import { getInfrastructure } from "../di-container.js";
import { getPerformanceSummary } from "../domain/lessons.js";
import type {
  LessonEntry,
  PerformanceEntry,
  PerformanceSummary,
  StatePosition,
} from "../types/briefing.js";
import { log } from "./logger.js";

const infra = () => getInfrastructure();

export async function generateBriefing(): Promise<string> {
  try {
    // 1. Positions Activity (last 24h)
    // Use ISO format for comparison since dates are stored as ISO 8601 strings
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const openedLast24h = await infra().db.query<StatePosition>(
      "SELECT * FROM positions WHERE deployed_at > ?",
      [cutoff24h]
    );
    const closedLast24h = await infra().db.query<StatePosition>(
      "SELECT * FROM positions WHERE closed = 1 AND closed_at > ?",
      [cutoff24h]
    );
    const openPositions = await infra().db.query<StatePosition>(
      "SELECT * FROM positions WHERE closed = 0"
    );

    // 2. Performance Activity (last 24h)
    const perfLast24h = await infra().db.query<PerformanceEntry>(
      "SELECT * FROM performance WHERE recorded_at > ?",
      [cutoff24h]
    );
    const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
    const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

    // 3. Lessons Learned (last 24h)
    const lessonsLast24h = await infra().db.query<LessonEntry>(
      "SELECT * FROM lessons WHERE created_at > ?",
      [cutoff24h]
    );

    // 4. Current State
    const perfSummary: PerformanceSummary | null = await getPerformanceSummary();

    // 5. Format Message
    const lines: string[] = [
      "☀️ <b>Morning Briefing</b> (Last 24h)",
      "────────────────",
      `<b>Activity:</b>`,
      `📥 Positions Opened: ${openedLast24h.length}`,
      `📤 Positions Closed: ${closedLast24h.length}`,
      "",
      `<b>Performance:</b>`,
      `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
      `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
      perfLast24h.length > 0
        ? `📈 Win Rate (24h): ${Math.round(
            (perfLast24h.filter((p) => (p.pnl_usd || 0) > 0).length / perfLast24h.length) * 100
          )}%`
        : "📈 Win Rate (24h): N/A",
      "",
      `<b>Lessons Learned:</b>`,
      lessonsLast24h.length > 0
        ? lessonsLast24h.map((l) => `• ${l.rule}`).join("\n")
        : "• No new lessons recorded overnight.",
      "",
      `<b>Current Portfolio:</b>`,
      `📂 Open Positions: ${openPositions.length}`,
      perfSummary
        ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
        : "",
      "────────────────",
    ];

    return lines.join("\n");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("briefing_error", `Failed to generate briefing: ${errorMsg}`);
    return "⚠️ <b>Briefing Unavailable</b>\n\nDatabase error occurred. Please try again later.";
  }
}
