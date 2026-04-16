// src/infrastructure/cycle-state.ts
// Centralized state manager for cycle operations to prevent race conditions
// Uses closure pattern (not class) to avoid `this` binding issues

import { Mutex } from "async-mutex";
import type { CronTaskList, CycleTimers } from "../types/index.js";

export interface CycleState {
  // Cron tasks
  getCronTasks(): CronTaskList;
  setCronTasks(tasks: CronTaskList): void;

  // PnL Poll
  getPnlPollInterval(): NodeJS.Timeout | undefined;
  setPnlPollInterval(interval: NodeJS.Timeout | undefined): void;

  // Busy flags
  isManagementBusy(): boolean;
  setManagementBusy(busy: boolean): void;
  isScreeningBusy(): boolean;
  setScreeningBusy(busy: boolean): void;

  // Timestamps
  getScreeningLastTriggered(): number;
  setScreeningLastTriggered(time: number): void;
  getPollTriggeredAt(): number;
  setPollTriggeredAt(time: number): void;

  // Cron status
  isCronStarted(): boolean;
  setCronStarted(started: boolean): void;

  // Timers
  getTimers(): CycleTimers;

  // Mutex
  getScreeningMutex(): Mutex;
}

export function createCycleState(): CycleState {
  // Private state (closure-scoped)
  let _cronTasks: CronTaskList = [];
  let _pnlPollInterval: NodeJS.Timeout | undefined;
  let _managementBusy = false;
  let _screeningBusy = false;
  let _screeningLastTriggered = 0;
  let _pollTriggeredAt = 0;
  let _cronStarted = false;
  const _timers: CycleTimers = {
    managementLastRun: null,
    screeningLastRun: null,
  };
  const _screeningMutex = new Mutex();

  return {
    // Cron tasks
    getCronTasks(): CronTaskList {
      return _cronTasks;
    },
    setCronTasks(tasks: CronTaskList): void {
      _cronTasks = tasks;
    },

    // PnL Poll
    getPnlPollInterval(): NodeJS.Timeout | undefined {
      return _pnlPollInterval;
    },
    setPnlPollInterval(interval: NodeJS.Timeout | undefined): void {
      _pnlPollInterval = interval;
    },

    // Busy flags
    isManagementBusy(): boolean {
      return _managementBusy;
    },
    setManagementBusy(busy: boolean): void {
      _managementBusy = busy;
    },
    isScreeningBusy(): boolean {
      return _screeningBusy;
    },
    setScreeningBusy(busy: boolean): void {
      _screeningBusy = busy;
    },

    // Timestamps
    getScreeningLastTriggered(): number {
      return _screeningLastTriggered;
    },
    setScreeningLastTriggered(time: number): void {
      _screeningLastTriggered = time;
    },
    getPollTriggeredAt(): number {
      return _pollTriggeredAt;
    },
    setPollTriggeredAt(time: number): void {
      _pollTriggeredAt = time;
    },

    // Cron status
    isCronStarted(): boolean {
      return _cronStarted;
    },
    setCronStarted(started: boolean): void {
      _cronStarted = started;
    },

    // Timers
    getTimers(): CycleTimers {
      return _timers;
    },

    // Mutex
    getScreeningMutex(): Mutex {
      return _screeningMutex;
    },
  };
}

// Singleton instance
export const cycleState = createCycleState();
