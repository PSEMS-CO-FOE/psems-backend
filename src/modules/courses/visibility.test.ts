import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

const h = createHarness("visibility.");
const { as, makeUser, login, openPhase, cleanup } = h;

const DEPARTMENT = "CE-VIS";
const BATCH = "VIS22ENG";
const PAST_BATCH = "VIS21ENG";

async function makeCourse(opts: { batch: string; name?: string; publish?: boolean }) {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({
      name: opts.name ?? `Course ${opts.batch}`,
      projectType: "Data Management Project",
      participationMode: "INDIVIDUAL",
      department: DEPARTMENT,
      batch: opts.batch,
      academicYear: "2026/2027",
    })
    .expect(201);

  const cpiId = create.body.id as string;
  if (opts.publish) {
    await request(app).post(`/courses/${cpiId}/status`).set(as("coord")).send({ status: "ACTIVE" }).expect(200);
  }
  return cpiId;
}

const listFor = (key: string) => request(app).get("/courses/mine/student").set(as(key));

interface RosterBody {
  rows: { indexNumber: string; working: string; offTarget: boolean }[];
}

// By index number, not by position — ordering should never decide a result.
function rowFor(roster: RosterBody, key: string) {
  return roster.rows.find((r) => r.indexNumber === `${h.prefix}${key}`)!;
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  // s22 is in the current batch; s21 is a year older and repeating.
  await makeUser("s22", Role.STUDENT, { student: true, batch: BATCH, department: DEPARTMENT });
  await makeUser("s21", Role.STUDENT, { student: true, batch: PAST_BATCH, department: DEPARTMENT });
  for (const k of ["coord", "s22", "s21"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("Course discovery", () => {
  it("shows a student their own batch's active courses and not another batch's", async () => {
    const mine = await makeCourse({ batch: BATCH, name: "DMP 22ENG", publish: true });
    await makeCourse({ batch: PAST_BATCH, name: "DMP 21ENG", publish: true });

    const list = await listFor("s22").expect(200);
    const ids = list.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(mine);
    expect(list.body.every((c: { batch: string }) => c.batch === BATCH)).toBe(true);
  });

  it("hides a draft course from students and keeps it for its coordinator", async () => {
    const draft = await makeCourse({ batch: BATCH, name: "Not ready" });

    const list = await listFor("s22").expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).not.toContain(draft);

    // The coordinator still sees everything they created.
    const owned = await request(app).get("/courses").set(as("coord")).expect(200);
    expect(owned.body.map((c: { id: string }) => c.id)).toContain(draft);
  });

  it("keeps a course visible to a student who joined it, after it is archived", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Finished", publish: true });
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await request(app).post(`/courses/${cpiId}/groups/solo`).set(as("s22")).expect(201);

    await request(app).post(`/courses/${cpiId}/status`).set(as("coord")).send({ status: "ARCHIVED" }).expect(200);

    const list = await listFor("s22").expect(200);
    const entry = list.body.find((c: { id: string }) => c.id === cpiId);
    expect(entry).toBeDefined();
    expect(entry.status).toBe("ARCHIVED");
  });

  it("treats batches differing only by case or spacing as the same batch", async () => {
    const cpiId = await makeCourse({ batch: " vis22eng ", name: "Sloppy batch", publish: true });

    const stored = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { batch: true } });
    expect(stored?.batch).toBe(BATCH);

    const list = await listFor("s22").expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(cpiId);
  });

  it("refuses to create a course without a batch", async () => {
    await request(app)
      .post("/courses")
      .set(as("coord"))
      .send({
        name: "No batch",
        projectType: "FYP",
        participationMode: "GROUP",
        department: DEPARTMENT,
        academicYear: "2026/2027",
      })
      .expect(400);
  });
});

