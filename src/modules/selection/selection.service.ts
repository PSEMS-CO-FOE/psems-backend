import {
  EoiType,
  Prisma,
  Group,
  IdeaApprovalStatus,
  IdeaAuthorType,
  SelectionStatus,
} from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { notify, notifyMany } from "../notifications/notifications.service";
import { getAcceptedSupervisorLecturerId, loadPolicy } from "../shared/cpiMembership";

async function loadCpi(cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");
  return cpi;
}

// Expression of interest used to be Supervisor-Led only. It is now a policy
// switch, so a coordinator-run course can use it too.
async function assertInterestEnabled(cpiId: string) {
  const policy = await loadPolicy(cpiId);
  if (!policy.interestEnabled) {
    throw new AuthError(409, "Expression of interest is not enabled for this course");
  }
  return policy;
}

async function requireApprovedLecturerId(userId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer || lecturer.approvalStatus !== "APPROVED") {
    throw new AuthError(403, "Only an approved lecturer can perform this action");
  }
  return lecturer.id;
}

async function assertUnderInterestCap(
  policy: { maxInterestsPerGroup: number | null },
  where: { groupId: string; type: EoiType },
) {
  if (policy.maxInterestsPerGroup === null) return;
  const count = await prisma.interestExpression.count({ where: { ...where, withdrawnAt: null } });
  if (count >= policy.maxInterestsPerGroup) {
    throw new AuthError(409, `This course allows interest in at most ${policy.maxInterestsPerGroup} project(s)`);
  }
}

