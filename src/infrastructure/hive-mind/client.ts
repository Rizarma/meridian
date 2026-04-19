/**
 * Hive Mind — low-level HTTP client.
 *
 * Provides a fetch wrapper with timeout/abort support, plus
 * original-compatible request helpers with correct header semantics.
 * Zero external dependencies — uses only Node.js native fetch().
 */

import { GET_TIMEOUT_MS, POST_TIMEOUT_MS } from "./config.js";

/**
 * Fetch with an AbortController timeout.
 *
 * Legacy, unmodified — preserved for backward compatibility.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = GET_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Original-Compatible Request Helpers ────────────────────────────
//
// These enforce the header contract from the original JS implementation:
//   - accept: application/json          (always)
//   - x-api-key: <apiKey>               (authenticated requests)
//   - content-type: application/json    (only when a JSON body is sent)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build headers for an authenticated HiveMind GET request.
 */
export function hiveGetHeaders(apiKey: string): Record<string, string> {
  return {
    accept: "application/json",
    "x-api-key": apiKey,
  };
}

/**
 * Build headers for an authenticated HiveMind POST request with a JSON body.
 */
export function hivePostHeaders(apiKey: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
}

/**
 * Perform an authenticated GET with original-compatible headers.
 * Returns parsed JSON or null on failure. Fail-open (never throws).
 */
export async function hiveGet<T>(
  url: string,
  apiKey: string,
  timeoutMs = GET_TIMEOUT_MS
): Promise<T | null> {
  try {
    const res = await fetchWithTimeout(url, { headers: hiveGetHeaders(apiKey) }, timeoutMs);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Perform an authenticated POST with original-compatible headers.
 * Sets content-type only when body is provided.
 * Returns parsed JSON or null on failure. Fail-open (never throws).
 */
export async function hivePost<T>(
  url: string,
  apiKey: string,
  body?: unknown,
  timeoutMs = POST_TIMEOUT_MS
): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-api-key": apiKey,
    };
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchWithTimeout(url, init, timeoutMs);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
