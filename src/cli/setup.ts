/**
 * Interactive setup wizard.
 * Guides user through .env + user-config.json creation.
 * Run: pnpm run setup
 */

import fs from "node:fs";
import readline from "node:readline";
import { ENV_PATH, USER_CONFIG_PATH } from "../config/paths.js";
import type {
  AskBoolFn,
  AskChoiceFn,
  AskFn,
  AskNumFn,
  AskNumOptions,
  ChoiceOption,
  EnvMap,
  LLMProvider,
  PresetConfig,
  Presets,
  UserConfig,
} from "../types/setup.d.ts";
import { colors, error, header } from "./colors.js";

const _DEFAULT_MODEL = "openai/gpt-oss-20b:free";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * Ask a basic text question with optional default value.
 * @param question - The question to display to the user
 * @param defaultVal - Optional default value if user presses Enter
 * @returns Promise resolving to the user's input (or default)
 */
const ask: AskFn = (question: string, defaultVal?: string): Promise<string> => {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined && defaultVal !== "" ? ` (default: ${defaultVal})` : "";
    rl.question(`${question}${hint}: `, (ans: string) => {
      const trimmed = ans.trim();
      resolve(trimmed === "" ? (defaultVal ?? "") : trimmed);
    });
  });
};

/**
 * Ask for a numeric value with optional min/max validation.
 * @param question - The question to display
 * @param defaultVal - Default numeric value
 * @param options - Optional min/max constraints
 * @returns Promise resolving to the validated number
 */
const askNum: AskNumFn = async (
  question: string,
  defaultVal: number,
  { min, max }: AskNumOptions = {}
): Promise<number> => {
  while (true) {
    const raw = await ask(question, String(defaultVal));
    const n = parseFloat(raw);
    if (Number.isNaN(n)) {
      console.log(error(`  Please enter a number.`));
      continue;
    }
    if (min !== undefined && n < min) {
      console.log(error(`  Minimum is ${min}.`));
      continue;
    }
    if (max !== undefined && n > max) {
      console.log(error(`  Maximum is ${max}.`));
      continue;
    }
    return n;
  }
};

/**
 * Ask a yes/no question.
 * @param question - The question to display
 * @param defaultVal - Default boolean value
 * @returns Promise resolving to true (yes) or false (no)
 */
const askBool: AskBoolFn = async (question: string, defaultVal: boolean): Promise<boolean> => {
  while (true) {
    const hint = defaultVal ? "Y/n" : "y/N";
    const raw = await ask(`${question} [${hint}]`, "");
    if (raw === "") return defaultVal;
    if (/^y(es)?$/i.test(raw)) return true;
    if (/^n(o)?$/i.test(raw)) return false;
    console.log(error("  Enter y or n."));
  }
};

/**
 * Ask user to select from a list of choices.
 * @param question - The question/prompt to display
 * @param choices - Array of choice options with label and key
 * @returns Promise resolving to the selected choice option
 */
const askChoice: AskChoiceFn = async <T extends string>(
  question: string,
  choices: ChoiceOption<T>[]
): Promise<ChoiceOption<T>> => {
  const labels = choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n");
  while (true) {
    console.log(`\n${question}`);
    console.log(labels);
    const raw = await ask("Enter number", "");
    const idx = parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx];
    console.log("  ⚠ Invalid choice.");
  }
};

/**
 * Parse .env file content into a key-value map.
 * @param content - Raw content of .env file
 * @returns Map of environment variable names to values
 */
