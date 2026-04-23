import type { ExportData, LessonExport, PerformanceExport, PoolExport, PositionEventExport } from "./types.js";

export function deduplicate(data: ExportData): ExportData {
  return {
    ...data,
    pools: dedupPools(data.pools),
    lessons: dedupLessons(data.lessons),
    performance: dedupPerformance(data.performance),
    positionEvents: dedupPositionEvents(data.positionEvents),
    positions: data.positions,
    positionSnapshots: data.positionSnapshots,
    signalWeights: mergeSignalWeights(data.signalWeights),
    poolDeploys: data.poolDeploys,
    exportedAt: data.exportedAt,
    source: data.source,
  };
}

function dedupPools(pools: PoolExport[]): PoolExport[] {
  const map = new Map<string, PoolExport>();

  for (const pool of pools) {
    const existing = map.get(pool.address);
    if (existing) {
      const keepExisting =
        (existing.total_deploys || 0) > (pool.total_deploys || 0) ||
        (existing.updated_at || "") > (pool.updated_at || "");

      if (!keepExisting) {
        map.set(pool.address, pool);
      }
    } else {
      map.set(pool.address, pool);
    }
  }

  return Array.from(map.values());
}

function dedupLessons(lessons: LessonExport[]): LessonExport[] {
  const map = new Map<string, LessonExport>();

  for (const lesson of lessons) {
    const key = `${lesson.pool || "global"}:${lesson.rule}`;
    const existing = map.get(key);

    if (existing) {
      const existingScore = (existing.pnl_pct !== null ? 1 : 0) + (existing.context ? 1 : 0);
      const newScore = (lesson.pnl_pct !== null ? 1 : 0) + (lesson.context ? 1 : 0);

      if (newScore > existingScore || lesson.created_at > existing.created_at) {
        map.set(key, lesson);
      }
    } else {
      map.set(key, lesson);
    }
  }

  return Array.from(map.values());
}

function dedupPerformance(performance: PerformanceExport[]): PerformanceExport[] {
  const map = new Map<string, PerformanceExport>();

  for (const record of performance) {
    const existing = map.get(record.position);
    if (!existing || record.recorded_at > existing.recorded_at) {
      map.set(record.position, record);
    }
  }

  return Array.from(map.values());
}

function dedupPositionEvents(events: PositionEventExport[]): PositionEventExport[] {
  const map = new Map<string, PositionEventExport>();

  for (const event of events) {
    const key = `${event.position_address}:${event.event_type}:${event.ts}`;
    if (!map.has(key)) {
      map.set(key, event);
    }
  }

  return Array.from(map.values());
}

function mergeSignalWeights(weights: ExportData["signalWeights"]): ExportData["signalWeights"] {
  const map = new Map<string, ExportData["signalWeights"][0]>();

  for (const weight of weights) {
    const existing = map.get(weight.signal);
    if (!existing || weight.updated_at > existing.updated_at) {
      map.set(weight.signal, weight);
    }
  }

  return Array.from(map.values());
}
