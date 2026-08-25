import { EoiType, IdeaApprovalStatus, IdeaAuthorType, IdeaVisibility } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notify, notifyMany } from "../notifications/notifications.service";
import {
  getAcceptedSupervisorLecturerId,
  getLeaderGroupId,
  getStudentGroupId,
  loadPolicy,
} from "../shared/cpiMembership";

// Post an idea (spec 3.3 Step 5). Single endpoint that branches on the actor's
// capacity, with each branch enabled by policy rather than by CpiMode — so a
// coordinator-run course can still let supervisors post, and vice versa.
export async function postIdea(userId: string, cpiId: string, title: string, description: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) {
    throw new AuthError(404, "CPI not found");
  }
  const policy = await loadPolicy(cpiId);

  const base = { courseInstanceId: cpiId, authorUserId: userId, title, description };

  if (cpi.createdById === userId) {
    if (!policy.allowCoordinatorIdeas) {
      throw new AuthError(403, "This course does not accept coordinator-posted ideas");
    }
    return prisma.projectIdea.create({
      data: { ...base, authorType: IdeaAuthorType.COORDINATOR, visibility: IdeaVisibility.PUBLIC_TO_STUDENTS },
    });
  }

  const supervisorLecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
  if (supervisorLecturerId) {
    if (!policy.allowSupervisorIdeas) {
      throw new AuthError(403, "This course does not accept supervisor-posted ideas");
    }
    return prisma.projectIdea.create({
      data: {
        ...base,
        authorType: IdeaAuthorType.SUPERVISOR,
        visibility: IdeaVisibility.PUBLIC_TO_STUDENTS,
        // The author is the primary supervisor; co-supervisors are added to this
        // list afterwards and must accept.
        supervisors: { create: { lecturerId: supervisorLecturerId, isPrimary: true, invitationStatus: "ACCEPTED", respondedAt: new Date() } },
      },
      include: ideaInclude,
    });
  }

  // A lecturer who is not (yet) a supervisor on this course may still post, when
  // the course allows it — that is how a lecturer advertises a project before
  // being formally attached to the course.
  if (policy.allowLecturerIdeas) {
    const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
    if (lecturer && lecturer.approvalStatus === "APPROVED") {
      return prisma.projectIdea.create({
        data: {
          ...base,
          authorType: IdeaAuthorType.LECTURER,
          visibility: IdeaVisibility.PUBLIC_TO_STUDENTS,
          supervisors: { create: { lecturerId: lecturer.id, isPrimary: true, invitationStatus: "ACCEPTED", respondedAt: new Date() } },
        },
        include: ideaInclude,
      });
    }
  }

  // A group's idea is posted by its leader, so one member cannot commit the
  // group. When the policy drops that requirement, any accepted member may post.
  const groupId = policy.studentIdeasLeaderOnly
    ? await getLeaderGroupId(userId, cpiId)
    : await getStudentGroupId(userId, cpiId);
  if (groupId) {
    if (!policy.allowStudentIdeas) {
      throw new AuthError(403, "This course does not accept student-posted ideas");
    }
    if (policy.maxIdeasPerGroup !== null) {
      const posted = await prisma.projectIdea.count({ where: { groupId } });
      if (posted >= policy.maxIdeasPerGroup) {
        throw new AuthError(409, `Your group may post at most ${policy.maxIdeasPerGroup} idea(s)`);
      }
    }
    const pendingApproval = policy.requireStudentIdeaApproval;
    const idea = await prisma.projectIdea.create({
      data: {
        ...base,
        authorType: IdeaAuthorType.STUDENT,
        visibility: IdeaVisibility.GROUP_RESTRICTED,
        groupId,
        approvalStatus: pendingApproval ? IdeaApprovalStatus.PENDING : null,
      },
    });

    // A group idea with no supervisor is seeking one by definition, so it says
    // so straight away rather than waiting for a second button nobody finds.
    // The group can withdraw it. An idea still awaiting the coordinator's
    // approval is not advertised yet.
    if (!pendingApproval && policy.interestEnabled) {
      await prisma.interestExpression.upsert({
        where: { groupId_ideaId_type: { groupId, ideaId: idea.id, type: EoiType.SEEKING_SUPERVISOR } },
        update: { withdrawnAt: null },
        create: { courseInstanceId: cpiId, ideaId: idea.id, type: EoiType.SEEKING_SUPERVISOR, groupId },
      });
    }

    return idea;
  }

  if (policy.studentIdeasLeaderOnly && (await getStudentGroupId(userId, cpiId))) {
    throw new AuthError(403, "Only the group leader can post your group's idea");
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
    // A student sees public ideas plus only their OWN group's — unless the
    // course deliberately opens every group's ideas to everyone.
    const policy = await loadPolicy(cpiId);
    where = policy.studentsSeeOtherGroupIdeas
      ? { courseInstanceId: cpiId }
      : {
          courseInstanceId: cpiId,
          OR: [{ visibility: IdeaVisibility.PUBLIC_TO_STUDENTS }, { groupId }],
        };
  }

  return prisma.projectIdea.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: ideaInclude,
  });
}

