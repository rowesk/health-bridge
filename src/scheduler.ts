import cron from 'node-cron';
import { runSync } from './sync.js';
import { isAuthorized } from './oauth.js';

/**
 * Pre-fetch from Google every 3 hours so the phone's /export request is instant
 * and resilient to transient Google API failures. The Air's data lands in
 * Google's cloud through the day as the Google Health app syncs.
 */
export function startScheduler(): void {
  cron.schedule('0 */3 * * *', () => {
    if (!isAuthorized()) return;
    runSync()
      .then((r) => console.log(`[scheduler] sync added ${r.added}/${r.fetched} samples`))
      .catch((err) => console.error('[scheduler] sync failed:', (err as Error).message));
  });
  console.log('[scheduler] started — syncing every 3 hours');
}
