import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../src/config/config.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../src/domain/pool-memory.js";
import { getSharedConnection } from "../src/infrastructure/connection.js";
import { log } from "../src/infrastructure/logger.js";
import { getTrackedPosition } from "../src/infrastructure/state.js";
import type {
  AddLiquidityParams,
  AddLiquidityResult,
  ClaimParams,
  ClaimResult,
  CloseParams,
  CloseResult,
  DeployParams,
  DeployResult,
  WithdrawLiquidityParams,
  WithdrawLiquidityResult,
} from "../src/types/dlmm.js";
import { recordActivity } from "../src/utils/health-check.js";
import { fetchWithRetry } from "../src/utils/retry.js";
import { isObject } from "../src/utils/validation.js";
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
  invalidatePositionsCache,
  findPositionInCache,
  // PnL API
  fetchDlmmPnlForPool,
  fetchClosedPnlForPool,
  deriveOpenPnlPct,
  // Position SDK
  lookupPoolForPosition,
  // Transaction safety
  simulateAndSend,
  simulateAndSendMany,
} from "./dlmm/index.js";

// Phase D: Read-only tools (extracted to dedicated modules)
import { getActiveBin } from "./dlmm/active-bin.js";
import { searchPools } from "./dlmm/search-pools.js";
import { getPositionPnl, getMyPositions, getWalletPositions } from "./dlmm/positions.js";

// Default slippage in basis points (1000 bps = 10%)
const DEFAULT_SLIPPAGE_BPS = 1000;

// Re-export from modules for backward compatibility
export {
  stopPoolCache,
  clearPoolCache,
  deletePoolFromCache,
  invalidatePositionsCache,
  deriveOpenPnlPct,
  fetchDlmmPnlForPool,
  lookupPoolForPosition,
  simulateAndSend,
  simulateAndSendMany,
  // Phase D: Read-only tools
  getActiveBin,
  searchPools,
  getPositionPnl,
  getMyPositions,
  getWalletPositions,
} from "./dlmm/index.js";

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
        const txHash = await simulateAndSend(
          getSharedConnection(),
          createTxArray[i],
          signers,
          "deploy"
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
        const txHash = await simulateAndSend(
          getSharedConnection(),
          addTxArray[i],
          [wallet],
          "deploy"
        );
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
      // Simulate and send via safety primitive
      const txHash = await simulateAndSend(
        getSharedConnection(),
        tx,
        [wallet, newPosition],
        "deploy"
      );
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
        const txHash = await simulateAndSend(
          getSharedConnection(),
          addTxArray[i],
          [wallet],
          "add_liquidity"
        );
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
      // Simulate and send via safety primitive
      const txHash = await simulateAndSend(
        getSharedConnection(),
        addTx,
        [wallet],
        "add_liquidity"
      );
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
      const txHash = await simulateAndSend(
        getSharedConnection(),
        tx,
        [wallet],
        "claim"
      );
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
              const claimHash = await simulateAndSend(
                getSharedConnection(),
                tx,
                [wallet],
                "withdraw"
              );
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
      const txHash = await simulateAndSend(
        getSharedConnection(),
        tx,
        [wallet],
        "withdraw"
      );
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
              const claimHash = await simulateAndSend(
                getSharedConnection(),
                tx,
                [wallet],
                "close"
              );
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
        const txHash = await simulateAndSend(
          getSharedConnection(),
          tx,
          [wallet],
          "close"
        );
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: Position is empty, forcing close account`);
      const closeTx: Transaction = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      // Simulate and send via safety primitive
      const txHash = await simulateAndSend(
        getSharedConnection(),
        closeTx,
        [wallet],
        "close"
      );
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
