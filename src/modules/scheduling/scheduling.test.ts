import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

const h = createHarness("scheduling.");
const { as, userIds, makeUser, login, openPhase, cleanup } = h;

// A course with two groups, one supervisor, one evaluator, and one stage that
// needs a supervisor on the panel. Each group gets a session. Stops at
// AVAILABILITY_SUBMISSION, the phase where scheduling happens.
async function setup() {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name: "Scheduling CPI", projectType: "FYP", participationMode: "GROUP", batch: "22ENG", department: "CE", academicYear: "2026" });
  const cpiId = create.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const groupA = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  const groupB = await request(app).post(`/courses/${cpiId}/groups`).set(as("s2")).send({ name: "Group B" });

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  await request(app).post(`/courses/${cpiId}/supervisors`).set(as("coord")).send({ lecturerUserId: userIds.sup }).expect(201);
  await request(app).post(`/courses/${cpiId}/supervisors/respond`).set(as("sup")).send({ decision: "ACCEPT" }).expect(200);
  await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds.ev }).expect(201);

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  // The supervisor posts it, because a new course does not let the coordinator
  // post ideas until a preset is applied.
  const idea = await request(app)
    .post(`/courses/${cpiId}/ideas`)
    .set(as("sup"))
    .send({ title: "I", description: "d" })
    .expect(201);

  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  for (const groupId of [groupA.body.id, groupB.body.id]) {
    await request(app)
      .put(`/courses/${cpiId}/allocations/${groupId}`)
      .set(as("coord"))
      .send({ ideaId: idea.body.id, supervisorUserId: userIds.sup })
      .expect(200);
  }

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
          // The supervisor has to be there. This is the rule the clash check uses.
          panelRules: [
            { role: "SUPERVISOR", minRequired: 1 },
            { role: "EVALUATOR", minRequired: 1 },
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
  const sessions = gen.body.sessions as { id: string; group: { id: string; name: string } }[];

  return {
    cpiId,
    stageId: stage.id as string,
    sessionA: sessions.find((s) => s.group.name === "Group A")!.id,
    sessionB: sessions.find((s) => s.group.name === "Group B")!.id,
  };
}

// A grid covering three days in a row, with a morning and an afternoon slot.
async function setGrid(cpiId: string, firstDay: Date) {
  const day = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const res = await request(app)
    .put(`/courses/${cpiId}/availability/template`)
    .set(as("coord"))
    .send({
      windowStart: iso(firstDay),
      windowEnd: iso(new Date(firstDay.getTime() + 2 * day)),
      slots: [
        { name: "Morning", startTime: "09:00", endTime: "12:00" },
        { name: "Afternoon", startTime: "13:00", endTime: "17:00" },
      ],
    })
    .expect(200);
  return {
    dates: [iso(firstDay), iso(new Date(firstDay.getTime() + day)), iso(new Date(firstDay.getTime() + 2 * day))],
    morning: res.body.slots[0].id as string,
    afternoon: res.body.slots[1].id as string,
  };
}

