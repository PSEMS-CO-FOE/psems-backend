import { CpiPhase, InvitationStatus, PanelRole, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";
import { seedPanel } from "../panel/panel.service";
import { getAcceptedSupervisorLecturerId, getCpiEvaluatorId, getStudentGroupId } from "../shared/cpiMembership";
import { combineDateAndTime, datesInWindow, fitForLecturers, formatDateOnly } from "./availability.service";

// Build the timetable: one session per group per stage. Safe to run again, since
// sessions that already exist are skipped.
export async function generateSessions(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const [allocations, stages] = await Promise.all([
    prisma.projectAllocation.findMany({ where: { courseInstanceId: cpiId }, select: { groupId: true } }),
    prisma.evaluationStage.findMany({ where: { courseInstanceId: cpiId }, select: { id: true } }),
  ]);
  if (allocations.length === 0) throw new AuthError(409, "No allocations exist — finalize allocation first");
  if (stages.length === 0) throw new AuthError(409, "No evaluation stages exist — configure evaluation first");

  let created = 0;
  for (const { groupId } of allocations) {
    for (const stage of stages) {
      const exists = await prisma.evaluationSession.findUnique({
        where: { groupId_evaluationStageId: { groupId, evaluationStageId: stage.id } },
      });
      if (exists) continue;
      const session = await prisma.evaluationSession.create({
        data: { courseInstanceId: cpiId, groupId, evaluationStageId: stage.id },
      });
      // Start the panel from the stage's defaults. It can be edited per session
      // later, which is how one group ends up with a different panel.
      await seedPanel(session.id);
      created++;
    }
  }

  return { created, sessions: await getSessionMap(cpiId) };
}

// Scheduling opens when the availability phase opens and never closes, so a
// session can still be moved later. That is why the check is here, not on the route.
async function assertSchedulingOpen(cpiId: string) {
  const window = await prisma.cpiTimeline.findUnique({
    where: { courseInstanceId_phase: { courseInstanceId: cpiId, phase: CpiPhase.AVAILABILITY_SUBMISSION } },
  });
  if (!window) throw new AuthError(403, "The availability phase has not been scheduled for this CPI");
  if (new Date() < window.startDate) {
    throw new AuthError(403, `Scheduling opens at ${window.startDate.toISOString()}`);
  }
}

export type ConflictKind =
  | "PANELIST_DOUBLE_BOOKED"
  | "GROUP_DOUBLE_BOOKED"
  | "ROOM_DOUBLE_BOOKED"
  | "OUTSIDE_AVAILABILITY"
  | "REQUIRED_PANELIST_MISSING";

export interface ScheduleConflict {
  kind: ConflictKind;
  message: string;
  sessionId?: string;
  people?: { userId: string | null; name: string }[];
}

const sessionInclude = {
  group: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true } },
} satisfies Prisma.EvaluationSessionInclude;

const panelistNameSelect = {
  user: { select: { id: true, fullName: true, email: true } },
  guest: { select: { fullName: true } },
} satisfies Prisma.SessionPanelistSelect;

function panelistName(p: { user: { fullName: string; email: string } | null; guest: { fullName: string } | null }) {
  return p.user?.fullName || p.user?.email || p.guest?.fullName || "a panelist";
}

