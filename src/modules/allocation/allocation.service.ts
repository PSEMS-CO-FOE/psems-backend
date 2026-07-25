import { AllocationSource, CourseInstance, SelectionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";
import { getAcceptedSupervisorLecturerId } from "../shared/cpiMembership";

function assertNotFinalized(cpi: CourseInstance) {
  if (cpi.allocationsFinalizedAt) {
    throw new AuthError(409, "Allocations are finalized and locked for this CPI");
  }
}

const allocationInclude = {
  group: { select: { id: true, name: true } },
  idea: { select: { id: true, title: true, authorType: true } },
  supervisor: { include: { user: { select: { email: true, fullName: true } } } },
} as const;

// Seed draft allocations from every group's ACCEPTED selection (spec 3.3
// Step 7). Existing allocations (e.g. coordinator overrides) are left as-is.
export async function generateAllocations(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  assertNotFinalized(cpi);

  const accepted = await prisma.projectSelection.findMany({
    where: { courseInstanceId: cpiId, status: SelectionStatus.ACCEPTED },
  });

  let created = 0;
  for (const sel of accepted) {
    const existing = await prisma.projectAllocation.findUnique({ where: { groupId: sel.groupId } });
    if (existing) continue;
    await prisma.projectAllocation.create({
      data: {
        courseInstanceId: cpiId,
        groupId: sel.groupId,
        ideaId: sel.ideaId,
        supervisorLecturerId: sel.supervisorLecturerId,
        source: AllocationSource.FROM_SELECTION,
      },
    });
    created++;
  }

  return { created, ...(await getAllocationMap(coordinatorUserId, cpiId)) };
}

// The full allocation map plus any groups still unmatched (spec: coordinator
// resolves unmatched groups before finalizing).
export async function getAllocationMap(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const [allocations, groups, ideas, supervisors] = await Promise.all([
    prisma.projectAllocation.findMany({ where: { courseInstanceId: cpiId }, include: allocationInclude }),
    prisma.group.findMany({ where: { courseInstanceId: cpiId }, select: { id: true, name: true } }),
    // All ideas in the CPI — feeds the coordinator's override picker (no UUIDs).
    prisma.projectIdea.findMany({
      where: { courseInstanceId: cpiId },
      select: { id: true, title: true, authorType: true },
      orderBy: { createdAt: "asc" },
    }),
    // Accepted supervisors, keyed by userId, for the override supervisor picker.
    prisma.cpiSupervisor.findMany({
      where: { courseInstanceId: cpiId, invitationStatus: "ACCEPTED" },
      include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } },
    }),
  ]);

  const allocatedGroupIds = new Set(allocations.map((a) => a.groupId));
  const unmatchedGroups = groups.filter((g) => !allocatedGroupIds.has(g.id));

  // Supervisor-Led (spec Step 7): also surface supervisor ideas that no group
  // was allocated, so the coordinator can resolve both sides.
  const allocatedIdeaIds = new Set(allocations.map((a) => a.ideaId));
  const unmatchedSupervisorIdeas =
    cpi.mode === "SUPERVISOR_LED"
      ? ideas.filter((i) => i.authorType === "SUPERVISOR" && !allocatedIdeaIds.has(i.id)).map((i) => ({ id: i.id, title: i.title }))
      : [];

  return {
    finalized: Boolean(cpi.allocationsFinalizedAt),
    allocations,
    unmatchedGroups,
    unmatchedSupervisorIdeas,
    ideas,
    supervisors: supervisors.map((s) => ({
      userId: s.lecturer.user.id,
      email: s.lecturer.user.email,
      fullName: s.lecturer.user.fullName,
    })),
  };
}

