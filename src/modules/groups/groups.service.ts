import { CpiPhase, InvitationStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";

// Resolves the Student profile for a user, or 403 if they aren't a student.
async function loadStudent(userId: string) {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) {
    throw new AuthError(403, "Only a student can perform this action");
  }
  return student;
}

// At most one ACCEPTED group per student per CPI (spec Step 4). Not expressible
// as a Prisma unique constraint, so enforced here on every create/accept.
async function assertNotInAnotherGroup(studentId: string, cpiId: string, exceptGroupId?: string) {
  const existing = await prisma.groupMember.findFirst({
    where: {
      studentId,
      status: InvitationStatus.ACCEPTED,
      group: { courseInstanceId: cpiId },
      ...(exceptGroupId ? { groupId: { not: exceptGroupId } } : {}),
    },
  });
  if (existing) {
    throw new AuthError(409, "You are already a member of a group in this CPI");
  }
}

export async function createGroup(userId: string, cpiId: string, name: string) {
  const student = await loadStudent(userId);

  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) {
    throw new AuthError(404, "CPI not found");
  }
  await assertNotInAnotherGroup(student.id, cpiId);

  // Leader's own membership is ACCEPTED from the start.
  return prisma.group.create({
    data: {
      courseInstanceId: cpiId,
      name,
      leaderStudentId: student.id,
      members: {
        create: { studentId: student.id, status: InvitationStatus.ACCEPTED, joinedAt: new Date() },
      },
    },
    include: { members: { include: { student: memberStudentSelect } } },
  });
}

export async function inviteMember(leaderUserId: string, cpiId: string, groupId: string, inviteeEmail: string) {
  const leader = await loadStudent(leaderUserId);
  const group = await loadGroupInCpi(groupId, cpiId);
  if (group.leaderStudentId !== leader.id) {
    throw new AuthError(403, "Only the group leader can invite members");
  }

  const inviteeUser = await prisma.user.findUnique({
    where: { email: inviteeEmail },
    include: { student: true },
  });
  if (!inviteeUser?.student) {
    throw new AuthError(404, "No student found with that email");
  }
  if (inviteeUser.student.id === leader.id) {
    throw new AuthError(400, "You are already in this group as its leader");
  }
  await assertNotInAnotherGroup(inviteeUser.student.id, cpiId);

  const existing = await prisma.groupMember.findUnique({
    where: { groupId_studentId: { groupId, studentId: inviteeUser.student.id } },
  });
  if (existing && existing.status !== InvitationStatus.DECLINED) {
    throw new AuthError(409, "That student already has a pending or accepted invitation to this group");
  }

  // A previously-declined invite can be re-sent (reset to PENDING).
  if (existing) {
    return prisma.groupMember.update({
      where: { id: existing.id },
      data: { status: InvitationStatus.PENDING, invitedAt: new Date(), joinedAt: null },
    });
  }
  return prisma.groupMember.create({
    data: { groupId, studentId: inviteeUser.student.id, status: InvitationStatus.PENDING },
  });
}

export async function respondToInvite(
  userId: string,
  cpiId: string,
  groupId: string,
  decision: "ACCEPT" | "DECLINE",
) {
  const student = await loadStudent(userId);
  await loadGroupInCpi(groupId, cpiId);

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_studentId: { groupId, studentId: student.id } },
  });
  if (!membership) {
    throw new AuthError(404, "You have no invitation to this group");
  }
  if (membership.status !== InvitationStatus.PENDING) {
    throw new AuthError(409, `Invitation already ${membership.status.toLowerCase()}`);
  }

  if (decision === "DECLINE") {
    return prisma.groupMember.update({
      where: { id: membership.id },
      data: { status: InvitationStatus.DECLINED },
    });
  }

  // Re-check right before accepting — the student may have joined another group
  // since the invite was sent.
  await assertNotInAnotherGroup(student.id, cpiId, groupId);
  return prisma.groupMember.update({
    where: { id: membership.id },
    data: { status: InvitationStatus.ACCEPTED, joinedAt: new Date() },
  });
}

export async function getMyGroup(userId: string, cpiId: string) {
  const student = await loadStudent(userId);
  const membership = await prisma.groupMember.findFirst({
    where: { studentId: student.id, status: InvitationStatus.ACCEPTED, group: { courseInstanceId: cpiId } },
    select: { groupId: true },
  });
  if (!membership) {
    return { group: null, locked: await isRegistrationClosed(cpiId) };
  }
  const group = await groupDetail(membership.groupId);
  return { group, locked: await isRegistrationClosed(cpiId) };
}

export async function getGroup(userId: string, cpiId: string, groupId: string) {
  const group = await loadGroupInCpi(groupId, cpiId);

  // Visible to any member of the group or the CPI's coordinator.
  const [student, cpi] = await Promise.all([
    prisma.student.findUnique({ where: { userId } }),
    prisma.courseInstance.findUnique({ where: { id: cpiId } }),
  ]);
  const isCoordinator = cpi?.createdById === userId;
  const isMember = student
    ? Boolean(
        await prisma.groupMember.findUnique({
          where: { groupId_studentId: { groupId, studentId: student.id } },
        }),
      )
    : false;
  if (!isCoordinator && !isMember) {
    throw new AuthError(403, "You do not have access to this group");
  }

  return { group: await groupDetail(group.id), locked: await isRegistrationClosed(cpiId) };
}

// --- internal helpers ---

const memberStudentSelect = {
  select: { id: true, studentId: true, user: { select: { email: true, fullName: true } } },
} as const;

async function loadGroupInCpi(groupId: string, cpiId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group || group.courseInstanceId !== cpiId) {
    throw new AuthError(404, "Group not found in this CPI");
  }
  return group;
}

async function groupDetail(groupId: string) {
  return prisma.group.findUnique({
    where: { id: groupId },
    include: { members: { include: { student: memberStudentSelect }, orderBy: { invitedAt: "asc" } } },
  });
}

// A group is "locked" once STUDENT_REGISTRATION closes (spec Step 4) — derived
// from the timeline, not a stored flag (phase-gating already blocks mutations).
async function isRegistrationClosed(cpiId: string): Promise<boolean> {
  const window = await prisma.cpiTimeline.findUnique({
    where: { courseInstanceId_phase: { courseInstanceId: cpiId, phase: CpiPhase.STUDENT_REGISTRATION } },
  });
  if (!window) return false;
  return new Date() > window.endDate;
}
