import { LecturerApprovalStatus, Role } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { assertRole } from "../shared/authorization";

// Spec 2.1/2.2: a Course Coordinator is an APPROVED lecturer promoted by the
// System Admin. We only flip the account-level role — the lecturer profile row
// stays, so their approval history and any future re-demotion remain intact.
export async function assignCoordinator(actorUserId: string, targetUserId: string) {
  await assertRole(actorUserId, Role.SYSTEM_ADMIN);

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { lecturer: true },
  });
  if (!target) {
    throw new AuthError(404, "User not found");
  }
  if (!target.lecturer || target.lecturer.approvalStatus !== LecturerApprovalStatus.APPROVED) {
    throw new AuthError(400, "Only an approved lecturer can be made a Course Coordinator");
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { role: Role.COURSE_COORDINATOR },
    select: { id: true, email: true, fullName: true, role: true },
  });
  return updated;
}
