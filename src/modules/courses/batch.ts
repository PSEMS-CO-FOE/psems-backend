import { CourseStatus, CpiPhase, JoinRequestStatus } from "@prisma/client";
import { prisma } from "../../config/database";

// A batch is the intake a student belongs to, e.g. 22ENG. It is fixed for life,
// unlike year of study, and it is what decides which courses a student sees.
//
// Typed by hand, so it is normalised on the way in. "22ENG", "22eng" and
// "22 ENG" would otherwise split one batch into three, and students would
// quietly stop seeing their course.
export function normalizeBatch(value: string): string {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

// Courses a student may act in: their own batch's active ones, anything they
// already joined, and anything they were approved to join late.
export async function accessibleCourseFilter(studentId: string, batch: string, department: string) {
  const [memberships, approvals] = await Promise.all([
    prisma.groupMember.findMany({
      where: { studentId },
      select: { group: { select: { courseInstanceId: true } } },
    }),
    prisma.courseJoinRequest.findMany({
      where: { studentId, status: JoinRequestStatus.APPROVED },
      select: { courseInstanceId: true },
    }),
  ]);

  return {
    OR: [
      // Joined courses stay visible whatever their state or batch — this is how
      // a student keeps seeing the courses they have already taken.
      { id: { in: memberships.map((m) => m.group.courseInstanceId) } },
      { id: { in: approvals.map((a) => a.courseInstanceId) } },
      { status: CourseStatus.ACTIVE, department, batch },
    ],
  };
}

// The only phases an approved late joiner may act outside. They still have to
// catch up on the two steps that close early — forming a group and choosing a
// project — but submission and evaluation windows apply to them exactly as they
// do to everyone else on the course.
export const LATE_JOINER_PHASES: CpiPhase[] = [
  CpiPhase.STUDENT_REGISTRATION,
  CpiPhase.PROJECT_SELECTION,
];

// Whether this student may act in this course at all. Used by the phase-gate
// lift, so it deliberately counts an approved late joiner.
export async function hasApprovedJoinRequest(studentId: string, cpiId: string): Promise<boolean> {
  const approval = await prisma.courseJoinRequest.findUnique({
    where: { courseInstanceId_studentId: { courseInstanceId: cpiId, studentId } },
    select: { status: true },
  });
  return approval?.status === JoinRequestStatus.APPROVED;
}
