/**
 * Hive Mind — low-level HTTP client.
 *
 * Zero external dependencies — uses only Node.js native fetch().
 */

import { GET_TIMEOUT_MS } from "./config.js";

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
