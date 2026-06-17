import { DateTime } from 'luxon';
import { CONFIG } from './config.js';
import type { DataPoint } from './googleHealth.js';

/**
 * A normalized sample, shaped so the Apple Shortcut can log it directly with no
 * on-device conversion.
 *
 * Field paths below were VERIFIED against the live Google Health API on
 * 2026-06-16 using the user's own account (Fitbit Air + Google Health).
 */
export interface Sample {
  dedupKey: string;
  hkType: string; // HealthKit identifier, or "sleepAnalysis"
  category?: string; // sleep category value, else undefined
  value?: number; // undefined for category samples
  unit?: string;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
  civilDate: string; // YYYY-MM-DD in USER_TZ
  source?: string;
  metadata?: Record<string, unknown>;
}

/** Civil date (YYYY-MM-DD) of an ISO timestamp, in the user's timezone. */
export function civil(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(CONFIG.userTz).toFormat('yyyy-LL-dd');
}

/**
 * Only keep Fitbit-originated data points. The API also returns HEALTH_KIT- and
 * other-sourced points (because the user linked Apple Health INTO Google Health);
 * writing those back into Apple Health would duplicate/loop the user's own data.
 * VERIFIED: each data point carries dataSource.platform ("FITBIT" | "HEALTH_KIT" | ...).
 */
export function isFitbitSourced(dp: DataPoint): boolean {
  return (dp.dataSource?.platform ?? 'FITBIT') === 'FITBIT';
}

