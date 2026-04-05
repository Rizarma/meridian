/**
 * Dev blocklist types
 */

export interface BlockedDev {
  label: string;
  reason: string;
  added_at: string;
}

export interface DevBlocklistDB {
  [wallet: string]: BlockedDev;
}

/**
 * Token blacklist types
 */

export interface BlacklistEntry {
  symbol: string;
  reason: string;
  added_at: string;
  added_by: string;
}

export interface BlacklistDB {
  [mint: string]: BlacklistEntry;
}
