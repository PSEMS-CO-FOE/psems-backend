import path from "path";
import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { getStudentGroupId } from "../shared/cpiMembership";
import * as ml from "./ml.client";

// ML-backed helpers. All of these tolerate the ML service being down: callers
// get empty/absent results rather than an error, so no lifecycle step depends
// on ML availability.

// Fire-and-forget: called after an idea is posted so the request that created
// it never waits on ML. Writes the similarityFlag the schema reserves for us.
export function flagSimilarityInBackground(ideaId: string, title: string, description: string): void {
  if (!ml.mlEnabled()) return;
  void (async () => {
    try {
      const result = await ml.checkSimilarity(`${title}. ${description}`);
      if (result?.flagged) {
        await prisma.projectIdea.update({
          where: { id: ideaId },
          data: { similarityFlag: true },
        });
      }
    } catch (err) {
      console.warn("[ml] similarity flagging failed:", (err as Error).message);
    }
  })();
}

// Preview endpoints — used while a student is drafting, before anything is saved.
export async function previewSimilarity(title: string, description: string) {
  const result = await ml.checkSimilarity(`${title}. ${description}`);
  return result ?? { flagged: false, tier: "unavailable", similar_projects: [] };
}

export async function suggestSupervisors(title: string, description: string, k = 3) {
  const result = await ml.recommendSupervisors(`${title}. ${description}`, k);
  return { recommendations: result?.recommendations ?? [] };
}

export async function serviceStatus() {
  if (!ml.mlEnabled()) return { enabled: false, reachable: false };
  const health = await ml.health();
  return { enabled: true, reachable: health !== null, status: health?.status ?? null };
}

// Analyse an uploaded proposal. Access mirrors listSubmissions: the coordinator
// who owns the CPI, or a member of the submitting group — never another group.
export async function analyzeSubmission(userId: string, cpiId: string, submissionId: string) {
  const submission = await prisma.submission.findFirst({
    where: { id: submissionId, courseInstanceId: cpiId },
  });
  if (!submission) throw new AuthError(404, "Submission not found");

  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  if (cpi.createdById === userId) {
    await loadOwnedCpi(userId, cpiId); // re-assert coordinator role
  } else {
    const groupId = await getStudentGroupId(userId, cpiId);
    if (!groupId || groupId !== submission.groupId) {
      throw new AuthError(403, "You cannot view analysis for this submission");
    }
  }

  // The ML service reads the file directly, so it must share this filesystem.
  // True for the single-host pilot; Supabase-backed storage would need the
  // bytes sent instead, so we degrade rather than guess at a path.
  if (env.STORAGE_BACKEND !== "local") {
    return { available: false, reason: "analysis requires local file storage" as const };
  }

  const analysis = await ml.analyzeProposal({
    path: path.resolve(env.STORAGE_DIR, submission.storagePath),
    proposal_id: submission.id,
    group_id: submission.groupId,
  });
  if (!analysis) return { available: false, reason: "ml service unavailable" as const };
  return { available: true as const, analysis };
}
