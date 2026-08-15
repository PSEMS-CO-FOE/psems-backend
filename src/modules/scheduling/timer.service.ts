import { CpiPhase, Prisma, SegmentTimeliness, SessionTimerSegment } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { getSessionPanelist } from "../shared/cpiMembership";
import { liveElapsed } from "./scheduling.service";

// The presentation clock, split into parts. The clock is kept on the server so
// everyone in the room sees the same time.

export type TimerAction = "start" | "pause" | "next" | "previous" | "stop" | "reset";

// How far off the target a part can be and still count as on time. It is a share
// of the target with an upper limit, so a short part does not get too much room.
const TIMELINESS_TOLERANCE_FRACTION = 0.1;
const TIMELINESS_TOLERANCE_CAP_SECONDS = 15;

function toleranceFor(targetSeconds: number) {
  return Math.min(TIMELINESS_TOLERANCE_CAP_SECONDS, targetSeconds * TIMELINESS_TOLERANCE_FRACTION);
}

const segmentOrder = { orderIndex: "asc" } as const;

async function loadSession(cpiId: string, sessionId: string) {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: { stage: { select: { id: true } } },
  });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return session;
}

// The coordinator, or anyone on this session's panel.
async function assertCanRunTimer(userId: string, cpiId: string, sessionId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { createdById: true } });
  if (cpi?.createdById === userId) return;
  const seat = await getSessionPanelist(userId, sessionId);
  if (!seat) throw new AuthError(403, "Only the coordinator or a member of this session's panel can control the timer");
}

// Checked here instead of on the route, so a session that runs a little outside
// the window does not fail on every button press.
async function assertEvaluationWindowOpen(cpiId: string) {
  const window = await prisma.cpiTimeline.findUnique({
    where: { courseInstanceId_phase: { courseInstanceId: cpiId, phase: CpiPhase.EVALUATION_EXECUTION } },
  });
  if (!window) throw new AuthError(403, "The evaluation phase has not been scheduled for this CPI");
  if (new Date() < window.startDate) {
    throw new AuthError(403, `Evaluation opens at ${window.startDate.toISOString()}`);
  }
}

// Copy the stage's running order onto the session the first time it is used. It
// is copied, not shared, so changing the stage later cannot change what a
// finished session recorded.
async function ensureSegments(sessionId: string, stageId: string): Promise<SessionTimerSegment[]> {
  const existing = await prisma.sessionTimerSegment.findMany({
    where: { evaluationSessionId: sessionId },
    orderBy: segmentOrder,
  });
  if (existing.length > 0) return existing;

  const templates = await prisma.timerSegmentTemplate.findMany({
    where: { evaluationStageId: stageId },
    orderBy: segmentOrder,
  });
  if (templates.length === 0) return [];

  await prisma.sessionTimerSegment.createMany({
    data: templates.map((t) => ({
      evaluationSessionId: sessionId,
      orderIndex: t.orderIndex,
      name: t.name,
      targetSeconds: t.targetSeconds,
    })),
  });

  return prisma.sessionTimerSegment.findMany({ where: { evaluationSessionId: sessionId }, orderBy: segmentOrder });
}

function segmentElapsed(segment: Pick<SessionTimerSegment, "accumulatedSeconds" | "running" | "startedAt">): number {
  const runningExtra = segment.running && segment.startedAt
    ? Math.floor((Date.now() - segment.startedAt.getTime()) / 1000)
    : 0;
  return segment.accumulatedSeconds + runningExtra;
}

// Work out whether a part finished on time, late or early.
function timelinessFor(elapsed: number, target: number): SegmentTimeliness {
  const tolerance = toleranceFor(target);
  if (elapsed > target + tolerance) return SegmentTimeliness.OVERTIME;
  if (elapsed < target - tolerance) return SegmentTimeliness.UNDER;
  return SegmentTimeliness.ON_TIME;
}

