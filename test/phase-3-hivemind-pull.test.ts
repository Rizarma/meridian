/**
 * Phase 3 Tests: HiveMind Pull Migration — Read Endpoints
 *
 * Tests covering:
 * 1. normalisePulledLesson normalises id|lessonId → id
 * 2. normalisePulledLesson normalises created_at|createdAt → createdAt
 * 3. normalisePulledLesson normalises sourceType|source → sourceType
 * 4. normalisePulledLesson returns empty rule for missing/invalid rule
 * 5. normalisePulledLessons filters nulls and empty rules
 * 6. normalisePulledLesson handles all fields present
 * 7. pullLessons returns null when disabled (fail-open)
 * 8. pullPresets returns null when disabled (fail-open)
 * 9. pullLessons returns null when agentId is empty (fail-open)
 * 10. pullPresets returns null when agentId is empty (fail-open)
 * 11. formatSharedLessonsForPrompt returns "" when disabled (fail-open)
 * 12. formatThresholdConsensusForAdvisory returns "" when disabled (fail-open)
 * 13. New pull functions are importable from the backward-compat barrel
 * 14. Legacy consensus query functions remain importable (backward-compat)
 * 15. formatSharedLessonsForPrompt with tag filtering works locally
 */

import { config } from "../src/config/config.js";
import {
  destroyConsensusCache,
  formatSharedLessonsForPrompt,
  formatThresholdConsensusForAdvisory,
  normalisePulledLesson,
  normalisePulledLessons,
  pullLessons,
  pullPresets,
} from "../src/infrastructure/hive-mind.js";
import { describe, describeAsync, expect, runTestsAsync, test, testAsync } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: normalisePulledLesson — field normalisation
// ═══════════════════════════════════════════════════════════════════════════

