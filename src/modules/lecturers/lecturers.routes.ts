import { Router } from "express";
import multer from "multer";
import { Role } from "@prisma/client";
import { requireAuth } from "../../middleware/auth";
import { accountRequestRateLimit } from "../../middleware/rateLimit";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import { bulkProvisionLecturers } from "./lecturerProvisioning.service";
import { registerLecturerSchema } from "./lecturers.schemas";
import {
  decideLecturer,
  listApprovedLecturers,
  listPendingLecturers,
  registerLecturer,
} from "./lecturers.service";

export const lecturersRouter = Router();

// CSV stays in memory — it is small and never needs to touch disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

// Bulk-provision lecturers the same way students are provisioned. These accounts
// are auto-approved (an admin uploaded them) and carry a forced first-login
// password change, which self-registered lecturers never had.
lecturersRouter.post(
  "/bulk-provision",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.SYSTEM_ADMIN),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Attach a CSV file in the 'file' field" });
      return res.status(201).json(await bulkProvisionLecturers(req.user!.user_id, req.file.buffer));
    } catch (err) {
      return next(err);
    }
  },
);

// Public: anyone may apply; the account stays PENDING (login blocked) until
// a System Admin approves it.
lecturersRouter.post("/register", accountRequestRateLimit, async (req, res, next) => {
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
// name; the System Admin uses it to promote a lecturer to Course Coordinator.
lecturersRouter.get(
  "/approved",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.COURSE_COORDINATOR, Role.SYSTEM_ADMIN),
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
