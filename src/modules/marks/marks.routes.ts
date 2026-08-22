import { Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import * as grades from "./grades.service";
import { gradeBandsSchema, publicationSchema } from "./marks.schemas";
import * as marks from "./marks.service";
import * as publication from "./publication.service";

export const marksRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorOnly = [...authed, requireRole(Role.COURSE_COORDINATOR)];

marksRouter.post("/aggregate", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await marks.aggregateMarks(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// Replaces the old single publish switch: marks and comments are separate, and
// either can be set for one stage or for the whole course, then turned off again.
marksRouter.post("/publish", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = publicationSchema.parse(req.body);
    return res.json(await publication.setPublication(req.user!.user_id, req.params.cpiId, input));
  } catch (err) {
    return next(err);
  }
});

marksRouter.get("/publications", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await publication.listPublications(req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

marksRouter.put("/grade-bands", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { bands } = gradeBandsSchema.parse(req.body);
    return res.json(await grades.setGradeBands(req.user!.user_id, req.params.cpiId, bands));
  } catch (err) {
    return next(err);
  }
});

marksRouter.get("/grade-bands", ...authed, async (req, res, next) => {
  try {
    return res.json(await grades.listGradeBands(req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// The CA sheet. Coordinator only: it lists every student in the course.
marksRouter.get("/sheet", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await marks.getMarkSheet(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// The coordinator sees every group. A student sees their own group, and only
// the stages that have been published.
marksRouter.get("/", ...authed, async (req, res, next) => {
  try {
    return res.json(await marks.getMarks(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
