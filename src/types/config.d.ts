// types/config.d.ts

export interface RiskConfig {
  maxPositions: number;
  maxDeployAmount: number;
}

export interface ScreeningConfig {
  minFeeActiveTvlRatio: number;
  minTvl: number;
  maxTvl: number;
  minVolume: number;
  minOrganic: number;
  minHolders: number;
  minMcap: number;
  maxMcap: number;
  minBinStep: number;
  maxBinStep: number;
  maxVolatility: number | null;
  timeframe: string;
  category: string;
  minTokenFeesSol: number;
  maxBundlePct: number;
  maxBotHoldersPct: number;
  maxTop10Pct: number;
  blockedLaunchpads: string[];
  allowedLaunchpads: string[];
  minTokenAgeHours: number | null;
  maxTokenAgeHours: number | null;
  athFilterPct: number | null;
  maxPoolsPerCycle: number;
}

export interface ManagementConfig {
  minClaimAmount: number;
  autoSwapAfterClaim: boolean;
  outOfRangeBinsToClose: number;
  outOfRangeWaitMinutes: number;
  oorCooldownTriggerCount: number;
  oorCooldownHours: number;
  minVolumeToRebalance: number;
  stopLossPct: number;
  takeProfitFeePct: number;
  minFeePerTvl24h: number;
  minAgeBeforeYieldCheck: number;
  minSolToOpen: number;
  deployAmountSol: number;
  gasReserve: number;
  positionSizePct: number;
  trailingTriggerPct: number;
  trailingDropPct: number;
  pnlSanityMaxDiffPct: number;
}

export interface StrategyConfig {
  strategy: string;
  binsBelow: number;
}

export interface ScheduleConfig {
  managementIntervalMin: number;
  screeningIntervalMin: number;
  healthCheckIntervalMin: number;
}

export interface LlmConfig {
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  managementModel: string;
  screeningModel: string;
  generalModel: string;
}

export interface TokenConfig {
  SOL: string;
  USDC: string;
  USDT: string;
}

export interface DarwinConfig {
  windowDays?: number;
  minSamples?: number;
  boostFactor?: number;
  decayFactor?: number;
  weightFloor?: number;
  weightCeiling?: number;
}

export interface FeaturesConfig {
  trailingTakeProfit: boolean;
  hiveMind: boolean;
  darwinEvolution: boolean;
  solMode: boolean;
  okx: boolean;
}

export interface Config {
  risk: RiskConfig;
  screening: ScreeningConfig;
  management: ManagementConfig;
  strategy: StrategyConfig;
  schedule: ScheduleConfig;
  llm: LlmConfig;
  tokens: TokenConfig;
  darwin: DarwinConfig;
  features: FeaturesConfig;
}

export interface UserConfigPartial {
  rpcUrl?: string;
  walletKey?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  dryRun?: boolean;
  maxPositions?: number;
  maxDeployAmount?: number;
  minFeeActiveTvlRatio?: number;
  minTvl?: number;
  maxTvl?: number;
  minVolume?: number;
  minOrganic?: number;
  minHolders?: number;
  minMcap?: number;
  maxMcap?: number;
  minBinStep?: number;
  maxBinStep?: number;
  maxVolatility?: number | null;
  timeframe?: string;
  category?: string;
  minTokenFeesSol?: number;
  maxBundlePct?: number;
  maxBotHoldersPct?: number;
  maxTop10Pct?: number;
  blockedLaunchpads?: string[];
  allowedLaunchpads?: string[];
  minTokenAgeHours?: number | null;
  maxTokenAgeHours?: number | null;
  athFilterPct?: number | null;
  maxPoolsPerCycle?: number;
  minClaimAmount?: number;
  autoSwapAfterClaim?: boolean;
  outOfRangeBinsToClose?: number;
  outOfRangeWaitMinutes?: number;
  oorCooldownTriggerCount?: number;
  oorCooldownHours?: number;
  minVolumeToRebalance?: number;
  stopLossPct?: number;
  takeProfitFeePct?: number;
  minFeePerTvl24h?: number;
  minAgeBeforeYieldCheck?: number;
  minSolToOpen?: number;
  deployAmountSol?: number;
  gasReserve?: number;
  positionSizePct?: number;
  trailingTakeProfit?: boolean;
  trailingTriggerPct?: number;
  trailingDropPct?: number;
  pnlSanityMaxDiffPct?: number;
  solMode?: boolean;
  strategy?: string;
  binsBelow?: number;
  managementIntervalMin?: number;
  screeningIntervalMin?: number;
  healthCheckIntervalMin?: number;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  managementModel?: string;
  screeningModel?: string;
  generalModel?: string;
  emergencyPriceDropPct?: number;
  darwin?: DarwinConfig;
  features?: Partial<FeaturesConfig>;
  // Flat key fallbacks for feature flags (written by older versions or update_config)
  hiveMind?: boolean;
  darwinEvolution?: boolean;
  okx?: boolean;
}
