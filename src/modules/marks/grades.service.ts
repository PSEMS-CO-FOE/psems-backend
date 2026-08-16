import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";

export interface GradeBandInput {
  label: string;
  minPercent: number;
}

// Letter grades and the lowest mark that earns each one. Only used when the
// course has grading turned on; a course that awards CA marks only has none.
export async function setGradeBands(coordinatorUserId: string, cpiId: string, bands: GradeBandInput[]) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const labels = bands.map((b) => b.label.trim());
  if (new Set(labels).size !== labels.length) {
    throw new AuthError(400, "Each grade can only be listed once");
  }

  // Highest first, so looking up a grade is "the first band the mark reaches".
  const ordered = [...bands].sort((a, b) => b.minPercent - a.minPercent);

  await prisma.$transaction([
    prisma.gradeBand.deleteMany({ where: { courseInstanceId: cpiId } }),
    prisma.gradeBand.createMany({
      data: ordered.map((band, i) => ({
        courseInstanceId: cpiId,
        label: band.label.trim(),
        minPercent: band.minPercent,
        orderIndex: i,
      })),
    }),
  ]);

  return listGradeBands(cpiId);
}

export function listGradeBands(cpiId: string) {
  return prisma.gradeBand.findMany({ where: { courseInstanceId: cpiId }, orderBy: { orderIndex: "asc" } });
}

// The grade a mark earns, or null if the course has no bands or the mark is
// below every one of them.
export function gradeFor(percent: number, bands: { label: string; minPercent: number }[]): string | null {
  return bands.find((band) => percent >= band.minPercent)?.label ?? null;
}
