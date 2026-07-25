import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "scoringrules.";
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
      ...(opts.student ? { student: { create: { studentId: `${PREFIX}${key}`, department: "CE", year: 3 } } } : {}),
      ...(opts.approvedLecturer ? { lecturer: { create: { approvalStatus: LecturerApprovalStatus.APPROVED } } } : {}),
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

async function cleanup() {
  await prisma.courseInstance.deleteMany({ where: { createdBy: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

// CPI with a generated session for group A at a 2-criterion stage. `assignEvs`
// controls how many evaluators get assigned; `evaluatorsRequired` sets the stage
// requirement. Returns ids and leaves phase at EVALUATION_EXECUTION.
async function setup(evaluatorsRequired: number, assignEvs: string[]) {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name: "Scoring CPI", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
  const cpiId = create.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const g = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  const groupId = g.body.id as string;

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  await request(app).post(`/courses/${cpiId}/finalize-coordinator-managed`).set(as("coord")).expect(200);
  for (const ev of ["ev1", "ev2", "hj"]) {
    await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds[ev] }).expect(201);
  }
  await request(app).post(`/courses/${cpiId}/head-judge`).set(as("coord")).send({ lecturerUserId: userIds.hj }).expect(200);

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "I", description: "d" });
  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  await request(app).put(`/courses/${cpiId}/allocations/${groupId}`).set(as("coord")).send({ ideaId: idea.body.id }).expect(200);

  await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
  const config = await request(app).put(`/courses/${cpiId}/evaluations/config`).set(as("coord")).send({
    stages: [{ name: "S", weight: 100, evaluatorsRequired, submissionRequired: false, criteria: [{ name: "C1", weight: 50, maxScore: 10 }, { name: "C2", weight: 50, maxScore: 10 }] }],
  });
  const stage = config.body[0];
  const [c1, c2] = stage.criteria;
  for (const ev of assignEvs) {
    await request(app).post(`/courses/${cpiId}/evaluations/stages/${stage.id}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds[ev] }).expect(201);
  }

  await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
  const gen = await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord"));
  const sessionId = (gen.body.sessions as { id: string; group: { id: string } }[]).find((s) => s.group.id === groupId)!.id;

  await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);
  return { cpiId, sessionId, c1: c1.id as string, c2: c2.id as string };
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("ev1", Role.LECTURER, { approvedLecturer: true });
  await makeUser("ev2", Role.LECTURER, { approvedLecturer: true });
  await makeUser("hj", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  for (const k of ["coord", "ev1", "ev2", "hj", "s1"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("Scoring locks once a session awaits Head Judge review", () => {
  it("rejects a resubmission after both evaluators have submitted (AWAITING_HEAD_JUDGE)", async () => {
    const { cpiId, sessionId, c1, c2 } = await setup(2, ["ev1", "ev2"]);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1, score: 5 }, { criterionId: c2, score: 5 }] }).expect(201);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2")).send({ scores: [{ criterionId: c1, score: 6 }, { criterionId: c2, score: 6 }] }).expect(201);

    // Session is now AWAITING_HEAD_JUDGE — ev1 can no longer silently revise.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1, score: 9 }] }).expect(409);
  });
});

describe("A stage's evaluatorsRequired is enforced before completion", () => {
  it("does not become ready when fewer than evaluatorsRequired evaluators are assigned", async () => {
    // Stage requires 2, but only ev1 is assigned.
    const { cpiId, sessionId, c1, c2 } = await setup(2, ["ev1"]);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1, score: 8 }, { criterionId: c2, score: 8 }] }).expect(201);

    // ev1 fully scored, but the requirement of 2 isn't met -> HJ cannot approve.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("hj")).expect(409);
  });
});

describe("Presentation duration", () => {
  it("lets an assigned evaluator save the duration and blocks an outsider", async () => {
    const { cpiId, sessionId } = await setup(2, ["ev1", "ev2"]);

    const ok = await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/presentation-duration`).set(as("ev1")).send({ seconds: 720 });
    expect(ok.status).toBe(200);
    expect(ok.body.presentationDurationSeconds).toBe(720);

    // A student is not permitted to set it.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/presentation-duration`).set(as("s1")).send({ seconds: 100 }).expect(403);
  });
});
