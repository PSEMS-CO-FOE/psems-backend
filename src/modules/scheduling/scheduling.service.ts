import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";
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
  location?: string,
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");

  // Evaluators assigned to this session's stage.
  const assignedEvaluators = await prisma.stageEvaluator.findMany({
    where: { evaluationStageId: session.evaluationStageId },
    select: { cpiEvaluatorId: true },
  });
  const assignedIds = assignedEvaluators.map((e) => e.cpiEvaluatorId);

  // Conflict detection (soft): any other scheduled session that shares an
  // assigned evaluator and overlaps the proposed time. Surfaced as a warning,
  // not a hard block — the coordinator may knowingly override.
  const otherStageIds = (
    await prisma.stageEvaluator.findMany({
      where: { cpiEvaluatorId: { in: assignedIds } },
      select: { evaluationStageId: true },
    })
  ).map((s) => s.evaluationStageId);

  const overlapping = await prisma.evaluationSession.findMany({
    where: {
      courseInstanceId: cpiId,
      id: { not: sessionId },
      evaluationStageId: { in: otherStageIds },
      scheduledStart: { lt: scheduledEnd },
      scheduledEnd: { gt: scheduledStart },
    },
    include: { group: { select: { name: true } }, stage: { select: { name: true } } },
  });
  const conflicts = overlapping.map((o) => ({
    sessionId: o.id,
    group: o.group.name,
    stage: o.stage.name,
    scheduledStart: o.scheduledStart,
    scheduledEnd: o.scheduledEnd,
  }));

  const updated = await prisma.evaluationSession.update({
    where: { id: sessionId },
    data: { scheduledStart, scheduledEnd, location },
    include: { group: { select: { name: true } }, stage: { select: { name: true } } },
  });

  // Notify students, the supervisor, and the assigned evaluators of the confirmed slot.
  const [members, allocation, evaluatorUsers] = await Promise.all([
    prisma.groupMember.findMany({ where: { groupId: session.groupId, status: "ACCEPTED" }, include: { student: true } }),
    prisma.projectAllocation.findUnique({ where: { groupId: session.groupId }, include: { supervisor: true } }),
    prisma.cpiEvaluator.findMany({ where: { id: { in: assignedIds } }, include: { lecturer: true } }),
  ]);
  const recipients = [
    ...members.map((m) => m.student.userId),
    ...(allocation?.supervisor ? [allocation.supervisor.userId] : []),
    ...evaluatorUsers.map((e) => e.lecturer.userId),
  ];
  const when = `${scheduledStart.toISOString()} – ${scheduledEnd.toISOString()}`;
  await notifyMany(recipients, {
    type: "SESSION_SCHEDULED",
    title: "Evaluation session scheduled",
    body: `"${updated.stage.name}" for "${updated.group.name}" is scheduled ${when}${location ? ` at ${location}` : ""}.`,
    courseInstanceId: cpiId,
  });

  return { session: updated, conflicts };
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

  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId, evaluationStageId: { in: stageIds } },
    include: sessionInclude,
    orderBy: { createdAt: "asc" },
  });
  return sessions.map(withDerived);
}

// Whoever runs the room (coordinator, an assigned evaluator, or the Head Judge)
// may set/control the presentation timer.
async function assertCanRunTimer(userId: string, cpiId: string, evaluationStageId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { createdById: true } });
  const cpiEvaluatorId = await getCpiEvaluatorId(userId, cpiId);
  const assigned = cpiEvaluatorId
    ? await prisma.stageEvaluator.findUnique({
        where: { evaluationStageId_cpiEvaluatorId: { evaluationStageId, cpiEvaluatorId } },
      })
    : null;
  const isHeadJudge = (await getHeadJudgeCpiEvaluatorId(userId, cpiId)) !== null;
  if (cpi!.createdById !== userId && !assigned && !isHeadJudge) {
    throw new AuthError(403, "Only the coordinator, an assigned evaluator, or the Head Judge can control the timer");
  }
}

function liveElapsed(s: { timerAccumulatedSeconds: number; timerRunning: boolean; timerStartedAt: Date | null }): number {
  const runningExtra = s.timerRunning && s.timerStartedAt ? Math.floor((Date.now() - s.timerStartedAt.getTime()) / 1000) : 0;
  return s.timerAccumulatedSeconds + runningExtra;
}

// Save the final elapsed presentation time directly (manual entry). Kept
// alongside the shared timer for when a duration is just typed in.
export async function setPresentationDuration(userId: string, cpiId: string, sessionId: string, seconds: number) {
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  await assertCanRunTimer(userId, cpiId, session.evaluationStageId);
  return prisma.evaluationSession.update({ where: { id: sessionId }, data: { presentationDurationSeconds: seconds } });
}

// Control the shared presentation timer. State lives on the session so every
// evaluator viewing it sees the same running clock (they poll for updates).
export async function controlTimer(
  userId: string,
  cpiId: string,
  sessionId: string,
  action: "start" | "pause" | "stop" | "reset",
) {
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  await assertCanRunTimer(userId, cpiId, session.evaluationStageId);

  const elapsed = liveElapsed(session);
  let data;
  switch (action) {
    case "start":
      data = session.timerRunning ? {} : { timerRunning: true, timerStartedAt: new Date() };
      break;
    case "pause":
      data = { timerRunning: false, timerStartedAt: null, timerAccumulatedSeconds: elapsed };
      break;
    case "stop":
      data = { timerRunning: false, timerStartedAt: null, timerAccumulatedSeconds: elapsed, presentationDurationSeconds: elapsed };
      break;
    case "reset":
      data = { timerRunning: false, timerStartedAt: null, timerAccumulatedSeconds: 0, presentationDurationSeconds: null };
      break;
  }

  const updated = await prisma.evaluationSession.update({ where: { id: sessionId }, data });
  return withDerived(updated);
}

async function getSessionMap(cpiId: string) {
  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId },
    include: sessionInclude,
    orderBy: { createdAt: "asc" },
  });
  return sessions.map(withDerived);
}

// Derived, non-persisted fields for session responses: an isOverdue flag, and
// the live timer elapsed value so pollers stay in sync.
function withDerived<
  T extends {
    scheduledEnd: Date | null;
    status: string;
    timerAccumulatedSeconds: number;
    timerRunning: boolean;
    timerStartedAt: Date | null;
  },
>(session: T) {
  const isOverdue = !!session.scheduledEnd && session.scheduledEnd.getTime() < Date.now() && session.status === "SCHEDULED";
  return { ...session, isOverdue, timerElapsedSeconds: liveElapsed(session) };
}

const sessionInclude = {
  group: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true } },
} as const;
