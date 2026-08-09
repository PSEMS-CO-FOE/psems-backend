import { CriterionLevel, PanelRole, PanelScoreVisibility, Prisma, SessionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { isScoringRole } from "../panel/panel.service";
import { loadPolicy, resolveSessionReviewer } from "../shared/cpiMembership";

interface ScoreInput {
  criterionId: string;
  studentId?: string;
  score: number;
  comment?: string;
}

export interface SubmitScoresInput {
  scores: ScoreInput[];
  overallComment?: string;
}

const scoreInclude = {
  criterion: { select: { id: true, name: true, maxScore: true, level: true, orderIndex: true } },
  student: { select: { id: true, studentId: true, user: { select: { fullName: true } } } },
} satisfies Prisma.RubricScoreInclude;

async function loadSession(sessionId: string, cpiId: string) {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: { stage: { select: { id: true, executionWindowStart: true, executionWindowEnd: true, panelScoreVisibility: true } } },
  });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return session;
}

// The one authorization check for scoring: hold a seat with a scoring role.
// It does not matter whether the holder is an evaluator, the supervisor, the
// coordinator or an external guest.
export async function resolveScoringSeat(userId: string, sessionId: string) {
  const seat = await prisma.sessionPanelist.findUnique({
    where: { evaluationSessionId_userId: { evaluationSessionId: sessionId, userId } },
  });
  if (!seat) throw new AuthError(403, "You are not on this session's panel");
  if (!isScoringRole(seat.role)) throw new AuthError(403, "Your role on this panel does not submit marks");
  return seat;
}

export async function submitScores(userId: string, cpiId: string, sessionId: string, input: SubmitScoresInput) {
  const seat = await resolveScoringSeat(userId, sessionId);
  return submitScoresForSeat(seat.id, cpiId, sessionId, input);
}

export async function submitScoresForSeat(
  seatId: string,
  cpiId: string,
  sessionId: string,
  input: SubmitScoresInput,
) {
  const session = await loadSession(sessionId, cpiId);
  const policy = await loadPolicy(cpiId);

  const { executionWindowStart: winStart, executionWindowEnd: winEnd } = session.stage;
  if (winStart && winEnd) {
    const now = new Date();
    if (now < winStart) throw new AuthError(403, "This stage's scoring window has not opened yet");
    if (now > winEnd) throw new AuthError(403, "This stage's scoring window has closed");
  }

  // Scoring is open while a session is still collecting, or reopened for one
  // panelist after a correction request. Once it is with the reviewer, changes
  // must go back through that flow.
  if (session.status === SessionStatus.AWAITING_REVIEW || session.status === SessionStatus.FINALIZED) {
    throw new AuthError(409, "Scoring is closed for this session — it is awaiting or has completed review");
  }
  if (session.status === SessionStatus.CORRECTION_REQUESTED) {
    const review = await prisma.sessionReview.findUnique({ where: { evaluationSessionId: sessionId } });
    if (review?.correctionPanelistId !== seatId) {
      throw new AuthError(409, "Only the panelist asked to correct may resubmit for this session");
    }
  }

  const criteria = await prisma.rubricCriterion.findMany({ where: { evaluationStageId: session.evaluationStageId } });
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const memberIds = await acceptedMemberIds(session.groupId);

  for (const s of input.scores) {
    const criterion = byId.get(s.criterionId);
    if (!criterion) throw new AuthError(400, "A score references a criterion not in this stage");
    if (s.score < 0 || s.score > criterion.maxScore) {
      throw new AuthError(400, `Score for "${criterion.name}" must be between 0 and ${criterion.maxScore}`);
    }
    if (criterion.level === CriterionLevel.INDIVIDUAL) {
      if (!s.studentId) throw new AuthError(400, `"${criterion.name}" is scored per student — a student is required`);
      if (!memberIds.includes(s.studentId)) throw new AuthError(400, "That student is not a member of this group");
    } else if (s.studentId) {
      throw new AuthError(400, `"${criterion.name}" is a group criterion and cannot be scored per student`);
    }
  }

  const existingComment = await prisma.sessionEvaluation.findUnique({ where: { sessionPanelistId: seatId } });
  const overallComment = input.overallComment?.trim() || existingComment?.overallComment;
  if (policy.requireOverallComment && !overallComment) {
    throw new AuthError(400, "An overall comment is required before submitting this evaluation");
  }

  // Replace this seat's scores for the criteria being submitted rather than
  // upserting: studentId is nullable, and Postgres treats NULLs as distinct, so
  // a compound-unique upsert cannot address a group-level row.
  await prisma.$transaction(async (tx) => {
    await tx.rubricScore.deleteMany({
      where: {
        evaluationSessionId: sessionId,
        sessionPanelistId: seatId,
        rubricCriterionId: { in: input.scores.map((s) => s.criterionId) },
      },
    });
    await tx.rubricScore.createMany({
      data: input.scores.map((s) => ({
        evaluationSessionId: sessionId,
        sessionPanelistId: seatId,
        rubricCriterionId: s.criterionId,
        studentId: s.studentId ?? null,
        score: s.score,
        comment: s.comment,
      })),
    });
    if (overallComment) {
      await tx.sessionEvaluation.upsert({
        where: { sessionPanelistId: seatId },
        update: { overallComment },
        create: { sessionPanelistId: seatId, overallComment },
      });
    }
  });

  return getOwnScores(sessionId, seatId);
}

