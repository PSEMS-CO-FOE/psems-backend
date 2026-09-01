import { Prisma, Role } from "@prisma/client";
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

// The projects a student actually did, derived from their group's allocations
// the same way a lecturer's supervised list is. Stored nowhere, so it can never
// drift from what happened. Empty for anyone who is not a student, which is what
// lets the profile page hide the tab rather than show it blank.
async function ownProjects(userId: string) {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) return [];

  const allocations = await prisma.projectAllocation.findMany({
    where: { group: { members: { some: { studentId: student.id, status: "ACCEPTED" } } } },
    orderBy: { createdAt: "desc" },
    include: {
      idea: { select: { title: true } },
      courseInstance: { select: { id: true, name: true, academicYear: true, projectType: true } },
      group: { select: { name: true } },
      supervisor: { select: { user: { select: { id: true, fullName: true, email: true } } } },
    },
  });

  return allocations.map((a) => ({
    title: a.idea.title,
    course: a.courseInstance.name,
    academicYear: a.courseInstance.academicYear,
    projectType: a.courseInstance.projectType,
    groupName: a.group.name,
    supervisor: a.supervisor
      ? { id: a.supervisor.user.id, fullName: a.supervisor.user.fullName, email: a.supervisor.user.email }
      : null,
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

  const [supervised, own] = await Promise.all([supervisedProjects(targetUserId), ownProjects(targetUserId)]);

  return {
    profile,
    user: owner,
    supervisedProjects: supervised,
    ownProjects: own,
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
  // Searches people, not profile rows. Querying `userProfile` meant anyone who
  // had never opened Edit my profile did not exist as far as the directory and
  // the search box were concerned — which, on a new deployment, is everyone.
  const users = await prisma.user.findMany({
    where: {
      // Guests hold no account; suspended people should not be offered as
      // supervisors or teammates.
      suspendedAt: null,
      // The directory exists to find a supervisor or a teammate. An admin is
      // neither, and listing one only invites a request they cannot act on.
      role: { notIn: [Role.SYSTEM_ADMIN, Role.SUPER_ADMIN] },
      ...(query.department ? { profile: { department: { contains: query.department, mode: "insensitive" } } } : {}),
      ...(query.area
        ? { profile: { interests: { some: { area: { contains: query.area, mode: "insensitive" } } } } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { fullName: { contains: query.q, mode: "insensitive" } },
              // An email is what people actually remember about a colleague.
              { email: { contains: query.q, mode: "insensitive" } },
              { profile: { headline: { contains: query.q, mode: "insensitive" } } },
              { profile: { about: { contains: query.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      profile: { include: { interests: { orderBy: { area: "asc" } }, outputs: { orderBy: [{ year: "desc" }, { title: "asc" }] } } },
    },
    take: 100,
    orderBy: [{ fullName: "asc" }, { email: "asc" }],
  });

  // The shape callers already read, with empty values where no profile exists.
  return users.map((u) => ({
    id: u.profile?.id ?? u.id,
    userId: u.id,
    headline: u.profile?.headline ?? null,
    about: u.profile?.about ?? null,
    department: u.profile?.department ?? null,
    designation: u.profile?.designation ?? null,
    contactEmail: u.profile?.contactEmail ?? null,
    links: u.profile?.links ?? null,
    interests: u.profile?.interests ?? [],
    outputs: u.profile?.outputs ?? [],
    user: { id: u.id, email: u.email, fullName: u.fullName, role: u.role },
  }));
}

export function listResearchAreas() {
  return prisma.researchInterest
    .groupBy({ by: ["area"], _count: { area: true }, orderBy: { _count: { area: "desc" } }, take: 100 })
    .then((rows) => rows.map((r) => ({ area: r.area, count: r._count.area })));
}