// Lists what is wrong with this time. These are warnings only — the coordinator
// can still book it. Checked against the people on this session's panel, not the
// stage's evaluator list, which no longer says who is in the room.
export async function detectConflicts(
  cpiId: string,
  sessionId: string,
  start: Date,
  end: Date,
  location?: string | null,
): Promise<ScheduleConflict[]> {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: {
      group: { select: { name: true } },
      stage: { include: { panelRules: true } },
      panelists: { select: { id: true, role: true, userId: true, lecturerId: true, ...panelistNameSelect } },
    },
  });
  if (!session) return [];

  const conflicts: ScheduleConflict[] = [];
  const overlaps = { scheduledStart: { lt: end }, scheduledEnd: { gt: start } } as const;

  // Looks at other courses too, since one person cannot be in two rooms at once.
  const panelUserIds = session.panelists.map((p) => p.userId).filter((id): id is string => Boolean(id));
  if (panelUserIds.length > 0) {
    const clashes = await prisma.evaluationSession.findMany({
      where: { id: { not: sessionId }, ...overlaps, panelists: { some: { userId: { in: panelUserIds } } } },
      include: { ...sessionInclude, panelists: { where: { userId: { in: panelUserIds } }, select: panelistNameSelect } },
    });
    for (const clash of clashes) {
      conflicts.push({
        kind: "PANELIST_DOUBLE_BOOKED",
        sessionId: clash.id,
        message: `${clash.panelists.map(panelistName).join(", ")} also has "${clash.stage.name}" for "${clash.group.name}" at this time`,
        people: clash.panelists.map((p) => ({ userId: p.user?.id ?? null, name: panelistName(p) })),
      });
    }
  }

  // Easy to do by mistake, since each stage is booked on its own screen.
  const groupClashes = await prisma.evaluationSession.findMany({
    where: { id: { not: sessionId }, groupId: session.groupId, ...overlaps },
    include: sessionInclude,
  });
  for (const clash of groupClashes) {
    conflicts.push({
      kind: "GROUP_DOUBLE_BOOKED",
      sessionId: clash.id,
      message: `"${session.group.name}" is already presenting "${clash.stage.name}" at this time`,
    });
  }

  if (location?.trim()) {
    const roomClashes = await prisma.evaluationSession.findMany({
      where: { id: { not: sessionId }, courseInstanceId: cpiId, location: location.trim(), ...overlaps },
      include: sessionInclude,
    });
    for (const clash of roomClashes) {
      conflicts.push({
        kind: "ROOM_DOUBLE_BOOKED",
        sessionId: clash.id,
        message: `${location.trim()} is already booked for "${clash.group.name}" · "${clash.stage.name}"`,
      });
    }
  }

  // Only checks people who filled in the grid. Not answering is not the same as
  // saying no, and warning about it would warn on almost every session.
  const lecturerIds = session.panelists.map((p) => p.lecturerId).filter((id): id is string => Boolean(id));
  if (lecturerIds.length > 0) {
    const responded = new Set(
      (
        await prisma.panelAvailability.findMany({
          where: { courseInstanceId: cpiId, lecturerId: { in: lecturerIds } },
          select: { lecturerId: true },
          distinct: ["lecturerId"],
        })
      ).map((r) => r.lecturerId),
    );
    const fit = await fitForLecturers(cpiId, [...responded], start, end);

    for (const panelist of session.panelists) {
      if (!panelist.lecturerId || !responded.has(panelist.lecturerId)) continue;
      const verdict = fit.get(panelist.lecturerId);
      if (verdict === "AVAILABLE") continue;
      const reason = verdict === "TENTATIVE" ? "is only tentatively free" : "has not marked themselves free";
      conflicts.push({
        kind: "OUTSIDE_AVAILABILITY",
        message: `${panelistName(panelist)} ${reason} at this time`,
        people: [{ userId: panelist.userId, name: panelistName(panelist) }],
      });
    }
  }

  // A role the stage requires, with nobody on the panel for it.
  for (const rule of session.stage.panelRules.filter((r) => r.minRequired > 0)) {
    const seated = session.panelists.filter((p) => p.role === rule.role).length;
    if (seated < rule.minRequired) {
      conflicts.push({
        kind: "REQUIRED_PANELIST_MISSING",
        message: `This stage requires ${rule.minRequired} ${roleLabel(rule.role)}(s); ${seated} are seated`,
      });
    }
  }

  return conflicts;
}

function roleLabel(role: PanelRole) {
  return role.replace(/_/g, " ").toLowerCase();
}

export interface ScheduleSessionInput {
  scheduledStart: Date;
  scheduledEnd: Date;
  location?: string;
  allocatedMinutes?: number;
}

