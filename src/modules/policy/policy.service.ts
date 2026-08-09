import { CpiMode, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import {
  getAcceptedSupervisorLecturerId,
  getCpiEvaluatorId,
  getStudentGroupId,
} from "../shared/cpiMembership";
import { UpdatePolicyInput } from "./policy.schemas";

// A mode is a starting point, not a constraint: it seeds these defaults at
// creation and is never consulted again. Every one of them can be changed
// afterwards, which is how a Coordinator-Managed course can still run
// supervisors, or a Supervisor-Led one let the coordinator post ideas.
export function presetFor(mode: CpiMode | null): Prisma.CpiPolicyCreateWithoutCourseInstanceInput {
  if (mode === CpiMode.COORDINATOR_MANAGED) {
    return {
      allowSupervisorIdeas: false,
      allowCoordinatorIdeas: true,
      requireStudentIdeaApproval: true,
      interestEnabled: false,
      selectionConfirmedBy: "COORDINATOR",
    };
  }
  return {
    allowSupervisorIdeas: true,
    allowCoordinatorIdeas: false,
    requireStudentIdeaApproval: false,
    interestEnabled: true,
    selectionConfirmedBy: "SUPERVISOR",
  };
}

export function createPolicyData(mode: CpiMode | null) {
  return presetFor(mode);
}

export async function getPolicy(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  const participant =
    cpi.createdById === userId ||
    (await getStudentGroupId(userId, cpiId)) !== null ||
    (await getAcceptedSupervisorLecturerId(userId, cpiId)) !== null ||
    (await getCpiEvaluatorId(userId, cpiId)) !== null;
  if (!participant) throw new AuthError(403, "You are not a participant in this CPI");

  const policy = await prisma.cpiPolicy.findUnique({ where: { courseInstanceId: cpiId } });
  if (policy) return policy;

  // A CPI created before the policy engine existed; materialise its preset so
  // the coordinator has something to edit.
  return prisma.cpiPolicy.create({
    data: { courseInstanceId: cpiId, ...createPolicyData(cpi.mode) },
  });
}

export async function updatePolicy(coordinatorUserId: string, cpiId: string, input: UpdatePolicyInput) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  return prisma.cpiPolicy.upsert({
    where: { courseInstanceId: cpiId },
    update: input,
    create: { courseInstanceId: cpiId, ...createPolicyData(cpi.mode), ...input },
  });
}