function reviveOrCreateLecturerInterest(cpiId: string, ideaId: string, lecturerId: string, type: EoiType) {
  return prisma.interestExpression.upsert({
    where: { supervisorLecturerId_ideaId_type: { supervisorLecturerId: lecturerId, ideaId, type } },
    update: { withdrawnAt: null },
    create: { courseInstanceId: cpiId, ideaId, type, supervisorLecturerId: lecturerId },
  });
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

// --- EOI: a group is interested in a posted idea ---

// Flat interest, no ranking. A group says "we would like this one" as many times
// as the policy allows; there is no order of preference to honour, which is also
// what makes first-come acceptance fair later.
export async function expressInterest(userId: string, cpiId: string, ideaId: string) {
  await loadCpi(cpiId);
  const policy = await assertInterestEnabled(cpiId);
  const group = await loadLeaderGroup(userId, cpiId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.groupId === group.id) {
    throw new AuthError(400, "That is your own group's idea — use seek-a-supervisor instead");
  }

  const existing = await prisma.interestExpression.findUnique({
    where: { groupId_ideaId_type: { groupId: group.id, ideaId, type: EoiType.GROUP_INTEREST } },
  });
  // Re-expressing after a withdrawal revives the row rather than colliding with
  // it, which is why withdrawal is soft.
  if (existing) {
    if (!existing.withdrawnAt) return existing;
    return prisma.interestExpression.update({ where: { id: existing.id }, data: { withdrawnAt: null } });
  }

  await assertUnderInterestCap(policy, { groupId: group.id, type: EoiType.GROUP_INTEREST });

  return prisma.interestExpression.create({
    data: { courseInstanceId: cpiId, ideaId, type: EoiType.GROUP_INTEREST, groupId: group.id },
  });
}

// --- EOI: a lecturer is interested in a group's idea (the mirror image) ---

export async function expressLecturerInterest(userId: string, cpiId: string, ideaId: string) {
  await loadCpi(cpiId);
  const policy = await assertInterestEnabled(cpiId);
  if (!policy.allowLecturerInterestInGroupIdeas) {
    throw new AuthError(409, "Lecturers may not express interest in group ideas on this course");
  }

  const lecturerId = await requireApprovedLecturerId(userId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorType !== IdeaAuthorType.STUDENT) {
    throw new AuthError(400, "That is not a group-posted idea");
  }

  return reviveOrCreateLecturerInterest(cpiId, ideaId, lecturerId, EoiType.LECTURER_INTEREST);
}

// --- EOI: a lecturer offers to co-supervise someone else's idea ---

export async function expressCoSupervisionInterest(userId: string, cpiId: string, ideaId: string) {
  await loadCpi(cpiId);
  const policy = await assertInterestEnabled(cpiId);
  if (!policy.allowCoSupervisionInterest) {
    throw new AuthError(409, "Co-supervision interest is not enabled on this course");
  }

  const lecturerId = await requireApprovedLecturerId(userId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorUserId === userId) {
    throw new AuthError(400, "That is your own idea");
  }

  return reviveOrCreateLecturerInterest(cpiId, ideaId, lecturerId, EoiType.CO_SUPERVISION_INTEREST);
}

// Withdrawal is soft: the row stays so the audit trail survives and the unique
// pair still holds if the same interest is expressed again. Refused once the
// selection phase closes — the route's phase gate does that, and this guard
// covers the policy switch.
export async function withdrawInterest(userId: string, cpiId: string, ideaId: string, type: EoiType) {
  const policy = await loadPolicy(cpiId);
  if (!policy.allowInterestWithdrawal) {
    throw new AuthError(409, "Interest cannot be withdrawn on this course");
  }

  const where =
    type === EoiType.GROUP_INTEREST || type === EoiType.SEEKING_SUPERVISOR
      ? { groupId: (await loadLeaderGroup(userId, cpiId)).id, ideaId, type }
      : { supervisorLecturerId: await requireApprovedLecturerId(userId), ideaId, type };

  const existing = await prisma.interestExpression.findFirst({ where: { ...where, courseInstanceId: cpiId } });
  if (!existing) throw new AuthError(404, "No such interest to withdraw");
  if (existing.withdrawnAt) return existing;

  return prisma.interestExpression.update({ where: { id: existing.id }, data: { withdrawnAt: new Date() } });
}

// --- EOI: group flags its own idea as seeking a supervisor ---

export async function markSeekingSupervisor(userId: string, cpiId: string, ideaId: string) {
  await loadCpi(cpiId);
  await assertInterestEnabled(cpiId);
  const group = await loadLeaderGroup(userId, cpiId);
  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorType !== IdeaAuthorType.STUDENT || idea.groupId !== group.id) {
    throw new AuthError(400, "You can only seek a supervisor for your own group's idea");
  }

  return prisma.interestExpression.upsert({
    where: { groupId_ideaId_type: { groupId: group.id, ideaId, type: EoiType.SEEKING_SUPERVISOR } },
    update: { withdrawnAt: null },
    create: { courseInstanceId: cpiId, ideaId, type: EoiType.SEEKING_SUPERVISOR, groupId: group.id },
  });
}

// --- EOI: supervisor marks willingness on a student idea ---

