import { z } from "zod";

export const overrideAllocationSchema = z.object({
  ideaId: z.string().uuid(),
  supervisorUserId: z.string().uuid().optional(),
});

// Reopening a locked allocation is a decision worth explaining, so the reason is
// required and lands on the audit trail with the write.
export const reopenAllocationsSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
