import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import {
  assignStageEvaluatorSchema,
  evaluationConfigSchema,
  patchStageSchema,
  pooledShareSchema,
  setPanelRulesSchema,
} from "./evaluations.schemas";
import { timerSegmentTemplateSchema } from "../scheduling/scheduling.schemas";
import * as evaluations from "./evaluations.service";
import { applyStagePanelSchema } from "../panel/panel.schemas";
import { applyPanelToStage } from "../panel/panel.service";

export const evaluationsRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorOnly = [...authed, requireRole(Role.COURSE_COORDINATOR)];
const coordinatorInConfig = [...coordinatorOnly, requirePhase(CpiPhase.EVALUATION_CONFIG)];

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

// The patch endpoints below are deliberately NOT gated to EVALUATION_CONFIG.
// Restaffing a panel, fixing a window, opening a stage or weighting the pooled
// marks are all things that happen on the day, long after that phase closed.
evaluationsRouter.patch("/stages/:stageId", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = patchStageSchema.parse(req.body);
    return res.json(await evaluations.patchStage(req.user!.user_id, req.params.cpiId, req.params.stageId, input));
  } catch (err) {
    return next(err);
  }
});

// One panel across every group in the stage — the usual starting point, since
// the same people normally evaluate everybody. Per-session edits layer on top.
evaluationsRouter.put("/stages/:stageId/panel", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { panelists, replaceExisting } = applyStagePanelSchema.parse(req.body);
    return res.json(
      await applyPanelToStage(req.user!.user_id, req.params.cpiId, req.params.stageId, panelists, replaceExisting),
    );
  } catch (err) {
    return next(err);
  }
});

evaluationsRouter.put("/stages/:stageId/panel-rules", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = setPanelRulesSchema.parse(req.body);
    return res.json(await evaluations.setPanelRules(req.user!.user_id, req.params.cpiId, req.params.stageId, input));
  } catch (err) {
    return next(err);
  }
});

evaluationsRouter.put("/stages/:stageId/timer-segments", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { segments } = timerSegmentTemplateSchema.parse(req.body);
    return res.json(
      await evaluations.setTimerSegmentTemplates(req.user!.user_id, req.params.cpiId, req.params.stageId, segments),
    );
  } catch (err) {
    return next(err);
  }
});

evaluationsRouter.post("/stages/:stageId/pooled-share", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = pooledShareSchema.parse(req.body);
    return res.json(await evaluations.setPooledShare(req.user!.user_id, req.params.cpiId, req.params.stageId, input));
  } catch (err) {
    return next(err);
  }
});

evaluationsRouter.get("/stages/:stageId/pooled-share", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await evaluations.listPooledShareDecisions(req.user!.user_id, req.params.cpiId, req.params.stageId));
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
