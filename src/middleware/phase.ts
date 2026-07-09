import { CpiPhase } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/database";

// Gates an action to its designated CPI phase window (spec 3.3 Step 2). The
// coordinator sets each phase's [startDate, endDate] during timeline setup;
// this rejects any request that arrives before the window opens or after it
// closes. Reads the CPI id from a route param (default ":cpiId").
//
// This is a time-window gate, distinct from RBAC (who) and CPI ownership
// (whose CPI) — those are checked separately by role middleware and the
// service layer.
export function requirePhase(phase: CpiPhase, cpiIdParam = "cpiId") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const cpiId = req.params[cpiIdParam];
    if (!cpiId) {
      return res.status(400).json({ error: `Missing ${cpiIdParam} in route` });
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
