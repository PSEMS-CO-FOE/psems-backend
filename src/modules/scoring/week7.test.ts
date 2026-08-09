import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "w7jest.";
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

// A coordinator-managed CPI carried all the way to a generated evaluation
// session for group A at a single 2-criterion stage, with ev1+ev2 assigned and
// hj as Head Judge. Returns ids needed to score. Leaves phase at EVALUATION_EXECUTION.
async function setupSession() {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name: "Scoring CPI", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
  const cpiId = create.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const g = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  const groupId = g.body.id as string;

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  await request(app).post(`/courses/${cpiId}/coordinator-managed-preset`).set(as("coord")).expect(200);
  for (const ev of ["ev1", "ev2", "hj"]) {
    await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds[ev] }).expect(201);
  }
  await request(app).post(`/courses/${cpiId}/head-judge`).set(as("coord")).send({ lecturerUserId: userIds.hj }).expect(200);
  // A Head Judge is opt-in now; without this the coordinator would be the reviewer.
  await request(app).patch(`/courses/${cpiId}/policy`).set(as("coord")).send({ headJudgeEnabled: true }).expect(200);

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "COORD-IDEA", description: "d" });

  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  await request(app).put(`/courses/${cpiId}/allocations/${groupId}`).set(as("coord")).send({ ideaId: idea.body.id }).expect(200);

  await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
  const config = await request(app)
    .put(`/courses/${cpiId}/evaluations/config`)
    .set(as("coord"))
    .send({
      stages: [
        {
          name: "Final Demo",
          weight: 100,
          panelRules: [{ role: "EVALUATOR", minRequired: 2 }],
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
    await request(app)
      .post(`/courses/${cpiId}/evaluations/stages/${stage.id}/evaluators`)
      .set(as("coord"))
      .send({ lecturerUserId: userIds[ev] })
      .expect(201);
  }

  await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
  const gen = await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord"));
  expect(gen.status).toBe(201);
  const session = (gen.body.sessions as { id: string; group: { id: string } }[]).find((s) => s.group.id === groupId)!;

  await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);
  return { cpiId, groupId, sessionId: session.id, c1Id: c1.id as string, c2Id: c2.id as string };
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

describe("Week 7: evaluator score isolation (non-negotiable)", () => {
  it("keeps each evaluator's scores private until the Head Judge finalizes", async () => {
    const { cpiId, sessionId, c1Id, c2Id } = await setupSession();

    // ev1 submits.
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: [{ criterionId: c1Id, score: 8 }, { criterionId: c2Id, score: 9 }] , overallComment: 'Reviewed.' })
      .expect(201);

    // ev2 (not yet scored) cannot see ev1's scores — sees only their own (none).
    const ev2Before = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2"));
    expect(ev2Before.status).toBe(200);
    expect(ev2Before.body).toHaveLength(0);

    // ev1 sees only their own 2 scores.
    const ev1View = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1"));
    expect(ev1View.body).toHaveLength(2);

    // Coordinator cannot peek before finalization.
    await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("coord")).expect(403);

    // ev2 submits — now both are in, but ev1 STILL sees only their own.
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev2"))
      .send({ scores: [{ criterionId: c1Id, score: 8 }, { criterionId: c2Id, score: 3 }] , overallComment: 'Reviewed.' })
      .expect(201);

    const ev1AfterBoth = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1"));
    expect(ev1AfterBoth.body).toHaveLength(2);
  });

  it("the Head Judge sees both evaluators side-by-side with deviation flags; others cannot", async () => {
    const { cpiId, sessionId, c1Id, c2Id } = await setupSession();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1Id, score: 8 }, { criterionId: c2Id, score: 9 }] , overallComment: 'Reviewed.' }).expect(201);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2")).send({ scores: [{ criterionId: c1Id, score: 8 }, { criterionId: c2Id, score: 3 }] , overallComment: 'Reviewed.' }).expect(201);

    // Non-HJ evaluator cannot open the review.
    await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/review`).set(as("ev1")).expect(403);

    const review = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/review`).set(as("hj"));
    expect(review.status).toBe(200);
    const c1 = review.body.criteria.find((c: { name: string }) => c.name === "C1");
    const c2 = review.body.criteria.find((c: { name: string }) => c.name === "C2");
    expect(c1.scores).toHaveLength(2);
    expect(c1.flagged).toBe(false); // 8 vs 8
    expect(c2.flagged).toBe(true); //  9 vs 3, spread 6 > 20% of 10
  });
});

describe("Week 7: Head Judge approve + correction", () => {
  it("approves once both submit, locking scores as FINALIZED", async () => {
    const { cpiId, sessionId, c1Id, c2Id } = await setupSession();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1Id, score: 7 }, { criterionId: c2Id, score: 7 }] , overallComment: 'Reviewed.' }).expect(201);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2")).send({ scores: [{ criterionId: c1Id, score: 8 }, { criterionId: c2Id, score: 8 }] , overallComment: 'Reviewed.' }).expect(201);

    // Marking never ends by itself — the Head Judge closes it, then approves.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("hj")).expect(200);
    const approve = await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("hj"));
    expect(approve.status).toBe(200);
    expect(approve.body.decision).toBe("APPROVED");

    // Locked: further scoring rejected.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1Id, score: 5 }] , overallComment: 'Reviewed.' }).expect(409);

    // Now the coordinator can see all finalized scores.
    const coordView = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("coord"));
    expect(coordView.status).toBe(200);
    expect(coordView.body).toHaveLength(4);
  });

  it("requires scoring to be closed before approval, and supports request-correction", async () => {
    const { cpiId, sessionId, c1Id, c2Id } = await setupSession();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1")).send({ scores: [{ criterionId: c1Id, score: 6 }, { criterionId: c2Id, score: 6 }] , overallComment: 'Reviewed.' }).expect(201);

    // Scoring is still open, so approving is refused — it has to be closed first.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("hj")).expect(409);

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2")).send({ scores: [{ criterionId: c1Id, score: 2 }, { criterionId: c2Id, score: 2 }] , overallComment: 'Reviewed.' }).expect(201);

    // HJ asks ev2 to reconsider. Corrections now target a panel seat, so the
    // same person can be asked in whatever capacity they sat.
    const ev2Seat = await prisma.sessionPanelist.findFirst({
      where: { evaluationSessionId: sessionId, userId: userIds.ev2 },
    });
    const correction = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/request-correction`)
      .set(as("hj"))
      .send({ panelistId: ev2Seat!.id, reason: "Scores far below the other evaluator" });
    expect(correction.status).toBe(200);
    expect(correction.body.decision).toBe("CORRECTION_REQUESTED");

    // ev2 resubmits, then HJ approves.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev2")).send({ scores: [{ criterionId: c1Id, score: 6 }, { criterionId: c2Id, score: 6 }] , overallComment: 'Reviewed.' }).expect(201);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("hj")).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("hj")).expect(200);
  });

  it("a non-assigned lecturer (the Head Judge) cannot submit scores", async () => {
    const { cpiId, sessionId, c1Id } = await setupSession();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("hj")).send({ scores: [{ criterionId: c1Id, score: 5 }] , overallComment: 'Reviewed.' }).expect(403);
  });
});
