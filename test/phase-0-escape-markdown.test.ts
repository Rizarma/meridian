/**
 * Phase 0 Tests: Telegram MarkdownV2 Escaping
 *
 * Dedicated coverage for escapeMarkdownV2():
 * - Backslash escaping (was missing)
 * - Every Telegram MarkdownV2 special character
 * - Mixed strings
 * - Idempotency expectations
 */

import { escapeMarkdownV2 } from "../src/infrastructure/telegram.js";
import { describeAsync, expect, runTestsAsync, testAsync } from "./test-harness.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Individual special characters
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("escapeMarkdownV2 – individual special characters", async () => {
  // Backslash – the bug that was missing
  testAsync("escapes backslash → \\\\", async () => {
    expect(escapeMarkdownV2("\\")).toBe("\\\\");
  });

  // All other MarkdownV2 special characters
  testAsync("escapes _", async () => {
    expect(escapeMarkdownV2("_")).toBe("\\_");
  });
  testAsync("escapes *", async () => {
    expect(escapeMarkdownV2("*")).toBe("\\*");
  });
  testAsync("escapes [", async () => {
    expect(escapeMarkdownV2("[")).toBe("\\[");
  });
  testAsync("escapes ]", async () => {
    expect(escapeMarkdownV2("]")).toBe("\\]");
  });
  testAsync("escapes (", async () => {
    expect(escapeMarkdownV2("(")).toBe("\\(");
  });
  testAsync("escapes )", async () => {
    expect(escapeMarkdownV2(")")).toBe("\\)");
  });
  testAsync("escapes ~", async () => {
    expect(escapeMarkdownV2("~")).toBe("\\~");
  });
  testAsync("escapes `", async () => {
    expect(escapeMarkdownV2("`")).toBe("\\`");
  });
  testAsync("escapes >", async () => {
    expect(escapeMarkdownV2(">")).toBe("\\>");
  });
  testAsync("escapes #", async () => {
    expect(escapeMarkdownV2("#")).toBe("\\#");
  });
  testAsync("escapes +", async () => {
    expect(escapeMarkdownV2("+")).toBe("\\+");
  });
  testAsync("escapes -", async () => {
    expect(escapeMarkdownV2("-")).toBe("\\-");
  });
  testAsync("escapes =", async () => {
    expect(escapeMarkdownV2("=")).toBe("\\=");
  });
  testAsync("escapes |", async () => {
    expect(escapeMarkdownV2("|")).toBe("\\|");
  });
  testAsync("escapes {", async () => {
    expect(escapeMarkdownV2("{")).toBe("\\{");
  });
  testAsync("escapes }", async () => {
    expect(escapeMarkdownV2("}")).toBe("\\}");
  });
  testAsync("escapes .", async () => {
    expect(escapeMarkdownV2(".")).toBe("\\.");
  });
  testAsync("escapes !", async () => {
    expect(escapeMarkdownV2("!")).toBe("\\!");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Plain / no-op cases
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("escapeMarkdownV2 – plain text unchanged", async () => {
  testAsync("empty string", async () => {
    expect(escapeMarkdownV2("")).toBe("");
  });

  testAsync("plain alphanumeric text", async () => {
    expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
  });

  testAsync("unicode / emoji pass-through", async () => {
    expect(escapeMarkdownV2("✅🚀🎉")).toBe("✅🚀🎉");
  });

  testAsync("spaces and newlines preserved", async () => {
    expect(escapeMarkdownV2("line1\nline2")).toBe("line1\nline2");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Backslash-specific cases
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("escapeMarkdownV2 – backslash handling", async () => {
  testAsync("single backslash is doubled", async () => {
    expect(escapeMarkdownV2("\\")).toBe("\\\\");
  });

  testAsync("backslash before special char does not double-escape the char", async () => {
    // Input:  \.  (two chars: backslash, dot)
    // Output: \\\. (four chars: escaped-backslash \ + escaped-dot \.)
    expect(escapeMarkdownV2("\\.")).toBe("\\\\\\.");
  });

  testAsync("multiple backslashes", async () => {
    expect(escapeMarkdownV2("\\\\")).toBe("\\\\\\\\");
  });

  testAsync("backslash in Windows-style path", async () => {
    expect(escapeMarkdownV2("C:\\Users\\path")).toBe("C:\\\\Users\\\\path");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Mixed strings
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("escapeMarkdownV2 – mixed strings", async () => {
  testAsync("combines multiple special characters", async () => {
    expect(escapeMarkdownV2("a_b*c.d")).toBe("a\\_b\\*c\\.d");
  });

  testAsync("price-like string with dots and dashes", async () => {
    expect(escapeMarkdownV2("Price: $1.23-2.50")).toBe("Price: $1\\.23\\-2\\.50");
  });

  testAsync("URL with dots, equals, ampersand-like chars", async () => {
    // Note: ? and & are NOT MarkdownV2 special chars, they stay as-is
    expect(escapeMarkdownV2("https://example.com?x=1")).toBe("https://example\\.com?x\\=1");
  });

  testAsync("Telegram message-like string", async () => {
    const input = "Deployed SOL/USDC\nAmount: 1.5 SOL\nPnL: +$2.50 (1.5%)";
    const expected = "Deployed SOL/USDC\nAmount: 1\\.5 SOL\nPnL: \\+$2\\.50 \\(1\\.5%\\)";
    expect(escapeMarkdownV2(input)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: Idempotency
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("escapeMarkdownV2 – idempotency", async () => {
  testAsync("double-escaping is NOT idempotent (escaped backslashes re-escape)", async () => {
    const input = "a_b.c";
    const once = escapeMarkdownV2(input);
    const twice = escapeMarkdownV2(once);
    // The escaped backslashes from round 1 get re-escaped in round 2
    expect(twice.length > once.length).toBe(true);
  });

  testAsync("plain text IS idempotent", async () => {
    const input = "hello world";
    expect(escapeMarkdownV2(escapeMarkdownV2(input))).toBe(escapeMarkdownV2(input));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite: All specials in one pass
// ═══════════════════════════════════════════════════════════════════════════

describeAsync("escapeMarkdownV2 – all specials in one string", async () => {
  testAsync("every special character escaped in a single pass", async () => {
    // Contains one of each: \ _ * [ ] ( ) ~ ` > # + - = | { } . !
    const input = "\\_*[]()~`>#+-=|{}.!";
    // Each char gets a backslash prefix; the literal \ becomes \\
    // Build expected programmatically to avoid manual escaping mistakes
    const specials = [
      "\\",
      "_",
      "*",
      "[",
      "]",
      "(",
      ")",
      "~",
      "`",
      ">",
      "#",
      "+",
      "-",
      "=",
      "|",
      "{",
      "}",
      ".",
      "!",
    ];
    const expected = specials.map((c) => (c === "\\" ? "\\\\" : `\\${c}`)).join("");
    expect(escapeMarkdownV2(input)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run tests if this file is executed directly
// ═══════════════════════════════════════════════════════════════════════════

const isMainModule =
  import.meta.url.startsWith("file://") &&
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"));

if (isMainModule) {
  runTestsAsync().catch(() => process.exit(1));
}
