import { ReviewDecision, RubricScoreStatus, SessionStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { notify, notifyMany } from "../notifications/notifications.service";
import { getSessionReadiness } from "../scoring/scoring.service";
import { resolveSessionReviewer } from "../shared/cpiMembership";

// Who signs a session off depends on policy: the Head Judge when the CPI uses
// one, otherwise the coordinator. Everything below authorises against that
// resolved reviewer rather than a fixed role.
async function assertReviewer(userId: string, sessionId: string) {
  const reviewer = await resolveSessionReviewer(sessionId);
  if (!reviewer || reviewer.userId !== userId) {
    throw new AuthError(403, "Only this session's reviewer can perform this action");
  }
  return reviewer;
}

async function loadSession(sessionId: string, cpiId: string) {
  const session = await prisma.evaluationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return session;
}

function displayName(panelist: {
  user: { fullName: string; email: string } | null;
  guest: { fullName: string; organization: string | null } | null;
}) {
  if (panelist.user) return { name: panelist.user.fullName || panelist.user.email, affiliation: null };
  if (panelist.guest) return { name: panelist.guest.fullName, affiliation: panelist.guest.organization };
  return { name: "Unknown", affiliation: null };
}

// Side-by-side scores grouped by criterion, with a per-criterion deviation flag
// (spec: "all scores side-by-side with statistical deviation indicators").
// Individual criteria are grouped per student as well, so a reviewer can see
// where members of one group diverged.
export async function reviewSession(userId: string, cpiId: string, sessionId: string) {
  await assertReviewer(userId, sessionId);
  const session = await loadSession(sessionId, cpiId);

  const scores = await prisma.rubricScore.findMany({
    where: { evaluationSessionId: sessionId },
    include: {
      criterion: { select: { id: true, name: true, maxScore: true, level: true, orderIndex: true } },
      student: { select: { id: true, studentId: true, user: { select: { fullName: true } } } },
      panelist: {
        include: {
          user: { select: { id: true, email: true, fullName: true } },
          guest: { select: { fullName: true, organization: true } },
        },
      },
    },
  });

  const buckets = new Map<string, typeof scores>();
  for (const s of scores) {
    const key = `${s.rubricCriterionId}::${s.studentId ?? ""}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(s);
    buckets.set(key, bucket);
  }

  const criteria = [...buckets.values()]
    .map((bucket) => {
      const values = bucket.map((g) => g.score);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const spread = Math.max(...values) - Math.min(...values);
      const maxScore = bucket[0].criterion.maxScore;
      return {
        criterionId: bucket[0].rubricCriterionId,
        name: bucket[0].criterion.name,
        level: bucket[0].criterion.level,
        student: bucket[0].student,
        maxScore,
        mean: Number(mean.toFixed(2)),
        spread,
        // Flag material disagreement: spread over 20% of the criterion's max.
        flagged: spread > 0.2 * maxScore,
        scores: bucket.map((g) => ({
          panelistId: g.sessionPanelistId,
          role: g.panelist.role,
          ...displayName(g.panelist),
          userId: g.panelist.user?.id ?? null,
          score: g.score,
          comment: g.comment,
          deviation: Number((g.score - mean).toFixed(2)),
        })),
        orderIndex: bucket[0].criterion.orderIndex,
      };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex || (a.student?.studentId ?? "").localeCompare(b.student?.studentId ?? ""));

  const panelists = await prisma.sessionPanelist.findMany({
    where: { evaluationSessionId: sessionId },
    include: {
      user: { select: { id: true, email: true, fullName: true } },
      guest: { select: { fullName: true, organization: true } },
      evaluation: { select: { overallComment: true, submittedAt: true } },
    },
    orderBy: { joinedAt: "asc" },
  });

  return {
    sessionId,
    status: session.status,
    readiness: await getSessionReadiness(sessionId),
    criteria,
    // The mandatory end-of-evaluation comments, which the reviewer reads
    // alongside the numbers.
    overallComments: panelists
      .filter((p) => p.evaluation)
      .map((p) => ({
        panelistId: p.id,
        role: p.role,
        ...displayName(p),
        comment: p.evaluation!.overallComment,
        submittedAt: p.evaluation!.submittedAt,
      })),
  };
}

// End marking for a session. Deliberately manual: nothing advances on its own,
// because only the person running the room knows when it is over — at an open
// event people arrive and leave, and even a fixed panel can lose someone. The
// reviewer sees how far short of the stage's requirements they are (readiness)
// and decides; closing early is allowed and audit-logged, since a no-show must
// not be able to strand a group's mark.
export async function closeScoring(userId: string, cpiId: string, sessionId: string) {
  await assertReviewer(userId, sessionId);
  const session = await loadSession(sessionId, cpiId);

  if (session.status === SessionStatus.FINALIZED) {
    throw new AuthError(409, "This session is already approved");
  }
  if (session.status === SessionStatus.AWAITING_REVIEW) {
    throw new AuthError(409, "Scoring is already closed for this session");
  }

  const scored = await prisma.rubricScore.count({ where: { evaluationSessionId: sessionId } });
  if (scored === 0) {
    throw new AuthError(409, "No marks have been submitted for this session yet");
  }

  return prisma.evaluationSession.update({
    where: { id: sessionId },
    data: { status: SessionStatus.AWAITING_REVIEW },
    select: { id: true, status: true },
  });
}

// Put an approved or closed session back into marking. Approval is no longer the
// point of no return — aggregation is, because that is when a mark starts being
// treated as a result. Until then the reviewer can re-scrutinise.
export async function reopen(userId: string, cpiId: string, sessionId: string, reason: string) {
  await assertReviewer(userId, sessionId);
  const session = await loadSession(sessionId, cpiId);

  if (session.status === SessionStatus.SCHEDULED) {
    throw new AuthError(409, "This session is already open for marking");
  }

  const aggregated = await prisma.finalMark.findUnique({
    where: {
      groupId_evaluationStageId: { groupId: session.groupId, evaluationStageId: session.evaluationStageId },
    },
  });
  if (aggregated) {
    throw new AuthError(409, "Marks for this stage have been aggregated — this session can no longer be reopened");
  }

  await prisma.$transaction([
    prisma.rubricScore.updateMany({
      where: { evaluationSessionId: sessionId },
      data: { status: RubricScoreStatus.PENDING },
    }),
    prisma.evaluationSession.update({ where: { id: sessionId }, data: { status: SessionStatus.SCHEDULED } }),
    prisma.sessionReview.upsert({
      where: { evaluationSessionId: sessionId },
      update: { decision: ReviewDecision.CORRECTION_REQUESTED, reason, correctionPanelistId: null, reviewerUserId: userId },
      create: {
        evaluationSessionId: sessionId,
        reviewerUserId: userId,
        decision: ReviewDecision.CORRECTION_REQUESTED,
        reason,
      },
    }),
  ]);

  // Everyone who already marked needs to know their scores are live again.
  const panelists = await prisma.sessionPanelist.findMany({
    where: { evaluationSessionId: sessionId, userId: { not: null } },
    select: { userId: true },
  });
  await notifyMany(
    panelists.map((p) => p.userId!),
    {
      type: "SESSION_REOPENED",
      title: "An evaluation was reopened",
      body: `Marking has been reopened for review. Reason: ${reason}`,
      courseInstanceId: cpiId,
    },
  );

  return { id: sessionId, status: SessionStatus.SCHEDULED };
}

export async function approve(userId: string, cpiId: string, sessionId: string) {
  await assertReviewer(userId, sessionId);
  const session = await loadSession(sessionId, cpiId);

  if (session.status !== SessionStatus.AWAITING_REVIEW) {
    throw new AuthError(409, "Close scoring for this session before approving it");
  }

  await prisma.$transaction([
    prisma.rubricScore.updateMany({
      where: { evaluationSessionId: sessionId },
      data: { status: RubricScoreStatus.FINALIZED },
    }),
    prisma.evaluationSession.update({ where: { id: sessionId }, data: { status: SessionStatus.FINALIZED } }),
    prisma.sessionReview.upsert({
      where: { evaluationSessionId: sessionId },
      update: { decision: ReviewDecision.APPROVED, reason: null, correctionPanelistId: null, reviewerUserId: userId },
      create: { evaluationSessionId: sessionId, reviewerUserId: userId, decision: ReviewDecision.APPROVED },
    }),
  ]);

  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { createdById: true } });
  if (cpi && cpi.createdById !== userId) {
    await notify(cpi.createdById, {
      type: "SCORES_FINALIZED",
      title: "Scores finalized",
      body: "An evaluation session was approved at review; its marks are finalized.",
      courseInstanceId: cpiId,
    });
  }

  return prisma.sessionReview.findUnique({ where: { evaluationSessionId: sessionId } });
}

export async function requestCorrection(
  userId: string,
  cpiId: string,
  sessionId: string,
  panelistId: string,
  reason: string,
) {
  await assertReviewer(userId, sessionId);
  const session = await loadSession(sessionId, cpiId);
  if (session.status === SessionStatus.FINALIZED) {
    throw new AuthError(409, "This session is finalized — cannot request corrections");
  }

  const target = await prisma.sessionPanelist.findUnique({
    where: { id: panelistId },
    include: { user: { select: { id: true } } },
  });
  if (!target || target.evaluationSessionId !== sessionId) {
    throw new AuthError(400, "That panelist is not on this session");
  }

  await prisma.$transaction([
    prisma.evaluationSession.update({ where: { id: sessionId }, data: { status: SessionStatus.CORRECTION_REQUESTED } }),
    prisma.sessionReview.upsert({
      where: { evaluationSessionId: sessionId },
      update: {
        decision: ReviewDecision.CORRECTION_REQUESTED,
        reason,
        correctionPanelistId: panelistId,
        reviewerUserId: userId,
      },
      create: {
        evaluationSessionId: sessionId,
        reviewerUserId: userId,
        decision: ReviewDecision.CORRECTION_REQUESTED,
        reason,
        correctionPanelistId: panelistId,
      },
    }),
  ]);

  if (target.userId) {
    await notify(target.userId, {
      type: "CORRECTION_REQUESTED",
      title: "Score correction requested",
      body: `The reviewer asked you to revise your scores. Reason: ${reason}`,
      courseInstanceId: cpiId,
      email: true,
    });
  }

  return prisma.sessionReview.findUnique({ where: { evaluationSessionId: sessionId } });
}
