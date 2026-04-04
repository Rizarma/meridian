// types/wallet.d.ts

export interface TokenBalance {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  usd_value: number;
}

export interface WalletBalances {
  sol: number;
  sol_usd: number;
  sol_price: number;
  tokens: TokenBalance[];
  total_usd: number;
}

export interface SwapResult {
  success: boolean;
  tx?: string;
  input_amount?: number;
  output_amount?: number;
  error?: string;
}

export interface SwapParams {
  input_mint: string;
  output_mint: string;
  amount: number;
  slippage_bps?: number;
}
