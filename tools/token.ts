const DATAPI_BASE = "https://datapi.jup.ag/v1";

import { config } from "../src/config/config.js";
import { log } from "../src/infrastructure/logger.js";
import type {
  OKXAdvancedResult,
  OKXClusterResult,
  SmartWalletHolding,
  SmartWalletHoldingPnl,
  TokenAudit,
  TokenCluster,
  TokenHolder,
  TokenHolderFunding,
  TokenHoldersInput,
  TokenHoldersResult,
  TokenInfo,
  TokenInfoInput,
  TokenNarrative,
  TokenNarrativeInput,
  TokenStats1h,
} from "../src/types/index.js";
import type { SmartWallet, SmartWalletList } from "../src/types/smart-wallets.js";
import type { TokenInfoResult } from "../src/types/token.js";
import { cache } from "../src/utils/cache.js";
import { isEnabled as isOKXEnabled } from "./okx.js";
import { registerTool } from "./registry.js";

// TTL constants (in milliseconds)
const TOKEN_INFO_TTL = 300000; // 5 minutes
const TOKEN_HOLDERS_TTL = 600000; // 10 minutes
const TOKEN_NARRATIVE_TTL = 1800000; // 30 minutes

// Jupiter API response types
interface JupiterNarrativeResponse {
  narrative?: string;
  status: string;
}

interface JupiterTokenAudit {
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  topHoldersPercentage?: number;
  botHoldersPercentage?: number;
  devMigrations?: unknown;
}

interface JupiterTokenStats1h {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

interface JupiterTokenStats24h {
  numNetBuyers?: number;
}

interface JupiterTokenData {
  id: string;
  name: string;
  symbol: string;
  mcap: number;
  usdPrice: number;
  liquidity: number;
  holderCount: number;
  organicScore: number;
  organicScoreLabel: string;
  launchpad: string;
  graduatedPool?: unknown;
  fees?: number;
  audit?: JupiterTokenAudit;
  stats1h?: JupiterTokenStats1h;
  stats24h?: JupiterTokenStats24h;
  totalSupply?: number;
  circSupply?: number;
}

interface JupiterHolderTag {
  name?: string;
  id?: string;
}

interface JupiterHolderAddressInfo {
  fundingAddress?: string;
  fundingAmount?: number;
  fundingSlot?: number;
}

interface JupiterHolder {
  address?: string;
  wallet?: string;
  amount: number;
  percentage?: number;
  pct?: number;
  solBalanceDisplay?: number;
  solBalance?: number;
  tags?: (string | JupiterHolderTag)[];
  addressInfo?: JupiterHolderAddressInfo;
}

interface PnLPosition {
  balance: number;
  balanceValue: number;
  averageCost: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalPnlPercentage: number;
  totalBuys: number;
  totalSells: number;
  totalWins: number;
  boughtValue: number;
  soldValue: number;
  firstActiveTime: string;
  lastActiveTime: string;
  holdingPeriodInSeconds?: number;
}

interface PnLResponse {
  [address: string]: {
    tokenPositions?: PnLPosition[];
  };
}

/**
 * Get the narrative/story behind a token from Jupiter ChainInsight.
 * Useful for understanding if a token has a real community/theme vs nothing.
 */
export async function getTokenNarrative({ mint }: TokenNarrativeInput): Promise<TokenNarrative> {
  const normalizedMint = mint.trim().toLowerCase();
  const cacheKey = `token:narrative:${normalizedMint}`;
  const cached = cache.get(cacheKey) as TokenNarrative | undefined;
  if (cached) {
    return cached;
  }

  const res = await fetch(`${DATAPI_BASE}/chaininsight/narrative/${mint}`);
  if (!res.ok) throw new Error(`Narrative API error: ${res.status}`);
  const data = (await res.json()) as JupiterNarrativeResponse;
  const result: TokenNarrative = {
    mint,
    narrative: data.narrative || null,
    status: data.status,
  };

  cache.set(cacheKey, result, TOKEN_NARRATIVE_TTL);
  return result;
}

/**
 * Search for token data by name, symbol, or mint address.
 * Returns condensed token info useful for confidence scoring.
 */
export async function getTokenInfo({ query }: TokenInfoInput): Promise<TokenInfoResult> {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `token:info:${normalizedQuery}`;
  const cached = cache.get(cacheKey) as TokenInfoResult | undefined;
  if (cached) {
    return cached;
  }

  const url = `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token search API error: ${res.status}`);
  const data = (await res.json()) as JupiterTokenData | JupiterTokenData[];
  const tokens = Array.isArray(data) ? data : [data];
  if (!tokens.length) {
    const notFoundResult: TokenInfoResult = { found: false, query };
    return notFoundResult;
  }

