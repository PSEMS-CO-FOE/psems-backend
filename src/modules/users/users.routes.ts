import { Router } from "express";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireAuth } from "../../middleware/auth";

export const usersRouter = Router();

// A minimal protected route to exercise the full stack (JWT auth -> forced
// password change gate) until real user/profile endpoints land in a later week.
usersRouter.get("/me", requireAuth, blockIfPasswordChangeRequired, (req, res) => {
  res.json({ user: req.user });
});
