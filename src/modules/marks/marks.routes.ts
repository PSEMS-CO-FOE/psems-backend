import { Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import * as marks from "./marks.service";

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

marksRouter.post("/publish", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await marks.publishMarks(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

// Coordinator sees all; a student sees only their group's, and only after publish.
marksRouter.get("/", ...authed, async (req, res, next) => {
  try {
    return res.json(await marks.getMarks(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
