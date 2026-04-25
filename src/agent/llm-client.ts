/**
 * LLM Client
 *
 * Handles all LLM provider interactions:
 * - OpenAI client initialization
 * - Provider fallback (system → user_embedded)
 * - Tool choice handling (auto/required/none)
 * - Retry logic with exponential backoff
 * - Model fallback on transient errors (502/503/529)
 */

import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { tools } from "../../tools/definitions/index.js";
import { config } from "../config/config.js";
import { FALLBACK_MODELS, RETRY, TIME, TIMEOUT } from "../config/constants.js";
import { log } from "../infrastructure/logger.js";
import type {
  AgentType,
  OpenAIError,
  ProviderMode,
  ToolChoice,
  ToolDefinition,
} from "../types/index.js";
import { rateLimiters, withRateLimit } from "../utils/rate-limiter.js";
import { INTENTS } from "./intent.js";
import { GENERAL_INTENT_ONLY_TOOLS, MANAGER_TOOLS, SCREENER_TOOLS } from "./tool-sets.js";

/** OpenAI client instance */
export const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: TIMEOUT.RPC_TIMEOUT_MS,
});

/** Default model from config */
export const DEFAULT_MODEL = config.llm.generalModel;

/** Intent patterns requiring tool use */
const TOOL_REQUIRED_INTENTS: RegExp =
  /\b(deploy|open position|open|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|self.?update|pull latest|git pull|update yourself|config|setting|threshold|set |change|update |balance|wallet|position|portfolio|pnl|yield|range|screen|candidate|find pool|search|research|token|smart wallet|whale|watch.?list|tracked wallet|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|lesson|learned|teach|pin|unpin)\b/i;

/** Action intents forcing tool_choice=required on step 0 */
const ACTION_INTENTS: RegExp =
  /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;

/**
 * Get tools filtered for the current agent role and goal.
 *
 * @param agentType - Agent role (MANAGER, SCREENER, GENERAL)
 * @param goal - User's goal for intent matching
 * @returns Filtered tool definitions
 */
