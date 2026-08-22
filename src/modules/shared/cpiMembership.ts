import { CpiPolicy, InvitationStatus, PanelRole } from "@prisma/client";
import { prisma } from "../../config/database";

// CPI-scoped membership lookups — authorization by capacity rather than account
// role. Return null (not throw) so callers can branch.

// Panel roles that may submit scores.
//
// HEAD_JUDGE is deliberately excluded: their seat exists so a session has a
// reviewer, and someone who marks and then approves their own marks defeats the
// point of the review step. A course that wants that person marking seats them
// as SENIOR_EVALUATOR instead and lets the coordinator review — the composition
// is a choice, the conflict is not.
export const SCORING_ROLES: PanelRole[] = [
  PanelRole.COORDINATOR,
  PanelRole.SUPERVISOR,
  PanelRole.CO_SUPERVISOR,
  PanelRole.SENIOR_EVALUATOR,
  PanelRole.EVALUATOR,
  PanelRole.JUNIOR_EVALUATOR,
];

// Used when a CPI has no policy row yet. Every CPI gets one at creation and the
// migration backfilled the rest, so this is a safety net rather than a path —
// deliberately a pure value, so reading a policy never writes.
const POLICY_DEFAULTS = {
  allowStudentIdeas: true,
  studentIdeasLeaderOnly: true,
  allowSupervisorIdeas: true,
  allowCoordinatorIdeas: true,
  allowLecturerIdeas: false,
  requireStudentIdeaApproval: false,
  maxIdeasPerGroup: null,
  allowCoSupervisorOnIdea: true,
  interestEnabled: true,
  maxInterestsPerGroup: null,
  allowInterestWithdrawal: true,
  allowLecturerInterestInGroupIdeas: true,
  allowCoSupervisionInterest: true,
  studentsSeeOtherGroupIdeas: false,
  allowSupervisorSelfRequest: true,
  selectionConfirmedBy: "SUPERVISOR",
  allowIndividualParticipation: true,
  targetGroupSize: null,
  autoCreateSoloGroup: true,
  headJudgeEnabled: false,
  requireOverallComment: true,
  availabilityRequiredFrom: "EVALUATORS_ONLY",
  passMarkPercent: null,
  gradingEnabled: false,
  caContributionPercent: null,
} as const;

export type EffectivePolicy = Omit<CpiPolicy, "id" | "courseInstanceId" | "updatedAt">;

// The CPI's behavioural settings. Replaces every rule that used to be derived
// from CpiMode, which is now only a preset label.
export async function loadPolicy(cpiId: string): Promise<EffectivePolicy> {
  const policy = await prisma.cpiPolicy.findUnique({ where: { courseInstanceId: cpiId } });
  return policy ?? (POLICY_DEFAULTS as unknown as EffectivePolicy);
}

// The id of the student's ACCEPTED group in this CPI, or null.
export async function getStudentGroupId(userId: string, cpiId: string): Promise<string | null> {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) return null;
  const membership = await prisma.groupMember.findFirst({
    where: { studentId: student.id, status: InvitationStatus.ACCEPTED, group: { courseInstanceId: cpiId } },
    select: { groupId: true },
  });
  return membership?.groupId ?? null;
}

// The id of the group this student LEADS in this CPI, or null. Group-level
// actions (posting the group's idea, selecting its project) run through this so
// one member cannot speak for the group.
export async function getLeaderGroupId(userId: string, cpiId: string): Promise<string | null> {
  const student = await prisma.student.findUnique({ where: { userId } });
  if (!student) return null;
  const membership = await prisma.groupMember.findFirst({
    where: { studentId: student.id, status: InvitationStatus.ACCEPTED, group: { courseInstanceId: cpiId } },
    include: { group: { select: { id: true, leaderStudentId: true } } },
  });
  if (!membership) return null;
  return membership.group.leaderStudentId === student.id ? membership.group.id : null;
}

// The Lecturer id if this user is an ACCEPTED supervisor of this CPI, or null.
export async function getAcceptedSupervisorLecturerId(userId: string, cpiId: string): Promise<string | null> {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) return null;
  const supervisor = await prisma.cpiSupervisor.findFirst({
    where: { courseInstanceId: cpiId, lecturerId: lecturer.id, invitationStatus: InvitationStatus.ACCEPTED },
  });
  return supervisor ? lecturer.id : null;
}

// The CpiEvaluator row id if this user is in this CPI's evaluator pool, or null.
export async function getCpiEvaluatorId(userId: string, cpiId: string): Promise<string | null> {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) return null;
  const evaluator = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  return evaluator?.id ?? null;
}

// The CpiEvaluator row id if this user is the CPI's default Head Judge, or null.
export async function getHeadJudgeCpiEvaluatorId(userId: string, cpiId: string): Promise<string | null> {
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer) return null;
  const evaluator = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });
  return evaluator?.isHeadJudge ? evaluator.id : null;
}

// This user's seat on a session's panel, or null. The single authorization
// check for scoring: it does not care whether they are an evaluator, the
// supervisor, the coordinator or a guest — only that they hold a seat.
export function getSessionPanelist(userId: string, sessionId: string) {
  return prisma.sessionPanelist.findUnique({
    where: { evaluationSessionId_userId: { evaluationSessionId: sessionId, userId } },
  });
}

// Who signs off a finished session: the Head Judge seat when policy enables one,
// otherwise the CPI's coordinator. Returns null when nobody qualifies yet.
export async function resolveSessionReviewer(
  sessionId: string,
): Promise<{ userId: string; via: "HEAD_JUDGE" | "COORDINATOR" } | null> {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    select: { courseInstanceId: true, courseInstance: { select: { createdById: true } } },
  });
  if (!session) return null;

  const policy = await loadPolicy(session.courseInstanceId);
  if (policy.headJudgeEnabled) {
    const headJudge = await prisma.sessionPanelist.findFirst({
      where: { evaluationSessionId: sessionId, role: PanelRole.HEAD_JUDGE },
      select: { userId: true },
    });
    if (headJudge?.userId) return { userId: headJudge.userId, via: "HEAD_JUDGE" };
  }
  return { userId: session.courseInstance.createdById, via: "COORDINATOR" };
}
