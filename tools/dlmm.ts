import { Keypair, PublicKey, sendAndConfirmTransaction, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../src/config/config.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../src/domain/pool-memory.js";
import {
  getActiveStrategy,
  getStrategyByLpStrategy,
  isLegacyLpStrategy,
} from "../src/domain/strategy-library.js";
import { getSharedConnection } from "../src/infrastructure/connection.js";
import { log } from "../src/infrastructure/logger.js";
import {
  getTrackedPosition,
  markInRange,
  markOutOfRange,
  minutesOutOfRange,
  syncOpenPositions,
} from "../src/infrastructure/state.js";
import type {
  ActiveBinParams,
  ActiveBinResult,
  AddLiquidityParams,
  AddLiquidityResult,
  ClaimParams,
  ClaimResult,
  CloseParams,
  CloseResult,
  DeployParams,
  DeployResult,
  EnrichedPosition,
  PositionPnL,
  PositionsResult,
  RawPnLData,
  SearchPoolsParams,
  SearchPoolsResult,
  WalletPositionsParams,
  WalletPositionsResult,
  WithdrawLiquidityParams,
  WithdrawLiquidityResult,
} from "../src/types/dlmm.js";
import { getErrorMessage } from "../src/utils/errors.js";
import { recordActivity } from "../src/utils/health-check.js";
import { fetchWithRetry } from "../src/utils/retry.js";
import { isArray, isObject } from "../src/utils/validation.js";
import { getWallet } from "../src/utils/wallet.js";
import { registerTool } from "./registry.js";
import { normalizeMint } from "./wallet.js";

// Phase A+B: Import from extracted modules
import {
  // SDK loader
  loadDlmmSdk,
  // Token amounts
  toLamports,
  fetchTokenDecimals,
  // Strategy
  resolveStrategy,
  calculateBinRange,
  isWideRange,
  // Pool cache
  getPool,
  stopPoolCache,
  clearPoolCache,
  deletePoolFromCache,
  // Positions cache
  withPositionsCacheLock,
  getCachedPositions,
  setPositionsCache,
  invalidatePositionsCache,
  getPositionsInflight,
  setPositionsInflight,
  findPositionInCache,
  getPoolFromCache,
  // PnL API
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
  getPositionPnlFromApi,
  fetchClosedPnlForPool,
  // Position SDK
  lookupPoolForPosition,
  getAllPositionsForWallet,
} from "./dlmm/index.js";

// Default slippage in basis points (1000 bps = 10%)
const DEFAULT_SLIPPAGE_BPS = 1000;

// Re-export from modules for backward compatibility
export {
  stopPoolCache,
  clearPoolCache,
  deletePoolFromCache,
  withPositionsCacheLock,
  invalidatePositionsCache,
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
  lookupPoolForPosition,
} from "./dlmm/index.js";

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }: ActiveBinParams): Promise<ActiveBinResult> {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price as BN)),
    pricePerLamport: (activeBin.price as BN).toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol,
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
}: DeployParams): Promise<DeployResult> {
  pool_address = normalizeMint(pool_address);

  // Resolve strategy configuration from modules
  const {
    strategyId,
    strategyConfig,
    strategyType,
    binsBelow: activeBinsBelow,
    binsAbove: activeBinsAbove,
  } = await resolveStrategy(strategy);

  if (await isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return {
      success: false,
      error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool.",
    };
  }

  if (process.env.DRY_RUN === "true") {
    const totalBins = activeBinsBelow + activeBinsAbove;
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: strategyId,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0,
        wide_range: isWideRange(activeBinsBelow, activeBinsAbove),
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (await isBaseMintOnCooldown(baseMint)) {
    log(
      "deploy",
      `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`
    );
    return {
      success: false,
      error:
        "Token on cooldown — recently closed out-of-range too many times. Try a different token.",
    };
  }
  const activeBin = await pool.getActiveBin();

  // Range calculation via module
  const { minBinId, maxBinId } = calculateBinRange(activeBin.binId, activeBinsBelow, activeBinsAbove);

  // Calculate amounts
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = toLamports(finalAmountY, 9); // SOL has 9 decimals
  
  // For X, fetch decimals from mint via module
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const decimalsX = await fetchTokenDecimals(pool.lbPair.tokenXMint);
    totalXLamports = toLamports(finalAmountX, decimalsX);
  }

  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRangeDeploy = isWideRange(activeBinsBelow, activeBinsAbove);
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log(
    "deploy",
    `Strategy: ${strategyId}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRangeDeploy ? " — WIDE RANGE" : ""})`
  );
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes: string[] = [];

    if (isWideRangeDeploy) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs: Transaction | Transaction[] = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        // Simulate first to catch errors before spending gas
        const simulation = await getSharedConnection().simulateTransaction(
          createTxArray[i],
          signers
        );
        if (simulation.value.err) {
          const errorMessage = JSON.stringify(simulation.value.err);
          log("deploy", `Transaction simulation failed: ${errorMessage}`);
          throw new Error(`Simulation failed: ${errorMessage}`);
        }
        const txHash = await sendAndConfirmTransaction(
          getSharedConnection(),
          createTxArray[i],
          signers
        );
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs: Transaction | Transaction[] = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        // Simulate first to catch errors before spending gas
        const simulation = await getSharedConnection().simulateTransaction(addTxArray[i], [wallet]);
        if (simulation.value.err) {
          const errorMessage = JSON.stringify(simulation.value.err);
          log("deploy", `Transaction simulation failed: ${errorMessage}`);
          throw new Error(`Simulation failed: ${errorMessage}`);
        }
        const txHash = await sendAndConfirmTransaction(getSharedConnection(), addTxArray[i], [
          wallet,
        ]);
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx: Transaction = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      // Simulate first to catch errors before spending gas
      const simulation = await getSharedConnection().simulateTransaction(tx, [wallet, newPosition]);
      if (simulation.value.err) {
        const errorMessage = JSON.stringify(simulation.value.err);
        log("deploy", `Transaction simulation failed: ${errorMessage}`);
        throw new Error(`Simulation failed: ${errorMessage}`);
      }
      const txHash = await sendAndConfirmTransaction(getSharedConnection(), tx, [
        wallet,
        newPosition,
      ]);
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);
    recordActivity();

    await invalidatePositionsCache();

    const actualBinStep = pool.lbPair.binStep;
    const activePrice = parseFloat((activeBin.price as BN).toString());
    const minPrice = activePrice * (1 + actualBinStep / 10000) ** (minBinId - activeBin.binId);
    const maxPrice = activePrice * (1 + actualBinStep / 10000) ** (maxBinId - activeBin.binId);

    // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
    const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
    const actualBaseFee =
      base_fee ??
      (baseFactor > 0 ? parseFloat((((baseFactor * actualBinStep) / 1e6) * 100).toFixed(4)) : null);

    if (!strategyConfig) {
      log(
        "deploy_warn",
        `No persisted strategy definition found for lp_strategy "${strategyId}"; strategy_config will be omitted`
      );
    }

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: strategyId,
      strategy_config: strategyConfig as unknown as Record<string, unknown> | undefined,
      wide_range: isWideRangeDeploy,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
      // Additional fields for persistence (trackPosition)
      volatility,
      fee_tvl_ratio,
      organic_score,
      initial_value_usd,
      active_bin: activeBin.binId,
      amount_sol: finalAmountY,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("deploy_error", message);
    return { success: false, error: message };
  }
}

