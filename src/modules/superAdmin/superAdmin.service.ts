import { PasswordResetRequestStatus, Prisma, Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { generateTempPassword } from "../shared/tempPassword";
import type { AuditQueryInput, CreateSystemAdminInput, UserSearchInput } from "./superAdmin.schemas";

const BCRYPT_WORK_FACTOR = 12;

const userSummary = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  forcePasswordChange: true,
  suspendedAt: true,
  suspendedReason: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export async function listSystemAdmins() {
  return prisma.user.findMany({
    where: { role: Role.SYSTEM_ADMIN },
    select: userSummary,
    orderBy: { createdAt: "asc" },
  });
}

// Returned once and never stored in the clear, so the caller must capture it.
export async function createSystemAdmin(input: CreateSystemAdminInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AuthError(409, "An account already exists for that email");
  }

  const tempPassword = generateTempPassword();
  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      passwordHash: await bcrypt.hash(tempPassword, BCRYPT_WORK_FACTOR),
      role: Role.SYSTEM_ADMIN,
      forcePasswordChange: true,
    },
    select: userSummary,
  });

  return { user, tempPassword };
}

export async function searchUsers(input: UserSearchInput) {
  const query = input.query;
  return prisma.user.findMany({
    where: {
      ...(input.role ? { role: input.role as Role } : {}),
      ...(query
        ? {
            OR: [
              { email: { contains: query, mode: "insensitive" as const } },
              { fullName: { contains: query, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: userSummary,
    orderBy: [{ role: "asc" }, { email: "asc" }],
    take: input.limit,
  });
}

async function loadTarget(actorId: string, userId: string) {
  // Suspending yourself would lock the last Super Admin out.
  if (actorId === userId) {
    throw new AuthError(400, "A Super Admin cannot act on their own account here");
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: userSummary });
  if (!user) {
    throw new AuthError(404, "User not found");
  }
  return user;
}

export async function suspendUser(actorId: string, userId: string, reason: string) {
  const target = await loadTarget(actorId, userId);
  if (target.suspendedAt) {
    throw new AuthError(409, "That account is already suspended");
  }

  return prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: new Date(), suspendedReason: reason, suspendedById: actorId },
    select: userSummary,
  });
}

export async function reinstateUser(actorId: string, userId: string) {
  const target = await loadTarget(actorId, userId);
  if (!target.suspendedAt) {
    throw new AuthError(409, "That account is not suspended");
  }

  return prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: null, suspendedReason: null, suspendedById: null },
    select: userSummary,
  });
}

// forcePasswordChange makes this a handover, not a password the Super Admin keeps.
export async function resetPassword(actorId: string, userId: string) {
  const user = await loadTarget(actorId, userId);
  const tempPassword = generateTempPassword();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(tempPassword, BCRYPT_WORK_FACTOR), forcePasswordChange: true },
    }),
    // A reset answers any request that asked for it.
    prisma.passwordResetRequest.updateMany({
      where: { userId, status: PasswordResetRequestStatus.PENDING },
      data: { status: PasswordResetRequestStatus.COMPLETED, handledAt: new Date(), handledById: actorId },
    }),
  ]);

  return { user, tempPassword };
}

export async function listPasswordResetRequests(status?: PasswordResetRequestStatus) {
  return prisma.passwordResetRequest.findMany({
    where: status ? { status } : {},
    select: {
      id: true,
      email: true,
      note: true,
      status: true,
      createdAt: true,
      handledAt: true,
      // Null when no account matches, which is the useful signal.
      user: { select: { id: true, email: true, fullName: true, role: true, suspendedAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function dismissPasswordResetRequest(actorId: string, requestId: string) {
  const updated = await prisma.passwordResetRequest.updateMany({
    where: { id: requestId, status: PasswordResetRequestStatus.PENDING },
    data: { status: PasswordResetRequestStatus.DISMISSED, handledAt: new Date(), handledById: actorId },
  });

  if (updated.count === 0) {
    throw new AuthError(409, "That request is no longer open");
  }
}

// Only whether anything at all points at this account.
async function countDependents(userId: string) {
  const [student, lecturer, ideas, panelSeats, reviews, cpis, provisioning] = await Promise.all([
    prisma.student.count({ where: { userId } }),
    prisma.lecturer.count({ where: { userId } }),
    prisma.projectIdea.count({ where: { authorUserId: userId } }),
    prisma.sessionPanelist.count({ where: { userId } }),
    prisma.sessionReview.count({ where: { reviewerUserId: userId } }),
    prisma.courseInstance.count({ where: { createdById: userId } }),
    prisma.provisioningLog.count({ where: { userId } }),
  ]);

  return student + lecturer + ideas + panelSeats + reviews + cpis + provisioning;
}

// Narrow by design: an account with activity carries marks and panel seats, so
// suspension is the answer there. This is for the account created by mistake.
export async function deleteUser(actorId: string, userId: string) {
  await loadTarget(actorId, userId);

  if ((await countDependents(userId)) > 0) {
    throw new AuthError(
      409,
      "This account has activity in the system and cannot be deleted. Suspend it instead — deleting would remove the record of what they did.",
    );
  }

  await prisma.user.delete({ where: { id: userId } });
}

export async function readAuditLog(input: AuditQueryInput) {
  return prisma.auditLog.findMany({
    where: {
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.before ? { createdAt: { lt: input.before } } : {}),
    },
    select: {
      id: true,
      action: true,
      resource: true,
      statusCode: true,
      createdAt: true,
      actor: { select: { id: true, email: true, fullName: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
  });
}
