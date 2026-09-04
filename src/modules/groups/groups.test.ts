import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

const h = createHarness("groups.");
const { as, email, makeUser, login, openPhase, cleanup } = h;

async function createCpi(name: string) {
  const res = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({
      name,
      projectType: "FYP",
      participationMode: "GROUP",
      batch: "22ENG",
      department: "CE",
      academicYear: "2026/2027",
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function openCpi(name: string) {
  const cpiId = await createCpi(name);
  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  return cpiId;
}

async function createGroup(cpiId: string, leaderKey: string, name: string) {
  const res = await request(app).post(`/courses/${cpiId}/groups`).set(as(leaderKey)).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function invite(cpiId: string, groupId: string, leaderKey: string, inviteeKey: string) {
  const res = await request(app)
    .post(`/courses/${cpiId}/groups/${groupId}/invite`)
    .set(as(leaderKey))
    .send({ email: email(inviteeKey) });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  await makeUser("s3", Role.STUDENT, { student: true });
  for (const k of ["coord", "s1", "s2", "s3"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

// Sending an invitation was always possible and taking it back was not, so a
// wrong address sat on the group for the rest of the course.
describe("Withdrawing an invitation", () => {
  it("removes a pending invitation and frees the student to be invited again", async () => {
    const cpiId = await openCpi("Revoke invite");
    const groupId = await createGroup(cpiId, "s1", "Alpha");
    const memberId = await invite(cpiId, groupId, "s1", "s2");

    await request(app)
      .delete(`/courses/${cpiId}/groups/${groupId}/invites/${memberId}`)
      .set(as("s1"))
      .expect(200);

    // Removed, not marked declined: declined is the invitee's own answer.
    expect(await prisma.groupMember.findUnique({ where: { id: memberId } })).toBeNull();

    const pending = await request(app).get(`/courses/${cpiId}/groups/invites`).set(as("s2")).expect(200);
    expect(pending.body).toHaveLength(0);

    // And the same student can be invited afresh.
    await invite(cpiId, groupId, "s1", "s2");
  });

  it("refuses to withdraw someone who already joined", async () => {
    const cpiId = await openCpi("Revoke joined");
    const groupId = await createGroup(cpiId, "s1", "Alpha");
    const memberId = await invite(cpiId, groupId, "s1", "s2");
    await request(app)
      .post(`/courses/${cpiId}/groups/${groupId}/respond`)
      .set(as("s2"))
      .send({ decision: "ACCEPT" })
      .expect(200);

    await request(app)
      .delete(`/courses/${cpiId}/groups/${groupId}/invites/${memberId}`)
      .set(as("s1"))
      .expect(409);
  });

  it("is the leader's to do, not a member's", async () => {
    const cpiId = await openCpi("Revoke guarded");
    const groupId = await createGroup(cpiId, "s1", "Alpha");
    const memberId = await invite(cpiId, groupId, "s1", "s2");

    await request(app)
      .delete(`/courses/${cpiId}/groups/${groupId}/invites/${memberId}`)
      .set(as("s2"))
      .expect(403);
  });
});

// Working alone creates a group of one, and creating a group is a click away
// from it, so both are easy to pick by mistake.
describe("Undoing how you take part", () => {
  it("lets a student who chose to work alone go back", async () => {
    const cpiId = await openCpi("Undo solo");

    const solo = await request(app).post(`/courses/${cpiId}/groups/solo`).set(as("s1"));
    expect(solo.status).toBe(201);

    await request(app).delete(`/courses/${cpiId}/groups/${solo.body.id}`).set(as("s1")).expect(200);

    // The endpoint always answers with a shape; the group inside it is what goes.
    const mine = await request(app).get(`/courses/${cpiId}/groups/mine`).set(as("s1")).expect(200);
    expect(mine.body.group).toBeNull();

    // Free to choose again — this time a group.
    await createGroup(cpiId, "s1", "Second thoughts");
  });

  it("takes any pending invitations with it", async () => {
    const cpiId = await openCpi("Undo with invites");
    const groupId = await createGroup(cpiId, "s1", "Alpha");
    await invite(cpiId, groupId, "s1", "s2");

    await request(app).delete(`/courses/${cpiId}/groups/${groupId}`).set(as("s1")).expect(200);

    const pending = await request(app).get(`/courses/${cpiId}/groups/invites`).set(as("s2")).expect(200);
    expect(pending.body).toHaveLength(0);
  });

  it("refuses once someone else has joined", async () => {
    const cpiId = await openCpi("Undo with a team");
    const groupId = await createGroup(cpiId, "s1", "Alpha");
    await invite(cpiId, groupId, "s1", "s2");
    await request(app)
      .post(`/courses/${cpiId}/groups/${groupId}/respond`)
      .set(as("s2"))
      .send({ decision: "ACCEPT" })
      .expect(200);

    // A leader must not be able to disband a team that formed around them.
    await request(app).delete(`/courses/${cpiId}/groups/${groupId}`).set(as("s1")).expect(409);
  });

  it("refuses once the group has posted an idea", async () => {
    const cpiId = await openCpi("Undo after an idea");
    const groupId = await createGroup(cpiId, "s1", "Alpha");

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    await request(app)
      .post(`/courses/${cpiId}/ideas`)
      .set(as("s1"))
      .send({ title: "Ours", description: "d" })
      .expect(201);

    // Registration has closed as well, which is its own refusal.
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await request(app).delete(`/courses/${cpiId}/groups/${groupId}`).set(as("s1")).expect(409);
    expect(groupId).toBeDefined();
  });

  it("is closed once registration is over", async () => {
    const cpiId = await openCpi("Undo too late");
    const groupId = await createGroup(cpiId, "s1", "Alpha");

    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    await request(app).delete(`/courses/${cpiId}/groups/${groupId}`).set(as("s1")).expect(403);
  });
});