describe("normalisePulledLesson — field normalisation", () => {
  test("normalises id field", () => {
    const result = normalisePulledLesson({ id: 42, rule: "test" });
    expect(result.id).toBe("42");
  });

  test("normalises lessonId → id when id is absent", () => {
    const result = normalisePulledLesson({ lessonId: "abc-123", rule: "test" });
    expect(result.id).toBe("abc-123");
  });

  test("prefers id over lessonId when both present", () => {
    const result = normalisePulledLesson({ id: 1, lessonId: "abc", rule: "test" });
    expect(result.id).toBe("1");
  });

  test("normalises created_at → createdAt", () => {
    const result = normalisePulledLesson({ rule: "test", created_at: "2025-01-01" });
    expect(result.createdAt).toBe("2025-01-01");
  });

  test("normalises createdAt → createdAt (camelCase passthrough)", () => {
    const result = normalisePulledLesson({ rule: "test", createdAt: "2025-06-15" });
    expect(result.createdAt).toBe("2025-06-15");
  });

  test("prefers created_at over createdAt when both present", () => {
    const result = normalisePulledLesson({ rule: "test", created_at: "a", createdAt: "b" });
    expect(result.createdAt).toBe("a");
  });

  test("normalises sourceType → sourceType", () => {
    const result = normalisePulledLesson({ rule: "test", sourceType: "auto" });
    expect(result.sourceType).toBe("auto");
  });

  test("normalises source → sourceType when sourceType absent", () => {
    const result = normalisePulledLesson({ rule: "test", source: "manual" });
    expect(result.sourceType).toBe("manual");
  });

  test("returns empty string rule when rule is missing", () => {
    const result = normalisePulledLesson({});
    expect(result.rule).toBe("");
  });

  test("returns empty string rule when rule is not a string", () => {
    const result = normalisePulledLesson({ rule: 123 });
    expect(result.rule).toBe("");
  });

  test("preserves valid rule text", () => {
    const result = normalisePulledLesson({ rule: "Avoid low-liquidity pools" });
    expect(result.rule).toBe("Avoid low-liquidity pools");
  });

  test("normalises tags as string array", () => {
    const result = normalisePulledLesson({ rule: "test", tags: ["screening", "liquidity"] });
    expect(result.tags!.length).toBe(2);
    expect(result.tags![0]).toBe("screening");
  });

  test("sets tags to undefined when not an array", () => {
    const result = normalisePulledLesson({ rule: "test", tags: "screening" });
    expect(result.tags).toBe(undefined);
  });

  test("preserves numeric score", () => {
    const result = normalisePulledLesson({ rule: "test", score: 4.5 });
    expect(result.score).toBe(4.5);
  });

  test("sets score to undefined when not a number", () => {
    const result = normalisePulledLesson({ rule: "test", score: "high" });
    expect(result.score).toBe(undefined);
  });

  test("preserves role string", () => {
    const result = normalisePulledLesson({ rule: "test", role: "screener" });
    expect(result.role).toBe("screener");
  });

  test("preserves outcome string", () => {
    const result = normalisePulledLesson({ rule: "test", outcome: "negative" });
    expect(result.outcome).toBe("negative");
  });

  test("all fields together", () => {
    const result = normalisePulledLesson({
      id: 99,
      rule: "Full lesson",
      tags: ["a"],
      role: "manager",
      outcome: "positive",
      sourceType: "auto",
      score: 3,
      created_at: "2025-03-01",
    });
    expect(result.id).toBe("99");
    expect(result.rule).toBe("Full lesson");
    expect(result.tags!.length).toBe(1);
    expect(result.role).toBe("manager");
    expect(result.outcome).toBe("positive");
    expect(result.sourceType).toBe("auto");
    expect(result.score).toBe(3);
    expect(result.createdAt).toBe("2025-03-01");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: normalisePulledLessons — array filtering
// ═══════════════════════════════════════════════════════════════════════════

describe("normalisePulledLessons — array filtering", () => {
  test("filters out entries with empty rules", () => {
    const result = normalisePulledLessons([
      { rule: "Valid lesson" },
      { rule: "" },
      { noRule: true },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].rule).toBe("Valid lesson");
  });

  test("filters out null/undefined entries", () => {
    const result = normalisePulledLessons([null, undefined, { rule: "only valid" }]);
    expect(result.length).toBe(1);
  });

  test("filters out non-object entries", () => {
    const result = normalisePulledLessons(["string", 42, true, { rule: "valid" }]);
    expect(result.length).toBe(1);
  });

  test("returns empty array for all-invalid input", () => {
    const result = normalisePulledLessons([null, { noRule: true }, "bad"]);
    expect(result.length).toBe(0);
  });

  test("handles empty input array", () => {
    const result = normalisePulledLessons([]);
    expect(result.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Fail-open behavior for pull functions
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("pullLessons / pullPresets — fail-open", async () => {
  testAsync("pullLessons returns null when disabled", async () => {
    const origFlag = config.features.hiveMind;
    config.features.hiveMind = false;
    try {
      const result = await pullLessons("agent-001");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
    }
  });

  testAsync("pullPresets returns null when disabled", async () => {
    const origFlag = config.features.hiveMind;
    config.features.hiveMind = false;
    try {
      const result = await pullPresets("agent-001");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
    }
  });

  testAsync("pullLessons returns null with empty agentId", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://example.com";
    process.env.HIVE_MIND_API_KEY = "test-key";

    try {
      const result = await pullLessons("");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  });

  testAsync("pullPresets returns null with empty agentId", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://example.com";
    process.env.HIVE_MIND_API_KEY = "test-key";

    try {
      const result = await pullPresets("");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  });

  testAsync("pullLessons returns null with unreachable server", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-key-pull";

    try {
      const result = await pullLessons("agent-001");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  });

  testAsync("pullPresets returns null with unreachable server", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-key-pull";

    try {
      const result = await pullPresets("agent-001");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  });

  testAsync("pullLessons returns null when no URL configured", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    delete process.env.HIVE_MIND_URL;
    process.env.HIVE_MIND_API_KEY = "test-key";

    try {
      const result = await pullLessons("agent-001");
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
      if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
      else delete process.env.HIVE_MIND_URL;
      if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
      else delete process.env.HIVE_MIND_API_KEY;
      destroyConsensusCache();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Adapter fail-open with disabled hive
// ═══════════════════════════════════════════════════════════════════════════

describeAsync(
  "formatSharedLessonsForPrompt / formatThresholdConsensusForAdvisory — fail-open",
  async () => {
    testAsync("formatSharedLessonsForPrompt returns '' when disabled", async () => {
      const origFlag = config.features.hiveMind;
      config.features.hiveMind = false;
      try {
        const result = await formatSharedLessonsForPrompt();
        expect(result).toBe("");
      } finally {
        config.features.hiveMind = origFlag;
      }
    });

    testAsync("formatThresholdConsensusForAdvisory returns '' when disabled", async () => {
      const origFlag = config.features.hiveMind;
      config.features.hiveMind = false;
      try {
        const result = await formatThresholdConsensusForAdvisory();
        expect(result).toBe("");
      } finally {
        config.features.hiveMind = origFlag;
      }
    });

    testAsync("formatSharedLessonsForPrompt returns '' with unreachable server", async () => {
      const origFlag = config.features.hiveMind;
      const origUrl = process.env.HIVE_MIND_URL;
      const origKey = process.env.HIVE_MIND_API_KEY;

      config.features.hiveMind = true;
      process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
      process.env.HIVE_MIND_API_KEY = "test-key-adapter";

      try {
        const result = await formatSharedLessonsForPrompt();
        expect(result).toBe("");
      } finally {
        config.features.hiveMind = origFlag;
        if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
        else delete process.env.HIVE_MIND_URL;
        if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
        else delete process.env.HIVE_MIND_API_KEY;
        destroyConsensusCache();
      }
    });

    testAsync(
      "formatThresholdConsensusForAdvisory returns '' with unreachable server",
      async () => {
        const origFlag = config.features.hiveMind;
        const origUrl = process.env.HIVE_MIND_URL;
        const origKey = process.env.HIVE_MIND_API_KEY;

        config.features.hiveMind = true;
        process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
        process.env.HIVE_MIND_API_KEY = "test-key-adapter";

        try {
          const result = await formatThresholdConsensusForAdvisory();
          expect(result).toBe("");
        } finally {
          config.features.hiveMind = origFlag;
          if (origUrl !== undefined) process.env.HIVE_MIND_URL = origUrl;
          else delete process.env.HIVE_MIND_URL;
          if (origKey !== undefined) process.env.HIVE_MIND_API_KEY = origKey;
          else delete process.env.HIVE_MIND_API_KEY;
          destroyConsensusCache();
        }
      }
    );
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Backward compatibility — legacy functions still importable
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("Backward compatibility — barrel exports", async () => {
  testAsync("pullLessons is importable from backward-compat barrel", async () => {
    const mod = await import("../src/infrastructure/hive-mind.js");
    expect(typeof mod.pullLessons).toBe("function");
  });

  testAsync("pullPresets is importable from backward-compat barrel", async () => {
    const mod = await import("../src/infrastructure/hive-mind.js");
    expect(typeof mod.pullPresets).toBe("function");
  });

  testAsync("normalisePulledLesson is importable from backward-compat barrel", async () => {
    const mod = await import("../src/infrastructure/hive-mind.js");
    expect(typeof mod.normalisePulledLesson).toBe("function");
  });

  testAsync("normalisePulledLessons is importable from backward-compat barrel", async () => {
    const mod = await import("../src/infrastructure/hive-mind.js");
    expect(typeof mod.normalisePulledLessons).toBe("function");
  });

  testAsync("queryLessonConsensus remains importable (legacy)", async () => {
    const mod = await import("../src/infrastructure/hive-mind.js");
    expect(typeof mod.queryLessonConsensus).toBe("function");
  });

  testAsync("queryThresholdConsensus remains importable (legacy)", async () => {
    const mod = await import("../src/infrastructure/hive-mind.js");
    expect(typeof mod.queryThresholdConsensus).toBe("function");
  });
});

// Run tests
runTestsAsync().catch(() => process.exit(1));
