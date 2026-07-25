import { SessionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { getCpiEvaluatorId, getHeadJudgeCpiEvaluatorId } from "../shared/cpiMembership";

interface ScoreInput {
  criterionId: string;
  score: number;
  comment?: string;
}

async function loadSession(sessionId: string, cpiId: string) {
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return session;
}

async function assignedEvaluatorIds(stageId: string): Promise<string[]> {
  const rows = await prisma.stageEvaluator.findMany({
    where: { evaluationStageId: stageId },
    select: { cpiEvaluatorId: true },
  });
  return rows.map((r) => r.cpiEvaluatorId);
}

export async function submitScores(userId: string, cpiId: string, sessionId: string, scores: ScoreInput[]) {
  const cpiEvaluatorId = await getCpiEvaluatorId(userId, cpiId);
  if (!cpiEvaluatorId) throw new AuthError(403, "Only an evaluator of this CPI can submit scores");

  const session = await loadSession(sessionId, cpiId);

  const assigned = await assignedEvaluatorIds(session.evaluationStageId);
  if (!assigned.includes(cpiEvaluatorId)) {
    throw new AuthError(403, "You are not assigned to evaluate this stage");
  }

  // If the stage defines its own execution window, scoring is only open within
  // it — so stages (proposal/mid/final) can each run at their own time.
  const stage = await prisma.evaluationStage.findUnique({
    where: { id: session.evaluationStageId },
    select: { executionWindowStart: true, executionWindowEnd: true },
  });
  if (stage?.executionWindowStart && stage.executionWindowEnd) {
    const now = new Date();
    if (now < stage.executionWindowStart) throw new AuthError(403, "This stage's scoring window has not opened yet");
    if (now > stage.executionWindowEnd) throw new AuthError(403, "This stage's scoring window has closed");
  }

  // Scoring is only open while a session is SCHEDULED (still collecting) or
  // CORRECTION_REQUESTED (reopened for one evaluator). Once AWAITING_HEAD_JUDGE
  // or FINALIZED, changes must go through the Head Judge's correction flow —
  // otherwise an evaluator could silently revise after the HJ began reviewing.
  if (session.status === SessionStatus.AWAITING_HEAD_JUDGE || session.status === SessionStatus.FINALIZED) {
    throw new AuthError(409, "Scoring is closed for this session — awaiting or completed Head Judge review");
  }
  if (session.status === SessionStatus.CORRECTION_REQUESTED) {
    const review = await prisma.headJudgeReview.findUnique({ where: { evaluationSessionId: sessionId } });
    if (review?.correctionEvaluatorId !== cpiEvaluatorId) {
      throw new AuthError(409, "Only the evaluator asked to correct may resubmit for this session");
    }
  }

  const criteria = await prisma.rubricCriterion.findMany({ where: { evaluationStageId: session.evaluationStageId } });
  const byId = new Map(criteria.map((c) => [c.id, c]));
  for (const s of scores) {
    const criterion = byId.get(s.criterionId);
    if (!criterion) throw new AuthError(400, "A score references a criterion not in this stage");
    if (s.score > criterion.maxScore) {
      throw new AuthError(400, `Score for "${criterion.name}" exceeds max ${criterion.maxScore}`);
    }
  }

  await prisma.$transaction(
    scores.map((s) =>
      prisma.rubricScore.upsert({
        where: {
          evaluationSessionId_cpiEvaluatorId_rubricCriterionId: {
            evaluationSessionId: sessionId,
            cpiEvaluatorId,
            rubricCriterionId: s.criterionId,
          },
        },
        update: { score: s.score, comment: s.comment },
        create: {
          evaluationSessionId: sessionId,
          cpiEvaluatorId,
          rubricCriterionId: s.criterionId,
          score: s.score,
          comment: s.comment,
        },
      }),
    ),
  );

  await refreshSessionReadiness(sessionId, assigned, criteria.length);
  return getOwnScores(sessionId, cpiEvaluatorId);
}

// Flip a session to AWAITING_HEAD_JUDGE once every assigned evaluator has scored
// every criterion AND at least evaluatorsRequired evaluators are involved (spec
// Flow B + the stage's evaluatorsRequired). Only ever promotes — never demotes,
// so a reopened CORRECTION_REQUESTED session isn't downgraded mid-fix.
async function refreshSessionReadiness(sessionId: string, assigned: string[], criteriaCount: number) {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: { stage: { select: { evaluatorsRequired: true } } },
  });
  if (!session || session.status === SessionStatus.FINALIZED) return;

  const counts = await prisma.rubricScore.groupBy({
    by: ["cpiEvaluatorId"],
    where: { evaluationSessionId: sessionId },
    _count: { rubricCriterionId: true },
  });
  const complete =
    criteriaCount > 0 &&
    assigned.length >= session.stage.evaluatorsRequired &&
    assigned.every((id) => counts.find((c) => c.cpiEvaluatorId === id)?._count.rubricCriterionId === criteriaCount);

  if (complete && session.status !== SessionStatus.AWAITING_HEAD_JUDGE) {
    await prisma.evaluationSession.update({ where: { id: sessionId }, data: { status: SessionStatus.AWAITING_HEAD_JUDGE } });
  }
}

function getOwnScores(sessionId: string, cpiEvaluatorId: string) {
  return prisma.rubricScore.findMany({
    where: { evaluationSessionId: sessionId, cpiEvaluatorId },
    include: { criterion: { select: { id: true, name: true, maxScore: true } } },
    orderBy: { criterion: { orderIndex: "asc" } },
  });
}

// ISOLATION (CLAUDE.md non-negotiable): an evaluator may read ONLY their own
// scores until the Head Judge finalizes. The HJ sees all (that's the review);
// the coordinator sees all only after FINALIZED.
export async function getSessionScores(userId: string, cpiId: string, sessionId: string) {
  const session = await loadSession(sessionId, cpiId);
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });

  if (await getHeadJudgeCpiEvaluatorId(userId, cpiId)) {
    return prisma.rubricScore.findMany({ where: { evaluationSessionId: sessionId }, include: scoreInclude });
  }
  if (cpi!.createdById === userId) {
    if (session.status !== SessionStatus.FINALIZED) {
      throw new AuthError(403, "Scores are visible to the coordinator only after the Head Judge finalizes");
    }
    return prisma.rubricScore.findMany({ where: { evaluationSessionId: sessionId }, include: scoreInclude });
  }

  const cpiEvaluatorId = await getCpiEvaluatorId(userId, cpiId);
  if (!cpiEvaluatorId) throw new AuthError(403, "You cannot view scores for this session");
  return getOwnScores(sessionId, cpiEvaluatorId);
}

const scoreInclude = {
  criterion: { select: { id: true, name: true, maxScore: true } },
  cpiEvaluator: { include: { lecturer: { include: { user: { select: { email: true, fullName: true } } } } } },
} as const;
