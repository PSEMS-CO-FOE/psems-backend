import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

const h = createHarness("marks.");
const { as, email, userIds, makeUser, login, openPhase, cleanup } = h;

interface StageInput {
  name: string;
  weight: number;
  panelRules: { role: string; minRequired: number }[];
  submissionRequired: boolean;
  criteria: { name: string; weight: number; maxScore: number; level?: "GROUP" | "INDIVIDUAL" }[];
}

// A course taken all the way to an approved, finalized session, which is the
// only state marks can be worked out from. `students` join one group; the
// coordinator reviews unless a head judge is asked for.
async function setupApprovedSession(opts: {
  stage: StageInput;
  students: string[];
  evaluators: string[];
  headJudge?: boolean;
}) {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({ name: "Marks CPI", projectType: "FYP", participationMode: "GROUP", department: "CE", academicYear: "2026" });
  const cpiId = create.body.id as string;
  const [leader, ...others] = opts.students;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const group = await request(app).post(`/courses/${cpiId}/groups`).set(as(leader)).send({ name: "Group A" });
  const groupId = group.body.id as string;
  for (const member of others) {
    await request(app)
      .post(`/courses/${cpiId}/groups/${groupId}/invite`)
      .set(as(leader))
      .send({ email: email(member) })
      .expect(201);
    await request(app)
      .post(`/courses/${cpiId}/groups/${groupId}/respond`)
      .set(as(member))
      .send({ decision: "ACCEPT" })
      .expect(200);
  }

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  await request(app).post(`/courses/${cpiId}/coordinator-managed-preset`).set(as("coord")).expect(200);
  const pool = opts.headJudge ? [...opts.evaluators, "hj"] : opts.evaluators;
  for (const ev of pool) {
    await request(app).post(`/courses/${cpiId}/evaluators`).set(as("coord")).send({ lecturerUserId: userIds[ev] }).expect(201);
  }
  if (opts.headJudge) {
    await request(app).post(`/courses/${cpiId}/head-judge`).set(as("coord")).send({ lecturerUserId: userIds.hj }).expect(200);
    await request(app).patch(`/courses/${cpiId}/policy`).set(as("coord")).send({ headJudgeEnabled: true }).expect(200);
  }

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const idea = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "IDEA", description: "d" });

  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  await request(app).put(`/courses/${cpiId}/allocations/${groupId}`).set(as("coord")).send({ ideaId: idea.body.id }).expect(200);
  await request(app).post(`/courses/${cpiId}/allocations/finalize`).set(as("coord")).expect(200);

  await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
  const config = await request(app)
    .put(`/courses/${cpiId}/evaluations/config`)
    .set(as("coord"))
    .send({ stages: [opts.stage] })
    .expect(200);
  const stage = config.body[0];
  for (const ev of opts.evaluators) {
    await request(app)
      .post(`/courses/${cpiId}/evaluations/stages/${stage.id}/evaluators`)
      .set(as("coord"))
      .send({ lecturerUserId: userIds[ev] })
      .expect(201);
  }

  await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
  const gen = await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord"));
  const sessionId = (gen.body.sessions as { id: string; group: { id: string } }[]).find((s) => s.group.id === groupId)!.id;

  await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);

  const studentIds = await prisma.student.findMany({
    where: { user: { email: { in: opts.students.map(email) } } },
    select: { id: true, user: { select: { email: true } } },
  });
  const studentIdByKey = Object.fromEntries(
    opts.students.map((key) => [key, studentIds.find((s) => s.user.email === email(key))!.id]),
  );

  return {
    cpiId,
    groupId,
    sessionId,
    stageId: stage.id as string,
    criteria: stage.criteria as { id: string; name: string; level: string }[],
    studentIdByKey,
    reviewer: opts.headJudge ? "hj" : "coord",
  };
}

