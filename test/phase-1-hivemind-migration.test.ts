/**
 * Phase 1 Tests: HiveMind Migration — Headers, Registration, Payload Builders
 *
 * Tests covering:
 * 1. hiveGetHeaders produces correct accept + x-api-key headers
 * 2. hivePostHeaders produces correct accept + content-type + x-api-key headers
 * 3. buildRegistrationPayload matches original JS contract shape
 * 4. buildLessonPayload builds correct nested payload
 * 5. buildPerformancePayload builds correct nested payload
 * 6. registerAgent returns null when disabled (fail-open)
 * 7. pushLesson returns null when disabled (fail-open)
 * 8. pushPerformance returns null when disabled (fail-open)
 * 9. New functions are importable from the backward-compat barrel
 */

import { config } from "../src/config/config.js";
import { hiveGetHeaders, hivePostHeaders } from "../src/infrastructure/hive-mind/client.js";
import {
  buildLessonPayload,
  buildPerformancePayload,
  buildRegistrationPayload,
  destroyConsensusCache,
  pushLesson,
  pushPerformance,
  registerAgent,
} from "../src/infrastructure/hive-mind.js";
import { describe, describeAsync, expect, runTestsAsync, test, testAsync } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Header helpers — original-compatible semantics
// ═══════════════════════════════════════════════════════════════════════════

describe("hiveGetHeaders — original-compatible headers", () => {
  test("includes accept: application/json", () => {
    const headers = hiveGetHeaders("my-key");
    expect(headers["accept"]).toBe("application/json");
  });

  test("includes x-api-key with the provided key", () => {
    const headers = hiveGetHeaders("my-key");
    expect(headers["x-api-key"]).toBe("my-key");
  });

  test("does NOT include content-type (no body on GET)", () => {
    const headers = hiveGetHeaders("my-key");
    expect("content-type" in headers).toBe(false);
    expect("Content-Type" in headers).toBe(false);
  });

  test("does NOT include Authorization header (uses x-api-key instead)", () => {
    const headers = hiveGetHeaders("my-key");
    expect("Authorization" in headers).toBe(false);
    expect("authorization" in headers).toBe(false);
  });
});

