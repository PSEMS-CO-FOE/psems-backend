import { z } from "zod";

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const respondGroupInviteSchema = z.object({
  decision: z.enum(["ACCEPT", "DECLINE"]),
});
