import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getMyPositions } from "../../tools/dlmm.js";
import { getWalletBalances } from "../../tools/wallet.js";
import { config } from "../config/config.js";
import { MAX_REACT_STEPS, RETRY, TIME, TIMEOUT } from "../config/constants.js";
import { getLessonsForPrompt, getPerformanceSummary } from "../domain/lessons.js";
import { formatSharedLessonsForPrompt } from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import { getStateSummary } from "../infrastructure/state.js";
import { stopAllTypingIndicators } from "../infrastructure/telegram.js";
import type { AgentOptions, AgentResult, AgentType, ProviderMode } from "../types/index.js";
import { getErrorMessage } from "../utils/errors.js";
import { recordActivity } from "../utils/health-check.js";
import { repairToolCallJson } from "./json-repair.js";
import {
  buildMessages,
  callLlm,
  DEFAULT_MODEL,
  getToolChoice,
  getToolsForRole,
  shouldRequireRealToolUse,
} from "./llm-client.js";
import { preCheckOncePerSession } from "./once-per-session.js";
import { buildSystemPrompt } from "./prompt.js";
import { executeToolsParallel } from "./tool-execution.js";

// Intent routing unified in src/agent/intent.ts (INTENTS array)
// Use detectIntent(), getToolsForIntent(), getRoleForIntent() from that module
// Tool sets imported from src/agent/tool-sets.ts (side-effect-free module)

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
      const toolChoice = getToolChoice(step, goal, mustUseRealTool);

      // Call LLM with retries, fallback, and provider compatibility handling
      const llmResult = await callLlm({
        model: activeModel,
        messages,
        tools: getToolsForRole(agentType, goal),
        toolChoice,
        temperature: config.llm.temperature,
        maxTokens: maxOutputTokens ?? config.llm.maxTokens,
        providerMode,
        systemPrompt,
        sessionHistory,
        goal,
      });

      // Update state from LLM call result
      const { response, providerMode: newProviderMode } = llmResult;
      if (newProviderMode !== providerMode) {
        providerMode = newProviderMode;
        messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
      }

      const msg = response.choices[0].message;

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
      // Wrap with step-level timeout as final safety net
      const stepTimeoutMs = TIMEOUT.TOOL_EXECUTION_MS + 30 * TIME.SECOND; // Tool timeout + buffer
      const toolResults = await Promise.race([
        executeToolsParallel(preCheckedCalls, agentType, step, onToolStart, onToolFinish),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            stopAllTypingIndicators(); // Force cleanup typing indicators on timeout
            reject(new Error(`Step ${step + 1} timed out after ${stepTimeoutMs / 1000}s`));
          }, stepTimeoutMs);
        }),
      ]);

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
