import { getAccessToken } from './oauth.js';
import { CONFIG } from './config.js';

const BASE = 'https://health.googleapis.com/v4/users/me/dataTypes';
const DEFAULT_PAGE_SIZE = 1000;

/**
 * Generic data point shape. The metric-specific payload lives under a key named
 * after the data type (camelCased), e.g. dp.dailyHeartRateVariability, dp.sleep.
 * Every point also has dp.dataSource.platform ("FITBIT" | "HEALTH_KIT" | ...).
 */
export type DataPoint = Record<string, any>;

async function authedGet(url: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Google Health API ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

function dataPointsUrl(kebabType: string, pageToken?: string, pageSize = DEFAULT_PAGE_SIZE): string {
  const params = new URLSearchParams();
  params.set('pageSize', String(pageSize));
  if (pageToken) params.set('pageToken', pageToken);
  return `${BASE}/${kebabType}/dataPoints?${params.toString()}`;
}

function reconcileUrl(kebabType: string, pageToken?: string, pageSize = DEFAULT_PAGE_SIZE): string {
  const params = new URLSearchParams({
    dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
    pageSize: String(pageSize),
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `${BASE}/${kebabType}/dataPoints:reconcile?${params.toString()}`;
}

/**
 * Daily summary types (daily-heart-rate-variability, daily-resting-heart-rate,
 * daily-oxygen-saturation, daily-respiratory-rate, daily-vo2-max).
 *
 * VERIFIED 2026-06-16: `list` returns points newest-first on the first page (dozens
 * of days), so for a personal daily sync we just take the first page and filter by
 * date in sync.ts — no filter expression needed. Follows up to `maxPages` of
 * continuation tokens as a safety margin.
 */
export async function listDaily(kebabType: string, maxPages = 1): Promise<DataPoint[]> {
  const out: DataPoint[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < maxPages) {
    const url = dataPointsUrl(kebabType, pageToken);
    const data: any = await authedGet(url);
    if (CONFIG.debugDump && (data.dataPoints?.length ?? 0) > 0) {
      console.log(`[DEBUG_DUMP] ${kebabType}:`, JSON.stringify(data.dataPoints[0]));
    }
    out.push(...(data.dataPoints ?? []));
    pages += 1;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * High-frequency sample types (e.g. heart-rate-variability — one point every ~5 min).
 * `list` returns points newest-first; we page until a page's oldest point predates
 * the cutoff, so we pull the whole lookback window without over-fetching history.
 */
export async function listSince(
  kebabType: string,
  isOlderThanCutoff: (dp: DataPoint) => boolean,
  maxPages = 30,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<DataPoint[]> {
  const out: DataPoint[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < maxPages) {
    const url = dataPointsUrl(kebabType, pageToken, pageSize);
    const data: any = await authedGet(url);
    const pts: DataPoint[] = data.dataPoints ?? [];
    if (CONFIG.debugDump && pts.length > 0) {
      console.log(`[DEBUG_DUMP] ${kebabType}:`, JSON.stringify(pts[0]));
    }
    if (pts.length === 0) break;
    out.push(...pts);
    pages += 1;
    const oldestOnPage = pts[pts.length - 1];
    if (oldestOnPage && isOlderThanCutoff(oldestOnPage)) break;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Session / interval types (sleep, steps, distance, exercise) — the `list`
 * endpoint returns an empty first page for these, so use `:reconcile`, which
 * returns deduped, tracker-sourced points. VERIFIED 2026-06-16 for sleep.
 */
export async function reconcile(
  kebabType: string,
  isOlderThanCutoff?: (dp: DataPoint) => boolean,
  maxPages = 30,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<DataPoint[]> {
  const out: DataPoint[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < maxPages) {
    const data = await authedGet(reconcileUrl(kebabType, pageToken, pageSize));
    const pts: DataPoint[] = data.dataPoints ?? [];
    if (CONFIG.debugDump && pts.length > 0) {
      console.log(`[DEBUG_DUMP] ${kebabType} (reconcile):`, JSON.stringify(pts[0]));
    }
    if (pts.length === 0) break;
    out.push(...pts);
    pages += 1;
    const oldestOnPage = pts[pts.length - 1];
    if (isOlderThanCutoff && oldestOnPage && isOlderThanCutoff(oldestOnPage)) break;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
