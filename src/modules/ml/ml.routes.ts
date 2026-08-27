import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { analyzeSubmissionSchema, ideaTextSchema } from "./ml.schemas";
import * as mlService from "./ml.service";

export const mlRouter = Router();

const authed = [requireAuth, blockIfPasswordChangeRequired];

// Draft-time assistance: the caller supplies text they are still composing, so
// these read nothing from the database and leak nothing between groups.
mlRouter.post("/supervisor-suggestions", ...authed, async (req, res, next) => {
  try {
    const { title, description, k } = ideaTextSchema.parse(req.body);
    return res.json(await mlService.suggestSupervisors(title, description, k ?? 3));
  } catch (err) {
    return next(err);
  }
});

mlRouter.post("/similarity-preview", ...authed, async (req, res, next) => {
  try {
    const { title, description } = ideaTextSchema.parse(req.body);
    return res.json(await mlService.previewSimilarity(title, description));
  } catch (err) {
    return next(err);
  }
});

mlRouter.post("/proposal-analysis", ...authed, async (req, res, next) => {
  try {
    const { cpiId, submissionId } = analyzeSubmissionSchema.parse(req.body);
    return res.json(await mlService.analyzeSubmission(req.user!.user_id, cpiId, submissionId));
  } catch (err) {
    return next(err);
  }
});

mlRouter.get("/status", ...authed, async (_req, res, next) => {
  try {
    return res.json(await mlService.serviceStatus());
  } catch (err) {
    return next(err);
  }
});
