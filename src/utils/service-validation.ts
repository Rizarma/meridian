import { isEnabled as isOKXEnabled } from "../../tools/okx.js";
import { config } from "../config/config.js";
import { getSharedConnection } from "../infrastructure/connection.js";
import { isEnabled as isHiveMindEnabled } from "../infrastructure/hive-mind.js";
import { log } from "../infrastructure/logger.js";
import { getErrorMessage } from "./errors.js";
import { getWallet } from "./wallet.js";

export interface ServiceCheck {
  name: string;
  enabled: boolean;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  details?: string;
}

export interface StartupValidationResult {
  allCriticalHealthy: boolean;
  services: ServiceCheck[];
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Check Functions
// ═══════════════════════════════════════════════════════════════════════════

async function checkRPC(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const connection = getSharedConnection();
    const slot = await connection.getSlot();
    return {
      name: "Solana RPC",
      enabled: true,
      healthy: true,
      latencyMs: Date.now() - start,
      details: `Slot: ${slot}`,
    };
  } catch (error) {
    return {
      name: "Solana RPC",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

function checkWallet(): ServiceCheck {
  try {
    const wallet = getWallet();
    const pubkey = wallet.publicKey.toString();
    return {
      name: "Wallet",
      enabled: true,
      healthy: true,
      details: `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`,
    };
  } catch (error) {
    return {
      name: "Wallet",
      enabled: true,
      healthy: false,
      error: getErrorMessage(error),
    };
  }
}

async function checkMeteora(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch("https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1", {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      return {
        name: "Meteora Pool Discovery",
        enabled: true,
        healthy: true,
        latencyMs: Date.now() - start,
        details: "API responsive",
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "Meteora Pool Discovery",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

async function checkMeteoraDLMM(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Try to fetch a pool list (lightweight check)
    const res = await fetch("https://dlmm.datapi.meteora.ag/pools?query=SOL&pageSize=1", {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok || res.status === 404) {
      // 404 is fine, means API is up but no results
      return {
        name: "Meteora DLMM API",
        enabled: true,
        healthy: true,
        latencyMs: Date.now() - start,
        details: "API responsive",
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "Meteora DLMM API",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

async function checkJupiter(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Check Jupiter Price API with SOL mint
    const res = await fetch(
      "https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112",
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    if (res.ok) {
      return {
        name: "Jupiter API",
        enabled: true,
        healthy: true,
        latencyMs: Date.now() - start,
        details: "Price API responsive",
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "Jupiter API",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

async function checkJupiterData(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Check Jupiter Data API (datapi.jup.ag)
    const res = await fetch("https://datapi.jup.ag/v1/assets/search?query=SOL", {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      return {
        name: "Jupiter Data API",
        enabled: true,
        healthy: true,
        latencyMs: Date.now() - start,
        details: "Data API responsive",
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "Jupiter Data API",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

async function checkLLM(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const baseUrl = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
    const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;

    // Try to fetch models list (lightweight check)
    const res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      return {
        name: "LLM Provider",
        enabled: true,
        healthy: true,
        latencyMs: Date.now() - start,
        details: baseUrl.includes("openrouter") ? "OpenRouter" : "Custom",
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "LLM Provider",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

async function checkOKX(): Promise<ServiceCheck> {
  const start = Date.now();

  if (!isOKXEnabled()) {
    return {
      name: "OKX Web3",
      enabled: false,
      healthy: false,
      details: "Not configured (optional)",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Check OKX network list endpoint (lightweight public endpoint)
    // This endpoint requires authentication but is lightweight
    const { OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE } =
      (await import("../../tools/okx.js")).getOKXCredentials?.() || {};

    if (!OKX_API_KEY || !OKX_SECRET_KEY || !OKX_PASSPHRASE) {
      clearTimeout(timeoutId);
      return {
        name: "OKX Web3",
        enabled: true,
        healthy: false,
        error: "Missing credentials",
      };
    }

    const timestamp = new Date().toISOString();
    const path = "/api/v5/defi/explore/network-list";
    const prehash = `${timestamp}GET${path}`;
    const crypto = await import("node:crypto");
    const sign = crypto.createHmac("sha256", OKX_SECRET_KEY).update(prehash).digest("base64");

    const res = await fetch(`https://web3.okx.com${path}`, {
      method: "GET",
      headers: {
        "OK-ACCESS-KEY": OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-PASSPHRASE": OKX_PASSPHRASE,
        "OK-ACCESS-TIMESTAMP": timestamp,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      return {
        name: "OKX Web3",
        enabled: true,
        healthy: true,
        latencyMs: Date.now() - start,
        details: "Risk API ready",
      };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "OKX Web3",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

async function checkHelius(): Promise<ServiceCheck> {
  const start = Date.now();

  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    return {
      name: "Helius",
      enabled: false,
      healthy: false,
      details: "Not configured (optional, using public RPC)",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // Use Helius RPC getHealth endpoint instead of non-existent /v0/status
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const data = (await res.json()) as { result?: string };
      if (data.result === "ok" || data.result === "behind") {
        return {
          name: "Helius",
          enabled: true,
          healthy: true,
          latencyMs: Date.now() - start,
          details: "Enhanced RPC ready",
        };
      }
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    return {
      name: "Helius",
      enabled: true,
      healthy: false,
      latencyMs: Date.now() - start,
      error: getErrorMessage(error),
    };
  }
}

function checkTelegram(): ServiceCheck {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return {
      name: "Telegram",
      enabled: false,
      healthy: false,
      details: "Not configured (optional)",
    };
  }

  // Basic validation of token format
  if (token.length < 20 || !chatId.match(/^-?\d+$/)) {
    return {
      name: "Telegram",
      enabled: true,
      healthy: false,
      error: "Invalid token or chat ID format",
    };
  }

  return {
    name: "Telegram",
    enabled: true,
    healthy: true,
    details: `Bot configured, Chat: ${chatId}`,
  };
}

function checkHiveMind(): ServiceCheck {
  if (!isHiveMindEnabled()) {
    return {
      name: "Hive Mind",
      enabled: false,
      healthy: false,
      details: "Not configured (optional)",
    };
  }

  return {
    name: "Hive Mind",
    enabled: true,
    healthy: true,
    details: "Collective intelligence enabled",
  };
}

function checkLPAgent(): ServiceCheck {
  const apiKey = process.env.LPAGENT_API_KEY;

  if (!apiKey) {
    return {
      name: "LPAgent",
      enabled: false,
      healthy: false,
      details: "Not configured (optional)",
    };
  }

  return {
    name: "LPAgent",
    enabled: true,
    healthy: true,
    details: "Copy-trading insights ready",
  };
}

function checkDarwinEvolution(): ServiceCheck {
  const enabled = config.features.darwinEvolution;

  return {
    name: "Darwin Evolution",
    enabled: true,
    healthy: enabled,
    details: enabled
      ? "Signal weight learning active"
      : "Disabled (enable with darwinEvolution: true)",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Validation Function
// ═══════════════════════════════════════════════════════════════════════════

export async function runStartupValidation(): Promise<StartupValidationResult> {
  log("startup", "Running service validation...");

  const checks = await Promise.all([
    checkRPC(),
    checkWallet(),
    checkMeteora(),
    checkMeteoraDLMM(),
    checkJupiter(),
    checkJupiterData(),
    checkLLM(),
    checkOKX(),
    checkHelius(),
    Promise.resolve(checkTelegram()),
    Promise.resolve(checkHiveMind()),
    Promise.resolve(checkLPAgent()),
    Promise.resolve(checkDarwinEvolution()),
  ]);

  // Critical services must be healthy
  const criticalServices = [
    "Solana RPC",
    "Wallet",
    "Meteora Pool Discovery",
    "Meteora DLMM API",
    "Jupiter API",
    "Jupiter Data API",
    "LLM Provider",
  ];
  const criticalChecks = checks.filter((c) => criticalServices.includes(c.name));
  const allCriticalHealthy = criticalChecks.every((c) => c.healthy);

  const result: StartupValidationResult = {
    allCriticalHealthy,
    services: checks,
    timestamp: new Date().toISOString(),
  };

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

export function formatStartupValidation(result: StartupValidationResult): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push("╔════════════════════════════════════════════════════════════════╗");
  lines.push("║           MERIDIAN SERVICE VALIDATION REPORT                   ║");
  lines.push("╚════════════════════════════════════════════════════════════════╝");
  lines.push("");

  // Critical Services Section
  lines.push("📋 CRITICAL SERVICES (Required)");
  lines.push("─".repeat(60));

  const criticalServices = result.services.filter((s) =>
    [
      "Solana RPC",
      "Wallet",
      "Meteora Pool Discovery",
      "Meteora DLMM API",
      "Jupiter API",
      "Jupiter Data API",
      "LLM Provider",
    ].includes(s.name)
  );

  for (const service of criticalServices) {
    const status = service.healthy ? "✅" : "❌";
    const latency = service.latencyMs ? ` (${service.latencyMs}ms)` : "";
    const details = service.details ? ` — ${service.details}` : "";
    const error = service.error ? ` [${service.error}]` : "";

    lines.push(`  ${status} ${service.name}${latency}${details}${error}`);
  }

  // Optional Services Section
  lines.push("");
  lines.push("🔧 OPTIONAL SERVICES");
  lines.push("─".repeat(60));

  const optionalServices = result.services.filter(
    (s) =>
      ![
        "Solana RPC",
        "Wallet",
        "Meteora Pool Discovery",
        "Meteora DLMM API",
        "Jupiter API",
        "Jupiter Data API",
        "LLM Provider",
      ].includes(s.name)
  );

  for (const service of optionalServices) {
    if (!service.enabled) {
      lines.push(`  ⚪ ${service.name} — ${service.details}`);
    } else if (service.healthy) {
      const latency = service.latencyMs ? ` (${service.latencyMs}ms)` : "";
      const details = service.details ? ` — ${service.details}` : "";
      lines.push(`  ✅ ${service.name}${latency}${details}`);
    } else {
      lines.push(`  ❌ ${service.name} — ${service.error || "Unhealthy"}`);
    }
  }

  // Summary
  lines.push("");
  lines.push("─".repeat(60));

  if (result.allCriticalHealthy) {
    lines.push("✅ ALL CRITICAL SERVICES OPERATIONAL");
    lines.push("   Agent ready to start");
  } else {
    lines.push("❌ CRITICAL SERVICE FAILURE");
    lines.push("   Agent will start but may not function correctly");
  }

  lines.push("");
  lines.push(`Validated at: ${new Date(result.timestamp).toLocaleTimeString()}`);
  lines.push("");

  return lines.join("\n");
}

export function logStartupValidation(result: StartupValidationResult): void {
  const formatted = formatStartupValidation(result);
  console.log(formatted);

  // Also log to file
  const criticalCount = result.services.filter(
    (s) =>
      s.healthy &&
      [
        "Solana RPC",
        "Wallet",
        "Meteora Pool Discovery",
        "Meteora DLMM API",
        "Jupiter API",
        "Jupiter Data API",
        "LLM Provider",
      ].includes(s.name)
  ).length;
  const optionalEnabled = result.services.filter((s) => s.enabled).length - criticalCount;

  log(
    "startup",
    `Service validation: ${criticalCount}/7 critical, ${optionalEnabled} optional enabled`
  );
}
