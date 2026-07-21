import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/database";

// Blocks protected routes until a provisioned account changes its temp password.
// The flag is re-checked from the DB, not the JWT (payload stays minimal, spec 9.1).
// Mount after requireAuth.
export async function blockIfPasswordChangeRequired(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.user_id },
    select: { forcePasswordChange: true },
  });

  if (!user) {
    return res.status(401).json({ error: "User no longer exists" });
  }

  if (user.forcePasswordChange) {
    return res.status(403).json({ error: "Password change required before continuing", code: "FORCE_PASSWORD_CHANGE" });
  }

  return next();
}
