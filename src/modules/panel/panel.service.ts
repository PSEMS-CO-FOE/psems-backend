import { randomBytes, createHash } from "node:crypto";
import { MarkCounting, PanelRole, Prisma, SessionPanelist, StagePanelRule } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { notify } from "../notifications/notifications.service";
import { loadPolicy, SCORING_ROLES } from "../shared/cpiMembership";

const GUEST_TOKEN_TTL_DAYS = 14;

export const panelistInclude = {
  user: { select: { id: true, email: true, fullName: true } },
  guest: { select: { id: true, fullName: true, email: true, organization: true, revokedAt: true } },
  evaluation: { select: { overallComment: true, submittedAt: true } },
} satisfies Prisma.SessionPanelistInclude;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// A seat's counting mode falls back to its role's rule, then to COUNTED.
export function effectiveMarkCounting(
  panelist: Pick<SessionPanelist, "role" | "markCounting">,
  rules: Pick<StagePanelRule, "role" | "markCounting">[],
): MarkCounting {
  if (panelist.markCounting) return panelist.markCounting;
  return rules.find((r) => r.role === panelist.role)?.markCounting ?? MarkCounting.COUNTED;
}

async function loadSessionInCpi(sessionId: string, cpiId: string) {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: { stage: { select: { id: true, name: true } } },
  });
  if (!session || session.courseInstanceId !== cpiId) throw new AuthError(404, "Session not found in this CPI");
  return session;
}


export async function seedPanel(sessionId: string) {
  const session = await prisma.evaluationSession.findUnique({
    where: { id: sessionId },
    include: {
      courseInstance: { select: { id: true, createdById: true } },
      stage: { include: { panelRules: true, evaluators: { include: { cpiEvaluator: { include: { lecturer: true } } } } } },
      group: { include: { allocation: { include: { supervisor: true } } } },
    },
  });
  if (!session) return;

  const policy = await loadPolicy(session.courseInstanceId);
  const wants = (role: PanelRole) => session.stage.panelRules.some((r) => r.role === role);
  const seats: Prisma.SessionPanelistCreateManyInput[] = [];

  for (const assignment of session.stage.evaluators) {
    seats.push({
      evaluationSessionId: sessionId,
      role: PanelRole.EVALUATOR,
      userId: assignment.cpiEvaluator.lecturer.userId,
      lecturerId: assignment.cpiEvaluator.lecturerId,
      cpiEvaluatorId: assignment.cpiEvaluatorId,
    });
  }

  const supervisor = session.group.allocation?.supervisor;
  if (supervisor && wants(PanelRole.SUPERVISOR)) {
    seats.push({
      evaluationSessionId: sessionId,
      role: PanelRole.SUPERVISOR,
      userId: supervisor.userId,
      lecturerId: supervisor.id,
    });
  }

  if (wants(PanelRole.COORDINATOR)) {
    seats.push({
      evaluationSessionId: sessionId,
      role: PanelRole.COORDINATOR,
      userId: session.courseInstance.createdById,
    });
  }

  if (policy.headJudgeEnabled) {
    const headJudge = await prisma.cpiEvaluator.findFirst({
      where: { courseInstanceId: session.courseInstanceId, isHeadJudge: true },
      include: { lecturer: true },
    });
    if (headJudge) {
      seats.push({
        evaluationSessionId: sessionId,
        role: PanelRole.HEAD_JUDGE,
        userId: headJudge.lecturer.userId,
        lecturerId: headJudge.lecturerId,
        cpiEvaluatorId: headJudge.id,
      });
    }
  }

  if (seats.length > 0) {
    await prisma.sessionPanelist.createMany({ data: seats, skipDuplicates: true });
  }
}

export async function listPanel(userId: string, cpiId: string, sessionId: string) {
  const session = await loadSessionInCpi(sessionId, cpiId);
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId }, select: { createdById: true } });

  const isCoordinator = cpi?.createdById === userId;
  const seat = await prisma.sessionPanelist.findUnique({
    where: { evaluationSessionId_userId: { evaluationSessionId: sessionId, userId } },
  });
  if (!isCoordinator && !seat) throw new AuthError(403, "You are not on this session's panel");

  const [panelists, rules] = await Promise.all([
    prisma.sessionPanelist.findMany({
      where: { evaluationSessionId: sessionId },
      include: panelistInclude,
      orderBy: { joinedAt: "asc" },
    }),
    prisma.stagePanelRule.findMany({ where: { evaluationStageId: session.evaluationStageId } }),
  ]);

  return {
    sessionId,
    stage: session.stage,
    rules,
    panelists: panelists.map((p) => ({ ...p, effectiveMarkCounting: effectiveMarkCounting(p, rules) })),
  };
}

