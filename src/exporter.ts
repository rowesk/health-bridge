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
  metadata?: Record<string, unknown> | null;
}

interface ExportSampleRow extends ExportSample {
  dedupKey: string;
  metadataJson: string | null;
}

export interface ExportPayload {
  batchId: string | null;
  fromDate: string | null;
  toDate: string | null;
  count: number;
  samples: ExportSample[];
}

/**
 * Return all unacknowledged samples up to yesterday. Today is excluded because
 * it is not a finished day and Fitbit can revise it. Does not mark anything
 * acknowledged; that happens only after the phone calls /ack.
 */
export function buildExport(): ExportPayload {
  const yesterday = DateTime.now().setZone(CONFIG.userTz).minus({ days: 1 }).toFormat('yyyy-LL-dd');
  const cur = db.prepare(`SELECT * FROM cursors WHERE id = 1`).get() as CursorRow;
  const after = cur?.last_acked_date ?? '0000-01-01';

  // When activity sync is off, keep high-volume Fitbit activity/cardio rows out
  // of the export because they can duplicate another watch or phone in HealthKit.
  const activityFilter = CONFIG.syncActivity
    ? ''
    : ` AND hk_type NOT IN ('stepCount', 'distanceWalkingRunning', 'activeEnergyBurned', 'heartRate', 'flightsClimbed', 'workout')`;

  const rows = db
    .prepare(
      `SELECT hk_type AS hkType, category, value, unit,
              start_time AS start, end_time AS end, civil_date AS civilDate,
              metadata_json AS metadataJson,
              dedup_key AS dedupKey
       FROM samples
       WHERE acked_at IS NULL AND civil_date <= ?${activityFilter}
       ORDER BY start_time ASC`,
    )
    .all(yesterday) as ExportSampleRow[];

  const samples = rows.map(({ metadataJson, dedupKey: _dedupKey, ...row }) => ({
    ...row,
    metadata: parseMetadata(metadataJson),
  }));

  if (samples.length === 0) {
    return { batchId: null, fromDate: after, toDate: yesterday, count: 0, samples: [] };
  }

  const minDate = samples.reduce((m, r) => (r.civilDate < m ? r.civilDate : m), samples[0].civilDate);
  const maxDate = samples.reduce((m, r) => (r.civilDate > m ? r.civilDate : m), samples[0].civilDate);
  const batchId = `b_${maxDate}_${randomUUID().slice(0, 8)}`;
  const createBatch = db.transaction((batchRows: ExportSampleRow[]) => {
    db.prepare(`INSERT INTO batches (batch_id, max_date, created_at) VALUES (?, ?, ?)`).run(
      batchId,
      maxDate,
      Date.now(),
    );

    const insertBatchSample = db.prepare(
      `INSERT OR IGNORE INTO batch_samples (batch_id, dedup_key) VALUES (?, ?)`,
    );
    for (const row of batchRows) {
      insertBatchSample.run(batchId, row.dedupKey);
    }
  });
  createBatch(rows);

  return { batchId, fromDate: minDate, toDate: maxDate, count: samples.length, samples };
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Advance the export cursor to the batch's max date. */
export function ack(batchId: string): boolean {
  const b = db.prepare(`SELECT max_date FROM batches WHERE batch_id = ?`).get(batchId) as
    | { max_date: string }
    | undefined;
  if (!b) return false;
  const markAcked = db.transaction(() => {
    db.prepare(
      `UPDATE samples
       SET acked_at = ?
       WHERE dedup_key IN (SELECT dedup_key FROM batch_samples WHERE batch_id = ?)`,
    ).run(Date.now(), batchId);
    db.prepare(
      `UPDATE cursors
       SET last_acked_date = CASE
         WHEN last_acked_date IS NULL OR last_acked_date < ? THEN ?
         ELSE last_acked_date
       END
       WHERE id = 1`,
    ).run(b.max_date, b.max_date);
  });
  markAcked();
  return true;
}
