import {
  CpiMode,
  EoiType,
  Group,
  IdeaApprovalStatus,
  IdeaAuthorType,
  SelectionStatus,
} from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { getAcceptedSupervisorLecturerId } from "../shared/cpiMembership";

async function loadCpi(cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");
  return cpi;
}

// Group-level selection actions are driven by the group leader.
async function loadLeaderGroup(userId: string, cpiId: string): Promise<Group> {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) throw new AuthError(403, "Only a student can perform this action");
  const membership = await prisma.groupMember.findFirst({
    where: { studentId: student.id, status: "ACCEPTED", group: { courseInstanceId: cpiId } },
    include: { group: true },
  });
  if (!membership) throw new AuthError(403, "You are not in a group in this CPI");
  if (membership.group.leaderStudentId !== student.id) {
    throw new AuthError(403, "Only the group leader can perform selection actions");
  }
  return membership.group;
}

async function loadIdeaInCpi(ideaId: string, cpiId: string) {
  const idea = await prisma.projectIdea.findUnique({ where: { id: ideaId } });
  if (!idea || idea.courseInstanceId !== cpiId) throw new AuthError(404, "Idea not found in this CPI");
  return idea;
}

// --- EOI: ranked interest (group -> supervisor idea) ---

export async function expressInterest(userId: string, cpiId: string, ideaId: string, rank: number) {
  const cpi = await loadCpi(cpiId);
  if (cpi.mode !== CpiMode.SUPERVISOR_LED) {
    throw new AuthError(409, "Ranked interest applies only in Supervisor-Led mode");
  }
  const group = await loadLeaderGroup(userId, cpiId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorType !== IdeaAuthorType.SUPERVISOR) {
    throw new AuthError(400, "Ranked interest can only target supervisor-posted ideas");
  }

  const existingForIdea = await prisma.interestExpression.findUnique({
    where: { groupId_ideaId_type: { groupId: group.id, ideaId, type: EoiType.GROUP_INTEREST } },
  });

  // rank must be unique within the group (no two projects at the same rank).
  const rankClash = await prisma.interestExpression.findFirst({
    where: { groupId: group.id, type: EoiType.GROUP_INTEREST, rank, ideaId: { not: ideaId } },
  });
  if (rankClash) throw new AuthError(409, `Your group already ranked another project #${rank}`);

  if (existingForIdea) {
    return prisma.interestExpression.update({ where: { id: existingForIdea.id }, data: { rank } });
  }

  const count = await prisma.interestExpression.count({
    where: { groupId: group.id, type: EoiType.GROUP_INTEREST },
  });
  if (count >= 3) throw new AuthError(409, "A group may express interest in at most 3 projects");

  return prisma.interestExpression.create({
    data: { courseInstanceId: cpiId, ideaId, type: EoiType.GROUP_INTEREST, groupId: group.id, rank },
  });
}

// --- EOI: group flags its own idea as seeking a supervisor ---

export async function markSeekingSupervisor(userId: string, cpiId: string, ideaId: string) {
  const cpi = await loadCpi(cpiId);
  if (cpi.mode !== CpiMode.SUPERVISOR_LED) {
    throw new AuthError(409, "Seeking a supervisor applies only in Supervisor-Led mode");
  }
  const group = await loadLeaderGroup(userId, cpiId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorType !== IdeaAuthorType.STUDENT || idea.groupId !== group.id) {
    throw new AuthError(400, "You can only seek a supervisor for your own group's idea");
  }

  return prisma.interestExpression.upsert({
    where: { groupId_ideaId_type: { groupId: group.id, ideaId, type: EoiType.SEEKING_SUPERVISOR } },
    update: {},
    create: { courseInstanceId: cpiId, ideaId, type: EoiType.SEEKING_SUPERVISOR, groupId: group.id },
  });
}

// --- EOI: supervisor marks willingness on a student idea ---

