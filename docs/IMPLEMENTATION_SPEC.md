# Health Bridge — Implementation Spec

**What it does:** pulls Fitbit Air data (incl. HRV) from the **Google Health API** into a tiny backend on your Dokploy/Hetzner server, then an **Apple Shortcut** on your iPhone pulls a clean JSON feed from that backend and writes every metric into **Apple Health**, where **Bevel** reads it.

**Audience:** a junior developer. Everything needed to implement is here. Where a Google Health API response field can't be 100% guaranteed from docs, it's flagged **[VERIFY]** with the reference to confirm against.

**Stack:** Node 20 + TypeScript + Fastify + better-sqlite3, in Docker, deployed on Dokploy. Apple Shortcut on iOS 17+.

---

## 1. Architecture

```
            ┌──────────────────────────── Hetzner / Dokploy ───────────────────────────┐
            │                                                                            │
 Fitbit Air │   ┌─────────────────────────  health-bridge (Docker)  ─────────────────┐  │
   │ BLE     │   │                                                                    │  │
   ▼         │   │  Scheduler (cron, hourly)                                           │  │
 Google      │   │     └─ refresh access token → pull Google Health API (recent days)│  │
 Health app  │   │        → normalize → upsert into SQLite (samples)                 │  │
   │ cloud   │   │                                                                    │  │
   ▼         │   │  HTTP API (Fastify, behind Traefik HTTPS):                         │  │
 Google ─────┼───┼──►  /auth/start, /auth/callback   (one-time OAuth bootstrap)       │  │
 Health API  │   │     GET  /export   (Bearer SHORTCUT_TOKEN) → unsynced samples JSON │  │
 (OAuth/REST)│   │     POST /ack      (mark exported samples acknowledged)             │  │
            │   │     POST /webhooks/google-health  (future: sleep push)             │  │
            │   │     GET  /healthz  (liveness)                                       │  │
            │   │  SQLite (Docker volume): oauth, samples, cursors                    │  │
            │   └────────────────────────────────────────────────────────────────────┘  │
            └────────────────────────────────────────────────────────────────────────────┘
                                          ▲  HTTPS GET /export + POST /ack
                                          │  (Bearer SHORTCUT_TOKEN)
                          ┌───────────────┴───────────────┐
                          │   iPhone — Apple Shortcut       │
                          │   (daily Automation)            │
                          │   loop samples → Log Health     │
                          │   Sample (value, unit, dates)   │
                          └───────────────┬─────────────────┘
                                          ▼
                                   Apple Health  ──►  Bevel
```

**Why this split:** the backend owns OAuth + Google API + normalization + dedup, so the Shortcut stays dumb (fetch JSON, loop, log). The scheduler pre-caches data so the phone's request is instant and resilient to Google API hiccups.

---

## 2. Prerequisites

