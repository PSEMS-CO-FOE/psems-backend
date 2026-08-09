import { MarkCounting, PanelRole, RubricScoreStatus, SessionStatus, StagePanelRule } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";
import { effectiveMarkCounting } from "../panel/panel.service";
import { getStudentGroupId } from "../shared/cpiMembership";

type ScoredPanelist = { id: string; role: PanelRole; markCounting: MarkCounting | null; weightPercent: number | null };

function mean(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

// A seat's own weight wins over its role's, so a coordinator can weight three
// plain evaluators 50/25/25 without needing separate senior/junior roles.
function resolveWeight(
  panelist: ScoredPanelist,
  rules: Pick<StagePanelRule, "role" | "weightPercent" | "markCounting">[],
): number | null {
  return panelist.weightPercent ?? rules.find((r) => r.role === panelist.role)?.weightPercent ?? null;
}

// Combine a criterion's scores into one value.
//
// This is a weighted MEAN — sum(score x weight) / sum(weight) — not a sum of
// weighted scores. Weights express relative say, so three markers weighted
// 50/25/25 who all give 80 must yield 80, not 40.
//
// With no weights anywhere it degrades to a plain average, which is the ordinary
// case. A seat left unweighted among weighted ones counts as a typical weighted
// seat rather than vanishing.
function combineScores(
  scores: { score: number; panelist: ScoredPanelist }[],
  rules: Pick<StagePanelRule, "role" | "weightPercent" | "markCounting">[],
) {
  if (scores.length === 0) return 0;

  const entries = scores.map((s) => ({ score: s.score, weight: resolveWeight(s.panelist, rules) }));
  const specified = entries.map((e) => e.weight).filter((w): w is number => w !== null);
  if (specified.length === 0) return mean(entries.map((e) => e.score));

  const fallback = mean(specified);
  const totalWeight = entries.reduce((sum, e) => sum + (e.weight ?? fallback), 0);
  if (totalWeight === 0) return mean(entries.map((e) => e.score));

  return entries.reduce((sum, e) => sum + e.score * (e.weight ?? fallback), 0) / totalWeight;
}

// Which seats fall into the pooled bucket, capped at the stage's scorer limit.
// Ordered by seat id so the same subset is chosen every time marks are
// aggregated — re-running aggregation must not change anyone's result.
function orderedPooledPanelistIds(
  scores: { sessionPanelistId: string; panelist: ScoredPanelist }[],
  rules: Pick<StagePanelRule, "role" | "markCounting">[],
  limit: number | null,
) {
  const ids = [
    ...new Set(
      scores
        .filter((s) => effectiveMarkCounting(s.panelist, rules) === MarkCounting.COORDINATOR_DECIDES)
        .map((s) => s.sessionPanelistId),
    ),
  ].sort();
  return new Set(limit === null ? ids : ids.slice(0, limit));
}

// Compute each group's marks from finalized scores (spec 3.3 Step 11). Requires
// every session approved at review. Per criterion: combine the panel's scores as
// a % of maxScore; weight by criterion weight -> stage %; weight by stage weight
// -> the stage's contribution to the group's overall (0–100).
export async function aggregateMarks(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId },
    include: { stage: { include: { criteria: true, panelRules: true } } },
  });
  if (sessions.length === 0) throw new AuthError(409, "No evaluation sessions to aggregate");
  if (sessions.some((s) => s.status !== SessionStatus.FINALIZED)) {
    throw new AuthError(409, "Every session must be approved at review before aggregation");
  }

  for (const session of sessions) {
    const scores = await prisma.rubricScore.findMany({
      where: { evaluationSessionId: session.id, status: RubricScoreStatus.FINALIZED },
      include: { panelist: { select: { id: true, role: true, markCounting: true, weightPercent: true } } },
    });

    const rules = session.stage.panelRules;
    const counting = (s: (typeof scores)[number]) => effectiveMarkCounting(s.panelist, rules);

    // ADVISORY marks are recorded and shown but never reach the total.
    const contributing = scores.filter((s) => counting(s) !== MarkCounting.ADVISORY);

    // Panelists the coordinator decides on — walk-ins and guests without a
    // formal role — are pooled: averaged into ONE contribution weighted by the
    // stage's pooledSharePercent, so a crowd cannot outvote the formal panel by
    // sheer number. pooledScorerLimit caps how many of them count, and is held
    // uniform across the stage so unequal panels stay comparable.
    const pooledIds = orderedPooledPanelistIds(contributing, rules, session.stage.pooledScorerLimit);
    const pooledShare = (session.stage.pooledSharePercent ?? 0) / 100;

    let stagePct = 0;
    for (const c of session.stage.criteria) {
      const cScores = contributing.filter((s) => s.rubricCriterionId === c.id);
      if (cScores.length === 0) continue;

      const pooled = cScores.filter((s) => pooledIds.has(s.sessionPanelistId));
      const formal = cScores.filter((s) => !pooledIds.has(s.sessionPanelistId));

      const formalAvg = combineScores(formal, rules);
      // The pool is deliberately a flat average — its whole point is that a
      // crowd contributes one voice, not many.
      const pooledAvg = mean(pooled.map((s) => s.score));

      // With no pooled scorers (or no share set) the formal panel carries the
      // whole criterion, which is the ordinary case.
      const share = pooled.length > 0 ? pooledShare : 0;
      const value =
        formal.length > 0 ? formalAvg * (1 - share) + pooledAvg * share : pooledAvg;

      stagePct += (value / c.maxScore) * 100 * (c.weight / 100);
    }
    const weightedContribution = stagePct * (session.stage.weight / 100);

    await prisma.finalMark.upsert({
      where: { groupId_evaluationStageId: { groupId: session.groupId, evaluationStageId: session.evaluationStageId } },
      update: { stageScorePercent: stagePct, weightedContribution },
      create: {
        courseInstanceId: cpiId,
        groupId: session.groupId,
        evaluationStageId: session.evaluationStageId,
        stageScorePercent: stagePct,
        weightedContribution,
      },
    });
  }

  return buildMarksView(cpiId);
}

