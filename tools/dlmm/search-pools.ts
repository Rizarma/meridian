// tools/dlmm/search-pools.ts
// Search DLMM pools by query — pure read operation

import { fetchWithRetry } from "../../src/utils/retry.js";
import { isArray, isObject } from "../../src/utils/validation.js";
import type { SearchPoolsParams, SearchPoolsResult } from "../../src/types/dlmm.js";

/** Raw shape from Meteora pool search API */
interface RawPoolSearchResult {
  address?: string;
  pool_address?: string;
  name: string;
  bin_step?: number;
  dlmm_params?: { bin_step?: number };
  base_fee_percentage?: number;
  fee_pct?: number;
  liquidity?: number;
  trade_volume_24h?: number;
  mint_x_symbol?: string;
  mint_x?: string;
  mint_y_symbol?: string;
  mint_y?: string;
  token_x?: { symbol?: string; address?: string };
  token_y?: { symbol?: string; address?: string };
}

/**
 * Search for DLMM pools by query string
 * @param params - Search query and optional limit
 * @returns Matching pools with metadata
 */
export async function searchPools({
  query,
  limit = 10,
}: SearchPoolsParams): Promise<SearchPoolsResult> {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);

  const rawSearchData = await res.json();
  if (!isObject(rawSearchData) && !isArray(rawSearchData)) {
    throw new Error("Invalid pool search response: not an object or array");
  }
  const data = rawSearchData as RawPoolSearchResult[] | { data?: RawPoolSearchResult[] };
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);

  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address || "",
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: {
        symbol: p.mint_x_symbol ?? p.token_x?.symbol,
        mint: p.mint_x ?? p.token_x?.address,
      },
      token_y: {
        symbol: p.mint_y_symbol ?? p.token_y?.symbol,
        mint: p.mint_y ?? p.token_y?.address,
      },
    })),
  };
}
