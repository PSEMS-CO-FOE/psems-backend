import { env } from "../../config/env";

// Thin client for the Python ML service. Every call is fail-soft: ML is an
// enhancement, never a dependency of the lifecycle, so a slow or absent service
// degrades the feature rather than failing the request that triggered it.
// Disabled entirely when ML_SERVICE_URL is unset.

// Draft assistance runs while a student types, so it must fail fast. Document
// analysis parses and embeds a whole PDF (~18s for a 23-page proposal) and is
// user-initiated, so it gets a much longer budget.
const TIMEOUT_MS = 8_000;
const ANALYSIS_TIMEOUT_MS = 120_000;

export interface SupervisorSuggestion {
  lecturer_id: string;
  name: string;
  research_interests: string;
  match_percent: number;
}

export interface SimilarProject {
  idea_id: string;
  title: string | null;
  similarity: number;
  tier: "high" | "moderate" | "low";
}

export interface SimilarityResult {
  flagged: boolean;
  tier: string;
  similar_projects: SimilarProject[];
}

export interface ProposalAnalysis {
  proposal_id: string;
  title: string;
  sections_found: string[];
  missing_required: string[];
  keywords: { keyword: string; score: number; confidence: string }[];
  research_area: { primary_area: string; sub_area: string | null; confidence: number };
  technologies: { name: string; category: string }[];
  complexity: { complexity: string; reasons: string[] };
}

export function mlEnabled(): boolean {
  return Boolean(env.ML_SERVICE_URL);
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  if (!mlEnabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.ML_SERVICE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      console.warn(`[ml] ${path} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    // Timeout, connection refused, bad JSON — all non-fatal by design.
    console.warn(`[ml] ${path} unavailable:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function health(): Promise<{ status: string } | null> {
  return call("/health");
}

export function recommendSupervisors(text: string, k = 3): Promise<{ recommendations: SupervisorSuggestion[] } | null> {
  return call("/features/supervisor-recommendation", {
    method: "POST",
    body: JSON.stringify({ text, k }),
  });
}

export function checkSimilarity(text: string, k = 5): Promise<SimilarityResult | null> {
  return call("/features/similarity-check", {
    method: "POST",
    body: JSON.stringify({ text, k }),
  });
}

export function analyzeProposal(params: {
  path: string;
  proposal_id: string;
  idea_id?: string;
  group_id?: string;
}): Promise<ProposalAnalysis | null> {
  return call("/proposals/analyze", { method: "POST", body: JSON.stringify(params) },
    ANALYSIS_TIMEOUT_MS);
}

export function proposalSummary(proposalId: string): Promise<{ summary: string } | null> {
  return call(`/proposals/${proposalId}/summary`, { method: "POST" }, ANALYSIS_TIMEOUT_MS);
}

export function proposalFeedback(
  proposalId: string,
): Promise<{ missing_required: string[]; suggestions: Record<string, string> } | null> {
  return call(`/proposals/${proposalId}/feedback`, { method: "POST" }, ANALYSIS_TIMEOUT_MS);
}