// Finish the running part and save its time. The extra time over the target is
// saved too, so changing the target later cannot change what was recorded.
function closeSegmentData(segment: SessionTimerSegment): Prisma.SessionTimerSegmentUpdateInput {
  const elapsed = segmentElapsed(segment);
  return {
    running: false,
    startedAt: null,
    accumulatedSeconds: elapsed,
    completedAt: new Date(),
    overranSeconds: Math.max(0, elapsed - segment.targetSeconds),
    ...(segment.timelinessManual ? {} : { timeliness: timelinessFor(elapsed, segment.targetSeconds) }),
  };
}

export async function controlTimer(userId: string, cpiId: string, sessionId: string, action: TimerAction) {
  const session = await loadSession(cpiId, sessionId);
  await assertCanRunTimer(userId, cpiId, sessionId);
  await assertEvaluationWindowOpen(cpiId);

  const segments = await ensureSegments(sessionId, session.evaluationStageId);
  const sessionElapsed = liveElapsed(session);
  const index = session.currentSegmentIndex;
  const current = segments.find((s) => s.orderIndex === index) ?? null;

  switch (action) {
    case "start":
      if (!session.timerRunning) {
        await prisma.evaluationSession.update({
          where: { id: sessionId },
          data: { timerRunning: true, timerStartedAt: new Date() },
        });
      }
      if (current && !current.running) {
        await prisma.sessionTimerSegment.update({
          where: { id: current.id },
          data: { running: true, startedAt: new Date() },
        });
      }
      break;

    case "pause":
      await pauseAll(sessionId, session, segments, sessionElapsed);
      break;

    // Moving on is always manual. Nothing changes when a target is reached — a
    // part that runs long keeps counting, so the extra time is recorded.
    case "next":
      await moveTo(sessionId, session, segments, index + 1);
      break;

    case "previous":
      await moveTo(sessionId, session, segments, index - 1);
      break;

    case "stop":
      await pauseAll(sessionId, session, segments, sessionElapsed, { closeCurrent: true });
      await prisma.evaluationSession.update({
        where: { id: sessionId },
        data: { presentationDurationSeconds: sessionElapsed },
      });
      break;

    case "reset":
      await prisma.$transaction([
        prisma.sessionTimerSegment.updateMany({
          where: { evaluationSessionId: sessionId },
          data: {
            running: false,
            startedAt: null,
            accumulatedSeconds: 0,
            completedAt: null,
            overranSeconds: 0,
            timeliness: null,
            timelinessManual: false,
          },
        }),
        prisma.evaluationSession.update({
          where: { id: sessionId },
          data: {
            timerRunning: false,
            timerStartedAt: null,
            timerAccumulatedSeconds: 0,
            presentationDurationSeconds: null,
            currentSegmentIndex: 0,
          },
        }),
      ]);
      break;
  }

  return getTimer(userId, cpiId, sessionId);
}

async function pauseAll(
  sessionId: string,
  session: { timerRunning: boolean },
  segments: SessionTimerSegment[],
  sessionElapsed: number,
  opts: { closeCurrent?: boolean } = {},
) {
  const running = segments.find((s) => s.running);
  if (running) {
    await prisma.sessionTimerSegment.update({
      where: { id: running.id },
      data: opts.closeCurrent
        ? closeSegmentData(running)
        : { running: false, startedAt: null, accumulatedSeconds: segmentElapsed(running) },
    });
  }
  if (session.timerRunning || opts.closeCurrent) {
    await prisma.evaluationSession.update({
      where: { id: sessionId },
      data: { timerRunning: false, timerStartedAt: null, timerAccumulatedSeconds: sessionElapsed },
    });
  }
}