async function finalize(cpiId: string, sessionId: string, reviewer: string) {
  await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as(reviewer)).expect(200);
  await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as(reviewer)).expect(200);
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("ev1", Role.LECTURER, { approvedLecturer: true });
  await makeUser("ev2", Role.LECTURER, { approvedLecturer: true });
  await makeUser("hj", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  for (const k of ["coord", "ev1", "ev2", "hj", "s1", "s2"]) await login(k);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

const groupOnlyStage: StageInput = {
  name: "Final Demo",
  weight: 100,
  panelRules: [{ role: "EVALUATOR", minRequired: 2 }],
  submissionRequired: false,
  criteria: [
    { name: "C1", weight: 50, maxScore: 10 },
    { name: "C2", weight: 50, maxScore: 10 },
  ],
};

// Half the stage is the group's work, half is each member's own.
const mixedStage: StageInput = {
  name: "Final Demo",
  weight: 100,
  panelRules: [{ role: "EVALUATOR", minRequired: 1 }],
  submissionRequired: false,
  criteria: [
    { name: "Product", weight: 50, maxScore: 10, level: "GROUP" },
    { name: "Contribution", weight: 50, maxScore: 10, level: "INDIVIDUAL" },
  ],
};

describe("Group marks", () => {
  it("averages the panel, weights by stage, and shows the coordinator every group", async () => {
    const s = await setupApprovedSession({
      stage: groupOnlyStage,
      students: ["s1"],
      evaluators: ["ev1", "ev2"],
      headJudge: true,
    });
    const [c1, c2] = s.criteria;

    // 7 and 9 on each criterion average to 8/10, so 80% of the only stage.
    for (const [ev, score] of [["ev1", 7], ["ev2", 9]] as const) {
      await request(app)
        .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
        .set(as(ev))
        .send({ scores: [{ criterionId: c1.id, score }, { criterionId: c2.id, score }], overallComment: "Reviewed." })
        .expect(201);
    }
    await finalize(s.cpiId, s.sessionId, s.reviewer);

    const agg = await request(app).post(`/courses/${s.cpiId}/marks/aggregate`).set(as("coord")).expect(200);
    expect(agg.body.groups).toHaveLength(1);
    expect(agg.body.groups[0].overall).toBe(80);
    expect(agg.body.groups[0].stages[0].stageScorePercent).toBe(80);
    // Every member still gets a row, with no individual half to report.
    const student = agg.body.groups[0].students[0];
    expect(student.overall).toBe(80);
    expect(student.stages[0].stageScorePercent).toBe(80);
    expect(student.stages[0].individualComponentPercent).toBeNull();
  });

  it("refuses to aggregate before every session is approved", async () => {
    const s = await setupApprovedSession({ stage: groupOnlyStage, students: ["s1"], evaluators: ["ev1", "ev2"] });
    const [c1, c2] = s.criteria;
    await request(app)
      .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: [{ criterionId: c1.id, score: 8 }, { criterionId: c2.id, score: 8 }], overallComment: "Reviewed." })
      .expect(201);

    await request(app).post(`/courses/${s.cpiId}/marks/aggregate`).set(as("coord")).expect(409);
  });
});

describe("Individual marks", () => {
  it("gives two members of one group different totals from the same group score", async () => {
    const s = await setupApprovedSession({ stage: mixedStage, students: ["s1", "s2"], evaluators: ["ev1"] });
    const product = s.criteria.find((c) => c.name === "Product")!;
    const contribution = s.criteria.find((c) => c.name === "Contribution")!;

    // The group scores 8 on the shared criterion; the members score 10 and 6 on
    // their own. Each criterion is worth half the stage.
    await request(app)
      .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
      .set(as("ev1"))
      .send({
        scores: [
          { criterionId: product.id, score: 8 },
          { criterionId: contribution.id, studentId: s.studentIdByKey.s1, score: 10 },
          { criterionId: contribution.id, studentId: s.studentIdByKey.s2, score: 6 },
        ],
        overallComment: "Reviewed.",
      })
      .expect(201);
    await finalize(s.cpiId, s.sessionId, s.reviewer);

    const agg = await request(app).post(`/courses/${s.cpiId}/marks/aggregate`).set(as("coord")).expect(200);
    const group = agg.body.groups[0];

    // Shared half is 40 for both. Individual halves are 50 and 30.
    const byIndex = Object.fromEntries(
      group.students.map((st: { indexNumber: string; overall: number; stages: { groupComponentPercent: number; individualComponentPercent: number }[] }) => [
        st.indexNumber,
        st,
      ]),
    );
    const first = byIndex[`${h.prefix}s1`];
    const second = byIndex[`${h.prefix}s2`];

    expect(first.stages[0].groupComponentPercent).toBe(40);
    expect(first.stages[0].individualComponentPercent).toBe(50);
    expect(first.overall).toBe(90);
    expect(second.stages[0].individualComponentPercent).toBe(30);
    expect(second.overall).toBe(70);

    // The group's own figure is the average of its members'.
    expect(group.overall).toBe(80);
  });

  it("rejects a student score on a group criterion and a missing student on an individual one", async () => {
    const s = await setupApprovedSession({ stage: mixedStage, students: ["s1", "s2"], evaluators: ["ev1"] });
    const product = s.criteria.find((c) => c.name === "Product")!;
    const contribution = s.criteria.find((c) => c.name === "Contribution")!;

    await request(app)
      .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: [{ criterionId: product.id, studentId: s.studentIdByKey.s1, score: 8 }], overallComment: "x" })
      .expect(400);

    await request(app)
      .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: [{ criterionId: contribution.id, score: 8 }], overallComment: "x" })
      .expect(400);
  });
});