// A time on one of the grid's dates, read the same way the service reads slots.
function at(date: string, hours: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hours).toISOString();
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("sup", Role.LECTURER, { approvedLecturer: true });
  await makeUser("ev", Role.LECTURER, { approvedLecturer: true });
  await makeUser("outsider", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  for (const k of ["coord", "sup", "ev", "outsider", "s1", "s2"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("Availability grid", () => {
  it("round-trips all three states and reports who has not answered", async () => {
    const { cpiId } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    const submitted = await request(app)
      .put(`/courses/${cpiId}/availability`)
      .set(as("ev"))
      .send({
        entries: [
          { templateSlotId: grid.morning, slotDate: grid.dates[0], status: "AVAILABLE" },
          { templateSlotId: grid.afternoon, slotDate: grid.dates[0], status: "TENTATIVE", note: "Might be teaching" },
          { templateSlotId: grid.morning, slotDate: grid.dates[1], status: "UNAVAILABLE" },
        ],
      })
      .expect(200);

    expect(submitted.body.entries).toHaveLength(3);
    expect(submitted.body.entries.map((e: { status: string }) => e.status).sort()).toEqual([
      "AVAILABLE",
      "TENTATIVE",
      "UNAVAILABLE",
    ]);

    // The old version had no way to see what you had sent.
    const mine = await request(app).get(`/courses/${cpiId}/availability/mine`).set(as("ev")).expect(200);
    expect(mine.body.entries).toHaveLength(3);
    expect(mine.body.required).toBe(true);

    // The whole grid is sent, so a cell left out is cleared. That is how a
    // lecturer takes a slot back.
    const reduced = await request(app)
      .put(`/courses/${cpiId}/availability`)
      .set(as("ev"))
      .send({ entries: [{ templateSlotId: grid.morning, slotDate: grid.dates[0], status: "AVAILABLE" }] })
      .expect(200);
    expect(reduced.body.entries).toHaveLength(1);

    // The coordinator sees the answers and who has not replied.
    const all = await request(app).get(`/courses/${cpiId}/availability`).set(as("coord")).expect(200);
    expect(all.body.entries).toHaveLength(1);
    expect(all.body.outstanding).toHaveLength(0);
  });

  it("accepts a supervisor who is not in the evaluator pool", async () => {
    const { cpiId } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    // The old version only allowed evaluators, so this used to fail with a 403.
    await request(app)
      .put(`/courses/${cpiId}/availability`)
      .set(as("sup"))
      .send({ entries: [{ templateSlotId: grid.morning, slotDate: grid.dates[0], status: "AVAILABLE" }] })
      .expect(200);

    // Someone with no role in the course still cannot.
    await request(app)
      .put(`/courses/${cpiId}/availability`)
      .set(as("outsider"))
      .send({ entries: [{ templateSlotId: grid.morning, slotDate: grid.dates[0], status: "AVAILABLE" }] })
      .expect(403);
  });

  it("rejects a cell outside the published window", async () => {
    const { cpiId } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const outside = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await request(app)
      .put(`/courses/${cpiId}/availability`)
      .set(as("ev"))
      .send({ entries: [{ templateSlotId: grid.morning, slotDate: outside, status: "AVAILABLE" }] })
      .expect(400);
  });
});

describe("Timetable conflicts", () => {
  it("names the required supervisor when the slot is outside their availability", async () => {
    const { cpiId, sessionA } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    // The supervisor fills in the grid and says the first morning does not work.
    await request(app)
      .put(`/courses/${cpiId}/availability`)
      .set(as("sup"))
      .send({
        entries: [
          { templateSlotId: grid.morning, slotDate: grid.dates[0], status: "UNAVAILABLE" },
          { templateSlotId: grid.morning, slotDate: grid.dates[1], status: "AVAILABLE" },
        ],
      })
      .expect(200);

    const scheduled = await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10), location: "Lab 1" })
      .expect(200);

    // Still booked. Clashes only warn, they never block.
    expect(scheduled.body.session.scheduledStart).toBeTruthy();
    const availabilityConflict = scheduled.body.conflicts.find(
      (c: { kind: string }) => c.kind === "OUTSIDE_AVAILABILITY",
    );
    expect(availabilityConflict).toBeDefined();
    expect(availabilityConflict.message).toContain("sup");
  });

  it("flags a room and a panelist booked twice at once", async () => {
    const { cpiId, sessionA, sessionB } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10), location: "Lab 1" })
      .expect(200);

    // Group B has the same panel and the same room at the same time.
    const clash = await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionB}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10), location: "Lab 1" })
      .expect(200);

    const kinds = clash.body.conflicts.map((c: { kind: string }) => c.kind);
    expect(kinds).toContain("PANELIST_DOUBLE_BOOKED");
    expect(kinds).toContain("ROOM_DOUBLE_BOOKED");
  });

  it("offers slots where every required panelist is free", async () => {
    const { cpiId, sessionA } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    for (const key of ["sup", "ev"]) {
      await request(app)
        .put(`/courses/${cpiId}/availability`)
        .set(as(key))
        .send({
          entries: [
            { templateSlotId: grid.morning, slotDate: grid.dates[0], status: "UNAVAILABLE" },
            { templateSlotId: grid.afternoon, slotDate: grid.dates[1], status: "AVAILABLE" },
          ],
        })
        .expect(200);
    }

    await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10), allocatedMinutes: 60 })
      .expect(200);

    const alternatives = await request(app)
      .get(`/courses/${cpiId}/sessions/${sessionA}/alternative-slots`)
      .set(as("coord"))
      .expect(200);

    // Only the slot both of them marked free is offered.
    expect(alternatives.body.length).toBeGreaterThan(0);
    for (const slot of alternatives.body) {
      expect(slot.slotDate).toBe(grid.dates[1]);
      expect(slot.slotName).toBe("Afternoon");
      expect(slot.allAvailable).toBe(true);
    }
  });

  it("still allows a reschedule after the availability phase has closed", async () => {
    const { cpiId, sessionA } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10) })
      .expect(200);

    // The availability window closes, but the timetable must still be editable.
    await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);
    await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[1], 14), scheduledEnd: at(grid.dates[1], 15) })
      .expect(200);
  });
});

