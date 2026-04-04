// types/agent.d.ts

import type {
  ChatCompletionMessageParam,
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

/** Agent role types */
export type AgentType = "MANAGER" | "SCREENER" | "GENERAL";

/** Tool choice options for LLM */
export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | {
      type: "function";
      function: { name: string };
    };

/** Intent pattern for matching user goals */
export interface IntentPattern {
  intent: string;
  re: RegExp;
}

/** Tool execution callbacks */
export interface ToolCallbacks {
  onToolStart?: (params: {
    name: string;
    args: Record<string, unknown>;
    step: number;
  }) => Promise<void>;
  onToolFinish?: (params: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    success: boolean;
    step: number;
  }) => Promise<void>;
}

/** Options for agent loop execution */
export interface AgentOptions extends ToolCallbacks {
  requireTool?: boolean;
  interactive?: boolean;
}

/** Result returned from agent loop */
export interface AgentResult {
  content: string;
  userMessage: string;
}

/** Maps intent strings to sets of tool names */
export interface IntentTools {
  [intent: string]: Set<string>;
}

/** OpenAI-compatible message for building prompts */
export type MessageParam = ChatCompletionMessageParam;

/** OpenAI chat completion response */
export type ChatCompletionResponse = ChatCompletion;

/** OpenAI message from completion */
export type CompletionMessage = ChatCompletionMessage;

/** OpenAI tool call structure (re-export for compatibility) */
export type ToolCall = ChatCompletionMessageToolCall;

/** Tool result for session history */
export interface ToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** Provider mode for system prompt handling */
export type ProviderMode = "system" | "user_embedded";

/** Error structure from OpenAI API or similar */
export interface OpenAIError {
  message?: string;
  error?: { message?: string };
  status?: number;
  code?: number;
}

/** Legacy AgentMessage interface for backward compatibility */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Tool definition structure */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}
