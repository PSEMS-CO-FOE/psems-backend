import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import { availabilitySchema, scheduleSessionSchema } from "./scheduling.schemas";
import * as scheduling from "./scheduling.service";

export const schedulingRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorOnly = [...authed, requireRole(Role.COURSE_COORDINATOR)];
const inAvailability = requirePhase(CpiPhase.AVAILABILITY_SUBMISSION);

schedulingRouter.post("/availability", ...authed, inAvailability, async (req, res, next) => {
  try {
    const { slotStart, slotEnd } = availabilitySchema.parse(req.body);
    return res.status(201).json(await scheduling.submitAvailability(req.user!.user_id, req.params.cpiId, slotStart, slotEnd));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/availability", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await scheduling.listAvailability(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.post("/sessions/generate", ...coordinatorOnly, inAvailability, async (req, res, next) => {
  try {
    return res.status(201).json(await scheduling.generateSessions(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.put("/sessions/:sessionId/schedule", ...coordinatorOnly, inAvailability, async (req, res, next) => {
  try {
    const { scheduledStart, scheduledEnd } = scheduleSessionSchema.parse(req.body);
    return res.json(
      await scheduling.scheduleSession(req.user!.user_id, req.params.cpiId, req.params.sessionId, scheduledStart, scheduledEnd),
    );
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/sessions", ...authed, async (req, res, next) => {
  try {
    return res.json(await scheduling.listSessions(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