export async function scheduleSession(
  coordinatorUserId: string,
  cpiId: string,
  sessionId: string,
  input: ScheduleSessionInput,
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  await assertSchedulingOpen(cpiId);
  return applySchedule(cpiId, sessionId, input);
}

async function applySchedule(cpiId: string, sessionId: string, input: ScheduleSessionInput) {
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  if (input.scheduledStart >= input.scheduledEnd) {
    throw new AuthError(400, "A session must start before it ends");
  }

  const conflicts = await detectConflicts(cpiId, sessionId, input.scheduledStart, input.scheduledEnd, input.location);
  const isReschedule = session.scheduledStart !== null;

  const updated = await prisma.evaluationSession.update({
    where: { id: sessionId },
    data: {
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      location: input.location,
      allocatedMinutes: input.allocatedMinutes ?? session.allocatedMinutes,
    },
    include: sessionInclude,
  });

  await notifySchedule(cpiId, session.groupId, updated, isReschedule);
  return { session: withDerived(updated), conflicts };
}

// Book several sessions at once — one room, one morning, groups one after another.
export async function scheduleSessions(
  coordinatorUserId: string,
  cpiId: string,
  entries: (ScheduleSessionInput & { sessionId: string })[],
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  await assertSchedulingOpen(cpiId);

  const results: { sessionId: string; conflicts: ScheduleConflict[] }[] = [];
  for (const entry of entries) {
    const { sessionId, ...rest } = entry;
    const { conflicts } = await applySchedule(cpiId, sessionId, rest);
    results.push({ sessionId, conflicts });
  }

  return { scheduled: results.length, results, sessions: await getSessionMap(cpiId) };
}

// Moving a session and booking it for the first time are different things, so
// they send different messages. Times are written out so people can read them.
async function notifySchedule(
  cpiId: string,
  groupId: string,
  session: { id: string; scheduledStart: Date | null; scheduledEnd: Date | null; location: string | null; group: { name: string }; stage: { name: string } },
  isReschedule: boolean,
) {
  const [members, allocation, panelists] = await Promise.all([
    prisma.groupMember.findMany({ where: { groupId, status: InvitationStatus.ACCEPTED }, include: { student: true } }),
    prisma.projectAllocation.findUnique({ where: { groupId }, include: { supervisor: true } }),
    prisma.sessionPanelist.findMany({ where: { evaluationSessionId: session.id }, select: { userId: true } }),
  ]);

  const recipients = [
    ...members.map((m) => m.student.userId),
    ...(allocation?.supervisor ? [allocation.supervisor.userId] : []),
    ...panelists.map((p) => p.userId).filter((id): id is string => Boolean(id)),
  ];

  await notifyMany(recipients, {
    type: isReschedule ? "SESSION_RESCHEDULED" : "SESSION_SCHEDULED",
    title: isReschedule ? "Evaluation session moved" : "Evaluation session scheduled",
    body: `"${session.stage.name}" for "${session.group.name}" ${isReschedule ? "has moved to" : "is scheduled for"} ${formatWhen(session.scheduledStart, session.scheduledEnd)}${session.location ? ` at ${session.location}` : ""}.`,
    courseInstanceId: cpiId,
  });
}

