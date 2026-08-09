import request from "supertest";
import { CpiPhase, Role } from "@prisma/client";
import { app } from "../../app";
import { prisma } from "../../config/database";
import { redis } from "../../config/redis";
import { emailQueue, queueConnection } from "../../jobs/emailQueue";
import { createHarness } from "../shared/testing/harness";

const h = createHarness("paneljest.");
const { userIds, makeUser, login, as, openPhase, cleanup } = h;

// An open evaluation: no evaluators assigned, anyone may join and mark, no Head
// Judge. This is the FYP demonstration-day shape, which the previous fixed-panel
// design could not express at all.
async function setupOpenEvaluation(
  overrides: { panelRules?: unknown[]; panelScoreVisibility?: string } = {},
) {
  const create = await request(app)
    .post("/courses")
    .set(as("coord"))
    .send({
      name: "Open Demo Day",
      projectType: "FYP",
      participationMode: "GROUP",
      department: "CE",
      academicYear: "2026",
      mode: "COORDINATOR_MANAGED",
    });
  expect(create.status).toBe(201);
  const cpiId = create.body.id as string;

  await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
  const group = await request(app).post(`/courses/${cpiId}/groups`).set(as("s1")).send({ name: "Group A" });
  const groupId = group.body.id as string;

  await openPhase(cpiId, CpiPhase.SUPERVISOR_ADDITION);
  for (const key of ["ev1", "ev2"]) {
    await request(app)
      .post(`/courses/${cpiId}/evaluators`)
      .set(as("coord"))
      .send({ lecturerUserId: userIds[key] })
      .expect(201);
  }

  await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
  const idea = await request(app)
    .post(`/courses/${cpiId}/ideas`)
    .set(as("coord"))
    .send({ title: "Demo idea", description: "d" });
  expect(idea.status).toBe(201);

  await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
  await request(app)
    .put(`/courses/${cpiId}/allocations/${groupId}`)
    .set(as("coord"))
    .send({ ideaId: idea.body.id })
    .expect(200);

  await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
  const config = await request(app)
    .put(`/courses/${cpiId}/evaluations/config`)
    .set(as("coord"))
    .send({
      stages: [
        {
          name: "Final Demonstration",
          weight: 100,
          submissionRequired: false,
          panelScoreVisibility: overrides.panelScoreVisibility ?? "ISOLATED",
          panelRules: overrides.panelRules ?? [
            { role: "EVALUATOR", minRequired: 0, openToAll: true, markCounting: "COUNTED" },
          ],
          criteria: [
            { name: "C1", weight: 50, maxScore: 10 },
            { name: "C2", weight: 50, maxScore: 10 },
          ],
        },
      ],
    });
  expect(config.status).toBe(200);
  const stage = config.body[0];

  await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
  await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord")).expect(201);

  await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);
  const sessions = await request(app).get(`/courses/${cpiId}/sessions`).set(as("coord"));
  const sessionId = sessions.body[0].id as string;

  return { cpiId, groupId, sessionId, stage, criteria: stage.criteria as { id: string }[] };
}

function scoresFor(criteria: { id: string }[], value: number) {
  return criteria.map((c) => ({ criterionId: c.id, score: value }));
}

beforeAll(async () => {
  await cleanup();
  await makeUser("coord", Role.COURSE_COORDINATOR);
  await makeUser("ev1", Role.LECTURER, { approvedLecturer: true });
  await makeUser("ev2", Role.LECTURER, { approvedLecturer: true });
  await makeUser("s1", Role.STUDENT, { student: true });
  await makeUser("s2", Role.STUDENT, { student: true });
  for (const key of ["coord", "ev1", "ev2", "s1", "s2"]) await login(key);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await emailQueue.close();
  await queueConnection.quit();
  await redis.quit();
});

describe("A stage with no required evaluators still completes", () => {
  it("lets a lecturer join an open panel and score without any assignment", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();

    const joined = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`)
      .set(as("ev1"))
      .send({ role: "EVALUATOR" });
    expect(joined.status).toBe(201);

    const submitted = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 8), overallComment: "Solid demonstration." });
    expect(submitted.status).toBe(201);

    // An open stage must NOT close on the first submission — others are still
    // marking. It stays collecting until the reviewer closes it.
    const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("SCHEDULED");
  });

  it("keeps accepting marks from later arrivals", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();
    for (const key of ["ev1", "ev2"]) {
      await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as(key)).send({ role: "EVALUATOR" });
      await request(app)
        .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
        .set(as(key))
        .send({ scores: scoresFor(criteria, 7), overallComment: `from ${key}` })
        .expect(201);
    }

    const stored = await prisma.rubricScore.count({ where: { evaluationSessionId: sessionId } });
    expect(stored).toBe(criteria.length * 2);
  });

  it("refuses a lecturer joining a stage that is not open", async () => {
    const { cpiId, sessionId } = await setupOpenEvaluation({
      panelRules: [{ role: "EVALUATOR", minRequired: 1, openToAll: false }],
    });

    const joined = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`)
      .set(as("ev1"))
      .send({ role: "EVALUATOR" });
    expect(joined.status).toBe(403);
  });
});