  const results: TokenInfo[] = tokens.slice(0, 5).map((t) => {
    const audit: TokenAudit | null = t.audit
      ? {
          mint_disabled: t.audit.mintAuthorityDisabled ?? false,
          freeze_disabled: t.audit.freezeAuthorityDisabled ?? false,
          top_holders_pct: t.audit.topHoldersPercentage?.toFixed(2) ?? null,
          bot_holders_pct: t.audit.botHoldersPercentage?.toFixed(2) ?? null,
          dev_migrations: t.audit.devMigrations,
        }
      : null;

    const stats_1h: TokenStats1h | null = t.stats1h
      ? {
          price_change: t.stats1h.priceChange?.toFixed(2) ?? null,
          buy_vol: t.stats1h.buyVolume?.toFixed(0) ?? null,
          sell_vol: t.stats1h.sellVolume?.toFixed(0) ?? null,
          buyers: t.stats1h.numOrganicBuyers ?? null,
          net_buyers: t.stats1h.numNetBuyers ?? null,
        }
      : null;

    const tokenInfo: TokenInfo = {
      mint: t.id,
      name: t.name,
      symbol: t.symbol,
      mcap: t.mcap,
      price: t.usdPrice,
      liquidity: t.liquidity,
      holders: t.holderCount,
      organic_score: t.organicScore,
      organic_label: t.organicScoreLabel,
      launchpad: t.launchpad,
      graduated: !!t.graduatedPool,
      global_fees_sol: t.fees != null ? parseFloat(t.fees.toFixed(2)) : null,
      audit,
      stats_1h,
      stats_24h_net_buyers: t.stats24h?.numNetBuyers ?? null,
    };
    return tokenInfo;
  });

  // Enrich first result with OKX smart money + risk data (public endpoint, no key needed)
  if (isOKXEnabled() && results[0]?.mint) {
    const { getAdvancedInfo, getClusterList } = await import("./okx.js");
    const [adv, clusters] = await Promise.all([
      getAdvancedInfo(results[0].mint).catch((err: unknown): null => {
        log("token", `OKX advanced info failed: ${(err as Error).message}`);
        return null;
      }),
      getClusterList(results[0].mint).catch((err: unknown): TokenCluster[] => {
        log("token", `OKX cluster list failed: ${(err as Error).message}`);
        return [];
      }),
    ]);
    if (adv) {
      results[0].risk_level = adv.risk_level ?? undefined;
      results[0].bundle_pct = adv.bundle_pct ?? undefined;
      results[0].sniper_pct = adv.sniper_pct ?? undefined;
      results[0].suspicious_pct = adv.suspicious_pct ?? undefined;
      results[0].new_wallet_pct = adv.new_wallet_pct ?? undefined;
      results[0].smart_money_buy = adv.smart_money_buy ?? undefined;
      results[0].tags = adv.tags ?? undefined;
    }
    if (clusters?.length) {
      results[0].kol_in_clusters = clusters.some((c) => c.has_kol);
      results[0].top_cluster_trend = clusters[0]?.trend ?? null;
      results[0].clusters = clusters as TokenCluster[];
    }
  }

