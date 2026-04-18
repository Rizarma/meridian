/**
 * Hive Mind — prompt adapters.
 *
 * Formats consensus data for LLM prompt injection.
 * Advisory-only — never overrides local analysis.
 *
 * Phase 3: formatSharedLessonsForPrompt and formatThresholdConsensusForAdvisory
 * now source primarily from pull endpoints. Legacy consensus queries are
 * preserved as fallbacks and remain exported.
 */

import { getErrorMessage } from "../../utils/errors.js";
import {
  isEnabled,
  MAX_CONSENSUS_CHARS,
  MAX_SHARED_LESSON_CHARS,
  MAX_SHARED_LESSONS,
  MAX_THRESHOLD_ADVISORY_CHARS,
  MIN_AGENTS_FOR_CONSENSUS,
  MIN_AGENTS_THRESHOLD_ADVISORY,
  readConfig,
} from "./config.js";
import { queryLessonConsensus, queryPoolConsensus, queryThresholdConsensus } from "./consensus.js";
import { pullLessons, pullPresets } from "./pull.js";

// ─── Pull-Based Adapters (Phase 3) ────────────────────────────────────

/**
 * Fetch shared lessons via pull endpoint and format for prompt injection.
 *
 * Primary source: pullLessons(agentId, limit)
 * Fallback: legacy queryLessonConsensus(tags)
 *
 * When tags are provided, filtering is applied locally after pull.
 * Returns empty string when disabled or no data available.
 * Bounded to MAX_SHARED_LESSONS entries and MAX_SHARED_LESSON_CHARS.
 * Fail-open: never throws.
 */
export async function formatSharedLessonsForPrompt(tags?: string[]): Promise<string> {
  try {
    if (!isEnabled()) return "";

    const cfg = readConfig();
    const agentId = cfg.hiveMindAgentId || "";

    // Primary source: pull endpoint
    const lessons = await pullLessons(agentId, MAX_SHARED_LESSONS * 3);

    if (lessons && lessons.length > 0) {
      // Apply local tag filtering if tags are specified
      let filtered = lessons;
      if (tags && tags.length > 0) {
        const tagSet = new Set(tags);
        filtered = lessons.filter(
          (l) => Array.isArray(l.tags) && l.tags.some((t) => tagSet.has(t))
        );
      }

      // Apply limit
      const limited = filtered.slice(0, MAX_SHARED_LESSONS);
      if (limited.length === 0) return "";

      const lines = limited.map((l) => {
        const scorePart = l.score != null ? `, score=${l.score}` : "";
        const ruleText = l.rule.length > 100 ? l.rule.slice(0, 100) : l.rule;
        return `- ${ruleText}${scorePart}`;
      });

      const header = "SHARED HIVE LESSONS (advisory, from other agents' experience):";
      let output = [header, ...lines].join("\n");

      if (output.length > MAX_SHARED_LESSON_CHARS) {
        output = `${output.slice(0, MAX_SHARED_LESSON_CHARS - 3)}...`;
      }

      return output;
    }

    // Fallback: legacy consensus query (preserved for backward compat)
    const legacyLessons = await queryLessonConsensus(tags);
    if (!legacyLessons || legacyLessons.length === 0) return "";

    // Only include lessons with meaningful consensus
    const legacyFiltered = legacyLessons
      .filter((l) => l.agent_count >= MIN_AGENTS_FOR_CONSENSUS && l.consensus_score > 0)
      .slice(0, MAX_SHARED_LESSONS);

    if (legacyFiltered.length === 0) return "";

    const legacyLines = legacyFiltered.map(
      (l) => `[${l.agent_count} agents, ${l.consensus_score}%] ${l.rule.slice(0, 100)}`
    );

    const legacyHeader = "SHARED HIVE LESSONS (advisory, from other agents' experience):";
    let legacyOutput = [legacyHeader, ...legacyLines].join("\n");

    if (legacyOutput.length > MAX_SHARED_LESSON_CHARS) {
      legacyOutput = `${legacyOutput.slice(0, MAX_SHARED_LESSON_CHARS - 3)}...`;
    }

    return legacyOutput;
  } catch {
    return "";
  }
}

/**
 * Fetch threshold/preset consensus and format as an advisory string for the
 * threshold evolution pipeline.
 *
 * Primary source: pullPresets(agentId)
 * If the preset response does not clearly support advisory formatting
 * (i.e. the schema is ambiguous or lacks usable fields), returns empty string.
 * Fallback: legacy queryThresholdConsensus()
 *
 * Advisory only — never overrides local analysis.
 * Returns empty string when disabled or unavailable.
 * Fail-open: never throws.
 */
