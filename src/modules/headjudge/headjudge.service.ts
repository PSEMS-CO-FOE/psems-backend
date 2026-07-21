import { HeadJudgeDecision, RubricScoreStatus, SessionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { getCpiEvaluatorId, getHeadJudgeCpiEvaluatorId } from "../shared/cpiMembership";

async function assertHeadJudge(userId: string, cpiId: string): Promise<string> {
  const hjId = await getHeadJudgeCpiEvaluatorId(userId, cpiId);
  if (!hjId) throw new AuthError(403, "Only the Head Judge of this CPI can perform this action");
  return hjId;
}

async function loadSession(sessionId: string, cpiId: string) {
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return session;
}

// Side-by-side scores grouped by criterion, with a per-criterion deviation flag
// (spec: "all scores side-by-side with statistical deviation indicators").
export async function reviewSession(userId: string, cpiId: string, sessionId: string) {
  await assertHeadJudge(userId, cpiId);
  const session = await loadSession(sessionId, cpiId);

  const scores = await prisma.rubricScore.findMany({
    where: { evaluationSessionId: sessionId },
    include: {
      criterion: { select: { id: true, name: true, maxScore: true, orderIndex: true } },
      cpiEvaluator: { include: { lecturer: { include: { user: { select: { email: true, fullName: true } } } } } },
    },
  });

  const byCriterion = new Map<string, typeof scores>();
  for (const s of scores) {
    const group = byCriterion.get(s.rubricCriterionId) ?? [];
    group.push(s);
    byCriterion.set(s.rubricCriterionId, group);
  }

  const criteria = [...byCriterion.values()]
    .map((group) => {
      const values = group.map((g) => g.score);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const spread = Math.max(...values) - Math.min(...values);
      const maxScore = group[0].criterion.maxScore;
      return {
        criterionId: group[0].rubricCriterionId,
        name: group[0].criterion.name,
        maxScore,
        mean,
        spread,
        // Flag material disagreement: spread over 20% of the criterion's max.
        flagged: spread > 0.2 * maxScore,
        scores: group.map((g) => ({
          evaluator: g.cpiEvaluator.lecturer.user,
          score: g.score,
          comment: g.comment,
          deviation: Number((g.score - mean).toFixed(2)),
        })),
        orderIndex: group[0].criterion.orderIndex,
      };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex);

  return { sessionId, status: session.status, criteria };
}

export async function approve(userId: string, cpiId: string, sessionId: string) {
  const hjId = await assertHeadJudge(userId, cpiId);
  const session = await loadSession(sessionId, cpiId);
  if (session.status !== SessionStatus.AWAITING_HEAD_JUDGE) {
    throw new AuthError(409, "All assigned evaluators must submit before approval");
  }

  await prisma.$transaction([
    prisma.rubricScore.updateMany({
      where: { evaluationSessionId: sessionId },
      data: { status: RubricScoreStatus.FINALIZED },
    }),
    prisma.evaluationSession.update({ where: { id: sessionId }, data: { status: SessionStatus.FINALIZED } }),
    prisma.headJudgeReview.upsert({
      where: { evaluationSessionId: sessionId },
      update: { decision: HeadJudgeDecision.APPROVED, reason: null, correctionEvaluatorId: null, headJudgeCpiEvaluatorId: hjId },
      create: { evaluationSessionId: sessionId, headJudgeCpiEvaluatorId: hjId, decision: HeadJudgeDecision.APPROVED },
    }),
  ]);

  return prisma.headJudgeReview.findUnique({ where: { evaluationSessionId: sessionId } });
}

export async function requestCorrection(
  userId: string,
  cpiId: string,
  sessionId: string,
  evaluatorUserId: string,
  reason: string,
) {
  const hjId = await assertHeadJudge(userId, cpiId);
  const session = await loadSession(sessionId, cpiId);
  if (session.status === SessionStatus.FINALIZED) {
    throw new AuthError(409, "This session is finalized — cannot request corrections");
  }

  const targetId = await getCpiEvaluatorId(evaluatorUserId, cpiId);
  const assigned = targetId
    ? await prisma.stageEvaluator.findUnique({
        where: { evaluationStageId_cpiEvaluatorId: { evaluationStageId: session.evaluationStageId, cpiEvaluatorId: targetId } },
      })
    : null;
  if (!assigned) throw new AuthError(400, "That evaluator is not assigned to this session's stage");

  await prisma.$transaction([
    prisma.evaluationSession.update({ where: { id: sessionId }, data: { status: SessionStatus.CORRECTION_REQUESTED } }),
    prisma.headJudgeReview.upsert({
      where: { evaluationSessionId: sessionId },
      update: { decision: HeadJudgeDecision.CORRECTION_REQUESTED, reason, correctionEvaluatorId: targetId, headJudgeCpiEvaluatorId: hjId },
      create: {
        evaluationSessionId: sessionId,
        headJudgeCpiEvaluatorId: hjId,
        decision: HeadJudgeDecision.CORRECTION_REQUESTED,
        reason,
        correctionEvaluatorId: targetId,
      },
    }),
  ]);

  return prisma.headJudgeReview.findUnique({ where: { evaluationSessionId: sessionId } });
}