- A Google account that owns the Fitbit Air (account already migrated to Google).
- The Google Health app installed on the iPhone and syncing the Air (the backend can only read what Google's cloud has).
- A domain/subdomain pointed at the Dokploy server, e.g. `health-bridge.yourdomain.com` (Dokploy + Traefik will issue HTTPS automatically).
- Dokploy access on the Hetzner box.
- iPhone on iOS 17 or later.

---

## 3. Part A — Google Cloud & OAuth setup (one-time, ~20 min)

Reference: `https://developers.google.com/health/setup`

1. **Create/Select a Google Cloud project** at `console.cloud.google.com`.
2. **Enable the Google Health API**: APIs & Services → Library → search "Google Health API" → Enable. (Direct: `https://console.developers.google.com/apis/library/health.googleapis.com`.)
3. **OAuth consent screen** (APIs & Services → OAuth consent / "Audience"):
   - User type: **External**.
   - Fill app name, support email, developer email.
   - **Publishing status: set to "In production"** (click **Publish app**). This is important — production status gives **non-expiring refresh tokens**. Testing status expires them every 7 days.
   - You can remain **unverified**: unverified clients support **up to 100 users**, which is plenty for one person. (A "Google hasn't verified this app" screen may appear at consent — click *Advanced → Go to {app} (unsafe)* to proceed. Verification/security review is only required beyond 100 users.) **[VERIFY]** that the health scopes let you click through unverified; if Google hard-blocks them, you'd need verification — see §10.
   - Add your own Google account under **Test users** as well (covers both states).
4. **Add scopes** (Data Access page → Add or remove scopes → filter "Google Health API"). Select the **read-only** bundles we need:
   - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` (HRV, heart rate, resting HR, SpO2, respiratory rate, weight, body fat, temperature)
   - `https://www.googleapis.com/auth/googlehealth.sleep.readonly` (sleep + stages)
   - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` (steps, distance, floors, exercise, VO2 max, active energy)
5. **Create OAuth client** (Credentials → Create credentials → OAuth client ID):
   - Application type: **Web application**.
   - **Authorized redirect URI**: `https://health-bridge.yourdomain.com/auth/callback`
   - Save the **Client ID** and **Client Secret**.

You'll do the actual consent (which mints the refresh token) once the backend is deployed — see §6.

---

## 4. Part B — The backend

### 4.1 Project structure

```
health-bridge/
├── src/
│   ├── server.ts          # Fastify app + routes
│   ├── config.ts          # env loading
│   ├── db.ts              # SQLite setup + migrations
│   ├── oauth.ts           # auth bootstrap + token manager
│   ├── googleHealth.ts    # Google Health API client (list/reconcile + paging)
│   ├── mapping.ts         # Google → normalized sample mapping (the heart of it)
│   ├── sync.ts            # fetch recent days → normalize → upsert
│   ├── exporter.ts        # /export + /ack logic
│   └── scheduler.ts       # cron
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

### 4.2 Environment variables (`.env.example`)

```
PORT=8080
PUBLIC_BASE_URL=https://health-bridge.yourdomain.com
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
GOOGLE_REDIRECT_URI=https://health-bridge.yourdomain.com/auth/callback
# Space-separated scopes (must match what you enabled in the consent screen)
GOOGLE_SCOPES=https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
# Secret the Shortcut must send as "Authorization: Bearer <...>"
SHORTCUT_TOKEN=generate-a-long-random-string
# Secret protecting /auth/start so randoms can't trigger the OAuth flow
ADMIN_TOKEN=another-long-random-string
# Local timezone of the user — used to bucket "civil days" and pick sleep midpoint
USER_TZ=Europe/London
# How many days back the scheduler keeps trying to (re)pull, to catch late revisions
LOOKBACK_DAYS=4
SQLITE_PATH=/data/health-bridge.db
```

### 4.3 Database schema (`db.ts`)

```ts
import Database from 'better-sqlite3';
import { CONFIG } from './config.js';

export const db = new Database(CONFIG.sqlitePath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS oauth (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token   TEXT,
  access_token    TEXT,
  access_expires  INTEGER,        -- epoch seconds
  health_user_id  TEXT
);

CREATE TABLE IF NOT EXISTS samples (
  dedup_key   TEXT PRIMARY KEY,   -- e.g. "hrv|2026-06-15T03:24:00Z"
  hk_type     TEXT NOT NULL,      -- HealthKit sample identifier
  category    TEXT,               -- for sleepAnalysis category value, else NULL
  value       REAL,               -- NULL for category samples
  unit        TEXT,               -- e.g. "ms","count/min","%","kcal","m","degC","kg"
  start_time  TEXT NOT NULL,      -- ISO 8601 UTC
  end_time    TEXT NOT NULL,
  civil_date  TEXT NOT NULL,      -- YYYY-MM-DD in USER_TZ (the "night/day" it belongs to)
  source      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_date ON samples(civil_date);

CREATE TABLE IF NOT EXISTS cursors (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_fetch_date  TEXT,   -- last civil date we pulled from Google
  last_acked_date  TEXT    -- last civil date the phone confirmed writing
);
INSERT OR IGNORE INTO cursors (id, last_fetch_date, last_acked_date) VALUES (1, NULL, NULL);

CREATE TABLE IF NOT EXISTS batches (
  batch_id   TEXT PRIMARY KEY,
  max_date   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
```

### 4.4 OAuth bootstrap + token manager (`oauth.ts`)

```ts
import { CONFIG } from './config.js';
import { db } from './db.js';

// One-time consent: GET /auth/start (admin) -> Google -> /auth/callback
export function buildAuthUrl(): string {
  const p = new URLSearchParams({
    client_id: CONFIG.googleClientId,
    redirect_uri: CONFIG.googleRedirectUri,
    response_type: 'code',
    scope: CONFIG.googleScopes,
    access_type: 'offline',     // required to receive a refresh token
    prompt: 'consent',          // force refresh_token on re-consent
    include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CONFIG.googleClientId,
      client_secret: CONFIG.googleClientSecret,
      redirect_uri: CONFIG.googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const t = await res.json() as any;
  db.prepare(`INSERT INTO oauth (id, refresh_token, access_token, access_expires)
              VALUES (1, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                refresh_token=excluded.refresh_token,
                access_token=excluded.access_token,
                access_expires=excluded.access_expires`)
    .run(t.refresh_token, t.access_token, Math.floor(Date.now()/1000) + t.expires_in - 60);

  // Store the health user id (recommended by Google).
  const id = await getIdentity(t.access_token);
  db.prepare(`UPDATE oauth SET health_user_id=? WHERE id=1`).run(id.healthUserId ?? null);
}

export async function getAccessToken(): Promise<string> {
  const row = db.prepare(`SELECT * FROM oauth WHERE id=1`).get() as any;
  if (!row?.refresh_token) throw new Error('Not authorized yet — visit /auth/start');
  const now = Math.floor(Date.now()/1000);
  if (row.access_token && row.access_expires > now) return row.access_token;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.googleClientId,
      client_secret: CONFIG.googleClientSecret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${await res.text()}`); // if 400 invalid_grant -> re-run /auth/start
  const t = await res.json() as any;
  db.prepare(`UPDATE oauth SET access_token=?, access_expires=? WHERE id=1`)
    .run(t.access_token, now + t.expires_in - 60);
  return t.access_token;
}

async function getIdentity(accessToken: string) {
  const res = await fetch('https://health.googleapis.com/v4/users/me/identity', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return res.ok ? await res.json() as any : {};
}
```

### 4.5 Google Health API client (`googleHealth.ts`)

Confirmed conventions (from `developers.google.com/health/endpoints`):
- Base: `https://health.googleapis.com/v4/users/me/dataTypes/{data-type}/dataPoints`
- Header: `Authorization: Bearer <token>`, `Accept: application/json`
- Data type **kebab-case in the path** (`daily-heart-rate-variability`), **snake_case in filters** (`daily_heart_rate_variability`).
- List supports `?filter=` and pagination via `nextPageToken` (pass back as `pageToken`). **[VERIFY]** exact page-token param name against the `list` reference.
- Sleep uses the `:reconcile` endpoint with `dataSourceFamily` (sample shows `google-wearables`).

```ts
import { getAccessToken } from './oauth.js';

const BASE = 'https://health.googleapis.com/v4/users/me/dataTypes';

async function authedGet(url: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GHAPI ${res.status} for ${url}: ${await res.text()}`);
  return res.json();
}

/** List all dataPoints for a type within [startCivil, endCivil) civil dates. */
export async function listDataPoints(kebabType: string, snakeType: string, startISO: string): Promise<any[]> {
  const out: any[] = [];
  // filter uses the data type's interval/sample civil_start_time; field name varies by record type. [VERIFY]
  let url = `${BASE}/${kebabType}/dataPoints?filter=${encodeURIComponent(`${snakeType}.interval.civil_start_time >= "${startISO}"`)}`;
  while (url) {
    const data = await authedGet(url);
    out.push(...(data.dataPoints ?? []));
    url = data.nextPageToken
      ? `${BASE}/${kebabType}/dataPoints?pageToken=${encodeURIComponent(data.nextPageToken)}`
      : '';
  }
  return out;
}

/** Sleep via reconcile (deduped, tracker-sourced). */
export async function listSleep(startCivilDate: string): Promise<any[]> {
  const url = `${BASE}/sleep/dataPoints:reconcile`
    + `?dataSourceFamily=${encodeURIComponent('users/me/dataSourceFamilies/google-wearables')}`
    + `&filter=${encodeURIComponent(`sleep.interval.civil_end_time >= "${startCivilDate}"`)}`;
  const data = await authedGet(url);
  return data.dataPoints ?? [];
}
```

### 4.6 Mapping — the core (`mapping.ts`)

This converts Google data points → normalized samples the Shortcut can log directly. **This is where the junior dev spends most care; verify each field path against the live JSON (log a raw dump first — see §8).**

```ts
import { DateTime } from 'luxon';
import { CONFIG } from './config.js';

export interface Sample {
  dedupKey: string; hkType: string; category?: string;
  value?: number; unit?: string;
  start: string; end: string; civilDate: string; source?: string;
}

const civil = (iso: string) =>
  DateTime.fromISO(iso, { zone: 'utc' }).setZone(CONFIG.userTz).toFormat('yyyy-LL-dd');

// ---- Numeric "daily" metrics (one value per night/day) ----
// Each Google daily data point has a date + a value field. Field names per the
// dataPoints reference: https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints  [VERIFY]

export function mapDailyHRV(dp: any, sleepMidpointISO: string): Sample {
  const v = dp.dailyHeartRateVariability?.rmssdMilliseconds   // [VERIFY] field name
        ?? dp.dailyHeartRateVariability?.value;
  return mkDaily('heartRateVariabilitySDNN', 'ms', v, dp, sleepMidpointISO); // RMSSD→SDNN field, see §10
}
export function mapRestingHR(dp: any, mid: string): Sample {
  const v = dp.dailyRestingHeartRate?.bpm ?? dp.dailyRestingHeartRate?.value; // [VERIFY]
  return mkDaily('restingHeartRate', 'count/min', v, dp, mid);
}
export function mapSpO2(dp: any, mid: string): Sample {
  const v = dp.dailyOxygenSaturation?.percentage ?? dp.dailyOxygenSaturation?.value; // [VERIFY]
  return mkDaily('oxygenSaturation', '%', v, dp, mid);
}
export function mapRespRate(dp: any, mid: string): Sample {
  const v = dp.respiratoryRateSleepSummary?.breathsPerMinute ?? dp.respiratoryRateSleepSummary?.value; // [VERIFY]
  return mkDaily('respiratoryRate', 'count/min', v, dp, mid);
}
export function mapVO2(dp: any, mid: string): Sample {
  const v = dp.dailyVo2Max?.value; // [VERIFY] unit mL/(kg*min)
  return mkDaily('vo2Max', 'mL/min·kg', v, dp, mid);
}

function mkDaily(hkType: string, unit: string, value: number, dp: any, whenISO: string): Sample {
  return { dedupKey: `${hkType}|${whenISO}`, hkType, unit, value,
           start: whenISO, end: whenISO, civilDate: civil(whenISO), source: 'fitbit' };
}

// ---- Interval metrics (steps, distance, active energy) ----
export function mapSteps(dp: any): Sample {
  const s = dp.steps.interval.startTime, e = dp.steps.interval.endTime;
  return { dedupKey: `steps|${s}`, hkType: 'stepCount', unit: 'count',
           value: Number(dp.steps.count), start: s, end: e, civilDate: civil(s), source: 'fitbit' };
}
export function mapDistance(dp: any): Sample {
  const s = dp.distance.interval.startTime, e = dp.distance.interval.endTime;
  const meters = Number(dp.distance.lengthMillimeters ?? dp.distance.millimeters) / 1000; // API uses mm  [VERIFY]
  return { dedupKey: `dist|${s}`, hkType: 'distanceWalkingRunning', unit: 'm',
           value: meters, start: s, end: e, civilDate: civil(s), source: 'fitbit' };
}

// ---- Sleep stages (one Sample per stage segment) ----
const STAGE_MAP: Record<string,string> = {
  AWAKE: 'awake', WAKE: 'awake', LIGHT: 'asleepCore', DEEP: 'asleepDeep', REM: 'asleepREM',
};
export function mapSleep(dp: any): Sample[] {
  const stages = dp.sleep?.stages ?? [];
  const civilD = civil(dp.sleep.interval.startTime);
  return stages
    .filter((st: any) => STAGE_MAP[st.type])
    .map((st: any) => ({
      dedupKey: `sleep|${st.startTime}|${st.type}`,
      hkType: 'sleepAnalysis', category: STAGE_MAP[st.type],
      start: st.startTime, end: st.endTime, civilDate: civilD, source: 'fitbit',
    }));
}

// Sleep midpoint, used to timestamp the nightly metrics (HRV etc.) realistically.
export function sleepMidpoint(sleepDp: any): string {
  const s = DateTime.fromISO(sleepDp.sleep.interval.startTime);
  const e = DateTime.fromISO(sleepDp.sleep.interval.endTime);
  return s.plus({ milliseconds: e.diff(s).milliseconds / 2 }).toUTC().toISO()!;
}
```

> Optional/high-volume: intraday `heart-rate` (5-second samples) maps to `heartRate` `count/min`. It's a lot of samples — implement only if you want it, and consider decimating.

### 4.7 Sync (`sync.ts`)

```ts
import { db } from './db.js';
import { CONFIG } from './config.js';
import { DateTime } from 'luxon';
import { listDataPoints, listSleep } from './googleHealth.js';
import * as M from './mapping.js';

export async function runSync(): Promise<{ added: number }> {
  const start = DateTime.now().setZone(CONFIG.userTz)
    .minus({ days: CONFIG.lookbackDays }).startOf('day');
  const startISO = start.toFormat("yyyy-LL-dd'T'00:00:00");
  const startDate = start.toFormat('yyyy-LL-dd');

  // 1) Sleep first (gives us the nightly midpoint to timestamp daily metrics).
  const sleeps = await listSleep(startDate);
  const midpointByDate = new Map<string,string>();
  const samples: M.Sample[] = [];
  for (const dp of sleeps) {
    const mid = M.sleepMidpoint(dp);
    midpointByDate.set(DateTime.fromISO(dp.sleep.interval.startTime).setZone(CONFIG.userTz).toFormat('yyyy-LL-dd'), mid);
    samples.push(...M.mapSleep(dp));
  }
  const midFor = (civilDate: string) =>
    midpointByDate.get(civilDate) ?? `${civilDate}T06:00:00Z`; // fallback 6am

  // 2) Daily metrics
  for (const dp of await listDataPoints('daily-heart-rate-variability','daily_heart_rate_variability',startISO))
    samples.push(M.mapDailyHRV(dp, midFor(dailyCivil(dp))));
  for (const dp of await listDataPoints('daily-resting-heart-rate','daily_resting_heart_rate',startISO))
    samples.push(M.mapRestingHR(dp, midFor(dailyCivil(dp))));
  for (const dp of await listDataPoints('daily-oxygen-saturation','daily_oxygen_saturation',startISO))
    samples.push(M.mapSpO2(dp, midFor(dailyCivil(dp))));
  for (const dp of await listDataPoints('daily-respiratory-rate','daily_respiratory_rate',startISO))
    samples.push(M.mapRespRate(dp, midFor(dailyCivil(dp))));

  // 3) Activity
  for (const dp of await listDataPoints('steps','steps',startISO))    samples.push(M.mapSteps(dp));
  for (const dp of await listDataPoints('distance','distance',startISO)) samples.push(M.mapDistance(dp));

  // 4) Upsert (dedup_key PK means re-pulling the same data is a no-op)
  const ins = db.prepare(`INSERT INTO samples
    (dedup_key,hk_type,category,value,unit,start_time,end_time,civil_date,source,created_at)
    VALUES (@dedupKey,@hkType,@category,@value,@unit,@start,@end,@civilDate,@source,@created)
    ON CONFLICT(dedup_key) DO NOTHING`);
  const tx = db.transaction((rows: M.Sample[]) => {
    for (const s of rows) ins.run({ category:null, value:null, unit:null, ...s, created: Date.now() });
  });
  tx(samples);

  db.prepare(`UPDATE cursors SET last_fetch_date=? WHERE id=1`)
    .run(DateTime.now().setZone(CONFIG.userTz).toFormat('yyyy-LL-dd'));
  return { added: samples.length };
}

// helper: civil date of a daily data point. [VERIFY] exact date field path per type.
function dailyCivil(dp: any): string {
  const d = dp.dailyHeartRateVariability?.date ?? dp.dailyRestingHeartRate?.date
        ?? dp.dailyOxygenSaturation?.date ?? dp.respiratoryRateSleepSummary?.date
        ?? dp.date;
  return `${d.year}-${String(d.month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
}
```

### 4.8 Export + ack (`exporter.ts`)

Ack model: backend marks exact sample rows as acknowledged after the iOS app writes a batch and calls `POST /ack`. `/export` returns unacknowledged samples **up to yesterday** (today is excluded because it is not a finished day and Fitbit can revise it). The legacy `last_acked_date` cursor is still maintained for compatibility, but it is no longer the only export filter. This matters when new metric types are added: newly inserted rows for an already-acked civil date can still export without re-serving every older sample.

```ts
import { db } from './db.js';
import { CONFIG } from './config.js';
import { DateTime } from 'luxon';
import { randomUUID } from 'crypto';

export function buildExport() {
  const yesterday = DateTime.now().setZone(CONFIG.userTz).minus({ days: 1 }).toFormat('yyyy-LL-dd');
  const cur = db.prepare(`SELECT last_acked_date FROM cursors WHERE id=1`).get() as any;
  const after = cur?.last_acked_date ?? '0000-01-01';

  const rows = db.prepare(
    `SELECT hk_type as hkType, category, value, unit, start_time as start, end_time as end, civil_date as civilDate
     FROM samples WHERE civil_date > ? AND civil_date <= ? ORDER BY start_time ASC`
  ).all(after, yesterday) as any[];

  if (rows.length === 0) return { batchId: null, samples: [] as any[] };

  const maxDate = rows.reduce((m, r) => r.civilDate > m ? r.civilDate : m, after);
  const batchId = `b_${maxDate}_${randomUUID().slice(0,8)}`;
  db.prepare(`INSERT INTO batches (batch_id,max_date,created_at) VALUES (?,?,?)`)
    .run(batchId, maxDate, Date.now());
  return { batchId, fromDate: after, toDate: maxDate, count: rows.length, samples: rows };
}

export function ack(batchId: string): boolean {
  const b = db.prepare(`SELECT max_date FROM batches WHERE batch_id=?`).get(batchId) as any;
  if (!b) return false;
  db.prepare(`UPDATE cursors SET last_acked_date=? WHERE id=1`).run(b.max_date);
  return true;
}
```

### 4.9 Server + routes (`server.ts`)

```ts
import Fastify from 'fastify';
import { CONFIG } from './config.js';
import { buildAuthUrl, exchangeCodeForTokens } from './oauth.js';
import { buildExport, ack } from './exporter.js';
import { runSync } from './sync.js';
import { startScheduler } from './scheduler.js';

const app = Fastify({ logger: true });
const bearer = (req: any) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

app.get('/healthz', async () => ({ ok: true }));

// One-time OAuth bootstrap (protect with ?admin=ADMIN_TOKEN)
app.get('/auth/start', async (req: any, reply) => {
  if (req.query.admin !== CONFIG.adminToken) return reply.code(403).send('forbidden');
  return reply.redirect(buildAuthUrl());
});
app.get('/auth/callback', async (req: any, reply) => {
  await exchangeCodeForTokens(req.query.code);
  return reply.send('Authorized. You can close this tab.');
});

// Shortcut endpoints (protect with Bearer SHORTCUT_TOKEN)
app.get('/export', async (req: any, reply) => {
  if (bearer(req) !== CONFIG.shortcutToken) return reply.code(401).send();
  return buildExport();
});
app.post('/ack', async (req: any, reply) => {
  if (bearer(req) !== CONFIG.shortcutToken) return reply.code(401).send();
  return { ok: ack(req.body.batchId) };
});

// Manual trigger for testing
app.post('/sync', async (req: any, reply) => {
  if (bearer(req) !== CONFIG.shortcutToken) return reply.code(401).send();
  return runSync();
});

// Future: Google webhook (sleep). Implements the verification handshake from the docs.
app.post('/webhooks/google-health', async (req: any, reply) => {
  if (req.body?.type === 'verification') {
    return bearer(req) === CONFIG.shortcutToken ? reply.code(200).send() : reply.code(401).send();
  }
  reply.code(204).send();
  setImmediate(() => runSync().catch(app.log.error));
});

app.listen({ port: CONFIG.port, host: '0.0.0.0' }).then(() => startScheduler());
```

### 4.10 Scheduler (`scheduler.ts`)

```ts
import cron from 'node-cron';
import { runSync } from './sync.js';

export function startScheduler() {
  // Hourly; the Air's data lands in Google cloud through the day.
  cron.schedule('0 * * * *', () => { runSync().catch(console.error); });
}
```

### 4.11 `package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`

```json
// package.json
{
  "name": "health-bridge",
  "type": "module",
  "scripts": { "build": "tsc", "start": "node dist/server.js", "dev": "tsx watch src/server.ts" },
  "dependencies": {
    "fastify": "^4", "better-sqlite3": "^11", "luxon": "^3", "node-cron": "^3"
  },
  "devDependencies": { "typescript": "^5", "tsx": "^4", "@types/luxon": "^3", "@types/node": "^20", "@types/better-sqlite3": "^7" }
}
```

```json
// tsconfig.json
{ "compilerOptions": {
  "target": "ES2022", "module": "ES2022", "moduleResolution": "Bundler",
  "outDir": "dist", "rootDir": "src", "strict": true, "esModuleInterop": true, "skipLibCheck": true
}, "include": ["src"] }
```

```dockerfile
# Dockerfile
FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

```yaml
# docker-compose.yml  (Dokploy "Compose" app)
services:
  health-bridge:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - health_data:/data
    # Dokploy/Traefik handles HTTPS + routing to port 8080
    expose:
      - "8080"
volumes:
  health_data:
```

---

## 5. Part D — Dokploy deployment

1. **DNS**: point `health-bridge.yourdomain.com` (A record) at the Hetzner server.
2. In Dokploy: **Create → Application** (or **Compose**). Source = your Git repo (push the project) or Dockerfile.
3. **Environment**: paste the `.env` values (Dokploy → Environment). Generate `SHORTCUT_TOKEN` and `ADMIN_TOKEN` with `openssl rand -hex 32`.
4. **Volume / Mount**: persist `/data` (Dokploy → Advanced → Volumes → mount a volume to `/data`) so the SQLite DB and tokens survive redeploys.
5. **Domain**: Dokploy → Domains → add `health-bridge.yourdomain.com`, container port `8080`, enable **HTTPS (Let's Encrypt)**. Traefik provisions the cert.
6. **Deploy**, then check `https://health-bridge.yourdomain.com/healthz` → `{"ok":true}`.
7. **Authorize once**: open `https://health-bridge.yourdomain.com/auth/start?admin=YOUR_ADMIN_TOKEN` in a browser, sign in with the Google account that owns the Air, grant the scopes (click through the "unverified app" screen if shown). You should land on "Authorized." The refresh token is now stored.
8. **Seed data**: `curl -X POST https://health-bridge.yourdomain.com/sync -H "Authorization: Bearer YOUR_SHORTCUT_TOKEN"` → should return `{ "added": N }`.
9. `curl https://health-bridge.yourdomain.com/export -H "Authorization: Bearer YOUR_SHORTCUT_TOKEN"` → JSON with `batchId` + `samples`.

---

## 6. Part E — The Apple Shortcut

Build in the Shortcuts app (it's visual; here's the exact action list). Name it **"Sync Google Health → Apple Health."**

1. **Text** → paste your `SHORTCUT_TOKEN`. (Set variable name `Token`.)
2. **Text** → `https://health-bridge.yourdomain.com` (var `BaseURL`).
3. **Get Contents of URL**
   - URL: `BaseURL` + `/export`
   - Method: **GET**
   - Headers: `Authorization` = `Bearer ` + `Token`
4. **Get Dictionary from Input** (parse JSON) → **Get Dictionary Value** key `batchId` (var `BatchId`), and key `samples` (var `Samples`).
5. **If** `BatchId` `has any value` → (else: Stop, nothing to sync).
6. **Repeat with Each** item in `Samples`:
   - **Get Dictionary Value** `hkType` (var `HK`), `category` (var `Cat`), `value` (var `Val`), `unit` (var `Unit`), `start` (var `Start`), `end` (var `End`).
   - **If** `HK` is `sleepAnalysis`:
     - **Log Health Sample** → Type: **Sleep**, Value: from `Cat` (In Bed/Asleep Core/Asleep Deep/Asleep REM/Awake), Start Date: `Start`, End Date: `End`.
   - **Otherwise** (quantity sample):
     - **Log Health Sample** → Type: map from `HK` (see table §7), Value: `Val`, (Unit per type), Start Date: `Start`, End Date: `End`.
     > Shortcuts requires the health type to be chosen in the action UI. Easiest robust pattern: an **If/Otherwise chain** on `HK` with one *Log Health Sample* action per type (HRV, Resting Heart Rate, Blood Oxygen, Respiratory Rate, VO2 max, Steps, Walking+Running Distance, Sleep). ~8 branches. Each branch hardcodes the type + unit and feeds `Val`, `Start`, `End`.
7. After the loop: **Get Contents of URL**
   - URL: `BaseURL` + `/ack`
   - Method: **POST**, Request Body: **JSON** `{ "batchId": BatchId }`
   - Headers: `Authorization` = `Bearer ` + `Token`

**Grant Health write permission (one-time):** run the shortcut manually once; iOS prompts for Health write access — **Turn All On**. (If a type's permission doesn't appear, it's because Shortcuts has never tried to write it yet — let it run/fail once, then enable it under Health → Profile → Privacy → Apps → Shortcuts.)

**Automation:** Shortcuts → Automation → **＋ → Time of Day** → e.g. **13:00 daily** (afternoon, so the Google Health app has already synced the night's data) → run the shortcut → **turn off "Ask Before Running" → Don't Ask.** Add a second time trigger (e.g. 21:00) for resilience.

---

## 7. Part E (reference) — Google Health → Apple Health type/unit map

| Google Health API type | Backend `hkType` | Apple "Log Health Sample" type | Unit | Notes |
|---|---|---|---|---|
| `daily-heart-rate-variability` | `heartRateVariabilitySDNN` | Heart Rate Variability | ms | RMSSD value into SDNN field — §10 |
| `daily-resting-heart-rate` | `restingHeartRate` | Resting Heart Rate | count/min | |
| `daily-oxygen-saturation` | `oxygenSaturation` | Blood Oxygen Saturation | % | |
| `respiratory-rate-sleep-summary` | `respiratoryRate` | Respiratory Rate | count/min | |
| `daily-vo2-max` | `vo2Max` | VO₂ Max | mL/(kg·min) | |
| `steps` | `stepCount` | Steps | count | |
| `distance` | `distanceWalkingRunning` | Walking + Running Distance | m | API in mm → /1000 |
| `active-energy-burned` | `activeEnergyBurned` | Active Energy | kcal | controlled by `SYNC_ACTIVITY` |
| `floors` | `flightsClimbed` | Flights Climbed | count | controlled by `SYNC_ACTIVITY` |
| `exercise` | `workout` | Workout | — | native iOS app writes `HKWorkout` with metadata for type, calories, distance, HR, steps |
| `sleep` (stages) | `sleepAnalysis` | Sleep | — | per-stage segments → category |
| `heart-rate` (intraday) | `heartRate` | Heart Rate | count/min | controlled by `SYNC_ACTIVITY`, high volume |

Sleep stage → Apple category: `LIGHT→Asleep Core`, `DEEP→Asleep Deep`, `REM→Asleep REM`, `AWAKE→Awake`.

---

## 8. Part F — Testing & verification

1. **Phase 0 (before any code):** use Google's **OAuth 2.0 Playground** or "Make your first API call" codelab with your client to confirm the Air's HRV/sleep actually return data. (`developers.google.com/health/codelabs/make-your-first-api-call`.)
2. **Raw-dump step:** in `sync.ts`, temporarily `console.log(JSON.stringify(dp))` for one of each data type and confirm the **field paths** in `mapping.ts` match (resolve all **[VERIFY]** markers). This is the single most important implementation step.
3. **Backend smoke test:** `/healthz`, `/auth/start` flow, `POST /sync` returns `added>0`, `GET /export` returns samples, `POST /ack` returns `{ok:true}` and a second `/export` returns fewer/zero.
4. **End-to-end:** run the Shortcut manually → open Apple Health → confirm HRV, Resting HR, Blood Oxygen, Respiratory Rate, Sleep appear at the right timestamps → open Bevel → confirm it ingests them.
5. **Automation:** confirm the timed automation runs unattended (check Health for new data next day with no manual action).
6. **Dedup:** run the Shortcut twice in a row → second run should add nothing (export empty after ack).

**Definition of done:** for 3 consecutive days, with no manual intervention, last night's HRV + resting HR + SpO2 + respiratory rate + sleep stages appear in Apple Health and Bevel by midday, with no duplicates.

---

## 9. Operations & gotchas

- **Refresh token longevity:** because the OAuth app is **In production**, the refresh token doesn't expire. If `/sync` ever fails with `invalid_grant`, re-run `/auth/start?admin=...` to re-mint it.
- **HRV semantics:** Fitbit reports **RMSSD**; Apple Health only has an **SDNN** field. We write the RMSSD value into SDNN. Correct for tracking *your* trend in Bevel; not numerically comparable to an Apple Watch. (No way around this — Apple has no RMSSD field.)
- **Sleep stages** are the most fragile part of the Shortcut (per-segment category logging). If it's flaky, fall back to logging a single "Asleep" block per night from `sleep.interval` and keep stages as a later enhancement.
- **Latency:** data only reaches the API after the Air syncs to the Google Health app; that's why the automation runs midday/evening, not 6am.
- **Phone state:** writing via Shortcuts automation is generally fine unattended once permission is granted, but if your iOS build nags for confirmation, that's a known intermittent issue — keep the manual run as backup.
- **September 2026:** this is built on the **Google Health API v4** (correct long-term API). The legacy Fitbit Web API is irrelevant here.
- **Security:** never commit `.env`. `SHORTCUT_TOKEN` is the only secret on the phone; rotate it by updating Dokploy env + the Shortcut's Text action. Keep `/auth/*` behind `ADMIN_TOKEN`.

---

## 10. Risks / decisions still open

1. **Unverified consent for health scopes** — most likely shows a click-through warning; **[VERIFY]** Google doesn't hard-block these scopes unverified. If it does, you'd submit for verification (free but a review process) — only blocker, and only if blocked.
2. **Exact API field names** for HRV/RHR/SpO2/respiratory daily values and the list `pageToken`/filter field per record type — resolve via the raw-dump step (§8) against `developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints`.
3. **Intraday heart rate & full sleep staging** — included as optional; decide if you want them in v1 or as a follow-up.

---

## 11. Build order (suggested for the junior dev)

1. Google Cloud setup (§3) + Playground test (§8.1).
2. Backend skeleton: `healthz`, OAuth bootstrap, token manager → authorize successfully (§4.4, §4.9, §5.7).
3. `googleHealth.ts` + raw dump → lock down `mapping.ts` field paths (§8.2).
4. `sync.ts` + `/sync` → data in SQLite.
5. `exporter.ts` + `/export` + `/ack`.
6. Scheduler.
7. Deploy on Dokploy with volume + HTTPS (§5).
8. Build the Shortcut (§6), grant Health permissions, test end-to-end (§8.4).
9. Turn on the daily automation; verify 3-day unattended run (§8, DoD).
```
