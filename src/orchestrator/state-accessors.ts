// src/orchestrator/state-accessors.ts
// Simple state accessors delegated to cycleState singleton

import { cycleState } from "../infrastructure/cycle-state.js";
import type { CycleTimers } from "../types/index.js";

export function isManagementBusy(): boolean {
  return cycleState.isManagementBusy();
}

export function setManagementBusy(busy: boolean): void {
  cycleState.setManagementBusy(busy);
}

export function getTimers(): CycleTimers {
  return cycleState.getTimers();
}

export function setCronStarted(started: boolean): void {
  cycleState.setCronStarted(started);
}
