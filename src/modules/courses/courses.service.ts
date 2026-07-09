import {
  CourseInstance,
  CpiMode,
  CpiPhase,
  InvitationStatus,
  LecturerApprovalStatus,
  Role,
} from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { assertRole } from "../shared/authorization";
import { CreateCpiInput, SetTimelineInput } from "./courses.schemas";

// Canonical phase order (spec 3.3 Step 2). Used to validate that a submitted
// timeline is complete and chronologically sane.
const PHASE_ORDER: CpiPhase[] = [
  CpiPhase.STUDENT_REGISTRATION,
  CpiPhase.SUPERVISOR_ADDITION,
  CpiPhase.IDEA_ANNOUNCEMENT,
  CpiPhase.PROJECT_SELECTION,
  CpiPhase.PROJECT_REGISTRATION,
  CpiPhase.EVALUATION_CONFIG,
  CpiPhase.PROPOSAL_SUBMISSION,
  CpiPhase.AVAILABILITY_SUBMISSION,
  CpiPhase.EVALUATION_EXECUTION,
  CpiPhase.FINAL_SUBMISSION,
];

export async function createCpi(coordinatorUserId: string, input: CreateCpiInput) {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  return prisma.courseInstance.create({
    data: {
      name: input.name,
      projectType: input.projectType,
      participationMode: input.participationMode,
      department: input.department,
      academicYear: input.academicYear,
      createdById: coordinatorUserId,
      // mode stays null until Step 3 determines it.
    },
  });
}

