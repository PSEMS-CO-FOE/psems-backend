import { z } from "zod";

export const createSystemAdminSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1, "A name is required"),
});

// Mandatory: whoever reinstates the account reads this.
export const suspendUserSchema = z.object({
  reason: z.string().min(1, "A reason is required"),
});

export const userSearchSchema = z.object({
  query: z.string().trim().optional(),
  role: z
    .enum(["SUPER_ADMIN", "SYSTEM_ADMIN", "COURSE_COORDINATOR", "LECTURER", "STUDENT"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const auditQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.coerce.date().optional(),
});

export type CreateSystemAdminInput = z.infer<typeof createSystemAdminSchema>;
export type UserSearchInput = z.infer<typeof userSearchSchema>;
export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
