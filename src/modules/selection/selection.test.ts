import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "w5jest.";
const PASSWORD = "TestPass#123";

const PHASE_ORDER: CpiPhase[] = [
  CpiPhase.STUDENT_REGISTRATION,
  CpiPhase.SUPERVISOR_ADDITION,
  CpiPhase.IDEA_ANNOUNCEMENT,
  CpiPhase.PROJECT_SELECTION,
  CpiPhase.PROJECT_REGISTRATION,
  CpiPhase.EVALUATION_CONFIG,
  CpiPhase.PROPOSAL_SUBMISSION,
  CpiPhase.AVAILABILITY_SUBMISSION,
  CpiPhase.EVALUATION_EXECUTION,
  CpiPhase.FINAL_SUBMISSION,
];

function timelineOpening(openPhase: CpiPhase) {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const k = PHASE_ORDER.indexOf(openPhase);
  const base = Date.now() - hour - k * day;
  return {
    phases: PHASE_ORDER.map((phase, i) => ({
      phase,
      startDate: new Date(base + i * day).toISOString(),
      endDate: new Date(base + i * day + day).toISOString(),
    })),
  };
}

const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

async function makeUser(key: string, role: Role, opts: { student?: boolean; approvedLecturer?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}${key}@psems.dev`,
      fullName: key,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role,
      ...(opts.student ? { student: { create: { studentId: `${PREFIX}${key}`, batch: "22ENG", department: "CE", year: 3 } } } : {}),
      ...(opts.approvedLecturer
        ? { lecturer: { create: { approvalStatus: LecturerApprovalStatus.APPROVED } } }
        : {}),
    },
  });
  userIds[key] = user.id;
}

async function login(key: string) {
  const res = await request(app).post("/auth/login").send({ email: `${PREFIX}${key}@psems.dev`, password: PASSWORD });
  expect(res.status).toBe(200);
  tokens[key] = res.body.accessToken;
}

const as = (key: string) => ({ Authorization: `Bearer ${tokens[key]}` });

async function openPhase(cpiId: string, phase: CpiPhase) {
  await request(app).put(`/courses/${cpiId}/timeline`).set(as("coord")).send(timelineOpening(phase)).expect(200);
}

async function createCpi(name: string) {
  const res = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name, projectType: "FYP", participationMode: "GROUP", batch: "22ENG", department: "CE", academicYear: "2026" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createGroup(cpiId: string, leaderKey: string, name: string) {
  const res = await request(app).post(`/courses/${cpiId}/groups`).set(as(leaderKey)).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function acceptSupervisor(cpiId: string, supKey: string) {
  await request(app).post(`/courses/${cpiId}/supervisors`).set(as("coord")).send({ lecturerUserId: userIds[supKey] }).expect(201);
  await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as(supKey)).send({ decision: "ACCEPT" }).expect(200);
}

async function postIdea(cpiId: string, authorKey: string, title: string) {
  const res = await request(app).post(`/courses/${cpiId}/ideas`).set(as(authorKey)).send({ title, description: "d" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("sup", Role.LECTURER, { approvedLecturer: true });
  await makeUser("sup2", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  await makeUser("s3", Role.STUDENT, { student: true });
  for (const k of ["coord", "sup", "sup2", "s1", "s2", "s3"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

async function cleanup() {
  await prisma.courseInstance.deleteMany({ where: { createdBy: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

describe("Week 5: Supervisor-Led — ranked interest, select, supervisor accepts", () => {
  it("group ranks a supervisor idea, selects it, and the supervisor mutually accepts", async () => {
    const cpiId = await createCpi("SL Interest CPI");

    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await createGroup(cpiId, "s1", "Group A");

    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "sup");

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const supIdea = await postIdea(cpiId, "sup", "SUP-IDEA");

    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    // Rank the supervisor idea #1.
    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: supIdea, rank: 1 }).expect(201);

    // Final selection -> pending, addressed to the idea's supervisor.
    const sel = await request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: supIdea });
    expect(sel.status).toBe(201);
    expect(sel.body.status).toBe("PENDING");

    // Supervisor accepts -> mutual match.
    const respond = await request(app).post(`/courses/${cpiId}/selection/${sel.body.id}/respond`).set(as("sup")).send({ decision: "ACCEPT" });
    expect(respond.status).toBe(200);
    expect(respond.body.status).toBe("ACCEPTED");
  });

  it("caps interest at the course's limit, and withdrawing frees a slot", async () => {
    const cpiId = await createCpi("SL Interest Cap CPI");
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await createGroup(cpiId, "s1", "Group A");
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "sup");
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const i1 = await postIdea(cpiId, "sup", "I1");
    const i2 = await postIdea(cpiId, "sup", "I2");
    const i3 = await postIdea(cpiId, "sup", "I3");
    const i4 = await postIdea(cpiId, "sup", "I4");
    // Interest is flat now — no ranking. The cap is a course setting rather than
    // a hard-coded 3, so set it explicitly.
    await request(app).patch(`/courses/${cpiId}/policy`).set(as("coord")).send({ maxInterestsPerGroup: 3 }).expect(200);
    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);

    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: i1 }).expect(201);
    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: i2 }).expect(201);
    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: i3 }).expect(201);
    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: i4 }).expect(409);

    // Withdrawing one frees the slot — impossible before, because interest was
    // write-once and the counter counted rows that could never be removed.
    await request(app)
      .delete(`/courses/${cpiId}/selection/interest/${i2}`)
      .query({ type: "GROUP_INTEREST" })
      .set(as("s1"))
      .expect(200);
    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: i4 }).expect(201);
  });
});

describe("Week 5: Supervisor-Led — own idea, willing supervisors, conflict resolution", () => {
  it("two supervisors mark willing; the group picks one, who accepts; the other cannot respond", async () => {
    const cpiId = await createCpi("SL Conflict CPI");

    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await createGroup(cpiId, "s3", "Group B");

    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "sup");
    await acceptSupervisor(cpiId, "sup2");

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const ownIdea = await postIdea(cpiId, "s3", "GROUP-B-IDEA");

    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    // Group flags its own idea as seeking a supervisor.
    await request(app).post(`/courses/${cpiId}/selection/seeking-supervisor`).set(as("s3")).send({ ideaId: ownIdea }).expect(201);
    // Both supervisors mark willing.
    await request(app).post(`/courses/${cpiId}/selection/willing`).set(as("sup")).send({ ideaId: ownIdea }).expect(201);
    await request(app).post(`/courses/${cpiId}/selection/willing`).set(as("sup2")).send({ ideaId: ownIdea }).expect(201);

    // Group resolves the conflict by choosing sup2.
    const sel = await request(app)
      .post(`/courses/${cpiId}/selection/select`)
      .set(as("s3"))
      .send({ ideaId: ownIdea, supervisorUserId: userIds.sup2 });
    expect(sel.status).toBe(201);

    // The NON-chosen supervisor cannot respond.
    await request(app).post(`/courses/${cpiId}/selection/${sel.body.id}/respond`).set(as("sup")).send({ decision: "ACCEPT" }).expect(403);

    // The chosen supervisor accepts -> mutual match.
    const respond = await request(app).post(`/courses/${cpiId}/selection/${sel.body.id}/respond`).set(as("sup2")).send({ decision: "ACCEPT" });
    expect(respond.status).toBe(200);
    expect(respond.body.status).toBe("ACCEPTED");
    expect(respond.body.supervisorLecturerId).toBeTruthy();
  });

  it("selecting own idea without choosing a willing supervisor is rejected", async () => {
    const cpiId = await createCpi("SL Own No-Sup CPI");
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await createGroup(cpiId, "s3", "Group B");
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "sup");
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const ownIdea = await postIdea(cpiId, "s3", "OWN");
    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    await request(app).post(`/courses/${cpiId}/selection/seeking-supervisor`).set(as("s3")).send({ ideaId: ownIdea }).expect(201);
    await request(app).post(`/courses/${cpiId}/selection/select`).set(as("s3")).send({ ideaId: ownIdea }).expect(400);
  });
});

describe("Week 5: Coordinator-Managed — select, coordinator approves", () => {
  it("group selects its own approved idea and the coordinator confirms", async () => {
    const cpiId = await createCpi("CM Selection CPI");

    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await createGroup(cpiId, "s1", "Group X");

    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await request(app).post(`/courses/${cpiId}/coordinator-managed-preset`).set(as("coord")).expect(200);

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    await postIdea(cpiId, "coord", "COORD-IDEA");
    const ownIdea = await postIdea(cpiId, "s1", "X-OWN");

    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    // Not yet approved -> can't select it.
    await request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: ownIdea }).expect(400);

    // Approve it (coordinator can approve during selection? approval is gated to
    // IDEA_ANNOUNCEMENT) — approve before advancing.
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    await request(app).post(`/courses/${cpiId}/ideas/${ownIdea}/approve`).set(as("coord")).expect(200);

    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    const sel = await request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: ownIdea });
    expect(sel.status).toBe(201);
    expect(sel.body.supervisorLecturerId).toBeNull();

    // A supervisor can't confirm in Coordinator-Managed mode; the coordinator does.
    const confirm = await request(app).post(`/courses/${cpiId}/selection/${sel.body.id}/respond`).set(as("coord")).send({ decision: "ACCEPT" });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("ACCEPTED");
  });
});

describe("Week 5: guards", () => {
  it("blocks selection actions outside the PROJECT_SELECTION window", async () => {
    const cpiId = await createCpi("Gate CPI");
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await createGroup(cpiId, "s1", "Group A");
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "sup");
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const supIdea = await postIdea(cpiId, "sup", "SUP");
    // Still in IDEA_ANNOUNCEMENT (selection not open yet).
    const res = await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s1")).send({ ideaId: supIdea, rank: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PHASE_NOT_OPEN");
  });

  it("a non-leader member cannot drive selection", async () => {
    const cpiId = await createCpi("Leader-Only CPI");
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    const groupId = await createGroup(cpiId, "s1", "Group A");
    await request(app).post(`/courses/${cpiId}/groups/${groupId}/invite`).set(as("s1")).send({ email: `${PREFIX}s2@psems.dev` }).expect(201);
    await request(app).post(`/courses/${cpiId}/groups/${groupId}/respond`).set(as("s2")).send({ decision: "ACCEPT" }).expect(200);
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await acceptSupervisor(cpiId, "sup");
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const supIdea = await postIdea(cpiId, "sup", "SUP");
    await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
    // s2 is a member, not the leader.
    await request(app).post(`/courses/${cpiId}/selection/interest`).set(as("s2")).send({ ideaId: supIdea, rank: 1 }).expect(403);
  });
});