export async function listOwnedCpis(coordinatorUserId: string) {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  return prisma.courseInstance.findMany({
    where: { createdById: coordinatorUserId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getCpiDetail(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  return prisma.courseInstance.findUnique({
    where: { id: cpiId },
    include: {
      timeline: { orderBy: { startDate: "asc" } },
      supervisors: { include: { lecturer: { include: { user: { select: { email: true, fullName: true } } } } } },
      evaluators: { include: { lecturer: { include: { user: { select: { email: true, fullName: true } } } } } },
    },
  });
}

export async function setTimeline(coordinatorUserId: string, cpiId: string, input: SetTimelineInput) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  validateTimeline(input);

  // Replace-all: clear any existing phase rows and insert the new set in one
  // transaction, so the timeline is never left half-updated.
  await prisma.$transaction([
    prisma.cpiTimeline.deleteMany({ where: { courseInstanceId: cpiId } }),
    prisma.cpiTimeline.createMany({
      data: input.phases.map((p) => ({
        courseInstanceId: cpiId,
        phase: p.phase,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
    }),
  ]);

  return prisma.cpiTimeline.findMany({
    where: { courseInstanceId: cpiId },
    orderBy: { startDate: "asc" },
  });
}

export async function inviteSupervisor(coordinatorUserId: string, cpiId: string, lecturerUserId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  if (cpi.mode === CpiMode.COORDINATOR_MANAGED) {
    throw new AuthError(409, "This CPI was finalized as Coordinator-Managed; supervisors cannot be added");
  }

  const lecturer = await loadApprovedLecturer(lecturerUserId);

  const existing = await prisma.cpiSupervisor.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (existing) {
    throw new AuthError(409, "This lecturer has already been invited as a supervisor for this CPI");
  }

  // Inviting the first supervisor is what flips the mode (spec 3.2) — there is
  // no manual toggle. Both writes share a transaction so mode and membership
  // never disagree.
  const [supervisor] = await prisma.$transaction([
    prisma.cpiSupervisor.create({
      data: { courseInstanceId: cpiId, lecturerId: lecturer.id },
    }),
    prisma.courseInstance.update({
      where: { id: cpiId },
      data: { mode: CpiMode.SUPERVISOR_LED },
    }),
  ]);

  return supervisor;
}

export async function respondToSupervisorInvite(
  lecturerUserId: string,
  cpiId: string,
  decision: "ACCEPT" | "DECLINE",
) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId: lecturerUserId } });
  if (!lecturer) {
    throw new AuthError(403, "Only the invited lecturer can respond to this invitation");
  }

  const invite = await prisma.cpiSupervisor.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (!invite) {
    throw new AuthError(404, "No supervisor invitation found for you on this CPI");
  }
  if (invite.invitationStatus !== InvitationStatus.PENDING) {
    throw new AuthError(409, `Invitation already ${invite.invitationStatus.toLowerCase()}`);
  }

  return prisma.cpiSupervisor.update({
    where: { id: invite.id },
    data: {
      invitationStatus: decision === "ACCEPT" ? InvitationStatus.ACCEPTED : InvitationStatus.DECLINED,
      respondedAt: new Date(),
    },
  });
}

export async function finalizeCoordinatorManaged(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  if (cpi.mode === CpiMode.SUPERVISOR_LED) {
    throw new AuthError(409, "This CPI is Supervisor-Led (supervisors were already added)");
  }

  const supervisorCount = await prisma.cpiSupervisor.count({ where: { courseInstanceId: cpiId } });
  if (supervisorCount > 0) {
    throw new AuthError(409, "Remove invited supervisors before finalizing as Coordinator-Managed");
  }

  return prisma.courseInstance.update({
    where: { id: cpiId },
    data: { mode: CpiMode.COORDINATOR_MANAGED },
  });
}

export async function assignEvaluator(coordinatorUserId: string, cpiId: string, lecturerUserId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const lecturer = await loadApprovedLecturer(lecturerUserId);

  const existing = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (existing) {
    throw new AuthError(409, "This lecturer is already an evaluator for this CPI");
  }

  // Evaluators exist in both modes — evaluation happens regardless of whether
  // the CPI is supervisor-led. No mode change here.
  return prisma.cpiEvaluator.create({
    data: { courseInstanceId: cpiId, lecturerId: lecturer.id },
  });
}

export async function setHeadJudge(coordinatorUserId: string, cpiId: string, lecturerUserId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const lecturer = await loadApprovedLecturer(lecturerUserId);

  const evaluator = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (!evaluator) {
    throw new AuthError(400, "Head Judge must be assigned from the evaluator pool — assign as evaluator first");
  }

  // Exactly one Head Judge per CPI: demote any current holder and promote the
  // target in one transaction (spec 3.3 Step 3).
  await prisma.$transaction([
    prisma.cpiEvaluator.updateMany({
      where: { courseInstanceId: cpiId, isHeadJudge: true },
      data: { isHeadJudge: false },
    }),
    prisma.cpiEvaluator.update({ where: { id: evaluator.id }, data: { isHeadJudge: true } }),
  ]);

  return prisma.cpiEvaluator.findUnique({ where: { id: evaluator.id } });
}

// --- internal helpers ---

// CPI-scope enforcement (spec 9.2 DB layer): a coordinator may only touch CPIs
// they own. 404 for non-existent, 403 for someone else's.
async function loadOwnedCpi(coordinatorUserId: string, cpiId: string): Promise<CourseInstance> {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) {
    throw new AuthError(404, "CPI not found");
  }
  if (cpi.createdById !== coordinatorUserId) {
    throw new AuthError(403, "You do not have access to this CPI");
  }
  return cpi;
}

async function loadApprovedLecturer(lecturerUserId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId: lecturerUserId } });
  if (!lecturer) {
    throw new AuthError(404, "No lecturer profile found for that user");
  }
  if (lecturer.approvalStatus !== LecturerApprovalStatus.APPROVED) {
    throw new AuthError(400, "Lecturer must be approved before being assigned to a CPI");
  }
  return lecturer;
}

function validateTimeline(input: SetTimelineInput) {
  const seen = new Set(input.phases.map((p) => p.phase));
  if (seen.size !== PHASE_ORDER.length) {
    throw new AuthError(400, "Timeline must define each of the 10 phases exactly once");
  }
  for (const p of input.phases) {
    if (p.startDate >= p.endDate) {
      throw new AuthError(400, `${p.phase}: startDate must be before endDate`);
    }
  }
  // Starts must be non-decreasing in canonical phase order — catches an
  // out-of-sequence timeline (e.g. selection scheduled before registration).
  const byPhase = new Map(input.phases.map((p) => [p.phase, p]));
  for (let i = 1; i < PHASE_ORDER.length; i++) {
    const prev = byPhase.get(PHASE_ORDER[i - 1])!;
    const curr = byPhase.get(PHASE_ORDER[i])!;
    if (curr.startDate < prev.startDate) {
      throw new AuthError(400, `${PHASE_ORDER[i]} cannot start before ${PHASE_ORDER[i - 1]}`);
    }
  }
}