describe("hivePostHeaders — original-compatible headers", () => {
  test("includes accept: application/json", () => {
    const headers = hivePostHeaders("my-key");
    expect(headers["accept"]).toBe("application/json");
  });

  test("includes x-api-key with the provided key", () => {
    const headers = hivePostHeaders("my-key");
    expect(headers["x-api-key"]).toBe("my-key");
  });

  test("includes content-type: application/json (POST has body)", () => {
    const headers = hivePostHeaders("my-key");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("does NOT include Authorization header", () => {
    const headers = hivePostHeaders("my-key");
    expect("Authorization" in headers).toBe(false);
    expect("authorization" in headers).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: buildRegistrationPayload — original contract shape
// ═══════════════════════════════════════════════════════════════════════════

describe("buildRegistrationPayload — original contract shape", () => {
  test("produces payload with all required fields", () => {
    const payload = buildRegistrationPayload({
      agentId: "agent-001",
      version: "1.0.0",
      reason: "startup",
      capabilities: { telegram: true, lpagent: true, dryRun: false },
    });

    expect(payload.agentId).toBe("agent-001");
    expect(payload.version).toBe("1.0.0");
    expect(payload.reason).toBe("startup");
  });

  test("includes ISO timestamp", () => {
    const payload = buildRegistrationPayload({
      agentId: "agent-001",
      version: "1.0.0",
      reason: "startup",
      capabilities: { telegram: false, lpagent: false, dryRun: false },
    });

    // ISO timestamp should be parseable
    const parsed = Date.parse(payload.timestamp);
    expect(parsed > 0).toBe(true);
    expect(isNaN(parsed)).toBe(false);
  });

  test("normalizes capabilities to booleans", () => {
    const payload = buildRegistrationPayload({
      agentId: "agent-001",
      version: "1.0.0",
      reason: "test",
      capabilities: { telegram: true, lpagent: false, dryRun: undefined as any },
    });

    expect(payload.capabilities.telegram).toBe(true);
    expect(payload.capabilities.lpagent).toBe(false);
    expect(payload.capabilities.dryRun).toBe(false);
  });

  test("capabilities object has exactly 3 keys", () => {
    const payload = buildRegistrationPayload({
      agentId: "agent-001",
      version: "1.0.0",
      reason: "test",
      capabilities: { telegram: true, lpagent: true, dryRun: true },
    });

    const keys = Object.keys(payload.capabilities);
    expect(keys.length).toBe(3);
    expect(keys.includes("telegram")).toBe(true);
    expect(keys.includes("lpagent")).toBe(true);
    expect(keys.includes("dryRun")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: buildLessonPayload — payload builder
// ═══════════════════════════════════════════════════════════════════════════

describe("buildLessonPayload — payload builder", () => {
  test("builds correct nested structure", () => {
    const payload = buildLessonPayload({
      agentId: "agent-001",
      rule: "Avoid low-liquidity pools",
      tags: ["screening", "liquidity"],
      outcome: "negative",
    });

    expect(payload.agentId).toBe("agent-001");
    expect(payload.lesson.rule).toBe("Avoid low-liquidity pools");
    expect(payload.lesson.tags.length).toBe(2);
    expect(payload.lesson.outcome).toBe("negative");
  });

  test("includes optional context when provided", () => {
    const payload = buildLessonPayload({
      agentId: "agent-001",
      rule: "Test rule",
      tags: ["test"],
      outcome: "positive",
      context: "Pool had 10x volume spike",
    });

    expect(payload.lesson.context).toBe("Pool had 10x volume spike");
  });

  test("omits context when not provided (undefined)", () => {
    const payload = buildLessonPayload({
      agentId: "agent-001",
      rule: "Test rule",
      tags: ["test"],
      outcome: "positive",
    });

    expect(payload.lesson.context).toBe(undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: buildPerformancePayload — payload builder
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPerformancePayload — payload builder", () => {
  test("builds correct nested structure with all required fields", () => {
    const payload = buildPerformancePayload({
      agentId: "agent-001",
      poolAddress: "PoolAddr1111111111111111111111111111111",
      pnlPct: -5.2,
      pnlUsd: -26.0,
      holdTimeMinutes: 180,
      closeReason: "stop_loss",
    });

    expect(payload.agentId).toBe("agent-001");
    expect(payload.performance.poolAddress).toBe("PoolAddr1111111111111111111111111111111");
    expect(payload.performance.pnlPct).toBe(-5.2);
    expect(payload.performance.pnlUsd).toBe(-26.0);
    expect(payload.performance.holdTimeMinutes).toBe(180);
    expect(payload.performance.closeReason).toBe("stop_loss");
  });

  test("includes optional fields when provided", () => {
    const payload = buildPerformancePayload({
      agentId: "agent-001",
      poolAddress: "PoolAddr1111111111111111111111111111111",
      pnlPct: 12.5,
      pnlUsd: 62.5,
      holdTimeMinutes: 360,
      closeReason: "take_profit",
      rangeEfficiency: 85.3,
      strategy: "narrow",
    });

    expect(payload.performance.rangeEfficiency).toBe(85.3);
    expect(payload.performance.strategy).toBe("narrow");
  });

  test("optional fields default to undefined", () => {
    const payload = buildPerformancePayload({
      agentId: "agent-001",
      poolAddress: "PoolAddr1111111111111111111111111111111",
      pnlPct: 0,
      pnlUsd: 0,
      holdTimeMinutes: 60,
      closeReason: "manual",
    });

    expect(payload.performance.rangeEfficiency).toBe(undefined);
    expect(payload.performance.strategy).toBe(undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Fail-open behavior for new push functions
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("registerAgent / pushLesson / pushPerformance — fail-open", async () => {
  testAsync("registerAgent returns null when disabled", async () => {
    const origFlag = config.features.hiveMind;
    config.features.hiveMind = false;
    try {
      const result = await registerAgent({
        agentId: "test",
        version: "1.0.0",
        reason: "test",
        capabilities: { telegram: false, lpagent: false, dryRun: false },
      });
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
    }
  });

  testAsync("pushLesson returns null when disabled", async () => {
    const origFlag = config.features.hiveMind;
    config.features.hiveMind = false;
    try {
      const result = await pushLesson({
        agentId: "test",
        rule: "test rule",
        tags: ["test"],
        outcome: "positive",
      });
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
    }
  });

  testAsync("pushPerformance returns null when disabled", async () => {
    const origFlag = config.features.hiveMind;
    config.features.hiveMind = false;
    try {
      const result = await pushPerformance({
        agentId: "test",
        poolAddress: "Pool111111111111111111111111111111111",
        pnlPct: 5.0,
        pnlUsd: 25.0,
        holdTimeMinutes: 120,
        closeReason: "take_profit",
      });
      expect(result).toBe(null);
    } finally {
      config.features.hiveMind = origFlag;
    }
  });

  testAsync("pushLesson returns null with unreachable server (fail-open)", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-key-push";

    try {
      const result = await pushLesson({
        agentId: "test",
        rule: "test rule",
        tags: ["test"],
        outcome: "positive",
      });
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

  testAsync("pushPerformance returns null with unreachable server (fail-open)", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-key-perf";

    try {
      const result = await pushPerformance({
        agentId: "test",
        poolAddress: "Pool111111111111111111111111111111111",
        pnlPct: -3.0,
        pnlUsd: -15.0,
        holdTimeMinutes: 60,
        closeReason: "stop_loss",
      });
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

  testAsync("registerAgent returns null with unreachable server (fail-open)", async () => {
    const origFlag = config.features.hiveMind;
    const origUrl = process.env.HIVE_MIND_URL;
    const origKey = process.env.HIVE_MIND_API_KEY;

    config.features.hiveMind = true;
    process.env.HIVE_MIND_URL = "https://nonexistent-test.invalid";
    process.env.HIVE_MIND_API_KEY = "test-key-reg";

    try {
      const result = await registerAgent({
        agentId: "test-agent",
        version: "0.1.0",
        reason: "startup",
        capabilities: { telegram: true, lpagent: true, dryRun: false },
      });
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

// Run tests
runTestsAsync().catch(() => process.exit(1));
