import { CourseStatus, CpiMode, CpiParticipationMode, CpiPhase } from "@prisma/client";
import { z } from "zod";

export const createCpiSchema = z.object({
  name: z.string().trim().min(1),
  projectType: z.string().trim().min(1).max(100),
  participationMode: z.nativeEnum(CpiParticipationMode),
  department: z.string().trim().min(1),
  // The intake this course runs for, e.g. 22ENG. Required, and free text on
  // purpose — a fixed pattern would block a special or repeat intake.
  batch: z.string().trim().min(1).max(20),
  academicYear: z.string().trim().min(1),
  // Optional preset that seeds the policy. Omitting it starts from defaults;
  // it does not gate anything afterwards.
  mode: z.nativeEnum(CpiMode).optional(),
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

// Re-applies a preset after creation. The mode is only a starting point, so
// this overwrites the settings the preset covers and leaves the rest alone.
export const applyPresetSchema = z.object({ mode: z.nativeEnum(CpiMode) });

export const inviteSupervisorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const respondInviteSchema = z.object({ decision: z.enum(["ACCEPT", "DECLINE"]) });
export const assignEvaluatorSchema = z.object({ lecturerUserId: z.string().uuid() });
export const setHeadJudgeSchema = z.object({ lecturerUserId: z.string().uuid() });

export type CreateCpiInput = z.infer<typeof createCpiSchema>;
export type SetTimelineInput = z.infer<typeof setTimelineSchema>;

export const requestToSuperviseSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

export const decideSupervisorRequestSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

export const setCourseStatusSchema = z.object({ status: z.nativeEnum(CourseStatus) });

// A repeated student asking to take a course with a later batch. The reason is
// required: an exam-related decision should say why it was made.
export const joinRequestSchema = z.object({ reason: z.string().trim().min(1).max(1000) });

// The coordinator adding someone directly, rather than answering their request.
export const addStudentSchema = z.object({
  studentId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

export const decideJoinRequestSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});
