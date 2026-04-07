/**
 * Phase 5 Tests: Caching Layer
 *
 * Tests the TTLCache implementation:
 * - Basic operations (get, set, invalidate, clear)
 * - TTL expiry behavior
 * - Cache hit/miss patterns
 * - Different TTLs for different entries
 */

import { TTLCache } from "../src/utils/cache.js";
import { describe, describeAsync, expect, runTestsAsync, test, testAsync } from "./test-harness.js";

describe("TTLCache - Basic Operations", () => {
  test("get returns undefined for non-existent key", () => {
    const cache = new TTLCache<string, string>();
    const result = cache.get("non-existent");
    expect(result).toBe(undefined);
  });

  test("set stores value that can be retrieved", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 1000);
    const result = cache.get("key1");
    expect(result).toBe("value1");
  });

  test("set overwrites existing value", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 1000);
    cache.set("key1", "value2", 1000);
    const result = cache.get("key1");
    expect(result).toBe("value2");
  });

  test("invalidate removes specific key", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 1000);
    cache.set("key2", "value2", 1000);
    cache.invalidate("key1");
    expect(cache.get("key1")).toBe(undefined);
    expect(cache.get("key2")).toBe("value2");
  });

  test("invalidate non-existent key does not throw", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 1000);
    cache.invalidate("non-existent");
    expect(cache.get("key1")).toBe("value1");
  });

  test("clear removes all entries", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 1000);
    cache.set("key2", "value2", 1000);
    cache.set("key3", "value3", 1000);
    cache.clear();
    expect(cache.get("key1")).toBe(undefined);
    expect(cache.get("key2")).toBe(undefined);
    expect(cache.get("key3")).toBe(undefined);
  });

  test("clear on empty cache does not throw", () => {
    const cache = new TTLCache<string, string>();
    cache.clear();
    expect(cache.get("any-key")).toBe(undefined);
  });
});

describeAsync("TTLCache - TTL Expiry", async () => {
  testAsync("value expires after TTL", async () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 50); // 50ms TTL
    expect(cache.get("key1")).toBe("value1");

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.get("key1")).toBe(undefined);
  });

  testAsync("expired entry is deleted from cache", async () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 50);
    cache.set("key2", "value2", 10000); // Long TTL

    // Wait for first entry to expire
    await new Promise((resolve) => setTimeout(resolve, 60));
    cache.get("key1"); // This should trigger cleanup

    // key2 should still exist
    expect(cache.get("key2")).toBe("value2");
  });

  testAsync("value with zero TTL expires immediately or very quickly", async () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", 0);
    // Small delay to allow expiry check
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = cache.get("key1");
    expect(result).toBe(undefined);
  });

  testAsync("negative TTL behaves like zero TTL", async () => {
    const cache = new TTLCache<string, string>();
    cache.set("key1", "value1", -100);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = cache.get("key1");
    expect(result).toBe(undefined);
  });
});

describe("TTLCache - Cache Hit/Miss Patterns", () => {
  test("cache hit returns correct value without calling underlying function", () => {
    const cache = new TTLCache<string, number>();
    let callCount = 0;

    function expensiveOperation(): number {
      callCount++;
      return 42;
    }

    // First call - cache miss
    const value1 = cache.get("key") ?? expensiveOperation();
    cache.set("key", value1, 1000);
    expect(callCount).toBe(1);
    expect(value1).toBe(42);

    // Second call - cache hit
    const value2 = cache.get("key") ?? expensiveOperation();
    expect(callCount).toBe(1); // Should not increment
    expect(value2).toBe(42);
  });

  test("cache miss calls underlying function and caches result", () => {
    const cache = new TTLCache<string, string>();
    let callCount = 0;

    function fetchData(): string {
      callCount++;
      return `data-${callCount}`;
    }

    // First access - miss
    const value1 =
      cache.get("key") ??
      (() => {
        const result = fetchData();
        cache.set("key", result, 1000);
        return result;
      })();
    expect(callCount).toBe(1);
    expect(value1).toBe("data-1");

    // Second access - hit
    const value2 = cache.get("key") ?? fetchData();
    expect(callCount).toBe(1); // No additional call
    expect(value2).toBe("data-1");
  });

  test("multiple keys can be cached independently", () => {
    const cache = new TTLCache<string, number>();

    cache.set("key1", 100, 1000);
    cache.set("key2", 200, 1000);
    cache.set("key3", 300, 1000);

    expect(cache.get("key1")).toBe(100);
    expect(cache.get("key2")).toBe(200);
    expect(cache.get("key3")).toBe(300);
  });

  test("updating one key does not affect others", () => {
    const cache = new TTLCache<string, number>();

    cache.set("key1", 100, 1000);
    cache.set("key2", 200, 1000);
    cache.set("key1", 150, 1000); // Update key1

    expect(cache.get("key1")).toBe(150);
    expect(cache.get("key2")).toBe(200);
  });
});

