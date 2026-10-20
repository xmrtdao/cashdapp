/**
 * scripts/retune-chat-cron.mjs — widen the three fleet-chat jobs that were
 * generating the spam.
 *
 * The cadence change alone was never going to be the fix — a 10-minute job that
 * files one duplicate per run files 144 duplicates a day regardless of whether
 * it runs every 10 minutes or every 3 hours. The dedupe work (migration
 * jobby_010, and the three emitters) is what stops the loop; this just stops it
 * being loud in the meantime and while nobody is watching.
 *
 * Prints a table of before/after so the change is reviewable rather than a
 * surprise in a diff of 84 jobs.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOBS_FILE = join(__dirname, '..', '..', 'relay-data', 'cron-jobs.json');

// Every 10 min -> every 30. Every 15 -> every 30. The job ids are named so the
// change is greppable later.
const RETUNE = {
  227: { name: 'fleet-chat-task-creator', from: '*/10 * * * *', to: '17,47 * * * *' },
  5:   { name: 'task-discussion-announcer', from: '*/15 * * * *', to: '7,37 * * * *' },
};

const raw = readFileSync(JOBS_FILE, 'utf8');
const parsed = JSON.parse(raw);
const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || Object.values(parsed).flat());

let changed = 0;
for (const change of Object.values(RETUNE)) void change;

for (const [idStr, want] of Object.entries(RETUNE)) {
  const id = Number(idStr);
  const job = jobs.find(j => Number(j.id) === id);
  if (!job) {
    console.error(`[retune] job ${id} (${want.name}) is not in cron-jobs.json — skipped`);
    continue;
  }
  if (job.schedule === want.to) {
    console.log(`[retune] ${id} ${want.name}: already ${want.to}`);
    continue;
  }
  const from = job.schedule;
  job.schedule = want.to;
  changed++;
  console.log(`[retune] ${id} ${want.name}: ${from}  ->  ${want.to}`);
}

if (changed > 0) {
  const newline = raw.endsWith('\n') ? '\n' : '';
  writeFileSync(JOBS_FILE, JSON.stringify(parsed, null, 2) + newline, 'utf8');
  console.log(`[retune] ${changed} job(s) retuned in ${JOBS_FILE}`);
} else {
  console.log('[retune] nothing to change');
}