// Move to another part. The part being left is finished, and the new one only
// starts if the clock was already running.
async function moveTo(
  sessionId: string,
  session: { timerRunning: boolean },
  segments: SessionTimerSegment[],
  target: number,
) {
  if (segments.length === 0) throw new AuthError(409, "This stage has no timer segments configured");
  if (target < 0 || target >= segments.length) {
    throw new AuthError(409, target < 0 ? "Already on the first segment" : "Already on the last segment");
  }

  const leaving = segments.find((s) => s.running);
  if (leaving) await prisma.sessionTimerSegment.update({ where: { id: leaving.id }, data: closeSegmentData(leaving) });

  const entering = segments.find((s) => s.orderIndex === target);
  if (entering && session.timerRunning) {
    await prisma.sessionTimerSegment.update({
      where: { id: entering.id },
      data: { running: true, startedAt: new Date() },
    });
  }

  await prisma.evaluationSession.update({ where: { id: sessionId }, data: { currentSegmentIndex: target } });
}

// Change a part's on time / late / early result by hand.
export async function setSegmentTimeliness(
  userId: string,
  cpiId: string,
  sessionId: string,
  segmentId: string,
  timeliness: SegmentTimeliness,
) {
  await loadSession(cpiId, sessionId);
  await assertCanRunTimer(userId, cpiId, sessionId);

  const segment = await prisma.sessionTimerSegment.findUnique({ where: { id: segmentId } });
  if (!segment || segment.evaluationSessionId !== sessionId) {
    throw new AuthError(404, "Segment not found on this session");
  }

  await prisma.sessionTimerSegment.update({
    where: { id: segmentId },
    data: { timeliness, timelinessManual: true },
  });
  return getTimer(userId, cpiId, sessionId);
}

// Kept small, because the timer window asks for it about once a second.
export async function getTimer(userId: string, cpiId: string, sessionId: string) {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      courseInstanceId: true,
      currentSegmentIndex: true,
      timerRunning: true,
      timerStartedAt: true,
      timerAccumulatedSeconds: true,
      presentationDurationSeconds: true,
      group: { select: { name: true } },
      stage: { select: { name: true } },
      timerSegments: { orderBy: segmentOrder },
    },
  });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  await assertCanRunTimer(userId, cpiId, sessionId);

  const segments = session.timerSegments.map((s) => {
    const elapsedSeconds = segmentElapsed(s);
    return {
      id: s.id,
      orderIndex: s.orderIndex,
      name: s.name,
      targetSeconds: s.targetSeconds,
      elapsedSeconds,
      running: s.running,
      completedAt: s.completedAt,
      // Counts up while the part runs, then stays at its saved value.
      overranSeconds: s.completedAt ? s.overranSeconds : Math.max(0, elapsedSeconds - s.targetSeconds),
      timeliness: s.timeliness,
      timelinessManual: s.timelinessManual,
    };
  });

  return {
    sessionId: session.id,
    group: session.group.name,
    stage: session.stage.name,
    running: session.timerRunning,
    elapsedSeconds: liveElapsed(session),
    presentationDurationSeconds: session.presentationDurationSeconds,
    currentSegmentIndex: session.currentSegmentIndex,
    segments,
  };
}

// Type in the final time by hand, for when only the total is known.
export async function setPresentationDuration(userId: string, cpiId: string, sessionId: string, seconds: number) {
  await loadSession(cpiId, sessionId);
  await assertCanRunTimer(userId, cpiId, sessionId);
  return prisma.evaluationSession.update({
    where: { id: sessionId },
    data: { presentationDurationSeconds: seconds },
  });
}

// Saves the whole list at once, like the rest of the evaluation setup.
export async function setSegmentTemplates(
  stageId: string,
  segments: { name: string; targetSeconds: number }[],
) {
  await prisma.$transaction([
    prisma.timerSegmentTemplate.deleteMany({ where: { evaluationStageId: stageId } }),
    prisma.timerSegmentTemplate.createMany({
      data: segments.map((s, i) => ({
        evaluationStageId: stageId,
        name: s.name,
        targetSeconds: s.targetSeconds,
        orderIndex: i,
      })),
    }),
  ]);

  return prisma.timerSegmentTemplate.findMany({ where: { evaluationStageId: stageId }, orderBy: segmentOrder });
}