// Coordinator override: set/replace a group's project (and supervisor). Works
// in either mode and can resolve an unmatched group (spec 3.3 Step 7).
export async function overrideAllocation(
  coordinatorUserId: string,
  cpiId: string,
  groupId: string,
  ideaId: string,
  supervisorUserId?: string,
) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  assertNotFinalized(cpi);

  const [group, idea] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId } }),
    prisma.projectIdea.findUnique({ where: { id: ideaId } }),
  ]);
  if (!group || group.courseInstanceId !== cpiId) throw new AuthError(404, "Group not found in this CPI");
  if (!idea || idea.courseInstanceId !== cpiId) throw new AuthError(404, "Idea not found in this CPI");

  let supervisorLecturerId: string | null = null;
  if (supervisorUserId) {
    supervisorLecturerId = await getAcceptedSupervisorLecturerId(supervisorUserId, cpiId);
    if (!supervisorLecturerId) throw new AuthError(400, "That supervisor is not an accepted supervisor of this CPI");
  }

  return prisma.projectAllocation.upsert({
    where: { groupId },
    update: { ideaId, supervisorLecturerId, source: AllocationSource.COORDINATOR_OVERRIDE },
    create: {
      courseInstanceId: cpiId,
      groupId,
      ideaId,
      supervisorLecturerId,
      source: AllocationSource.COORDINATOR_OVERRIDE,
    },
  });
}

// Coordinator-Managed per-pairing confirmation (spec 3.3 Step 7: the
// coordinator "reviews all pairings and confirms or reassigns"). Distinct from
// Supervisor-Led, where pairings already carry a mutual student↔supervisor
// confirmation from selection and need no separate review. Confirming is
// recorded by promoting source to COORDINATOR_OVERRIDE (reviewed); reassigning
// via overrideAllocation does the same, so both paths satisfy finalize's gate.
export async function confirmAllocation(coordinatorUserId: string, cpiId: string, groupId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  assertNotFinalized(cpi);
  if (cpi.mode !== "COORDINATOR_MANAGED") {
    throw new AuthError(409, "Per-pairing confirmation applies only in Coordinator-Managed mode");
  }

  const allocation = await prisma.projectAllocation.findUnique({ where: { groupId } });
  if (!allocation || allocation.courseInstanceId !== cpiId) {
    throw new AuthError(404, "No allocation for that group in this CPI");
  }

  return prisma.projectAllocation.update({
    where: { groupId },
    data: { source: AllocationSource.COORDINATOR_OVERRIDE },
  });
}

// Lock all allocations for the CPI (spec 3.3 Step 7: "all allocations locked").
export async function finalizeAllocations(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  assertNotFinalized(cpi);

  // Coordinator-Managed requires every pairing to have been explicitly reviewed
  // (confirmed or reassigned) before locking — the mode's distinct workflow.
  // Supervisor-Led carries selection-time mutual confirmation, so no extra gate.
  if (cpi.mode === "COORDINATOR_MANAGED") {
    const unreviewed = await prisma.projectAllocation.findMany({
      where: { courseInstanceId: cpiId, source: AllocationSource.FROM_SELECTION },
      include: { group: { select: { id: true, name: true } } },
    });
    if (unreviewed.length > 0) {
      throw new AuthError(
        409,
        `Confirm or reassign every pairing first — ${unreviewed.length} unreviewed (e.g. "${unreviewed[0].group.name}")`,
      );
    }
  }
  const updated = await prisma.courseInstance.update({
    where: { id: cpiId },
    data: { allocationsFinalizedAt: new Date() },
    select: { id: true, allocationsFinalizedAt: true },
  });

  // Notify every allocated group's members and their supervisor (spec Step 7).
  const allocations = await prisma.projectAllocation.findMany({
    where: { courseInstanceId: cpiId },
    include: {
      group: { include: { members: { where: { status: "ACCEPTED" }, include: { student: true } } } },
      supervisor: true,
    },
  });
  const recipients: string[] = [];
  for (const a of allocations) {
    recipients.push(...a.group.members.map((m) => m.student.userId));
    if (a.supervisor) recipients.push(a.supervisor.userId);
  }
  await notifyMany(recipients, {
    type: "ALLOCATION_FINALIZED",
    title: "Project allocation finalized",
    body: `Project allocations for "${cpi.name}" are final.`,
    courseInstanceId: cpiId,
  });

  return updated;
}
