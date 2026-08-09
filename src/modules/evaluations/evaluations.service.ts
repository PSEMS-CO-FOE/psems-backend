import { MarkCounting, PanelRole } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import {
  getAcceptedSupervisorLecturerId,
  getCpiEvaluatorId,
  getStudentGroupId,
} from "../shared/cpiMembership";
import {
  EvaluationConfigInput,
  PatchStageInput,
  PooledShareInput,
  SetPanelRulesInput,
} from "./evaluations.schemas";

const DEFAULT_PANEL_RULES = [
  { role: PanelRole.EVALUATOR, minRequired: 1, markCounting: MarkCounting.COUNTED, openToAll: false },
];

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
// weight-validated; blocked once submissions exist, because replacing stages
// cascade-deletes them. Everything a coordinator might need to change AFTER that
// point has its own patch endpoint below.
export async function setEvaluationConfig(coordinatorUserId: string, cpiId: string, input: EvaluationConfigInput) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  validateWeights(input);

  const submissionCount = await prisma.submission.count({ where: { courseInstanceId: cpiId } });
  if (submissionCount > 0) {
    throw new AuthError(
      409,
      "Cannot replace the evaluation config after submissions exist — edit the stage, its panel rules or its windows instead",
    );
  }

  await prisma.$transaction([
    prisma.evaluationStage.deleteMany({ where: { courseInstanceId: cpiId } }),
    ...input.stages.map((stage, i) =>
      prisma.evaluationStage.create({
        data: {
          courseInstanceId: cpiId,
          name: stage.name,
          weight: stage.weight,
          submissionRequired: stage.submissionRequired,
          submissionWindowStart: stage.submissionWindowStart,
          submissionWindowEnd: stage.submissionWindowEnd,
          executionWindowStart: stage.executionWindowStart,
          executionWindowEnd: stage.executionWindowEnd,
          panelScoreVisibility: stage.panelScoreVisibility,
          orderIndex: i,
          criteria: {
            create: stage.criteria.map((c, ci) => ({
              name: c.name,
              description: c.description,
              weight: c.weight,
              maxScore: c.maxScore,
              level: c.level,
              orderIndex: ci,
            })),
          },
          panelRules: { create: stage.panelRules ?? DEFAULT_PANEL_RULES },
        },
      }),
    ),
  ]);

  return getEvaluationConfig(coordinatorUserId, cpiId);
}

async function loadStage(coordinatorUserId: string, cpiId: string, stageId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const stage = await prisma.evaluationStage.findUnique({ where: { id: stageId } });
  if (!stage || stage.courseInstanceId !== cpiId) throw new AuthError(404, "Stage not found in this CPI");
  return stage;
}

// Deliberately outside the submission lock: a stage's windows, visibility and
// name are exactly the things that need fixing once a course is running.
export async function patchStage(coordinatorUserId: string, cpiId: string, stageId: string, input: PatchStageInput) {
  await loadStage(coordinatorUserId, cpiId, stageId);
  return prisma.evaluationStage.update({ where: { id: stageId }, data: input });
}

// Also outside the lock — restaffing a panel mid-semester is the whole point of
// per-session panels, and it would be pointless if the rules were frozen.
export async function setPanelRules(
  coordinatorUserId: string,
  cpiId: string,
  stageId: string,
  input: SetPanelRulesInput,
) {
  await loadStage(coordinatorUserId, cpiId, stageId);

  const roles = input.rules.map((r) => r.role);
  if (new Set(roles).size !== roles.length) {
    throw new AuthError(400, "Each panel role may appear at most once per stage");
  }

  await prisma.$transaction([
    prisma.stagePanelRule.deleteMany({ where: { evaluationStageId: stageId } }),
    prisma.stagePanelRule.createMany({
      data: input.rules.map((r) => ({ ...r, evaluationStageId: stageId })),
    }),
  ]);

  return prisma.stagePanelRule.findMany({ where: { evaluationStageId: stageId } });
}

// Weight the pooled contribution from panelists whose marks the coordinator
// decides on (walk-ins, guests without a formal role). The scorer limit is held
// uniform across the stage so a group seen by eleven people is not compared with
// one seen by four.
export async function setPooledShare(
  coordinatorUserId: string,
  cpiId: string,
  stageId: string,
  input: PooledShareInput,
) {
  await loadStage(coordinatorUserId, cpiId, stageId);

  const [stage] = await prisma.$transaction([
    prisma.evaluationStage.update({
      where: { id: stageId },
      data: { pooledSharePercent: input.sharePercent, pooledScorerLimit: input.scorerLimit ?? null },
    }),
    prisma.pooledShareDecision.create({
      data: {
        evaluationStageId: stageId,
        sharePercent: input.sharePercent,
        scorerLimit: input.scorerLimit ?? null,
        reason: input.reason,
        decidedById: coordinatorUserId,
      },
    }),
  ]);

  return stage;
}

export async function listPooledShareDecisions(coordinatorUserId: string, cpiId: string, stageId: string) {
  await loadStage(coordinatorUserId, cpiId, stageId);
  return prisma.pooledShareDecision.findMany({
    where: { evaluationStageId: stageId },
    orderBy: { decidedAt: "desc" },
    include: { decidedBy: { select: { id: true, fullName: true, email: true } } },
  });
}

// Assign a CPI-pool evaluator as a stage default. These seed each new session's
// panel; the panel itself stays editable per session afterwards.
export async function assignStageEvaluator(
  coordinatorUserId: string,
  cpiId: string,
  stageId: string,
  lecturerUserId: string,
) {
  await loadStage(coordinatorUserId, cpiId, stageId);

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
      panelRules: true,
      evaluators: {
        include: {
          cpiEvaluator: {
            include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } },
          },
        },
      },
    },
  });
}
