import { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";

// Middleware-layer half of RBAC defense-in-depth (spec 9.2). Service-layer
// re-checks are added per-module as CPI-scoped write endpoints are built.
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions for this action" });
    }

    return next();
  };
}
