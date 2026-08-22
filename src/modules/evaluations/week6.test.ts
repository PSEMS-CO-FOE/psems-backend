import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "w6jest.";
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

// CPI with an ACCEPTED selection for group A, plus `ev` in the evaluator pool.
// Leaves the timeline at PROJECT_SELECTION.
async function setupAcceptedCpi(name: string) {
  const c = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name, projectType: "FYP", participationMode: "GROUP", batch: "22ENG", department: "CE", academicYear: "2026" });
  const cpiId = c.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const g = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  const groupId = g.body.id as string;

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  await request(app).post(`/courses/${cpiId}/supervisors`).set(as("coord")).send({ lecturerUserId: userIds.sup }).expect(201);
  await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as("sup")).send({ decision: "ACCEPT" }).expect(200);
  await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds.ev }).expect(201);

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("sup")).send({ title: "SUP-IDEA", description: "d" });
  const supIdeaId = idea.body.id as string;

  await openPhase(cpiId, CpiPhase.PROJECT_SELECTION);
  const sel = await request(app).post(`/courses/${cpiId}/selection/select`).set(as("s1")).send({ ideaId: supIdeaId });
  await request(app).post(`/courses/${cpiId}/selection/${sel.body.id}/respond`).set(as("sup")).send({ decision: "ACCEPT" }).expect(200);

  return { cpiId, groupId, supIdeaId };
}

