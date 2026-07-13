import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import { assignStageEvaluatorSchema, evaluationConfigSchema } from "./evaluations.schemas";
import * as evaluations from "./evaluations.service";

export const evaluationsRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorInConfig = [
  ...authed,
  requireRole(Role.COURSE_COORDINATOR),
  requirePhase(CpiPhase.EVALUATION_CONFIG),
];

evaluationsRouter.put("/config", ...coordinatorInConfig, async (req, res, next) => {
  try {
    const input = evaluationConfigSchema.parse(req.body);
    return res.json(await evaluations.setEvaluationConfig(req.user!.user_id, req.params.cpiId, input));
  } catch (err) {
    return next(err);
  }
});

evaluationsRouter.post("/stages/:stageId/evaluators", ...coordinatorInConfig, async (req, res, next) => {
  try {
    const { lecturerUserId } = assignStageEvaluatorSchema.parse(req.body);
    return res
      .status(201)
      .json(await evaluations.assignStageEvaluator(req.user!.user_id, req.params.cpiId, req.params.stageId, lecturerUserId));
  } catch (err) {
    return next(err);
  }
});

// Read the rubric — any CPI participant, not phase-gated.
evaluationsRouter.get("/config", ...authed, async (req, res, next) => {
  try {
    return res.json(await evaluations.getEvaluationConfig(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
