// tools/dlmm/transactions.ts
// Core simulate-then-send transaction safety primitive
//
// CRITICAL SAFETY INVARIANT: No transaction is ever sent unless simulation
// succeeded first. This is the single enforcement point for that invariant.

import { type Connection, type Keypair, sendAndConfirmTransaction, type Transaction } from "@solana/web3.js";
import { log } from "../../src/infrastructure/logger.js";

// ─── Types ─────────────────────────────────────────────────────

/** Result of a simulation-only check (dry-run / pre-flight) */
export interface SimulationResult {
  /** Whether the simulation succeeded (no errors) */
  success: boolean;
  /** Serialized Solana error details if simulation failed */
  error?: string;
}

/** Result of a simulate-then-send operation */
export interface TransactionResult {
  /** Transaction signature (present when successfully sent) */
  signature?: string;
  /** Whether the full operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Simulation error details if simulation failed */
  simulationError?: string;
}

// ─── Audit Logging ────────────────────────────────────────────

interface AuditEntry {
  readonly timestamp: string;
  readonly action: "simulate" | "send" | "simulate_failed";
  readonly label: string;
  readonly success: boolean;
  readonly error?: string;
  readonly signature?: string;
}

/**
 * Transaction audit log — keeps the last N entries for diagnostics.
 * Entries are logged at debug level and retained in memory for health checks.
 */
const AUDIT_LOG_MAX = 200;
const auditLog: AuditEntry[] = [];

function audit(entry: Omit<AuditEntry, "timestamp">): void {
  const full: AuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(full);
  if (auditLog.length > AUDIT_LOG_MAX) {
    auditLog.shift();
  }
}

/** Retrieve recent audit entries for health checks / diagnostics */
export function getTransactionAuditLog(): readonly AuditEntry[] {
  return auditLog;
}

// ─── Simulation ───────────────────────────────────────────────

/**
 * Simulate a transaction without sending it.
 * Useful for dry-run mode and pre-flight checks.
 *
 * @param connection - Solana RPC connection
 * @param transaction - Transaction to simulate
 * @param signers - Signers for the transaction
 * @param label - Label for logging context (e.g. "deploy", "claim")
 */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  label: string = "tx"
): Promise<SimulationResult> {
  audit({ action: "simulate", label, success: true });
  try {
    const simulation = await connection.simulateTransaction(transaction, signers);
    if (simulation.value.err) {
      const errorMessage = JSON.stringify(simulation.value.err);
      audit({ action: "simulate_failed", label, success: false, error: errorMessage });
      return { success: false, error: errorMessage };
    }
    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    audit({ action: "simulate_failed", label, success: false, error: message });
    return { success: false, error: message };
  }
}

// ─── Simulate-Then-Send Primitive ─────────────────────────────

/**
 * Core safety primitive: simulate a transaction, then send it only if
 * simulation succeeds.
 *
 * INVARIANT: sendAndConfirmTransaction is NEVER called unless simulation
 * returned no errors. If simulation fails, throws with full Solana error
 * details preserved in the message.
 *
 * @param connection - Solana RPC connection
 * @param transaction - Transaction to simulate and send
 * @param signers - Signers for the transaction
 * @param label - Label for logging context (e.g. "deploy", "claim")
 * @returns Transaction signature
 * @throws Error if simulation fails (with Solana error details) or if send fails
 */
export async function simulateAndSend(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  label: string = "tx"
): Promise<string> {
  // SAFETY: Simulate FIRST — never skip this check
  const simulation = await connection.simulateTransaction(transaction, signers);
  if (simulation.value.err) {
    const errorMessage = JSON.stringify(simulation.value.err);
    log(label, `Transaction simulation failed: ${errorMessage}`);
    audit({ action: "simulate_failed", label, success: false, error: errorMessage });
    throw new Error(`Simulation failed: ${errorMessage}`);
  }

  audit({ action: "simulate", label, success: true });

  // Only reached when simulation succeeded — safe to send
  const signature = await sendAndConfirmTransaction(connection, transaction, signers);
  audit({ action: "send", label, success: true, signature });
  return signature;
}

/**
 * Process an array of transactions with the simulate-then-send safety pattern.
 * Each transaction is individually simulated before sending.
 * Stops processing and throws on the first simulation failure.
 *
 * @param connection - Solana RPC connection
 * @param transactions - Array of transactions to process
 * @param signers - Signers for each transaction
 * @param label - Label for logging context
 * @returns Array of transaction signatures
 */
export async function simulateAndSendMany(
  connection: Connection,
  transactions: Transaction[],
  signers: Keypair[],
  label: string = "tx"
): Promise<string[]> {
  const signatures: string[] = [];
  for (let i = 0; i < transactions.length; i++) {
    const sig = await simulateAndSend(connection, transactions[i], signers, label);
    signatures.push(sig);
    log(label, `Transaction ${i + 1}/${transactions.length}: ${sig}`);
  }
  return signatures;
}
