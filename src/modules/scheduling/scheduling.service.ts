import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { getCpiEvaluatorId, getHeadJudgeCpiEvaluatorId } from "../shared/cpiMembership";

export async function submitAvailability(userId: string, cpiId: string, slotStart: Date, slotEnd: Date) {
  const cpiEvaluatorId = await getCpiEvaluatorId(userId, cpiId);
  if (!cpiEvaluatorId) throw new AuthError(403, "Only an evaluator of this CPI can submit availability");

  return prisma.evaluatorAvailability.create({
    data: { courseInstanceId: cpiId, cpiEvaluatorId, slotStart, slotEnd },
  });
}

export async function listAvailability(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  return prisma.evaluatorAvailability.findMany({
    where: { courseInstanceId: cpiId },
    include: { cpiEvaluator: { include: { lecturer: { include: { user: { select: { email: true, fullName: true } } } } } } },
    orderBy: { slotStart: "asc" },
  });
}

// Build the timetable: one session per allocated group per stage. Idempotent —
// re-running skips sessions that already exist.
export async function generateSessions(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const [allocations, stages] = await Promise.all([
    prisma.projectAllocation.findMany({ where: { courseInstanceId: cpiId }, select: { groupId: true } }),
    prisma.evaluationStage.findMany({ where: { courseInstanceId: cpiId }, select: { id: true } }),
  ]);
  if (allocations.length === 0) throw new AuthError(409, "No allocations exist — finalize allocation first");
  if (stages.length === 0) throw new AuthError(409, "No evaluation stages exist — configure evaluation first");

  let created = 0;
  for (const { groupId } of allocations) {
    for (const stage of stages) {
      const exists = await prisma.evaluationSession.findUnique({
        where: { groupId_evaluationStageId: { groupId, evaluationStageId: stage.id } },
      });
      if (exists) continue;
      await prisma.evaluationSession.create({
        data: { courseInstanceId: cpiId, groupId, evaluationStageId: stage.id },
      });
      created++;
    }
  }

  return { created, sessions: await getSessionMap(cpiId) };
}

export async function scheduleSession(
  coordinatorUserId: string,
  cpiId: string,
  sessionId: string,
  scheduledStart: Date,
  scheduledEnd: Date,
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return prisma.evaluationSession.update({
    where: { id: sessionId },
    data: { scheduledStart, scheduledEnd },
  });
}

// Sessions visible to the requester: coordinator/HJ see all; an evaluator sees
// only sessions whose stage they're assigned to.
export async function listSessions(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  if (cpi.createdById === userId || (await getHeadJudgeCpiEvaluatorId(userId, cpiId))) {
    return getSessionMap(cpiId);
  }

  const cpiEvaluatorId = await getCpiEvaluatorId(userId, cpiId);
  if (!cpiEvaluatorId) throw new AuthError(403, "You are not a participant in this CPI's evaluation");

  const stageIds = (
    await prisma.stageEvaluator.findMany({ where: { cpiEvaluatorId }, select: { evaluationStageId: true } })
  ).map((s) => s.evaluationStageId);

  return prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId, evaluationStageId: { in: stageIds } },
    include: sessionInclude,
    orderBy: { createdAt: "asc" },
  });
}

async function getSessionMap(cpiId: string) {
  return prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId },
    include: sessionInclude,
    orderBy: { createdAt: "asc" },
  });
}

const sessionInclude = {
  group: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true } },
} as const;
