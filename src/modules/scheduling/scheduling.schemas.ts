import { z } from "zod";

export const availabilitySchema = z
  .object({ slotStart: z.coerce.date(), slotEnd: z.coerce.date() })
  .refine((v) => v.slotStart < v.slotEnd, { message: "slotStart must be before slotEnd" });

export const scheduleSessionSchema = z.object({
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date(),
});
