import {
  CourseInstance,
  CourseStatus,
  CpiMode,
  CpiPhase,
  InvitationStatus,
  LecturerApprovalStatus,
  Role,
} from "@prisma/client";
import { prisma } from "../../config/database";
import { accessibleCourseFilter, normalizeBatch } from "./batch";
import { AuthError } from "../auth/auth.service";
import { assertRole } from "../shared/authorization";
import { notify, notifyMany } from "../notifications/notifications.service";
import { createPolicyData } from "../policy/policy.service";
import { loadPolicy } from "../shared/cpiMembership";
import { CreateCpiInput, SetTimelineInput } from "./courses.schemas";

// Canonical phase order (spec 3.3 Step 2). Used to validate that a submitted
// timeline is complete and chronologically sane.
const PHASE_ORDER: CpiPhase[] = [
  CpiPhase.STUDENT_REGISTRATION,
  CpiPhase.SUPERVISOR_ADDITION,
  CpiPhase.IDEA_ANNOUNCEMENT,
  CpiPhase.PROJECT_SELECTION,
  CpiPhase.PROJECT_REGISTRATION,
  CpiPhase.EVALUATION_CONFIG,
  CpiPhase.PROPOSAL_SUBMISSION,
  CpiPhase.AVAILABILITY_SUBMISSION,
  CpiPhase.EVALUATION_EXECUTION,
  CpiPhase.FINAL_SUBMISSION,
];

export async function createCpi(coordinatorUserId: string, input: CreateCpiInput) {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  // The mode is a preset: it seeds the policy and is never consulted again, so
  // every rule it implies can be changed afterwards.
  return prisma.courseInstance.create({
    data: {
      name: input.name,
      projectType: input.projectType,
      participationMode: input.participationMode,
      department: input.department,
      batch: normalizeBatch(input.batch),
      academicYear: input.academicYear,
      mode: input.mode ?? null,
      createdById: coordinatorUserId,
      policy: { create: createPolicyData(input.mode ?? null) },
    },
  });
}

export async function listOwnedCpis(coordinatorUserId: string) {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  return prisma.courseInstance.findMany({
    where: { createdById: coordinatorUserId },
    orderBy: { createdAt: "desc" },
  });
}

// Basic, non-sensitive CPI info for any authenticated participant to display
// (e.g. the course name in a header instead of its id).
export async function getCpiSummary(cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({
    where: { id: cpiId },
    select: {
      id: true,
      name: true,
      department: true,
      academicYear: true,
      projectType: true,
      participationMode: true,
      mode: true,
    },
  });
  if (!cpi) throw new AuthError(404, "CPI not found");
  return cpi;
}

export async function getCpiDetail(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  return prisma.courseInstance.findUnique({
    where: { id: cpiId },
    include: {
      timeline: { orderBy: { startDate: "asc" } },
      supervisors: { include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } } },
      evaluators: { include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } } },
    },
  });
}

