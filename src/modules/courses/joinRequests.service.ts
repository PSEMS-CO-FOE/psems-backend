import { CourseStatus, JoinRequestStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { notify } from "../notifications/notifications.service";
import { loadOwnedCpi } from "./courses.service";

// A student who did not reach the pass mark is repeated, and may take the module
// again with a later batch. They ask; the coordinator decides. It is never
// automatic, and approving IS the access — there is no separate grant.

export async function requestToJoin(userId: string, cpiId: string, reason: string) {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) throw new AuthError(403, "Only a student can ask to join a course");

  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "Course not found");
  if (cpi.status !== CourseStatus.ACTIVE) throw new AuthError(409, "That course is not open");
  if (cpi.department !== student.department) {
    throw new AuthError(403, "That course belongs to another department");
  }
  if (cpi.batch === student.batch) {
    throw new AuthError(409, "That course is already open to your batch");
  }

  // Re-asking after a rejection is allowed — the circumstances may have changed
  // — so an existing row is reopened rather than blocking a second attempt.
  const existing = await prisma.courseJoinRequest.findUnique({
    where: { courseInstanceId_studentId: { courseInstanceId: cpiId, studentId: student.id } },
  });
  if (existing?.status === JoinRequestStatus.APPROVED) {
    throw new AuthError(409, "You have already been added to that course");
  }
  if (existing?.status === JoinRequestStatus.PENDING) {
    throw new AuthError(409, "Your request is already waiting for a decision");
  }

  const request = existing
    ? await prisma.courseJoinRequest.update({
        where: { id: existing.id },
        data: { reason, status: JoinRequestStatus.PENDING, decidedById: null, decidedAt: null },
      })
    : await prisma.courseJoinRequest.create({
        data: { courseInstanceId: cpiId, studentId: student.id, reason },
      });

  await notify(cpi.createdById, {
    type: "COURSE_JOIN_REQUESTED",
    title: "A student asked to join a course",
    body: `${student.studentId} asked to take "${cpi.name}" with ${cpi.batch}.`,
    courseInstanceId: cpiId,
  });

  return request;
}

export async function listJoinRequests(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  return prisma.courseJoinRequest.findMany({
    where: { courseInstanceId: cpiId },
    include: {
      student: {
        select: { id: true, studentId: true, batch: true, user: { select: { fullName: true, email: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function decideJoinRequest(
  coordinatorUserId: string,
  cpiId: string,
  requestId: string,
  approve: boolean,
  note?: string,
) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const request = await prisma.courseJoinRequest.findUnique({
    where: { id: requestId },
    include: { student: true },
  });
  if (!request || request.courseInstanceId !== cpiId) {
    throw new AuthError(404, "Request not found in this course");
  }

  const decided = await prisma.courseJoinRequest.update({
    where: { id: requestId },
    data: {
      status: approve ? JoinRequestStatus.APPROVED : JoinRequestStatus.REJECTED,
      decidedById: coordinatorUserId,
      decidedAt: new Date(),
    },
  });

  await notify(request.student.userId, {
    type: approve ? "COURSE_JOIN_APPROVED" : "COURSE_JOIN_REJECTED",
    title: approve ? "You were added to a course" : "Your request was declined",
    body: approve
      ? `You can now take "${cpi.name}" with ${cpi.batch}.${note ? ` ${note}` : ""}`
      : `Your request to take "${cpi.name}" was declined.${note ? ` ${note}` : ""}`,
    courseInstanceId: cpiId,
    email: true,
  });

  return decided;
}

/**
 * Students the coordinator could add: same department, a different batch from
 * the one this course is open to, and not already on it. A repeated student who
 * does not know to ask would otherwise be unreachable — the request had to come
 * from them, and nothing let the coordinator start it.
 */
export async function listAddableStudents(coordinatorUserId: string, cpiId: string, q?: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const alreadyOn = await prisma.courseJoinRequest.findMany({
    where: { courseInstanceId: cpiId, status: JoinRequestStatus.APPROVED },
    select: { studentId: true },
  });

  const students = await prisma.student.findMany({
    where: {
      department: cpi.department,
      // The course's own batch already sees it; adding them would be a no-op.
      batch: { not: cpi.batch },
      id: { notIn: alreadyOn.map((r) => r.studentId) },
      user: { suspendedAt: null },
      ...(q
        ? {
            OR: [
              { studentId: { contains: q, mode: "insensitive" as const } },
              { registrationNumber: { contains: q, mode: "insensitive" as const } },
              { user: { fullName: { contains: q, mode: "insensitive" as const } } },
              { user: { email: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      studentId: true,
      registrationNumber: true,
      batch: true,
      user: { select: { fullName: true, email: true } },
    },
    orderBy: [{ batch: "desc" }, { studentId: "asc" }],
    take: 50,
  });

  // A request they made themselves and had declined should not look like a
  // fresh candidate with no history.
  const pending = await prisma.courseJoinRequest.findMany({
    where: { courseInstanceId: cpiId, studentId: { in: students.map((s) => s.id) } },
    select: { studentId: true, status: true },
  });
  const stateByStudent = new Map(pending.map((r) => [r.studentId, r.status]));

  return students.map((student) => ({ ...student, existingRequest: stateByStudent.get(student.id) ?? null }));
}

/**
 * The coordinator adding someone directly. Approval has always been the access,
 * so this writes the same approved row their own request would have produced.
 */
export async function addStudent(coordinatorUserId: string, cpiId: string, studentId: string, note?: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw new AuthError(404, "Student not found");
  if (student.department !== cpi.department) {
    throw new AuthError(403, "That student belongs to another department");
  }
  if (student.batch === cpi.batch) {
    throw new AuthError(409, "That course is already open to their batch");
  }

  const reason = note?.trim() || "Added by the coordinator";
  const decision = {
    status: JoinRequestStatus.APPROVED,
    decidedById: coordinatorUserId,
    decidedAt: new Date(),
  };

  const existing = await prisma.courseJoinRequest.findUnique({
    where: { courseInstanceId_studentId: { courseInstanceId: cpiId, studentId } },
  });
  if (existing?.status === JoinRequestStatus.APPROVED) {
    throw new AuthError(409, "That student is already on this course");
  }

  const added = existing
    ? await prisma.courseJoinRequest.update({ where: { id: existing.id }, data: { reason, ...decision } })
    : await prisma.courseJoinRequest.create({
        data: { courseInstanceId: cpiId, studentId, reason, ...decision },
      });

  await notify(student.userId, {
    type: "COURSE_JOIN_APPROVED",
    title: "You were added to a course",
    body: `You can now take "${cpi.name}" with ${cpi.batch}.${note ? ` ${note}` : ""}`,
    courseInstanceId: cpiId,
    email: true,
  });

  return added;
}
