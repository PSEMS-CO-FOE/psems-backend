import { AllocationSource, CourseInstance, CpiPhase, SelectionStatus } from "@prisma/client";
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

// Pairings open with PROJECT_REGISTRATION and never close with it. A supervisor
// goes on leave in week 10 and the group has to be moved; a route-level phase
// gate made that a hard 403 long after the only legitimate moment had passed.
// Same reasoning as scheduling, where the gate moved into the service for the
// same reason. The finalize lock is the real protection here, not the calendar.
async function assertAllocationOpen(cpiId: string) {
  const window = await prisma.cpiTimeline.findUnique({
    where: { courseInstanceId_phase: { courseInstanceId: cpiId, phase: CpiPhase.PROJECT_REGISTRATION } },
  });
  if (!window) throw new AuthError(403, "The project registration phase has not been scheduled for this CPI");
  if (new Date() < window.startDate) {
    throw new AuthError(403, `Allocation opens at ${window.startDate.toISOString()}`);
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

  // One insert with skipDuplicates instead of a read-then-create loop: the loop
  // raced against itself and against coordinator overrides, and a duplicate
  // group surfaced as an unmapped unique violation — an HTTP 500 rather than a
  // conflict. Existing allocations (e.g. overrides) are left untouched.
  const { count: created } = await prisma.projectAllocation.createMany({
    data: accepted.map((sel) => ({
      courseInstanceId: cpiId,
      groupId: sel.groupId,
      ideaId: sel.ideaId,
      supervisorLecturerId: sel.supervisorLecturerId,
      source: AllocationSource.FROM_SELECTION,
    })),
    skipDuplicates: true,
  });

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
  await assertAllocationOpen(cpiId);
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
  await assertAllocationOpen(cpiId);
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

// Unlock allocations so a pairing can be changed after the fact. A supervisor
// going on leave mid-semester is ordinary, and until this existed the only
// answer was a 409 — the lock had no way out at all.
//
// The cut-off mirrors the evaluation reopen rule: finalizing is not the point of
// no return, aggregation is. Once any mark exists for this course, the pairing
// that produced it has to stand.
export async function reopenAllocations(coordinatorUserId: string, cpiId: string, reason: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  if (!cpi.allocationsFinalizedAt) {
    throw new AuthError(409, "Allocations are not locked");
  }

  const aggregated = await prisma.finalMark.findFirst({
    where: { group: { courseInstanceId: cpiId } },
    select: { id: true },
  });
  if (aggregated) {
    throw new AuthError(409, "Marks have been aggregated for this course — allocations can no longer be reopened");
  }

  // Conditional, so two coordinators clicking at once cannot both reopen.
  const unlocked = await prisma.courseInstance.updateMany({
    where: { id: cpiId, allocationsFinalizedAt: { not: null } },
    data: { allocationsFinalizedAt: null },
  });
  if (unlocked.count === 0) {
    throw new AuthError(409, "Allocations are not locked");
  }

  // The reason is kept on the audit trail the write middleware already records;
  // nobody is notified here, because nothing has changed yet. Re-finalizing
  // notifies every affected group and supervisor, as it always did.
  return { id: cpiId, allocationsFinalizedAt: null, reason };
}

// Lock all allocations for the CPI (spec 3.3 Step 7: "all allocations locked").
export async function finalizeAllocations(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  await assertAllocationOpen(cpiId);
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
  // Conditional write: only finalize a course that is still open, so two
  // coordinators clicking at once cannot both "finalize" and both notify.
  const locked = await prisma.courseInstance.updateMany({
    where: { id: cpiId, allocationsFinalizedAt: null },
    data: { allocationsFinalizedAt: new Date() },
  });
  if (locked.count === 0) {
    throw new AuthError(409, "Allocations were already finalized");
  }

  const updated = await prisma.courseInstance.findUniqueOrThrow({
    where: { id: cpiId },
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
