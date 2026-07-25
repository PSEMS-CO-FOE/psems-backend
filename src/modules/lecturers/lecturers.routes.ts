import { Router } from "express";
import { Role } from "@prisma/client";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import { registerLecturerSchema } from "./lecturers.schemas";
import {
  decideLecturer,
  listApprovedLecturers,
  listPendingLecturers,
  registerLecturer,
} from "./lecturers.service";

export const lecturersRouter = Router();

// Public: anyone may apply; the account stays PENDING (login blocked) until
// a System Admin approves it.
lecturersRouter.post("/register", async (req, res, next) => {
  try {
    const input = registerLecturerSchema.parse(req.body);
    const result = await registerLecturer(input);
    return res.status(201).json({
      message: "Registration received — you can log in once a System Admin approves your account",
      lecturer: result,
    });
  } catch (err) {
    return next(err);
  }
});

// Coordinators browse the approved pool to pick supervisors/evaluators/HJ by
// name instead of pasting a raw userId.
lecturersRouter.get(
  "/approved",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.COURSE_COORDINATOR),
  async (_req, res, next) => {
    try {
      return res.json(await listApprovedLecturers());
    } catch (err) {
      return next(err);
    }
  },
);

const adminOnly = [requireAuth, blockIfPasswordChangeRequired, requireRole(Role.SYSTEM_ADMIN)];

lecturersRouter.get("/pending", ...adminOnly, async (req, res, next) => {
  try {
    return res.json(await listPendingLecturers(req.user!.user_id));
  } catch (err) {
    return next(err);
  }
});

lecturersRouter.post("/:id/approve", ...adminOnly, async (req, res, next) => {
  try {
    return res.json(await decideLecturer(req.user!.user_id, req.params.id, "APPROVED"));
  } catch (err) {
    return next(err);
  }
});

lecturersRouter.post("/:id/reject", ...adminOnly, async (req, res, next) => {
  try {
    return res.json(await decideLecturer(req.user!.user_id, req.params.id, "REJECTED"));
  } catch (err) {
    return next(err);
  }
});
