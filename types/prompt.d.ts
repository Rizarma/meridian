/**
 * Prompt builder types
 */

export type AgentType = "SCREENER" | "MANAGER" | "GENERAL";

export interface PromptContext {
  portfolio: unknown;
  positions: unknown;
  stateSummary: unknown;
  lessons: string | null;
  perfSummary: unknown;
}
