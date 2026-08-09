import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

// The scenario the supervisor predicted: a group expresses interest in two
// supervisors' projects, and both supervisors act at the same moment. Before
// Wave 2 both writes succeeded, and allocation later died on an unmapped unique
// violation that surfaced as HTTP 500.
const h = createHarness("racejest.");
const { userIds, makeUser, login, as, openPhase, cleanup } = h;

async function setupTwoPendingSelections() {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({
      name: "Race CPI",
      projectType: "FYP",
      participationMode: "GROUP",
      department: "CE",
      academicYear: "2026",
      mode: "SUPERVISOR_LED",
    });
  const cpiId = create.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const group = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  const groupId = group.body.id as string;

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  for (const key of ["supA", "supB"]) {
    await request(app)
      .post(`/courses/${cpiId}/supervisors`)
      .set(as("coord"))
      .send({ lecturerUserId: userIds[key] })
      .expect(201);
    await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as(key)).send({ decision: "ACCEPT" }).expect(200);
  }

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const ideaA = await request(app)
    .post(`/courses/${cpiId}/ideas`)
    .set(as("supA"))
    .send({ title: "Project A", description: "d" });
  const ideaB = await request(app)
    .post(`/courses/${cpiId}/ideas`)
    .set(as("supB"))
    .send({ title: "Project B", description: "d" });
  expect(ideaA.status).toBe(201);
  expect(ideaB.status).toBe(201);

  await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
  return { cpiId, groupId, ideaAId: ideaA.body.id as string, ideaBId: ideaB.body.id as string };
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("supA", Role.LECTURER, { approvedLecturer: true });
  await makeUser("supB", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  for (const key of ["coord", "supA", "supB", "s1"]) await login(key);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("A group cannot end up with two live selections", () => {
  it("refuses a second selection while one is pending", async () => {
    const { cpiId, ideaAId, ideaBId } = await setupTwoPendingSelections();

    await request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: ideaAId }).expect(201);

    const second = await request(app)
      .post(`/courses/${cpiId}/selection/select`)
      .set(as("s1"))
      .send({ ideaId: ideaBId });
    expect(second.status).toBe(409);
  });

  it("survives two selections fired at the same instant", async () => {
    const { cpiId, groupId, ideaAId, ideaBId } = await setupTwoPendingSelections();

    // No await between them: both are in flight before either finishes, which is
    // what defeated the old read-then-write check.
    const [first, second] = await Promise.all([
      request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: ideaAId }),
      request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: ideaBId }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Whatever the interleaving, exactly one live selection exists — and the
    // loser got a conflict, not "Internal server error".
    const live = await prisma.projectSelection.count({
      where: { groupId, status: { in: ["PENDING", "ACCEPTED"] } },
    });
    expect(live).toBe(1);
  });

  it("lets only one responder settle a selection", async () => {
    const { cpiId, ideaAId } = await setupTwoPendingSelections();
    const created = await request(app)
      .post(`/courses/${cpiId}/selection/select`)
      .set(as("s1"))
      .send({ ideaId: ideaAId })
      .expect(201);
    const selectionId = created.body.id as string;

    const [a, b] = await Promise.all([
      request(app).post(`/courses/${cpiId}/selection/${selectionId}/respond`).set(as("supA")).send({ decision: "ACCEPT" }),
      request(app).post(`/courses/${cpiId}/selection/${selectionId}/respond`).set(as("supA")).send({ decision: "DECLINE" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("aggregates allocations without a duplicate blowing up", async () => {
    const { cpiId, ideaAId } = await setupTwoPendingSelections();
    const created = await request(app)
      .post(`/courses/${cpiId}/selection/select`)
      .set(as("s1"))
      .send({ ideaId: ideaAId })
      .expect(201);
    await request(app)
      .post(`/courses/${cpiId}/selection/${created.body.id}/respond`)
      .set(as("supA"))
      .send({ decision: "ACCEPT" })
      .expect(200);

    await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);

    // Generating twice used to hit the group-unique constraint on the second
    // pass and return 500. It is idempotent now.
    const first = await request(app).post(`/courses/${cpiId}/allocations/generate`).set(as("coord"));
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(1);

    const again = await request(app).post(`/courses/${cpiId}/allocations/generate`).set(as("coord"));
    expect(again.status).toBe(201);
    expect(again.body.created).toBe(0);
  });
});
