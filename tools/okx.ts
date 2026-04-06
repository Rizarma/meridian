/**
 * OKX DEX API helpers — public endpoints (no API key required)
 * Uses Ok-Access-Client-type: agent-cli header for unauthenticated access.
 * Docs: https://web3.okx.com/build/dev-docs/
 */
import crypto from "crypto";
import { config } from "../src/config/config.js";
import type {
  OKXAdvancedInfo,
  OKXAdvancedResult,
  OKXCluster,
  OKXClusterResult,
  OKXFullAnalysis,
  OKXPriceData,
  OKXPriceResult,
  OKXRiskAnalysis,
  OKXRiskFlags,
} from "../src/types/index.js";

const BASE = "https://web3.okx.com";
const CHAIN_SOLANA = "501";
const PUBLIC_HEADERS = { "Ok-Access-Client-type": "agent-cli" };

function getOKXCredentials() {
  return {
    OKX_API_KEY: process.env.OKX_API_KEY || process.env.OK_ACCESS_KEY || "",
    OKX_SECRET_KEY: process.env.OKX_SECRET_KEY || process.env.OK_ACCESS_SECRET || "",
    OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || process.env.OK_ACCESS_PASSPHRASE || "",
    OKX_PROJECT_ID: process.env.OKX_PROJECT_ID || process.env.OK_ACCESS_PROJECT || "",
  };
}

function hasAuth(): boolean {
  const { OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE } = getOKXCredentials();
  return !!(
    OKX_API_KEY &&
    OKX_SECRET_KEY &&
    OKX_PASSPHRASE &&
    !/enter your passphrase here/i.test(OKX_PASSPHRASE)
  );
}

/**
 * Check whether OKX integration is enabled.
 * Requires both the feature flag AND environment variables.
 */
export function isEnabled(): boolean {
  return config.features.okx && hasAuth();
}

function buildAuthHeaders(method: string, path: string, body = ""): Record<string, string> {
  const { OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, OKX_PROJECT_ID } = getOKXCredentials();
  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}${method.toUpperCase()}${path}${body}`;
  const sign = crypto.createHmac("sha256", OKX_SECRET_KEY).update(prehash).digest("base64");

  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-PASSPHRASE": OKX_PASSPHRASE,
    "OK-ACCESS-TIMESTAMP": timestamp,
  };

  if (OKX_PROJECT_ID) headers["OK-ACCESS-PROJECT"] = OKX_PROJECT_ID;
  return headers;
}

async function okxRequest(method: string, path: string, body: unknown = null): Promise<unknown> {
  const bodyText = body == null ? "" : JSON.stringify(body);
  const headers = hasAuth()
    ? {
        ...buildAuthHeaders(method, path, bodyText),
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      }
    : { ...PUBLIC_HEADERS, ...(body != null ? { "Content-Type": "application/json" } : {}) };

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body != null ? { body: bodyText } : {}),
  });
  if (!res.ok) throw new Error(`OKX API ${res.status}: ${path}`);
  const json = (await res.json()) as {
    code: string | number;
    msg?: string;
    message?: string;
    data: unknown;
  };
  if (json.code !== "0" && json.code !== 0)
    throw new Error(`OKX error ${json.code}: ${json.msg || json.message || "unknown"}`);
  return json.data;
}

async function okxGet(path: string): Promise<unknown> {
  return okxRequest("GET", path);
}

async function okxPost(path: string, body: unknown): Promise<unknown> {
  return okxRequest("POST", path, body);
}

const pct = (v: string | null | undefined): number | null =>
  v != null && v !== "" ? parseFloat(v) : null;
const int = (v: string | null | undefined): number | null =>
  v != null && v !== "" ? parseInt(v, 10) : null;

function isAffirmative(label: string | undefined): boolean {
  return typeof label === "string" && label.trim().toLowerCase() === "yes";
}

function collectRiskEntries(
  section:
    | { highRiskList?: unknown[]; middleRiskList?: unknown[]; lowRiskList?: unknown[] }
    | null
    | undefined
): Array<{ riskKey?: string; newRiskLabel?: string }> {
  if (!section || typeof section !== "object") return [];
  return [
    ...(Array.isArray(section.highRiskList) ? section.highRiskList : []),
    ...(Array.isArray(section.middleRiskList) ? section.middleRiskList : []),
    ...(Array.isArray(section.lowRiskList) ? section.lowRiskList : []),
  ] as Array<{ riskKey?: string; newRiskLabel?: string }>;
}

/**
 * Token risk flags from OKX's nested risk check endpoint.
 * Rugpull is informational only; wash trading is used as a hard filter upstream.
 */
export async function getRiskFlags(
  tokenAddress: string,
  chainId = CHAIN_SOLANA
): Promise<OKXRiskFlags> {
  const ts = Date.now();
  const path = `/priapi/v1/dx/market/v2/risk/new/check?chainId=${chainId}&tokenContractAddress=${tokenAddress}&t=${ts}`;
  const data = (await okxGet(path)) as OKXRiskAnalysis;

  const entries = [
    ...collectRiskEntries(data?.allAnalysis),
    ...collectRiskEntries(data?.swapAnalysis),
    ...collectRiskEntries(data?.contractAnalysis),
    ...collectRiskEntries(data?.extraAnalysis),
  ];

  const hasRisk = (riskKey: string): boolean =>
    entries.some((entry) => entry?.riskKey === riskKey && isAffirmative(entry?.newRiskLabel));

  return {
    is_rugpull: hasRisk("isLiquidityRemoval"),
    is_wash: hasRisk("isWash"),
    risk_level: int(String(data?.riskLevel ?? data?.riskControlLevel ?? "")),
    source: "okx-risk-check",
  };
}

/**
 * Advanced token info — risk level, bundle/sniper/suspicious %, dev rug history, token tags.
 */
export async function getAdvancedInfo(
  tokenAddress: string,
  chainIndex = CHAIN_SOLANA
): Promise<OKXAdvancedResult | null> {
  const path = `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = (await okxGet(path)) as OKXAdvancedInfo | OKXAdvancedInfo[];
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;

  const tags = d.tokenTags || [];
  return {
    risk_level: int(d.riskControlLevel),
    bundle_pct: pct(d.bundleHoldingPercent),
    sniper_pct: pct(d.sniperHoldingPercent),
    suspicious_pct: pct(d.suspiciousHoldingPercent),
    dev_holding_pct: pct(d.devHoldingPercent),
    top10_pct: pct(d.top10HoldPercent),
    lp_burned_pct: pct(d.lpBurnedPercent),
    total_fee_sol: pct(d.totalFee),
    dev_rug_count: int(d.devRugPullTokenCount),
    dev_token_count: int(d.devCreateTokenCount),
    creator: d.creatorAddress || null,
    tags,
    is_honeypot: tags.includes("honeypot"),
    smart_money_buy: tags.includes("smartMoneyBuy"),
    dev_sold_all: tags.includes("devHoldingStatusSellAll"),
    dev_buying_more: tags.includes("devHoldingStatusBuy"),
    low_liquidity: tags.includes("lowLiquidity"),
    dex_boost: tags.includes("dexBoost"),
    dex_screener_paid: tags.includes("dexScreenerPaid") || tags.includes("dsPaid"),
  };
}

