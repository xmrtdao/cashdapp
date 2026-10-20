/**
 * The daemon loop.
 *
 * House style, from `cron-engine-v2.mjs`: a self-rescheduling `setTimeout`, not
 * a `setInterval`, so a slow tick cannot stack on top of a slow tick. State in a
 * JSON file under `relay-data/`. The shared pool from `lib/db.mjs`, fetched
 * inside each call.
 *
 * What it does, unattended: generate domains from a keyword set, fetch them,
 * classify them, record what it found, and ask the model to score the ones that
 * have both a live site and a published contact address.
 *
 * WHAT IT NEVER DOES
 *
 * It sends nothing. There is no send call in this file and no send path in
 * `domain-score.mjs`. Every drafted action a candidate can take is behind a
 * click in the UI. That is the whole reason the feature is safe to run against
 * an account that has just signed up: a stranger's inbox is never touched
 * because a new user appeared.
 *
 * The keywords are the input that makes this personal. A brand-new candidate has
 * no dossier yet, so the default set is generic and the daemon says so in the
 * run ledger. Once a dossier exists the keyword set should come from it - that
 * wiring is the next piece, and it is deliberately not here, because inferring
 * someone's industry from their resume without asking them is the same class of
 * move as inferring a dossier fact, and `AGENTS.md` bans that.
 *
 * Usage:
 *   node relay/jobby/domain-daemon.mjs --once      one pass, then exit
 *   node relay/jobby/domain-daemon.mjs --daemon    run forever
 *   node relay/jobby/domain-daemon.mjs --once --keywords roofing,plumbing
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanPass } from './domain-scan.mjs';
import { scoreBatch } from './domain-score.mjs';
import * as store from './domain-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = join(__dirname, '..', '..');
const STATE_DIR = join(RELAY_ROOT, 'relay-data');
const STATE_FILE = join(STATE_DIR, 'domain-daemon-state.json');

/** How often to run, and how long to wait between passes. */
const TICK_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Generic keywords, used only until a candidate's own are known.
 *
 * Deliberately boring, and deliberately few. This daemon makes requests to real
 * servers on someone's behalf; a large default keyword set is a large default
 * footprint, and a set specific enough to be interesting is a set that should
 * have come from asking the candidate rather than from guessing.
 */
const DEFAULT_KEYWORDS = [
  'roofing', 'plumbing', 'hvac', 'landscaping', 'electrician',
  'dentist', 'bakery', 'salon', 'accounting', 'auto-repair',
];

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { lastRunAt: null, passes: 0, lastError: null };
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // A corrupt state file must not stop the daemon. The alternative is a
    // process that crash-loops on its own bookkeeping and never runs a pass,
    // which is the failure this file exists to prevent.
    return { lastRunAt: null, passes: 0, lastError: 'state file unreadable, reset' };
  }
}

function saveState(state) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    // Losing bookkeeping is survivable. Stopping the scan is not.
    console.error('[domain-daemon] could not write state:', err.message);
  }
}

/**
 * One full pass.
 *
 * Ordered deliberately: create tables, scan, then score. Scoring reads rows the
 * scan just wrote, so scoring first would score whatever the last pass happened
 * to leave behind and the run ledger's `scored` count would not match the scan
 * that produced it.
 */
export async function runOnce({ keywords = DEFAULT_KEYWORDS, budget, log = true } = {}) {
  const state = loadState();
  const started = Date.now();
  let runId = null;

  try {
    await store.ensureDomainTables();
    runId = await store.startRun(keywords);

    const scan = await scanPass({
      keywords,
      budget,
      recordImpl: store.recordCandidate,
    });

    if (log) {
      console.log(`[domain-daemon] generated ${scan.generated} domains from ${keywords.length} keywords, checked ${scan.checked}/${scan.requested}`);
      console.log(`[domain-daemon] ${scan.toScore.length} live domains with a published contact address`);
    }

    // Score only what this pass found. Reading the global unscored queue instead
    // would let one pass score a backlog the ledger does not account for.
    const toScore = scan.toScore.slice(0, 10).map(r => r.row);
    const scored = await scoreBatch(toScore);

    for (const s of scored) {
      const row = scan.results.find(r => r.row.domain === s.domain)?.row;
      const id = row?.id;
      // recordCandidate returns the id, but scanPass stores rows rather than
      // results. Resolve the id by domain so the score attaches to the right
      // row even when two keywords generated the same domain.
      if (id) await store.recordScore(id, s);
    }

    // Backfill any ids the scan could not resolve, from the store's own queue.
    // Better a slightly older score than no score at all.
    if (scored.length) {
      const queue = await store.unscoredContactable(scored.length * 2);
      for (const s of scored) {
        const match = queue.find(q => q.domain === s.domain);
        if (match) await store.recordScore(match.id, s);
      }
    }

    const contacted = scan.results.filter(r => r.row.contact_email).length;
    const durationMs = Date.now() - started;

    if (runId) {
      await store.finishRun(runId, {
        checked: scan.checked,
        found: scan.results.length,
        scored: scored.length,
        contacted,
        stoppedReason: scan.stoppedReason,
        durationMs,
      });
    }

    const next = { ...state, lastRunAt: new Date().toISOString(), passes: state.passes + 1, lastError: null };
    saveState(next);

    if (log) {
      console.log(`[domain-daemon] pass done in ${durationMs}ms: ${scan.checked} checked, ${contacted} with a contact, ${scored.length} scored`);
    }
    return { ok: true, checked: scan.checked, contacted, scored: scored.length, durationMs };
  } catch (err) {
    const message = String(err && err.message || err);
    console.error('[domain-daemon] pass failed:', message);
    // Record the failure on the run row rather than only the log. A pass that
    // dies silently leaves a row with started_at and no finished_at, which is
    // visible to anyone reading the ledger and invisible to anyone tailing logs.
    if (runId) {
      try {
        await store.finishRun(runId, {
          checked: 0, found: 0, scored: 0, contacted: 0,
          stoppedReason: `error: ${message}`,
          durationMs: Date.now() - started,
        });
      } catch { /* the original error is the one worth reporting */ }
    }
    saveState({ ...state, lastError: message, lastRunAt: new Date().toISOString() });
    return { ok: false, error: message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const daemon = argv.includes('--daemon');
  const kwIndex = argv.indexOf('--keywords');
  const keywords = kwIndex !== -1 && argv[kwIndex + 1]
    ? argv[kwIndex + 1].split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_KEYWORDS;

  if (once) {
    const result = await runOnce({ keywords });
    process.exit(result.ok ? 0 : 1);
  }

  if (!daemon) {
    console.log('usage: domain-daemon.mjs --once | --daemon [--keywords a,b,c]');
    process.exit(2);
  }

  console.log(`[domain-daemon] starting, tick ${TICK_MS / 3600000}h, keywords: ${keywords.join(', ')}`);
  console.log('[domain-daemon] this daemon does not send email. It records and scores only.');

  const loop = async () => {
    await runOnce({ keywords });
    // setTimeout, not setInterval. An interval would fire the next pass on a
    // fixed schedule regardless of whether this one finished, and passes stack.
    setTimeout(loop, TICK_MS);
  };
  await loop();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(err => {
    console.error('[domain-daemon] fatal:', err);
    process.exit(1);
  });
}

export { DEFAULT_KEYWORDS, TICK_MS, loadState };
