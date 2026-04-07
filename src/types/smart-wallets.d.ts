// types/smart-wallets.d.ts
// Smart wallet tracking types for KOL/alpha wallets

export type WalletCategory = "alpha" | "kol" | "whale" | "smart";
export type WalletType = "lp" | "holder";

export interface SmartWallet {
  name: string;
  address: string;
  category: WalletCategory;
  type: WalletType;
  addedAt: string;
}

export interface SmartWalletDB {
  wallets: SmartWallet[];
}

export interface AddSmartWalletInput {
  name: string;
  address: string;
  category?: WalletCategory;
  type?: WalletType;
}

export interface RemoveSmartWalletInput {
  address: string;
}

export interface SmartWalletResult {
  success: boolean;
  wallet?: SmartWallet;
  error?: string;
  removed?: string;
}

export interface SmartWalletList {
  total: number;
  wallets: SmartWallet[];
}

export interface WalletInPool {
  name: string;
  category: WalletCategory;
  address: string;
}

export interface CheckSmartWalletsInput {
  pool_address: string;
}

export interface WalletPositionCheck {
  pool: string;
  tracked_wallets: number;
  in_pool: WalletInPool[];
  confidence_boost: boolean;
  signal: string;
}

export interface CachedWalletPositions {
  positions: unknown[];
  fetchedAt: number;
}