export async function setTimeline(coordinatorUserId: string, cpiId: string, input: SetTimelineInput) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  validateTimeline(input);

  // Replace-all: clear any existing phase rows and insert the new set in one
  // transaction, so the timeline is never left half-updated.
  await prisma.$transaction([
    prisma.cpiTimeline.deleteMany({ where: { courseInstanceId: cpiId } }),
    prisma.cpiTimeline.createMany({
      data: input.phases.map((p) => ({
        courseInstanceId: cpiId,
        phase: p.phase,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
    }),
  ]);

  return prisma.cpiTimeline.findMany({
    where: { courseInstanceId: cpiId },
    orderBy: { startDate: "asc" },
  });
}

// Inviting a supervisor no longer changes the CPI's mode, and is no longer
// refused for a Coordinator-Managed one: a coordinator-run course can have
// supervisors who post ideas and sit on panels. What they may do is a policy
// question, not a consequence of having been invited.
export async function inviteSupervisor(coordinatorUserId: string, cpiId: string, lecturerUserId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  const lecturer = await loadApprovedLecturer(lecturerUserId);

  const existing = await prisma.cpiSupervisor.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (existing) {
    throw new AuthError(409, "This lecturer has already been invited as a supervisor for this CPI");
  }

  const supervisor = await prisma.cpiSupervisor.create({
    data: { courseInstanceId: cpiId, lecturerId: lecturer.id },
  });

  await notify(lecturerUserId, {
    type: "SUPERVISOR_INVITED",
    title: "Supervisor invitation",
    body: `You have been invited to supervise in "${cpi.name}".`,
    courseInstanceId: cpiId,
    email: true,
  });

  return supervisor;
}

// Courses an approved lecturer can discover and ask to join.
//
// PRIVACY BOUNDARY: this returns course metadata and nothing else. Accepted
// supervisors can see every idea in a course including groups' restricted ones,
// so opening discovery to any lecturer would leak them. A lecturer sees ideas
// only once they are actually on the course.
export async function listOpenCpis(userId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId }, include: { user: true } });
  if (!lecturer || lecturer.approvalStatus !== LecturerApprovalStatus.APPROVED) return [];

  const [already, requested] = await Promise.all([
    prisma.cpiSupervisor.findMany({ where: { lecturerId: lecturer.id }, select: { courseInstanceId: true } }),
    prisma.supervisorRequest.findMany({
      where: { lecturerId: lecturer.id },
      select: { courseInstanceId: true, status: true },
    }),
  ]);
  const requestedBy = new Map(requested.map((r) => [r.courseInstanceId, r.status]));
  const excluded = new Set(already.map((a) => a.courseInstanceId));

  const cpis = await prisma.courseInstance.findMany({
    // Drafts are still being set up; a request against one is noise for the
    // coordinator, and an archived course has already finished.
    where: { id: { notIn: [...excluded] }, status: CourseStatus.ACTIVE },
    select: {
      id: true,
      name: true,
      department: true,
      batch: true,
      academicYear: true,
      projectType: true,
      createdBy: { select: { fullName: true, email: true } },
      _count: { select: { groups: true, supervisors: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return cpis.map((cpi) => ({ ...cpi, requestStatus: requestedBy.get(cpi.id) ?? null }));
}

// A lecturer asking to be made a supervisor on a course they found. The note is
// what the coordinator reads when deciding.
export async function requestToSupervise(userId: string, cpiId: string, note?: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  const policy = await loadPolicy(cpiId);
  if (!policy.allowSupervisorSelfRequest) {
    throw new AuthError(409, "This course does not accept requests to supervise");
  }

  const lecturer = await loadApprovedLecturer(userId);
  const requester = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { fullName: true, email: true },
  });

  const existingRole = await prisma.cpiSupervisor.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (existingRole) throw new AuthError(409, "You are already invited or accepted on this course");

  const existing = await prisma.supervisorRequest.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (existing && existing.status === "PENDING") {
    throw new AuthError(409, "You already have a pending request for this course");
  }

  // A rejected request can be made again — circumstances change.
  const requestRow = existing
    ? await prisma.supervisorRequest.update({
        where: { id: existing.id },
        data: { status: "PENDING", note: note ?? null, decidedById: null, decidedAt: null },
      })
    : await prisma.supervisorRequest.create({
        data: { courseInstanceId: cpiId, lecturerId: lecturer.id, note: note ?? null },
      });

  await notify(cpi.createdById, {
    type: "SUPERVISOR_REQUESTED",
    title: "A lecturer asked to supervise",
    body: `${requester.fullName || requester.email} asked to supervise in "${cpi.name}".${note ? ` Note: ${note}` : ""}`,
    courseInstanceId: cpiId,
  });

  return requestRow;
}

export async function listSupervisorRequests(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  return prisma.supervisorRequest.findMany({
    where: { courseInstanceId: cpiId },
    orderBy: { createdAt: "desc" },
    include: { lecturer: { include: { user: { select: { id: true, email: true, fullName: true } } } } },
  });
}

// Approving promotes the request into a real supervisor invitation, which the
// lecturer still has to accept — they asked to be considered, not to be enrolled.
export async function decideSupervisorRequest(
  coordinatorUserId: string,
  cpiId: string,
  requestId: string,
  decision: "APPROVE" | "REJECT",
) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const requestRow = await prisma.supervisorRequest.findUnique({
    where: { id: requestId },
    include: { lecturer: { include: { user: true } } },
  });
  if (!requestRow || requestRow.courseInstanceId !== cpiId) {
    throw new AuthError(404, "Request not found in this CPI");
  }
  if (requestRow.status !== "PENDING") {
    throw new AuthError(409, `That request was already ${requestRow.status.toLowerCase()}`);
  }

  const decided = await prisma.supervisorRequest.update({
    where: { id: requestId },
    data: {
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      decidedById: coordinatorUserId,
      decidedAt: new Date(),
    },
  });

  if (decision === "APPROVE") {
    await prisma.cpiSupervisor.upsert({
      where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: requestRow.lecturerId } },
      update: {},
      create: { courseInstanceId: cpiId, lecturerId: requestRow.lecturerId },
    });
  }

  await notify(requestRow.lecturer.userId, {
    type: decision === "APPROVE" ? "SUPERVISOR_REQUEST_APPROVED" : "SUPERVISOR_REQUEST_REJECTED",
    title: decision === "APPROVE" ? "Your request to supervise was approved" : "Your request to supervise was declined",
    body:
      decision === "APPROVE"
        ? `You have been invited to supervise in "${cpi.name}" — accept the invitation to join.`
        : `Your request to supervise in "${cpi.name}" was not taken up.`,
    courseInstanceId: cpiId,
    email: true,
  });

  return decided;
}

