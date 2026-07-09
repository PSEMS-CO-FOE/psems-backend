import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "w3jest.";
const COORD_EMAIL = `${PREFIX}coord@psems.dev`;
const LECT1_EMAIL = `${PREFIX}lect1@psems.dev`;
const LECT2_EMAIL = `${PREFIX}lect2@psems.dev`;
const PASSWORD = "TestPass#123";

let coordToken: string;
let lect1Token: string;
let lect1UserId: string;
let lect2UserId: string;

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

// Builds a valid 10-phase timeline; SUPERVISOR_ADDITION (index 1) brackets
// "now" when open=true, else the whole timeline sits in the future.
function buildTimeline(open: boolean) {
  const day = 24 * 60 * 60 * 1000;
  const base = open ? Date.now() - day : Date.now() + 5 * day;
  return {
    phases: PHASE_ORDER.map((phase, i) => ({
      phase,
      startDate: new Date(base + i * day).toISOString(),
      endDate: new Date(base + i * day + day).toISOString(),
    })),
  };
}

// CPIs must go before their creator: course_instances.created_by_id is a
// Restrict FK (you can't delete a coordinator who still owns CPIs). CpiSupervisor
// / CpiEvaluator rows cascade from the CourseInstance delete.
async function cleanup() {
  await prisma.courseInstance.deleteMany({ where: { createdBy: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

async function login(email: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

async function createCpi(name: string) {
  const res = await request(app)
    .post("/courses")
    .set("Authorization", `Bearer ${coordToken}`)
    .send({ name, projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function setTimeline(cpiId: string, open: boolean) {
  const res = await request(app)
    .put(`/courses/${cpiId}/timeline`)
    .set("Authorization", `Bearer ${coordToken}`)
    .send(buildTimeline(open));
  expect(res.status).toBe(200);
}

describe("Week 3 acceptance: CPI lifecycle setup", () => {
  beforeAll(async () => {
    await cleanup();
    const hash = await bcrypt.hash(PASSWORD, 12);
    await prisma.user.create({
      data: { email: COORD_EMAIL, passwordHash: hash, role: Role.COURSE_COORDINATOR },
    });
    const lect1 = await prisma.user.create({
      data: {
        email: LECT1_EMAIL,
        passwordHash: hash,
        role: Role.LECTURER,
        lecturer: { create: { approvalStatus: LecturerApprovalStatus.APPROVED } },
      },
    });
    const lect2 = await prisma.user.create({
      data: {
        email: LECT2_EMAIL,
        passwordHash: hash,
        role: Role.LECTURER,
        lecturer: { create: { approvalStatus: LecturerApprovalStatus.APPROVED } },
      },
    });
    lect1UserId = lect1.id;
    lect2UserId = lect2.id;

    coordToken = await login(COORD_EMAIL);
    lect1Token = await login(LECT1_EMAIL);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await emailQueue.close();
    await queueConnection.quit();
    await redis.quit();
  });

  it("creates a CPI (mode undetermined until Step 3)", async () => {
    const cpiId = await createCpi("Mode Test CPI");
    const detail = await request(app).get(`/courses/${cpiId}`).set("Authorization", `Bearer ${coordToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.mode).toBeNull();
  });

  it("flips to SUPERVISOR_LED when a supervisor is invited, and the lecturer can accept", async () => {
    const cpiId = await createCpi("Supervisor-Led CPI");
    await setTimeline(cpiId, true);

    const invite = await request(app)
      .post(`/courses/${cpiId}/supervisors`)
      .set("Authorization", `Bearer ${coordToken}`)
      .send({ lecturerUserId: lect1UserId });
    expect(invite.status).toBe(201);
    expect(invite.body.invitationStatus).toBe("PENDING");

    const detail = await request(app).get(`/courses/${cpiId}`).set("Authorization", `Bearer ${coordToken}`);
    expect(detail.body.mode).toBe("SUPERVISOR_LED");

    const respond = await request(app)
      .post(`/courses/${cpiId}/supervisors/respond`)
      .set("Authorization", `Bearer ${lect1Token}`)
      .send({ decision: "ACCEPT" });
    expect(respond.status).toBe(200);
    expect(respond.body.invitationStatus).toBe("ACCEPTED");
  });

  it("assigns an evaluator and promotes exactly one to Head Judge", async () => {
    const cpiId = await createCpi("Evaluator CPI");
    await setTimeline(cpiId, true);

    // Head Judge must come from the evaluator pool.
    const early = await request(app)
      .post(`/courses/${cpiId}/head-judge`)
      .set("Authorization", `Bearer ${coordToken}`)
      .send({ lecturerUserId: lect2UserId });
    expect(early.status).toBe(400);

    const assign = await request(app)
      .post(`/courses/${cpiId}/evaluators`)
      .set("Authorization", `Bearer ${coordToken}`)
      .send({ lecturerUserId: lect2UserId });
    expect(assign.status).toBe(201);

    const hj = await request(app)
      .post(`/courses/${cpiId}/head-judge`)
      .set("Authorization", `Bearer ${coordToken}`)
      .send({ lecturerUserId: lect2UserId });
    expect(hj.status).toBe(200);
    expect(hj.body.isHeadJudge).toBe(true);
  });

  it("rejects a Step-3 action outside the SUPERVISOR_ADDITION window", async () => {
    const cpiId = await createCpi("Future CPI");
    await setTimeline(cpiId, false); // whole timeline in the future

    const invite = await request(app)
      .post(`/courses/${cpiId}/supervisors`)
      .set("Authorization", `Bearer ${coordToken}`)
      .send({ lecturerUserId: lect1UserId });
    expect(invite.status).toBe(403);
    expect(invite.body.code).toBe("PHASE_NOT_OPEN");
  });

  it("finalizes as COORDINATOR_MANAGED and then blocks supervisor invites", async () => {
    const cpiId = await createCpi("Coordinator-Managed CPI");
    await setTimeline(cpiId, true);

    const finalize = await request(app)
      .post(`/courses/${cpiId}/finalize-coordinator-managed`)
      .set("Authorization", `Bearer ${coordToken}`);
    expect(finalize.status).toBe(200);
    expect(finalize.body.mode).toBe("COORDINATOR_MANAGED");

    const invite = await request(app)
      .post(`/courses/${cpiId}/supervisors`)
      .set("Authorization", `Bearer ${coordToken}`)
      .send({ lecturerUserId: lect1UserId });
    expect(invite.status).toBe(409);
  });

  it("enforces RBAC and CPI-scope: non-coordinators are blocked", async () => {
    const cpiId = await createCpi("Scoped CPI");

    const create = await request(app)
      .post("/courses")
      .set("Authorization", `Bearer ${lect1Token}`)
      .send({ name: "x", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
    expect(create.status).toBe(403);

    const view = await request(app).get(`/courses/${cpiId}`).set("Authorization", `Bearer ${lect1Token}`);
    expect(view.status).toBe(403);
  });
});
