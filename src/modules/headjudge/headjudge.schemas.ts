import { z } from "zod";

export const requestCorrectionSchema = z.object({
  evaluatorUserId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});