// Add an internal person (any approved lecturer, or the coordinator) to one
// session's panel. Deliberately not restricted to the CPI evaluator pool — the
// pool is a shortlist now, not a gate.
export async function addPanelist(
  coordinatorUserId: string,
  cpiId: string,
  sessionId: string,
  input: { userId: string; role: PanelRole; weightPercent?: number; markCounting?: MarkCounting },
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const session = await loadSessionInCpi(sessionId, cpiId);

  const user = await prisma.user.findUnique({ where: { id: input.userId }, include: { lecturer: true } });
  if (!user) throw new AuthError(404, "User not found");

  await assertRoleHasCapacity(session.evaluationStageId, input.role, sessionId);

  const cpiEvaluator = user.lecturer
    ? await prisma.cpiEvaluator.findUnique({
        where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: user.lecturer.id } },
      })
    : null;

  const existing = await prisma.sessionPanelist.findUnique({
    where: { evaluationSessionId_userId: { evaluationSessionId: sessionId, userId: input.userId } },
  });
  if (existing) throw new AuthError(409, "That person already holds a seat on this panel");

  const panelist = await prisma.sessionPanelist.create({
    data: {
      evaluationSessionId: sessionId,
      role: input.role,
      userId: input.userId,
      lecturerId: user.lecturer?.id ?? null,
      cpiEvaluatorId: cpiEvaluator?.id ?? null,
      weightPercent: input.weightPercent ?? null,
      markCounting: input.markCounting ?? null,
      addedById: coordinatorUserId,
    },
    include: panelistInclude,
  });

  await notify(input.userId, {
    type: "PANEL_SEAT_ADDED",
    title: "You have been added to an evaluation panel",
    body: `You are on the panel for "${session.stage.name}" as ${input.role.replace(/_/g, " ").toLowerCase()}.`,
    courseInstanceId: cpiId,
  });

  return panelist;
}

export async function updatePanelist(
  coordinatorUserId: string,
  cpiId: string,
  sessionId: string,
  panelistId: string,
  input: { role?: PanelRole; weightPercent?: number | null; markCounting?: MarkCounting | null },
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const session = await loadSessionInCpi(sessionId, cpiId);

  const panelist = await prisma.sessionPanelist.findUnique({ where: { id: panelistId } });
  if (!panelist || panelist.evaluationSessionId !== sessionId) {
    throw new AuthError(404, "Panelist not found on this session");
  }
  if (input.role && input.role !== panelist.role) {
    await assertRoleHasCapacity(session.evaluationStageId, input.role, sessionId);
  }

  return prisma.sessionPanelist.update({
    where: { id: panelistId },
    data: {
      role: input.role ?? undefined,
      weightPercent: input.weightPercent === undefined ? undefined : input.weightPercent,
      markCounting: input.markCounting === undefined ? undefined : input.markCounting,
    },
    include: panelistInclude,
  });
}

// Removing a seat removes that person's scores with it (the FK cascades), which
// is the point: an evaluator withdrawn from a session should not still be
// counted in its mark. Refused once the session is locked.
export async function removePanelist(coordinatorUserId: string, cpiId: string, sessionId: string, panelistId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const session = await loadSessionInCpi(sessionId, cpiId);
  if (session.status === "FINALIZED") {
    throw new AuthError(409, "This session is finalized — its panel can no longer be changed");
  }

  const panelist = await prisma.sessionPanelist.findUnique({ where: { id: panelistId } });
  if (!panelist || panelist.evaluationSessionId !== sessionId) {
    throw new AuthError(404, "Panelist not found on this session");
  }

  await prisma.sessionPanelist.delete({ where: { id: panelistId } });
  return { removed: panelistId };
}

async function assertRoleHasCapacity(stageId: string, role: PanelRole, sessionId: string) {
  const rule = await prisma.stagePanelRule.findUnique({
    where: { evaluationStageId_role: { evaluationStageId: stageId, role } },
  });
  if (!rule?.maxAllowed) return;

  const held = await prisma.sessionPanelist.count({ where: { evaluationSessionId: sessionId, role } });
  if (held >= rule.maxAllowed) {
    throw new AuthError(409, `This stage allows at most ${rule.maxAllowed} panelist(s) in the ${role} role`);
  }
}

