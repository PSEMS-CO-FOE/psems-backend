import { CpiParticipationMode, CpiPhase } from "@prisma/client";
import { z } from "zod";

export const createCpiSchema = z.object({
  name: z.string().trim().min(1),
  projectType: z.string().trim().min(1).max(100),
  participationMode: z.nativeEnum(CpiParticipationMode),
  department: z.string().trim().min(1),
  academicYear: z.string().trim().min(1),
});

const timelinePhaseSchema = z.object({
  phase: z.nativeEnum(CpiPhase),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export const setTimelineSchema = z.object({
  // A CPI may use any subset of the canonical phases (at least one). Omitted
  // phases simply leave their gated actions closed. Uniqueness + canonical
  // ordering is checked in the service.
  phases: z.array(timelinePhaseSchema).min(1).max(10),
});

export const inviteSupervisorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const respondInviteSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) });
export const assignEvaluatorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const setHeadJudgeSchema = z.object({ lecturerUserId: z.string().uuid() });

export type CreateCpiInput = z.infer<typeof createCpiSchema>;
export type SetTimelineInput = z.infer<typeof setTimelineSchema>;