function formatWhen(start: Date | null, end: Date | null): string {
  if (!start || !end) return "a time to be confirmed";
  const date = start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const from = start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const to = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${from}–${to}`;
}

export interface AlternativeSlot {
  slotDate: string;
  templateSlotId: string;
  slotName: string;
  start: string;
  end: string;
  allAvailable: boolean;
  tentative: string[];
  sessionsAlreadyInSlot: number;
}

// Finds slots where everyone the stage requires is free, so a clashing session
// can actually be moved instead of just flagged.
export async function getAlternativeSlots(
  coordinatorUserId: string,
  cpiId: string,
  sessionId: string,
  limit = 10,
): Promise<AlternativeSlot[]> {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: {
      stage: { include: { panelRules: true } },
      panelists: { select: { role: true, lecturerId: true, ...panelistNameSelect } },
    },
  });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");

  const template = await prisma.availabilityTemplate.findUnique({
    where: { courseInstanceId: cpiId },
    include: { slots: { orderBy: { orderIndex: "asc" } } },
  });
  if (!template) return [];

  // Only required roles limit the move. Someone optional does not.
  const requiredRoles = new Set(session.stage.panelRules.filter((r) => r.minRequired > 0).map((r) => r.role));
  const required = session.panelists.filter((p) => requiredRoles.has(p.role) && p.lecturerId);
  const requiredLecturerIds = required.map((p) => p.lecturerId!);
  const nameByLecturer = new Map(required.map((p) => [p.lecturerId!, panelistName(p)]));

  const durationMs = sessionDurationMs(session);
  const dates = datesInWindow(template.windowStart, template.windowEnd);
  const candidates: AlternativeSlot[] = [];

  for (const date of dates) {
    for (const slot of template.slots) {
      const start = combineDateAndTime(date, slot.startTime);
      const slotEnd = combineDateAndTime(date, slot.endTime);
      const end = new Date(start.getTime() + durationMs);
      if (end > slotEnd) continue;

      const fit = await fitForLecturers(cpiId, requiredLecturerIds, start, end);
      const unavailable = requiredLecturerIds.filter((id) => {
        const verdict = fit.get(id);
        return verdict === "UNAVAILABLE" || verdict === "NO_RESPONSE";
      });
      if (unavailable.length > 0) continue;

      const tentative = requiredLecturerIds.filter((id) => fit.get(id) === "TENTATIVE");

      candidates.push({
        slotDate: formatDateOnly(date),
        templateSlotId: slot.id,
        slotName: slot.name,
        start: start.toISOString(),
        end: end.toISOString(),
        allAvailable: tentative.length === 0,
        tentative: tentative.map((id) => nameByLecturer.get(id) ?? "a panelist"),
        sessionsAlreadyInSlot: await prisma.evaluationSession.count({
          where: {
            courseInstanceId: cpiId,
            id: { not: sessionId },
            scheduledStart: { lt: slotEnd },
            scheduledEnd: { gt: start },
          },
        }),
      });
    }
  }

  // Best options first: fully free before maybe, and quieter slots before busy ones.
  candidates.sort(
    (a, b) =>
      Number(b.allAvailable) - Number(a.allAvailable) ||
      a.sessionsAlreadyInSlot - b.sessionsAlreadyInSlot ||
      a.start.localeCompare(b.start),
  );
  return candidates.slice(0, limit);
}

function sessionDurationMs(session: { allocatedMinutes: number | null; scheduledStart: Date | null; scheduledEnd: Date | null }) {
  if (session.allocatedMinutes) return session.allocatedMinutes * 60_000;
  if (session.scheduledStart && session.scheduledEnd) {
    return session.scheduledEnd.getTime() - session.scheduledStart.getTime();
  }
  return 30 * 60_000;
}

// Which sessions the caller may see. The coordinator sees all of them, a student
// sees their own group's, a supervisor sees the groups they supervise, and a
// panel member sees the sessions they sit on.
export async function listSessions(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  if (cpi.createdById === userId) return getSessionMap(cpiId);

  const studentGroupId = await getStudentGroupId(userId, cpiId);
  if (studentGroupId) {
    const sessions = await prisma.evaluationSession.findMany({
      where: { courseInstanceId: cpiId, groupId: studentGroupId },
      include: sessionInclude,
      orderBy: { createdAt: "asc" },
    });
    return sessions.map(withDerived);
  }

  const [seatedSessionIds, supervisorLecturerId, cpiEvaluatorId] = await Promise.all([
    prisma.sessionPanelist
      .findMany({ where: { userId, session: { courseInstanceId: cpiId } }, select: { evaluationSessionId: true } })
      .then((rows) => rows.map((r) => r.evaluationSessionId)),
    getAcceptedSupervisorLecturerId(userId, cpiId),
    getCpiEvaluatorId(userId, cpiId),
  ]);

  const supervisedGroupIds = supervisorLecturerId
    ? (
        await prisma.projectAllocation.findMany({
          where: { courseInstanceId: cpiId, supervisorLecturerId },
          select: { groupId: true },
        })
      ).map((a) => a.groupId)
    : [];

  const stageIds = cpiEvaluatorId
    ? (
        await prisma.stageEvaluator.findMany({ where: { cpiEvaluatorId }, select: { evaluationStageId: true } })
      ).map((s) => s.evaluationStageId)
    : [];

  if (seatedSessionIds.length === 0 && supervisedGroupIds.length === 0 && stageIds.length === 0) {
    throw new AuthError(403, "You are not a participant in this CPI's evaluation");
  }

  const sessions = await prisma.evaluationSession.findMany({
    where: {
      courseInstanceId: cpiId,
      OR: [
        { id: { in: seatedSessionIds } },
        { groupId: { in: supervisedGroupIds } },
        { evaluationStageId: { in: stageIds } },
      ],
    },
    include: sessionInclude,
    orderBy: { createdAt: "asc" },
  });
  return sessions.map(withDerived);
}

export interface ScheduleSheetRow {
  groupName: string;
  stageName: string;
  location: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  members: { no: number; indexNumber: string; registrationNumber: string | null; name: string }[];
}

// The timetable for printing: one block per group with its members and index
// numbers. Coordinator only, because it lists every student in the course.
export async function getScheduleSheet(coordinatorUserId: string, cpiId: string, stageId?: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId, ...(stageId ? { evaluationStageId: stageId } : {}) },
    include: {
      stage: { select: { id: true, name: true, orderIndex: true } },
      group: {
        select: {
          name: true,
          members: {
            where: { status: InvitationStatus.ACCEPTED },
            select: {
              student: {
                select: { studentId: true, registrationNumber: true, user: { select: { fullName: true, email: true } } },
              },
            },
            orderBy: { student: { studentId: "asc" } },
          },
        },
      },
    },
    orderBy: [{ stage: { orderIndex: "asc" } }, { scheduledStart: { sort: "asc", nulls: "last" } }],
  });

  const rows: ScheduleSheetRow[] = sessions.map((session) => ({
    groupName: session.group.name,
    stageName: session.stage.name,
    location: session.location,
    scheduledStart: session.scheduledStart?.toISOString() ?? null,
    scheduledEnd: session.scheduledEnd?.toISOString() ?? null,
    members: session.group.members.map((m, i) => ({
      no: i + 1,
      indexNumber: m.student.studentId,
      registrationNumber: m.student.registrationNumber,
      name: m.student.user.fullName || m.student.user.email,
    })),
  }));

  // Use one venue in the heading if every session is in the same place.
  const venues = [...new Set(rows.map((r) => r.location).filter((l): l is string => Boolean(l)))];

  return {
    courseName: cpi.name,
    academicYear: cpi.academicYear,
    venue: venues.length === 1 ? venues[0] : null,
    unscheduled: rows.filter((r) => !r.scheduledStart).length,
    rows,
  };
}

async function getSessionMap(cpiId: string) {
  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId },
    include: sessionInclude,
    orderBy: { createdAt: "asc" },
  });
  return sessions.map(withDerived);
}

// Extra fields worked out on the fly, not stored: whether the session is overdue,
// and the current timer value so every client shows the same time.
export function withDerived<
  T extends {
    scheduledEnd: Date | null;
    status: string;
    timerAccumulatedSeconds: number;
    timerRunning: boolean;
    timerStartedAt: Date | null;
  },
>(session: T) {
  const isOverdue = !!session.scheduledEnd && session.scheduledEnd.getTime() < Date.now() && session.status === "SCHEDULED";
  return { ...session, isOverdue, timerElapsedSeconds: liveElapsed(session) };
}

export function liveElapsed(s: { timerAccumulatedSeconds: number; timerRunning: boolean; timerStartedAt: Date | null }): number {
  const runningExtra = s.timerRunning && s.timerStartedAt ? Math.floor((Date.now() - s.timerStartedAt.getTime()) / 1000) : 0;
  return s.timerAccumulatedSeconds + runningExtra;
}
