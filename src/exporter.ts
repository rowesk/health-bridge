import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { db, type CursorRow } from './db.js';
import { CONFIG } from './config.js';

export interface ExportSample {
  hkType: string;
  category: string | null;
  value: number | null;
  unit: string | null;
  start: string;
  end: string;
  civilDate: string;
}

export interface ExportPayload {
  batchId: string | null;
  fromDate: string | null;
  toDate: string | null;
  count: number;
  samples: ExportSample[];
}

/**
 * Return all samples on civil dates after the last acked date and up to yesterday
 * (today is excluded because it isn't a finished day and Fitbit revises data).
 * Does NOT advance the cursor — that happens on /ack.
 */
export function buildExport(): ExportPayload {
  const yesterday = DateTime.now().setZone(CONFIG.userTz).minus({ days: 1 }).toFormat('yyyy-LL-dd');
  const cur = db.prepare(`SELECT * FROM cursors WHERE id = 1`).get() as CursorRow;
  const after = cur?.last_acked_date ?? '0000-01-01';

  const rows = db
    .prepare(
      `SELECT hk_type AS hkType, category, value, unit,
              start_time AS start, end_time AS end, civil_date AS civilDate
       FROM samples
       WHERE civil_date > ? AND civil_date <= ?
       ORDER BY start_time ASC`,
    )
    .all(after, yesterday) as ExportSample[];

  if (rows.length === 0) {
    return { batchId: null, fromDate: after, toDate: yesterday, count: 0, samples: [] };
  }

  const maxDate = rows.reduce((m, r) => (r.civilDate > m ? r.civilDate : m), after);
  const batchId = `b_${maxDate}_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO batches (batch_id, max_date, created_at) VALUES (?, ?, ?)`).run(
    batchId,
    maxDate,
    Date.now(),
  );

  return { batchId, fromDate: after, toDate: maxDate, count: rows.length, samples: rows };
}

/** Advance the export cursor to the batch's max date. */
export function ack(batchId: string): boolean {
  const b = db.prepare(`SELECT max_date FROM batches WHERE batch_id = ?`).get(batchId) as
    | { max_date: string }
    | undefined;
  if (!b) return false;
  db.prepare(`UPDATE cursors SET last_acked_date = ? WHERE id = 1`).run(b.max_date);
  return true;
}
