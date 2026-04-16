/**
 * Threshold Evolution - Suggestion & History Tables
 *
 * Separates analysis, suggestion, and application phases.
 * No direct config mutation - all changes go through approval workflow.
 */

import { get, getDb, query, run, transaction } from "./db.js";
import { log } from "./logger.js";

// ─── Types ─────────────────────────────────────────────────────────

export interface ThresholdSuggestion {
  id?: number;
  field: string;
  currentValue: number;
  suggestedValue: number;
  confidence: number; // 0-100%
  rationale: string;
  sampleSize: number;
  winnerCount: number;
  loserCount: number;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "expired";
  reviewedAt?: string;
  reviewedBy?: string;
  appliedAt?: string;
}

export interface ThresholdHistory {
  id?: number;
  field: string;
  oldValue: number;
  newValue: number;
  rationale: string;
  confidence: number;
  sampleSize: number;
  triggeredBy: string; // suggestion_id or "manual"
  appliedAt: string;
  performanceSnapshot: string; // JSON of relevant performance data
}

// ─── Schema Initialization ─────────────────────────────────────────

export function initThresholdEvolutionTables(): void {
  const db = getDb();

  // Suggestions table - pending approvals
  db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      current_value REAL NOT NULL,
      suggested_value REAL NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
      rationale TEXT NOT NULL,
      sample_size INTEGER NOT NULL,
      winner_count INTEGER NOT NULL,
      loser_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      reviewed_at TEXT,
      reviewed_by TEXT,
      applied_at TEXT
    )
  `);

  // History table - applied changes
  db.exec(`
    CREATE TABLE IF NOT EXISTS threshold_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      old_value REAL NOT NULL,
      new_value REAL NOT NULL,
      rationale TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      sample_size INTEGER NOT NULL,
      triggered_by TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      performance_snapshot TEXT
    )
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON threshold_suggestions(status);
    CREATE INDEX IF NOT EXISTS idx_suggestions_created ON threshold_suggestions(created_at);
    CREATE INDEX IF NOT EXISTS idx_history_field ON threshold_history(field);
    CREATE INDEX IF NOT EXISTS idx_history_applied ON threshold_history(applied_at);
  `);
}

// ─── Suggestion Management ─────────────────────────────────────────

export function saveSuggestion(suggestion: ThresholdSuggestion): number {
  const result = run(
    `INSERT INTO threshold_suggestions 
     (field, current_value, suggested_value, confidence, rationale, sample_size, 
      winner_count, loser_count, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    suggestion.field,
    suggestion.currentValue,
    suggestion.suggestedValue,
    suggestion.confidence,
    suggestion.rationale,
    suggestion.sampleSize,
    suggestion.winnerCount,
    suggestion.loserCount,
    suggestion.createdAt,
    suggestion.status
  );

  log(
    "evolution",
    `New suggestion #${result.lastInsertRowid}: ${suggestion.field} ${suggestion.currentValue} → ${suggestion.suggestedValue} (${suggestion.confidence}% confidence)`
  );
  return Number(result.lastInsertRowid);
}

export function getPendingSuggestions(): ThresholdSuggestion[] {
  const rows = query<{
    id: number;
    field: string;
    current_value: number;
    suggested_value: number;
    confidence: number;
    rationale: string;
    sample_size: number;
    winner_count: number;
    loser_count: number;
    created_at: string;
  }>(
    `SELECT * FROM threshold_suggestions 
     WHERE status = 'pending' 
     ORDER BY confidence DESC, created_at DESC`
  );

  return rows.map(
    (r: {
      id: number;
      field: string;
      current_value: number;
      suggested_value: number;
      confidence: number;
      rationale: string;
      sample_size: number;
      winner_count: number;
      loser_count: number;
      created_at: string;
    }) => ({
      id: r.id,
      field: r.field,
      currentValue: r.current_value,
      suggestedValue: r.suggested_value,
      confidence: r.confidence,
      rationale: r.rationale,
      sampleSize: r.sample_size,
      winnerCount: r.winner_count,
      loserCount: r.loser_count,
      createdAt: r.created_at,
      status: "pending",
    })
  );
}