export async function publishMarks(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  const count = await prisma.finalMark.count({ where: { courseInstanceId: cpiId } });
  if (count === 0) throw new AuthError(409, "Aggregate marks before publishing");

  const updated = await prisma.courseInstance.update({
    where: { id: cpiId },
    data: { marksPublishedAt: new Date() },
    select: { id: true, marksPublishedAt: true },
  });

  const members = await prisma.groupMember.findMany({
    where: { status: "ACCEPTED", group: { courseInstanceId: cpiId } },
    include: { student: true },
  });
  await notifyMany(
    members.map((m) => m.student.userId),
    {
      type: "MARKS_PUBLISHED",
      title: "Your marks are published",
      body: `Final marks for "${cpi.name}" are now available.`,
      courseInstanceId: cpiId,
      email: true,
    },
  );

  return updated;
}

export async function getMarks(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  if (cpi.createdById === userId) {
    await loadOwnedCpi(userId, cpiId);
    return buildMarksView(cpiId);
  }

  const groupId = await getStudentGroupId(userId, cpiId);
  if (!groupId) throw new AuthError(403, "You are not a participant in this CPI");
  if (!cpi.marksPublishedAt) throw new AuthError(403, "Marks have not been published yet");
  return buildMarksView(cpiId, groupId);
}

async function buildMarksView(cpiId: string, onlyGroupId?: string) {
  const marks = await prisma.finalMark.findMany({
    where: { courseInstanceId: cpiId, ...(onlyGroupId ? { groupId: onlyGroupId } : {}) },
    include: { group: { select: { id: true, name: true } }, stage: { select: { id: true, name: true, weight: true } } },
  });

  const byGroup = new Map<string, { groupId: string; groupName: string; stages: unknown[]; overall: number }>();
  for (const m of marks) {
    const entry = byGroup.get(m.groupId) ?? { groupId: m.groupId, groupName: m.group.name, stages: [], overall: 0 };
    entry.stages.push({
      stageId: m.stage.id,
      stageName: m.stage.name,
      weight: m.stage.weight,
      stageScorePercent: Number(m.stageScorePercent.toFixed(2)),
      weightedContribution: Number(m.weightedContribution.toFixed(2)),
    });
    entry.overall = Number((entry.overall + m.weightedContribution).toFixed(2));
    byGroup.set(m.groupId, entry);
  }
  return [...byGroup.values()];
}
