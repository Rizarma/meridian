// src/orchestrator/briefing.ts
// Daily briefing scheduling and missed-briefing recovery

import { CYCLE } from "../config/constants.js";
import { generateBriefing } from "../infrastructure/briefing.js";
import { log } from "../infrastructure/logger.js";
import { getLastBriefingDate, setLastBriefingDate } from "../infrastructure/state.js";
import { sendHTML, isEnabled as telegramEnabled } from "../infrastructure/telegram.js";
import { getErrorMessage } from "../utils/errors.js";

async function runBriefing(): Promise<void> {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${getErrorMessage(error)}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
export async function maybeRunMissedBriefing(): Promise<void> {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = await getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = CYCLE.BRIEFING_HOUR_UTC;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

export { runBriefing };
