/**
 * Confirmation timer utilities for position management.
 *
 * This module is separated to avoid circular dependencies between
 * infrastructure/state.ts and cycles/management.ts.
 */

// Timer maps for peak and trailing drop confirmations
const _peakConfirmTimers: Map<string, NodeJS.Timeout> = new Map();
const _trailingDropConfirmTimers = new Map<string, NodeJS.Timeout>();

/**
 * Clear the peak confirmation timer for a position.
 */
export function clearPeakConfirmationTimer(positionAddress: string): void {
  const timer = _peakConfirmTimers.get(positionAddress);
  if (timer) {
    clearTimeout(timer);
    _peakConfirmTimers.delete(positionAddress);
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
  _peakConfirmTimers.set(positionAddress, timer);
}

/**
 * Schedule a trailing drop confirmation timer for a position.
 * Internal helper - called by management cycle.
 */
export function setTrailingDropConfirmTimer(positionAddress: string, timer: NodeJS.Timeout): void {
  _trailingDropConfirmTimers.set(positionAddress, timer);
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
