/**
 * Hive Mind — barrel re-export of the public API.
 *
 * All consumer imports resolve through this file (or through the
 * backward-compatible `../hive-mind.js` shim).
 */

// Prompt adapters
export {
  formatPoolConsensusForPrompt,
  formatSharedLessonsForPrompt,
  formatThresholdConsensusForAdvisory,
} from "./adapters.js";
// Cache management
export { destroyConsensusCache } from "./cache.js";
// Config & feature flag
export { isEnabled } from "./config.js";
// Raw consensus queries
export {
  getHivePulse,
  queryLessonConsensus,
  queryPatternConsensus,
  queryPoolConsensus,
  queryThresholdConsensus,
} from "./consensus.js";
// Registration & sync
export {
  bootstrapSync,
  heartbeat,
  register,
  syncToHive,
} from "./sync.js";
