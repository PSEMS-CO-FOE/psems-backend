import { z } from "zod";

export const requestCorrectionSchema = z.object({
  panelistId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

export const reopenSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
