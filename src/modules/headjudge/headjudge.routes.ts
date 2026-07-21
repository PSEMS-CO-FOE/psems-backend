import { CpiPhase } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requestCorrectionSchema } from "./headjudge.schemas";
import * as headjudge from "./headjudge.service";

export const headjudgeRouter = Router({ mergeParams: true });

const inExecution = [requireAuth, blockIfPasswordChangeRequired, requirePhase(CpiPhase.EVALUATION_EXECUTION)];

headjudgeRouter.get("/sessions/:sessionId/review", ...inExecution, async (req, res, next) => {
  try {
    return res.json(await headjudge.reviewSession(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

headjudgeRouter.post("/sessions/:sessionId/approve", ...inExecution, async (req, res, next) => {
  try {
    return res.json(await headjudge.approve(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

headjudgeRouter.post("/sessions/:sessionId/request-correction", ...inExecution, async (req, res, next) => {
  try {
    const { evaluatorUserId, reason } = requestCorrectionSchema.parse(req.body);
    return res.json(
      await headjudge.requestCorrection(req.user!.user_id, req.params.cpiId, req.params.sessionId, evaluatorUserId, reason),
    );
  } catch (err) {
    return next(err);
  }
});
