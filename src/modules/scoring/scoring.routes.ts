import { CpiPhase } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { submitScoresSchema } from "./scoring.schemas";
import * as scoring from "./scoring.service";

export const scoringRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const inExecution = requirePhase(CpiPhase.EVALUATION_EXECUTION);

scoringRouter.post("/sessions/:sessionId/scores", ...authed, inExecution, async (req, res, next) => {
  try {
    const { scores } = submitScoresSchema.parse(req.body);
    return res.status(201).json(await scoring.submitScores(req.user!.user_id, req.params.cpiId, req.params.sessionId, scores));
  } catch (err) {
    return next(err);
  }
});

scoringRouter.get("/sessions/:sessionId/scores", ...authed, async (req, res, next) => {
  try {
    return res.json(await scoring.getSessionScores(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});
