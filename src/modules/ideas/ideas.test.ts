import bcrypt from "bcrypt";
import request from "supertest";
import { CpiPhase, LecturerApprovalStatus, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";

const PREFIX = "w4jest.";
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

// Timeline anchored so `openPhase` brackets "now"; earlier phases are in the
// past, later phases in the future. Lets a single test walk sequential phases.
function timelineOpening(openPhase: CpiPhase) {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const k = PHASE_ORDER.indexOf(openPhase);
  const base = Date.now() - hour - k * day; // so phase k starts 1h ago
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
  const email = `${PREFIX}${key}@psems.dev`;
  const hash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email,
      fullName: key,
      passwordHash: hash,
      role,
      ...(opts.student ? { student: { create: { studentId: `${PREFIX}${key}`, department: "CE", year: 3 } } } : {}),
      ...(opts.approvedLecturer
        ? { lecturer: { create: { approvalStatus: LecturerApprovalStatus.APPROVED } } }
        : {}),
    },
  });
  userIds[key] = user.id;
}

async function login(key: string) {
  const res = await request(app)
    .post("/auth/login")
    .send({ email: `${PREFIX}${key}@psems.dev`, password: PASSWORD });
  expect(res.status).toBe(200);
  tokens[key] = res.body.accessToken;
}

function as(key: string) {
  return { Authorization: `Bearer ${tokens[key]}` };
}

async function openPhase(cpiId: string, phase: CpiPhase) {
  const res = await request(app).put(`/courses/${cpiId}/timeline`).set(as("coord")).send(timelineOpening(phase));
  expect(res.status).toBe(200);
}

