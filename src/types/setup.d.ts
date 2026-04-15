// types/setup.d.ts
// Setup wizard types for interactive configuration

/** Risk preset configuration */
export interface PresetConfig {
  label: string;
  timeframe: string;
  minOrganic: number;
  minHolders: number;
  maxMcap: number;
  takeProfitFeePct: number;
  stopLossPct: number;
  outOfRangeWaitMinutes: number;
  managementIntervalMin: number;
  screeningIntervalMin: number;
  description: string;
}

/** Collection of all presets */
export interface Presets {
  degen: PresetConfig;
  moderate: PresetConfig;
  safe: PresetConfig;
}

/** LLM provider configuration */
export interface LLMProvider {
  label: string;
  key: string;
  baseUrl: string;
  keyHint: string;
  modelDefault: string;
}

/** User configuration output from setup wizard */
export interface UserConfig {
  preset: string;
  rpcUrl: string;
  deployAmountSol: number;
  maxPositions: number;
  minSolToOpen: number;
  timeframe: string;
  minOrganic: number;
  minHolders: number;
  maxMcap: number;
  takeProfitFeePct: number;
  stopLossPct: number;
  outOfRangeWaitMinutes: number;
  managementIntervalMin: number;
  screeningIntervalMin: number;
  llmProvider: string;
  telegramChatId: string;
  dryRun: boolean;
  // Legacy fields that may exist in existing configs (secrets now only in .env)
  walletKey?: string;
  llmApiKey?: string;
  [key: string]: unknown;
}

/** Environment variable map */
export interface EnvMap {
  [key: string]: string;
}

/** Choice option for askChoice */
export interface ChoiceOption<T = string> {
  label: string;
  key: T;
}

/** Ask function type - basic text input */
export type AskFn = (question: string, defaultVal?: string) => Promise<string>;

/** Ask number function options */
export interface AskNumOptions {
  min?: number;
  max?: number;
}

/** Ask number function type */
export type AskNumFn = (
  question: string,
  defaultVal: number,
  options?: AskNumOptions
) => Promise<number>;

/** Ask boolean function type */
export type AskBoolFn = (question: string, defaultVal: boolean) => Promise<boolean>;

/** Ask choice function type */
export type AskChoiceFn = <T extends string>(
  question: string,
  choices: ChoiceOption<T>[]
) => Promise<ChoiceOption<T>>;

/** Setup wizard context */
export interface SetupContext {
  existingConfig: Partial<UserConfig>;
  existingEnv: EnvMap;
}

/** Setup summary display data */
export interface SetupSummary {
  presetName: string;
  dryRun: boolean;
  deployAmountSol: number;
  maxPositions: number;
  minSolToOpen: number;
  timeframe: string;
  minOrganic: number;
  minHolders: number;
  takeProfitFeePct: number;
  stopLossPct: number;
  outOfRangeWaitMinutes: number;
  managementIntervalMin: number;
  screeningIntervalMin: number;
  providerLabel: string;
  telegramEnabled: boolean;
  envPath: string;
  configPath: string;
}
