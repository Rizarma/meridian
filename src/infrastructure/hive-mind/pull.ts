/**
 * Hive Mind — original-compatible pull (read) endpoints.
 *
 * Phase 3: Migrates shared-lesson and preset reads toward the
 * original-compatible pull endpoints using `hiveGet`.
 *
 * Each function queries the hive server using GET with proper
 * `accept: application/json` + `x-api-key` headers. All functions
 * fail-open (return null on error, never throw).
 */

import type {
  PulledLesson,
  PullLessonsResponse,
  PullPresetsResponse,
} from "../../types/hive-mind.js";
import { hiveGet } from "./client.js";
import { GET_TIMEOUT_MS, readConfig } from "./config.js";

// ─── Response Normalisers ────────────────────────────────────────────

/**
 * Normalise a raw lesson object from the server into PulledLesson.
 *
 * The original JS client normalises from fields:
 *   id | lessonId, rule, tags, role, outcome, sourceType | source, score, created_at | createdAt
 *
 * This normaliser is conservative: it extracts what it can and leaves
 * the rest undefined. The `rule` field defaults to an empty string
 * so downstream formatting can safely skip it.
 */
export function normalisePulledLesson(raw: Record<string, unknown>): PulledLesson {
  return {
    id: String(raw.id ?? raw.lessonId ?? ""),
    rule: typeof raw.rule === "string" ? raw.rule : "",
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    role: typeof raw.role === "string" ? raw.role : undefined,
    outcome: typeof raw.outcome === "string" ? raw.outcome : undefined,
    sourceType:
      typeof raw.sourceType === "string"
        ? raw.sourceType
        : typeof raw.source === "string"
          ? (raw.source as string)
          : undefined,
    score: typeof raw.score === "number" ? raw.score : undefined,
    createdAt:
      typeof raw.created_at === "string"
        ? raw.created_at
        : typeof raw.createdAt === "string"
          ? raw.createdAt
          : undefined,
  };
}

/**
 * Normalise an array of raw lesson objects.
 * Filters out lessons with empty rules (invalid/unusable).
 */
export function normalisePulledLessons(raws: unknown[]): PulledLesson[] {
  return raws
    .map((r) =>
      r != null && typeof r === "object"
        ? normalisePulledLesson(r as Record<string, unknown>)
        : null
    )
    .filter((l): l is PulledLesson => l !== null && l.rule.length > 0);
}

// ─── Pull Functions ────────────────────────────────────────────────────

/**
 * Pull shared lessons from the hive using the original-compatible endpoint:
 *   GET /api/hivemind/lessons/pull?agentId=...&limit=...
 *
 * Returns normalised PulledLesson[] or null on failure. Fail-open.
 *
 * @param agentId - The requesting agent's ID
 * @param limit   - Optional max number of lessons to request
 */
export async function pullLessons(agentId: string, limit?: number): Promise<PulledLesson[] | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;
    if (!agentId) return null;

    const baseUrl = cfg.hiveMindUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({ agentId });
    if (limit != null && limit > 0) {
      params.set("limit", String(limit));
    }

    const url = `${baseUrl}/api/hivemind/lessons/pull?${params.toString()}`;
    const response = await hiveGet<PullLessonsResponse>(url, cfg.hiveMindApiKey, GET_TIMEOUT_MS);

    if (!response) return null;

    // The original client expects lessons under `payload.lessons`
    // but the top-level response may also contain `lessons` directly.
    const raws = response.lessons ?? (response as Record<string, unknown>).lessons;
    if (!Array.isArray(raws)) return null;

    return normalisePulledLessons(raws as unknown[]);
  } catch {
    return null;
  }
}

/**
 * Pull presets from the hive using the original-compatible endpoint:
 *   GET /api/hivemind/presets/pull?agentId=...
 *
 * Returns the raw PullPresetsResponse or null on failure. Fail-open.
 * Consumers must inspect the response shape before using it.
 *
 * @param agentId - The requesting agent's ID
 */
export async function pullPresets(agentId: string): Promise<PullPresetsResponse | null> {
  try {
    const cfg = readConfig();
    if (!cfg.hiveMindUrl || !cfg.hiveMindApiKey) return null;
    if (!agentId) return null;

    const baseUrl = cfg.hiveMindUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({ agentId });

    const url = `${baseUrl}/api/hivemind/presets/pull?${params.toString()}`;
    const response = await hiveGet<PullPresetsResponse>(url, cfg.hiveMindApiKey, GET_TIMEOUT_MS);

    if (!response) return null;

    return response;
  } catch {
    return null;
  }
}
