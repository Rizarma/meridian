import type { ToolDefinition } from "../../types/index.js";
import { adminTools } from "./admin.js";
import { dataTools } from "./data.js";
import { managementTools } from "./management.js";
import { screeningTools } from "./screening.js";

export { adminTools, dataTools, managementTools, screeningTools };

export const tools: ToolDefinition[] = [
  ...screeningTools,
  ...managementTools,
  ...dataTools,
  ...adminTools,
];