// Courses a student can open: their own batch's active ones, everything they
// have already joined, and anything they were approved to join late.
//
// Matching on department alone used to show every student every course the
// department had ever run, including drafts still being set up.
export async function listStudentCpis(userId: string) {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) return [];

  return prisma.courseInstance.findMany({
    where: await accessibleCourseFilter(student.id, student.batch, student.department),
    select: {
      id: true,
      name: true,
      department: true,
      batch: true,
      status: true,
      academicYear: true,
      projectType: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

// Active courses in the student's department belonging to OTHER batches, so a
// repeated student can name the one they want to join. Metadata only — never
// contents — the same boundary `listOpenCpis` draws for lecturers.
export async function listOtherBatchCpis(userId: string) {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) return [];

  const requests = await prisma.courseJoinRequest.findMany({
    where: { studentId: student.id },
    select: { courseInstanceId: true, status: true, reason: true },
  });
  const byId = new Map(requests.map((r) => [r.courseInstanceId, r]));

  const courses = await prisma.courseInstance.findMany({
    where: {
      status: CourseStatus.ACTIVE,
      department: student.department,
      batch: { not: student.batch },
    },
    select: { id: true, name: true, batch: true, projectType: true, academicYear: true },
    orderBy: { createdAt: "desc" },
  });

  return courses.map((course) => ({ ...course, request: byId.get(course.id) ?? null }));
}

// Move a course between draft, active and archived. Drafts are invisible to
// students, which is what lets a coordinator build one in peace; archiving takes
// a finished course out of everyone's list except the students who took it.
export async function setCourseStatus(coordinatorUserId: string, cpiId: string, status: CourseStatus) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const updated = await prisma.courseInstance.update({
    where: { id: cpiId },
    data: { status },
    select: { id: true, name: true, status: true, batch: true, department: true },
  });

  // Students only learn a course exists when it is published, so that is the
  // moment worth telling them about.
  if (status === CourseStatus.ACTIVE) {
    const students = await prisma.student.findMany({
      where: { batch: updated.batch, department: updated.department },
      select: { userId: true },
    });
    await notifyMany(
      students.map((s) => s.userId),
      {
        type: "COURSE_PUBLISHED",
        title: "A course is open",
        body: `"${updated.name}" is now open for ${updated.batch}.`,
        courseInstanceId: cpiId,
      },
    );
  }

  return updated;
}

// Everyone the course is for, and what they are doing. The admin uploads the
// batch, so the system knows all of them — but until now the coordinator could
// only see the groups that happened to exist, and a student who never started
// was invisible to allocation, sessions and marks alike.
export async function getCourseRoster(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);
  const policy = await prisma.cpiPolicy.findUnique({ where: { courseInstanceId: cpiId } });

  const [students, memberships, approvals] = await Promise.all([
    prisma.student.findMany({
      where: { batch: cpi.batch, department: cpi.department },
      select: { id: true, studentId: true, user: { select: { fullName: true, email: true } } },
      orderBy: { studentId: "asc" },
    }),
    prisma.groupMember.findMany({
      where: { status: InvitationStatus.ACCEPTED, group: { courseInstanceId: cpiId } },
      select: {
        studentId: true,
        group: { select: { id: true, name: true, _count: { select: { members: true } } } },
      },
    }),
    prisma.courseJoinRequest.findMany({
      where: { courseInstanceId: cpiId, status: "APPROVED" },
      select: {
        student: {
          select: { id: true, studentId: true, user: { select: { fullName: true, email: true } } },
        },
      },
    }),
  ]);

  // Approved late joiners belong on the roster even though their batch differs.
  const roll = [...students];
  for (const approval of approvals) {
    if (!roll.some((s) => s.id === approval.student.id)) roll.push(approval.student);
  }

  const byStudent = new Map(memberships.map((m) => [m.studentId, m.group]));
  const target = policy?.targetGroupSize ?? null;

  const rows = roll.map((student) => {
    const group = byStudent.get(student.id) ?? null;
    const size = group?._count.members ?? 0;
    return {
      studentId: student.id,
      indexNumber: student.studentId,
      name: student.user.fullName || student.user.email,
      group: group ? { id: group.id, name: group.name, size } : null,
      // A group of one on a group course is someone working alone, which is
      // allowed and worth telling apart from not having started.
      working: group ? (size === 1 ? "ALONE" : "IN_GROUP") : "NOT_STARTED",
      // Advisory: the batch rarely divides evenly, so this is flagged, never refused.
      offTarget: group !== null && target !== null && size !== target,
    };
  });

  return {
    batch: cpi.batch,
    targetGroupSize: target,
    total: rows.length,
    inGroups: rows.filter((r) => r.working === "IN_GROUP").length,
    alone: rows.filter((r) => r.working === "ALONE").length,
    notStarted: rows.filter((r) => r.working === "NOT_STARTED").length,
    rows,
  };
}

