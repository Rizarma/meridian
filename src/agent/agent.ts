import { jsonrepair } from "jsonrepair";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { tools } from "../../tools/definitions/index.js";
import { getMyPositions } from "../../tools/dlmm.js";
import { executeTool } from "../../tools/executor.js";
import { getWalletBalances } from "../../tools/wallet.js";
import { config } from "../config/config.js";
import { FALLBACK_MODELS, MAX_REACT_STEPS } from "../config/constants.js";
import { getLessonsForPrompt, getPerformanceSummary } from "../domain/lessons.js";
import { log } from "../infrastructure/logger.js";
import { getStateSummary } from "../infrastructure/state.js";
import type {
  AgentOptions,
  AgentResult,
  AgentType,
  IntentTools,
  OpenAIError,
  ProviderMode,
  ToolChoice,
  ToolDefinition,
  ToolResult,
} from "../types/index.js";
import { INTENTS } from "./intent.js";
import { buildSystemPrompt } from "./prompt.js";
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
  timeout: 5 * 60 * 1000,
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
  const {
    requireTool = false,
    interactive = false,
    onToolStart = null,
    onToolFinish = null,
  } = options;

  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(
    agentType,
    portfolio,
    positions,
    stateSummary,
    lessons,
    perfSummary
  );

  let providerMode: ProviderMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION: Set<string> = new Set([
    "deploy_position",
    "swap_token",
    "close_position",
  ]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS: Set<string> = new Set(["deploy_position"]);
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

      for (let attempt = 0; attempt < 3; attempt++) {
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
          response = await client.chat.completions.create(requestParams);
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
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log(
              "agent",
              `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`
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
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(
                  JSON.parse(jsonrepair(tc.function.arguments))
                );
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
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
            `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`
          );
          if (noToolRetryCount >= 2) {
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
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults: ToolResult[] = await Promise.all(
        msg.tool_calls.map(async (toolCall) => {
          const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
          let functionArgs: Record<string, unknown>;

          try {
            functionArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
          } catch {
            try {
              functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments)) as Record<
                string,
                unknown
              >;
              log("warn", `Repaired malformed JSON args for ${functionName}`);
            } catch (parseError) {
              log(
                "error",
                `Failed to parse args for ${functionName}: ${(parseError as Error).message}`
              );
              functionArgs = {};
            }
          }

          // Block once-per-session tools from firing a second time
          if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
            log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
            await onToolFinish?.({
              name: functionName,
              args: functionArgs,
              result: {
                blocked: true,
                reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
              },
              success: false,
              step,
            });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                blocked: true,
                reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
              }),
            };
          }

          await onToolStart?.({ name: functionName, args: functionArgs, step });
          const result = await executeTool(functionName, functionArgs);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result,
            success: result?.success !== false && !result?.error && !result?.blocked,
            step,
          });

          // Lock deploy_position after first attempt regardless of outcome — retrying is never right
          // For close/swap: only lock on success so genuine failures can be retried
          if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
          else if (ONCE_PER_SESSION.has(functionName) && result.success === true)
            firedOnce.add(functionName);

          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        })
      );

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${(error as Error).message}`);

      // If it's a rate limit, wait and retry
      if ((error as { status?: number }).status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
