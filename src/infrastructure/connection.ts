import { Connection } from "@solana/web3.js";
import { getRpcUrl } from "../config/config.js";

let _connection: Connection | null = null;

export function getSharedConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getRpcUrl(), "confirmed");
  }
  return _connection;
}

export function resetConnection(): void {
  _connection = null;
}
