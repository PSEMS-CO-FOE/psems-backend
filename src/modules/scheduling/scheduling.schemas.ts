import { z } from "zod";

export const availabilitySchema = z
  .object({ slotStart: z.coerce.date(), slotEnd: z.coerce.date() })
  .refine((v) => v.slotStart < v.slotEnd, { message: "slotStart must be before slotEnd" });

export const scheduleSessionSchema = z.object({
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date(),
  location: z.string().trim().max(500).optional(),
});

export const presentationDurationSchema = z.object({
  seconds: z.number().int().min(0).max(86400),
});

export const timerControlSchema = z.object({
  action: z.enum(["start", "pause", "stop", "reset"]),
});
