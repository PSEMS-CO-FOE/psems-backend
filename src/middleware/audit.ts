import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/database";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Logs every write to the append-only audit_logs table (roadmap non-negotiable).
// Runs on res "finish" so it adds no latency and records the real outcome status
// (a rejected 403 is evidence too).
export function auditLogger(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) {
    return next();
  }

  res.on("finish", () => {
    // Hash, never store, the body — audit rows must not contain passwords/PII.
    const payloadHash =
      req.body && Object.keys(req.body).length > 0
        ? crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex")
        : null;

    prisma.auditLog
      .create({
        data: {
          actorId: req.user?.user_id ?? null,
          // Route pattern (e.g. "POST /lecturers/:id/approve"); baseUrl is "" once
          // an error unwinds to the app handler, so fall back to req.path.
          action: `${req.method} ${req.route?.path && req.baseUrl ? req.baseUrl + req.route.path : req.path}`,
          resource: req.originalUrl,
          payloadHash,
          statusCode: res.statusCode,
        },
      })
      .catch((err) => {
        // Never fail the request because auditing failed — but be loud about it.
        console.error("AUDIT LOG WRITE FAILED", err);
      });
  });

  next();
}
