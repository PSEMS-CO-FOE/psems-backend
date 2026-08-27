import { Router } from "express";
import { Role } from "@prisma/client";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/role";
import { assignCoordinator, revokeCoordinator } from "./users.service";

export const usersRouter = Router();

usersRouter.get("/me", requireAuth, blockIfPasswordChangeRequired, (req, res) => {
  res.json({ user: req.user });
});

// Undoes an accidental promotion.
usersRouter.post(
  "/:id/revoke-coordinator",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.SYSTEM_ADMIN),
  async (req, res, next) => {
    try {
      return res.json(await revokeCoordinator(req.user!.user_id, req.params.id));
    } catch (err) {
      return next(err);
    }
  },
);

// System Admin promotes an approved lecturer to Course Coordinator (spec 2.2).
usersRouter.post(
  "/:id/assign-coordinator",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.SYSTEM_ADMIN),
  async (req, res, next) => {
    try {
      const updated = await assignCoordinator(req.user!.user_id, req.params.id);
      return res.json(updated);
    } catch (err) {
      return next(err);
    }
  },
);
