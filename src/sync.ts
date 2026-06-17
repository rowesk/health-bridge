import { DateTime } from 'luxon';
import { db } from './db.js';
import { CONFIG } from './config.js';
import { listDaily, listSince, reconcile, type DataPoint } from './googleHealth.js';
import * as M from './mapping.js';

interface SyncResult {
  added: number;
  fetched: number;
  fromDate: string;
}

/**
 * Pull the last LOOKBACK_DAYS of data from the Google Health API, normalize it,
 * and upsert into the samples table. Idempotent (dedup_key PK).
 *
 * HRV strategy ("all HRV data"): pull every granular intraday sample, and use the
 * nightly daily-average only as a fallback for dates that have no granular samples.
 * Only FITBIT-sourced points are kept (HEALTH_KIT points are the user's own Apple
 * data and must not be written back).
 */
export async function runSync(): Promise<SyncResult> {
  const cutoff = DateTime.now().setZone(CONFIG.userTz).minus({ days: CONFIG.lookbackDays }).startOf('day');
  const cutoffDate = cutoff.toFormat('yyyy-LL-dd');
  const recentEnough = (civilDate: string | undefined): boolean => !!civilDate && civilDate >= cutoffDate;
  const olderThanCutoff = (iso: string | undefined): boolean => !!iso && M.civil(iso) < cutoffDate;

  const samples: M.Sample[] = [];

  // 1) Sleep (reconcile) — provides the nightly midpoint used to timestamp daily metrics.
  const midpointByDate = new Map<string, string>();
  try {
    const sleeps = (await reconcile('sleep', (dp) => olderThanCutoff(dp.sleep?.interval?.startTime))).filter(M.isFitbitSourced);
    for (const dp of sleeps) {
      const startTime = dp.sleep?.interval?.startTime;
      if (!startTime) continue;
      const cd = M.civil(startTime);
      if (!recentEnough(cd)) continue;
      const mid = M.sleepMidpoint(dp);
      if (mid) midpointByDate.set(cd, mid);
      samples.push(...M.mapSleep(dp));
    }
  } catch (err) {
    console.error('[sync] sleep failed:', (err as Error).message);
  }
  const midFor = (civilDate: string): string => midpointByDate.get(civilDate) ?? `${civilDate}T06:00:00Z`;

  // 2) HRV — ALL granular intraday samples.
  const hrvCoveredDates = new Set<string>();
  try {
    const points = (
      await listSince('heart-rate-variability', (dp) => {
        const t = M.hrvSampleTime(dp);
        return olderThanCutoff(t);
      })
    ).filter(M.isFitbitSourced);
    for (const dp of points) {
      const s = M.mapHrvSample(dp);
      if (s && recentEnough(s.civilDate)) {
        samples.push(s);
        hrvCoveredDates.add(s.civilDate);
      }
    }
  } catch (err) {
    console.error('[sync] heart-rate-variability failed:', (err as Error).message);
  }

  // 2c) Continuous heart rate — high-volume, but needed by recovery/strain apps.
  if (CONFIG.syncActivity) {
    try {
      const points = (
        await listSince(
          'heart-rate',
          (dp) => {
            const t = M.heartRateSampleTime(dp);
            return olderThanCutoff(t);
          },
          120,
        )
      ).filter(M.isFitbitSourced);
      for (const dp of points) {
        const s = M.mapHeartRateSample(dp);
        if (s && recentEnough(s.civilDate)) samples.push(s);
      }
    } catch (err) {
      console.error('[sync] heart-rate failed:', (err as Error).message);
    }
  }

  // 2b) Daily-average HRV — only for nights with no granular samples (fallback).
  try {
    const points = (await listDaily('daily-heart-rate-variability')).filter(M.isFitbitSourced);
    for (const dp of points) {
      const cd = M.dailyCivilDate(dp);
      if (!recentEnough(cd) || hrvCoveredDates.has(cd as string)) continue;
      const s = M.mapDailyHRV(dp, midFor(cd as string));
      if (s) samples.push(s);
    }
  } catch (err) {
    console.error('[sync] daily-heart-rate-variability failed:', (err as Error).message);
  }

  // 3) Other nightly numeric metrics (list, newest-first).
  const daily: Array<[string, (dp: DataPoint, when: string) => M.Sample | null]> = [
    ['daily-resting-heart-rate', M.mapRestingHR],
    ['daily-oxygen-saturation', M.mapSpO2],
    ['daily-respiratory-rate', M.mapRespRate],
    ['daily-vo2-max', M.mapVO2],
  ];
  for (const [kebab, mapFn] of daily) {
    try {
      const points = (await listDaily(kebab)).filter(M.isFitbitSourced);
      for (const dp of points) {
        const cd = M.dailyCivilDate(dp);
        if (!recentEnough(cd)) continue;
        const s = mapFn(dp, midFor(cd as string));
        if (s) samples.push(s);
      }
    } catch (err) {
      console.error(`[sync] ${kebab} failed:`, (err as Error).message);
    }
  }

  // 4) Activity/cardio sessions (reconcile) — optional because some metrics can
  // duplicate iPhone/Watch data if the owner uses multiple devices.
  if (CONFIG.syncActivity) {
    const intervals: Array<[string, (dp: DataPoint) => M.Sample | null, (dp: DataPoint) => string | undefined, number]> = [
      ['steps', M.mapSteps, (dp) => dp.steps?.interval?.startTime, 120],
      ['distance', M.mapDistance, (dp) => dp.distance?.interval?.startTime, 120],
      ['active-energy-burned', M.mapActiveEnergy, (dp) => dp.activeEnergyBurned?.interval?.startTime, 120],
      ['floors', M.mapFloors, (dp) => dp.floors?.interval?.startTime, 20],
      ['exercise', M.mapWorkout, (dp) => dp.exercise?.interval?.startTime, 20],
    ];
    for (const [kebab, mapFn, startTime, maxPages] of intervals) {
      try {
        const points = (await reconcile(kebab, (dp) => olderThanCutoff(startTime(dp)), maxPages)).filter(M.isFitbitSourced);
        for (const dp of points) {
          const s = mapFn(dp);
          if (s && recentEnough(s.civilDate)) samples.push(s);
        }
      } catch (err) {
        console.error(`[sync] ${kebab} failed:`, (err as Error).message);
      }
    }
  }

  // 5) Upsert.
  const insert = db.prepare(
    `INSERT INTO samples
       (dedup_key, hk_type, category, value, unit, start_time, end_time, civil_date, source, metadata_json, created_at)
     VALUES
       (@dedupKey, @hkType, @category, @value, @unit, @start, @end, @civilDate, @source, @metadataJson, @createdAt)
     ON CONFLICT(dedup_key) DO NOTHING`,
  );
  const insertMany = db.transaction((rows: M.Sample[]) => {
    let added = 0;
    for (const s of rows) {
      const info = insert.run({
        dedupKey: s.dedupKey,
        hkType: s.hkType,
        category: s.category ?? null,
        value: s.value ?? null,
        unit: s.unit ?? null,
        start: s.start,
        end: s.end,
        civilDate: s.civilDate,
        source: s.source ?? null,
        metadataJson: s.metadata ? JSON.stringify(s.metadata) : null,
        createdAt: Date.now(),
      });
      added += info.changes;
    }
    return added;
  });
  const added = insertMany(samples);

  db.prepare(`UPDATE cursors SET last_fetch_date = ? WHERE id = 1`).run(
    DateTime.now().setZone(CONFIG.userTz).toFormat('yyyy-LL-dd'),
  );

  return { added, fetched: samples.length, fromDate: cutoffDate };
}
