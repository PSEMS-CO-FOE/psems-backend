import { Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { UpdateProfileInput } from "./profiles.schemas";

const profileInclude = {
  interests: { orderBy: { area: "asc" } },
  outputs: { orderBy: [{ year: "desc" }, { title: "asc" }] },
  user: { select: { id: true, email: true, fullName: true, role: true } },
} satisfies Prisma.UserProfileInclude;

// Projects supervised are DERIVED, never stored, so the list can never drift
// from what actually happened. Student names appear alongside each project —
// decided deliberately (see the plan's privacy note).
async function supervisedProjects(userId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) return [];

  const allocations = await prisma.projectAllocation.findMany({
    where: { supervisorLecturerId: lecturer.id },
    orderBy: { createdAt: "desc" },
    include: {
      idea: { select: { title: true } },
      courseInstance: { select: { id: true, name: true, academicYear: true, projectType: true } },
      group: {
        select: {
          name: true,
          members: {
            where: { status: "ACCEPTED" },
            select: { student: { select: { studentId: true, user: { select: { fullName: true } } } } },
          },
        },
      },
    },
  });

  return allocations.map((a) => ({
    title: a.idea.title,
    course: a.courseInstance.name,
    academicYear: a.courseInstance.academicYear,
    projectType: a.courseInstance.projectType,
    groupName: a.group.name,
    students: a.group.members.map((m) => ({
      studentId: m.student.studentId,
      fullName: m.student.user.fullName,
    })),
  }));
}

// An institution-wide directory: any logged-in user may read any profile.
// Guests authenticating with a scoring link never reach this — their access is
// scoped to the sessions they mark, and they hold no account.
export async function getProfile(targetUserId: string) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!user) throw new AuthError(404, "User not found");

  // A profile row may not exist yet — the directory still shows the person, just
  // with nothing filled in.
  const profile = await prisma.userProfile.findUnique({
    where: { userId: targetUserId },
    include: profileInclude,
  });
  const owner =
    profile?.user ??
    (await prisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: { id: true, email: true, fullName: true, role: true },
    }));

  return {
    profile,
    user: owner,
    supervisedProjects: await supervisedProjects(targetUserId),
  };
}

export async function updateMyProfile(userId: string, input: UpdateProfileInput) {
  const { interests, outputs, links, ...fields } = input;

  // Prisma distinguishes "leave this JSON alone" from "set it to SQL NULL", so
  // an explicit null has to be spelled out rather than passed through.
  const linksData =
    links === undefined ? {} : { links: links === null ? Prisma.DbNull : (links as Prisma.InputJsonValue) };

  const profile = await prisma.userProfile.upsert({
    where: { userId },
    update: { ...fields, ...linksData },
    create: { userId, ...fields, ...linksData },
  });

  // Replace-all for the two child collections: they are short lists a person
  // edits as a whole, so diffing them would add complexity for nothing.
  if (interests) {
    await prisma.$transaction([
      prisma.researchInterest.deleteMany({ where: { profileId: profile.id } }),
      prisma.researchInterest.createMany({
        data: [...new Set(interests.map((a) => a.trim()).filter(Boolean))].map((area) => ({
          profileId: profile.id,
          area,
        })),
      }),
    ]);
  }

  if (outputs) {
    await prisma.$transaction([
      prisma.researchOutput.deleteMany({ where: { profileId: profile.id } }),
      prisma.researchOutput.createMany({
        data: outputs.map((o) => ({ ...o, profileId: profile.id })),
      }),
    ]);
  }

  return getProfile(userId);
}

// Find supervisors by research area — the reason interests are tagged rather
// than left as free text in the About section.
export async function searchProfiles(query: { area?: string; department?: string; q?: string }) {
  const profiles = await prisma.userProfile.findMany({
    where: {
      ...(query.department ? { department: { contains: query.department, mode: "insensitive" } } : {}),
      ...(query.area ? { interests: { some: { area: { contains: query.area, mode: "insensitive" } } } } : {}),
      ...(query.q
        ? {
            OR: [
              { headline: { contains: query.q, mode: "insensitive" } },
              { about: { contains: query.q, mode: "insensitive" } },
              { user: { fullName: { contains: query.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: profileInclude,
    take: 100,
    orderBy: { user: { fullName: "asc" } },
  });

  return profiles;
}

export function listResearchAreas() {
  return prisma.researchInterest
    .groupBy({ by: ["area"], _count: { area: true }, orderBy: { _count: { area: "desc" } }, take: 100 })
    .then((rows) => rows.map((r) => ({ area: r.area, count: r._count.area })));
}