export async function markWilling(userId: string, cpiId: string, ideaId: string) {
  const cpi = await loadCpi(cpiId);
  if (cpi.mode !== CpiMode.SUPERVISOR_LED) {
    throw new AuthError(409, "Willing-to-supervise applies only in Supervisor-Led mode");
  }
  const lecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
  if (!lecturerId) throw new AuthError(403, "Only an accepted supervisor of this CPI can mark willingness");

  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorType !== IdeaAuthorType.STUDENT) {
    throw new AuthError(400, "Willingness can only be marked on a student idea");
  }
  const seeking = await prisma.interestExpression.findFirst({
    where: { ideaId, type: EoiType.SEEKING_SUPERVISOR },
  });
  if (!seeking) throw new AuthError(400, "That idea is not seeking a supervisor");

  return prisma.interestExpression.upsert({
    where: { supervisorLecturerId_ideaId_type: { supervisorLecturerId: lecturerId, ideaId, type: EoiType.SUPERVISOR_WILLING } },
    update: {},
    create: { courseInstanceId: cpiId, ideaId, type: EoiType.SUPERVISOR_WILLING, supervisorLecturerId: lecturerId },
  });
}

// --- Mutual confirmation: group makes final selection ---

export async function selectProject(
  userId: string,
  cpiId: string,
  ideaId: string,
  supervisorUserId?: string,
) {
  const cpi = await loadCpi(cpiId);
  const group = await loadLeaderGroup(userId, cpiId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);

  // One active selection per group: block if already matched or awaiting a response.
  const active = await prisma.projectSelection.findFirst({
    where: { groupId: group.id, status: { in: [SelectionStatus.PENDING, SelectionStatus.ACCEPTED] } },
  });
  if (active) {
    const msg =
      active.status === SelectionStatus.ACCEPTED
        ? "Your group already has a confirmed project"
        : "Your group already has a pending selection awaiting a response";
    throw new AuthError(409, msg);
  }

  let supervisorLecturerId: string | null = null;

  if (cpi.mode === CpiMode.SUPERVISOR_LED) {
    if (idea.authorType === IdeaAuthorType.SUPERVISOR) {
      // The idea's author is the supervisor who must accept.
      const authorLecturer = await prisma.lecturer.findUnique({ where: { userId: idea.authorUserId } });
      supervisorLecturerId = authorLecturer!.id;
    } else if (idea.authorType === IdeaAuthorType.STUDENT && idea.groupId === group.id) {
      // Own idea: the group picks one WILLING supervisor (conflict resolution).
      if (!supervisorUserId) {
        throw new AuthError(400, "Selecting your own idea requires choosing a willing supervisor");
      }
      const chosen = await prisma.lecturer.findUnique({ where: { userId: supervisorUserId } });
      if (!chosen) throw new AuthError(404, "Chosen supervisor not found");
      const willing = await prisma.interestExpression.findUnique({
        where: {
          supervisorLecturerId_ideaId_type: {
            supervisorLecturerId: chosen.id,
            ideaId,
            type: EoiType.SUPERVISOR_WILLING,
          },
        },
      });
      if (!willing) throw new AuthError(400, "That supervisor has not marked willingness for your idea");
      supervisorLecturerId = chosen.id;
    } else {
      throw new AuthError(400, "You may only select a supervisor-posted idea or your own group's idea");
    }
  } else {
    // Coordinator-Managed: a coordinator-posted idea, or the group's own
    // APPROVED idea. The coordinator (not a supervisor) confirms.
    const ownApproved =
      idea.authorType === IdeaAuthorType.STUDENT &&
      idea.groupId === group.id &&
      idea.approvalStatus === IdeaApprovalStatus.APPROVED;
    if (idea.authorType !== IdeaAuthorType.COORDINATOR && !ownApproved) {
      throw new AuthError(400, "Select a coordinator-posted idea or your own approved idea");
    }
  }

  return prisma.projectSelection.create({
    data: { courseInstanceId: cpiId, groupId: group.id, ideaId, supervisorLecturerId },
  });
}