// Shown on every idea so a group can see who would supervise them — the primary
// plus any co-supervisor who has accepted or is still deciding.
const ideaInclude = {
  author: { select: { id: true, email: true, fullName: true } },
  group: { select: { id: true, name: true } },
  supervisors: {
    include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } },
    orderBy: { isPrimary: "desc" },
  },
} as const;

async function loadIdeaForAuthor(userId: string, cpiId: string, ideaId: string) {
  const idea = await prisma.projectIdea.findUnique({ where: { id: ideaId }, include: { supervisors: true } });
  if (!idea || idea.courseInstanceId !== cpiId) throw new AuthError(404, "Idea not found in this CPI");

  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  const isPrimary = Boolean(
    lecturer && idea.supervisors.some((sup) => sup.lecturerId === lecturer.id && sup.isPrimary),
  );
  if (!isPrimary) throw new AuthError(403, "Only the idea's own supervisor can change its supervisor list");
  return idea;
}

// Name a co-supervisor on an idea. They are invited, not assumed — the invite
// sits PENDING until they accept, and groups see that state.
export async function addIdeaCoSupervisor(userId: string, cpiId: string, ideaId: string, lecturerUserId: string) {
  const policy = await loadPolicy(cpiId);
  if (!policy.allowCoSupervisorOnIdea) {
    throw new AuthError(409, "This course does not allow co-supervisors on ideas");
  }
  const idea = await loadIdeaForAuthor(userId, cpiId, ideaId);

  const invitee = await prisma.lecturer.findUnique({ where: { userId: lecturerUserId } });
  if (!invitee || invitee.approvalStatus !== "APPROVED") {
    throw new AuthError(400, "That lecturer is not approved on this system");
  }
  if (idea.supervisors.some((sup) => sup.lecturerId === invitee.id)) {
    throw new AuthError(409, "That lecturer is already on this idea");
  }

  const created = await prisma.ideaSupervisor.create({
    data: { ideaId, lecturerId: invitee.id },
    include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } },
  });

  await notify(lecturerUserId, {
    type: "CO_SUPERVISOR_INVITED",
    title: "Invitation to co-supervise",
    body: `You have been invited to co-supervise "${idea.title}".`,
    courseInstanceId: cpiId,
    email: true,
  });

  return created;
}

export async function respondToIdeaSupervisorInvite(
  userId: string,
  cpiId: string,
  ideaId: string,
  decision: "ACCEPT" | "DECLINE",
) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) throw new AuthError(403, "Only a lecturer can respond to this invitation");

  const idea = await prisma.projectIdea.findUnique({ where: { id: ideaId } });
  if (!idea || idea.courseInstanceId !== cpiId) throw new AuthError(404, "Idea not found in this CPI");

  const row = await prisma.ideaSupervisor.findUnique({
    where: { ideaId_lecturerId: { ideaId, lecturerId: lecturer.id } },
  });
  if (!row) throw new AuthError(404, "You have not been invited to co-supervise this idea");
  if (row.isPrimary) throw new AuthError(409, "You are this idea's own supervisor");
  if (row.invitationStatus !== "PENDING") {
    throw new AuthError(409, `You already ${row.invitationStatus.toLowerCase()} this invitation`);
  }

  return prisma.ideaSupervisor.update({
    where: { id: row.id },
    data: {
      invitationStatus: decision === "ACCEPT" ? "ACCEPTED" : "DECLINED",
      respondedAt: new Date(),
    },
  });
}

export async function removeIdeaCoSupervisor(userId: string, cpiId: string, ideaId: string, coSupervisorId: string) {
  const idea = await loadIdeaForAuthor(userId, cpiId, ideaId);
  const row = idea.supervisors.find((sup) => sup.id === coSupervisorId);
  if (!row) throw new AuthError(404, "That co-supervisor is not on this idea");
  if (row.isPrimary) throw new AuthError(409, "The idea's own supervisor cannot be removed");

  await prisma.ideaSupervisor.delete({ where: { id: coSupervisorId } });
  return { removed: coSupervisorId };
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

  const policy = await loadPolicy(cpiId);
  return prisma.projectIdea.update({
    where: { id: ideaId },
    data: {
      title,
      description,
      revisionNote: null,
      approvalStatus: policy.requireStudentIdeaApproval ? IdeaApprovalStatus.PENDING : null,
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

// Coordinator accepts/rejects a student idea — only where the policy asks for
// student ideas to be approved.
export async function decideIdea(
  coordinatorUserId: string,
  cpiId: string,
  ideaId: string,
  decision: "APPROVED" | "REJECTED",
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const policy = await loadPolicy(cpiId);
  if (!policy.requireStudentIdeaApproval) {
    throw new AuthError(409, "This course does not require student ideas to be approved");
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
