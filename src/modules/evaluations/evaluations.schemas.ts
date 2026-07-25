import { z } from "zod";

const criterionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  weight: z.number().int().min(1).max(100),
  maxScore: z.number().int().min(1).max(1000),
});

const stageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    weight: z.number().int().min(1).max(100),
    evaluatorsRequired: z.number().int().min(1).max(10),
    submissionRequired: z.boolean().default(false),
    // Optional per-stage submission window (both or neither).
    submissionWindowStart: z.coerce.date().optional(),
    submissionWindowEnd: z.coerce.date().optional(),
    // Optional per-stage scoring/presentation window (both or neither).
    executionWindowStart: z.coerce.date().optional(),
    executionWindowEnd: z.coerce.date().optional(),
    criteria: z.array(criterionSchema).min(1),
  })
  .refine((s) => !!s.submissionWindowStart === !!s.submissionWindowEnd, {
    message: "submissionWindowStart and submissionWindowEnd must be set together",
  })
  .refine((s) => !s.submissionWindowStart || !s.submissionWindowEnd || s.submissionWindowStart < s.submissionWindowEnd, {
    message: "submissionWindowStart must be before submissionWindowEnd",
  })
  .refine((s) => !!s.executionWindowStart === !!s.executionWindowEnd, {
    message: "executionWindowStart and executionWindowEnd must be set together",
  })
  .refine((s) => !s.executionWindowStart || !s.executionWindowEnd || s.executionWindowStart < s.executionWindowEnd, {
    message: "executionWindowStart must be before executionWindowEnd",
  });

export const evaluationConfigSchema = z.object({
  stages: z.array(stageSchema).min(1).max(12),
});

export const assignStageEvaluatorSchema = z.object({ lecturerUserId: z.string().uuid() });

export type EvaluationConfigInput = z.infer<typeof evaluationConfigSchema>;