describe("The Head Judge is optional", () => {
  it("routes review to the coordinator when no Head Judge is enabled", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev1")).send({ role: "EVALUATOR" });
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 7), overallComment: "Fine." })
      .expect(201);

    // The coordinator is the reviewer here, so they can both read the review and
    // approve it — no Head Judge exists.
    const review = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/review`).set(as("coord"));
    expect(review.status).toBe(200);
    expect(review.body.overallComments).toHaveLength(1);

    // Nothing advances on its own: the coordinator ends marking, then approves.
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord")).expect(200);
    const approved = await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("coord"));
    expect(approved.status).toBe(200);

    const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("FINALIZED");
  });

  it("does not let a panelist who is not the reviewer approve", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev1")).send({ role: "EVALUATOR" });
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 7), overallComment: "Fine." })
      .expect(201);

    const approved = await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("ev1"));
    expect(approved.status).toBe(403);
  });
});

describe("The overall comment is mandatory", () => {
  it("rejects a submission with no overall comment, and accepts it once given", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev1")).send({ role: "EVALUATOR" });

    const withoutComment = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 6) });
    expect(withoutComment.status).toBe(400);

    const withComment = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 6), overallComment: "Met expectations." });
    expect(withComment.status).toBe(201);
  });

  it("can be turned off in policy", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();
    await request(app)
      .patch(`/courses/${cpiId}/policy`)
      .set(as("coord"))
      .send({ requireOverallComment: false })
      .expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev1")).send({ role: "EVALUATOR" });

    const res = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 6) });
    expect(res.status).toBe(201);
  });
});

describe("Score visibility", () => {
  it("keeps panelists isolated by default", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();
    for (const key of ["ev1", "ev2"]) {
      await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as(key)).send({ role: "EVALUATOR" });
      await request(app)
        .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
        .set(as(key))
        .send({ scores: scoresFor(criteria, key === "ev1" ? 9 : 4), overallComment: `from ${key}` })
        .expect(201);
    }

    const seen = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1"));
    expect(seen.status).toBe(200);
    expect(seen.body).toHaveLength(criteria.length);
    expect(seen.body.every((s: { score: number }) => s.score === 9)).toBe(true);
  });

  it("shows the whole panel once a stage is opened", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation({ panelScoreVisibility: "OPEN_WITH_NAMES" });
    for (const key of ["ev1", "ev2"]) {
      await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as(key)).send({ role: "EVALUATOR" });
      await request(app)
        .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
        .set(as(key))
        .send({ scores: scoresFor(criteria, key === "ev1" ? 9 : 4), overallComment: `from ${key}` })
        .expect(201);
    }

    const seen = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/scores`).set(as("ev1"));
    expect(seen.status).toBe(200);
    expect(seen.body).toHaveLength(criteria.length * 2);
    expect(seen.body.some((s: { score: number }) => s.score === 4)).toBe(true);
  });
});

describe("Guest panelists", () => {
  it("scores through a one-time link without an account", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();

    const invite = await request(app)
      .post(`/courses/${cpiId}/guests`)
      .set(as("coord"))
      .send({
        fullName: "Industry Client",
        email: "client@example.com",
        organization: "Acme",
        sessionIds: [sessionId],
        role: "SENIOR_EVALUATOR",
      });
    expect(invite.status).toBe(201);
    const token = invite.body.token as string;
    expect(token).toBeTruthy();

    const workspace = await request(app).get("/guest/workspace").query({ token });
    expect(workspace.status).toBe(200);
    expect(workspace.body.sessions).toHaveLength(1);
    expect(workspace.body.sessions[0].criteria).toHaveLength(criteria.length);

    const scored = await request(app)
      .post("/guest/scores")
      .send({
        token,
        sessionId,
        scores: scoresFor(criteria, 10),
        overallComment: "Directly relevant to our problem.",
      });
    expect(scored.status).toBe(201);

    // A guest holds a real seat, so their marks reach the session like anyone
    // else's — the difference is only how they authenticate.
    const stored = await prisma.rubricScore.count({ where: { evaluationSessionId: sessionId } });
    expect(stored).toBe(criteria.length);
  });

  it("refuses a revoked link", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();
    const invite = await request(app)
      .post(`/courses/${cpiId}/guests`)
      .set(as("coord"))
      .send({ fullName: "Visitor", email: "v@example.com", sessionIds: [sessionId], role: "EVALUATOR" });
    const token = invite.body.token as string;

    await request(app).post(`/courses/${cpiId}/guests/${invite.body.guest.id}/revoke`).set(as("coord")).expect(200);

    const scored = await request(app)
      .post("/guest/scores")
      .send({ token, sessionId, scores: scoresFor(criteria, 5), overallComment: "x" });
    expect(scored.status).toBe(401);
  });
});

