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
