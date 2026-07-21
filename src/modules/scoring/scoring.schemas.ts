import { z } from "zod";

export const submitScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        criterionId: z.string().uuid(),
        score: z.number().int().min(0),
        comment: z.string().max(2000).optional(),
      }),
    )
    .min(1),
});