describe("Panel composition rules", () => {
  it("reports readiness per required role without acting on it", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation({
      panelRules: [{ role: "EVALUATOR", minRequired: 2, openToAll: true }],
    });

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev1")).send({ role: "EVALUATOR" });
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 8), overallComment: "one" })
      .expect(201);

    // One of two required evaluators has finished: readiness says so, but the
    // session does not move — only the reviewer ends marking.
    let review = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/review`).set(as("coord"));
    expect(review.body.readiness.allRequirementsMet).toBe(false);
    expect(review.body.readiness.roles[0]).toMatchObject({ role: "EVALUATOR", minRequired: 2, finished: 1 });

    let session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("SCHEDULED");

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev2")).send({ role: "EVALUATOR" });
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev2"))
      .send({ scores: scoresFor(criteria, 6), overallComment: "two" })
      .expect(201);

    review = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/review`).set(as("coord"));
    expect(review.body.readiness.allRequirementsMet).toBe(true);

    // Still SCHEDULED — meeting the minimum is information, not an action.
    session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("SCHEDULED");
  });

  it("lets the reviewer close scoring while an optional panelist has not marked", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation({
      panelRules: [{ role: "EVALUATOR", minRequired: 1, openToAll: true }],
    });

    // Two join, only one scores. The requirement is one, so the reviewer can end
    // marking without waiting — at an open event someone always leaves early.
    for (const key of ["ev1", "ev2"]) {
      await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as(key)).send({ role: "EVALUATOR" });
    }
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 8), overallComment: "only one" })
      .expect(201);

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord")).expect(200);
    const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("AWAITING_REVIEW");
  });

  it("refuses to close a session nobody has marked", async () => {
    const { cpiId, sessionId } = await setupOpenEvaluation();
    const closed = await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord"));
    expect(closed.status).toBe(409);
  });
});