// ─── Add Liquidity ─────────────────────────────────────────────
export async function addLiquidity({
  position_address,
  pool_address,
  amount_x,
  amount_y,
  strategy,
  single_sided_x,
}: AddLiquidityParams): Promise<AddLiquidityResult> {
  position_address = normalizeMint(position_address);
  pool_address = normalizeMint(pool_address);

  // ─── Validation ──────────────────────────────────────────────
  // Validate addresses
  try {
    new PublicKey(position_address);
    new PublicKey(pool_address);
  } catch {
    return { success: false, error: "Invalid Solana address format" };
  }

  // Validate at least one amount is provided and > 0
  const finalAmountX = amount_x ?? 0;
  const finalAmountY = amount_y ?? 0;
  if (finalAmountX <= 0 && finalAmountY <= 0) {
    return { success: false, error: "At least one amount (amount_x or amount_y) must be > 0" };
  }

  // Validate single_sided_x requires amount_x > 0
  if (single_sided_x && finalAmountX <= 0) {
    return {
      success: false,
      error:
        "single_sided_x requires amount_x > 0 — cannot do single-sided X deposit without X amount",
    };
  }

  // ─── DRY RUN ─────────────────────────────────────────────────
  if (process.env.DRY_RUN === "true") {
    return {
      success: true,
      position: position_address,
      pool: pool_address,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: [],
      error: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("add_liquidity", `Adding liquidity to position: ${position_address}`);
    const wallet = getWallet();

    // Resolve strategy via module
    const { strategyType } = await resolveStrategy(strategy);

    // ─── Load Pool & Position ──────────────────────────────────
    deletePoolFromCache(pool_address); // Clear cache for fresh state
    const pool = await getPool(pool_address);

    // Get position data to determine bin range
    const positionPubKey = new PublicKey(position_address);
    let positionData: unknown;
    try {
      positionData = await pool.getPosition(positionPubKey);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Position not found: ${message}` };
    }

    // Check if position is closed
    const tracked = await getTrackedPosition(position_address);
    if (tracked?.closed) {
      return { success: false, error: "Position already closed — cannot add liquidity" };
    }

    // Get bin range from position data
    // Validate positionData has expected shape before accessing
    if (!isObject(positionData)) {
      return { success: false, error: "Invalid position data from SDK" };
    }
    const processed = (
      positionData as { positionData?: { lowerBinId?: number; upperBinId?: number } }
    )?.positionData;
    const minBinId = processed?.lowerBinId ?? -887272;
    const maxBinId = processed?.upperBinId ?? 887272;

    // Check if position is in range
    const activeBin = await pool.getActiveBin();
    const isInRange = activeBin.binId >= minBinId && activeBin.binId <= maxBinId;
    if (!isInRange) {
      return {
        success: false,
        error: `Position out of range — active bin ${activeBin.binId} is outside position range [${minBinId}, ${maxBinId}]`,
      };
    }

    // ─── Convert Amounts to Lamports ─────────────────────────────
    // Get token decimals via module
    const decimalsX = await fetchTokenDecimals(pool.lbPair.tokenXMint);
    const decimalsY = await fetchTokenDecimals(pool.lbPair.tokenYMint);

    // Convert to lamports
    const totalXLamports =
      finalAmountX > 0 ? new BN((finalAmountX * 10 ** decimalsX).toFixed(0), 10) : new BN(0);
    const totalYLamports =
      finalAmountY > 0 ? new BN((finalAmountY * 10 ** decimalsY).toFixed(0), 10) : new BN(0);

    // Handle single-sided liquidity
    const finalXLamports = totalXLamports;
    let finalYLamports = totalYLamports;
    if (single_sided_x && finalAmountX > 0) {
      if (finalAmountY > 0) {
        log("add_liquidity", `Note: single_sided_x=true — ignoring amount_y (${finalAmountY})`);
      }
      finalYLamports = new BN(0);
    }

    log("add_liquidity", `Pool: ${pool_address}`);
    log("add_liquidity", `Strategy: ${strategy || config.strategy.strategy}, Bin range: ${minBinId} to ${maxBinId}`);
    log("add_liquidity", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
    log("add_liquidity", `Active bin: ${activeBin.binId}`);

    // ─── Execute Add Liquidity ─────────────────────────────────
    const txHashes: string[] = [];
    const totalBins = maxBinId - minBinId + 1;
    const isWideRange = totalBins > 69;

    if (isWideRange) {
      // Wide range: use chunkable method
      const addTxs: Transaction | Transaction[] = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: positionPubKey,
        user: wallet.publicKey,
        totalXAmount: finalXLamports,
        totalYAmount: finalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        // Simulate first to catch errors before spending gas
        const simulation = await getSharedConnection().simulateTransaction(addTxArray[i], [wallet]);
        if (simulation.value.err) {
          const errorMessage = JSON.stringify(simulation.value.err);
          log("add_liquidity", `Transaction simulation failed: ${errorMessage}`);
          throw new Error(`Simulation failed: ${errorMessage}`);
        }
        const txHash = await sendAndConfirmTransaction(getSharedConnection(), addTxArray[i], [
          wallet,
        ]);
        txHashes.push(txHash);
        log("add_liquidity", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // Standard range: use single transaction method
      const addTx: Transaction = await pool.addLiquidityByStrategy({
        positionPubKey: positionPubKey,
        user: wallet.publicKey,
        totalXAmount: finalXLamports,
        totalYAmount: finalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: DEFAULT_SLIPPAGE_BPS,
      });
      // Simulate first to catch errors before spending gas
      const simulation = await getSharedConnection().simulateTransaction(addTx, [wallet]);
      if (simulation.value.err) {
        const errorMessage = JSON.stringify(simulation.value.err);
        log("add_liquidity", `Transaction simulation failed: ${errorMessage}`);
        throw new Error(`Simulation failed: ${errorMessage}`);
      }
      const txHash = await sendAndConfirmTransaction(getSharedConnection(), addTx, [wallet]);
      txHashes.push(txHash);
      log("add_liquidity", `Add liquidity tx: ${txHash}`);
    }

    log("add_liquidity", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);
    recordActivity();

    // Invalidate positions cache
    await invalidatePositionsCache();

    return {
      success: true,
      position: position_address,
      pool: pool_address,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error: any) {
    log("add_liquidity_error", error.message);

    // Handle specific error cases
    if (error.message?.includes("insufficient")) {
      return { success: false, error: `Insufficient balance: ${error.message}` };
    }
    if (error.message?.includes("0x1")) {
      return { success: false, error: `Insufficient balance or invalid account: ${error.message}` };
    }
    if (error.message?.includes("range") || error.message?.includes("bin")) {
      return { success: false, error: `Out of range or invalid bin: ${error.message}` };
    }

    return { success: false, error: error.message };
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({
  pool_address,
  position_address,
}: {
  pool_address: string;
  position_address: string;
}): Promise<PositionPnL | { error: string }> {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  return getPositionPnlFromApi(pool_address, position_address, walletAddress);
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({
  force = false,
  silent = false,
} = {}): Promise<PositionsResult> {
  const cached = getCachedPositions(force);
  if (cached) return cached;

  const inflight = getPositionsInflight();
  if (inflight) return inflight;

  let walletAddress: string;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const fetchPromise = (async () => {
    try {
      // Single portfolio API call — returns all positions with full PnL data
      if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
      const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
      const res = await fetchWithRetry(portfolioUrl);
      if (!res.ok)
        throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
      const portfolio = (await res.json()) as { pools?: any[] };

      const pools = portfolio.pools || [];
      if (!silent) log("positions", `Found ${pools.length} pool(s) with open positions`);

      // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
      // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
      const binDataByPool: Record<string, Record<string, RawPnLData>> = {};
      const pnlMaps = await Promise.all(
        pools.map((pool: any) => fetchDlmmPnlForPool(pool.poolAddress, walletAddress))
      );
      pools.forEach((pool: any, i: number) => {
        binDataByPool[pool.poolAddress] = pnlMaps[i];
      });

      const positions: EnrichedPosition[] = [];
      for (const pool of pools) {
        for (const positionAddress of pool.listPositions || []) {
          const tracked = await getTrackedPosition(positionAddress);
          const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

          // Mark OOR state and capture the effective out_of_range_since to
          // avoid a duplicate DB read in minutesOutOfRange below.
          const oorSince = isOOR
            ? await markOutOfRange(positionAddress)
            : await markInRange(positionAddress);

          // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
          const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
          if (!binData) {
            log(
              "positions_warn",
              `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`
            );
          }
          const lowerBin = binData?.lowerBinId ?? tracked?.bin_range?.min ?? null;
          const upperBin = binData?.upperBinId ?? tracked?.bin_range?.max ?? null;
          const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;

          const ageFromState = tracked?.deployed_at
            ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
            : null;
          const reportedPnlPct = binData
            ? Number(
                config.features.solMode
                  ? (binData.pnlSolPctChange ?? 0)
                  : (binData.pnlPctChange ?? 0)
              )
            : null;
          const derivedPnlPct = binData ? deriveOpenPnlPct(binData, config.features.solMode) : null;
          const pnlPctDiff =
            reportedPnlPct != null && derivedPnlPct != null
              ? Math.abs(reportedPnlPct - derivedPnlPct)
              : null;
          const pnlPctSuspicious =
            pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
          if (pnlPctSuspicious) {
            log(
              "positions_warn",
              `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct?.toFixed(2)} derived=${derivedPnlPct?.toFixed(2)} diff=${pnlPctDiff?.toFixed(2)}`
            );
          }

          positions.push({
            position: positionAddress,
            pool: pool.poolAddress,
            pair: tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
            base_mint: pool.tokenXMint,
            lower_bin: lowerBin,
            upper_bin: upperBin,
            active_bin: activeBin,
            in_range: binData ? !binData.isOutOfRange : !isOOR,
            unclaimed_fees_usd: binData
              ? Math.round(
                  (config.features.solMode
                    ? Number(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol ?? 0) +
                      Number(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol ?? 0)
                    : Number(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0) +
                      Number(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0)) * 10000
                ) / 10000
              : null,
            total_value_usd: binData
              ? Math.round(
                  (config.features.solMode
                    ? Number(binData.unrealizedPnl?.balancesSol ?? 0)
                    : Number(binData.unrealizedPnl?.balances ?? 0)) * 10000
                ) / 10000
              : null,
            // Always-USD fields for internal accounting and lesson recording.
            total_value_true_usd: binData
              ? Math.round(Number(binData.unrealizedPnl?.balances ?? 0) * 10000) / 10000
              : null,
            collected_fees_usd: binData
              ? Math.round(
                  Number(
                    config.features.solMode
                      ? (binData.allTimeFees?.total?.sol ?? 0)
                      : (binData.allTimeFees?.total?.usd ?? 0)
                  ) * 10000
                ) / 10000
              : null,
            collected_fees_true_usd: binData
              ? Math.round(Number(binData.allTimeFees?.total?.usd ?? 0) * 10000) / 10000
              : null,
            pnl_usd: binData
              ? Math.round(
                  Number(config.features.solMode ? (binData.pnlSol ?? 0) : (binData.pnlUsd ?? 0)) *
                    10000
                ) / 10000
              : null,
            pnl_true_usd: binData ? Math.round(Number(binData.pnlUsd ?? 0) * 10000) / 10000 : null,
            pnl_pct: binData ? Math.round((reportedPnlPct || 0) * 100) / 100 : null,
            pnl_pct_derived: derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
            pnl_pct_diff: pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
            pnl_pct_suspicious: !!pnlPctSuspicious,
            unclaimed_fees_true_usd: binData
              ? Math.round(
                  (Number(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0) +
                    Number(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0)) *
                    10000
                ) / 10000
              : null,
            fee_per_tvl_24h: binData
              ? Math.round(Number(binData.feePerTvl24h ?? 0) * 100) / 100
              : null,
            age_minutes: binData?.createdAt
              ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000)
              : ageFromState,
            minutes_out_of_range: await minutesOutOfRange(positionAddress, oorSince),
            instruction: tracked?.instruction ?? null,
            tracked_state: tracked,
          });
        }
      }

      const result: PositionsResult = {
        wallet: walletAddress,
        total_positions: positions.length,
        positions,
      };
      syncOpenPositions(positions.map((p) => p.position));
      await setPositionsCache(result);
      return result;
    } catch (error: unknown) {
      log("positions_error", `Portfolio fetch failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      return {
        wallet: walletAddress,
        total_positions: 0,
        positions: [] as EnrichedPosition[],
        error: getErrorMessage(error),
      };
    } finally {
      setPositionsInflight(null);
    }
  })();

  setPositionsInflight(fetchPromise);
  return fetchPromise;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({
  wallet_address,
}: WalletPositionsParams): Promise<WalletPositionsResult> {
  try {
    const positions = await getAllPositionsForWallet(wallet_address);

    if (positions.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    // Enrich with PnL API
    const uniquePools = [...new Set(positions.map((r) => r.pool))];
    const pnlMaps = await Promise.all(
      uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address))
    );
    const pnlByPool: Record<string, Record<string, RawPnLData>> = {};
    uniquePools.forEach((pool, i) => {
      pnlByPool[pool] = pnlMaps[i];
    });

    const enrichedPositions = positions.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position: r.position,
        pool: r.pool,
        lower_bin: p?.lowerBinId ?? null,
        upper_bin: p?.upperBinId ?? null,
        active_bin: p?.poolActiveBinId ?? null,
        in_range: p ? !p.isOutOfRange : null,
        unclaimed_fees_usd:
          Math.round(
            (p
              ? parseFloat(String(p.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0)) +
                parseFloat(String(p.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0))
              : 0) * 100
          ) / 100,
        total_value_usd:
          Math.round((p ? parseFloat(String(p.unrealizedPnl?.balances ?? 0)) : 0) * 100) / 100,
        pnl_usd: Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct: Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes: p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: enrichedPositions.length, positions: enrichedPositions };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log("wallet_positions_error", message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({
  query,
  limit = 10,
}: SearchPoolsParams): Promise<SearchPoolsResult> {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  interface PoolSearchResult {
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
  const rawSearchData = await res.json();
  if (!isObject(rawSearchData) && !isArray(rawSearchData)) {
    throw new Error("Invalid pool search response: not an object or array");
  }
  const data = rawSearchData as PoolSearchResult[] | { data?: PoolSearchResult[] };
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

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }: ClaimParams): Promise<ClaimResult> {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_claim: position_address,
      message: "DRY RUN — no transaction sent",
    };
  }

  const tracked = await getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    deletePoolFromCache(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs: Transaction[] = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes: string[] = [];
    for (const tx of txs) {
      // Simulate first to catch errors before spending gas
      const simulation = await getSharedConnection().simulateTransaction(tx, [wallet]);
      if (simulation.value.err) {
        const errorMessage = JSON.stringify(simulation.value.err);
        log("claim", `Transaction simulation failed: ${errorMessage}`);
        throw new Error(`Simulation failed: ${errorMessage}`);
      }
      const txHash = await sendAndConfirmTransaction(getSharedConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    recordActivity();
    await invalidatePositionsCache();

    return {
      success: true,
      position: position_address,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
      // Flag for middleware to record claim
      _recordClaim: true,
    };
  } catch (error: any) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Withdraw Liquidity ────────────────────────────────────────
export async function withdrawLiquidity({
  position_address,
  pool_address,
  bps = 10000,
  claim_fees = false,
}: WithdrawLiquidityParams): Promise<WithdrawLiquidityResult> {
  position_address = normalizeMint(position_address);
  pool_address = normalizeMint(pool_address);

  // ─── Parameter Validation ───────────────────────────────────
  // Validate Solana addresses (base58, 32-44 chars)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  if (
    !base58Regex.test(position_address) ||
    position_address.length < 32 ||
    position_address.length > 44
  ) {
    return { success: false, error: `Invalid position_address: ${position_address}` };
  }
  if (!base58Regex.test(pool_address) || pool_address.length < 32 || pool_address.length > 44) {
    return { success: false, error: `Invalid pool_address: ${pool_address}` };
  }

  // Validate bps (1-10000, where 10000 = 100%)
  if (bps < 1 || bps > 10000) {
    return {
      success: false,
      error: `Invalid bps: ${bps}. Must be between 1 and 10000 (10000 = 100%)`,
    };
  }

  // ─── Dry Run Mode ─────────────────────────────────────────────
  if (process.env.DRY_RUN === "true") {
    return {
      success: true,
      position: position_address,
      pool: pool_address,
      bps,
      amount_x_withdrawn: 0,
      amount_y_withdrawn: 0,
      fees_claimed: claim_fees ? 0 : undefined,
      txs: [],
    };
  }

  const tracked = await getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — no liquidity to withdraw" };
  }

  try {
    log("withdraw", `Withdrawing ${bps / 100}% liquidity from position: ${position_address}`);
    const wallet = getWallet();

    // Clear cached pool so SDK loads fresh position state
    deletePoolFromCache(pool_address.toString());
    const pool = await getPool(pool_address);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes: string[] = [];
    let feesClaimedUsd = 0;

    // ─── Step 1: Claim Fees (optional) ─────────────────────────
    if (claim_fees) {
      const recentlyClaimed =
        tracked?.last_claim_at && Date.now() - new Date(tracked.last_claim_at).getTime() < 60_000;
      try {
        if (recentlyClaimed) {
          log(
            "withdraw",
            `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at!).getTime()) / 1000)}s ago`
          );
        } else {
          log("withdraw", `Step 1: Claiming fees for ${position_address}`);
          const positionData = await pool.getPosition(positionPubKey);
          const claimTxs: Transaction[] = await pool.claimSwapFee({
            owner: wallet.publicKey,
            position: positionData,
          });
          if (claimTxs && claimTxs.length > 0) {
            for (const tx of claimTxs) {
              // Simulate first to catch errors before spending gas
              const simulation = await getSharedConnection().simulateTransaction(tx, [wallet]);
              if (simulation.value.err) {
                const errorMessage = JSON.stringify(simulation.value.err);
                log("withdraw", `Transaction simulation failed: ${errorMessage}`);
                throw new Error(`Simulation failed: ${errorMessage}`);
              }
              const claimHash = await sendAndConfirmTransaction(getSharedConnection(), tx, [
                wallet,
              ]);
              claimTxHashes.push(claimHash);
            }
            log("withdraw", `Step 1 OK (claim): ${claimTxHashes.join(", ")}`);

            // Get fees claimed from position data
            const binData = await fetchDlmmPnlForPool(pool_address, wallet.publicKey.toString());
            const posData = binData[position_address];
            if (posData?.unrealizedPnl) {
              feesClaimedUsd =
                Number(posData.unrealizedPnl.unclaimedFeeTokenX?.usd ?? 0) +
                Number(posData.unrealizedPnl.unclaimedFeeTokenY?.usd ?? 0);
            }
          }
        }
      } catch (e: any) {
        log("withdraw_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
      }
    }

    // ─── Step 2: Get Position Data & Check Liquidity ────────────
    let fromBinId = -887272;
    let toBinId = 887272;
    let hasLiquidity = false;
    let preBinData: any[] = [];

    try {
      const positionData = await pool.getPosition(positionPubKey);
      const processed = (positionData as { positionData?: { lowerBinId?: number; upperBinId?: number; positionBinData?: unknown[] } })?.positionData;
      if (processed) {
        fromBinId = processed.lowerBinId ?? fromBinId;
        toBinId = processed.upperBinId ?? toBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        preBinData = bins as Array<{ positionLiquidity?: string }>;
        hasLiquidity = bins.some((bin) => new BN((bin as { positionLiquidity?: string })?.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("withdraw_warn", `Could not check liquidity state: ${message}`);
    }

    if (!hasLiquidity) {
      return { success: false, error: "Position has no liquidity to withdraw" };
    }

    // Get token decimals for amount conversion
    let decimalsX = 9;
    let decimalsY = 9;
    try {
      const mintXInfo = await getSharedConnection().getParsedAccountInfo(
        new PublicKey(pool.lbPair.tokenXMint)
      );
      const parsedDataX = mintXInfo.value?.data as
        | { parsed?: { info?: { decimals?: number } } }
        | undefined;
      decimalsX = parsedDataX?.parsed?.info?.decimals ?? 9;
      const mintYInfo = await getSharedConnection().getParsedAccountInfo(
        new PublicKey(pool.lbPair.tokenYMint)
      );
      const parsedDataY = mintYInfo.value?.data as
        | { parsed?: { info?: { decimals?: number } } }
        | undefined;
      decimalsY = parsedDataY?.parsed?.info?.decimals ?? 9;
    } catch {
      log("withdraw_warn", "Could not fetch token decimals, using default 9");
    }

    // ─── Step 3: Remove Liquidity ───────────────────────────────
    // Note: removeLiquidity is deterministic — removes bps/10000 of existing
    // position liquidity from each bin. No slippage parameter needed (unlike
    // addLiquidity which converts new capital at current prices).
    log("withdraw", `Step 2: Removing ${bps / 100}% liquidity`);
    const withdrawTxs: Transaction | Transaction[] = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(bps),
      shouldClaimAndClose: false, // Don't close position, just withdraw
    });

    const withdrawTxHashes: string[] = [];
    for (const tx of Array.isArray(withdrawTxs) ? withdrawTxs : [withdrawTxs]) {
      // Simulate first to catch errors before spending gas
      const simulation = await getSharedConnection().simulateTransaction(tx, [wallet]);
      if (simulation.value.err) {
        const errorMessage = JSON.stringify(simulation.value.err);
        log("withdraw", `Transaction simulation failed: ${errorMessage}`);
        throw new Error(`Simulation failed: ${errorMessage}`);
      }
      const txHash = await sendAndConfirmTransaction(getSharedConnection(), tx, [wallet]);
      withdrawTxHashes.push(txHash);
    }
    log("withdraw", `Step 2 OK (withdraw): ${withdrawTxHashes.join(", ")}`);

    // ─── Step 4: Calculate Withdrawn Amounts ────────────────────
    // Use on-chain position data comparison (pre vs post) instead of wallet
    // balance delta. The wallet balance approach has a race condition — other
    // transactions (auto-swap, concurrent claims) can change balances between
    // the pre and post snapshots, producing incorrect amounts.
    // sendAndConfirmTransaction already waits for confirmation, so the RPC
    // state should reflect the withdrawal immediately (no sleep needed).
    let amountXWithdrawn = 0;
    let amountYWithdrawn = 0;

    try {
      // Re-fetch position data after confirmed withdrawal
      const postPositionData = await pool.getPosition(positionPubKey);
      const postProcessed = (postPositionData as { positionData?: { positionBinData?: unknown[] } })?.positionData;
      const postBins = Array.isArray(postProcessed?.positionBinData)
        ? postProcessed.positionBinData
        : [];

      // Sum pre-withdrawal liquidity across all bins
      let preTotalLiquidity = new BN(0);
      for (const bin of preBinData) {
        preTotalLiquidity = preTotalLiquidity.add(new BN(bin.positionLiquidity || "0"));
      }

      // Sum post-withdrawal liquidity across all bins
      let postTotalLiquidity = new BN(0);
      for (const bin of postBins) {
        postTotalLiquidity = postTotalLiquidity.add(new BN((bin as { positionLiquidity?: string })?.positionLiquidity || "0"));
      }

      const liquidityDelta = preTotalLiquidity.sub(postTotalLiquidity);

      if (liquidityDelta.gt(new BN(0)) && preTotalLiquidity.gt(new BN(0))) {
        // We know how much liquidity was removed. Estimate token amounts
        // from the bps ratio applied to pre-withdrawal bin composition.
        const bpsRatio = bps / 10000;

        // Use per-bin X/Y amounts if available (Meteora SDK provides these)
        let preTotalX = new BN(0);
        let preTotalY = new BN(0);
        for (const bin of preBinData) {
          preTotalX = preTotalX.add(new BN(bin.positionXAmount || bin.positionX || "0"));
          preTotalY = preTotalY.add(new BN(bin.positionYAmount || bin.positionY || "0"));
        }

        if (preTotalX.gt(new BN(0)) || preTotalY.gt(new BN(0))) {
          // SDK provides per-token amounts — use bps ratio directly
          amountXWithdrawn = (preTotalX.toNumber() * bpsRatio) / 10 ** decimalsX;
          amountYWithdrawn = (preTotalY.toNumber() * bpsRatio) / 10 ** decimalsY;
        } else {
          // Fallback: estimate from total liquidity change ratio applied to
          // current wallet balance. NOTE: This may be inaccurate if other
          // transactions (auto-swap, claims) modify the wallet concurrently.
          const removedRatio = liquidityDelta.toNumber() / preTotalLiquidity.toNumber();
          log(
            "withdraw",
            `Using fallback estimate (removedRatio=${removedRatio.toFixed(4)}) — amounts are approximate`
          );
          const tokenXAccount = await getSharedConnection().getTokenAccountsByOwner(
            wallet.publicKey,
            {
              mint: pool.lbPair.tokenXMint,
            }
          );
          const tokenYAccount = await getSharedConnection().getTokenAccountsByOwner(
            wallet.publicKey,
            {
              mint: pool.lbPair.tokenYMint,
            }
          );
          if (tokenXAccount.value.length > 0) {
            const info = await getSharedConnection().getParsedAccountInfo(
              tokenXAccount.value[0].pubkey
            );
            const parsedData = info.value?.data as
              | { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }
              | undefined;
            const parsed = parsedData?.parsed?.info;
            amountXWithdrawn = parsed
              ? Number(parsed.tokenAmount?.uiAmount ?? 0) * removedRatio
              : 0;
          }
          if (tokenYAccount.value.length > 0) {
            const info = await getSharedConnection().getParsedAccountInfo(
              tokenYAccount.value[0].pubkey
            );
            const parsedData = info.value?.data as
              | { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }
              | undefined;
            const parsed = parsedData?.parsed?.info;
            amountYWithdrawn = parsed
              ? Number(parsed.tokenAmount?.uiAmount ?? 0) * removedRatio
              : 0;
          }
        }
      }

      amountXWithdrawn = Math.max(0, amountXWithdrawn);
      amountYWithdrawn = Math.max(0, amountYWithdrawn);
    } catch (e: any) {
      log("withdraw_warn", `Could not calculate withdrawn amounts: ${e.message}`);
    }

    // ─── Step 5: Invalidate Cache & Return ──────────────────────
    await invalidatePositionsCache();

    const allTxs = [...claimTxHashes, ...withdrawTxHashes];
    log(
      "withdraw",
      `SUCCESS — withdrawn ~${amountXWithdrawn.toFixed(6)} X, ~${amountYWithdrawn.toFixed(6)} Y (txs: ${allTxs.length})`
    );

    return {
      success: true,
      position: position_address,
      pool: pool_address,
      bps,
      amount_x_withdrawn: amountXWithdrawn,
      amount_y_withdrawn: amountYWithdrawn,
      fees_claimed: claim_fees ? feesClaimedUsd : undefined,
      txs: allTxs,
    };
  } catch (error: any) {
    log("withdraw_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({
  position_address,
  reason,
}: CloseParams): Promise<CloseResult> {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_close: position_address,
      message: "DRY RUN — no transaction sent",
    };
  }

  const tracked = await getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    deletePoolFromCache(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes: string[] = [];
    const closeTxHashes: string[] = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed =
      tracked?.last_claim_at && Date.now() - new Date(tracked.last_claim_at).getTime() < 60_000;
    try {
      if (recentlyClaimed) {
        log(
          "close",
          `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at!).getTime()) / 1000)}s ago`
        );
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs: Transaction[] = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            // Simulate first to catch errors before spending gas
            const simulation = await getSharedConnection().simulateTransaction(tx, [wallet]);
            if (simulation.value.err) {
              const errorMessage = JSON.stringify(simulation.value.err);
              log("close", `Transaction simulation failed: ${errorMessage}`);
              throw new Error(`Simulation failed: ${errorMessage}`);
            }
            const claimHash = await sendAndConfirmTransaction(getSharedConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e: any) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = (positionDataForClose as { positionData?: { lowerBinId?: number; upperBinId?: number; positionBinData?: unknown[] } })?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN((bin as { positionLiquidity?: string })?.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("close_warn", `Could not check liquidity state: ${message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx: Transaction | Transaction[] = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        // Simulate first to catch errors before spending gas
        const simulation = await getSharedConnection().simulateTransaction(tx, [wallet]);
        if (simulation.value.err) {
          const errorMessage = JSON.stringify(simulation.value.err);
          log("close", `Transaction simulation failed: ${errorMessage}`);
          throw new Error(`Simulation failed: ${errorMessage}`);
        }
        const txHash = await sendAndConfirmTransaction(getSharedConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: Position is empty, forcing close account`);
      const closeTx: Transaction = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      // Simulate first to catch errors before spending gas
      const simulation = await getSharedConnection().simulateTransaction(closeTx, [wallet]);
      if (simulation.value.err) {
        const errorMessage = JSON.stringify(simulation.value.err);
        log("close", `Transaction simulation failed: ${errorMessage}`);
        throw new Error(`Simulation failed: ${errorMessage}`);
      }
      const txHash = await sendAndConfirmTransaction(getSharedConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    recordActivity();
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise((r) => setTimeout(r, 5000));
    await invalidatePositionsCache();

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log(
          "close_warn",
          `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`
        );
      } catch (e: any) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor(
          (Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000
        );
      }

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        const res = await fetchWithRetry(closedUrl);
        if (res.ok) {
          const rawClosedData = await res.json();
          if (!isObject(rawClosedData)) {
            log("close_warn", "Invalid closed positions response: not an object");
          } else {
            const data = rawClosedData as { positions?: any[] };
            const posEntry = (data.positions || []).find(
              (p: any) => p.positionAddress === position_address
            );
            if (posEntry) {
              pnlUsd = Number(posEntry.pnlUsd ?? 0);
              pnlPct = Number(posEntry.pnlPctChange ?? 0);
              finalValueUsd = Number(posEntry.allTimeWithdrawals?.total?.usd ?? 0);
              initialUsd = Number(posEntry.allTimeDeposits?.total?.usd ?? 0);
              feesUsd = Number(posEntry.allTimeFees?.total?.usd ?? 0) || feesUsd;
              log(
                "close",
                `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`
              );
            } else {
              log(
                "close_warn",
                `Position not found in status=closed response — may still be settling`
              );
            }
          }
        }
      } catch (e: any) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = findPositionInCache(position_address);
        if (cachedPos) {
          pnlUsd = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? 0;
          pnlPct = cachedPos.pnl_pct ?? 0;
          feesUsd =
            (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
            pnlPct = (pnlUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: pool.lbPair.tokenXMint.toString(),
        // Additional fields for persistence (recordClose + recordPerformance)
        _recordClose: true,
        close_reason: reason || "agent decision",
        _recordPerformance: true,
        _perf_data: {
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolAddress.slice(0, 8),
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility || null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          base_mint: pool.lbPair.tokenXMint.toString(),
          deployed_at: tracked.deployed_at,
        },
      };
    }

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
      // Flag for middleware to record close even without tracked data
      _recordClose: true,
      close_reason: reason || "agent decision",
    };
  } catch (error: any) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// Tool registrations
registerTool({
  name: "get_active_bin",
  handler: getActiveBin,
  roles: ["SCREENER", "MANAGER", "GENERAL"],
});

registerTool({
  name: "get_position_pnl",
  handler: getPositionPnl,
  roles: ["MANAGER", "GENERAL"],
});

registerTool({
  name: "get_my_positions",
  handler: getMyPositions,
  roles: ["SCREENER", "MANAGER", "GENERAL"],
});

registerTool({
  name: "get_wallet_positions",
  handler: getWalletPositions,
  roles: ["GENERAL"], // Research only — not for agent's own positions
});

registerTool({
  name: "search_pools",
  handler: searchPools,
  roles: ["SCREENER", "GENERAL"],
});

registerTool({
  name: "deploy_position",
  handler: deployPosition,
  roles: ["SCREENER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "close_position",
  handler: closePosition,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "claim_fees",
  handler: claimFees,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "withdraw_liquidity",
  handler: withdrawLiquidity,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});

registerTool({
  name: "add_liquidity",
  handler: addLiquidity,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});
