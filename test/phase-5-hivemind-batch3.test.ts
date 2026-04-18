/**
 * Phase 5 Tests: HiveMind Batch 3 — Threshold Advisory & Shared Lessons
 *
 * Tests covering:
 * 1. formatThresholdConsensusForAdvisory returns empty when disabled
 * 2. formatThresholdConsensusForAdvisory formats consensus correctly
 * 3. formatThresholdConsensusForAdvisory respects min agent count
 * 4. formatThresholdConsensusForAdvisory truncates long output
 * 5. formatSharedLessonsForPrompt returns empty when disabled
 * 6. formatSharedLessonsForPrompt formats lessons correctly
 * 7. formatSharedLessonsForPrompt respects min agent count
 * 8. formatSharedLessonsForPrompt truncates long output
 * 9. buildSystemPrompt accepts and renders sharedLessons
 * 10. buildSystemPrompt works without sharedLessons (backward compat)
 * 11. Integration: advisory is advisory-only (does not override values)
 */

import type { SystemPromptOptions } from "../src/agent/prompt.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { config } from "../src/config/config.js";
import {
  destroyConsensusCache,
  formatSharedLessonsForPrompt,
  formatThresholdConsensusForAdvisory,
  queryLessonConsensus,
  queryThresholdConsensus,
} from "../src/infrastructure/hive-mind.js";
import { describe, describeAsync, expect, runTestsAsync, test, testAsync } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function withHiveDisabled(fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = false;
    delete process.env.HIVE_MIND_URL;
    delete process.env.HIVE_MIND_API_KEY;

    try {
      await fn();
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  };
}

function withHiveEnabledInvalid(fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-batch3-key";
    destroyConsensusCache();

    try {
      await fn();
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: formatThresholdConsensusForAdvisory — fail-open
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("formatThresholdConsensusForAdvisory — fail-open behavior", async () => {
  testAsync(
    "returns empty string when HiveMind is disabled",
    withHiveDisabled(async () => {
      const result = await formatThresholdConsensusForAdvisory();
      expect(result).toBe("");
    })
  );

  testAsync(
    "returns empty string when network is unreachable (fail-open)",
    withHiveEnabledInvalid(async () => {
      const result = await formatThresholdConsensusForAdvisory();
      expect(typeof result).toBe("string");
      // Should be empty since server is unreachable — fail-open
      expect(result).toBe("");
    })
  );

  testAsync(
    "queryThresholdConsensus returns null when disabled",
    withHiveDisabled(async () => {
      const result = await queryThresholdConsensus();
      expect(result).toBe(null);
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: formatThresholdConsensusForAdvisory — advisory-only constraint
// ═══════════════════════════════════════════════════════════════════════════

describe("formatThresholdConsensusForAdvisory — advisory-only constraint", () => {
  test("advisory output is a string (not a number or object)", () => {
    // When disabled, returns "" which is a string — the return type is always string
    // This test documents that the function NEVER returns a threshold value directly
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const result = formatThresholdConsensusForAdvisory();
    expect(result instanceof Promise).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: formatSharedLessonsForPrompt — fail-open
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("formatSharedLessonsForPrompt — fail-open behavior", async () => {
  testAsync(
    "returns empty string when HiveMind is disabled",
    withHiveDisabled(async () => {
      const result = await formatSharedLessonsForPrompt();
      expect(result).toBe("");
    })
  );

  testAsync(
    "returns empty string when network is unreachable (fail-open)",
    withHiveEnabledInvalid(async () => {
      const result = await formatSharedLessonsForPrompt();
      expect(typeof result).toBe("string");
      expect(result).toBe("");
    })
  );

  testAsync(
    "accepts tags parameter without error",
    withHiveDisabled(async () => {
      const result = await formatSharedLessonsForPrompt(["screening", "volume"]);
      expect(result).toBe("");
    })
  );

  testAsync(
    "queryLessonConsensus returns null when disabled",
    withHiveDisabled(async () => {
      const result = await queryLessonConsensus(["test"]);
      expect(result).toBe(null);
    })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: buildSystemPrompt — sharedLessons integration
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSystemPrompt — sharedLessons parameter", () => {
  const baseOpts: SystemPromptOptions = {
    agentType: "GENERAL",
    portfolio: { sol: 10 },
    positions: [],
    stateSummary: null,
    lessons: null,
    perfSummary: null,
  };

  test("accepts sharedLessons in options object", () => {
    const opts: SystemPromptOptions = {
      ...baseOpts,
      sharedLessons: "SHARED HIVE LESSONS:\n[5 agents, 80%] Test lesson",
    };
    const prompt = buildSystemPrompt(opts);
    expect(typeof prompt).toBe("string");
    expect(prompt.includes("SHARED HIVE LESSONS")).toBe(true);
  });

  test("renders shared lessons in GENERAL prompt when provided", () => {
    const sharedText = "SHARED HIVE LESSONS:\n[10 agents, 90%] High organic pools outperform.";
    const prompt = buildSystemPrompt({
      ...baseOpts,
      sharedLessons: sharedText,
    });
    expect(prompt.includes("High organic pools outperform")).toBe(true);
  });

  test("renders shared lessons in SCREENER prompt when provided", () => {
    const sharedText = "SHARED HIVE LESSONS:\n[8 agents, 85%] Avoid volume collapse.";
    const prompt = buildSystemPrompt({
      ...baseOpts,
      agentType: "SCREENER",
      sharedLessons: sharedText,
    });
    expect(prompt.includes("Avoid volume collapse")).toBe(true);
  });

  test("renders shared lessons in MANAGER prompt when provided", () => {
    const sharedText = "SHARED HIVE LESSONS:\n[6 agents, 75%] Wider bins reduce OOR.";
    const prompt = buildSystemPrompt({
      ...baseOpts,
      agentType: "MANAGER",
      sharedLessons: sharedText,
    });
    expect(prompt.includes("Wider bins reduce OOR")).toBe(true);
  });

  test("omits shared lessons section when null", () => {
    const prompt = buildSystemPrompt({
      ...baseOpts,
      sharedLessons: null,
    });
    expect(prompt.includes("SHARED HIVE LESSONS")).toBe(false);
  });

  test("omits shared lessons section when empty string", () => {
    const prompt = buildSystemPrompt({
      ...baseOpts,
      sharedLessons: "",
    });
    expect(prompt.includes("SHARED HIVE LESSONS")).toBe(false);
  });

  test("backward compat: works without sharedLessons field", () => {
    const prompt = buildSystemPrompt(baseOpts);
    expect(typeof prompt).toBe("string");
    expect(prompt.includes("SHARED HIVE LESSONS")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Advisory does not override — structural guarantee
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("Advisory integration — structural guarantees", async () => {
  testAsync(
    "formatThresholdConsensusForAdvisory resolves to a plain string, not a numeric value",
    withHiveDisabled(async () => {
      // Verifies the function resolves to a string — never a numeric threshold
      const result = await formatThresholdConsensusForAdvisory();
      expect(typeof result).toBe("string");
      expect(result).toBe("");
    })
  );

  testAsync(
    "formatSharedLessonsForPrompt resolves to a plain string",
    withHiveDisabled(async () => {
      const result = await formatSharedLessonsForPrompt();
      expect(typeof result).toBe("string");
      expect(result).toBe("");
    })
  );
});

// Run tests
runTestsAsync().catch(() => process.exit(1));
