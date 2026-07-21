import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "w8jest.";
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
  await prisma.notification.deleteMany({ where: { recipient: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

// Full lifecycle up to a Head-Judge-approved, FINALIZED session for group A.
// ev1 scores 7/7, ev2 scores 9/9 -> both criteria average 8/10 = 80%.
async function setupApprovedSession() {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name: "Marks CPI", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
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
  const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "IDEA", description: "d" });

  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  await request(app).put(`/courses/${cpiId}/allocations/${groupId}`).set(as("coord")).send({ ideaId: idea.body.id }).expect(200);
  await request(app).post(`/courses/${cpiId}/allocations/finalize`).set(as("coord")).expect(200);

  await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
  const config = await request(app)
    .put(`/courses/${cpiId}/evaluations/config`)
    .set(as("coord"))
    .send({
      stages: [
        {
          name: "Final Demo",
          weight: 100,
          evaluatorsRequired: 2,
          submissionRequired: false,
          criteria: [
            { name: "C1", weight: 50, maxScore: 10 },
            { name: "C2", weight: 50, maxScore: 10 },
          ],
        },
      ],
    });
  const stage = config.body[0];
  const [c1, c2] = stage.criteria;
  for (const ev of ["ev1", "ev2"]) {
    await request(app).post(`/courses/${cpiId}/evaluations/stages/${stage.id}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds[ev] }).expect(201);
  }

  await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
  const gen = await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord"));
  const sessionId = (gen.body.sessions as { id: string; group: { id: string } }[]).find((s) => s.group.id === groupId)!.id;

  await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);
  await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1.id, score: 7 }, { criterionId: c2.id, score: 7 }] }).expect(201);
  await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2")).send({ scores: [{ criterionId: c1.id, score: 9 }, { criterionId: c2.id, score: 9 }] }).expect(201);
  await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("hj")).expect(200);

  return { cpiId, groupId, sessionId };
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

describe("Week 8: mark aggregation, publishing, student view", () => {
  it("aggregates weighted marks, gates the student view on publish, and notifies", async () => {
    const { cpiId } = await setupApprovedSession();

    // Aggregate — 80% on the only stage (weight 100) -> overall 80.
    const agg = await request(app).post(`/courses/${cpiId}/marks/aggregate`).set(as("coord"));
    expect(agg.status).toBe(200);
    expect(agg.body).toHaveLength(1);
    expect(agg.body[0].overall).toBe(80);
    expect(agg.body[0].stages[0].stageScorePercent).toBe(80);

    // Student cannot see marks before they're published.
    await request(app).get(`/courses/${cpiId}/marks`).set(as("s1")).expect(403);

    const publish = await request(app).post(`/courses/${cpiId}/marks/publish`).set(as("coord"));
    expect(publish.status).toBe(200);
    expect(publish.body.marksPublishedAt).toBeTruthy();

    // Now the student sees their own group's mark.
    const studentView = await request(app).get(`/courses/${cpiId}/marks`).set(as("s1"));
    expect(studentView.status).toBe(200);
    expect(studentView.body).toHaveLength(1);
    expect(studentView.body[0].overall).toBe(80);

    // Notifications fired: student got MARKS_PUBLISHED, coordinator got SCORES_FINALIZED.
    const studentNotifs = await request(app).get(`/notifications`).set(as("s1"));
    expect(studentNotifs.body.some((n: { type: string }) => n.type === "MARKS_PUBLISHED")).toBe(true);
    expect(studentNotifs.body.some((n: { type: string }) => n.type === "ALLOCATION_FINALIZED")).toBe(true);

    const coordNotifs = await request(app).get(`/notifications`).set(as("coord"));
    expect(coordNotifs.body.some((n: { type: string }) => n.type === "SCORES_FINALIZED")).toBe(true);
  });

  it("refuses to aggregate before every session is Head-Judge approved", async () => {
    // Fresh CPI where the session is scored but NOT approved.
    const create = await request(app)
      .post("/courses")
      .set(as("coord"))
      .send({ name: "Unfinished CPI", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
    const cpiId = create.body.id as string;
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    const g = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await request(app).post(`/courses/${cpiId}/finalize-coordinator-managed`).set(as("coord")).expect(200);
    for (const ev of ["ev1", "ev2"]) await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds[ev] }).expect(201);
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "I", description: "d" });
    await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
    await request(app).put(`/courses/${cpiId}/allocations/${g.body.id}`).set(as("coord")).send({ ideaId: idea.body.id }).expect(200);
    await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
    await request(app).put(`/courses/${cpiId}/evaluations/config`).set(as("coord")).send({
      stages: [{ name: "S", weight: 100, evaluatorsRequired: 2, submissionRequired: false, criteria: [{ name: "C", weight: 100, maxScore: 10 }] }],
    }).expect(200);
    await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
    await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord")).expect(201);

    // No scores, nothing approved -> aggregation blocked.
    await request(app).post(`/courses/${cpiId}/marks/aggregate`).set(as("coord")).expect(409);
    // Publishing before aggregation is also blocked.
    await request(app).post(`/courses/${cpiId}/marks/publish`).set(as("coord")).expect(409);
  });
});
