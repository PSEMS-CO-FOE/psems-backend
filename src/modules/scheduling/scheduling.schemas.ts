import { AvailabilityStatus, SegmentTimeliness } from "@prisma/client";
import { z } from "zod";

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

// A slot is a time of day that repeats on every date, so it is stored as HH:mm.
export const availabilityTemplateSchema = z
  .object({
    windowStart: z.coerce.date(),
    windowEnd: z.coerce.date(),
    slots: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            startTime: z.string().regex(HH_MM, "Use HH:mm"),
            endTime: z.string().regex(HH_MM, "Use HH:mm"),
          })
          .refine((s) => s.startTime < s.endTime, { message: "A slot must start before it ends" }),
      )
      .min(1)
      .max(12),
  })
  .refine((v) => v.windowStart <= v.windowEnd, { message: "windowStart must not be after windowEnd" });

// Saves the whole grid, so any cell left out is cleared. An empty list is allowed.
export const availabilitySchema = z.object({
  entries: z
    .array(
      z.object({
        templateSlotId: z.string().uuid(),
        slotDate: z.coerce.date(),
        status: z.nativeEnum(AvailabilityStatus),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .max(500),
});

const scheduleFields = {
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date(),
  location: z.string().trim().max(200).optional(),
  allocatedMinutes: z.number().int().min(1).max(600).optional(),
};

export const scheduleSessionSchema = z.object(scheduleFields);

export const bulkScheduleSchema = z.object({
  entries: z.array(z.object({ sessionId: z.string().uuid(), ...scheduleFields })).min(1).max(200),
});

export const presentationDurationSchema = z.object({ seconds: z.number().int().min(0).max(86_400) });

// next and previous move the clock on by hand. Reaching a target changes nothing.
export const timerControlSchema = z.object({
  action: z.enum(["start", "pause", "next", "previous", "stop", "reset"]),
});

export const segmentTimelinessSchema = z.object({ timeliness: z.nativeEnum(SegmentTimeliness) });

export const timerSegmentTemplateSchema = z.object({
  segments: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        targetSeconds: z.number().int().min(5).max(21_600),
      }),
    )
    .max(12),
});

export type AvailabilityTemplateInput = z.infer<typeof availabilityTemplateSchema>;
export type BulkScheduleInput = z.infer<typeof bulkScheduleSchema>;
