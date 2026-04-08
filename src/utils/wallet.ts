/**
 * Shared wallet utilities for lazy initialization and validation.
 * Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
 * (e.g. during screening-only tests).
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../infrastructure/logger.js";
import { getErrorMessage } from "./errors.js";

let _wallet: Keypair | null = null;

// Base58 validation regex (Solana keys are base58, typically 88 chars for 64-byte secret)
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MIN_SECRET_KEY_LENGTH = 64; // 64 bytes = 88 base58 chars typically

/**
 * Validates the wallet private key from environment variable.
 * @param key - The wallet private key string (typically from process.env.WALLET_PRIVATE_KEY)
 * @returns The trimmed, validated key string
 * @throws Error if key is missing, empty, contains invalid characters, or has wrong length
 */
export function validateWalletKey(key: string | undefined): string {
  if (!key || key.trim() === "") {
    throw new Error("WALLET_PRIVATE_KEY not set (env var is missing or empty)");
  }
  const trimmed = key.trim();
  if (!BASE58_REGEX.test(trimmed)) {
    throw new Error("WALLET_PRIVATE_KEY contains invalid characters (not valid base58)");
  }
  // Try decoding to validate length
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length < MIN_SECRET_KEY_LENGTH) {
      throw new Error(
        `WALLET_PRIVATE_KEY decoded to ${decoded.length} bytes, expected at least ${MIN_SECRET_KEY_LENGTH}`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("WALLET_PRIVATE_KEY")) throw e;
    throw new Error(`WALLET_PRIVATE_KEY is not valid base58: ${getErrorMessage(e)}`);
  }
  return trimmed;
}

/**
 * Gets or initializes the wallet Keypair from environment variable.
 * Lazy-initialized on first call to avoid crashing during module import.
 * Only logs initialization in non-TTY mode to avoid disrupting REPL formatted output.
 * @returns The initialized Keypair
 * @throws Error if WALLET_PRIVATE_KEY is not set or invalid
 */
export function getWallet(): Keypair {
  if (!_wallet) {
    const validKey = validateWalletKey(process.env.WALLET_PRIVATE_KEY);
    _wallet = Keypair.fromSecretKey(bs58.decode(validKey));
    // Only log in non-TTY mode to avoid disrupting REPL formatted output
    if (!process.stdin.isTTY) {
      log("init", `Wallet: ${_wallet.publicKey.toString()}`);
    }
  }
  return _wallet;
}