export function getToolsForRole(agentType: AgentType, goal: string): ToolDefinition[] {
  if (agentType === "MANAGER") return tools.filter((t) => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter((t) => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set<string>();
  for (const intent of INTENTS) {
    if (intent.pattern.test(goal)) {
      for (const tool of intent.requiredTools) matched.add(tool);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0)
    return tools.filter((t) => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter((t) => matched.has(t.function.name));
}

/**
 * Determine if tool use should be required for this request.
 *
 * @param goal - User's goal
 * @param agentType - Agent role
 * @param requireTool - Explicit override
 * @returns Whether to require tool use
 */
export function shouldRequireRealToolUse(
  goal: string,
  agentType: AgentType,
  requireTool: boolean
): boolean {
  if (requireTool) return true;
  if (agentType === "MANAGER") return false;
  return TOOL_REQUIRED_INTENTS.test(goal);
}

/**
 * Build message array based on provider mode.
 *
 * @param systemPrompt - System prompt content
 * @param sessionHistory - Previous messages
 * @param goal - Current user goal
 * @param providerMode - Provider compatibility mode
 * @returns Message array for LLM
 */
export function buildMessages(
  systemPrompt: string,
  sessionHistory: ChatCompletionMessageParam[],
  goal: string,
  providerMode: ProviderMode
): ChatCompletionMessageParam[] {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

/**
 * Check if error is a system role rejection.
 *
 * @param error - Error object
 * @returns True if provider rejected system role
 */
export function isSystemRoleError(error: unknown): boolean {
  const err = error as OpenAIError;
  const message = String(err?.message || err?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

/**
 * Check if error is a tool_choice rejection.
 *
 * @param error - Error object
 * @returns True if provider rejected tool_choice parameter
 */
export function isToolChoiceError(error: unknown): boolean {
  const err = error as OpenAIError;
  const message = String(err?.message || err?.error?.message || error || "");
  return /tool_choice/i.test(message) || /no endpoints found.*tool/i.test(message);
}

/**
 * Determine tool_choice value for current step.
 *
 * @param step - Current ReAct step
 * @param goal - User's goal
 * @param mustUseRealTool - Whether tool use is required
 * @returns Tool choice (required/auto) or null if disabled
 */
export function getToolChoice(
  step: number,
  goal: string,
  mustUseRealTool: boolean
): ToolChoice | null {
  if (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) {
    return "required";
  }
  return "auto";
}

/** Chat completion request parameters */
interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

/** Result of LLM call with metadata */
export interface LlmResult {
  response: ChatCompletion;
  usedModel: string;
  providerMode: ProviderMode;
  toolChoice: ToolChoice | null;
}

/**
 * Call LLM with retries, fallback, and provider compatibility handling.
 *
 * @param params - Call parameters
 * @returns LLM response with metadata
 */
export async function callLlm({
  model,
  messages,
  tools,
  toolChoice,
  temperature,
  maxTokens,
  providerMode,
  systemPrompt,
  sessionHistory,
  goal,
}: {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ToolDefinition[];
  toolChoice: ToolChoice | null;
  temperature: number;
  maxTokens: number;
  providerMode: ProviderMode;
  systemPrompt: string;
  sessionHistory: ChatCompletionMessageParam[];
  goal: string;
}): Promise<LlmResult> {
  const FALLBACK_MODEL = FALLBACK_MODELS[0] ?? "stepfun/step-3.5-flash:free";
  let response: ChatCompletion | undefined;
  let usedModel = model;
  let currentProviderMode = providerMode;
  let currentToolChoice = toolChoice;
  let currentMessages = messages;

  for (let attempt = 0; attempt < RETRY.MAX_RPC_RETRIES; attempt++) {
    try {
      const requestParams: ChatCompletionRequest = {
        model: usedModel,
        messages: currentMessages,
        tools,
        temperature,
        max_tokens: maxTokens,
      };

      if (currentToolChoice !== null) {
        requestParams.tool_choice = currentToolChoice;
      }

      // biome-ignore lint/performance/noAwaitInLoops: intentional retry loop
      response = await withRateLimit(rateLimiters.openrouter, () =>
        client.chat.completions.create(requestParams)
      );
    } catch (error) {
      // Provider rejected system role — switch to user_embedded mode
      if (currentProviderMode === "system" && isSystemRoleError(error)) {
        currentProviderMode = "user_embedded";
        currentMessages = buildMessages(systemPrompt, sessionHistory, goal, currentProviderMode);
        log("agent", "Provider rejected system role — retrying with embedded system instructions");
        attempt -= 1;
        continue;
      }

      // Provider rejected tool_choice — disable it
      if (currentToolChoice !== null && isToolChoiceError(error)) {
        currentToolChoice = null;
        log("agent", "Provider rejected tool_choice — retrying without tool_choice parameter");
        attempt -= 1;
        continue;
      }

      throw error;
    }

    if (response.choices?.length) {
      return {
        response,
        usedModel,
        providerMode: currentProviderMode,
        toolChoice: currentToolChoice,
      };
    }

    // Handle transient provider errors
    const errCode = (response as unknown as { error?: { code?: number } }).error?.code;
    if (errCode === 502 || errCode === 503 || errCode === 529) {
      const wait = (attempt + 1) * RETRY.BASE_RETRY_WAIT_MS;
      if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
        usedModel = FALLBACK_MODEL;
        log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
      } else {
        log(
          "agent",
          `Provider error ${errCode}, retrying in ${wait / TIME.SECOND}s (attempt ${attempt + 1}/${RETRY.MAX_RPC_RETRIES})`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    } else {
      break;
    }
  }

  if (!response?.choices?.length) {
    log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
    throw new Error(
      `API returned no choices: ${(response as unknown as { error?: { message?: string } }).error?.message || JSON.stringify(response)}`
    );
  }

  return {
    response,
    usedModel,
    providerMode: currentProviderMode,
    toolChoice: currentToolChoice,
  };
}
