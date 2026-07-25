import bcrypt from "bcrypt";
import { LecturerApprovalStatus, Role } from "@prisma/client";
import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { AuthError } from "../auth/auth.service";
import { assertRole } from "../shared/authorization";
import { RegisterLecturerInput } from "./lecturers.schemas";

const BCRYPT_WORK_FACTOR = 12;

export async function registerLecturer(input: RegisterLecturerInput) {
  if (env.UNIVERSITY_EMAIL_DOMAIN && !input.email.endsWith(`@${env.UNIVERSITY_EMAIL_DOMAIN}`)) {
    throw new AuthError(400, `Registration requires a @${env.UNIVERSITY_EMAIL_DOMAIN} university email`);
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AuthError(409, "An account with this email already exists");
  }

  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_WORK_FACTOR),
      role: Role.LECTURER,
      lecturer: {
        create: { selfRegistered: true }, // approvalStatus defaults to PENDING
      },
    },
    include: { lecturer: true },
  });

  return {
    id: user.lecturer!.id, // lecturer row id — same id the pending list and approve/reject endpoints use
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    approvalStatus: user.lecturer!.approvalStatus,
  };
}

// Approved lecturers, for coordinator assignment pickers (replaces raw
// userId pasting). Returns the userId, since assignment endpoints take
// `lecturerUserId`. Any authenticated coordinator may browse the pool.
export async function listApprovedLecturers() {
  const lecturers = await prisma.lecturer.findMany({
    where: { approvalStatus: LecturerApprovalStatus.APPROVED },
    select: { user: { select: { id: true, email: true, fullName: true } } },
    orderBy: { user: { fullName: "asc" } },
  });
  return lecturers.map((l) => ({
    userId: l.user.id,
    email: l.user.email,
    fullName: l.user.fullName,
  }));
}

export async function listPendingLecturers(actorUserId: string) {
  await assertRole(actorUserId, Role.SYSTEM_ADMIN);
  return prisma.lecturer.findMany({
    where: { approvalStatus: LecturerApprovalStatus.PENDING },
    select: {
      id: true,
      user: { select: { id: true, email: true, fullName: true, createdAt: true } },
    },
    orderBy: { user: { createdAt: "asc" } },
  });
}

export async function decideLecturer(
  actorUserId: string,
  lecturerId: string,
  decision: "APPROVED" | "REJECTED",
) {
  await assertRole(actorUserId, Role.SYSTEM_ADMIN);

  const lecturer = await prisma.lecturer.findUnique({ where: { id: lecturerId } });
  if (!lecturer) {
    throw new AuthError(404, "Lecturer not found");
  }

  const updated = await prisma.lecturer.update({
    where: { id: lecturerId },
    data: { approvalStatus: decision },
    select: { id: true, approvalStatus: true, user: { select: { email: true, fullName: true } } },
  });
  return updated;
}
