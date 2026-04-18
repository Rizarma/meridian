/**
 * Hive Mind — barrel re-export of the public API.
 *
 * All consumer imports resolve through this file (or through the
 * backward-compatible `../hive-mind.js` shim).
 *
 * Phase 4: Added strict compat flag, path telemetry, and deprecation helpers.
 */

// Prompt adapters (Phase 3: lessons + threshold now use pull endpoints)
export {
  formatPoolConsensusForPrompt,
  formatSharedLessonsForPrompt,
  formatThresholdConsensusForAdvisory,
} from "./adapters.js";
// Cache management
export { destroyConsensusCache } from "./cache.js";
// Config & feature flag (Phase 4: added strict compat + telemetry + deprecation)
export {
  getActivePathsSummary,
  getPathTelemetry,
  isEnabled,
  isLegacyBatchSyncEnabled,
  isStrictCompatEnabled,
  recordPathUsage,
  resetDeprecationWarnings,
  resetPathTelemetry,
} from "./config.js";
// Raw consensus queries (legacy, preserved for backward compat)
export {
  getHivePulse,
  queryLessonConsensus,
  queryPatternConsensus,
  queryPoolConsensus,
  queryThresholdConsensus,
} from "./consensus.js";
// Pull endpoints (Phase 3 — original-compatible read functions)
export {
  normalisePulledLesson,
  normalisePulledLessons,
  pullLessons,
  pullPresets,
} from "./pull.js";
// Registration & sync (legacy + phase-1 originals)
export {
  bootstrapSync,
  buildLessonPayload,
  buildPerformancePayload,
  buildRegistrationPayload,
  heartbeat,
  pushLesson,
  pushPerformance,
  register,
  registerAgent,
  syncToHive,
} from "./sync.js";
