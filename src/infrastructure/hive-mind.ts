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
  getHivePulse,
  heartbeat,
  isEnabled,
  isLegacyBatchSyncEnabled,
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
  register,
  registerAgent,
  syncToHive,
} from "./hive-mind/index.js";
