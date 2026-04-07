// src/types/index.ts
// Main type exports for Meridian DLMM Agent
// NOTE: Types with duplicate names across modules are NOT re-exported here.
// Import those directly from their source modules.

// Export all from agent.d.ts (all unique)
export * from "./agent.js";

// Export from api.d.ts (unique only)
export type {
  LPerPosition,
  SmartWalletCheck,
  TopLPerStudy,
} from "./api.js";

// Export all from blocklist.d.ts (all unique)
export * from "./blocklist.js";

// Export from briefing.d.ts (unique only)
export type {
  ActivityStats,
  BriefingData,
  LessonsFile,
  PerformanceEntry,
  StateFile,
  StatePosition,
} from "./briefing.js";

// Export all from cli.d.ts (all unique)
export * from "./cli.js";

// Export from config.d.ts (unique only)
export type {
  Config,
  DarwinConfig,
  LlmConfig,
  RiskConfig,
  ScheduleConfig,
  ScreeningConfig,
  StrategyConfig,
  TokenConfig,
  UserConfigPartial,
} from "./config.js";

// Export from dlmm.d.ts (unique only)
export type {
  ActiveBin,
  ActiveBinParams,
  BinArray,
  ClaimParams,
  ClaimResult,
  CloseParams,
  CloseResult,
  DeployParams,
  DeployResult,
  DLMMPool,
  EnrichedPosition,
  LbPair,
  PoolCache,
  PositionPnL,
  PositionsResult,
  RawPnLData,
  SearchPoolResult,
  SearchPoolsParams,
  SearchPoolsResult,
  StrategyType,
  WalletPosition,
  WalletPositionsParams,
  WalletPositionsResult,
} from "./dlmm.js";

// Export from executor.d.ts (unique only)
export type {
  ActionLog,
  AddLessonArgs,
  ClearLessonsArgs,
  ClosePositionArgs,
  ConfigChangeMap,
  CronRestarter,
  DeployPositionArgs,
  LessonIdArgs,
  ListLessonsArgs,
  ProtectedTool,
  SafetyCheckResult,
  SetPositionNoteArgs,
  SwapTokenArgs,
  ToolExecutionResult,
  ToolMap,
  UpdateConfigInput,
  UpdateConfigResult,
  WriteTool,
} from "./executor.js";

// Export all from hive-mind.d.ts (all unique)
export * from "./hive-mind.js";

// Export from lessons.d.ts (unique only)
export type {
  EvolutionResult,
  LessonContext,
  LessonOutcome,
  LessonsData,
  ListedLesson,
  ListLessonsOptions,
  ListLessonsResult,
  PerformanceHistoryEntry,
  PerformanceHistoryResult,
  PerformanceMetrics,
  PositionPerformance,
  RoleTags,
  ThresholdEvolution,
  WeightAdjustment,
} from "./lessons.js";

// Export all from logger.d.ts (all unique)
export * from "./logger.js";

// Export all from okx.d.ts (all unique)
export * from "./okx.js";

// Export from orchestrator.d.ts (unique only)
export type {
  ActionDecision,
  ActionType,
  CronTask,
  CronTaskList,
  CycleOptions,
  CycleTimers,
  LiveMessageHandler,
  ManagementReport,
  NarrativeResult,
  ReconCandidate,
  ScreeningResult,
  SessionState,
} from "./orchestrator.js";

// Export from pool.d.ts (unique only)
export type {
  Pool,
  PoolBase,
  PoolCandidate,
  PoolMemory,
  TopCandidatesResult,
} from "./pool.js";

// Export from pool-memory.d.ts (unique only)
export type {
  PoolMemoryDB,
  PoolMemoryEntry,
  PoolMemoryInput,
  PoolMemoryResult,
  PoolNote,
  PoolNoteInput,
  PoolNoteResult,
  PositionSnapshotInput,
} from "./pool-memory.js";

// Export from position.d.ts (unique only)
export type {
  ClaimFeesResult,
  ClosePositionResult,
  DeployPositionParams,
  DeployPositionResult,
  ExitAlert,
  MyPositionsResult,
  Position,
} from "./position.js";

// Export all from prompt.d.ts (all unique)
export * from "./prompt.js";

// Export all from screening.d.ts (all unique)
export * from "./screening.js";

// Export all from setup.d.ts (all unique)
export * from "./setup.js";

// Export all from signals.d.ts (all unique)
export * from "./signals.js";

// Export from smart-wallets.d.ts (unique only)
export type {
  AddSmartWalletInput,
  CachedWalletPositions,
  CheckSmartWalletsInput,
  RemoveSmartWalletInput,
  SmartWalletDB,
  SmartWalletList,
  WalletCategory,
  WalletInPool,
  WalletPositionCheck,
  WalletType,
} from "./smart-wallets.js";

// Export from state.d.ts (unique only)
export type {
  BinRange,
  ExitAction,
  PeakConfirmation,
  PositionState,
  StateEvent,
  StateSummary,
  TrailingConfirmation,
} from "./state.js";

// Export all from strategy.d.ts (all unique)
export * from "./strategy.js";

// Export all from study.d.ts (all unique)
export * from "./study.js";

// Export from telegram.d.ts (unique only)
export type {
  LiveMessage,
  LiveMessageAPI,
  LiveMessageState,
  OutOfRangeNotification,
  TelegramContext,
  TelegramNotifyClose,
  TelegramNotifyDeploy,
  TelegramNotifyOOR,
  TelegramNotifySwap,
  TelegramUpdate,
} from "./telegram.js";

// Export from token.d.ts (unique only)
export type {
  SmartWalletHolding,
  SmartWalletHoldingPnl,
  TokenAudit,
  TokenCluster,
  TokenHolder,
  TokenHolderFunding,
  TokenHoldersInput,
  TokenHoldersResult,
  TokenInfo,
  TokenInfoInput,
  TokenNarrative,
  TokenNarrativeInput,
  TokenStats1h,
} from "./token.js";

// Export from tools.d.ts (unique only)
export type {
  ToolParameterProperty,
  ToolParameters,
} from "./tools.js";

// Export all from wallet.d.ts (all unique)
export * from "./wallet.js";

// Export all from weights.d.ts (all unique)
export * from "./weights.js";
