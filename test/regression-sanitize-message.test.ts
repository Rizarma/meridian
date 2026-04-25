/**
 * Regression tests for log sanitization
 * SECURITY: These tests verify that sensitive data never leaks into logs
 * If you modify SENSITIVE_PATTERNS in logger.ts, you MUST update these tests.
 */
import { sanitizeMessage } from "../src/infrastructure/logger.js";
import { describe, expect, runTests, test } from "./test-harness.js";

describe("SECURITY: sanitizeMessage", () => {
  describe("Solana keypair arrays", () => {
    test("redacts 64-byte keypair arrays", () => {
      const keypair = `[12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78, 90, 12, 34, 56, 78]`;
      const result = sanitizeMessage(keypair);
      expect(result).toBe("[REDACTED_KEYPAIR]");
    });

    test("redacts keypair arrays without spaces", () => {
      const keypair = `[12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78]`;
      const result = sanitizeMessage(keypair);
      expect(result).toBe("[REDACTED_KEYPAIR]");
    });

    test("does not redact short arrays", () => {
      const shortArray = `[12, 34, 56, 78, 90]`;
      const result = sanitizeMessage(shortArray);
      expect(result).toBe(shortArray);
    });
  });

  describe("Solana base58 keys", () => {
    test("redacts 32-char base58 strings", () => {
      const key = "5KT6iWj9MF6y6hGLtqzZtZ7iP7dXvJmYqR8sT9uV2wX";
      const result = sanitizeMessage(`key=${key}`);
      expect(result).toBe("key=[REDACTED_KEY]");
    });

    test("redacts 44-char base58 strings", () => {
      const key = "5KT6iWj9MF6y6hGLtqzZtZ7iP7dXvJmYqR8sT9uV2wX3yZ5";
      const result = sanitizeMessage(`wallet: ${key}`);
      expect(result).toBe("wallet: [REDACTED_KEY]");
    });

    test("does not redact short base58 strings", () => {
      const short = "5KT6iWj9MF"; // 10 chars
      const result = sanitizeMessage(short);
      expect(result).toBe(short);
    });
  });

  describe("API keys", () => {
    test("redacts OpenAI/OpenRouter style keys", () => {
      const key = "sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
      const result = sanitizeMessage(`Authorization: ${key}`);
      expect(result).toBe("Authorization: [REDACTED_API_KEY]");
    });

    test("redacts keys with underscores and dashes", () => {
      const key = "sk-test_123-abc_def-456";
      const result = sanitizeMessage(key);
      expect(result).toBe("[REDACTED_API_KEY]");
    });
  });

  describe("Generic tokens", () => {
    test("redacts 32+ char alphanumeric tokens", () => {
      const token = "abcdef1234567890abcdef1234567890";
      const result = sanitizeMessage(`token=${token}`);
      expect(result).toBe("token=[REDACTED_TOKEN]");
    });

    test("redacts Helius-style API keys", () => {
      const heliusKey = "a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6";
      const result = sanitizeMessage(heliusKey);
      expect(result).toBe("[REDACTED_TOKEN]");
    });
  });

  describe("Hex secrets", () => {
    test("redacts 32-char hex strings", () => {
      const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
      const result = sanitizeMessage(hex);
      expect(result).toBe("[REDACTED_HASH]");
    });

    test("redacts 64-char hex strings", () => {
      const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
      const result = sanitizeMessage(hex);
      expect(result).toBe("[REDACTED_HASH]");
    });

    test("handles uppercase hex", () => {
      const hex = "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6";
      const result = sanitizeMessage(hex);
      expect(result).toBe("[REDACTED_HASH]");
    });
  });

  describe("Long numbers", () => {
    test("redacts 10+ digit numbers", () => {
      const id = "1234567890123";
      const result = sanitizeMessage(`user_id=${id}`);
      expect(result).toBe("user_id=[REDACTED_NUMBER]");
    });

    test("does not redact short numbers", () => {
      const short = "12345";
      const result = sanitizeMessage(short);
      expect(result).toBe(short);
    });
  });

  describe("Multiple secrets in one message", () => {
    test("redacts all secrets in a complex message", () => {
      const message = `Deploying with key=5KT6iWj9MF6y6hGLtqzZtZ7iP7dXvJmYqR8sT9uV2wX and API key sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz for user 1234567890`;
      const result = sanitizeMessage(message);
      expect(result.includes("[REDACTED_KEY]")).toBe(true);
      expect(result.includes("[REDACTED_API_KEY]")).toBe(true);
      expect(result.includes("[REDACTED_NUMBER]")).toBe(true);
      expect(result.includes("5KT6iWj9MF6y6hGLtqzZtZ7iP7dXvJmYqR8sT9uV2wX")).toBe(false);
      expect(result.includes("sk-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz")).toBe(false);
      expect(result.includes("1234567890")).toBe(false);
    });
  });

  describe("Edge cases", () => {
    test("handles empty strings", () => {
      expect(sanitizeMessage("")).toBe("");
    });

    test("handles strings with no secrets", () => {
      const message = "Normal log message with pool data and prices";
      expect(sanitizeMessage(message)).toBe(message);
    });

    test("handles Solana addresses (shorter base58)", () => {
      // Solana addresses are typically 32-44 chars but we need to be careful
      // This is a real Solana address format - should be redacted by base58 pattern
      const address = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
      const result = sanitizeMessage(address);
      expect(result).toBe("[REDACTED_KEY]");
    });
  });
});

// Run tests
runTests();
