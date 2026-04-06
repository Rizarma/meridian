import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config, getRpcUrl } from "../src/config/config.js";
import { log } from "../src/infrastructure/logger.js";
import { registerTool } from "./registry.js";

// Type imports from types/wallet.d.ts
interface WalletBalance {
  mint: string;
  symbol: string;
  balance: number;
  usd: number | null;
}

interface WalletBalances {
  wallet: string | null;
  sol: number;
  sol_price: number;
  sol_usd: number;
  usdc: number;
  tokens: WalletBalance[];
  total_usd: number;
  error?: string;
}

interface SwapResult {
  success?: boolean;
  tx?: string;
  input_mint?: string;
  output_mint?: string;
  amount_in?: string;
  amount_out?: string;
  error?: string;
  dry_run?: boolean;
  would_swap?: { input_mint: string; output_mint: string; amount: number };
  message?: string;
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}

interface JupiterUltraOrder {
  transaction: string;
  requestId: string;
  errorCode?: string;
  errorMessage?: string;
}

interface JupiterUltraExecute {
  status: string;
  signature?: string;
  code?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

interface HeliusBalanceEntry {
  mint: string;
  symbol: string;
  balance: number;
  pricePerToken?: number;
  usdValue?: number;
}

interface HeliusBalancesResponse {
  balances: HeliusBalanceEntry[];
  totalUsdValue?: number;
}

// Internal interface for swapViaQuoteApi parameters
interface SwapViaQuoteParams {
  wallet: Keypair;
  connection: Connection;
  input_mint: string;
  output_mint: string;
  amountStr: string;
}

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

function getConnection(): Connection {
  if (!_connection) _connection = new Connection(getRpcUrl(), "confirmed");
  return _connection;
}

function getWallet(): Keypair {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API: string = "https://api.jup.ag/price/v3";
const JUPITER_ULTRA_API: string = "https://api.jup.ag/ultra/v1";
const JUPITER_QUOTE_API: string = "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY: string = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances(): Promise<WalletBalances> {
  let walletAddress: string | null;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return {
      wallet: null,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: "Wallet not configured",
    };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: "Helius API key missing",
    };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as HeliusBalancesResponse;
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find((b) => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find((b) => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens: WalletBalance[] = balances.map((b) => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("wallet_error", errorMessage);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: errorMessage,
    };
  }
}

/**
 * Swap tokens via Jupiter Ultra API (order → sign → execute).
 */
const SOL_MINT: string = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint: string): string {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" ||
    mint === "native" ||
    /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}: {
  input_mint: string;
  output_mint: string;
  amount: number;
}): Promise<SwapResult> {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals =
        (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info
          ?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Ultra order (unsigned tx + requestId) ─────────────
    const orderUrl =
      `${JUPITER_ULTRA_API}/order` +
      `?inputMint=${input_mint}` +
      `&outputMint=${output_mint}` +
      `&amount=${amountStr}` +
      `&taker=${wallet.publicKey.toString()}`;

    const orderRes = await fetch(orderUrl, {
      headers: { "x-api-key": JUPITER_API_KEY },
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      if (orderRes.status === 500) {
        log("swap", `Ultra failed for ${input_mint}, falling back to regular swap API`);
        return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr });
      }
      throw new Error(`Ultra order failed: ${orderRes.status} ${body}`);
    }

    const order = (await orderRes.json()) as JupiterUltraOrder;
    if (order.errorCode || order.errorMessage) {
      log("swap", `Ultra error for ${input_mint}, falling back to regular swap API`);
      return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr });
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_ULTRA_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JUPITER_API_KEY,
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Ultra execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = (await execRes.json()) as JupiterUltraExecute;
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("swap_error", errorMessage);
    return { success: false, error: errorMessage };
  }
}

async function swapViaQuoteApi({
  wallet,
  connection,
  input_mint,
  output_mint,
  amountStr,
}: SwapViaQuoteParams): Promise<SwapResult> {
  // ─── Get quote ─────────────────────────────────────────────
  const quoteRes = await fetch(
    `${JUPITER_QUOTE_API}/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}&slippageBps=300`,
    { headers: { "x-api-key": JUPITER_API_KEY } }
  );
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = (await quoteRes.json()) as JupiterQuote;
  if ((quote as unknown as { error?: string }).error)
    throw new Error(`Quote error: ${(quote as unknown as { error?: string }).error}`);

  // ─── Get swap tx ───────────────────────────────────────────
  const swapRes = await fetch(`${JUPITER_QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": JUPITER_API_KEY },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap tx failed: ${swapRes.status} ${await swapRes.text()}`);
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

  // ─── Sign and send ─────────────────────────────────────────
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(txHash, "confirmed");

  log("swap", `SUCCESS (fallback) tx: ${txHash}`);
  return { success: true, tx: txHash, input_mint, output_mint };
}

// Tool registrations
registerTool({
  name: "get_wallet_balance",
  handler: getWalletBalances,
  roles: ["SCREENER", "MANAGER", "GENERAL"],
});

registerTool({
  name: "swap_token",
  handler: swapToken,
  roles: ["MANAGER", "GENERAL"],
  isWriteTool: true,
});
