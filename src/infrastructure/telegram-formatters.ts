// src/infrastructure/telegram-formatters.ts
import type { WalletBalances } from "../types/wallet.js";

const DUST_THRESHOLD_USD = 0.1;
const GAS_RESERVE_SOL = 0.2;
const MIN_DEPLOY_SOL = 0.35;

interface FormatOptions {
  showDust?: boolean;
  showFullAddress?: boolean;
}

export function formatWalletBalanceForTelegram(
  data: WalletBalances,
  options: FormatOptions = {}
): string {
  console.log("[telegram-formatters] formatWalletBalanceForTelegram called");
  console.log("[telegram-formatters] data keys:", Object.keys(data));
  console.log("[telegram-formatters] data.tokens:", data.tokens);
  console.log("[telegram-formatters] data.tokens type:", typeof data.tokens);
  console.log("[telegram-formatters] Array.isArray(data.tokens):", Array.isArray(data.tokens));

  // Handle error case
  if (data.error) {
    console.log("[telegram-formatters] Error case triggered:", data.error);
    return `❌ *Wallet Balance Error*\n\n${data.error}\n\n_Using cached state data..._`;
  }

  const { showDust = false, showFullAddress = false } = options;
  const lines: string[] = [];

  // Header with truncated wallet
  lines.push("💰 *Wallet Balance*");
  if (data.wallet) {
    const display = showFullAddress
      ? data.wallet
      : `${data.wallet.slice(0, 4)}...${data.wallet.slice(-4)}`;
    lines.push(`\`${display}\``);
    lines.push("");
  }

  // SOL Box
  lines.push("┌────────────────────────────┐");
  const sol = data.sol ?? 0;
  const solUsd = data.sol_usd ?? 0;
  lines.push(`│  ◉ SOL          ${sol.toFixed(3)} SOL │`);
  lines.push(`│    ≈ $${solUsd.toFixed(2)}${" ".repeat(16 - solUsd.toFixed(2).length)}│`);

  // USDC if significant
  if (data.usdc && data.usdc > 0.01) {
    lines.push(
      `│  ● USDC         ${data.usdc?.toFixed(2) ?? "0.00"}${" ".repeat(18 - (data.usdc?.toFixed(2)?.length ?? 4))}│`
    );
  }
  lines.push("└────────────────────────────┘");
  lines.push("");

  // Sort tokens by USD value
  console.log("[telegram-formatters] About to process tokens");
  const tokens = data.tokens || [];
  console.log("[telegram-formatters] tokens length after fallback:", tokens.length);

  let significant: typeof tokens = [];
  let dust: typeof tokens = [];

  try {
    significant = tokens
      .filter(
        (t) => (t.usd || 0) >= DUST_THRESHOLD_USD && t.symbol !== "SOL" && t.symbol !== "USDC"
      )
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));

    dust = tokens.filter(
      (t) =>
        (t.usd || 0) > 0 &&
        (t.usd || 0) < DUST_THRESHOLD_USD &&
        t.symbol !== "SOL" &&
        t.symbol !== "USDC"
    );

    console.log(
      "[telegram-formatters] Filter success - significant:",
      significant.length,
      "dust:",
      dust.length
    );
  } catch (filterError) {
    console.error("[telegram-formatters] FILTER ERROR:", filterError);
    console.error("[telegram-formatters] tokens array:", JSON.stringify(tokens, null, 2));
    throw filterError;
  }

  // Other holdings
  if (significant.length > 0) {
    lines.push("🪙 *Other Holdings* (>$0.10)");
    const last = significant.length - 1;
    for (let i = 0; i < Math.min(significant.length, 5); i++) {
      const t = significant[i];
      const prefix = i === last ? "└─" : "├─";
      const value = t.usd ? `·  $${t.usd.toFixed(2)}` : "·  —";
      lines.push(
        `${prefix} ${t.symbol.padEnd(6)} ${(t.balance ?? 0).toFixed(2).padStart(8)}  ${value}`
      );
    }
    lines.push("");
  }

  // Dust summary
  if (dust.length > 0 && !showDust) {
    const dustTotal = dust.reduce((sum, t) => sum + (t.usd || 0), 0);
    lines.push(`🫰 *${dust.length} dust tokens* hidden (~\\$${dustTotal.toFixed(2)} total)`);
    lines.push(`   _Use /dust to see all_`);
    lines.push("");
  } else if (showDust && dust.length > 0) {
    lines.push("🫰 *Dust Tokens* (<$0.10)");
    const last = dust.length - 1;
    for (let i = 0; i < dust.length; i++) {
      const t = dust[i];
      const prefix = i === last ? "└─" : "├─";
      lines.push(
        `${prefix} ${t.symbol}: ${(t.balance ?? 0).toFixed(2)} ($${(t.usd || 0).toFixed(2)})`
      );
    }
    lines.push("");
  }

  // Total
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const totalUsd = data.total_usd ?? 0;
  lines.push(`📊 *Total Portfolio: \\$${totalUsd.toFixed(2)}*`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  // Gas warning
  const availableForDeploy = Math.max(0, (data.sol ?? 0) - GAS_RESERVE_SOL);
  const canDeploy = availableForDeploy >= MIN_DEPLOY_SOL;

  if (!canDeploy) {
    const needed = MIN_DEPLOY_SOL - availableForDeploy;
    lines.push("⚠️ *Low SOL for New Positions*");
    lines.push(`   ├─ Available: ${availableForDeploy.toFixed(3)} SOL`);
    lines.push(`   ├─ Required: ${MIN_DEPLOY_SOL} SOL minimum`);
    lines.push(`   ├─ Gas reserve: ${GAS_RESERVE_SOL} SOL`);
    lines.push(`   └─ Shortage: ~${needed.toFixed(3)} SOL`);
    lines.push("");
    lines.push("   _Add SOL to enable deployments_");
  } else {
    lines.push(`✅ Ready to deploy (${availableForDeploy.toFixed(3)} SOL available)`);
  }

  return lines.join("\n");
}