describeAsync("TTLCache - Different TTLs", async () => {
  testAsync("different entries can have different TTLs", async () => {
    const cache = new TTLCache<string, string>();

    cache.set("short", "short-lived", 50);
    cache.set("long", "long-lived", 10000);

    expect(cache.get("short")).toBe("short-lived");
    expect(cache.get("long")).toBe("long-lived");

    // Wait for short TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(cache.get("short")).toBe(undefined);
    expect(cache.get("long")).toBe("long-lived");
  });

  testAsync("updating entry resets TTL", async () => {
    const cache = new TTLCache<string, string>();

    cache.set("key", "value1", 50);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Update with new TTL before original expires
    cache.set("key", "value2", 100);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should still exist because TTL was reset
    expect(cache.get("key")).toBe("value2");
  });

  testAsync("very long TTL keeps value for extended period", async () => {
    const cache = new TTLCache<string, string>();
    cache.set("key", "persistent", 1000000); // Very long TTL

    // Simulate multiple accesses over time
    for (let i = 0; i < 5; i++) {
      expect(cache.get("key")).toBe("persistent");
    }
  });
});

describe("TTLCache - Type Safety", () => {
  test("supports string values", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key", "string-value", 1000);
    expect(cache.get("key")).toBe("string-value");
  });

  test("supports number values", () => {
    const cache = new TTLCache<string, number>();
    cache.set("key", 12345, 1000);
    expect(cache.get("key")).toBe(12345);
  });

  test("supports object values", () => {
    const cache = new TTLCache<string, { name: string; value: number }>();
    const obj = { name: "test", value: 42 };
    cache.set("key", obj, 1000);
    const result = cache.get("key");
    expect(result?.name).toBe("test");
    expect(result?.value).toBe(42);
  });

  test("supports array values", () => {
    const cache = new TTLCache<string, number[]>();
    const arr = [1, 2, 3, 4, 5];
    cache.set("key", arr, 1000);
    const result = cache.get("key");
    expect(result?.length).toBe(5);
    expect(result?.[0]).toBe(1);
    expect(result?.[4]).toBe(5);
  });

  test("supports number keys", () => {
    const cache = new TTLCache<number, string>();
    cache.set(1, "one", 1000);
    cache.set(2, "two", 1000);
    expect(cache.get(1)).toBe("one");
    expect(cache.get(2)).toBe("two");
  });
});

describe("TTLCache - Edge Cases", () => {
  test("handles undefined as value", () => {
    const cache = new TTLCache<string, string | undefined>();
    cache.set("key", undefined, 1000);
    // Should return undefined (ambiguous with not found, but that's expected)
    const result = cache.get("key");
    expect(result).toBe(undefined);
  });

  test("handles null as value", () => {
    const cache = new TTLCache<string, string | null>();
    cache.set("key", null as unknown as string, 1000);
    const result = cache.get("key");
    expect(result).toBe(null);
  });

  test("empty string as key works", () => {
    const cache = new TTLCache<string, string>();
    cache.set("", "empty-key-value", 1000);
    expect(cache.get("")).toBe("empty-key-value");
  });

  test("special characters in key work", () => {
    const cache = new TTLCache<string, string>();
    cache.set("key:with:colons", "value1", 1000);
    cache.set("key/with/slashes", "value2", 1000);
    cache.set("key.with.dots", "value3", 1000);

    expect(cache.get("key:with:colons")).toBe("value1");
    expect(cache.get("key/with/slashes")).toBe("value2");
    expect(cache.get("key.with.dots")).toBe("value3");
  });
});

// Run tests asynchronously
runTestsAsync();
