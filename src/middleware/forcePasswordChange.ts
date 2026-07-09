import { NextFunction, Request, Response } from "express";
import { prisma } from "../config/database";

// Blocks access to every protected route until a provisioned account (e.g. a
// bulk-created student) has changed its temporary password. The flag is
// intentionally NOT embedded in the JWT (token payload stays minimal per spec
// 9.1), so this re-checks the DB. Mount after requireAuth, before route logic.
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