describe("Publishing", () => {
  async function aggregated() {
    const s = await setupApprovedSession({ stage: mixedStage, students: ["s1", "s2"], evaluators: ["ev1"] });
    const product = s.criteria.find((c) => c.name === "Product")!;
    const contribution = s.criteria.find((c) => c.name === "Contribution")!;
    await request(app)
      .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
      .set(as("ev1"))
      .send({
        scores: [
          { criterionId: product.id, score: 8 },
          { criterionId: contribution.id, studentId: s.studentIdByKey.s1, score: 10 },
          { criterionId: contribution.id, studentId: s.studentIdByKey.s2, score: 6 },
        ],
        overallComment: "Reviewed.",
      })
      .expect(201);
    await finalize(s.cpiId, s.sessionId, s.reviewer);
    await request(app).post(`/courses/${s.cpiId}/marks/aggregate`).set(as("coord")).expect(200);
    return s;
  }

  it("hides marks until they are published, and names the stage still to come", async () => {
    const s = await aggregated();

    const before = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1")).expect(200);
    expect(before.body.groups).toHaveLength(0);
    expect(before.body.pendingStages).toEqual([{ stageId: s.stageId, stageName: "Final Demo" }]);

    await request(app)
      .post(`/courses/${s.cpiId}/marks/publish`)
      .set(as("coord"))
      .send({ stageId: null, publishMarks: true, publishComments: false })
      .expect(200);

    const after = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1")).expect(200);
    expect(after.body.groups[0].overall).toBe(80);
    expect(after.body.pendingStages).toHaveLength(0);

    const notifications = await request(app).get(`/notifications`).set(as("s1"));
    expect(notifications.body.some((n: { type: string }) => n.type === "MARKS_PUBLISHED")).toBe(true);
  });

  it("shows a student only their own breakdown, not their group-mate's", async () => {
    const s = await aggregated();
    await request(app)
      .post(`/courses/${s.cpiId}/marks/publish`)
      .set(as("coord"))
      .send({ stageId: null, publishMarks: true, publishComments: false })
      .expect(200);

    const view = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1")).expect(200);
    expect(view.body.groups[0].students).toHaveLength(1);
    expect(view.body.groups[0].students[0].indexNumber).toBe(`${h.prefix}s1`);
  });

  it("can be turned off again", async () => {
    const s = await aggregated();
    const publish = (publishMarks: boolean) =>
      request(app)
        .post(`/courses/${s.cpiId}/marks/publish`)
        .set(as("coord"))
        .send({ stageId: null, publishMarks, publishComments: false })
        .expect(200);

    await publish(true);
    expect((await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1"))).body.groups).toHaveLength(1);

    // The old single timestamp could never be cleared.
    await publish(false);
    expect((await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1"))).body.groups).toHaveLength(0);
  });

  it("releases feedback without the numbers", async () => {
    const s = await aggregated();
    await request(app)
      .post(`/courses/${s.cpiId}/marks/publish`)
      .set(as("coord"))
      .send({ stageId: null, publishMarks: false, publishComments: true })
      .expect(200);

    const view = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1")).expect(200);
    expect(view.body.groups).toHaveLength(0);

    const publications = await request(app).get(`/courses/${s.cpiId}/marks/publications`).set(as("coord")).expect(200);
    expect(publications.body[0]).toMatchObject({ publishMarks: false, publishComments: true });
  });

  it("refuses to publish marks that do not exist yet", async () => {
    const s = await setupApprovedSession({ stage: mixedStage, students: ["s1"], evaluators: ["ev1"] });
    await request(app)
      .post(`/courses/${s.cpiId}/marks/publish`)
      .set(as("coord"))
      .send({ stageId: null, publishMarks: true, publishComments: false })
      .expect(409);
  });
});

describe("Grades and the CA sheet", () => {
  async function aggregatedWithGrades() {
    const s = await setupApprovedSession({ stage: mixedStage, students: ["s1", "s2"], evaluators: ["ev1"] });
    const product = s.criteria.find((c) => c.name === "Product")!;
    const contribution = s.criteria.find((c) => c.name === "Contribution")!;
    await request(app)
      .post(`/courses/${s.cpiId}/sessions/${s.sessionId}/scores`)
      .set(as("ev1"))
      .send({
        scores: [
          { criterionId: product.id, score: 8 },
          { criterionId: contribution.id, studentId: s.studentIdByKey.s1, score: 10 },
          { criterionId: contribution.id, studentId: s.studentIdByKey.s2, score: 6 },
        ],
        overallComment: "Reviewed.",
      })
      .expect(201);
    await finalize(s.cpiId, s.sessionId, s.reviewer);
    await request(app).post(`/courses/${s.cpiId}/marks/aggregate`).set(as("coord")).expect(200);
    return s;
  }

  it("awards a grade per student once grading is turned on", async () => {
    const s = await aggregatedWithGrades();

    // No grades until the course asks for them.
    let sheet = await request(app).get(`/courses/${s.cpiId}/marks/sheet`).set(as("coord")).expect(200);
    expect(sheet.body.rows.every((r: { grade: string | null }) => r.grade === null)).toBe(true);

    await request(app).patch(`/courses/${s.cpiId}/policy`).set(as("coord")).send({ gradingEnabled: true }).expect(200);
    await request(app)
      .put(`/courses/${s.cpiId}/marks/grade-bands`)
      .set(as("coord"))
      .send({ bands: [{ label: "B", minPercent: 65 }, { label: "A", minPercent: 85 }] })
      .expect(200);

    sheet = await request(app).get(`/courses/${s.cpiId}/marks/sheet`).set(as("coord")).expect(200);
    const byIndex = Object.fromEntries(sheet.body.rows.map((r: { indexNumber: string }) => [r.indexNumber, r]));
    // 90 reaches A, 70 only reaches B.
    expect(byIndex[`${h.prefix}s1`].grade).toBe("A");
    expect(byIndex[`${h.prefix}s2`].grade).toBe("B");
  });

  it("holds the grade back from students until it is released", async () => {
    const s = await aggregatedWithGrades();
    await request(app).patch(`/courses/${s.cpiId}/policy`).set(as("coord")).send({ gradingEnabled: true }).expect(200);
    await request(app)
      .put(`/courses/${s.cpiId}/marks/grade-bands`)
      .set(as("coord"))
      .send({ bands: [{ label: "B", minPercent: 65 }, { label: "A", minPercent: 85 }] })
      .expect(200);

    // Marks released, grade not: releasing a mark during the semester is not the
    // same decision as releasing a grade at the end.
    await request(app)
      .post(`/courses/${s.cpiId}/marks/publish`)
      .set(as("coord"))
      .send({ stageId: null, publishMarks: true, publishComments: false, publishGrades: false })
      .expect(200);

    let view = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1")).expect(200);
    expect(view.body.groups[0].students[0].overall).toBeGreaterThan(0);
    expect(view.body.groups[0].students[0].grade).toBeNull();
    expect(view.body.gradesReleased).toBe(false);

    await request(app)
      .post(`/courses/${s.cpiId}/marks/publish`)
      .set(as("coord"))
      .send({ stageId: null, publishMarks: true, publishComments: false, publishGrades: true })
      .expect(200);

    view = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("s1")).expect(200);
    expect(view.body.groups[0].students[0].grade).toBe("A");
  });

  it("reports a contribution instead of a grade when the project is part of a module", async () => {
    const s = await aggregatedWithGrades();
    await request(app)
      .patch(`/courses/${s.cpiId}/policy`)
      .set(as("coord"))
      .send({ gradingEnabled: true, caContributionPercent: 40 })
      .expect(200);
    await request(app)
      .put(`/courses/${s.cpiId}/marks/grade-bands`)
      .set(as("coord"))
      .send({ bands: [{ label: "A", minPercent: 85 }] })
      .expect(200);

    const view = await request(app).get(`/courses/${s.cpiId}/marks`).set(as("coord")).expect(200);
    expect(view.body.gradeIsForWholeModule).toBe(false);
    // A letter banded on this assessment alone would not be the module's grade,
    // so what is reported is what these marks add to it: 90 at 40% = 36.
    expect(view.body.groups[0].students[0].grade).toBeNull();
    expect(view.body.groups[0].students[0].contributionToModule).toBeCloseTo(36, 1);
  });

  it("lays the sheet out one row per student with a weight row and totals", async () => {
    const s = await aggregatedWithGrades();
    const sheet = await request(app).get(`/courses/${s.cpiId}/marks/sheet`).set(as("coord")).expect(200);

    expect(sheet.body.stages).toHaveLength(1);
    // The printed sheet's weight row sums to 1.00.
    expect(sheet.body.weights[s.stageId]).toBe(1);
    expect(sheet.body.rows).toHaveLength(2);

    const row = sheet.body.rows.find((r: { indexNumber: string }) => r.indexNumber === `${h.prefix}s1`);
    expect(row.stagePercents[s.stageId]).toBe(90);
    expect(row.total).toBe(90);
    expect(row.zeroTotal).toBe(false);
    // Names are stored as one field, so the sheet splits them for its columns.
    expect(row.surname).toBe("s1");

    await request(app).get(`/courses/${s.cpiId}/marks/sheet`).set(as("s1")).expect(403);
  });
});
