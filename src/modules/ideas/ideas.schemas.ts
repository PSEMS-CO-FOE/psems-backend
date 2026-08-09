import { z } from "zod";

export const postIdeaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
});

export const requestRevisionSchema = z.object({
  note: z.string().trim().min(1).max(1000),
});

export const coSupervisorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const respondCoSupervisorSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) });
