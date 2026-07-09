import { Router } from "express";
import multer from "multer";
import { Role } from "@prisma/client";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import { bulkProvisionStudents, getBatchStatus } from "./provisioning.service";

export const studentsRouter = Router();

// CSVs are small (a 200-student cohort is ~15KB); 1MB cap stops abuse while
// keeping the file entirely in memory — it never touches disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

studentsRouter.post(
  "/bulk-provision",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.SYSTEM_ADMIN),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "CSV file is required (multipart field name: 'file')" });
      }
      const result = await bulkProvisionStudents(req.user!.user_id, req.file.buffer);
      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

studentsRouter.get(
  "/provisioning/:batchId",
  requireAuth,
  blockIfPasswordChangeRequired,
  requireRole(Role.SYSTEM_ADMIN),
  async (req, res, next) => {
    try {
      return res.json(await getBatchStatus(req.params.batchId));
    } catch (err) {
      return next(err);
    }
  },
);
