/**
 * Prompt builder types
 */

import type { AgentType } from "./agent.js";

export type { AgentType };

export interface PromptContext {
  portfolio: unknown;
  positions: unknown;
  stateSummary: unknown;
  lessons: string | null;
  perfSummary: unknown;
}