describe("Re-scrutinising an approved session", () => {
  it("reopens for marking, then refuses once marks are aggregated", async () => {
    const { cpiId, sessionId, criteria } = await setupOpenEvaluation();
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as("ev1")).send({ role: "EVALUATOR" });
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 5), overallComment: "first pass" })
      .expect(201);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("coord")).expect(200);

    // Approval is not the point of no return — the reviewer can re-scrutinise.
    const reopened = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/reopen`)
      .set(as("coord"))
      .send({ reason: "Second marker disputed the demo score" });
    expect(reopened.status).toBe(200);

    let session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("SCHEDULED");

    // Marking is genuinely live again.
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 9), overallComment: "revised" })
      .expect(201);

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/marks/aggregate`).set(as("coord")).expect(200);

    // Aggregation is the real lock: a mark that has become a result stops moving.
    const tooLate = await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/reopen`)
      .set(as("coord"))
      .send({ reason: "changed my mind" });
    expect(tooLate.status).toBe(409);

    session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("FINALIZED");
  });
});

describe("Evaluation settings stay editable after submissions exist", () => {
  it("patches a stage and its panel rules once the config itself is locked", async () => {
    const { cpiId, groupId, stage } = await setupOpenEvaluation();

    // A submission is what locks the replace-all config path.
    await prisma.submission.create({
      data: {
        courseInstanceId: cpiId,
        groupId,
        evaluationStageId: stage.id,
        storagePath: "test/locked.pdf",
        fileName: "locked.pdf",
        fileSize: 10,
      },
    });

    await openPhase(cpiId, CpiPhase.EVALUATION_CONFIG);
    const replaceAll = await request(app)
      .put(`/courses/${cpiId}/evaluations/config`)
      .set(as("coord"))
      .send({
        stages: [
          {
            name: "Replaced",
            weight: 100,
            criteria: [{ name: "X", weight: 100, maxScore: 10 }],
          },
        ],
      });
    expect(replaceAll.status).toBe(409);

    // The targeted paths still work — this is what lets a coordinator restaff a
    // panel or open a stage on the day.
    const patched = await request(app)
      .patch(`/courses/${cpiId}/evaluations/stages/${stage.id}`)
      .set(as("coord"))
      .send({ panelScoreVisibility: "OPEN_WITH_NAMES" });
    expect(patched.status).toBe(200);
    expect(patched.body.panelScoreVisibility).toBe("OPEN_WITH_NAMES");

    const rules = await request(app)
      .put(`/courses/${cpiId}/evaluations/stages/${stage.id}/panel-rules`)
      .set(as("coord"))
      .send({ rules: [{ role: "SENIOR_EVALUATOR", minRequired: 1 }, { role: "JUNIOR_EVALUATOR", minRequired: 2 }] });
    expect(rules.status).toBe(200);
    expect(rules.body).toHaveLength(2);
  });

  it("records a reason whenever the pooled share is set", async () => {
    const { cpiId, stage } = await setupOpenEvaluation();

    const noReason = await request(app)
      .post(`/courses/${cpiId}/evaluations/stages/${stage.id}/pooled-share`)
      .set(as("coord"))
      .send({ sharePercent: 30 });
    expect(noReason.status).toBe(400);

    const set = await request(app)
      .post(`/courses/${cpiId}/evaluations/stages/${stage.id}/pooled-share`)
      .set(as("coord"))
      .send({ sharePercent: 30, scorerLimit: 5, reason: "Five industry guests attended every group." });
    expect(set.status).toBe(200);
    expect(set.body.pooledSharePercent).toBe(30);

    const decisions = await request(app)
      .get(`/courses/${cpiId}/evaluations/stages/${stage.id}/pooled-share`)
      .set(as("coord"));
    expect(decisions.status).toBe(200);
    expect(decisions.body[0].reason).toContain("industry guests");
  });
});

describe("Per-seat weighting", () => {
  it("weights markers individually without needing separate senior/junior roles", async () => {
    const { cpiId, sessionId, groupId, criteria } = await setupOpenEvaluation({
      panelRules: [{ role: "EVALUATOR", minRequired: 0, openToAll: true, markCounting: "COUNTED" }],
    });

    // Two plain evaluators, weighted 75/25 by the coordinator — the role is the
    // same for both, only their say differs.
    for (const key of ["ev1", "ev2"]) {
      await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as(key)).send({ role: "EVALUATOR" });
    }
    const panel = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/panel`).set(as("coord"));
    const seatOf = (userId: string) =>
      (panel.body.panelists as { id: string; user: { id: string } }[]).find((p) => p.user?.id === userId)!.id;

    await request(app)
      .patch(`/courses/${cpiId}/sessions/${sessionId}/panel/${seatOf(userIds.ev1)}`)
      .set(as("coord"))
      .send({ weightPercent: 75 })
      .expect(200);
    await request(app)
      .patch(`/courses/${cpiId}/sessions/${sessionId}/panel/${seatOf(userIds.ev2)}`)
      .set(as("coord"))
      .send({ weightPercent: 25 })
      .expect(200);

    // ev1 gives 8/10 everywhere, ev2 gives 4/10.
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 8), overallComment: "strong" })
      .expect(201);
    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev2"))
      .send({ scores: scoresFor(criteria, 4), overallComment: "weak" })
      .expect(201);

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/marks/aggregate`).set(as("coord")).expect(200);

    // Weighted mean: (8*75 + 4*25) / 100 = 7 out of 10 = 70%.
    // A weighted SUM would have given 7/10 of the marks away — the whole point
    // of this test is that weights express relative say, not a multiplier.
    const mark = await prisma.finalMark.findFirst({ where: { groupId } });
    expect(mark!.stageScorePercent).toBeCloseTo(70, 5);
  });

  it("stays a plain average when nobody is weighted", async () => {
    const { cpiId, sessionId, groupId, criteria } = await setupOpenEvaluation();

    for (const [key, score] of [["ev1", 8], ["ev2", 4]] as const) {
      await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/panel/join`).set(as(key)).send({ role: "EVALUATOR" });
      await request(app)
        .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
        .set(as(key))
        .send({ scores: scoresFor(criteria, score), overallComment: "x" })
        .expect(201);
    }

    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/close-scoring`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/sessions/${sessionId}/approve`).set(as("coord")).expect(200);
    await request(app).post(`/courses/${cpiId}/marks/aggregate`).set(as("coord")).expect(200);

    // (8 + 4) / 2 = 6 out of 10 = 60%.
    const mark = await prisma.finalMark.findFirst({ where: { groupId } });
    expect(mark!.stageScorePercent).toBeCloseTo(60, 5);
  });
});

