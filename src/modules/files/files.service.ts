import crypto from "crypto";
import { CpiPhase } from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { getStudentGroupId } from "../shared/cpiMembership";
import { storage } from "./storage";

export interface UploadedFile {
  buffer: Buffer;
  originalName: string;
  size: number;
  mimeType: string;
}

// A group member uploads a file for a submission stage. SOFT deadline (spec 3.3
// Step 9): once the window opens, a late upload is accepted and flagged (isLate)
// rather than rejected — so this is not hard phase-gated.
export async function submitProposal(userId: string, cpiId: string, stageId: string, file: UploadedFile) {
  const groupId = await getStudentGroupId(userId, cpiId);
  if (!groupId) throw new AuthError(403, "Only a member of a group in this CPI can submit");

  const stage = await prisma.evaluationStage.findUnique({ where: { id: stageId } });
  if (!stage || stage.courseInstanceId !== cpiId) throw new AuthError(404, "Stage not found in this CPI");
  if (!stage.submissionRequired) throw new AuthError(400, "This stage does not require a submission");

  // Prefer the stage's own submission window; fall back to the CPI's
  // PROPOSAL_SUBMISSION phase when the stage doesn't define one. This lets each
  // submission stage (Proposal, Mid, Final, Report) carry its own deadline.
  let windowStart: Date;
  let windowEnd: Date;
  if (stage.submissionWindowStart && stage.submissionWindowEnd) {
    windowStart = stage.submissionWindowStart;
    windowEnd = stage.submissionWindowEnd;
  } else {
    const phase = await prisma.cpiTimeline.findUnique({
      where: { courseInstanceId_phase: { courseInstanceId: cpiId, phase: CpiPhase.PROPOSAL_SUBMISSION } },
    });
    if (!phase) throw new AuthError(403, "The submission window has not been scheduled");
    windowStart = phase.startDate;
    windowEnd = phase.endDate;
  }

  const now = new Date();
  if (now < windowStart) {
    throw new AuthError(403, `Submissions open at ${windowStart.toISOString()}`);
  }
  const isLate = now > windowEnd;

  const objectKey = `cpi/${cpiId}/stage/${stageId}/group/${groupId}/${crypto.randomUUID()}-${file.originalName}`;
  const { storagePath } = await storage.save(objectKey, file.buffer, file.mimeType);

  // One current submission per group per stage; resubmitting replaces it.
  return prisma.submission.upsert({
    where: { groupId_evaluationStageId: { groupId, evaluationStageId: stageId } },
    update: { storagePath, fileName: file.originalName, fileSize: file.size, isLate, submittedAt: now },
    create: {
      courseInstanceId: cpiId,
      groupId,
      evaluationStageId: stageId,
      storagePath,
      fileName: file.originalName,
      fileSize: file.size,
      isLate,
    },
  });
}

// Coordinator sees all submissions (incl. late flags for review); a student
// sees only their own group's.
export async function listSubmissions(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  if (cpi.createdById === userId) {
    await loadOwnedCpi(userId, cpiId); // re-assert coordinator role
    return prisma.submission.findMany({
      where: { courseInstanceId: cpiId },
      include: { group: { select: { id: true, name: true } }, stage: { select: { id: true, name: true } } },
      orderBy: { submittedAt: "desc" },
    });
  }

  const groupId = await getStudentGroupId(userId, cpiId);
  if (!groupId) throw new AuthError(403, "You are not a participant in this CPI");
  return prisma.submission.findMany({
    where: { groupId },
    include: { stage: { select: { id: true, name: true } } },
    orderBy: { submittedAt: "desc" },
  });
}
