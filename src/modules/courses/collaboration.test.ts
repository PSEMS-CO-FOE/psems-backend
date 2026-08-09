import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

// Wave 2: the collaboration half of a course — co-supervisors on ideas, a
// lecturer asking to join, interest flowing both ways, and a student taking part
// without a group.
const h = createHarness("collabjest.");
const { userIds, makeUser, login, as, openPhase, cleanup } = h;

async function createCpi(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({
      name,
      projectType: "FYP",
      participationMode: "GROUP",
      department: "CE",
      academicYear: "2026",
      mode: "SUPERVISOR_LED",
      ...extra,
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function acceptSupervisor(cpiId: string, key: string) {
  await request(app)
    .post(`/courses/${cpiId}/supervisors`)
    .set(as("coord"))
    .send({ lecturerUserId: userIds[key] })
    .expect(201);
  await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as(key)).send({ decision: "ACCEPT" }).expect(200);
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("supA", Role.LECTURER, { approvedLecturer: true });
  await makeUser("supB", Role.LECTURER, { approvedLecturer: true });
  await makeUser("outsider", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  for (const key of ["coord", "supA", "supB", "outsider", "s1", "s2"]) await login(key);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("Co-supervisors on an idea", () => {
  it("names a co-supervisor who must accept, and shows both to groups", async () => {
    const cpiId = await createCpi("Co-supervision CPI");
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "supA");
    await acceptSupervisor(cpiId, "supB");

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const idea = await request(app)
      .post(`/courses/${cpiId}/ideas`)
      .set(as("supA"))
      .send({ title: "Joint project", description: "d" });
    expect(idea.status).toBe(201);
    // The author is recorded as primary, so the list is complete from the start.
    expect(idea.body.supervisors).toHaveLength(1);
    expect(idea.body.supervisors[0].isPrimary).toBe(true);

    const invited = await request(app)
      .post(`/courses/${cpiId}/ideas/${idea.body.id}/co-supervisors`)
      .set(as("supA"))
      .send({ lecturerUserId: userIds.supB });
    expect(invited.status).toBe(201);
    expect(invited.body.invitationStatus).toBe("PENDING");

    // Someone who is not the idea's own supervisor cannot change its list.
    const notMine = await request(app)
      .post(`/courses/${cpiId}/ideas/${idea.body.id}/co-supervisors`)
      .set(as("supB"))
      .send({ lecturerUserId: userIds.outsider });
    expect(notMine.status).toBe(403);

    await request(app)
      .post(`/courses/${cpiId}/ideas/${idea.body.id}/co-supervisors/respond`)
      .set(as("supB"))
      .send({ decision: "ACCEPT" })
      .expect(200);

    const listed = await request(app).get(`/courses/${cpiId}/ideas`).set(as("supA"));
    const shown = listed.body.find((i: { id: string }) => i.id === idea.body.id);
    expect(shown.supervisors).toHaveLength(2);
    expect(shown.supervisors.map((s: { invitationStatus: string }) => s.invitationStatus).sort()).toEqual([
      "ACCEPTED",
      "ACCEPTED",
    ]);
  });
});

describe("A lecturer can find a course and ask to supervise", () => {
  it("discovers the course, requests, and the coordinator approves into an invitation", async () => {
    const cpiId = await createCpi("Discoverable CPI");

    const open = await request(app).get("/courses/open").set(as("outsider"));
    expect(open.status).toBe(200);
    const found = open.body.find((c: { id: string }) => c.id === cpiId);
    expect(found).toBeTruthy();
    expect(found.requestStatus).toBeNull();
    // Discovery exposes metadata only — never the ideas inside.
    expect(found.ideas).toBeUndefined();

    const requested = await request(app)
      .post(`/courses/${cpiId}/supervisor-requests`)
      .set(as("outsider"))
      .send({ note: "I work in this area" });
    expect(requested.status).toBe(201);

    const dup = await request(app).post(`/courses/${cpiId}/supervisor-requests`).set(as("outsider")).send({});
    expect(dup.status).toBe(409);

    const queue = await request(app).get(`/courses/${cpiId}/supervisor-requests`).set(as("coord"));
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].note).toBe("I work in this area");

    await request(app)
      .post(`/courses/${cpiId}/supervisor-requests/${requested.body.id}`)
      .set(as("coord"))
      .send({ decision: "APPROVE" })
      .expect(200);

    // Approval creates an invitation, not membership — they still have to accept.
    const invite = await prisma.cpiSupervisor.findFirst({
      where: { courseInstanceId: cpiId, lecturer: { userId: userIds.outsider } },
    });
    expect(invite?.invitationStatus).toBe("PENDING");
  });

  it("is refused when the course turns self-requests off", async () => {
    const cpiId = await createCpi("Closed CPI");
    await request(app)
      .patch(`/courses/${cpiId}/policy`)
      .set(as("coord"))
      .send({ allowSupervisorSelfRequest: false })
      .expect(200);

    const requested = await request(app).post(`/courses/${cpiId}/supervisor-requests`).set(as("outsider")).send({});
    expect(requested.status).toBe(409);
  });
});

describe("Interest flows both ways and can be withdrawn", () => {
  it("lets a lecturer express interest in a group's idea, then withdraw it", async () => {
    const cpiId = await createCpi("Two-way interest CPI");
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    const group = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });

    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "supA");

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const groupIdea = await request(app)
      .post(`/courses/${cpiId}/ideas`)
      .set(as("s1"))
      .send({ title: "Our idea", description: "d" });
    expect(groupIdea.status).toBe(201);
    expect(group.body.id).toBeTruthy();

    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);

    const interested = await request(app)
      .post(`/courses/${cpiId}/selection/lecturer-interest`)
      .set(as("supA"))
      .send({ ideaId: groupIdea.body.id });
    expect(interested.status).toBe(201);
    expect(interested.body.withdrawnAt).toBeNull();

    const withdrawn = await request(app)
      .delete(`/courses/${cpiId}/selection/interest/${groupIdea.body.id}`)
      .query({ type: "LECTURER_INTEREST" })
      .set(as("supA"));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.withdrawnAt).not.toBeNull();

    // Re-expressing revives the same row rather than colliding with it, which is
    // why withdrawal is soft rather than a delete.
    const again = await request(app)
      .post(`/courses/${cpiId}/selection/lecturer-interest`)
      .set(as("supA"))
      .send({ ideaId: groupIdea.body.id });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(interested.body.id);
    expect(again.body.withdrawnAt).toBeNull();
  });
});

