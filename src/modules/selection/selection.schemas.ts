import { z } from "zod";

export const expressInterestSchema = z.object({
  ideaId: z.string().uuid(),
  rank: z.number().int().min(1).max(3),
});

// seeking-supervisor and willing both just reference an idea.
export const ideaRefSchema = z.object({ ideaId: z.string().uuid() });

export const selectProjectSchema = z.object({
  ideaId: z.string().uuid(),
  // Required only when selecting the group's OWN idea and multiple supervisors
  // marked willing — the group picks which one (conflict resolution).
  supervisorUserId: z.string().uuid().optional(),
});

export const respondSelectionSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) });
