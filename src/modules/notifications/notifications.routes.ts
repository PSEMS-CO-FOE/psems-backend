import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { listMyNotifications, markRead } from "./notifications.service";

export const notificationsRouter = Router();

const authed = [requireAuth, blockIfPasswordChangeRequired];

notificationsRouter.get("/", ...authed, async (req, res, next) => {
  try {
    return res.json(await listMyNotifications(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

notificationsRouter.post("/:id/read", ...authed, async (req, res, next) => {
  try {
    return res.json(await markRead(req.user!.user_id, req.params.id));
  } catch (err) {
    return next(err);
  }
});
