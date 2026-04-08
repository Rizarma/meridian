import { Connection } from "@solana/web3.js";
import { getRpcUrl } from "../config/config.js";
import { log } from "./logger.js";

let _connection: Connection | null = null;

// Circuit breaker state
const CIRCUIT_BREAKER_THRESHOLD = 5; // Failures before opening
const CIRCUIT_BREAKER_TIMEOUT_MS = 30000; // 30 seconds before retry
let _consecutiveFailures = 0;
let _circuitOpen = false;
let _circuitOpenedAt: number | null = null;

export function getSharedConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getRpcUrl(), "confirmed");
  }
  return _connection;
}

export function resetConnection(): void {
  _connection = null;
}

/**
 * Check if circuit breaker is open (RPC considered down)
 */
export function isCircuitOpen(): boolean {
  if (!_circuitOpen) return false;

  // Check if we should try closing the circuit
  if (_circuitOpenedAt && Date.now() - _circuitOpenedAt > CIRCUIT_BREAKER_TIMEOUT_MS) {
    log("circuit_breaker", "Circuit breaker timeout elapsed - attempting reset");
    _circuitOpen = false;
    _consecutiveFailures = 0;
    _circuitOpenedAt = null;
    resetConnection(); // Get fresh connection
    return false;
  }

  return true;
}

/**
 * Record a successful RPC call
 */
export function recordRpcSuccess(): void {
  if (_consecutiveFailures > 0) {
    _consecutiveFailures = 0;
    log("circuit_breaker", "RPC calls succeeding - resetting failure count");
  }
}

/**
 * Record a failed RPC call
 */
export function recordRpcFailure(error: unknown): void {
  _consecutiveFailures++;

  if (_consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitOpen = true;
    _circuitOpenedAt = Date.now();
    log(
      "circuit_breaker",
      `Circuit breaker OPENED after ${_consecutiveFailures} consecutive failures: ${error}`
    );
  }
}

/**
 * Wrap an RPC call with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  _operationName: string
): Promise<T> {
  if (isCircuitOpen()) {
    throw new Error(
      `Circuit breaker is OPEN - RPC calls temporarily disabled (${CIRCUIT_BREAKER_TIMEOUT_MS}ms cooldown)`
    );
  }

  try {
    const result = await operation();
    recordRpcSuccess();
    return result;
  } catch (error) {
    recordRpcFailure(error);
    throw error;
  }
}
