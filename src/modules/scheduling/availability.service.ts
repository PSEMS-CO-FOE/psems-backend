import { AvailabilityRequirement, AvailabilityStatus, InvitationStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { loadPolicy } from "../shared/cpiMembership";

export interface TemplateSlotInput {
  name: string;
  startTime: string;
  endTime: string;
}

export interface AvailabilityEntryInput {
  templateSlotId: string;
  slotDate: Date;
  status: AvailabilityStatus;
  note?: string;
}

const templateInclude = {
  slots: { orderBy: { orderIndex: "asc" } },
} satisfies Prisma.AvailabilityTemplateInclude;

// A grid cell is a clock time on a date. A session is an exact moment. We match
// them using the server's timezone, which is fine for one department.

// Postgres stores a DATE as midnight UTC, so match that.
export function toDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

// The day a moment falls on locally. 21:00 on the 3rd can be 02:00 UTC on the
// 4th, but it still belongs to the 3rd.
export function calendarDateOf(instant: Date): Date {
  return new Date(Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()));
}

export function formatDateOnly(value: Date): string {
  return toDateOnly(value).toISOString().slice(0, 10);
}

// Every day in the window. These are the grid's columns.
export function datesInWindow(windowStart: Date, windowEnd: Date): Date[] {
  const dates: Date[] = [];
  for (let d = toDateOnly(windowStart); d <= toDateOnly(windowEnd); d = new Date(d.getTime() + 86_400_000)) {
    dates.push(d);
  }
  return dates;
}

export async function setTemplate(
  coordinatorUserId: string,
  cpiId: string,
  input: { windowStart: Date; windowEnd: Date; slots: TemplateSlotInput[] },
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  if (toDateOnly(input.windowStart) > toDateOnly(input.windowEnd)) {
    throw new AuthError(400, "The availability window must start before it ends");
  }

  // Saves the whole grid at once. Deleting a slot also deletes the answers given
  // for it, so no answer is left pointing at a slot that is gone.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.availabilityTemplate.findUnique({ where: { courseInstanceId: cpiId } });
    if (existing) await tx.availabilityTemplateSlot.deleteMany({ where: { templateId: existing.id } });

    return tx.availabilityTemplate.upsert({
      where: { courseInstanceId: cpiId },
      update: {
        windowStart: toDateOnly(input.windowStart),
        windowEnd: toDateOnly(input.windowEnd),
        slots: { create: input.slots.map((s, i) => ({ ...s, orderIndex: i })) },
      },
      create: {
        courseInstanceId: cpiId,
        windowStart: toDateOnly(input.windowStart),
        windowEnd: toDateOnly(input.windowEnd),
        slots: { create: input.slots.map((s, i) => ({ ...s, orderIndex: i })) },
      },
      include: templateInclude,
    });
  });
}

// Just the shape of the grid: dates and slot names. No answers.
export async function getTemplate(cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { createdById: true } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  const template = await prisma.availabilityTemplate.findUnique({
    where: { courseInstanceId: cpiId },
    include: templateInclude,
  });
  if (!template) return null;

  return { ...template, dates: datesInWindow(template.windowStart, template.windowEnd).map(formatDateOnly) };
}

// Who the course settings expect an answer from. Used only to show who has not
// replied yet. It never blocks anyone from answering.
export async function expectedRespondentLecturerIds(cpiId: string): Promise<string[]> {
  const policy = await loadPolicy(cpiId);
  if (policy.availabilityRequiredFrom === AvailabilityRequirement.NONE) return [];

  const evaluators = await prisma.cpiEvaluator.findMany({
    where: { courseInstanceId: cpiId },
    select: { lecturerId: true },
  });
  const ids = new Set(evaluators.map((e) => e.lecturerId));

  if (policy.availabilityRequiredFrom === AvailabilityRequirement.EVALUATORS_AND_SUPERVISORS) {
    const supervisors = await prisma.cpiSupervisor.findMany({
      where: { courseInstanceId: cpiId, invitationStatus: InvitationStatus.ACCEPTED },
      select: { lecturerId: true },
    });
    for (const s of supervisors) ids.add(s.lecturerId);
  }

  return [...ids];
}

// Any evaluator, accepted supervisor or panel member may answer. This is on
// purpose wider than the course settings, which only say who is expected to.
async function resolveRespondentLecturerId(userId: string, cpiId: string): Promise<string> {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) throw new AuthError(403, "Only a lecturer can submit availability");

  const [isEvaluator, isSupervisor, seatCount] = await Promise.all([
    prisma.cpiEvaluator.findUnique({
      where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
      select: { id: true },
    }),
    prisma.cpiSupervisor.findFirst({
      where: { courseInstanceId: cpiId, lecturerId: lecturer.id, invitationStatus: InvitationStatus.ACCEPTED },
      select: { id: true },
    }),
    prisma.sessionPanelist.count({ where: { lecturerId: lecturer.id, session: { courseInstanceId: cpiId } } }),
  ]);

  if (!isEvaluator && !isSupervisor && seatCount === 0) {
    throw new AuthError(403, "You are not part of this CPI's evaluation");
  }
  return lecturer.id;
}