function parseEnv(content: string): EnvMap {
  const map: EnvMap = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

/**
 * Build .env file content from a key-value map.
 * @param map - Environment variable map
 * @returns String content for .env file
 */
function buildEnv(map: EnvMap): string {
  return `${Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

// ─── Presets ──────────────────────────────────────────────────────────────────
const PRESETS: Presets = {
  degen: {
    label: "Degen",
    timeframe: "30m",
    minOrganic: 60,
    minHolders: 200,
    maxMcap: 5_000_000,
    takeProfitFeePct: 10,
    stopLossPct: -25,
    outOfRangeWaitMinutes: 15,
    managementIntervalMin: 5,
    screeningIntervalMin: 15,
    description: "30m timeframe, pumping tokens allowed, fast cycles. High risk/reward.",
  },
  moderate: {
    label: "Moderate",
    timeframe: "4h",
    minOrganic: 65,
    minHolders: 500,
    maxMcap: 10_000_000,
    takeProfitFeePct: 5,
    stopLossPct: -15,
    outOfRangeWaitMinutes: 30,
    managementIntervalMin: 10,
    screeningIntervalMin: 30,
    description: "4h timeframe, balanced risk/reward. Recommended for most users.",
  },
  safe: {
    label: "Safe",
    timeframe: "24h",
    minOrganic: 75,
    minHolders: 1000,
    maxMcap: 10_000_000,
    takeProfitFeePct: 3,
    stopLossPct: -10,
    outOfRangeWaitMinutes: 60,
    managementIntervalMin: 15,
    screeningIntervalMin: 60,
    description: "24h timeframe, stable pools only, avoids pumps. Lower yield, lower risk.",
  },
};

// ─── Load existing state ───────────────────────────────────────────────────────
const existingConfig: Partial<UserConfig> = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
const existingEnv: EnvMap = fs.existsSync(ENV_PATH)
  ? parseEnv(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const e = (key: keyof UserConfig, fallback: unknown) => existingConfig[key] ?? fallback;
const ev = (key: string, fallback: string) => existingEnv[key] ?? fallback;

// ─── Banner ────────────────────────────────────────────────────────────────────
console.log(
  colors.cyan(`
╔═══════════════════════════════════════════════╗
║        Meridian — Setup Wizard                ║
║        Autonomous Meteora DLMM LP Agent       ║
╚═══════════════════════════════════════════════╝
`)
);
console.log(colors.dim("This wizard creates your .env and user-config.json."));
console.log(colors.dim("Press Enter to keep the current/default value.\n"));

// ─── Section 1: API Keys & Wallet ─────────────────────────────────────────────
console.log(header("API Keys & Wallet"));

const alreadySet = (val: string) => (val ? "*** (already set — Enter to keep)" : "");

const openrouterKey = await ask(
  "OpenRouter API key (sk-or-...)",
  alreadySet(ev("OPENROUTER_API_KEY", ""))
);

const walletKey = await ask(
  "Wallet private key (base58)",
  alreadySet(ev("WALLET_PRIVATE_KEY", (existingConfig.walletKey as string) || ""))
);

const rpcUrl = await ask(
  "RPC URL",
  ev("RPC_URL", e("rpcUrl", "https://api.mainnet-beta.solana.com") as string)
);

const heliusKey = await ask(
  "Helius API key (for balance lookups, optional)",
  alreadySet(ev("HELIUS_API_KEY", ""))
);

// ─── Section 2: Telegram ──────────────────────────────────────────────────────
console.log(header("Telegram (optional — skip to disable)"));

const telegramToken = await ask("Telegram bot token", alreadySet(ev("TELEGRAM_BOT_TOKEN", "")));

const telegramChatId = await ask(
  "Telegram chat ID",
  ev("TELEGRAM_CHAT_ID", e("telegramChatId", "") as string)
);

// ─── Section 3: Preset ────────────────────────────────────────────────────────
const presetChoice = await askChoice("Select a risk preset:", [
  { label: `🔥 Degen    — ${PRESETS.degen.description}`, key: "degen" },
  { label: `⚖️  Moderate — ${PRESETS.moderate.description}`, key: "moderate" },
  { label: `🛡️  Safe     — ${PRESETS.safe.description}`, key: "safe" },
  { label: "⚙️  Custom   — Configure every setting manually", key: "custom" },
]);

const preset = presetChoice.key === "custom" ? null : PRESETS[presetChoice.key as keyof Presets];
const p = (key: keyof PresetConfig, fallback: unknown) =>
  preset?.[key] ?? e(key as keyof UserConfig, fallback);

console.log(
  preset
    ? colors.success(
        `\n✓ ${preset.label} preset selected. Override individual values below (Enter to keep).\n`
      )
    : colors.info("\nCustom mode — configure all settings.\n")
);

// ─── Section 4: Deployment ────────────────────────────────────────────────────
console.log(header("Deployment"));

const deployAmountSol = await askNum(
  "SOL to deploy per position",
  e("deployAmountSol", 0.3) as number,
  { min: 0.01, max: 50 }
);

const maxPositions = await askNum("Max concurrent positions", e("maxPositions", 3) as number, {
  min: 1,
  max: 10,
});

const minSolToOpen = await askNum(
  "Min SOL balance to open a new position",
  e("minSolToOpen", parseFloat((deployAmountSol + 0.05).toFixed(3))) as number,
  { min: 0.05 }
);

const dryRun = await askBool("Dry run mode? (no real transactions)", e("dryRun", true) as boolean);

// ─── Section 5: Risk & Filters ────────────────────────────────────────────────
console.log(header("Risk & Filters"));

const timeframe = await ask(
  "Pool discovery timeframe (30m / 1h / 4h / 12h / 24h)",
  p("timeframe", "4h") as string
);

const minOrganic = await askNum("Min organic score (0–100)", p("minOrganic", 65) as number, {
  min: 0,
  max: 100,
});

const minHolders = await askNum("Min token holders", p("minHolders", 500) as number, { min: 1 });

const maxMcap = await askNum("Max token market cap USD", p("maxMcap", 10_000_000) as number, {
  min: 100_000,
});

// ─── Section 6: Exit Rules ────────────────────────────────────────────────────
console.log(header("Exit Rules"));

const takeProfitFeePct = await askNum(
  "Take profit when fees earned >= X% of deployed capital",
  p("takeProfitFeePct", 5) as number,
  { min: 0.1, max: 100 }
);

const stopLossPct = await askNum(
  "Stop loss at X% price drop (e.g. -15)",
  p("stopLossPct", -15) as number,
  { min: -99, max: -1 }
);

const outOfRangeWaitMinutes = await askNum(
  "Minutes out-of-range before closing",
  p("outOfRangeWaitMinutes", 30) as number,
  { min: 1 }
);

// ─── Section 7: Scheduling ────────────────────────────────────────────────────
console.log(header("Scheduling"));

const managementIntervalMin = await askNum(
  "Management cycle interval (minutes)",
  p("managementIntervalMin", 10) as number,
  { min: 1 }
);

const screeningIntervalMin = await askNum(
  "Screening cycle interval (minutes)",
  p("screeningIntervalMin", 30) as number,
  { min: 5 }
);

// ─── Section 8: LLM Provider ─────────────────────────────────────────────────
console.log(header("LLM Provider"));

const LLM_PROVIDERS: LLMProvider[] = [
  {
    label: "OpenRouter   (openrouter.ai — many models)",
    key: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-...",
    modelDefault: "nousresearch/hermes-3-llama-3.1-405b",
  },
  {
    label: "MiniMax      (api.minimax.io)",
    key: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    keyHint: "your MiniMax API key",
    modelDefault: "MiniMax-Text-01",
  },
  {
    label: "OpenAI       (api.openai.com)",
    key: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    modelDefault: "gpt-4o",
  },
  {
    label: "Local / LM Studio / Ollama (OpenAI-compatible)",
    key: "local",
    baseUrl: "http://localhost:1234/v1",
    keyHint: "(leave blank or type any value)",
    modelDefault: "local-model",
  },
  {
    label: "Custom       (any OpenAI-compatible endpoint)",
    key: "custom",
    baseUrl: "",
    keyHint: "your API key",
    modelDefault: "",
  },
];

const providerChoice = await askChoice(
  "Select LLM provider:",
  LLM_PROVIDERS.map((p) => ({ label: p.label, key: p.key }))
);
const provider = LLM_PROVIDERS.find((p) => p.key === providerChoice.key);
if (!provider) {
  console.log(error("Invalid provider selection."));
  process.exit(1);
}

let llmBaseUrl = provider.baseUrl;
if (provider.key === "local" || provider.key === "custom") {
  llmBaseUrl = await ask(
    "Base URL",
    e("llmBaseUrl", provider.baseUrl || "http://localhost:1234/v1") as string
  );
}

const llmApiKeyExisting = e(
  "llmApiKey",
  existingEnv.LLM_API_KEY || existingEnv.OPENROUTER_API_KEY || ""
) as string;
const llmApiKeyRaw = await ask(
  "API Key",
  llmApiKeyExisting ? "*** (already set)" : provider.keyHint || ""
);
const llmApiKey = llmApiKeyRaw.startsWith("***") ? llmApiKeyExisting : llmApiKeyRaw;

const llmModel = await ask(
  "Model name",
  e("llmModel", process.env.LLM_MODEL || provider.modelDefault) as string
);

rl.close();

// ─── Write .env ───────────────────────────────────────────────────────────────
const isKept = (val: string) => !val || val.startsWith("***");

const envMap: EnvMap = {
  ...existingEnv,
  ...(isKept(openrouterKey) ? {} : { OPENROUTER_API_KEY: openrouterKey }),
  ...(isKept(walletKey) ? {} : { WALLET_PRIVATE_KEY: walletKey }),
  ...(rpcUrl ? { RPC_URL: rpcUrl } : {}),
  ...(isKept(heliusKey) ? {} : { HELIUS_API_KEY: heliusKey }),
  ...(isKept(telegramToken) ? {} : { TELEGRAM_BOT_TOKEN: telegramToken }),
  ...(telegramChatId ? { TELEGRAM_CHAT_ID: telegramChatId } : {}),
  DRY_RUN: dryRun ? "true" : "false",
};
fs.writeFileSync(ENV_PATH, buildEnv(envMap));

// ─── Write user-config.json ────────────────────────────────────────────────────
const userConfig: UserConfig = {
  ...existingConfig,
  preset: presetChoice.key,
  rpcUrl,
  deployAmountSol,
  maxPositions,
  minSolToOpen,
  timeframe,
  minOrganic,
  minHolders,
  maxMcap,
  takeProfitFeePct,
  stopLossPct,
  outOfRangeWaitMinutes,
  managementIntervalMin,
  screeningIntervalMin,
  llmProvider: provider.key,
  llmBaseUrl,
  llmModel,
  ...(llmApiKey ? { llmApiKey } : {}),
  telegramChatId: telegramChatId || "",
  dryRun,
};

// Remove legacy key if present
delete (userConfig as Partial<UserConfig> & { emergencyPriceDropPct?: unknown })
  .emergencyPriceDropPct;

fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

// ─── Summary ──────────────────────────────────────────────────────────────────
const presetName = preset ? `${preset.label}` : "Custom";

console.log(
  colors.green(`
╔═══════════════════════════════════════════════╗
║           Setup Complete                      ║
╚═══════════════════════════════════════════════╝
`)
);

console.log(colors.cyan("  Preset:       ") + colors.bold(presetName));
console.log(
  colors.cyan("  Dry run:      ") +
    (dryRun ? colors.yellow("YES — no real transactions") : colors.green("NO — live trading"))
);

console.log(
  colors.dim(`
  Deploy:       ${deployAmountSol} SOL/position  ·  max ${maxPositions} positions
  Min balance:  ${minSolToOpen} SOL to open new position
  Timeframe:    ${timeframe}  ·  organic ≥ ${minOrganic}  ·  holders ≥ ${minHolders}
  Take profit:  fees ≥ ${takeProfitFeePct}%
  Stop loss:    ${stopLossPct}% price drop
  OOR close:    after ${outOfRangeWaitMinutes} min

  Cycles:       management every ${managementIntervalMin}m  ·  screening every ${screeningIntervalMin}m
  Provider:     ${provider.label.split("(")[0].trim()}
  Model:        ${llmModel}
  Base URL:     ${llmBaseUrl}

  Telegram:     ${telegramToken ? colors.green("enabled") : colors.gray("disabled")}
  .env:         ${ENV_PATH}
  Config:       ${USER_CONFIG_PATH}
`)
);

console.log(colors.bold.green('\nRun "pnpm start" to launch the agent.'));
if (dryRun) {
  console.log(
    colors.yellow(
      "\n  ⚠ DRY RUN is ON — set dryRun: false in user-config.json when ready for live trading.\n"
    )
  );
}