export function approveSuggestion(
  id: number,
  reviewer: string
): { success: boolean; suggestion?: ThresholdSuggestion; error?: string } {
  const suggestion = get<{
    id: number;
    field: string;
    current_value: number;
    suggested_value: number;
    confidence: number;
    rationale: string;
    sample_size: number;
  }>(`SELECT * FROM threshold_suggestions WHERE id = ? AND status = 'pending'`, id);

  if (!suggestion) {
    return { success: false, error: "Suggestion not found or not pending" };
  }

  const now = new Date().toISOString();

  transaction(() => {
    // Update suggestion status
    run(
      `UPDATE threshold_suggestions 
       SET status = 'approved', reviewed_at = ?, reviewed_by = ?
       WHERE id = ?`,
      now,
      reviewer,
      id
    );

    // Log to history
    run(
      `INSERT INTO threshold_history 
       (field, old_value, new_value, rationale, confidence, sample_size, triggered_by, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      suggestion.field,
      suggestion.current_value,
      suggestion.suggested_value,
      suggestion.rationale,
      suggestion.confidence,
      suggestion.sample_size,
      String(id),
      now
    );
  });

  log("evolution", `Suggestion #${id} approved by ${reviewer} and applied`);

  return {
    success: true,
    suggestion: {
      id: suggestion.id,
      field: suggestion.field,
      currentValue: suggestion.current_value,
      suggestedValue: suggestion.suggested_value,
      confidence: suggestion.confidence,
      rationale: suggestion.rationale,
      sampleSize: suggestion.sample_size,
      winnerCount: 0, // Not stored in DB for approved
      loserCount: 0,
      createdAt: now,
      status: "approved",
      reviewedAt: now,
      reviewedBy: reviewer,
      appliedAt: now,
    },
  };
}

export function rejectSuggestion(
  id: number,
  reviewer: string,
  reason?: string
): { success: boolean; error?: string } {
  const suggestion = get<{ id: number }>(
    `SELECT id FROM threshold_suggestions WHERE id = ? AND status = 'pending'`,
    id
  );

  if (!suggestion) {
    return { success: false, error: "Suggestion not found or not pending" };
  }

  run(
    `UPDATE threshold_suggestions 
     SET status = 'rejected', reviewed_at = ?, reviewed_by = ?
     WHERE id = ?`,
    new Date().toISOString(),
    reviewer,
    id
  );

  log("evolution", `Suggestion #${id} rejected by ${reviewer}${reason ? `: ${reason}` : ""}`);
  return { success: true };
}

// ─── History Queries ─────────────────────────────────────────────────

export function getThresholdHistory(field?: string, limit: number = 20): ThresholdHistory[] {
  let sql = `SELECT * FROM threshold_history`;
  const params: (string | number)[] = [];

  if (field) {
    sql += ` WHERE field = ?`;
    params.push(field);
  }

  sql += ` ORDER BY applied_at DESC LIMIT ?`;
  params.push(limit);

  const rows = query<{
    id: number;
    field: string;
    old_value: number;
    new_value: number;
    rationale: string;
    confidence: number;
    sample_size: number;
    triggered_by: string;
    applied_at: string;
    performance_snapshot: string | null;
  }>(sql, ...params);

  return rows.map(
    (r: {
      id: number;
      field: string;
      old_value: number;
      new_value: number;
      rationale: string;
      confidence: number;
      sample_size: number;
      triggered_by: string;
      applied_at: string;
      performance_snapshot: string | null;
    }) => ({
      id: r.id,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      rationale: r.rationale,
      confidence: r.confidence,
      sampleSize: r.sample_size,
      triggeredBy: r.triggered_by,
      appliedAt: r.applied_at,
      performanceSnapshot: r.performance_snapshot ?? "",
    })
  );
}

export function getCurrentThresholdsWithHistory(): {
  current: Record<string, number>;
  lastEvolved: Record<string, string>;
} {
  // Get current from config (this would import from config)
  const current = {
    maxVolatility: 10,
    minFeeActiveTvlRatio: 0.5,
    minOrganic: 75,
  };

  // Get last evolved dates
  const rows = query<{ field: string; applied_at: string }>(
    `SELECT field, MAX(applied_at) as applied_at 
     FROM threshold_history 
     GROUP BY field`
  );

  const lastEvolved: Record<string, string> = {};
  for (const row of rows) {
    lastEvolved[row.field] = row.applied_at;
  }

  return { current, lastEvolved };
}

// ─── Auto-Expire Old Suggestions ───────────────────────────────────

export function expireOldSuggestions(days: number = 7): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const result = run(
    `UPDATE threshold_suggestions 
     SET status = 'expired'
     WHERE status = 'pending' AND created_at < ?`,
    cutoff.toISOString()
  );

  if (result.changes > 0) {
    log("evolution", `Expired ${result.changes} old threshold suggestions`);
  }

  return result.changes;
}