// What is sent is the lecturer's full answer, so any cell left out is cleared.
// That is how a lecturer takes a slot back.
export async function submitAvailability(userId: string, cpiId: string, entries: AvailabilityEntryInput[]) {
  const lecturerId = await resolveRespondentLecturerId(userId, cpiId);

  const template = await prisma.availabilityTemplate.findUnique({
    where: { courseInstanceId: cpiId },
    include: templateInclude,
  });
  if (!template) throw new AuthError(409, "The coordinator has not set up the availability grid yet");

  const slotIds = new Set(template.slots.map((s) => s.id));
  const windowStart = toDateOnly(template.windowStart);
  const windowEnd = toDateOnly(template.windowEnd);

  for (const entry of entries) {
    if (!slotIds.has(entry.templateSlotId)) {
      throw new AuthError(400, "An entry references a slot that is not part of this grid");
    }
    const date = toDateOnly(entry.slotDate);
    if (date < windowStart || date > windowEnd) {
      throw new AuthError(400, "An entry falls outside the availability window");
    }
  }

  await prisma.$transaction([
    prisma.panelAvailability.deleteMany({ where: { courseInstanceId: cpiId, lecturerId } }),
    prisma.panelAvailability.createMany({
      data: entries.map((entry) => ({
        courseInstanceId: cpiId,
        lecturerId,
        templateSlotId: entry.templateSlotId,
        slotDate: toDateOnly(entry.slotDate),
        status: entry.status,
        note: entry.note ?? null,
      })),
    }),
  ]);

  return getMyAvailability(userId, cpiId);
}

export async function getMyAvailability(userId: string, cpiId: string) {
  const lecturerId = await resolveRespondentLecturerId(userId, cpiId);
  const [template, entries, expected] = await Promise.all([
    getTemplate(cpiId),
    prisma.panelAvailability.findMany({
      where: { courseInstanceId: cpiId, lecturerId },
      orderBy: [{ slotDate: "asc" }, { templateSlot: { orderIndex: "asc" } }],
    }),
    expectedRespondentLecturerIds(cpiId),
  ]);

  return {
    template,
    required: expected.includes(lecturerId),
    entries: entries.map((e) => ({ ...e, slotDate: formatDateOnly(e.slotDate) })),
  };
}

// Everyone's answers, plus who has not replied yet.
export async function listAvailability(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const [template, entries, expectedIds] = await Promise.all([
    getTemplate(cpiId),
    prisma.panelAvailability.findMany({
      where: { courseInstanceId: cpiId },
      include: {
        lecturer: { select: { id: true, user: { select: { id: true, fullName: true, email: true } } } },
        templateSlot: { select: { id: true, name: true, orderIndex: true } },
      },
      orderBy: [{ slotDate: "asc" }, { templateSlot: { orderIndex: "asc" } }],
    }),
    expectedRespondentLecturerIds(cpiId),
  ]);

  const responded = new Set(entries.map((e) => e.lecturerId));
  const outstanding = await prisma.lecturer.findMany({
    where: { id: { in: expectedIds.filter((id) => !responded.has(id)) } },
    select: { id: true, user: { select: { id: true, fullName: true, email: true } } },
  });

  return {
    template,
    entries: entries.map((e) => ({ ...e, slotDate: formatDateOnly(e.slotDate) })),
    outstanding,
  };
}

// Can this lecturer make this time? "Said no" and "did not answer" are kept
// apart, because not answering is not the same as saying no.
export type SlotFit = "AVAILABLE" | "TENTATIVE" | "UNAVAILABLE" | "NO_RESPONSE";

export async function fitForLecturers(
  cpiId: string,
  lecturerIds: string[],
  start: Date,
  end: Date,
): Promise<Map<string, SlotFit>> {
  const fit = new Map<string, SlotFit>(lecturerIds.map((id) => [id, "NO_RESPONSE"]));
  if (lecturerIds.length === 0) return fit;

  const entries = await prisma.panelAvailability.findMany({
    where: { courseInstanceId: cpiId, lecturerId: { in: lecturerIds }, slotDate: calendarDateOf(start) },
    include: { templateSlot: true },
  });

  for (const entry of entries) {
    if (!coversInstant(entry.slotDate, entry.templateSlot.startTime, entry.templateSlot.endTime, start, end)) continue;
    // A day can have more than one slot, so keep the best answer.
    const current = fit.get(entry.lecturerId);
    if (current === "AVAILABLE") continue;
    if (current === "TENTATIVE" && entry.status === AvailabilityStatus.UNAVAILABLE) continue;
    fit.set(entry.lecturerId, entry.status);
  }

  return fit;
}

// The session has to fit fully inside the slot to count.
function coversInstant(slotDate: Date, startTime: string, endTime: string, start: Date, end: Date): boolean {
  return start >= combineDateAndTime(slotDate, startTime) && end <= combineDateAndTime(slotDate, endTime);
}

// Turn a slot's clock time on a date into a real moment.
export function combineDateAndTime(slotDate: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const d = toDateOnly(slotDate);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hours, minutes);
}
