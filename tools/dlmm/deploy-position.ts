// tools/dlmm/deploy-position.ts
// Deploy a new LP position into a Meteora DLMM pool
// Extracted from tools/dlmm.ts (Phase F)

import { Keypair, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../../src/domain/pool-memory.js";
import { getSharedConnection } from "../../src/infrastructure/connection.js";
import { log } from "../../src/infrastructure/logger.js";
import type { DeployParams, DeployResult } from "../../src/types/dlmm.js";
import { recordActivity } from "../../src/utils/health-check.js";
import { getWallet } from "../../src/utils/wallet.js";
import { normalizeMint } from "../wallet.js";
import { simulateAndSend } from "./transactions.js";
import { getPool } from "./pool-cache.js";
import { invalidatePositionsCache } from "./positions-cache.js";
import { toLamports, fetchTokenDecimals } from "./token-amounts.js";
import { resolveStrategy, calculateBinRange, isWideRange } from "./strategy.js";

// Default slippage in basis points (1000 bps = 10%)
const DEFAULT_SLIPPAGE_BPS = 1000;

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
  const { minBinId, maxBinId } = calculateBinRange(
    activeBin.binId,
    activeBinsBelow,
    activeBinsAbove
  );

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