describe("A student can take part without a group", () => {
  it("creates a group of one, and refuses when the course does not allow it", async () => {
    const groupCpi = await createCpi("Groups only CPI");
    await openPhase(groupCpi, CpiPhase.STUDENT_REGISTRATION);

    const refused = await request(app).post(`/courses/${groupCpi}/groups/solo`).set(as("s2"));
    expect(refused.status).toBe(409);

    const soloCpi = await createCpi("Individual CPI", { participationMode: "INDIVIDUAL" });
    await openPhase(soloCpi, CpiPhase.STUDENT_REGISTRATION);

    const created = await request(app).post(`/courses/${soloCpi}/groups/solo`).set(as("s2"));
    expect(created.status).toBe(201);
    expect(created.body.members).toHaveLength(1);

    // Idempotent — the UI can just call it.
    const again = await request(app).post(`/courses/${soloCpi}/groups/solo`).set(as("s2"));
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(created.body.id);

    // Nobody to invite on an individual course.
    const invite = await request(app)
      .post(`/courses/${soloCpi}/groups/${created.body.id}/invite`)
      .set(as("s2"))
      .send({ email: `${h.prefix}s1@psems.dev` });
    expect(invite.status).toBe(409);
  });
});

describe("Directory profiles", () => {
  it("edits your own profile and reads anyone's, with supervised projects derived", async () => {
    const mine = await request(app)
      .patch("/profiles/me")
      .set(as("supA"))
      .send({
        headline: "Senior Lecturer, Networks",
        about: "Works on wireless systems.",
        department: "CE",
        interests: ["Wireless", "IoT", "Wireless"],
        outputs: [{ title: "A paper on mesh routing", venue: "ICC", year: 2025 }],
      });
    expect(mine.status).toBe(200);
    // Duplicate tags collapse.
    expect(mine.body.profile.interests).toHaveLength(2);
    expect(mine.body.profile.outputs).toHaveLength(1);

    // Any logged-in user can read it — a student choosing a supervisor is the
    // whole point.
    const asStudent = await request(app).get(`/profiles/${userIds.supA}`).set(as("s1"));
    expect(asStudent.status).toBe(200);
    expect(asStudent.body.profile.headline).toBe("Senior Lecturer, Networks");
    expect(Array.isArray(asStudent.body.supervisedProjects)).toBe(true);

    // Filtering by research area is why interests are tagged.
    const found = await request(app).get("/profiles/search").query({ area: "wireless" }).set(as("s1"));
    expect(found.status).toBe(200);
    expect(found.body.some((p: { userId: string }) => p.userId === userIds.supA)).toBe(true);

    // Someone with no profile row still resolves, just empty.
    const bare = await request(app).get(`/profiles/${userIds.s2}`).set(as("s1"));
    expect(bare.status).toBe(200);
    expect(bare.body.profile).toBeNull();
    expect(bare.body.user.id).toBe(userIds.s2);
  });
});