describe("One panel across every group", () => {
  it("applies the same people to all sessions, then lets one group differ", async () => {
    const { cpiId, stage } = await setupOpenEvaluation();

    // A second group, so "all sessions" means more than one.
    await openPhase(cpiId, CpiPhase.STUDENT_REGISTRATION);
    const groupB = await request(app).post(`/courses/${cpiId}/groups`).set(as("s2")).send({ name: "Group B" });
    await openPhase(cpiId, CpiPhase.IDEA_ANNOUNCEMENT);
    const ideaB = await request(app).post(`/courses/${cpiId}/ideas`).set(as("coord")).send({ title: "B", description: "d" });
    await openPhase(cpiId, CpiPhase.PROJECT_REGISTRATION);
    await request(app)
      .put(`/courses/${cpiId}/allocations/${groupB.body.id}`)
      .set(as("coord"))
      .send({ ideaId: ideaB.body.id })
      .expect(200);
    await openPhase(cpiId, CpiPhase.AVAILABILITY_SUBMISSION);
    await request(app).post(`/courses/${cpiId}/sessions/generate`).set(as("coord")).expect(201);
    await openPhase(cpiId, CpiPhase.EVALUATION_EXECUTION);

    // The usual starting point: the same two people evaluate everybody.
    const applied = await request(app)
      .put(`/courses/${cpiId}/evaluations/stages/${stage.id}/panel`)
      .set(as("coord"))
      .send({
        panelists: [
          { userId: userIds.ev1, role: "SENIOR_EVALUATOR", weightPercent: 60 },
          { userId: userIds.ev2, role: "EVALUATOR", weightPercent: 40 },
        ],
      });
    expect(applied.status).toBe(200);
    expect(applied.body.appliedTo).toBe(2);

    const sessions = await request(app).get(`/courses/${cpiId}/sessions`).set(as("coord"));
    expect(sessions.body).toHaveLength(2);
    for (const session of sessions.body) {
      const panel = await request(app).get(`/courses/${cpiId}/sessions/${session.id}/panel`).set(as("coord"));
      expect(panel.body.panelists).toHaveLength(2);
    }

    // ...and then one group deviates, without disturbing the other.
    const [firstSession, secondSession] = sessions.body;
    const firstPanel = await request(app).get(`/courses/${cpiId}/sessions/${firstSession.id}/panel`).set(as("coord"));
    const ev2Seat = firstPanel.body.panelists.find(
      (p: { user: { id: string } }) => p.user?.id === userIds.ev2,
    );
    await request(app)
      .delete(`/courses/${cpiId}/sessions/${firstSession.id}/panel/${ev2Seat.id}`)
      .set(as("coord"))
      .expect(200);

    const after = await request(app).get(`/courses/${cpiId}/sessions/${firstSession.id}/panel`).set(as("coord"));
    expect(after.body.panelists).toHaveLength(1);
    const untouched = await request(app).get(`/courses/${cpiId}/sessions/${secondSession.id}/panel`).set(as("coord"));
    expect(untouched.body.panelists).toHaveLength(2);
  });

  it("never removes someone who has already marked", async () => {
    const { cpiId, sessionId, stage, criteria } = await setupOpenEvaluation();

    await request(app)
      .put(`/courses/${cpiId}/evaluations/stages/${stage.id}/panel`)
      .set(as("coord"))
      .send({ panelists: [{ userId: userIds.ev1, role: "EVALUATOR" }] })
      .expect(200);

    await request(app)
      .post(`/courses/${cpiId}/sessions/${sessionId}/scores`)
      .set(as("ev1"))
      .send({ scores: scoresFor(criteria, 8), overallComment: "done" })
      .expect(201);

    // Replacing the panel with somebody else would otherwise discard ev1's
    // marks along with their seat. They are kept, and the caller is told why.
    const replaced = await request(app)
      .put(`/courses/${cpiId}/evaluations/stages/${stage.id}/panel`)
      .set(as("coord"))
      .send({ panelists: [{ userId: userIds.ev2, role: "EVALUATOR" }], replaceExisting: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.kept).toHaveLength(1);
    expect(replaced.body.kept[0].reason).toContain("already submitted marks");

    const panel = await request(app).get(`/courses/${cpiId}/sessions/${sessionId}/panel`).set(as("coord"));
    expect(panel.body.panelists).toHaveLength(2);
  });
});
