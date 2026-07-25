import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import {
  getAcceptedSupervisorLecturerId,
  getCpiEvaluatorId,
  getStudentGroupId,
} from "../shared/cpiMembership";
import { EvaluationConfigInput } from "./evaluations.schemas";

function validateWeights(input: EvaluationConfigInput) {
  const stageSum = input.stages.reduce((s, st) => s + st.weight, 0);
  if (stageSum !== 100) {
    throw new AuthError(400, `Stage weights must sum to 100 (got ${stageSum})`);
  }
  for (const stage of input.stages) {
    const critSum = stage.criteria.reduce((s, c) => s + c.weight, 0);
    if (critSum !== 100) {
      throw new AuthError(400, `Criteria weights in "${stage.name}" must sum to 100 (got ${critSum})`);
    }
  }
}

// Define the whole evaluation config at once (spec 3.3 Step 8). Replace-all and
// weight-validated; blocked once submissions exist (replacing stages would
// cascade-delete them).
export async function setEvaluationConfig(coordinatorUserId: string, cpiId: string, input: EvaluationConfigInput) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  validateWeights(input);

  const submissionCount = await prisma.submission.count({ where: { courseInstanceId: cpiId } });
  if (submissionCount > 0) {
    throw new AuthError(409, "Cannot reconfigure evaluation after submissions have been made");
  }

  await prisma.$transaction([
    prisma.evaluationStage.deleteMany({ where: { courseInstanceId: cpiId } }),
    ...input.stages.map((stage, i) =>
      prisma.evaluationStage.create({
        data: {
          courseInstanceId: cpiId,
          name: stage.name,
          weight: stage.weight,
          evaluatorsRequired: stage.evaluatorsRequired,
          submissionRequired: stage.submissionRequired,
          submissionWindowStart: stage.submissionWindowStart,
          submissionWindowEnd: stage.submissionWindowEnd,
          executionWindowStart: stage.executionWindowStart,
          executionWindowEnd: stage.executionWindowEnd,
          orderIndex: i,
          criteria: {
            create: stage.criteria.map((c, ci) => ({
              name: c.name,
              description: c.description,
              weight: c.weight,
              maxScore: c.maxScore,
              orderIndex: ci,
            })),
          },
        },
      }),
    ),
  ]);

  return getEvaluationConfig(coordinatorUserId, cpiId);
}

// Assign a CPI-pool evaluator to a specific stage (spec 3.3 Step 8).
export async function assignStageEvaluator(
  coordinatorUserId: string,
  cpiId: string,
  stageId: string,
  lecturerUserId: string,
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const stage = await prisma.evaluationStage.findUnique({ where: { id: stageId } });
  if (!stage || stage.courseInstanceId !== cpiId) throw new AuthError(404, "Stage not found in this CPI");

  const cpiEvaluatorId = await getCpiEvaluatorId(lecturerUserId, cpiId);
  if (!cpiEvaluatorId) throw new AuthError(400, "That lecturer is not in this CPI's evaluator pool");

  const existing = await prisma.stageEvaluator.findUnique({
    where: { evaluationStageId_cpiEvaluatorId: { evaluationStageId: stageId, cpiEvaluatorId } },
  });
  if (existing) throw new AuthError(409, "That evaluator is already assigned to this stage");

  return prisma.stageEvaluator.create({ data: { evaluationStageId: stageId, cpiEvaluatorId } });
}

// Read the config. Visible to the coordinator and any CPI participant (students
// should be able to see the rubric they'll be judged against).
export async function getEvaluationConfig(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  const participant =
    cpi.createdById === userId ||
    (await getStudentGroupId(userId, cpiId)) !== null ||
    (await getAcceptedSupervisorLecturerId(userId, cpiId)) !== null ||
    (await getCpiEvaluatorId(userId, cpiId)) !== null;
  if (!participant) throw new AuthError(403, "You are not a participant in this CPI");

  return prisma.evaluationStage.findMany({
    where: { courseInstanceId: cpiId },
    orderBy: { orderIndex: "asc" },
    include: {
      criteria: { orderBy: { orderIndex: "asc" } },
      evaluators: {
        include: {
          cpiEvaluator: {
            include: { lecturer: { include: { user: { select: { email: true, fullName: true } } } } },
          },
        },
      },
    },
  });
}