async function cleanup() {
  await prisma.courseInstance.deleteMany({ where: { createdBy: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("sup", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  await makeUser("s3", Role.STUDENT, { student: true });
  for (const k of ["coord", "sup", "s1", "s2", "s3"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

async function createCpi(name: string) {
  const res = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name, projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Forms group A (s1 leader + s2) and group B (s3) in the given CPI during the
// STUDENT_REGISTRATION window. Returns the two group ids.
async function formGroups(cpiId: string) {
  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);

  const gA = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  expect(gA.status).toBe(201);
  const groupA = gA.body.id as string;

  const inv = await request(app)
    .post(`/courses/${cpiId}/groups/${groupA}/invite`)
    .set(as("s1"))
    .send({ email: `${PREFIX}s2@psems.dev` });
  expect(inv.status).toBe(201);
  const acc = await request(app).post(`/courses/${cpiId}/groups/${groupA}/respond`).set(as("s2")).send({ decision: "ACCEPT" });
  expect(acc.status).toBe(200);

  const gB = await request(app).post(`/courses/${cpiId}/groups`).set(as("s3")).send({ name: "Group B" });
  expect(gB.status).toBe(201);
  return { groupA, groupB: gB.body.id as string };
}

function titles(list: { body: unknown }) {
  return (list.body as { title: string }[]).map((i) => i.title).sort();
}

describe("Week 4: group formation", () => {
  it("leader forms a group, invites a member who accepts, and one-group-per-CPI holds", async () => {
    const cpiId = await createCpi("Group Formation CPI");
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);

    const create = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Team 1" });
    expect(create.status).toBe(201);
    const groupId = create.body.id as string;

    const invite = await request(app)
      .post(`/courses/${cpiId}/groups/${groupId}/invite`)
      .set(as("s1"))
      .send({ email: `${PREFIX}s2@psems.dev` });
    expect(invite.status).toBe(201);
    expect(invite.body.status).toBe("PENDING");

    const accept = await request(app)
      .post(`/courses/${cpiId}/groups/${groupId}/respond`)
      .set(as("s2"))
      .send({ decision: "ACCEPT" });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe("ACCEPTED");

    const mine = await request(app).get(`/courses/${cpiId}/groups/mine`).set(as("s2"));
    expect(mine.body.group.members).toHaveLength(2);

    // s2 can't now create another group in the same CPI.
    const second = await request(app).post(`/courses/${cpiId}/groups`).set(as("s2")).send({ name: "Team 2" });
    expect(second.status).toBe(409);
  });

  it("blocks group creation outside the STUDENT_REGISTRATION window", async () => {
    const cpiId = await createCpi("Locked Groups CPI");
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT); // registration already closed
    const create = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Too Late" });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("PHASE_CLOSED");
  });
});

describe("Week 4: idea visibility — Supervisor-Led", () => {
  it("supervisor idea is public; student ideas are visible only to their own group", async () => {
    const cpiId = await createCpi("Supervisor-Led Ideas CPI");
    await formGroups(cpiId);

    // Advance to supervisor addition; invite + accept supervisor -> SUPERVISOR_LED.
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await request(app).post(`/courses/${cpiId}/supervisors`).set(as("coord")).send({ lecturerUserId: userIds.sup }).expect(201);
    await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as("sup")).send({ decision: "ACCEPT" }).expect(200);

    // Advance to idea announcement and post.
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    await request(app).post(`/courses/${cpiId}/ideas`).set(as("sup")).send({ title: "SUP-IDEA", description: "d" }).expect(201);
    await request(app).post(`/courses/${cpiId}/ideas`).set(as("s1")).send({ title: "GROUP-A-IDEA", description: "d" }).expect(201);
    await request(app).post(`/courses/${cpiId}/ideas`).set(as("s3")).send({ title: "GROUP-B-IDEA", description: "d" }).expect(201);

    // Student in group A: public supervisor idea + own group idea only.
    const a1View = await request(app).get(`/courses/${cpiId}/ideas`).set(as("s1"));
    expect(titles(a1View)).toEqual(["GROUP-A-IDEA", "SUP-IDEA"]);

    // Student in group B: public supervisor idea + own group idea only.
    const b1View = await request(app).get(`/courses/${cpiId}/ideas`).set(as("s3"));
    expect(titles(b1View)).toEqual(["GROUP-B-IDEA", "SUP-IDEA"]);

    // Supervisor and coordinator see everything.
    const supView = await request(app).get(`/courses/${cpiId}/ideas`).set(as("sup"));
    expect(titles(supView)).toEqual(["GROUP-A-IDEA", "GROUP-B-IDEA", "SUP-IDEA"]);
    const coordView = await request(app).get(`/courses/${cpiId}/ideas`).set(as("coord"));
    expect(titles(coordView)).toEqual(["GROUP-A-IDEA", "GROUP-B-IDEA", "SUP-IDEA"]);

    // A coordinator cannot post ideas in Supervisor-Led mode.
    const coordPost = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "X", description: "d" });
    expect(coordPost.status).toBe(403);
  });
});

describe("Week 4: idea visibility + approval — Coordinator-Managed", () => {
  it("coordinator idea is public; student ideas need approval and stay group-restricted", async () => {
    const cpiId = await createCpi("Coordinator-Managed Ideas CPI");
    await formGroups(cpiId);

    // Skip supervisors -> COORDINATOR_MANAGED.
    await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
    await request(app).post(`/courses/${cpiId}/finalize-coordinator-managed`).set(as("coord")).expect(200);

    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "COORD-IDEA", description: "d" }).expect(201);
    const aPost = await request(app).post(`/courses/${cpiId}/ideas`).set(as("s1")).send({ title: "GROUP-A-IDEA", description: "d" });
    expect(aPost.status).toBe(201);
    expect(aPost.body.approvalStatus).toBe("PENDING");
    await request(app).post(`/courses/${cpiId}/ideas`).set(as("s3")).send({ title: "GROUP-B-IDEA", description: "d" }).expect(201);

    // Group A student sees coordinator idea + own group idea; not group B's.
    const a1View = await request(app).get(`/courses/${cpiId}/ideas`).set(as("s1"));
    expect(titles(a1View)).toEqual(["COORD-IDEA", "GROUP-A-IDEA"]);

    // Coordinator approves group A's idea.
    const ideaId = (a1View.body as { id: string; title: string }[]).find((i) => i.title === "GROUP-A-IDEA")!.id;
    const approve = await request(app).post(`/courses/${cpiId}/ideas/${ideaId}/approve`).set(as("coord"));
    expect(approve.status).toBe(200);
    expect(approve.body.approvalStatus).toBe("APPROVED");

    // Even approved, group A's idea stays hidden from group B.
    const b1View = await request(app).get(`/courses/${cpiId}/ideas`).set(as("s3"));
    expect(titles(b1View)).toEqual(["COORD-IDEA", "GROUP-B-IDEA"]);
  });
});
