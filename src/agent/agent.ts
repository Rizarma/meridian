import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { tools } from "../../tools/definitions/index.js";
import { getMyPositions } from "../../tools/dlmm.js";
import { getWalletBalances } from "../../tools/wallet.js";
import { config } from "../config/config.js";
import { FALLBACK_MODELS, MAX_REACT_STEPS, RETRY, TIME, TIMEOUT } from "../config/constants.js";
import { getLessonsForPrompt, getPerformanceSummary } from "../domain/lessons.js";
import { formatSharedLessonsForPrompt } from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import { getStateSummary } from "../infrastructure/state.js";
import type {
  AgentOptions,
  AgentResult,
  AgentType,
  OpenAIError,
  ProviderMode,
  ToolChoice,
  ToolDefinition,
} from "../types/index.js";
import { getErrorMessage } from "../utils/errors.js";
import { recordActivity } from "../utils/health-check.js";
import { rateLimiters, withRateLimit } from "../utils/rate-limiter.js";
import { INTENTS } from "./intent.js";
import { repairToolCallJson } from "./json-repair.js";
import { preCheckOncePerSession } from "./once-per-session.js";
import { buildSystemPrompt } from "./prompt.js";
import { executeToolsParallel } from "./tool-execution.js";
import { GENERAL_INTENT_ONLY_TOOLS, MANAGER_TOOLS, SCREENER_TOOLS } from "./tool-sets.js";

// Interface for chat completion request parameters
interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

// Intent routing unified in src/agent/intent.ts (INTENTS array)
// Use detectIntent(), getToolsForIntent(), getRoleForIntent() from that module
// Tool sets imported from src/agent/tool-sets.ts (side-effect-free module)

function getToolsForRole(agentType: AgentType, goal: string): ToolDefinition[] {
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

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: TIMEOUT.RPC_TIMEOUT_MS,
});

const DEFAULT_MODEL = config.llm.generalModel;

const TOOL_REQUIRED_INTENTS: RegExp =
  /\b(deploy|open position|open|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|self.?update|pull latest|git pull|update yourself|config|setting|threshold|set |change|update |balance|wallet|position|portfolio|pnl|yield|range|screen|candidate|find pool|search|research|token|smart wallet|whale|watch.?list|tracked wallet|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|lesson|learned|teach|pin|unpin)\b/i;

function shouldRequireRealToolUse(
  goal: string,
  agentType: AgentType,
  requireTool: boolean
): boolean {
  if (requireTool) return true;
  if (agentType === "MANAGER") return false;
  return TOOL_REQUIRED_INTENTS.test(goal);
}

function buildMessages(
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

function isSystemRoleError(error: unknown): boolean {
  const err = error as OpenAIError;
  const message = String(err?.message || err?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceError(error: unknown): boolean {
  const err = error as OpenAIError;
  const message = String(err?.message || err?.error?.message || error || "");
  // Catch any tool_choice related errors (provider doesn't support the parameter)
  return /tool_choice/i.test(message) || /no endpoints found.*tool/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param goal - The task description for the agent
 * @param maxSteps - Safety limit on iterations (default 20)
 * @returns The agent's final text response
 */
export async function agentLoop(
  goal: string,
  maxSteps: number = config.llm.maxSteps ?? MAX_REACT_STEPS,
  sessionHistory: ChatCompletionMessageParam[] = [],
  agentType: AgentType = "GENERAL",
  model: string | null = null,
  maxOutputTokens: number | null = null,
  options: AgentOptions = {}
): Promise<AgentResult> {
  const { requireTool = false, onToolStart = null, onToolFinish = null } = options;

  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = await getStateSummary();
  const lessons = await getLessonsForPrompt({ agentType });
  const perfSummary = await getPerformanceSummary();
  // Fetch shared hive lessons — fail-open, returns "" if disabled or error
  const sharedLessons = await formatSharedLessonsForPrompt();
  const systemPrompt = buildSystemPrompt({
    agentType,
    portfolio,
    positions,
    stateSummary,
    lessons,
    perfSummary,
    sharedLessons: sharedLessons || null,
  });

  let providerMode: ProviderMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const firedOnce = new Set<string>();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, requireTool);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = FALLBACK_MODELS[0] ?? "stepfun/step-3.5-flash:free";
      let response: ChatCompletion | undefined;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS: RegExp =
        /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice: ToolChoice | null =
        step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool) ? "required" : "auto";

      for (let attempt = 0; attempt < RETRY.MAX_RPC_RETRIES; attempt++) {
        try {
          const requestParams: ChatCompletionRequest = {
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          // Only include tool_choice if provider supports it
          if (toolChoice !== null) {
            requestParams.tool_choice = toolChoice;
          }
          // biome-ignore lint/performance/noAwaitInLoops: intentional retry loop
          response = await withRateLimit(rateLimiters.openrouter, () =>
            client.chat.completions.create(requestParams)
          );
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log(
              "agent",
              "Provider rejected system role — retrying with embedded system instructions"
            );
            attempt -= 1;
            continue;
          }
          if (toolChoice !== null && isToolChoiceError(error)) {
            toolChoice = null; // Disable tool_choice entirely for this provider
            log("agent", "Provider rejected tool_choice — retrying without tool_choice parameter");
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
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
      const msg: ChatCompletionMessage = response.choices[0].message;

      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        repairToolCallJson(
          msg.tool_calls as Array<{
            id: string;
            function: { name: string; arguments: string };
          }>
        );
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log(
            "agent",
            `Rejected no-tool final answer (${noToolRetryCount}/${RETRY.MAX_NO_TOOL_RETRIES}) for tool-required request`
          );
          if (noToolRetryCount >= RETRY.MAX_NO_TOOL_RETRIES) {
            recordActivity();
            return {
              content:
                "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content:
              providerMode === "system"
                ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
                : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        recordActivity();
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Pre-reserve once-per-session tools BEFORE parallel execution to prevent
      // race conditions where multiple destructive calls pass the guard simultaneously
      const preCheckedCalls = preCheckOncePerSession(
        msg.tool_calls as Array<{
          id: string;
          function: { name: string; arguments: string };
        }>,
        firedOnce
      );

      // Execute all tool calls in parallel (blocked calls resolve immediately)
      const toolResults = await executeToolsParallel(
        preCheckedCalls,
        agentType,
        step,
        onToolStart,
        onToolFinish
      );

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${getErrorMessage(error)}`);

      // If it's a rate limit, wait and retry
      if ((error as { status?: number }).status === 429) {
        log("agent", `Rate limited, waiting ${TIMEOUT.API_TIMEOUT_MS / TIME.SECOND}s...`);
        await sleep(TIMEOUT.API_TIMEOUT_MS);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  recordActivity();
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
