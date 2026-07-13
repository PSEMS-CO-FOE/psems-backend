import { z } from "zod";

const criterionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  weight: z.number().int().min(1).max(100),
  maxScore: z.number().int().min(1).max(1000),
});

const stageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  weight: z.number().int().min(1).max(100),
  evaluatorsRequired: z.number().int().min(1).max(10),
  submissionRequired: z.boolean().default(false),
  criteria: z.array(criterionSchema).min(1),
});

export const evaluationConfigSchema = z.object({
  stages: z.array(stageSchema).min(1).max(12),
});

export const assignStageEvaluatorSchema = z.object({ lecturerUserId: z.string().uuid() });

export type EvaluationConfigInput = z.infer<typeof evaluationConfigSchema>;
