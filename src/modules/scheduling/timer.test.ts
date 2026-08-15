import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

const h = createHarness("timer.");
const { as, userIds, makeUser, login, openPhase, cleanup } = h;

// A course with one session whose stage has two timer parts, stopped at
// EVALUATION_EXECUTION. The targets are short so the test can run past one fast.
async function setup() {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name: "Timer CPI", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
  const cpiId = create.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const group = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  await request(app).post(`/courses/${cpiId}/supervisors`).set(as("coord")).send({ lecturerUserId: userIds.sup }).expect(201);
  await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as("sup")).send({ decision: "ACCEPT" }).expect(200);
  await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds.ev }).expect(201);

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("sup")).send({ title: "I", description: "d" }).expect(201);

  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  await request(app)
    .put(`/courses/${cpiId}/allocations/${group.body.id}`)
    .set(as("coord"))
    .send({ ideaId: idea.body.id, supervisorUserId: userIds.sup })
    .expect(200);

  await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
  const config = await request(app)
    .put(`/courses/${cpiId}/evaluations/config`)
    .set(as("coord"))
    .send({
      stages: [
        {
          name: "Final",
          weight: 100,
          submissionRequired: false,
          panelRules: [{ role: "EVALUATOR", minRequired: 1 }],
          timerSegments: [
            { name: "Presentation", targetSeconds: 5 },
            { name: "Q&A", targetSeconds: 5 },
          ],
          criteria: [{ name: "C1", weight: 100, maxScore: 10 }],
        },
      ],
    })
    .expect(200);
  const stage = config.body[0];
  await request(app)
    .post(`/courses/${cpiId}/evaluations/stages/${stage.id}/evaluators`)
    .set(as("coord"))
    .send({ lecturerUserId: userIds.ev })
    .expect(201);

  await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
  const gen = await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord")).expect(201);
  const sessionId = (gen.body.sessions as { id: string }[])[0].id;

  await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);
  return { cpiId, stageId: stage.id as string, sessionId };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("Multi-segment presentation timer", () => {
  it("copies the stage's running order onto the session on first use", async () => {
    const { cpiId, sessionId } = await setup();

    const timer = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).expect(200);
    expect(timer.body.segments).toHaveLength(0);

    const started = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/timer`)
      .set(as("ev"))
      .send({ action: "start" })
      .expect(200);

    expect(started.body.segments.map((s: { name: string }) => s.name)).toEqual(["Presentation", "Q&A"]);
    expect(started.body.currentSegmentIndex).toBe(0);
    expect(started.body.segments[0].running).toBe(true);
  });

  it("advances only on Next, and records the overrun of the segment it leaves", async () => {
    const { cpiId, sessionId } = await setup();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).send({ action: "start" }).expect(200);

    // Go past the 5 second target. Nothing moves on by itself, which is the point:
    // if it did, running late could never be recorded.
    await wait(6200);
    const stillFirst = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).expect(200);
    expect(stillFirst.body.currentSegmentIndex).toBe(0);
    expect(stillFirst.body.segments[0].running).toBe(true);
    expect(stillFirst.body.segments[0].overranSeconds).toBeGreaterThan(0);

    const advanced = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/timer`)
      .set(as("ev"))
      .send({ action: "next" })
      .expect(200);

    expect(advanced.body.currentSegmentIndex).toBe(1);
    expect(advanced.body.segments[0].running).toBe(false);
    expect(advanced.body.segments[0].overranSeconds).toBeGreaterThan(0);
    expect(advanced.body.segments[0].timeliness).toBe("OVERTIME");
    // The clock keeps going into the next part instead of starting again.
    expect(advanced.body.segments[1].running).toBe(true);
    expect(advanced.body.running).toBe(true);
  }, 20_000);

  it("refuses to advance past the last segment", async () => {
    const { cpiId, sessionId } = await setup();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).send({ action: "start" }).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).send({ action: "next" }).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).send({ action: "next" }).expect(409);
  });

  it("banks the total on stop and clears everything on reset", async () => {
    const { cpiId, sessionId } = await setup();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).send({ action: "start" }).expect(200);
    await wait(1200);

    const stopped = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/timer`)
      .set(as("ev"))
      .send({ action: "stop" })
      .expect(200);
    expect(stopped.body.running).toBe(false);
    expect(stopped.body.presentationDurationSeconds).toBeGreaterThanOrEqual(1);

    const reset = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/timer`)
      .set(as("ev"))
      .send({ action: "reset" })
      .expect(200);
    expect(reset.body.elapsedSeconds).toBe(0);
    expect(reset.body.presentationDurationSeconds).toBeNull();
    expect(reset.body.currentSegmentIndex).toBe(0);
    expect(reset.body.segments.every((s: { elapsedSeconds: number }) => s.elapsedSeconds === 0)).toBe(true);
  }, 15_000);

  it("keeps a hand-corrected verdict when the segment closes", async () => {
    const { cpiId, sessionId } = await setup();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).send({ action: "start" }).expect(200);

    const timer = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("ev")).expect(200);
    const first = timer.body.segments[0];

    // A group that finished early on purpose should not be marked down for it, so
    // the result can be changed by hand.
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/segments/${first.id}/timeliness`)
      .set(as("ev"))
      .send({ timeliness: "ON_TIME" })
      .expect(200);

    const advanced = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/timer`)
      .set(as("ev"))
      .send({ action: "next" })
      .expect(200);

    expect(advanced.body.segments[0].timeliness).toBe("ON_TIME");
    expect(advanced.body.segments[0].timelinessManual).toBe(true);
  });

  it("lets only the coordinator or a panelist drive the clock", async () => {
    const { cpiId, sessionId } = await setup();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("coord")).send({ action: "start" }).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/timer`).set(as("s1")).send({ action: "pause" }).expect(403);
  });
});