/**
 * Top holder clusters — trend direction, holding period, KOL presence, PnL.
 * Condenses to top N clusters for LLM consumption.
 */
export async function getClusterList(
  tokenAddress: string,
  chainIndex = CHAIN_SOLANA,
  limit = 5
): Promise<OKXClusterResult[]> {
  const path = `/api/v6/dex/market/token/cluster/list?chainIndex=${chainIndex}&tokenContractAddress=${tokenAddress}`;
  const data = (await okxGet(path)) as { clusterList?: OKXCluster[] } | OKXCluster[];
  // Public endpoint returns data.clusterList (not data[0].clustList)
  const raw = !Array.isArray(data)
    ? (data.clusterList ?? [])
    : ((data[0] as { clustList?: OKXCluster[] })?.clustList ?? []);
  if (!raw.length) return [];

  return raw.slice(0, limit).map((c) => {
    const hasKol = (c.clusterAddressList || []).some((a) => a.isKol);
    const trendType = typeof c.trendType === "object" ? c.trendType?.trendType : c.trendType;
    return {
      holding_pct: pct(c.holdingPercent),
      trend: trendType || null,
      avg_hold_days: c.averageHoldingPeriod
        ? Math.round(parseFloat(c.averageHoldingPeriod) / 86400)
        : null,
      pnl_pct: pct(c.pnlPercent),
      buy_vol_usd: pct(c.buyVolume),
      sell_vol_usd: pct(c.sellVolume),
      avg_buy_price: pct(c.averageBuyPriceUsd),
      has_kol: hasKol,
      address_count: (c.clusterAddressList || []).length,
    };
  });
}

/**
 * Price info — current price, ATH (maxPrice), ATL, multi-timeframe volume + price change.
 * Also returns holders, marketCap, liquidity from this endpoint.
 */
export async function getPriceInfo(
  tokenAddress: string,
  chainIndex = CHAIN_SOLANA
): Promise<OKXPriceResult | null> {
  const data = (await okxPost("/api/v6/dex/market/price-info", [
    { chainIndex, tokenContractAddress: tokenAddress },
  ])) as OKXPriceData | OKXPriceData[];
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;
  const price = parseFloat(d.price || "0");
  const maxPrice = parseFloat(d.maxPrice || "0");
  return {
    price,
    ath: maxPrice,
    atl: parseFloat(d.minPrice || "0"),
    price_vs_ath_pct: maxPrice > 0 ? parseFloat(((price / maxPrice) * 100).toFixed(1)) : null,
    price_change_5m: pct(d.priceChange5M),
    price_change_1h: pct(d.priceChange1H),
    volume_5m: pct(d.volume5M),
    volume_1h: pct(d.volume1H),
    holders: int(d.holders),
    market_cap: pct(d.marketCap),
    liquidity: pct(d.liquidity),
  };
}

/**
 * Fetch all three in parallel — use this during screening enrichment.
 */
export async function getFullTokenAnalysis(
  tokenAddress: string,
  chainIndex = CHAIN_SOLANA
): Promise<OKXFullAnalysis> {
  const [advanced, clusters, price] = await Promise.allSettled([
    getAdvancedInfo(tokenAddress, chainIndex),
    getClusterList(tokenAddress, chainIndex),
    getPriceInfo(tokenAddress, chainIndex),
  ]);
  return {
    advanced: advanced.status === "fulfilled" ? advanced.value : null,
    clusters: clusters.status === "fulfilled" ? clusters.value : [],
    price: price.status === "fulfilled" ? price.value : null,
  };
}