  const successResult: TokenInfoResult = { found: true, query, results };
  cache.set(cacheKey, successResult, TOKEN_INFO_TTL);
  return successResult;
}

/**
 * Get holder distribution for a token mint.
 * Fetches top 100 holders — caller decides how many to display.
 */
export async function getTokenHolders({
  mint,
  limit = 20,
}: TokenHoldersInput): Promise<TokenHoldersResult> {
  const normalizedMint = mint.trim().toLowerCase();
  const cacheKey = `token:holders:${normalizedMint}`;
  const cached = cache.get(cacheKey) as TokenHoldersResult | undefined;
  if (cached) {
    return cached;
  }

  // Fetch holders and total supply in parallel
  const [holdersRes, tokenRes] = await Promise.all([
    fetch(`${DATAPI_BASE}/holders/${mint}?limit=100`),
    fetch(`${DATAPI_BASE}/assets/search?query=${mint}`),
  ]);
  if (!holdersRes.ok) throw new Error(`Holders API error: ${holdersRes.status}`);
  const data = (await holdersRes.json()) as
    | JupiterHolder[]
    | { holders?: JupiterHolder[]; data?: JupiterHolder[] };
  const tokenData = tokenRes.ok
    ? ((await tokenRes.json()) as JupiterTokenData | JupiterTokenData[])
    : null;
  const tokenInfo = Array.isArray(tokenData) ? tokenData[0] : tokenData;
  const totalSupply = tokenInfo?.totalSupply || tokenInfo?.circSupply || null;

  const holders: JupiterHolder[] = Array.isArray(data) ? data : data.holders || data.data || [];

  const mapped: TokenHolder[] = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags = (h.tags || []).map((t) => (typeof t === "string" ? t : t.name || t.id || ""));
    const isPool = tags.some((t) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    const pct = totalSupply
      ? (Number(h.amount) / totalSupply) * 100
      : (h.percentage ?? h.pct ?? null);

    const funding: TokenHolderFunding | undefined = h.addressInfo?.fundingAddress
      ? {
          address: h.addressInfo.fundingAddress,
          amount: h.addressInfo.fundingAmount ?? 0,
          slot: h.addressInfo.fundingSlot ?? 0,
        }
      : undefined;

    return {
      address: h.address || h.wallet || "",
      amount: h.amount,
      pct: pct != null ? parseFloat(pct.toFixed(4)) : null,
      sol_balance: h.solBalanceDisplay ?? h.solBalance ?? null,
      tags: tags.length ? tags : undefined,
      is_pool: isPool || undefined,
      funding,
    };
  });

  const realHolders = mapped.filter((h) => !h.is_pool);
  const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);

  // ─── Bundle / Cluster Analysis (OKX) ─────────────────────────
  let advancedData: OKXAdvancedResult | null = null;
  let clusterList: OKXClusterResult[] = [];
  if (isOKXEnabled()) {
    const { getAdvancedInfo, getClusterList } = await import("./okx.js");
    const [adv, clusters] = await Promise.all([
      getAdvancedInfo(mint).catch((err: unknown): null => {
        log("token", `OKX advanced info failed: ${(err as Error).message}`);
        return null;
      }),
      getClusterList(mint).catch((err: unknown): OKXClusterResult[] => {
        log("token", `OKX cluster list failed: ${(err as Error).message}`);
        return [];
      }),
    ]);
    advancedData = adv;
    clusterList = clusters;
  }

  // ─── Smart Wallet / KOL Cross-reference ──────────────────────
  // Use targeted holders endpoint — only returns matching wallets, no noise
  const { listSmartWallets } = await import("../src/domain/smart-wallets.js");
  const { wallets: smartWallets } = listSmartWallets() as SmartWalletList;
  const smartWalletsHolding: SmartWalletHolding[] = [];

  if (smartWallets.length > 0) {
    const addresses = smartWallets.map((w) => w.address).join(",");
    const kwRes = await fetch(`${DATAPI_BASE}/holders/${mint}?addresses=${addresses}`).catch(
      (): null => null
    );
    const kwData = kwRes?.ok
      ? ((await kwRes.json()) as
          | JupiterHolder[]
          | { holders?: JupiterHolder[]; data?: JupiterHolder[] })
      : null;
    const kwHolders: JupiterHolder[] = Array.isArray(kwData)
      ? kwData
      : kwData?.holders || kwData?.data || [];

    const smartWalletMap = new Map<string, SmartWallet>(smartWallets.map((w) => [w.address, w]));
    const matchedHolders = kwHolders
      .map((h) => ({ ...h, addr: h.address || h.wallet || "" }))
      .filter((h) => smartWalletMap.has(h.addr));

    await Promise.all(
      matchedHolders.map(async (h) => {
        const wallet = smartWalletMap.get(h.addr)!;
        const pct = totalSupply
          ? parseFloat(((Number(h.amount) / totalSupply) * 100).toFixed(4))
          : null;

        let pnl: SmartWalletHoldingPnl | null = null;
        try {
          const pnlRes = await fetch(
            `${DATAPI_BASE}/pnl-positions?address=${h.addr}&assetId=${mint}`
          );
          if (pnlRes.ok) {
            const pnlData = (await pnlRes.json()) as PnLResponse;
            const pos = pnlData?.[h.addr]?.tokenPositions?.[0];
            if (pos) {
              pnl = {
                balance: pos.balance,
                balance_usd: pos.balanceValue,
                avg_cost: pos.averageCost,
                realized_pnl: pos.realizedPnl,
                unrealized_pnl: pos.unrealizedPnl,
                total_pnl: pos.totalPnl,
                total_pnl_pct: pos.totalPnlPercentage,
                buys: pos.totalBuys,
                sells: pos.totalSells,
                wins: pos.totalWins,
                bought_value: pos.boughtValue,
                sold_value: pos.soldValue,
                first_active: pos.firstActiveTime,
                last_active: pos.lastActiveTime,
                holding_days: pos.holdingPeriodInSeconds
                  ? Math.round(pos.holdingPeriodInSeconds / 86400)
                  : null,
              };
            }
          }
        } catch {
          /* ignore */
        }

        smartWalletsHolding.push({
          name: wallet.name,
          category: wallet.category,
          address: h.addr,
          pct,
          sol_balance: h.solBalanceDisplay ?? h.solBalance ?? null,
          pnl,
        });
      })
    );
  }

  const result: TokenHoldersResult = {
    mint,
    global_fees_sol: tokenInfo?.fees != null ? parseFloat(tokenInfo.fees.toFixed(2)) : null,
    total_fetched: holders.length,
    showing: mapped.length,
    top_10_real_holders_pct: top10Pct.toFixed(2),
    // OKX advanced info
    risk_level: (advancedData as OKXAdvancedResult | null)?.risk_level ?? null,
    bundle_pct: (advancedData as OKXAdvancedResult | null)?.bundle_pct ?? null,
    sniper_pct: (advancedData as OKXAdvancedResult | null)?.sniper_pct ?? null,
    suspicious_pct: (advancedData as OKXAdvancedResult | null)?.suspicious_pct ?? null,
    new_wallet_pct:
      (advancedData as (OKXAdvancedResult & { new_wallet_pct?: number | null }) | null)
        ?.new_wallet_pct ?? null,
    smart_wallets_holding: smartWalletsHolding,
    holders: mapped,
  };

  cache.set(cacheKey, result, TOKEN_HOLDERS_TTL);
  return result;
}

// Tool registrations
registerTool({
  name: "get_token_info",
  handler: getTokenInfo,
  roles: ["SCREENER", "GENERAL"],
});

registerTool({
  name: "get_token_holders",
  handler: getTokenHolders,
  roles: ["SCREENER", "GENERAL"],
});

registerTool({
  name: "get_token_narrative",
  handler: getTokenNarrative,
  roles: ["SCREENER", "GENERAL"],
});
