import fs from "node:fs";
import { Bot, type Context, GrammyError, HttpError } from "grammy";
import { USER_CONFIG_PATH } from "../config/paths.js";
import type {
  LiveMessageAPI,
  TelegramMessage,
  TelegramNotifyClose,
  TelegramNotifyDeploy,
  TelegramNotifyOOR,
  TelegramNotifySwap,
} from "../types/telegram.js";
import { getErrorMessage } from "../utils/errors.js";
import { log } from "./logger.js";

// Local types for live messages
interface LiveMessageState {
  title: string;
  intro: string;
  toolLines: string[];
  footer: string;
  messageId: number | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void> | null;
  flushRequested: boolean;
}

/**
 * Sanitize parsed JSON to prevent prototype pollution.
 * Removes __proto__, constructor, and prototype keys from objects.
 * Uses Object.create(null) to avoid prototype chain and recursively sanitizes nested objects.
 */
function sanitizeJson<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeJson(item)) as unknown as T;
  }

  // Use Object.create(null) to avoid prototype chain
  const sanitized = Object.create(null) as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    // Block dangerous keys at all levels
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      log("security", `Blocked dangerous key: ${key}`);
      continue;
    }

    // Recursively sanitize nested objects
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeJson(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized as T;
}

const TOKEN: string | null = process.env.TELEGRAM_BOT_TOKEN || null;
const bot = TOKEN ? new Bot(TOKEN) : null;
const ALLOWED_USER_IDS: Set<string> = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId: string | null = process.env.TELEGRAM_CHAT_ID || null;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;
let _pollingStarted = false;
let _onMessage: ((msg: TelegramMessage) => Promise<void>) | null = null;

// ─── Management cycle message reuse ───────────────────────────────
const MESSAGE_EDIT_MAX_AGE_MS = 47 * 60 * 60 * 1000; // 47 hours (Telegram limit is 48h)
let _lastManagementMessageId: number | null = null;
let _lastManagementMessageTime: number = 0;
const FLUSH_DELAY_MS = 300;

export function getLastManagementMessageId(): number | null {
  // Check if message is too old (Telegram 48h edit limit)
  if (Date.now() - _lastManagementMessageTime > MESSAGE_EDIT_MAX_AGE_MS) {
    return null;
  }
  return _lastManagementMessageId;
}

export function setLastManagementMessageId(id: number | null): void {
  _lastManagementMessageId = id;
  _lastManagementMessageTime = id ? Date.now() : 0;
}

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId(): void {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as {
        telegramChatId?: string;
      };
      const cfg = sanitizeJson(raw);
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch {
    /**/
  }
}