export async function respondToSelection(
  userId: string,
  cpiId: string,
  selectionId: string,
  decision: "ACCEPT" | "DECLINE",
) {
  const cpi = await loadCpi(cpiId);
  const selection = await prisma.projectSelection.findUnique({ where: { id: selectionId } });
  if (!selection || selection.courseInstanceId !== cpiId) {
    throw new AuthError(404, "Selection not found in this CPI");
  }
  if (selection.status !== SelectionStatus.PENDING) {
    throw new AuthError(409, `Selection already ${selection.status.toLowerCase()}`);
  }

  // Who confirms depends on mode: the chosen supervisor, or the coordinator.
  if (cpi.mode === CpiMode.SUPERVISOR_LED) {
    const lecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
    if (!lecturerId || lecturerId !== selection.supervisorLecturerId) {
      throw new AuthError(403, "Only the selected supervisor can respond to this selection");
    }
  } else if (cpi.createdById !== userId) {
    throw new AuthError(403, "Only the coordinator can confirm selections in Coordinator-Managed mode");
  }

  return prisma.projectSelection.update({
    where: { id: selectionId },
    data: {
      status: decision === "ACCEPT" ? SelectionStatus.ACCEPTED : SelectionStatus.DECLINED,
      respondedAt: new Date(),
    },
  });
}

// Scoped view of the selection state for the requester.
export async function getSelectionState(userId: string, cpiId: string) {
  const cpi = await loadCpi(cpiId);

  // Coordinator (owner): full map.
  if (cpi.createdById === userId) {
    const [selections, interest] = await Promise.all([
      prisma.projectSelection.findMany({ where: { courseInstanceId: cpiId }, include: selectionInclude }),
      prisma.interestExpression.findMany({ where: { courseInstanceId: cpiId }, include: eoiInclude }),
    ]);
    return { role: "COORDINATOR", selections, interestExpressions: interest };
  }

  // Supervisor: what they marked willing + selections addressed to them +
  // student ideas seeking a supervisor they could still mark willing on.
  const lecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
  if (lecturerId) {
    const [willingByMe, pendingSelections, seeking] = await Promise.all([
      prisma.interestExpression.findMany({
        where: { courseInstanceId: cpiId, supervisorLecturerId: lecturerId, type: EoiType.SUPERVISOR_WILLING },
        include: eoiInclude,
      }),
      prisma.projectSelection.findMany({
        where: { courseInstanceId: cpiId, supervisorLecturerId: lecturerId, status: SelectionStatus.PENDING },
        include: selectionInclude,
      }),
      prisma.interestExpression.findMany({
        where: { courseInstanceId: cpiId, type: EoiType.SEEKING_SUPERVISOR },
        include: eoiInclude,
      }),
    ]);
    // Ideas the supervisor hasn't already marked willing on.
    const willingIdeaIds = new Set(willingByMe.map((w) => w.ideaId));
    const seekingIdeas = seeking
      .filter((s) => !willingIdeaIds.has(s.ideaId))
      .map((s) => ({ ideaId: s.ideaId, idea: s.idea, group: s.group }));
    return { role: "SUPERVISOR", willingByMe, pendingSelections, seekingIdeas };
  }

  // Student: their group's interest, incoming willingness, and current selection.
  const student = await prisma.student.findUnique({ where: { userId } });
  const membership = student
    ? await prisma.groupMember.findFirst({
        where: { studentId: student.id, status: "ACCEPTED", group: { courseInstanceId: cpiId } },
        select: { groupId: true },
      })
    : null;
  if (!membership) throw new AuthError(403, "You are not a participant in this CPI");

  const groupIdeaIds = (
    await prisma.projectIdea.findMany({ where: { groupId: membership.groupId }, select: { id: true } })
  ).map((i) => i.id);

  const [groupInterest, willingSupervisors, selection] = await Promise.all([
    prisma.interestExpression.findMany({
      where: { groupId: membership.groupId },
      include: eoiInclude,
      orderBy: { rank: "asc" },
    }),
    // Supervisors who marked willing on this group's own ideas.
    prisma.interestExpression.findMany({
      where: { type: EoiType.SUPERVISOR_WILLING, ideaId: { in: groupIdeaIds } },
      include: eoiInclude,
    }),
    prisma.projectSelection.findFirst({
      where: { groupId: membership.groupId },
      include: selectionInclude,
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return { role: "STUDENT", groupInterest, willingSupervisors, selection };
}

const eoiInclude = {
  idea: { select: { id: true, title: true, authorType: true } },
  group: { select: { id: true, name: true } },
  supervisor: { include: { user: { select: { id: true, email: true, fullName: true } } } },
} as const;

const selectionInclude = {
  idea: { select: { id: true, title: true, authorType: true } },
  group: { select: { id: true, name: true } },
  supervisor: { include: { user: { select: { id: true, email: true, fullName: true } } } },
} as const;