describe("Schedule visibility", () => {
  it("shows a student their own group's sessions and no one else's", async () => {
    const { cpiId, sessionA } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10), location: "Lab 1" })
      .expect(200);

    // Students used to get a 403 here and could not see the schedule at all.
    const mine = await request(app).get(`/courses/${cpiId}/sessions`).set(as("s1")).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].group.name).toBe("Group A");
    expect(mine.body[0].location).toBe("Lab 1");

    // The supervisor sees both of the groups they supervise.
    const supervised = await request(app).get(`/courses/${cpiId}/sessions`).set(as("sup")).expect(200);
    expect(supervised.body).toHaveLength(2);

    await request(app).get(`/courses/${cpiId}/sessions`).set(as("outsider")).expect(403);
  });

  it("lets an unassigned lecturer find and join an evaluation that is open to all", async () => {
    const { cpiId, stageId, sessionA } = await setup();

    // "outsider" is an approved lecturer with no role on this course, which is
    // the FYP demo-day case: nobody is assigned and whoever attends may mark.
    await request(app).get(`/courses/${cpiId}/sessions`).set(as("outsider")).expect(403);

    await request(app)
      .put(`/courses/${cpiId}/evaluations/stages/${stageId}/panel-rules`)
      .set(as("coord"))
      .send({
        rules: [
          { role: "SUPERVISOR", minRequired: 1 },
          { role: "EVALUATOR", minRequired: 0, openToAll: true },
        ],
      })
      .expect(200);

    // Finding the session is the whole point: without this the join endpoint
    // existed but there was no way to reach a session id.
    const open = await request(app).get(`/courses/${cpiId}/sessions`).set(as("outsider")).expect(200);
    expect(open.body).toHaveLength(2);

    // Seats are taken on the day, so joining is gated to the execution phase.
    await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);

    const joined = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionA}/panel/join`)
      .set(as("outsider"))
      .send({ role: "EVALUATOR" })
      .expect(201);
    expect(joined.body.role).toBe("EVALUATOR");

    // Joining twice is the same seat, not a second one.
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionA}/panel/join`)
      .set(as("outsider"))
      .send({ role: "EVALUATOR" })
      .expect(201);
    const panel = await request(app).get(`/courses/${cpiId}/sessions/${sessionA}/panel`).set(as("coord")).expect(200);
    expect(panel.body.panelists.filter((pl: { user: { id: string } | null }) => pl.user?.id === userIds.outsider)).toHaveLength(1);
  });

  it("keeps a course with no open stage closed to outsiders", async () => {
    // Widening visibility must not turn every timetable into a public one.
    const { cpiId } = await setup();
    await request(app).get(`/courses/${cpiId}/sessions`).set(as("outsider")).expect(403);
  });

  it("builds a printable sheet with each group's members by index number", async () => {
    const { cpiId, sessionA } = await setup();
    const grid = await setGrid(cpiId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    await request(app)
      .put(`/courses/${cpiId}/sessions/${sessionA}/schedule`)
      .set(as("coord"))
      .send({ scheduledStart: at(grid.dates[0], 9), scheduledEnd: at(grid.dates[0], 10), location: "Lab 1" })
      .expect(200);

    const sheet = await request(app).get(`/courses/${cpiId}/schedule-sheet`).set(as("coord")).expect(200);
    const groupA = sheet.body.rows.find((r: { groupName: string }) => r.groupName === "Group A");
    expect(groupA.members[0]).toMatchObject({ no: 1, indexNumber: `${h.prefix}s1` });
    expect(groupA.location).toBe("Lab 1");
    // Group B has no time yet, and the sheet shows that instead of hiding it.
    expect(sheet.body.unscheduled).toBe(1);

    await request(app).get(`/courses/${cpiId}/schedule-sheet`).set(as("s1")).expect(403);
  });
});
