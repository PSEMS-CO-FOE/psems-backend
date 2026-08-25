import { z } from "zod";

// Interest is flat — no rank. Every EOI action just references an idea.
export const ideaRefSchema = z.object({ ideaId: z.string().uuid() });

export const selectProjectSchema = z.object({
  ideaId: z.string().uuid(),
  // Required only when selecting the group's OWN idea and multiple supervisors
  // marked willing — the group picks which one (conflict resolution).
  supervisorUserId: z.string().uuid().optional(),
});

export const respondSelectionSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) });

// Which kind of interest is being withdrawn — the caller knows, and it decides
// whether the row is keyed by group or by lecturer.
export const withdrawInterestSchema = z.object({
  type: z.enum(["GROUP_INTEREST", "SEEKING_SUPERVISOR", "SUPERVISOR_WILLING", "LECTURER_INTEREST", "CO_SUPERVISION_INTEREST"]),
});

export const acceptInterestedGroupSchema = z.object({
  ideaId: z.string().uuid(),
  groupId: z.string().uuid(),
});
