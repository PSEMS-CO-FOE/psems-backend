import { z } from "zod";

export const overrideAllocationSchema = z.object({
  ideaId: z.string().uuid(),
  supervisorUserId: z.string().uuid().optional(),
});