/** First defined numeric value among candidate paths. */
function firstNum(...candidates: Array<unknown>): number | undefined {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const n = typeof c === 'string' ? Number(c) : (c as number);
    if (typeof n === 'number' && !Number.isNaN(n)) return n;
  }
  return undefined;
}

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function durationSeconds(duration: unknown): number | undefined {
  if (duration === null || duration === undefined) return undefined;
  if (typeof duration === 'number' && Number.isFinite(duration)) return duration;
  if (typeof duration !== 'string') return undefined;
  const match = duration.trim().match(/^(-?\d+(?:\.\d+)?)s$/);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Convert a Google {date:{year,month,day}} object to YYYY-MM-DD. */
function ymd(date: any): string | undefined {
  if (!date?.year) return undefined;
  return `${date.year}-${String(date.month ?? 1).padStart(2, '0')}-${String(date.day ?? 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Nightly / daily numeric metrics. All VERIFIED 2026-06-16.
// ---------------------------------------------------------------------------

function mkDaily(
  hkType: string,
  unit: string,
  value: number | undefined,
  whenISO: string,
): Sample | null {
  if (value === undefined) return null;
  return {
    dedupKey: `${hkType}|${whenISO}`,
    hkType,
    unit,
    value,
    start: whenISO,
    end: whenISO,
    civilDate: civil(whenISO),
    source: 'fitbit',
  };
}

export function mapDailyHRV(dp: DataPoint, whenISO: string): Sample | null {
  const d = dp.dailyHeartRateVariability ?? {};
  // VERIFIED: nightly average HRV in ms. (Also available: entropy,
  // deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds.)
  const v = firstNum(d.averageHeartRateVariabilityMilliseconds, d.rmssdMilliseconds, d.value);
  return mkDaily('heartRateVariabilitySDNN', 'ms', v, whenISO); // Fitbit HRV → Apple SDNN field (see spec §3/§10)
}

/**
 * Granular intraday HRV sample (~every 5 min during sleep). This is the "all HRV
 * data" source. VERIFIED 2026-06-16:
 *   heartRateVariability.rootMeanSquareOfSuccessiveDifferencesMilliseconds (RMSSD, ms)
 *   heartRateVariability.sampleTime.physicalTime (ISO timestamp)
 * Written into Apple Health's SDNN field at its real timestamp (RMSSD→SDNN caveat, §3).
 */
export function mapHrvSample(dp: DataPoint): Sample | null {
  const h = dp.heartRateVariability ?? {};
  const t: string | undefined = h.sampleTime?.physicalTime;
  const v = firstNum(h.rootMeanSquareOfSuccessiveDifferencesMilliseconds, h.value);
  if (!t || v === undefined) return null;
  return {
    dedupKey: `heartRateVariabilitySDNN|${t}`,
    hkType: 'heartRateVariabilitySDNN',
    unit: 'ms',
    value: v,
    start: t,
    end: t,
    civilDate: civil(t),
    source: 'fitbit',
  };
}

/** Physical (UTC) timestamp of a granular HRV sample, for pagination cutoffs. */
export function hrvSampleTime(dp: DataPoint): string | undefined {
  return dp.heartRateVariability?.sampleTime?.physicalTime;
}

export function mapHeartRateSample(dp: DataPoint): Sample | null {
  const h = dp.heartRate ?? {};
  const t: string | undefined = h.sampleTime?.physicalTime;
  const v = firstNum(h.beatsPerMinute, h.bpm, h.value);
  if (!t || v === undefined) return null;
  return {
    dedupKey: `heartRate|${t}`,
    hkType: 'heartRate',
    unit: 'count/min',
    value: v,
    start: t,
    end: t,
    civilDate: civil(t),
    source: 'fitbit',
    metadata: compactMetadata({
      googleMotionContext: h.metadata?.motionContext,
      googleSensorLocation: h.metadata?.sensorLocation,
    }),
  };
}

/** Physical (UTC) timestamp of a granular heart-rate sample, for pagination cutoffs. */
export function heartRateSampleTime(dp: DataPoint): string | undefined {
  return dp.heartRate?.sampleTime?.physicalTime;
}

export function mapRestingHR(dp: DataPoint, whenISO: string): Sample | null {
  const d = dp.dailyRestingHeartRate ?? {};
  // VERIFIED: beatsPerMinute (string, e.g. "75").
  const v = firstNum(d.beatsPerMinute, d.bpm, d.value);
  return mkDaily('restingHeartRate', 'count/min', v, whenISO);
}

export function mapSpO2(dp: DataPoint, whenISO: string): Sample | null {
  const d = dp.dailyOxygenSaturation ?? {};
  // VERIFIED: averagePercentage (e.g. 96.2). NOTE: Apple Health stores O2 sat as a
  // fraction (0-1); if it appears 100x off after the first write, divide by 100 here.
  const v = firstNum(d.averagePercentage, d.percentage, d.value);
  return mkDaily('oxygenSaturation', '%', v, whenISO);
}

export function mapRespRate(dp: DataPoint, whenISO: string): Sample | null {
  const d = dp.dailyRespiratoryRate ?? {};
  // VERIFIED: data type "daily-respiratory-rate" → dailyRespiratoryRate.breathsPerMinute (e.g. 16.2).
  const v = firstNum(d.breathsPerMinute, d.value);
  return mkDaily('respiratoryRate', 'count/min', v, whenISO);
}

export function mapVO2(dp: DataPoint, whenISO: string): Sample | null {
  const d = dp.dailyVo2Max ?? {};
  // VERIFIED 2026-06-16: dailyVo2Max.vo2Max (e.g. 33.71).
  const v = firstNum(d.vo2Max, d.value);
  return mkDaily('vo2Max', 'mL/min·kg', v, whenISO);
}

/** Civil date of a daily data point (for matching to the night's sleep midpoint). */
export function dailyCivilDate(dp: DataPoint): string | undefined {
  const d =
    dp.dailyHeartRateVariability?.date ??
    dp.dailyRestingHeartRate?.date ??
    dp.dailyOxygenSaturation?.date ??
    dp.dailyRespiratoryRate?.date ??
    dp.dailyVo2Max?.date ??
    dp.date;
  return ymd(d);
}

// ---------------------------------------------------------------------------
// Interval metrics (steps, distance). Fetched via reconcile (see googleHealth.ts).
// VERIFIED 2026-06-16: steps.count + steps.interval.{startTime,endTime};
// distance.millimeters + distance.interval. NOTE: the iPhone already logs steps/
// distance natively — syncing these risks double-counting (gated by SYNC_ACTIVITY).
// ---------------------------------------------------------------------------

export function mapSteps(dp: DataPoint): Sample | null {
  const s = dp.steps?.interval?.startTime;
  const e = dp.steps?.interval?.endTime;
  const v = firstNum(dp.steps?.count);
  if (!s || !e || v === undefined) return null;
  return {
    dedupKey: `stepCount|${s}`,
    hkType: 'stepCount',
    unit: 'count',
    value: v,
    start: s,
    end: e,
    civilDate: civil(s),
    source: 'fitbit',
  };
}

export function mapDistance(dp: DataPoint): Sample | null {
  const s = dp.distance?.interval?.startTime;
  const e = dp.distance?.interval?.endTime;
  // VERIFIED 2026-06-16 (reconcile): distance.millimeters (string, e.g. "25000" = 25 m).
  const mm = firstNum(dp.distance?.millimeters, dp.distance?.lengthMillimeters, dp.distance?.value);
  if (!s || !e || mm === undefined) return null;
  return {
    dedupKey: `distanceWalkingRunning|${s}`,
    hkType: 'distanceWalkingRunning',
    unit: 'm',
    value: mm / 1000,
    start: s,
    end: e,
    civilDate: civil(s),
    source: 'fitbit',
  };
}

export function mapActiveEnergy(dp: DataPoint): Sample | null {
  const s = dp.activeEnergyBurned?.interval?.startTime;
  const e = dp.activeEnergyBurned?.interval?.endTime;
  const v = firstNum(dp.activeEnergyBurned?.kcal, dp.activeEnergyBurned?.caloriesKcal, dp.activeEnergyBurned?.value);
  if (!s || !e || v === undefined) return null;
  return {
    dedupKey: `activeEnergyBurned|${s}`,
    hkType: 'activeEnergyBurned',
    unit: 'kcal',
    value: v,
    start: s,
    end: e,
    civilDate: civil(s),
    source: 'fitbit',
  };
}

export function mapFloors(dp: DataPoint): Sample | null {
  const s = dp.floors?.interval?.startTime;
  const e = dp.floors?.interval?.endTime;
  const v = firstNum(dp.floors?.count);
  if (!s || !e || v === undefined) return null;
  return {
    dedupKey: `flightsClimbed|${s}`,
    hkType: 'flightsClimbed',
    unit: 'count',
    value: v,
    start: s,
    end: e,
    civilDate: civil(s),
    source: 'fitbit',
  };
}

export function mapWorkout(dp: DataPoint): Sample | null {
  const exercise = dp.exercise ?? {};
  const s: string | undefined = exercise.interval?.startTime;
  const e: string | undefined = exercise.interval?.endTime;
  if (!s || !e) return null;

  const summary = exercise.metricsSummary ?? {};
  const distanceMillimeters = firstNum(summary.distanceMillimeters);
  const elevationGainMillimeters = firstNum(summary.elevationGainMillimeters);
  const workoutType = exercise.exerciseType ?? 'OTHER';

  return {
    dedupKey: `workout|${s}|${workoutType}`,
    hkType: 'workout',
    category: workoutType,
    start: s,
    end: e,
    civilDate: civil(s),
    source: 'fitbit',
    metadata: compactMetadata({
      workoutActivityType: workoutType,
      workoutName: exercise.displayName,
      activeDurationSeconds: durationSeconds(exercise.activeDuration),
      totalEnergyBurnedKcal: firstNum(summary.caloriesKcal),
      totalDistanceMeters: distanceMillimeters === undefined ? undefined : distanceMillimeters / 1000,
      averageHeartRateBPM: firstNum(summary.averageHeartRateBeatsPerMinute),
      steps: firstNum(summary.steps),
      activeZoneMinutes: firstNum(summary.activeZoneMinutes),
      elevationGainMeters: elevationGainMillimeters === undefined ? undefined : elevationGainMillimeters / 1000,
    }),
  };
}

// ---------------------------------------------------------------------------
// Sleep — one Sample per session in-bed span plus one Sample per stage segment.
// VERIFIED 2026-06-16:
// sleep.interval.{startTime,endTime} and sleep.stages[].{startTime,endTime,type}
// with type in {AWAKE, LIGHT, DEEP, REM}.
// ---------------------------------------------------------------------------

const STAGE_MAP: Record<string, string> = {
  AWAKE: 'awake',
  WAKE: 'awake',
  RESTLESS: 'awake',
  LIGHT: 'asleepCore',
  DEEP: 'asleepDeep',
  REM: 'asleepREM',
  ASLEEP: 'asleepUnspecified',
};

export function mapSleep(dp: DataPoint): Sample[] {
  const sleep = dp.sleep;
  const stages: any[] = sleep?.stages ?? [];
  const startTime = sleep?.interval?.startTime;
  const endTime = sleep?.interval?.endTime;
  if (!startTime || !endTime) return [];
  const civilD = civil(startTime);
  const inBed: Sample = {
    dedupKey: `sleepAnalysis|${startTime}|IN_BED`,
    hkType: 'sleepAnalysis',
    category: 'inBed',
    start: startTime,
    end: endTime,
    civilDate: civilD,
    source: 'fitbit',
  };

  if (stages.length > 0) {
    const stageSamples = stages
      .filter((st) => STAGE_MAP[st.type])
      .map((st) => ({
        dedupKey: `sleepAnalysis|${st.startTime}|${st.type}`,
        hkType: 'sleepAnalysis',
        category: STAGE_MAP[st.type],
        start: st.startTime,
        end: st.endTime,
        civilDate: civilD,
        source: 'fitbit',
      }));
    return [inBed, ...stageSamples];
  }

  return [
    inBed,
    {
      dedupKey: `sleepAnalysis|${startTime}|ASLEEP`,
      hkType: 'sleepAnalysis',
      category: 'asleepUnspecified',
      start: startTime,
      end: endTime,
      civilDate: civilD,
      source: 'fitbit',
    },
  ];
}

/** Midpoint of a sleep session, used to timestamp nightly metrics realistically. */
export function sleepMidpoint(dp: DataPoint): string | null {
  const s = dp.sleep?.interval?.startTime;
  const e = dp.sleep?.interval?.endTime;
  if (!s || !e) return null;
  const start = DateTime.fromISO(s);
  const end = DateTime.fromISO(e);
  return start.plus({ milliseconds: end.diff(start).milliseconds / 2 }).toUTC().toISO();
}
