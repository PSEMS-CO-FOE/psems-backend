import { CpiPhase, Role } from "@prisma/client";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requirePhase } from "../../middleware/phase";
import { requireRole } from "../../middleware/role";
import * as availability from "./availability.service";
import {
  availabilitySchema,
  availabilityTemplateSchema,
  bulkScheduleSchema,
  presentationDurationSchema,
  scheduleSessionSchema,
  segmentTimelinessSchema,
  timerControlSchema,
} from "./scheduling.schemas";
import * as scheduling from "./scheduling.service";
import * as timer from "./timer.service";

export const schedulingRouter = Router({ mergeParams: true });

const authed = [requireAuth, blockIfPasswordChangeRequired];
const coordinatorOnly = [...authed, requireRole(Role.COURSE_COORDINATOR)];
const inAvailability = requirePhase(CpiPhase.AVAILABILITY_SUBMISSION);

// No phase check: the grid has to exist before anyone can fill it in.
schedulingRouter.put("/availability/template", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = availabilityTemplateSchema.parse(req.body);
    return res.json(await availability.setTemplate(req.user!.user_id, req.params.cpiId, input));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/availability/template", ...authed, async (req, res, next) => {
  try {
    return res.json(await availability.getTemplate(req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/availability/mine", ...authed, async (req, res, next) => {
  try {
    return res.json(await availability.getMyAvailability(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.put("/availability", ...authed, inAvailability, async (req, res, next) => {
  try {
    const { entries } = availabilitySchema.parse(req.body);
    return res.json(await availability.submitAvailability(req.user!.user_id, req.params.cpiId, entries));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/availability", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await availability.listAvailability(req.user!.user_id, req.params.cpiId));
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

// The phase is checked in the service, which keeps scheduling open after the
// availability window closes so a session can still be moved.
schedulingRouter.put("/sessions/:sessionId/schedule", ...coordinatorOnly, async (req, res, next) => {
  try {
    const input = scheduleSessionSchema.parse(req.body);
    return res.json(await scheduling.scheduleSession(req.user!.user_id, req.params.cpiId, req.params.sessionId, input));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.put("/sessions/schedule", ...coordinatorOnly, async (req, res, next) => {
  try {
    const { entries } = bulkScheduleSchema.parse(req.body);
    return res.json(await scheduling.scheduleSessions(req.user!.user_id, req.params.cpiId, entries));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/sessions/:sessionId/alternative-slots", ...coordinatorOnly, async (req, res, next) => {
  try {
    return res.json(await scheduling.getAlternativeSlots(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.get("/schedule-sheet", ...coordinatorOnly, async (req, res, next) => {
  try {
    const stageId = typeof req.query.stageId === "string" ? req.query.stageId : undefined;
    return res.json(await scheduling.getScheduleSheet(req.user!.user_id, req.params.cpiId, stageId));
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

// No phase check here; it is done in the service.
schedulingRouter.get("/sessions/:sessionId/timer", ...authed, async (req, res, next) => {
  try {
    return res.json(await timer.getTimer(req.user!.user_id, req.params.cpiId, req.params.sessionId));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.post("/sessions/:sessionId/timer", ...authed, async (req, res, next) => {
  try {
    const { action } = timerControlSchema.parse(req.body);
    return res.json(await timer.controlTimer(req.user!.user_id, req.params.cpiId, req.params.sessionId, action));
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.post("/sessions/:sessionId/segments/:segmentId/timeliness", ...authed, async (req, res, next) => {
  try {
    const { timeliness } = segmentTimelinessSchema.parse(req.body);
    return res.json(
      await timer.setSegmentTimeliness(
        req.user!.user_id,
        req.params.cpiId,
        req.params.sessionId,
        req.params.segmentId,
        timeliness,
      ),
    );
  } catch (err) {
    return next(err);
  }
});

schedulingRouter.post("/sessions/:sessionId/presentation-duration", ...authed, async (req, res, next) => {
  try {
    const { seconds } = presentationDurationSchema.parse(req.body);
    return res.json(
      await timer.setPresentationDuration(req.user!.user_id, req.params.cpiId, req.params.sessionId, seconds),
    );
  } catch (err) {
    return next(err);
  }
});
