import { CpiPhase } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { reopenSchema, requestCorrectionSchema } from "./review.schemas";
import * as review from "./review.service";

export const reviewRouter = Router({ mergeParams: true });

const inExecution = [requireAuth, blockIfPasswordChangeRequired, requirePhase(CpiPhase.EVALUATION_EXECUTION)];

reviewRouter.get("/sessions/:sessionId/review", ...inExecution, async (req, res, next) => {
  try {
    return res.json(await review.reviewSession(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

// Marking never ends on its own — the reviewer ends it.
reviewRouter.post("/sessions/:sessionId/close-scoring", ...inExecution, async (req, res, next) => {
  try {
    return res.json(await review.closeScoring(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

// Re-scrutinise: undo a close or an approval and put marking back in play.
// Refused once the stage's marks have been aggregated.
reviewRouter.post("/sessions/:sessionId/reopen", ...inExecution, async (req, res, next) => {
  try {
    const { reason } = reopenSchema.parse(req.body);
    return res.json(await review.reopen(req.user!.user_id, req.params.cpiId, req.params.sessionId, reason));
  } catch (err) {
    return next(err);
  }
});

reviewRouter.post("/sessions/:sessionId/approve", ...inExecution, async (req, res, next) => {
  try {
    return res.json(await review.approve(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

reviewRouter.post("/sessions/:sessionId/request-correction", ...inExecution, async (req, res, next) => {
  try {
    const { panelistId, reason } = requestCorrectionSchema.parse(req.body);
    return res.json(
      await review.requestCorrection(req.user!.user_id, req.params.cpiId, req.params.sessionId, panelistId, reason),
    );
  } catch (err) {
    return next(err);
  }
});
