import { CriterionLevel, MarkCounting, PanelRole, PanelScoreVisibility } from "@prisma/client";
import { z } from "zod";

const criterionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  weight: z.number().int().min(1).max(100),
  maxScore: z.number().int().min(1).max(1000),
  // GROUP is scored once for the group; INDIVIDUAL is scored per member.
  level: z.nativeEnum(CriterionLevel).default(CriterionLevel.GROUP),
});

// The composition a stage expects. minRequired 0 with openToAll true is the open
// event: nobody is assigned and whoever attends may mark.
const panelRuleSchema = z.object({
  role: z.nativeEnum(PanelRole),
  minRequired: z.number().int().min(0).max(50).default(0),
  maxAllowed: z.number().int().min(1).max(50).nullable().optional(),
  weightPercent: z.number().min(0).max(100).nullable().optional(),
  markCounting: z.nativeEnum(MarkCounting).default(MarkCounting.COUNTED),
  openToAll: z.boolean().default(false),
});

const stageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    weight: z.number().int().min(1).max(100),
    submissionRequired: z.boolean().default(false),
    // Optional per-stage submission window (both or neither).
    submissionWindowStart: z.coerce.date().optional(),
    submissionWindowEnd: z.coerce.date().optional(),
    // Optional per-stage scoring/presentation window (both or neither).
    executionWindowStart: z.coerce.date().optional(),
    executionWindowEnd: z.coerce.date().optional(),
    panelScoreVisibility: z.nativeEnum(PanelScoreVisibility).default(PanelScoreVisibility.ISOLATED),
    // Omitted means "one evaluator required", which is the least surprising
    // default and matches how stages behaved before panels existed.
    panelRules: z.array(panelRuleSchema).max(8).optional(),
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
  })
  .refine((s) => !s.panelRules || new Set(s.panelRules.map((r) => r.role)).size === s.panelRules.length, {
    message: "Each panel role may appear at most once per stage",
  });

export const evaluationConfigSchema = z.object({
  stages: z.array(stageSchema).min(1).max(12),
});

export const assignStageEvaluatorSchema = z.object({ lecturerUserId: z.string().uuid() });

// Targeted edits that stay available after submissions exist, so a coordinator
// can still fix a window, open a stage, or restaff a panel mid-semester.
export const patchStageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    submissionWindowStart: z.coerce.date().nullable(),
    submissionWindowEnd: z.coerce.date().nullable(),
    executionWindowStart: z.coerce.date().nullable(),
    executionWindowEnd: z.coerce.date().nullable(),
    panelScoreVisibility: z.nativeEnum(PanelScoreVisibility),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to change" });

export const setPanelRulesSchema = z.object({
  rules: z.array(panelRuleSchema).max(8),
});

// Weighting the pooled scores is taken with the marks already visible, so the
// reason is mandatory and the whole decision is kept.
export const pooledShareSchema = z.object({
  sharePercent: z.number().min(0).max(100),
  scorerLimit: z.number().int().min(1).max(200).nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
});

export type EvaluationConfigInput = z.infer<typeof evaluationConfigSchema>;
export type PatchStageInput = z.infer<typeof patchStageSchema>;
export type SetPanelRulesInput = z.infer<typeof setPanelRulesSchema>;
export type PooledShareInput = z.infer<typeof pooledShareSchema>;