const FOUR_STAGE_RUBRIC = {
  stages: [
    { name: "Proposal", weight: 15, panelRules: [{ role: "EVALUATOR", minRequired: 2 }], submissionRequired: true, criteria: [{ name: "Clarity", weight: 50, maxScore: 10 }, { name: "Feasibility", weight: 50, maxScore: 10 }] },
    { name: "Mid Evaluation", weight: 25, panelRules: [{ role: "EVALUATOR", minRequired: 2 }], submissionRequired: false, criteria: [{ name: "Progress", weight: 100, maxScore: 20 }] },
    { name: "Final Demo", weight: 40, panelRules: [{ role: "EVALUATOR", minRequired: 3 }], submissionRequired: false, criteria: [{ name: "Demo", weight: 100, maxScore: 40 }] },
    { name: "Report", weight: 20, panelRules: [{ role: "EVALUATOR", minRequired: 1 }], submissionRequired: true, criteria: [{ name: "Writing", weight: 100, maxScore: 20 }] },
  ],
};

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("sup", Role.LECTURER, { approvedLecturer: true });
  await makeUser("ev", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  for (const k of ["coord", "sup", "ev", "s1"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("Week 6: allocation finalize + override", () => {
  it("generates from accepted selections, allows override, then locks on finalize", async () => {
    const { cpiId, groupId, supIdeaId } = await setupAcceptedCpi("Allocation CPI");
    await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);

    const gen = await request(app).post(`/courses/${cpiId}/allocations/generate`).set(as("coord"));
    expect(gen.status).toBe(201);
    expect(gen.body.created).toBe(1);
    expect(gen.body.unmatchedGroups).toHaveLength(0);
    expect(gen.body.allocations[0].source).toBe("FROM_SELECTION");

    // Override the group's supervisor assignment.
    const override = await request(app)
      .put(`/courses/${cpiId}/allocations/${groupId}`)
      .set(as("coord"))
      .send({ ideaId: supIdeaId, supervisorUserId: userIds.sup });
    expect(override.status).toBe(200);
    expect(override.body.source).toBe("COORDINATOR_OVERRIDE");

    const finalize = await request(app).post(`/courses/${cpiId}/allocations/finalize`).set(as("coord"));
    expect(finalize.status).toBe(200);
    expect(finalize.body.allocationsFinalizedAt).toBeTruthy();

    // Locked: further changes rejected.
    await request(app).post(`/courses/${cpiId}/allocations/generate`).set(as("coord")).expect(409);
    await request(app).put(`/courses/${cpiId}/allocations/${groupId}`).set(as("coord")).send({ ideaId: supIdeaId }).expect(409);
  });
});

describe("Allocation reopen", () => {
  it("unlocks a finalized allocation so a supervisor can be changed", async () => {
    const { cpiId, groupId, supIdeaId } = await setupAcceptedCpi("Reopen CPI");
    await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);

    await request(app).post(`/courses/${cpiId}/allocations/generate`).set(as("coord")).expect(201);
    await request(app).post(`/courses/${cpiId}/allocations/finalize`).set(as("coord")).expect(200);
    await request(app)
      .put(`/courses/${cpiId}/allocations/${groupId}`)
      .set(as("coord"))
      .send({ ideaId: supIdeaId })
      .expect(409);

    // A reason is required — reopening a lock is a decision worth explaining.
    await request(app).post(`/courses/${cpiId}/allocations/reopen`).set(as("coord")).send({}).expect(400);

    const reopened = await request(app)
      .post(`/courses/${cpiId}/allocations/reopen`)
      .set(as("coord"))
      .send({ reason: "Dr Alpha is on leave from week 10" })
      .expect(200);
    expect(reopened.body.allocationsFinalizedAt).toBeNull();

    // The whole point: the pairing can now be changed.
    const changed = await request(app)
      .put(`/courses/${cpiId}/allocations/${groupId}`)
      .set(as("coord"))
      .send({ ideaId: supIdeaId, supervisorUserId: userIds.sup })
      .expect(200);
    expect(changed.body.source).toBe("COORDINATOR_OVERRIDE");

    // Reopening something already open is a conflict, not a silent no-op.
    await request(app)
      .post(`/courses/${cpiId}/allocations/reopen`)
      .set(as("coord"))
      .send({ reason: "again" })
      .expect(409);
  });

  it("still allows a pairing change after the registration phase has closed", async () => {
    // A supervisor going on leave does not wait for the timeline. The route
    // gate used to make this a hard 403 long after the phase had passed.
    const { cpiId, groupId, supIdeaId } = await setupAcceptedCpi("Late change CPI");
    await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
    await request(app).post(`/courses/${cpiId}/allocations/generate`).set(as("coord")).expect(201);

    await request(app)
      .put(`/courses/${cpiId}/timeline`)
      .set(as("coord"))
      .send({
        phases: [
          {
            phase: "PROJECT_REGISTRATION",
            startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            endDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      })
      .expect(200);

    await request(app)
      .put(`/courses/${cpiId}/allocations/${groupId}`)
      .set(as("coord"))
      .send({ ideaId: supIdeaId, supervisorUserId: userIds.sup })
      .expect(200);
  });
});

describe("Week 6: evaluation config (4-stage rubric)", () => {
  it("accepts a valid 4-stage rubric, rejects bad weights, and assigns a stage evaluator", async () => {
    const { cpiId } = await setupAcceptedCpi("Rubric CPI");
    await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);

    const config = await request(app).put(`/courses/${cpiId}/evaluations/config`).set(as("coord")).send(FOUR_STAGE_RUBRIC);
    expect(config.status).toBe(200);
    expect(config.body).toHaveLength(4);
    const proposal = config.body.find((s: { name: string }) => s.name === "Proposal");
    expect(proposal.criteria).toHaveLength(2);

    // Stage weights that don't sum to 100 are rejected.
    const bad = await request(app)
      .put(`/courses/${cpiId}/evaluations/config`)
      .set(as("coord"))
      .send({ stages: [{ name: "Only", weight: 90, panelRules: [{ role: "EVALUATOR", minRequired: 1 }], submissionRequired: false, criteria: [{ name: "X", weight: 100, maxScore: 10 }] }] });
    expect(bad.status).toBe(400);

    // Assign the pooled evaluator to the Proposal stage.
    const assign = await request(app)
      .post(`/courses/${cpiId}/evaluations/stages/${proposal.id}/evaluators`)
      .set(as("coord"))
      .send({ lecturerUserId: userIds.ev });
    expect(assign.status).toBe(201);

    const view = await request(app).get(`/courses/${cpiId}/evaluations/config`).set(as("coord"));
    const proposalView = view.body.find((s: { name: string }) => s.name === "Proposal");
    expect(proposalView.evaluators).toHaveLength(1);
  });
});

describe("Week 6: proposal submission (soft deadline)", () => {
  it("accepts an on-time upload, blocks before the window, and flags a late upload", async () => {
    const { cpiId } = await setupAcceptedCpi("Submission CPI");
    await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
    const config = await request(app).put(`/courses/${cpiId}/evaluations/config`).set(as("coord")).send(FOUR_STAGE_RUBRIC);
    const proposalStageId = config.body.find((s: { name: string }) => s.name === "Proposal").id as string;

    // Before the window opens -> rejected.
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await request(app)
      .post(`/courses/${cpiId}/stages/${proposalStageId}/submission`)
      .set(as("s1"))
      .attach("file", Buffer.from("%PDF-1.4 early"), "early.pdf")
      .expect(403);

    // In-window -> accepted, not late.
    await openPhase(cpiId, CpiPhase.PROPOSAL_SUBMISSION);
    const onTime = await request(app)
      .post(`/courses/${cpiId}/stages/${proposalStageId}/submission`)
      .set(as("s1"))
      .attach("file", Buffer.from("%PDF-1.4 ontime"), "proposal.pdf");
    expect(onTime.status).toBe(201);
    expect(onTime.body.isLate).toBe(false);

    // After the window closed -> still accepted, but flagged late.
    await openPhase(cpiId, CpiPhase.FINAL_SUBMISSION);
    const late = await request(app)
      .post(`/courses/${cpiId}/stages/${proposalStageId}/submission`)
      .set(as("s1"))
      .attach("file", Buffer.from("%PDF-1.4 late"), "proposal-v2.pdf");
    expect(late.status).toBe(201);
    expect(late.body.isLate).toBe(true);

    // Coordinator sees the submission with its late flag.
    const list = await request(app).get(`/courses/${cpiId}/submissions`).set(as("coord"));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].isLate).toBe(true);
  });
});
