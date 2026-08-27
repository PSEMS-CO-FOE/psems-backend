import { z } from "zod";

export const ideaTextSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(10_000),
  k: z.coerce.number().int().min(1).max(10).optional(),
});

export const analyzeSubmissionSchema = z.object({
  cpiId: z.string().uuid(),
  submissionId: z.string().uuid(),
});
