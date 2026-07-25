import { CpiMode, IdeaApprovalStatus, IdeaAuthorType, IdeaVisibility } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";
import { getAcceptedSupervisorLecturerId, getStudentGroupId } from "../shared/cpiMembership";

// Post an idea (spec 3.3 Step 5). Single endpoint that branches on the actor's
// capacity for this CPI:
//   coordinator-owner (Coordinator-Managed) -> public coordinator idea
//   accepted supervisor (Supervisor-Led)    -> public supervisor idea
//   student in an accepted group            -> group-restricted student idea
export async function postIdea(userId: string, cpiId: string, title: string, description: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) {
    throw new AuthError(404, "CPI not found");
  }

  const base = { courseInstanceId: cpiId, authorUserId: userId, title, description };

  // 1. Coordinator posts directly — only in Coordinator-Managed mode.
  if (cpi.createdById === userId) {
    if (cpi.mode !== CpiMode.COORDINATOR_MANAGED) {
      throw new AuthError(403, "In Supervisor-Led mode, supervisors post ideas — not the coordinator");
    }
    return prisma.projectIdea.create({
      data: { ...base, authorType: IdeaAuthorType.COORDINATOR, visibility: IdeaVisibility.PUBLIC_TO_STUDENTS },
    });
  }

  // 2. Supervisor posts — only in Supervisor-Led mode.
  if (await getAcceptedSupervisorLecturerId(userId, cpiId)) {
    if (cpi.mode !== CpiMode.SUPERVISOR_LED) {
      throw new AuthError(403, "Supervisor ideas are only posted in Supervisor-Led mode");
    }
    return prisma.projectIdea.create({
      data: { ...base, authorType: IdeaAuthorType.SUPERVISOR, visibility: IdeaVisibility.PUBLIC_TO_STUDENTS },
    });
  }

  // 3. Student posts on behalf of their group — both modes. In Coordinator-
  // Managed the coordinator must then approve it (starts PENDING).
  const groupId = await getStudentGroupId(userId, cpiId);
  if (groupId) {
    return prisma.projectIdea.create({
      data: {
        ...base,
        authorType: IdeaAuthorType.STUDENT,
        visibility: IdeaVisibility.GROUP_RESTRICTED,
        groupId,
        approvalStatus: cpi.mode === CpiMode.COORDINATOR_MANAGED ? IdeaApprovalStatus.PENDING : null,
      },
    });
  }

  throw new AuthError(403, "You are not eligible to post ideas in this CPI");
}

// List ideas scoped to the requester (spec 3.3 Step 5). This query IS the
// visibility rule — a student idea reaches its own group and no other.
export async function listIdeas(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) {
    throw new AuthError(404, "CPI not found");
  }

  const privileged = cpi.createdById === userId || (await getAcceptedSupervisorLecturerId(userId, cpiId));
  let where;
  if (privileged) {
    // Coordinator and supervisors see everything in the CPI.
    where = { courseInstanceId: cpiId };
  } else {
    const groupId = await getStudentGroupId(userId, cpiId);
    if (!groupId) {
      throw new AuthError(403, "You are not a participant in this CPI");
    }
    // A student sees public ideas plus only their OWN group's ideas.
    where = {
      courseInstanceId: cpiId,
      OR: [{ visibility: IdeaVisibility.PUBLIC_TO_STUDENTS }, { groupId }],
    };
  }

  return prisma.projectIdea.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      author: { select: { email: true, fullName: true } },
      group: { select: { id: true, name: true } },
    },
  });
}

// A student edits their group's own idea and resubmits it. Allowed while the
// idea hasn't been approved/rejected; resubmitting clears any revision request
// and, in Coordinator-Managed, returns the idea to PENDING for re-review.
export async function updateIdea(userId: string, cpiId: string, ideaId: string, title: string, description: string) {
  const groupId = await getStudentGroupId(userId, cpiId);
  if (!groupId) throw new AuthError(403, "Only a group member can edit an idea");

  const idea = await prisma.projectIdea.findUnique({ where: { id: ideaId } });
  if (!idea || idea.courseInstanceId !== cpiId) throw new AuthError(404, "Idea not found in this CPI");
  if (idea.authorType !== IdeaAuthorType.STUDENT || idea.groupId !== groupId) {
    throw new AuthError(403, "You can only edit your own group's idea");
  }
  if (idea.approvalStatus === IdeaApprovalStatus.APPROVED || idea.approvalStatus === IdeaApprovalStatus.REJECTED) {
    throw new AuthError(409, `This idea is already ${idea.approvalStatus.toLowerCase()} and can't be edited`);
  }

  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  return prisma.projectIdea.update({
    where: { id: ideaId },
    data: {
      title,
      description,
      revisionNote: null,
      approvalStatus: cpi!.mode === CpiMode.COORDINATOR_MANAGED ? IdeaApprovalStatus.PENDING : null,
    },
  });
}

// A coordinator or an accepted supervisor asks a group to revise their idea,
// with a note. The group can then edit and resubmit within the posting phase.
export async function requestIdeaRevision(userId: string, cpiId: string, ideaId: string, note: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  const isCoordinator = cpi.createdById === userId;
  const isSupervisor = Boolean(await getAcceptedSupervisorLecturerId(userId, cpiId));
  if (!isCoordinator && !isSupervisor) {
    throw new AuthError(403, "Only the coordinator or a supervisor can request a revision");
  }

  const idea = await prisma.projectIdea.findUnique({ where: { id: ideaId } });
  if (!idea || idea.courseInstanceId !== cpiId) throw new AuthError(404, "Idea not found in this CPI");
  if (idea.authorType !== IdeaAuthorType.STUDENT) throw new AuthError(400, "Only student ideas can be sent back for revision");

  const updated = await prisma.projectIdea.update({
    where: { id: ideaId },
    data: { approvalStatus: IdeaApprovalStatus.REVISION_REQUESTED, revisionNote: note },
  });

  if (idea.groupId) {
    const members = await prisma.groupMember.findMany({
      where: { groupId: idea.groupId, status: "ACCEPTED" },
      include: { student: true },
    });
    await notifyMany(
      members.map((m) => m.student.userId),
      {
        type: "IDEA_REVISION_REQUESTED",
        title: "Idea revision requested",
        body: `Your idea "${idea.title}" needs changes: ${note}`,
        courseInstanceId: cpiId,
      },
    );
  }

  return updated;
}

// Coordinator accepts/rejects a student idea — Coordinator-Managed only.
export async function decideIdea(
  coordinatorUserId: string,
  cpiId: string,
  ideaId: string,
  decision: "APPROVED" | "REJECTED",
) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  if (cpi.mode !== CpiMode.COORDINATOR_MANAGED) {
    throw new AuthError(409, "Idea approval only applies in Coordinator-Managed mode");
  }

  const idea = await prisma.projectIdea.findUnique({ where: { id: ideaId } });
  if (!idea || idea.courseInstanceId !== cpiId) {
    throw new AuthError(404, "Idea not found in this CPI");
  }
  if (idea.authorType !== IdeaAuthorType.STUDENT) {
    throw new AuthError(400, "Only student ideas require approval");
  }
  if (idea.approvalStatus !== IdeaApprovalStatus.PENDING) {
    throw new AuthError(409, `Idea already ${idea.approvalStatus?.toLowerCase()}`);
  }

  return prisma.projectIdea.update({
    where: { id: ideaId },
    data: { approvalStatus: IdeaApprovalStatus[decision] },
  });
}