// A lecturer joins a session whose stage is open to all — the FYP demo-day case,
// where nobody is assigned and whoever attends may mark.
export async function joinOpenPanel(userId: string, cpiId: string, sessionId: string, role: PanelRole) {
  const session = await loadSessionInCpi(sessionId, cpiId);

  const rule = await prisma.stagePanelRule.findUnique({
    where: { evaluationStageId_role: { evaluationStageId: session.evaluationStageId, role } },
  });
  if (!rule?.openToAll) throw new AuthError(403, "This evaluation is not open to join");

  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  if (!lecturer || lecturer.approvalStatus !== "APPROVED") {
    throw new AuthError(403, "Only an approved lecturer can join an open panel");
  }

  const existing = await prisma.sessionPanelist.findUnique({
    where: { evaluationSessionId_userId: { evaluationSessionId: sessionId, userId } },
  });
  if (existing) return existing;

  await assertRoleHasCapacity(session.evaluationStageId, role, sessionId);

  const cpiEvaluator = await prisma.cpiEvaluator.findUnique({
    where: { courseInstanceId_lecturerId: { courseInstanceId: cpiId, lecturerId: lecturer.id } },
  });

  return prisma.sessionPanelist.create({
    data: {
      evaluationSessionId: sessionId,
      role,
      userId,
      lecturerId: lecturer.id,
      cpiEvaluatorId: cpiEvaluator?.id ?? null,
    },
    include: panelistInclude,
  });
}

// Invite an external participant to score specific sessions. Returns the raw
// token exactly once — only its hash is stored, so it cannot be recovered later.
export async function inviteGuest(
  coordinatorUserId: string,
  cpiId: string,
  input: { fullName: string; email: string; organization?: string; sessionIds: string[]; role: PanelRole },
) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const sessions = await prisma.evaluationSession.findMany({
    where: { id: { in: input.sessionIds }, courseInstanceId: cpiId },
    select: { id: true },
  });
  if (sessions.length !== input.sessionIds.length) {
    throw new AuthError(404, "One or more sessions were not found in this CPI");
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + GUEST_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const guest = await prisma.guestPanelist.create({
    data: {
      courseInstanceId: cpiId,
      fullName: input.fullName,
      email: input.email,
      organization: input.organization ?? null,
      tokenHash: hashToken(token),
      tokenExpiresAt: expiresAt,
      invitedById: coordinatorUserId,
      panelSeats: {
        create: sessions.map((s) => ({
          evaluationSessionId: s.id,
          role: input.role,
          addedById: coordinatorUserId,
        })),
      },
    },
    include: { panelSeats: true },
  });

  return { guest, token, expiresAt };
}

export async function listGuests(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  return prisma.guestPanelist.findMany({
    where: { courseInstanceId: cpiId },
    orderBy: { createdAt: "desc" },
    include: {
      panelSeats: {
        select: { id: true, role: true, evaluationSessionId: true, session: { select: { stage: { select: { name: true } }, group: { select: { name: true } } } } },
      },
    },
  });
}

export async function revokeGuest(coordinatorUserId: string, cpiId: string, guestId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);
  const guest = await prisma.guestPanelist.findUnique({ where: { id: guestId } });
  if (!guest || guest.courseInstanceId !== cpiId) throw new AuthError(404, "Guest not found in this CPI");

  return prisma.guestPanelist.update({
    where: { id: guestId },
    data: { revokedAt: new Date() },
    select: { id: true, revokedAt: true },
  });
}

// Resolve a guest's magic link into the seats it grants. Guests authenticate
// against one course's sessions only and never become directory users.
export async function resolveGuestToken(token: string) {
  const guest = await prisma.guestPanelist.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      courseInstance: { select: { id: true, name: true } },
      panelSeats: {
        include: {
          session: {
            include: {
              group: { select: { id: true, name: true } },
              stage: { select: { id: true, name: true, panelScoreVisibility: true } },
            },
          },
        },
      },
    },
  });
  if (!guest) throw new AuthError(401, "This scoring link is not valid");
  if (guest.revokedAt) throw new AuthError(401, "This scoring link has been revoked");
  if (guest.tokenExpiresAt < new Date()) throw new AuthError(401, "This scoring link has expired");
  return guest;
}

export function isScoringRole(role: PanelRole) {
  return SCORING_ROLES.includes(role);
}