describe("Joining another batch's course", () => {
  it("lets a repeated student ask, and shows the course once approved", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Retake target", publish: true });

    // Not visible to the older student to begin with.
    expect((await listFor("s21")).body.map((c: { id: string }) => c.id)).not.toContain(cpiId);

    // They can still find it by name, without seeing its contents.
    const others = await request(app).get("/courses/other-batches").set(as("s21")).expect(200);
    expect(others.body.map((c: { id: string }) => c.id)).toContain(cpiId);

    const asked = await request(app)
      .post(`/courses/${cpiId}/join-requests`)
      .set(as("s21"))
      .send({ reason: "Repeating after failing last year" })
      .expect(201);

    // Pending is not access.
    expect((await listFor("s21")).body.map((c: { id: string }) => c.id)).not.toContain(cpiId);

    const queue = await request(app).get(`/courses/${cpiId}/join-requests`).set(as("coord")).expect(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].student.batch).toBe(PAST_BATCH);

    await request(app)
      .post(`/courses/${cpiId}/join-requests/${asked.body.id}`)
      .set(as("coord"))
      .send({ approve: true })
      .expect(200);

    expect((await listFor("s21")).body.map((c: { id: string }) => c.id)).toContain(cpiId);
  });

  it("does not grant access on a rejected request", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Declined", publish: true });
    const asked = await request(app)
      .post(`/courses/${cpiId}/join-requests`)
      .set(as("s21"))
      .send({ reason: "Please" })
      .expect(201);

    await request(app)
      .post(`/courses/${cpiId}/join-requests/${asked.body.id}`)
      .set(as("coord"))
      .send({ approve: false })
      .expect(200);

    expect((await listFor("s21")).body.map((c: { id: string }) => c.id)).not.toContain(cpiId);
  });

  it("refuses a request for the student's own batch", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Already mine", publish: true });
    await request(app)
      .post(`/courses/${cpiId}/join-requests`)
      .set(as("s22"))
      .send({ reason: "n/a" })
      .expect(409);
  });

  it("lets an approved student start after registration has closed, and no one else", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Late start", publish: true });
    const asked = await request(app)
      .post(`/courses/${cpiId}/join-requests`)
      .set(as("s21"))
      .send({ reason: "Repeating" })
      .expect(201);
    await request(app)
      .post(`/courses/${cpiId}/join-requests/${asked.body.id}`)
      .set(as("coord"))
      .send({ approve: true })
      .expect(200);

    // The course has moved on — registration is long shut. This is the normal
    // case, because a repeat is decided after the previous course finished.
    await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);

    // The approved student can still form their group.
    await request(app).post(`/courses/${cpiId}/groups/solo`).set(as("s21")).expect(201);

    // A student of the course's own batch cannot — the window really is closed.
    await request(app).post(`/courses/${cpiId}/groups/solo`).set(as("s22")).expect(403);
  });

  it("lets an approved student reach selection too, but not the submission window", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Late selection", publish: true });
    const asked = await request(app)
      .post(`/courses/${cpiId}/join-requests`)
      .set(as("s21"))
      .send({ reason: "Repeating" })
      .expect(201);
    await request(app)
      .post(`/courses/${cpiId}/join-requests/${asked.body.id}`)
      .set(as("coord"))
      .send({ approve: true })
      .expect(200);

    await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);

    // Selection is the other phase that closes before a repeat is decided.
    // The phase middleware answers with a `code`, which is what tells its 403
    // apart from any the service itself raises.
    const reached = await request(app)
      .post(`/courses/${cpiId}/selection/interest`)
      .set(as("s21"))
      .send({ ideaId: "00000000-0000-0000-0000-000000000000" });
    expect(reached.body.code).toBeUndefined();

    // The lift is scoped to catching up. Idea posting is not one of those
    // phases, so it stays shut for them exactly as it is for everyone else.
    const ideas = await request(app)
      .post(`/courses/${cpiId}/ideas`)
      .set(as("s21"))
      .send({ title: "Late idea", description: "d" });
    expect(ideas.status).toBe(403);
    expect(ideas.body.code).toBe("PHASE_CLOSED");
  });
});

describe("Group size", () => {
  it("accepts a group that is over or under the target, and flags it", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Odd sizes", publish: true });
    await request(app)
      .patch(`/courses/${cpiId}/policy`)
      .set(as("coord"))
      .send({ targetGroupSize: 4 })
      .expect(200);
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);

    // One student, target four. The batch will not divide evenly, so this is
    // expected — flagged for the coordinator, never refused.
    await request(app).post(`/courses/${cpiId}/groups/solo`).set(as("s22")).expect(201);

    const roster = await request(app).get(`/courses/${cpiId}/roster`).set(as("coord")).expect(200);
    expect(roster.body.targetGroupSize).toBe(4);
    expect(rowFor(roster.body, "s22").offTarget).toBe(true);
    expect(roster.body.alone).toBe(1);
  });
});

describe("The course roster", () => {
  it("lists every student in the batch, including those who have not started", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Roster", publish: true });
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    await request(app).post(`/courses/${cpiId}/groups/solo`).set(as("s22")).expect(201);

    const roster = await request(app).get(`/courses/${cpiId}/roster`).set(as("coord")).expect(200);
    expect(roster.body.batch).toBe(BATCH);
    // s22 is the only student in this batch, and they are working alone.
    expect(roster.body.total).toBe(1);
    expect(roster.body.alone).toBe(1);
    expect(roster.body.notStarted).toBe(0);
    expect(rowFor(roster.body, "s22").working).toBe("ALONE");
  });

  it("counts a student who never started", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Nobody started", publish: true });
    const roster = await request(app).get(`/courses/${cpiId}/roster`).set(as("coord")).expect(200);
    expect(roster.body.notStarted).toBe(1);
    expect(rowFor(roster.body, "s22").working).toBe("NOT_STARTED");
  });

  it("shows nobody when the batch is wrong, which is how a typo is caught", async () => {
    const cpiId = await makeCourse({ batch: "VIS23ENG", name: "Mistyped", publish: true });
    const roster = await request(app).get(`/courses/${cpiId}/roster`).set(as("coord")).expect(200);
    expect(roster.body.total).toBe(0);
  });

  it("includes an approved late joiner even though their batch differs", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "With a repeat", publish: true });
    const asked = await request(app)
      .post(`/courses/${cpiId}/join-requests`)
      .set(as("s21"))
      .send({ reason: "Repeating" })
      .expect(201);
    await request(app)
      .post(`/courses/${cpiId}/join-requests/${asked.body.id}`)
      .set(as("coord"))
      .send({ approve: true })
      .expect(200);

    const roster = await request(app).get(`/courses/${cpiId}/roster`).set(as("coord")).expect(200);
    expect(roster.body.total).toBe(2);
    expect(roster.body.rows.map((r: { indexNumber: string }) => r.indexNumber)).toContain(`${h.prefix}s21`);
  });

  it("is coordinator-only", async () => {
    const cpiId = await makeCourse({ batch: BATCH, name: "Private", publish: true });
    await request(app).get(`/courses/${cpiId}/roster`).set(as("s22")).expect(403);
  });
});