function _saveChatId(id: string): void {
  try {
    const raw: { telegramChatId?: string } & Record<string, unknown> = fs.existsSync(
      USER_CONFIG_PATH
    )
      ? (JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as {
          telegramChatId?: string;
        } & Record<string, unknown>)
      : {};
    const cfg = sanitizeJson(raw);
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${getErrorMessage(e)}`);
  }
}

loadChatId();

// ─── Bot handlers (module level - registered once) ───────────────

function contextToMessage(ctx: Context): TelegramMessage | null {
  const msg = ctx.message;
  if (!msg) return null;
  return {
    message_id: msg.message_id,
    from: msg.from
      ? {
          id: msg.from.id,
          username: msg.from.username,
        }
      : undefined,
    chat: msg.chat
      ? {
          id: msg.chat.id,
          type: msg.chat.type as "private" | "group" | "supergroup" | "channel",
        }
      : undefined,
    text: msg.text,
  };
}

// Register handlers at module level (once)
if (bot) {
  // Authorization middleware
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (!msg?.text) return;

    const incomingChatId = String(msg.chat?.id || "");
    const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
    const chatType = msg.chat?.type || "unknown";

    if (!chatId) {
      if (!_warnedMissingChatId) {
        log(
          "telegram_warn",
          "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety."
        );
        _warnedMissingChatId = true;
      }
      return;
    }

    if (incomingChatId !== chatId) return;

    if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
      if (!_warnedMissingAllowedUsers) {
        log(
          "telegram_warn",
          "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control."
        );
        _warnedMissingAllowedUsers = true;
      }
      return;
    }

    if (ALLOWED_USER_IDS.size > 0) {
      if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return;
    }

    await next();
  });

  // Message handler
  bot.on("message:text", async (ctx) => {
    const msg = contextToMessage(ctx);
    if (msg && _onMessage) {
      await _onMessage(msg);
    }
  });

  // Error handling
  bot.catch((err) => {
    const _ctx = err.ctx;
    const e = err.error;

    if (e instanceof GrammyError) {
      log("telegram_error", `API error ${e.error_code}: ${e.description}`);
    } else if (e instanceof HttpError) {
      log("telegram_error", `Network error: ${getErrorMessage(e)}`);
    } else {
      log("telegram_error", `Unexpected error: ${getErrorMessage(e)}`);
    }
  });
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled(): boolean {
  return !!bot;
}

function escapeMarkdown(text: string): string {
  // Escape Markdown special characters: * _ [ ] ( ) ~ ` > # + - = | { } . !
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

export async function sendMessage(text: string): Promise<unknown> {
  if (!bot || !chatId) return null;
  const safeText = String(text).slice(0, 4096);
  try {
    return await bot.api.sendMessage(chatId, safeText, { parse_mode: "Markdown" });
  } catch (error) {
    // If Markdown parsing fails, retry with escaped text as plain text
    if (error instanceof GrammyError) {
      const errorMessage = error.description || "";
      if (errorMessage.includes("parse entities") || errorMessage.includes("Can't find end")) {
        log("telegram_warn", "Markdown parsing failed, sending with escaped characters");
        // Re-slice after escaping to ensure we don't exceed Telegram's limit
        return await bot.api.sendMessage(chatId, escapeMarkdown(safeText).slice(0, 4096));
      }
      // Ignore "message is not modified" — content hasn't changed, no need to update
      if (errorMessage.includes("message is not modified")) {
        return null;
      }
    }
    throw error;
  }
}

export async function sendHTML(html: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    await bot.api.sendMessage(chatId, html.slice(0, 4096), { parse_mode: "HTML" });
  } catch (error) {
    if (error instanceof GrammyError) {
      const errorMessage = error.description || "";
      if (errorMessage.includes("parse entities")) {
        log("telegram_warn", "HTML parsing failed, sending as plain text");
        await bot.api.sendMessage(chatId, html.slice(0, 4096));
        return;
      }
      if (errorMessage.includes("message is not modified")) {
        return;
      }
    }
    throw error;
  }
}

export async function editMessage(text: string, messageId: number): Promise<unknown> {
  if (!bot || !chatId || !messageId) return null;
  const safeText = String(text).slice(0, 4096);
  try {
    return await bot.api.editMessageText(chatId, messageId, safeText, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    // If Markdown parsing fails, retry as plain text
    if (error instanceof GrammyError) {
      const errorMessage = error.description || "";
      if (errorMessage.includes("parse entities") || errorMessage.includes("Can't find end")) {
        log("telegram_warn", "Markdown parsing failed, editing as plain text");
        // Re-slice after escaping to ensure we don't exceed Telegram's limit
        return await bot.api.editMessageText(
          chatId,
          messageId,
          escapeMarkdown(safeText).slice(0, 4096)
        );
      }
      // Ignore "message is not modified" — content hasn't changed, no need to update
      if (errorMessage.includes("message is not modified")) {
        return null;
      }
    }
    throw error;
  }
}

export function hasActiveLiveMessage(): boolean {
  return _liveMessageDepth > 0;
}

interface TypingIndicator {
  stop(): void;
}

function createTypingIndicator(): TypingIndicator {
  if (!bot || !chatId) {
    return { stop() {} };
  }

  const botInstance = bot;
  const chatIdStr = chatId;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    await botInstance.api.sendChatAction(chatIdStr, "typing");
    timer = setTimeout((): void => {
      tick().catch((): null => null);
    }, 4000);
  }

  tick().catch((): null => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

interface ToolResult {
  error?: string;
  reason?: string;
  blocked?: boolean;
  position?: string;
  success?: boolean;
  claimed_amount?: number;
  applied?: Record<string, unknown>;
  candidates?: unknown[];
  total_positions?: number;
  positions?: unknown[];
  sol?: number;
  lpers?: unknown[];
}

function summarizeToolResult(name: string, result: ToolResult | null): string {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : result.reason || "failed";
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(
  title: string,
  intro = "Starting..."
): Promise<LiveMessageAPI | null> {
  if (!bot || !chatId) return null;
  const typing = createTypingIndicator();

  const state: LiveMessageState = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render(): string {
    const sections: string[] = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow(): Promise<void> {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = (await sendMessage(text)) as { message_id?: number } | null;
      state.messageId = sent?.message_id ?? null;
      // Track this message ID for management cycle reuse
      if (state.messageId) {
        setLastManagementMessageId(state.messageId);
      }
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = FLUSH_DELAY_MS): void {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout((): void => {
      state.flushPromise = flushNow().catch((e): undefined => {
        log("telegram_warn", `Live message update failed: ${getErrorMessage(e)}`);
      });
    }, delay);
  }

  async function upsertToolLine(name: string, icon: string, suffix = ""): Promise<void> {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name: string): Promise<void> {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name: string, result: unknown, success: boolean): Promise<void> {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result as ToolResult);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text: string): Promise<void> {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText: string): Promise<void> {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText: string): Promise<void> {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}

// ─── Update existing live message (for management cycle reuse) ──
export async function updateExistingLiveMessage(
  title: string,
  intro: string,
  existingMessageId: number
): Promise<LiveMessageAPI | null> {
  if (!bot || !chatId) return null;

  const typing = createTypingIndicator();

  const state: LiveMessageState = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: existingMessageId,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render(): string {
    const sections: string[] = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow(): Promise<void> {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) return;
    try {
      await editMessage(text, state.messageId);
    } catch (error) {
      // If edit fails (message deleted, too old, etc), we can't recover in this cycle
      // The next cycle will create a new message since messageId won't be saved
      throw error;
    }
  }

  function scheduleFlush(delay = FLUSH_DELAY_MS): void {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout((): void => {
      state.flushPromise = flushNow().catch((e): undefined => {
        log("telegram_warn", `Live message update failed: ${getErrorMessage(e)}`);
      });
    }, delay);
  }

  async function upsertToolLine(name: string, icon: string, suffix = ""): Promise<void> {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  // Reset live message depth and immediately update the existing message
  _liveMessageDepth += 1;
  try {
    await flushNow();
  } catch {
    typing.stop();
    _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
    return null;
  }

  return {
    async toolStart(name: string): Promise<void> {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name: string, result: unknown, success: boolean): Promise<void> {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result as ToolResult);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text: string): Promise<void> {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText: string): Promise<void> {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      try {
        await flushNow();
      } catch {
        // Edit failed, message might be deleted - will create new next cycle
      }
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText: string): Promise<void> {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      try {
        await flushNow();
      } catch {
        // Edit failed
      }
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}

// ─── Long polling ────────────────────────────────────────────────
export function startPolling(onMessage: (msg: TelegramMessage) => Promise<void>): Promise<void> {
  if (!bot || _pollingStarted) return Promise.resolve();
  _pollingStarted = true;
  _onMessage = onMessage;

  // Set up graceful shutdown
  const stopHandler = (): void => {
    log("telegram", "Received shutdown signal, stopping bot...");
    bot?.stop();
  };
  process.once("SIGINT", stopHandler);
  process.once("SIGTERM", stopHandler);

  // Start polling
  return bot.start({
    drop_pending_updates: false,
    onStart: () => {
      log("telegram", "Bot polling started");
    },
  });
}

export function stopPolling(): void {
  _pollingStarted = false;
  bot?.stop();
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({
  pair,
  amountSol,
  position,
  tx,
  priceRange,
  binStep,
  baseFee,
}: TelegramNotifyDeploy): Promise<void> {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const poolStr =
    binStep || baseFee
      ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? `${baseFee}%` : "?"}\n`
      : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
      `Amount: ${amountSol} SOL\n` +
      priceStr +
      poolStr +
      `Position: <code>${position?.slice(0, 8)}...</code>\n` +
      `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct }: TelegramNotifyClose): Promise<void> {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
      `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`
  );
}

export async function notifySwap({
  inputSymbol,
  outputSymbol,
  amountIn,
  amountOut,
  tx,
}: TelegramNotifySwap): Promise<void> {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
      `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
      `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }: TelegramNotifyOOR): Promise<void> {
  if (hasActiveLiveMessage()) return;
  await sendHTML(`⚠️ <b>Out of Range</b> ${pair}\n` + `Been OOR for ${minutesOOR} minutes`);
}