export async function formatThresholdConsensusForAdvisory(): Promise<string> {
  try {
    if (!isEnabled()) return "";

    const cfg = readConfig();
    const agentId = cfg.hiveMindAgentId || "";

    // Primary source: pull presets endpoint
    const presetsResponse = await pullPresets(agentId);

    if (
      presetsResponse &&
      Array.isArray(presetsResponse.presets) &&
      presetsResponse.presets.length > 0
    ) {
      // Conservative: attempt to format only if presets clearly look like
      // threshold objects with numeric fields. If the shape is ambiguous,
      // return empty string rather than inventing meaning.
      const validPreset = presetsResponse.presets.find((p) => {
        if (p == null || typeof p !== "object") return false;
        // Check if the preset has at least one numeric field that could be a threshold
        const values = Object.values(p);
        return values.some((v) => typeof v === "number");
      });

      if (!validPreset) {
        // Schema is ambiguous — don't invent meaning, fall through to legacy
        // Fall through to legacy below
      } else {
        const preset = validPreset as Record<string, unknown>;
        const lines: string[] = [];

        for (const [field, value] of Object.entries(preset)) {
          if (typeof value === "number") {
            lines.push(`${field}: ${value}`);
          }
        }

        if (lines.length === 0) return "";

        const header = `Hive threshold advisory (from presets, use as context only):`;
        let output = [header, ...lines].join("\n");

        if (output.length > MAX_THRESHOLD_ADVISORY_CHARS) {
          output = `${output.slice(0, MAX_THRESHOLD_ADVISORY_CHARS - 3)}...`;
        }

        return output;
      }
    }

    // Fallback: legacy threshold consensus query
    const consensus = await queryThresholdConsensus();
    if (!consensus || consensus.agent_count < MIN_AGENTS_THRESHOLD_ADVISORY) return "";

    const lines: string[] = [];
    for (const [field, data] of Object.entries(consensus)) {
      if (field === "agent_count") continue;
      // Defensive: skip unexpected/non-object server fields (fail-open)
      if (data == null || typeof data !== "object" || Array.isArray(data)) {
        console.log(
          "[hive]",
          `formatThresholdConsensusForAdvisory: skipping unexpected field "${field}" (type=${typeof data})`
        );
        continue;
      }
      const entry = data as Record<string, unknown>;
      if (typeof entry.median !== "number") continue;
      const spreadStr = typeof entry.spread === "number" ? ` (spread=${entry.spread})` : "";
      lines.push(`${field}: median=${entry.median}${spreadStr}`);
    }

    if (lines.length === 0) return "";

    const header = `Hive threshold advisory (${consensus.agent_count} agents, use as context only):`;
    let output = [header, ...lines].join("\n");

    if (output.length > MAX_THRESHOLD_ADVISORY_CHARS) {
      output = `${output.slice(0, MAX_THRESHOLD_ADVISORY_CHARS - 3)}...`;
    }

    return output;
  } catch {
    return "";
  }
}

// ─── Pool Consensus (unchanged in Phase 3) ────────────────────────────

/**
 * Query multiple pools in parallel and format for LLM prompt injection.
 * Only shows pools with >= 3 agents reporting (filters noise).
 *
 * Phase 3: This adapter is NOT migrated to pull semantics.
 * It continues to use the legacy consensus endpoint.
 */
export async function formatPoolConsensusForPrompt(poolAddresses: string[]): Promise<string> {
  if (!isEnabled() || !Array.isArray(poolAddresses) || poolAddresses.length === 0) {
    return "";
  }

  try {
    const results = await Promise.all(
      poolAddresses.map(async (addr) => {
        const data = await queryPoolConsensus(addr);
        return { addr, data };
      })
    );

    const lines: string[] = [];
    let _poolsWithData = 0;

    for (const { addr, data } of results) {
      if (data && data.unique_agents >= MIN_AGENTS_FOR_CONSENSUS) {
        _poolsWithData++;
        const name = data.pool_name || addr.slice(0, 8);
        const winPct = data.weighted_win_rate ?? 0;
        const avgPnl =
          data.weighted_avg_pnl != null
            ? `${(data.weighted_avg_pnl >= 0 ? "+" : "") + data.weighted_avg_pnl.toFixed(1)}%`
            : "N/A";
        lines.push(
          `[HIVE] ${name}: ${data.unique_agents} agents, ${winPct}% win, ${avgPnl} avg PnL`
        );
      }
    }

    if (lines.length === 0) return "";

    const header = `HIVE MIND CONSENSUS (supplementary — your own analysis takes priority):`;
    let output = [header, ...lines].join("\n");

    if (output.length > MAX_CONSENSUS_CHARS) {
      output = `${output.slice(0, MAX_CONSENSUS_CHARS - 3)}...`;
    }

    return output;
  } catch (e) {
    console.log("[hive]", `formatPoolConsensusForPrompt error: ${getErrorMessage(e)}`);
    return "";
  }
}
