/**
 * Hive Mind — backward-compatible re-export barrel.
 *
 * The implementation lives in ./hive-mind/ subdirectory.
 * This file preserves the original import path for all consumers:
 *   import { ... } from "../infrastructure/hive-mind.js";
 *
 * DO NOT add logic here — re-export only.
 */

export {
  bootstrapSync,
  buildLessonPayload,
  buildPerformancePayload,
  buildRegistrationPayload,
  destroyConsensusCache,
  formatPoolConsensusForPrompt,
  formatSharedLessonsForPrompt,
  formatThresholdConsensusForAdvisory,
  getActivePathsSummary,
  getHivePulse,
  getPathTelemetry,
  heartbeat,
  isEnabled,
  isLegacyBatchSyncEnabled,
  isStrictCompatEnabled,
  normalisePulledLesson,
  normalisePulledLessons,
  pullLessons,
  pullPresets,
  pushLesson,
  pushPerformance,
  queryLessonConsensus,
  queryPatternConsensus,
  queryPoolConsensus,
  queryThresholdConsensus,
  recordPathUsage,
  register,
  registerAgent,
  resetDeprecationWarnings,
  resetPathTelemetry,
  syncToHive,
} from "./hive-mind/index.js";
