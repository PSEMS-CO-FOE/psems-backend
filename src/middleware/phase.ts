import { CpiPhase } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/database";
import { LATE_JOINER_PHASES } from "../modules/courses/batch";

// Gates an action to its CPI phase window (spec 3.3 Step 2) — a time gate,
// separate from RBAC (who) and CPI ownership (whose CPI). Reads the CPI id from
// a route param (default ":cpiId").
export function requirePhase(phase: CpiPhase, cpiIdParam = "cpiId") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const cpiId = req.params[cpiIdParam];
    if (!cpiId) {
      return res.status(400).json({ error: `Missing ${cpiIdParam} in route` });
    }

    // A student approved to join a later batch's course arrives after the
    // previous course finished and its marks came out, so this course has
    // usually moved past registration and selection. The approval carries a
    // reason, a decision and a timestamp — it is the authorisation to act
    // outside those two windows, and without this the approval would only
    // reveal a course they still could not do anything in.
    if (LATE_JOINER_PHASES.includes(phase) && req.user && (await isApprovedLateJoiner(req.user.user_id, cpiId))) {
      return next();
    }

    const window = await prisma.cpiTimeline.findUnique({
      where: { courseInstanceId_phase: { courseInstanceId: cpiId, phase } },
    });

    if (!window) {
      return res.status(403).json({
        error: `The ${phase} phase has not been scheduled for this CPI`,
        code: "PHASE_NOT_SCHEDULED",
      });
    }

    const now = new Date();
    if (now < window.startDate) {
      return res.status(403).json({
        error: `The ${phase} phase opens at ${window.startDate.toISOString()}`,
        code: "PHASE_NOT_OPEN",
      });
    }
    if (now > window.endDate) {
      return res.status(403).json({
        error: `The ${phase} phase closed at ${window.endDate.toISOString()}`,
        code: "PHASE_CLOSED",
      });
    }

    return next();
  };
}

/**
 * Open while ANY of these phases is. Some actions belong to more than one point
 * in the course — co-supervision is arranged when ideas go up, and again once
 * selection has paired a supervisor with a group — and gating them to a single
 * phase shuts them exactly when they are needed.
 */
export function requireAnyPhase(phases: CpiPhase[], cpiIdParam = "cpiId") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const cpiId = req.params[cpiIdParam];
    if (!cpiId) {
      return res.status(400).json({ error: `Missing ${cpiIdParam} in route` });
    }

    if (
      req.user &&
      phases.some((phase) => LATE_JOINER_PHASES.includes(phase)) &&
      (await isApprovedLateJoiner(req.user.user_id, cpiId))
    ) {
      return next();
    }

    const windows = await prisma.cpiTimeline.findMany({
      where: { courseInstanceId: cpiId, phase: { in: phases } },
    });

    const now = new Date();
    if (windows.some((w) => now >= w.startDate && now <= w.endDate)) return next();

    return res.status(403).json({
      error: `This needs one of these phases to be open: ${phases.join(", ")}`,
      code: "PHASE_CLOSED",
    });
  };
}

async function isApprovedLateJoiner(userId: string, cpiId: string): Promise<boolean> {
  const student = await prisma.student.findUnique({ where: { userId }, select: { id: true } });
  if (!student) return false;

  const approval = await prisma.courseJoinRequest.findUnique({
    where: { courseInstanceId_studentId: { courseInstanceId: cpiId, studentId: student.id } },
    select: { status: true },
  });
  return approval?.status === "APPROVED";
}