export async function markWilling(userId: string, cpiId: string, ideaId: string) {
  await loadCpi(cpiId);
  await assertInterestEnabled(cpiId);
  const lecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
  if (!lecturerId) throw new AuthError(403, "Only an accepted supervisor of this CPI can mark willingness");

  const idea = await loadIdeaInCpi(ideaId, cpiId);
  if (idea.authorType !== IdeaAuthorType.STUDENT) {
    throw new AuthError(400, "Willingness can only be marked on a student idea");
  }
  const seeking = await prisma.interestExpression.findFirst({
    where: { ideaId, type: EoiType.SEEKING_SUPERVISOR, withdrawnAt: null },
  });
  if (!seeking) throw new AuthError(400, "That idea is not seeking a supervisor");

  return prisma.interestExpression.upsert({
    where: { supervisorLecturerId_ideaId_type: { supervisorLecturerId: lecturerId, ideaId, type: EoiType.SUPERVISOR_WILLING } },
    update: { withdrawnAt: null },
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

  // Which supervisor (if any) a selection carries follows from the idea itself,
  // not from the CPI's mode: a supervisor-posted idea brings its author, a
  // group's own idea needs a willing supervisor named, and a coordinator-posted
  // one carries none because the coordinator confirms it.
  const policy = await loadPolicy(cpiId);

  if (idea.authorType === IdeaAuthorType.SUPERVISOR) {
    const authorLecturer = await prisma.lecturer.findUnique({ where: { userId: idea.authorUserId } });
    if (!authorLecturer) throw new AuthError(409, "That idea's author is no longer a lecturer on this system");
    supervisorLecturerId = authorLecturer.id;
  } else if (idea.authorType === IdeaAuthorType.STUDENT) {
    if (idea.groupId !== group.id) {
      throw new AuthError(400, "You may only select a posted idea or your own group's idea");
    }
    if (policy.requireStudentIdeaApproval && idea.approvalStatus !== IdeaApprovalStatus.APPROVED) {
      throw new AuthError(400, "Your group's idea must be approved before it can be selected");
    }
    if (supervisorUserId) {
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
    } else if (policy.selectionConfirmedBy === "SUPERVISOR") {
      throw new AuthError(400, "Selecting your own idea requires choosing a willing supervisor");
    }
  }

  // The "one active selection per group" check and the write have to be one
  // step. Read-then-write let two concurrent selects both pass, which is how a
  // group ended up with two pending selections and two supervisors each able to
  // accept. A partial unique index backs this up at the database level.
  try {
    const selection = await prisma.projectSelection.create({
      data: { courseInstanceId: cpiId, groupId: group.id, ideaId, supervisorLecturerId },
    });

    if (supervisorLecturerId) {
      const supervisor = await prisma.lecturer.findUnique({ where: { id: supervisorLecturerId } });
      if (supervisor) {
        await notify(supervisor.userId, {
          type: "SELECTION_SUBMITTED",
          title: "A group selected your project",
          body: `"${group.name}" selected "${idea.title}" and is waiting for your response.`,
          courseInstanceId: cpiId,
          email: true,
        });
      }
    } else {
      await notify(cpi.createdById, {
        type: "SELECTION_SUBMITTED",
        title: "A group made its project selection",
        body: `"${group.name}" selected "${idea.title}" and is waiting for confirmation.`,
        courseInstanceId: cpiId,
      });
    }

    return selection;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AuthError(409, "Your group already has a selection awaiting a response");
    }
    throw err;
  }
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

  // Who confirms is a policy setting, so a course can require the supervisor,
  // the coordinator, or accept either.
  const policy = await loadPolicy(cpiId);
  const lecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
  const isChosenSupervisor = Boolean(lecturerId) && lecturerId === selection.supervisorLecturerId;
  const isCoordinator = cpi.createdById === userId;

  const allowed =
    policy.selectionConfirmedBy === "SUPERVISOR"
      ? isChosenSupervisor
      : policy.selectionConfirmedBy === "COORDINATOR"
        ? isCoordinator
        : isChosenSupervisor || isCoordinator;
  if (!allowed) {
    throw new AuthError(403, "You are not the confirmer for this selection");
  }

  // Conditional write: only a selection still PENDING is changed. Two people
  // responding at the same moment previously both succeeded, last-write-wins.
  // Now exactly one updates a row and the other is told so.
  const outcome = decision === "ACCEPT" ? SelectionStatus.ACCEPTED : SelectionStatus.DECLINED;
  const changed = await prisma.projectSelection.updateMany({
    where: { id: selectionId, status: SelectionStatus.PENDING },
    data: { status: outcome, respondedAt: new Date() },
  });
  if (changed.count === 0) {
    throw new AuthError(409, "Someone already responded to this selection");
  }

  const updated = await prisma.projectSelection.findUnique({
    where: { id: selectionId },
    include: { group: { select: { id: true, name: true } }, idea: { select: { title: true } } },
  });

  const members = await prisma.groupMember.findMany({
    where: { groupId: selection.groupId, status: "ACCEPTED" },
    include: { student: { select: { userId: true } } },
  });
  await notifyMany(
    members.map((m) => m.student.userId),
    {
      type: decision === "ACCEPT" ? "SELECTION_ACCEPTED" : "SELECTION_DECLINED",
      title: decision === "ACCEPT" ? "Your project was confirmed" : "Your project selection was declined",
      body:
        decision === "ACCEPT"
          ? `"${updated?.idea.title}" is confirmed for your group.`
          : `"${updated?.idea.title}" was declined. You can select another project.`,
      courseInstanceId: cpiId,
      email: true,
    },
  );

  return updated;
}

// A supervisor picks one of the groups that registered interest in their idea.
//
// The other route round — the group formally selects, the supervisor confirms —
// still exists. This one exists because several groups usually want the same
// project, and the choice between them is the supervisor's to make, not
// something the groups should have to race each other to claim.
export async function acceptInterestedGroup(
  userId: string,
  cpiId: string,
  ideaId: string,
  groupId: string,
) {
  await loadCpi(cpiId);
  const lecturerId = await getAcceptedSupervisorLecturerId(userId, cpiId);
  if (!lecturerId) throw new AuthError(403, "Only an accepted supervisor of this CPI can do this");

  const idea = await loadIdeaInCpi(ideaId, cpiId);
  const owns = await prisma.ideaSupervisor.findFirst({
    where: { ideaId, lecturerId, invitationStatus: "ACCEPTED" },
  });
  if (!owns) throw new AuthError(403, "That idea is not yours to award");

  const interest = await prisma.interestExpression.findUnique({
    where: { groupId_ideaId_type: { groupId, ideaId, type: EoiType.GROUP_INTEREST } },
  });
  if (!interest || interest.withdrawnAt) {
    throw new AuthError(409, "That group is not currently interested in this idea");
  }

  // One live selection per group is enforced by a partial unique index, so a
  // group already placed elsewhere is refused rather than silently moved.
  const existing = await prisma.projectSelection.findFirst({
    where: { groupId, status: { not: SelectionStatus.DECLINED } },
    include: { idea: { select: { title: true } } },
  });
  if (existing) {
    throw new AuthError(409, `That group already has "${existing.idea.title}"`);
  }

  const selection = await prisma.projectSelection.create({
    data: {
      courseInstanceId: cpiId,
      groupId,
      ideaId,
      supervisorLecturerId: lecturerId,
      status: SelectionStatus.ACCEPTED,
      respondedAt: new Date(),
    },
    include: { group: { select: { id: true, name: true } }, idea: { select: { title: true } } },
  });

  const members = await prisma.groupMember.findMany({
    where: { groupId, status: "ACCEPTED" },
    include: { student: { select: { userId: true } } },
  });
  await notifyMany(
    members.map((m) => m.student.userId),
    {
      type: "SELECTION_ACCEPTED",
      title: "Your project was confirmed",
      body: `"${idea.title}" is confirmed for your group.`,
      courseInstanceId: cpiId,
      email: true,
    },
  );

  return selection;
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
    // The ideas this lecturer owns or co-supervises — what a group's interest
    // would be aimed at.
    const myIdeas = await prisma.ideaSupervisor.findMany({
      where: { lecturerId, idea: { courseInstanceId: cpiId } },
      select: { ideaId: true },
    });
    const myIdeaIds = myIdeas.map((i) => i.ideaId);

    const [willingByMe, pendingSelections, seeking, interestInMyIdeas] = await Promise.all([
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
      // Groups that registered interest in one of this lecturer's ideas. Without
      // it a supervisor saw nothing until a group made a formal selection, which
      // is the step expressing interest exists to precede.
      myIdeaIds.length
        ? prisma.interestExpression.findMany({
            where: {
              courseInstanceId: cpiId,
              type: EoiType.GROUP_INTEREST,
              ideaId: { in: myIdeaIds },
              withdrawnAt: null,
            },
            include: eoiInclude,
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
    ]);
    // Ideas the supervisor hasn't already marked willing on.
    const willingIdeaIds = new Set(willingByMe.map((w) => w.ideaId));
    const seekingIdeas = seeking
      .filter((s) => !willingIdeaIds.has(s.ideaId))
      .map((s) => ({ ideaId: s.ideaId, idea: s.idea, group: s.group }));
    return { role: "SUPERVISOR", willingByMe, pendingSelections, seekingIdeas, interestInMyIdeas };
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
      orderBy: { createdAt: "asc" },
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