function acceptedMemberIds(groupId: string) {
  return prisma.groupMember
    .findMany({ where: { groupId, status: "ACCEPTED" }, select: { studentId: true } })
    .then((rows) => rows.map((r) => r.studentId));
}

// How many scores one panelist owes: every group criterion once, plus every
// individual criterion once per accepted member.
async function requiredScoreCount(stageId: string, groupId: string) {
  const criteria = await prisma.rubricCriterion.findMany({
    where: { evaluationStageId: stageId },
    select: { level: true },
  });
  if (criteria.length === 0) return 0;
  const members = await acceptedMemberIds(groupId);
  const group = criteria.filter((c) => c.level === CriterionLevel.GROUP).length;
  const individual = criteria.filter((c) => c.level === CriterionLevel.INDIVIDUAL).length;
  return group + individual * members.length;
}

export interface RoleReadiness {
  role: PanelRole;
  minRequired: number;
  finished: number;
  met: boolean;
}

export interface SessionReadiness {
  scoresSubmitted: number;
  panelistsFinished: number;
  roles: RoleReadiness[];
  allRequirementsMet: boolean;
}

// How ready a session is for review — reported, never acted on. Sessions do not
// advance by themselves: at an open event there is no knowable moment when
// "everyone has scored" (people arrive and leave), and even with a fixed panel
// the person running the room is the one who knows it is over. So this tells the
// reviewer where things stand and they decide when to close scoring.
export async function getSessionReadiness(sessionId: string): Promise<SessionReadiness | null> {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: { stage: { include: { panelRules: true } } },
  });
  if (!session) return null;

  const policy = await loadPolicy(session.courseInstanceId);
  const required = await requiredScoreCount(session.evaluationStageId, session.groupId);

  const panelists = await prisma.sessionPanelist.findMany({
    where: { evaluationSessionId: sessionId },
    include: { _count: { select: { scores: true } }, evaluation: { select: { id: true } } },
  });

  const finished = (p: (typeof panelists)[number]) =>
    required > 0 && p._count.scores >= required && (!policy.requireOverallComment || p.evaluation !== null);

  const roles = session.stage.panelRules
    .filter((r) => r.minRequired > 0)
    .map((rule) => {
      const count = panelists.filter((p) => p.role === rule.role && finished(p)).length;
      return { role: rule.role, minRequired: rule.minRequired, finished: count, met: count >= rule.minRequired };
    });

  return {
    scoresSubmitted: await prisma.rubricScore.count({ where: { evaluationSessionId: sessionId } }),
    panelistsFinished: panelists.filter(finished).length,
    roles,
    allRequirementsMet: roles.every((r) => r.met),
  };
}

function getOwnScores(sessionId: string, seatId: string) {
  return prisma.rubricScore.findMany({
    where: { evaluationSessionId: sessionId, sessionPanelistId: seatId },
    include: scoreInclude,
    orderBy: [{ criterion: { orderIndex: "asc" } }, { studentId: "asc" }],
  });
}

function allScores(sessionId: string, withNames: boolean) {
  return prisma.rubricScore
    .findMany({
      where: { evaluationSessionId: sessionId },
      include: {
        ...scoreInclude,
        panelist: {
          include: {
            user: { select: { id: true, fullName: true, email: true } },
            guest: { select: { fullName: true, organization: true } },
          },
        },
      },
      orderBy: [{ criterion: { orderIndex: "asc" } }, { studentId: "asc" }],
    })
    .then((rows) =>
      withNames
        ? rows
        : rows.map(({ panelist, ...rest }) => ({
            ...rest,
            panelist: { id: panelist.id, role: panelist.role, user: null, guest: null },
          })),
    );
}

// Score visibility. ISOLATED is the default and keeps the original rule: a
// panelist sees only their own marks until review completes. A coordinator may
// open a stage deliberately (an FYP demonstration where the room marks together),
// which is audit-logged at the point the setting changes.
export async function getSessionScores(userId: string, cpiId: string, sessionId: string) {
  const session = await loadSession(sessionId, cpiId);
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { createdById: true } });

  const reviewer = await resolveSessionReviewer(sessionId);
  if (reviewer?.userId === userId) return allScores(sessionId, true);

  const seat = await prisma.sessionPanelist.findUnique({
    where: { evaluationSessionId_userId: { evaluationSessionId: sessionId, userId } },
  });

  if (session.stage.panelScoreVisibility !== PanelScoreVisibility.ISOLATED && seat) {
    return allScores(sessionId, session.stage.panelScoreVisibility === PanelScoreVisibility.OPEN_WITH_NAMES);
  }

  if (cpi?.createdById === userId) {
    if (session.status !== SessionStatus.FINALIZED) {
      throw new AuthError(403, "Scores are visible to the coordinator only after the session is reviewed");
    }
    return allScores(sessionId, true);
  }

  if (!seat) throw new AuthError(403, "You cannot view scores for this session");
  return getOwnScores(sessionId, seat.id);
}
