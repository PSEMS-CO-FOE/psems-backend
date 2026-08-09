import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { submitScoresForSeat, SubmitScoresInput } from "../scoring/scoring.service";
import { isScoringRole, resolveGuestToken } from "./panel.service";

// Everything a guest can act on, resolved purely from their link. They never see
// the wider course — only the sessions they hold a seat on, and for each one the
// rubric, the group's members, and whatever they have already submitted.
export async function getGuestWorkspace(token: string) {
  const guest = await resolveGuestToken(token);

  const sessions = await Promise.all(
    guest.panelSeats.map(async (seat) => {
      const [criteria, members, ownScores, evaluation] = await Promise.all([
        prisma.rubricCriterion.findMany({
          where: { evaluationStageId: seat.session.evaluationStageId },
          orderBy: { orderIndex: "asc" },
          select: { id: true, name: true, description: true, weight: true, maxScore: true, level: true },
        }),
        prisma.groupMember.findMany({
          where: { groupId: seat.session.groupId, status: "ACCEPTED" },
          select: { student: { select: { id: true, studentId: true, user: { select: { fullName: true } } } } },
        }),
        prisma.rubricScore.findMany({
          where: { sessionPanelistId: seat.id },
          select: { rubricCriterionId: true, studentId: true, score: true, comment: true },
        }),
        prisma.sessionEvaluation.findUnique({
          where: { sessionPanelistId: seat.id },
          select: { overallComment: true },
        }),
      ]);

      return {
        panelistId: seat.id,
        role: seat.role,
        sessionId: seat.evaluationSessionId,
        status: seat.session.status,
        scheduledStart: seat.session.scheduledStart,
        location: seat.session.location,
        group: seat.session.group,
        stage: seat.session.stage,
        criteria,
        members: members.map((m) => m.student),
        ownScores,
        overallComment: evaluation?.overallComment ?? null,
      };
    }),
  );

  return {
    guest: { fullName: guest.fullName, email: guest.email, organization: guest.organization },
    courseInstance: guest.courseInstance,
    expiresAt: guest.tokenExpiresAt,
    sessions,
  };
}

export async function submitGuestScores(token: string, sessionId: string, input: SubmitScoresInput) {
  const guest = await resolveGuestToken(token);

  const seat = guest.panelSeats.find((s) => s.evaluationSessionId === sessionId);
  if (!seat) throw new AuthError(403, "This link does not cover that session");
  if (!isScoringRole(seat.role)) throw new AuthError(403, "Your role on this panel does not submit marks");

  return submitScoresForSeat(seat.id, guest.courseInstanceId, sessionId, input);
}
