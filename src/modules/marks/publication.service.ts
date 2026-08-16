import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notifyMany } from "../notifications/notifications.service";

// What students may see. Marks, comments and the grade are separate switches:
// feedback can go out before the numbers, and the grade later still — releasing
// marks during the semester is not the same decision as releasing a grade at the
// end. Any of them can be turned off again; the old single timestamp could be
// set once and never cleared.

export interface PublicationInput {
  // null means the whole course; a stage id sets that stage only.
  stageId: string | null;
  publishMarks: boolean;
  publishComments: boolean;
  publishGrades: boolean;
}

export interface Visibility {
  marks: boolean;
  comments: boolean;
  grades: boolean;
}

export async function setPublication(coordinatorUserId: string, cpiId: string, input: PublicationInput) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  if (input.stageId) {
    const stage = await prisma.evaluationStage.findUnique({ where: { id: input.stageId } });
    if (!stage || stage.courseInstanceId !== cpiId) throw new AuthError(404, "Stage not found in this CPI");
  }

  const marksExist = await prisma.finalMark.count({ where: { courseInstanceId: cpiId } });
  if (input.publishMarks && marksExist === 0) throw new AuthError(409, "Aggregate marks before publishing them");

  // Found and then written rather than upserted: the course-wide row is kept
  // unique by a partial index, which Prisma cannot target in an upsert.
  const existing = await prisma.markPublication.findFirst({
    where: { courseInstanceId: cpiId, evaluationStageId: input.stageId },
  });

  const anythingPublished = input.publishMarks || input.publishComments || input.publishGrades;
  const data = {
    publishMarks: input.publishMarks,
    publishComments: input.publishComments,
    publishGrades: input.publishGrades,
    publishedAt: anythingPublished ? (existing?.publishedAt ?? new Date()) : null,
    publishedById: anythingPublished ? coordinatorUserId : null,
  };

  if (existing) {
    await prisma.markPublication.update({ where: { id: existing.id }, data });
  } else {
    await prisma.markPublication.create({
      data: { courseInstanceId: cpiId, evaluationStageId: input.stageId, ...data },
    });
  }

  // Only announce the first time something becomes visible. Turning a switch
  // off, or re-saving one already on, should not email the whole cohort again.
  const newlyVisible =
    anythingPublished && !(existing?.publishMarks || existing?.publishComments || existing?.publishGrades);
  if (newlyVisible) {
    const members = await prisma.groupMember.findMany({
      where: { status: "ACCEPTED", group: { courseInstanceId: cpiId } },
      include: { student: true },
    });
    const released = [
      input.publishMarks ? "Marks" : null,
      input.publishComments ? "feedback" : null,
      input.publishGrades ? "grades" : null,
    ].filter(Boolean) as string[];
    const what = released.length === 1 ? released[0] : `${released.slice(0, -1).join(", ")} and ${released.at(-1)}`;
    await notifyMany(
      members.map((m) => m.student.userId),
      {
        type: "MARKS_PUBLISHED",
        title: `${what} released`,
        body: `${what} for "${cpi.name}" are now available.`,
        courseInstanceId: cpiId,
        email: true,
      },
    );
  }

  return listPublications(cpiId);
}

export function listPublications(cpiId: string) {
  return prisma.markPublication.findMany({
    where: { courseInstanceId: cpiId },
    include: { stage: { select: { id: true, name: true } } },
    orderBy: { updatedAt: "desc" },
  });
}

// What a student may see for each stage. A stage's own setting wins; without
// one, the course-wide setting applies; without that, nothing is visible.
export async function resolveVisibility(cpiId: string) {
  const rows = await prisma.markPublication.findMany({ where: { courseInstanceId: cpiId } });
  const courseWide = rows.find((r) => r.evaluationStageId === null);
  const byStage = new Map(rows.filter((r) => r.evaluationStageId).map((r) => [r.evaluationStageId!, r]));

  return (stageId: string): Visibility => {
    const row = byStage.get(stageId) ?? courseWide;
    return {
      marks: row?.publishMarks ?? false,
      comments: row?.publishComments ?? false,
      grades: row?.publishGrades ?? false,
    };
  };
}
