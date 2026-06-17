import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CONFIG } from './config.js';

// Ensure the directory for the SQLite file exists (e.g. the mounted /data volume).
mkdirSync(dirname(CONFIG.sqlitePath), { recursive: true });

export const db: Database.Database = new Database(CONFIG.sqlitePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS oauth (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token   TEXT,
  access_token    TEXT,
  access_expires  INTEGER,          -- epoch seconds
  health_user_id  TEXT,
  legacy_user_id  TEXT,
  updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS samples (
  dedup_key   TEXT PRIMARY KEY,     -- e.g. "heartRateVariabilitySDNN|2026-06-15T03:24:00Z"
  hk_type     TEXT NOT NULL,        -- HealthKit sample identifier (or "sleepAnalysis")
  category    TEXT,                 -- sleep category value (asleepDeep, awake, ...), else NULL
  value       REAL,                 -- NULL for category samples
  unit        TEXT,                 -- "ms","count/min","%","kcal","m","degC","kg", ...
  start_time  TEXT NOT NULL,        -- ISO 8601 UTC
  end_time    TEXT NOT NULL,        -- ISO 8601 UTC
  civil_date  TEXT NOT NULL,        -- YYYY-MM-DD in USER_TZ (the night/day it belongs to)
  source      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_date ON samples(civil_date);

CREATE TABLE IF NOT EXISTS cursors (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_fetch_date  TEXT,            -- last civil date pulled from Google
  last_acked_date  TEXT             -- last civil date the phone confirmed writing
);
INSERT OR IGNORE INTO cursors (id, last_fetch_date, last_acked_date) VALUES (1, NULL, NULL);

CREATE TABLE IF NOT EXISTS batches (
  batch_id   TEXT PRIMARY KEY,
  max_date   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

export interface OAuthRow {
  id: number;
  refresh_token: string | null;
  access_token: string | null;
  access_expires: number | null;
  health_user_id: string | null;
  legacy_user_id: string | null;
  updated_at: number | null;
}

export interface CursorRow {
  id: number;
  last_fetch_date: string | null;
  last_acked_date: string | null;
}