// The batches this department has used, so the create form can suggest them
// rather than relying on a coordinator typing the same code the same way twice.
export async function listDepartmentBatches(coordinatorUserId: string) {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  const courses = await prisma.courseInstance.findMany({
    where: { createdById: coordinatorUserId },
    select: { department: true },
    distinct: ["department"],
  });
  const departments = courses.map((c) => c.department);

  const [fromCourses, fromStudents] = await Promise.all([
    prisma.courseInstance.findMany({
      where: { department: { in: departments } },
      select: { batch: true },
      distinct: ["batch"],
    }),
    prisma.student.findMany({
      where: { department: { in: departments } },
      select: { batch: true },
      distinct: ["batch"],
    }),
  ]);

  return [...new Set([...fromCourses, ...fromStudents].map((r) => r.batch))].sort();
}

// CPIs a lecturer can open (accepted supervisor and/or evaluator/Head Judge),
// with their role(s) in each.
export async function listLecturerCpis(userId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) return [];

  const cpiSelect = { id: true, name: true, department: true, academicYear: true } as const;
  const [supervisorRoles, evaluatorRoles] = await Promise.all([
    prisma.cpiSupervisor.findMany({
      where: { lecturerId: lecturer.id, invitationStatus: InvitationStatus.ACCEPTED },
      include: { courseInstance: { select: cpiSelect } },
    }),
    prisma.cpiEvaluator.findMany({
      where: { lecturerId: lecturer.id },
      include: { courseInstance: { select: cpiSelect } },
    }),
  ]);

  const byId = new Map<string, { id: string; name: string; department: string; academicYear: string; roles: string[] }>();
  const add = (cpi: { id: string; name: string; department: string; academicYear: string }, role: string) => {
    const existing = byId.get(cpi.id);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
    } else {
      byId.set(cpi.id, { ...cpi, roles: [role] });
    }
  };
  for (const s of supervisorRoles) add(s.courseInstance, "Supervisor");
  for (const e of evaluatorRoles) add(e.courseInstance, e.isHeadJudge ? "Head Judge" : "Evaluator");

  return [...byId.values()];
}

// A lecturer's own PENDING supervisor invitations.
export async function listMySupervisorInvites(lecturerUserId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId: lecturerUserId } });
  if (!lecturer) return [];
  const invites = await prisma.cpiSupervisor.findMany({
    where: { lecturerId: lecturer.id, invitationStatus: InvitationStatus.PENDING },
    include: {
      courseInstance: { select: { id: true, name: true, department: true, academicYear: true } },
    },
    orderBy: { invitedAt: "desc" },
  });
  return invites.map((i) => ({
    cpiId: i.courseInstanceId,
    invitedAt: i.invitedAt,
    courseInstance: i.courseInstance,
  }));
}

export async function respondToSupervisorInvite(
  lecturerUserId: string,
  cpiId: string,
  decision: "ACCEPT" | "DECLINE",
) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId: lecturerUserId } });
  if (!lecturer) {
    throw new AuthError(403, "Only the invited lecturer can respond to this invitation");
  }

  const invite = await prisma.cpiSupervisor.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (!invite) {
    throw new AuthError(404, "No supervisor invitation found for you on this CPI");
  }
  if (invite.invitationStatus !== InvitationStatus.PENDING) {
    throw new AuthError(409, `Invitation already ${invite.invitationStatus.toLowerCase()}`);
  }

  return prisma.cpiSupervisor.update({
    where: { id: invite.id },
    data: {
      invitationStatus: decision === "ACCEPT" ? InvitationStatus.ACCEPTED : InvitationStatus.DECLINED,
      respondedAt: new Date(),
    },
  });
}

