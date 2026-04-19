/**
 * Hive Mind — prompt adapters.
 *
 * Formats consensus data for LLM prompt injection.
 * Advisory-only — never overrides local analysis.
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
} from "./config.js";
import { queryLessonConsensus, queryPoolConsensus, queryThresholdConsensus } from "./consensus.js";

/**
 * Fetch threshold consensus and format as an advisory string for the
 * threshold evolution pipeline. Advisory only — never overrides local
 * analysis. Returns empty string when disabled or unavailable.
 */
export async function formatThresholdConsensusForAdvisory(): Promise<string> {
  try {
    if (!isEnabled()) return "";

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

/**
 * Fetch shared lesson consensus from the hive and format for prompt
 * injection. Returns empty string when disabled or no data available.
 * Bounded to MAX_SHARED_LESSONS entries to prevent prompt bloat.
 */
export async function formatSharedLessonsForPrompt(tags?: string[]): Promise<string> {
  try {
    if (!isEnabled()) return "";

    const lessons = await queryLessonConsensus(tags);
    if (!lessons || lessons.length === 0) return "";

    // Only include lessons with meaningful consensus
    const filtered = lessons
      .filter((l) => l.agent_count >= MIN_AGENTS_FOR_CONSENSUS && l.consensus_score > 0)
      .slice(0, MAX_SHARED_LESSONS);

    if (filtered.length === 0) return "";

    const lines = filtered.map(
      (l) => `[${l.agent_count} agents, ${l.consensus_score}%] ${l.rule.slice(0, 100)}`
    );

    const header = "SHARED HIVE LESSONS (advisory, from other agents' experience):";
    let output = [header, ...lines].join("\n");

    if (output.length > MAX_SHARED_LESSON_CHARS) {
      output = `${output.slice(0, MAX_SHARED_LESSON_CHARS - 3)}...`;
    }

    return output;
  } catch {
    return "";
  }
}

/**
 * Query multiple pools in parallel and format for LLM prompt injection.
 * Only shows pools with >= 3 agents reporting (filters noise).
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
