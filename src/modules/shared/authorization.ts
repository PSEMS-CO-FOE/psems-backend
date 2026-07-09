import { Role, User } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";

// Service-layer RBAC re-check (spec 9.2 defense in depth). Route middleware
// already guards these, but every write re-loads the actor and re-verifies —
// so a bypassed or misconfigured middleware can't turn into a privilege
// escalation. Returns the loaded user for callers that need it.
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
