import { CpiMode, IdeaApprovalStatus, IdeaAuthorType, IdeaVisibility } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { getAcceptedSupervisorLecturerId, getStudentGroupId } from "../shared/cpiMembership";

// Post an idea during Idea Announcement. A single endpoint whose behaviour
// depends on the actor's capacity for THIS CPI (spec 3.3 Step 5):
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

// List ideas with visibility scoped to the requester (spec 3.3 Step 5). This
// query IS the visibility rule — the same student idea is returned to its own
// group and withheld from every other group.
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
