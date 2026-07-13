import { AllocationSource, CourseInstance, SelectionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
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

  const [allocations, groups] = await Promise.all([
    prisma.projectAllocation.findMany({ where: { courseInstanceId: cpiId }, include: allocationInclude }),
    prisma.group.findMany({ where: { courseInstanceId: cpiId }, select: { id: true, name: true } }),
  ]);

  const allocatedGroupIds = new Set(allocations.map((a) => a.groupId));
  const unmatchedGroups = groups.filter((g) => !allocatedGroupIds.has(g.id));

  return { finalized: Boolean(cpi.allocationsFinalizedAt), allocations, unmatchedGroups };
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

// Lock all allocations for the CPI (spec 3.3 Step 7: "all allocations locked").
export async function finalizeAllocations(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  assertNotFinalized(cpi);
  return prisma.courseInstance.update({
    where: { id: cpiId },
    data: { allocationsFinalizedAt: new Date() },
    select: { id: true, allocationsFinalizedAt: true },
  });
}
