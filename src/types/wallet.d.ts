// types/wallet.d.ts

export interface TokenBalance {
  mint: string;
  symbol: string;
  amount?: number;
  decimals?: number;
  usd_value?: number;
  balance?: number;
  usd?: number | null;
}

export interface WalletBalances {
  wallet: string | null;
  sol: number;
  sol_usd: number;
  sol_price: number;
  usdc?: number;
  tokens: TokenBalance[];
  total_usd: number;
  error?: string;
}

export interface SwapResult {
  success: boolean;
  tx?: string;
  input_amount?: number;
  output_amount?: number;
  input_mint?: string;
  output_mint?: string;
  amount_in?: string;
  amount_out?: string;
  error?: string;
  dry_run?: boolean;
  would_swap?: {
    input_mint: string;
    output_mint: string;
    amount: number;
  };
  message?: string;
}

export interface SwapParams {
  input_mint: string;
  output_mint: string;
  amount: number;
  slippage_bps?: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}

export interface JupiterUltraOrder {
  transaction: string;
  requestId: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface JupiterUltraExecute {
  status: string;
  signature?: string;
  code?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

export interface HeliusBalanceEntry {
  mint: string;
  symbol: string;
  balance: number;
  pricePerToken?: number;
  usdValue?: number;
}

export interface HeliusBalancesResponse {
  balances: HeliusBalanceEntry[];
  totalUsdValue?: number;
}
