// types/telegram.d.ts

export interface TelegramMessage {
  message_id?: number;
  chat?: {
    id: number;
    type?: string;
  };
  text?: string;
  from?: {
    id: number;
    username?: string;
  };
}

export interface TelegramContext {
  message?: TelegramMessage;
  chat?: {
    id: number;
  };
}

export interface LiveMessage {
  toolStart: (name: string) => Promise<void>;
  toolFinish: (name: string, result: unknown, success: boolean) => Promise<void>;
  note: (text: string) => Promise<void>;
  finalize: (text: string) => Promise<void>;
  fail: (error: string) => Promise<void>;
}

export interface OutOfRangeNotification {
  pair: string;
  minutesOOR: number;
}

export interface TelegramNotifyDeploy {
  pair: string;
  amountSol: number;
  position?: string;
  tx?: string;
  priceRange?: { min: number; max: number };
  binStep?: number;
  baseFee?: number;
}

export interface TelegramNotifyClose {
  pair: string;
  pnlUsd: number;
  pnlPct: number;
}

export interface TelegramNotifySwap {
  inputSymbol: string;
  outputSymbol: string;
  amountIn?: number;
  amountOut?: number;
  tx?: string;
}

export interface TelegramNotifyOOR {
  pair: string;
  minutesOOR: number;
}

export interface LiveMessageState {
  title: string;
  intro: string;
  toolLines: string[];
  footer: string;
  messageId: number | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void> | null;
  flushRequested: boolean;
}

export interface LiveMessageAPI {
  toolStart(name: string): Promise<void>;
  toolFinish(name: string, result: unknown, success: boolean): Promise<void>;
  note(text: string): Promise<void>;
  finalize(finalText: string): Promise<void>;
  fail(errorText: string): Promise<void>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
