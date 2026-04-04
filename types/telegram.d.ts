// types/telegram.d.ts

export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
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
