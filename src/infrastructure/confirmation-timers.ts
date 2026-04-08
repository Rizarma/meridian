/**
 * Confirmation timer utilities for position management.
 *
 * This module is separated to avoid circular dependencies between
 * infrastructure/state.ts and cycles/management.ts.
 */

// Timer maps for peak and trailing drop confirmations
const _peakConfirmTimers: Map<string, NodeJS.Timeout> = new Map();
const _trailingDropConfirmTimers = new Map<string, NodeJS.Timeout>();

// TTL tracking for stale timer cleanup
const _timerTimestamps: Map<string, number> = new Map();
const TIMER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Clear the peak confirmation timer for a position.
 */
export function clearPeakConfirmationTimer(positionAddress: string): void {
  const timer = _peakConfirmTimers.get(positionAddress);
  if (timer) {
    clearTimeout(timer);
    _peakConfirmTimers.delete(positionAddress);
    _timerTimestamps.delete(`${positionAddress}:peak`);
  }
}

/**
 * Clear the trailing drop confirmation timer for a position.
 */
export function clearTrailingDropConfirmationTimer(positionAddress: string): void {
  const timer = _trailingDropConfirmTimers.get(positionAddress);
  if (timer) {
    clearTimeout(timer);
    _trailingDropConfirmTimers.delete(positionAddress);
    _timerTimestamps.delete(`${positionAddress}:trailing`);
  }
}

/**
 * Clear all confirmation timers for a position.
 * Should be called when a position is closed to prevent timer leaks.
 */
export function clearAllConfirmationTimers(positionAddress: string): void {
  clearPeakConfirmationTimer(positionAddress);
  clearTrailingDropConfirmationTimer(positionAddress);
}

/**
 * Schedule a peak confirmation timer for a position.
 * Internal helper - called by management cycle.
 */
export function setPeakConfirmTimer(positionAddress: string, timer: NodeJS.Timeout): void {
  // Clear existing if present
  clearPeakConfirmationTimer(positionAddress);

  _peakConfirmTimers.set(positionAddress, timer);
  _timerTimestamps.set(`${positionAddress}:peak`, Date.now());

  // Schedule cleanup - don't keep process alive just for this timer
  timer.unref?.();
}

/**
 * Schedule a trailing drop confirmation timer for a position.
 * Internal helper - called by management cycle.
 */
export function setTrailingDropConfirmTimer(positionAddress: string, timer: NodeJS.Timeout): void {
  clearTrailingDropConfirmationTimer(positionAddress);

  _trailingDropConfirmTimers.set(positionAddress, timer);
  _timerTimestamps.set(`${positionAddress}:trailing`, Date.now());

  timer.unref?.();
}

/**
 * Get the peak confirmation timer for a position (for checking existence).
 */
export function getPeakConfirmTimer(positionAddress: string): NodeJS.Timeout | undefined {
  return _peakConfirmTimers.get(positionAddress);
}

/**
 * Get the trailing drop confirmation timer for a position (for checking existence).
 */
export function getTrailingDropConfirmTimer(positionAddress: string): NodeJS.Timeout | undefined {
  return _trailingDropConfirmTimers.get(positionAddress);
}

/**
 * Delete the peak confirmation timer entry without clearing (used after timer fires).
 */
export function deletePeakConfirmTimer(positionAddress: string): boolean {
  return _peakConfirmTimers.delete(positionAddress);
}

/**
 * Delete the trailing drop confirmation timer entry without clearing (used after timer fires).
 */
export function deleteTrailingDropConfirmTimer(positionAddress: string): boolean {
  return _trailingDropConfirmTimers.delete(positionAddress);
}

/**
 * Periodic cleanup of stale timer entries older than TIMER_TTL_MS.
 * Should be called periodically (e.g., by a scheduled job) to prevent memory leaks.
 */
export function cleanupStaleTimers(): void {
  const now = Date.now();

  for (const [key, timestamp] of _timerTimestamps.entries()) {
    if (now - timestamp > TIMER_TTL_MS) {
      const [positionAddress, type] = key.split(":");
      if (type === "peak") {
        clearPeakConfirmationTimer(positionAddress);
      } else if (type === "trailing") {
        clearTrailingDropConfirmationTimer(positionAddress);
      }
      _timerTimestamps.delete(key);
    }
  }
}

/**
 * Get timer counts for monitoring/debugging.
 * Returns the number of peak, trailing, and total active timers.
 */
export function getTimerStats(): { peak: number; trailing: number; total: number } {
  return {
    peak: _peakConfirmTimers.size,
    trailing: _trailingDropConfirmTimers.size,
    total: _peakConfirmTimers.size + _trailingDropConfirmTimers.size,
  };
}
