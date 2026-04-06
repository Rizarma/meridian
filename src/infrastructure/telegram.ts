import fs from "fs";
import { USER_CONFIG_PATH } from "../config/paths.js";
import type {
  LiveMessageAPI,
  LiveMessageState,
  TelegramMessage,
  TelegramNotifyClose,
  TelegramNotifyDeploy,
  TelegramNotifyOOR,
  TelegramNotifySwap,
  TelegramUpdate,
} from "../types/telegram.d.ts";
import { log } from "./logger.js";

const TOKEN: string | null = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE: string | null = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS: Set<string> = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId: string | null = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId(): void {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as {
        telegramChatId?: string;
      };
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch {
    /**/
  }
}

function saveChatId(id: string): void {
  try {
    const cfg: { telegramChatId?: string } & Record<string, unknown> = fs.existsSync(
      USER_CONFIG_PATH
    )
      ? (JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as {
          telegramChatId?: string;
        } & Record<string, unknown>)
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${(e as Error).message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg: TelegramMessage): boolean {
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
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log(
        "telegram_warn",
        "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control."
      );
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled(): boolean {
  return !!TOKEN;
}

async function postTelegram(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (!TOKEN || !chatId || !BASE) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      // Throw so callers can handle specific errors (e.g., Markdown parsing)
      throw new Error(`${method} ${res.status}: ${err}`);
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${(e as Error).message}`);
    throw e; // Re-throw so callers can handle it
  }
}

export async function sendMessage(text: string): Promise<unknown> {
  if (!TOKEN || !chatId) return null;
  const safeText = String(text).slice(0, 4096);
  try {
    return await postTelegram("sendMessage", {
      text: safeText,
      parse_mode: "Markdown",
    });
  } catch (error) {
    // If Markdown parsing fails, retry as plain text
    const errorMessage = String((error as { message?: string }).message || "");
    if (errorMessage.includes("parse entities") || errorMessage.includes("Can't find end")) {
      log("telegram_warn", "Markdown parsing failed, sending as plain text");
      return postTelegram("sendMessage", { text: safeText });
    }
    throw error;
  }
}

export async function sendHTML(html: string): Promise<void> {
  if (!TOKEN || !chatId) return;
  await postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text: string, messageId: number): Promise<unknown> {
  if (!TOKEN || !chatId || !messageId) return null;
  const safeText = String(text).slice(0, 4096);
  try {
    return await postTelegram("editMessageText", {
      message_id: messageId,
      text: safeText,
      parse_mode: "Markdown",
    });
  } catch (error) {
    // If Markdown parsing fails, retry as plain text
    const errorMessage = String((error as { message?: string }).message || "");
    if (errorMessage.includes("parse entities") || errorMessage.includes("Can't find end")) {
      log("telegram_warn", "Markdown parsing failed, editing as plain text");
      return postTelegram("editMessageText", { message_id: messageId, text: safeText });
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
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

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
  if (!TOKEN || !chatId) return null;
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
      const sent = (await sendMessage(text)) as {
        result?: { message_id?: number };
      } | null;
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300): void {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => undefined);
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

// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage: (msg: TelegramMessage) => Promise<void>): Promise<void> {
  while (_polling) {
    try {
      const res = await fetch(`${BASE}/getUpdates?offset=${_offset}&timeout=30`, {
        signal: AbortSignal.timeout(35_000),
      });
      if (!res.ok) {
        await sleep(5000);
        continue;
      }
      const data = (await res.json()) as { result?: TelegramUpdate[] };
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!(e as Error).message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${(e as Error).message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage: (msg: TelegramMessage) => Promise<void>): void {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling(): void {
  _polling = false;
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
      ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
