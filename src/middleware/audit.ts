import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/database";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Records every write operation to the append-only audit_logs table
// (spec 9.x / roadmap non-negotiable #4). Mounted globally in app.ts so no
// route can silently opt out. The insert runs on res "finish" — after the
// response is already sent — so auditing never adds latency, and it captures
// the real outcome status (a rejected 403 attempt is evidence too).
export function auditLogger(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) {
    return next();
  }

  res.on("finish", () => {
    // Hash, never store, the body: audit rows must not contain passwords/PII.
    const payloadHash =
      req.body && Object.keys(req.body).length > 0
        ? crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex")
        : null;

    prisma.auditLog
      .create({
        data: {
          actorId: req.user?.user_id ?? null,
          // Route pattern (e.g. "POST /lecturers/:id/approve") when available;
          // req.baseUrl resets to "" once an error unwinds to the app-level
          // handler, so fall back to req.path (full path at app level) then.
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
