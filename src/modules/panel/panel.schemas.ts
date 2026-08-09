import { MarkCounting, PanelRole } from "@prisma/client";
import { z } from "zod";

const panelRole = z.nativeEnum(PanelRole);
const markCounting = z.nativeEnum(MarkCounting);

export const addPanelistSchema = z.object({
  userId: z.string().uuid(),
  role: panelRole,
  weightPercent: z.number().min(0).max(100).optional(),
  markCounting: markCounting.optional(),
});

export const updatePanelistSchema = z
  .object({
    role: panelRole.optional(),
    weightPercent: z.number().min(0).max(100).nullable().optional(),
    markCounting: markCounting.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export const joinPanelSchema = z.object({
  role: panelRole.default(PanelRole.EVALUATOR),
});

export const inviteGuestSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  organization: z.string().max(200).optional(),
  sessionIds: z.array(z.string().uuid()).min(1),
  role: panelRole.default(PanelRole.EVALUATOR),
});

export const guestScoreSchema = z.object({
  token: z.string().min(1),
  sessionId: z.string().uuid(),
  scores: z
    .array(
      z.object({
        criterionId: z.string().uuid(),
        studentId: z.string().uuid().optional(),
        score: z.number().int().min(0),
        comment: z.string().max(2000).optional(),
      }),
    )
    .min(1),
  overallComment: z.string().max(4000).optional(),
});