// Applies a preset to the policy. A preset is a starting point, not a lock: it
// writes only the handful of settings it has an opinion about, leaves every
// other one untouched, and refuses nothing — a Coordinator-Managed course may
// still run supervisors. Re-applying one later is how a coordinator resets an
// area they have edited into a corner.
export async function applyPreset(coordinatorUserId: string, cpiId: string, mode: CpiMode) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const preset = createPolicyData(mode);

  const [cpi] = await prisma.$transaction([
    prisma.courseInstance.update({ where: { id: cpiId }, data: { mode } }),
    prisma.cpiPolicy.upsert({
      where: { courseInstanceId: cpiId },
      update: preset,
      create: { courseInstanceId: cpiId, ...preset },
    }),
  ]);

  return cpi;
}

export function applyCoordinatorManagedPreset(coordinatorUserId: string, cpiId: string) {
  return applyPreset(coordinatorUserId, cpiId, CpiMode.COORDINATOR_MANAGED);
}

export async function assignEvaluator(coordinatorUserId: string, cpiId: string, lecturerUserId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const lecturer = await loadApprovedLecturer(lecturerUserId);

  const existing = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (existing) {
    throw new AuthError(409, "This lecturer is already an evaluator for this CPI");
  }

  // Evaluators exist in both modes — evaluation happens regardless of whether
  // the CPI is supervisor-led. No mode change here.
  return prisma.cpiEvaluator.create({
    data: { courseInstanceId: cpiId, lecturerId: lecturer.id },
  });
}

export async function setHeadJudge(coordinatorUserId: string, cpiId: string, lecturerUserId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const lecturer = await loadApprovedLecturer(lecturerUserId);

  const evaluator = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  if (!evaluator) {
    throw new AuthError(400, "Head Judge must be assigned from the evaluator pool — assign as evaluator first");
  }

  // Exactly one Head Judge per CPI: demote any current holder and promote the
  // target in one transaction (spec 3.3 Step 3).
  await prisma.$transaction([
    prisma.cpiEvaluator.updateMany({
      where: { courseInstanceId: cpiId, isHeadJudge: true },
      data: { isHeadJudge: false },
    }),
    prisma.cpiEvaluator.update({ where: { id: evaluator.id }, data: { isHeadJudge: true } }),
  ]);

  return prisma.cpiEvaluator.findUnique({ where: { id: evaluator.id } });
}

// --- internal helpers ---

// CPI-scope enforcement (spec 9.2): a coordinator may only touch CPIs they own —
// 404 if non-existent, 403 if someone else's. Reused by other CPI-scoped modules.
export async function loadOwnedCpi(coordinatorUserId: string, cpiId: string): Promise<CourseInstance> {
  await assertRole(coordinatorUserId, Role.COURSE_COORDINATOR);
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) {
    throw new AuthError(404, "CPI not found");
  }
  if (cpi.createdById !== coordinatorUserId) {
    throw new AuthError(403, "You do not have access to this CPI");
  }
  return cpi;
}

async function loadApprovedLecturer(lecturerUserId: string) {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId: lecturerUserId } });
  if (!lecturer) {
    throw new AuthError(404, "No lecturer profile found for that user");
  }
  if (lecturer.approvalStatus !== LecturerApprovalStatus.APPROVED) {
    throw new AuthError(400, "Lecturer must be approved before being assigned to a CPI");
  }
  return lecturer;
}

function validateTimeline(input: SetTimelineInput) {
  const seen = new Set(input.phases.map((p) => p.phase));
  if (seen.size !== input.phases.length) {
    throw new AuthError(400, "Each phase may be defined at most once");
  }
  for (const p of input.phases) {
    if (p.startDate >= p.endDate) {
      throw new AuthError(400, `${p.phase}: startDate must be before endDate`);
    }
  }
  // Among the phases provided (any subset), starts must be non-decreasing in
  // canonical order — catches out-of-sequence scheduling.
  const included = PHASE_ORDER.filter((phase) => seen.has(phase));
  const byPhase = new Map(input.phases.map((p) => [p.phase, p]));
  for (let i = 1; i < included.length; i++) {
    const prev = byPhase.get(included[i - 1])!;
    const curr = byPhase.get(included[i])!;
    if (curr.startDate < prev.startDate) {
      throw new AuthError(400, `${included[i]} cannot start before ${included[i - 1]}`);
    }
  }
}
