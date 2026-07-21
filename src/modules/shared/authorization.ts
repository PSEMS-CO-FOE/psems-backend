import { Role, User } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";

// Service-layer RBAC re-check (spec 9.2 defense-in-depth) — re-verifies the
// actor's role independently of route middleware. Returns the loaded user.
export async function assertRole(userId: string, ...allowedRoles: Role[]): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AuthError(401, "User no longer exists");
  }
  if (!allowedRoles.includes(user.role)) {
    throw new AuthError(403, "Insufficient permissions for this action");
  }
  return user;
}
