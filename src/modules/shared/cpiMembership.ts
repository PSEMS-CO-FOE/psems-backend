import { InvitationStatus } from "@prisma/client";
import { prisma } from "../../config/database";

// Shared "what is this user, relative to this CPI" lookups. Used wherever an
// action's authorization depends on CPI-scoped membership (ideas, selection)
// rather than the coarse account role. Return null instead of throwing so
// callers can branch on capacity.

// The id of the student's ACCEPTED group in this CPI, or null.
export async function getStudentGroupId(userId: string, cpiId: string): Promise<string | null> {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) return null;
  const membership = await prisma.groupMember.findFirst({
    where: { studentId: student.id, status: InvitationStatus.ACCEPTED, group: { courseInstanceId: cpiId } },
    select: { groupId: true },
  });
  return membership?.groupId ?? null;
}

// The Lecturer id if this user is an ACCEPTED supervisor of this CPI, or null.
export async function getAcceptedSupervisorLecturerId(userId: string, cpiId: string): Promise<string | null> {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) return null;
  const supervisor = await prisma.cpiSupervisor.findFirst({
    where: { courseInstanceId: cpiId, lecturerId: lecturer.id, invitationStatus: InvitationStatus.ACCEPTED },
  });
  return supervisor ? lecturer.id : null;
}
