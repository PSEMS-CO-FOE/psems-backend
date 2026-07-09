import { CpiParticipationMode, CpiPhase, CpiProjectType } from "@prisma/client";
import { z } from "zod";

export const createCpiSchema = z.object({
  name: z.string().trim().min(1),
  projectType: z.nativeEnum(CpiProjectType),
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
  // All 10 phases must be provided together — a partial timeline would leave
  // gated actions unreachable. Completeness + ordering is checked in the service.
  phases: z.array(timelinePhaseSchema).length(10),
});

export const inviteSupervisorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const respondInviteSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) });
export const assignEvaluatorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const setHeadJudgeSchema = z.object({ lecturerUserId: z.string().uuid() });

export type CreateCpiInput = z.infer<typeof createCpiSchema>;
export type SetTimelineInput = z.infer<typeof setTimelineSchema>;
