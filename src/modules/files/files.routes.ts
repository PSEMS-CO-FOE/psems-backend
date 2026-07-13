import { Role } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/auth";
import { blockIfPasswordChangeRequired } from "../../middleware/forcePasswordChange";
import { requireRole } from "../../middleware/role";
import * as files from "./files.service";

// mergeParams so :cpiId from the mount path reaches the handlers.
export const filesRouter = Router({ mergeParams: true });

// Proposals are held in memory then handed to the storage backend; 20MB cap.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const authed = [requireAuth, blockIfPasswordChangeRequired];

// Not hard phase-gated — the service enforces a SOFT deadline (accept + flag late).
filesRouter.post(
  "/stages/:stageId/submission",
  ...authed,
  requireRole(Role.STUDENT),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "A file is required (multipart field 'file')" });
      const result = await files.submitProposal(req.user!.user_id, req.params.cpiId, req.params.stageId, {
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      });
      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

filesRouter.get("/submissions", ...authed, async (req, res, next) => {
  try {
    return res.json(await files.listSubmissions(req.user!.user_id, req.params.cpiId));
  } catch (err) {
    return next(err);
  }
});
