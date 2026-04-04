// types/agent.d.ts

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentOptions {
  requireTool?: boolean;
  interactive?: boolean;
  onToolStart?: (params: { name: string; args: Record<string, unknown>; step: number }) => Promise<void>;
  onToolFinish?: (params: { name: string; args: Record<string, unknown>; result: unknown; success: boolean; step: number }) => Promise<void>;
}

export interface AgentResult {
  content: string;
  userMessage: string;
}

export type AgentType = "MANAGER" | "SCREENER" | "GENERAL";

export interface ToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

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
