import { z } from "zod";

export const submitScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        criterionId: z.string().uuid(),
        // Required for an INDIVIDUAL criterion, rejected for a GROUP one.
        studentId: z.string().uuid().optional(),
        score: z.number().int().min(0),
        comment: z.string().max(2000).optional(),
      }),
    )
    .min(1),
  // Mandatory unless the CPI's policy turns it off; enforced in the service so
  // an already-saved comment counts on resubmission.
  overallComment: z.string().max(4000).optional(),
});
