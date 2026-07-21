import { RubricScoreStatus, SessionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";
import { getStudentGroupId } from "../shared/cpiMembership";

// Compute each group's marks from finalized scores (spec 3.3 Step 11). Requires
// every session Head-Judge approved. Per criterion: average the evaluators'
// scores as a % of maxScore; weight by criterion weight -> stage %; weight by
// stage weight -> the stage's contribution to the group's overall (0–100).
export async function aggregateMarks(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId },
    include: { stage: { include: { criteria: true } } },
  });
  if (sessions.length === 0) throw new AuthError(409, "No evaluation sessions to aggregate");
  if (sessions.some((s) => s.status !== SessionStatus.FINALIZED)) {
    throw new AuthError(409, "Every session must be Head-Judge approved before aggregation");
  }

  for (const session of sessions) {
    const scores = await prisma.rubricScore.findMany({
      where: { evaluationSessionId: session.id, status: RubricScoreStatus.FINALIZED },
    });

    let stagePct = 0;
    for (const c of session.stage.criteria) {
      const cScores = scores.filter((s) => s.rubricCriterionId === c.id);
      if (cScores.length === 0) continue;
      const avg = cScores.reduce((a, b) => a + b.score, 0) / cScores.length;
      stagePct += (avg / c.maxScore) * 100 * (c.weight / 100);
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
