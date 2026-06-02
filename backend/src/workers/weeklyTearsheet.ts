/**
 * Weekly tearsheet cron worker.
 *
 * Schedule: every Sunday 00:00 UTC (`'0 0 * * 0'` with `timezone: 'UTC'`).
 *
 * Matches the existing worker pattern from `errorLogCleanup.ts`:
 *   - `isRunning` flag prevents overlapping execution
 *   - try/finally to clear the flag
 *   - silent skip when previous run still active
 */

import cron from 'node-cron';

import { runWeeklyForAllProfiles } from '../services/WeeklyTearsheet.ts';

let isRunning = false;

const run = async (): Promise<void> => {
  if (isRunning) {
    console.log('[WeeklyTearsheet] previous run still active, skipping');
    return;
  }
  isRunning = true;
  const t0 = Date.now();
  try {
    const { succeeded, failed } = await runWeeklyForAllProfiles(new Date());
    console.log(
      `[WeeklyTearsheet] completed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
        `succeeded=${succeeded} failed=${failed}`,
    );
  } catch (e) {
    console.error('[WeeklyTearsheet] uncaught:', e);
  } finally {
    isRunning = false;
  }
};

export const startWeeklyTearsheetWorker = (): void => {
  console.log('[WeeklyTearsheet] scheduled — every Sunday 00:00 UTC');
  cron.schedule('0 0 * * 0', run, { timezone: 'UTC' });
};

/// Exported for one-shot CLI / manual replay (e.g. `bun scripts/run-weekly.ts`).
export { run as runWeeklyTearsheetNow };
