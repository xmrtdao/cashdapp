import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');
mkdirSync(DATA_DIR, { recursive: true });

const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8080';
const STUCK_MINS = parseInt(process.env.STUCK_MINS || '60', 10);
// Escalation ladder. The old cooldown was 15 minutes, which meant a task
// nobody was ever going to touch got nudged every 15 minutes for as long as it
// existed: on 2026-10-17 ten tasks had been nudged 40+ times each, four of them
// unchanged for 12 to 21 DAYS. Nudging is a prompt for a human to act, and a
// message ignored forty times is not a prompt, it is wallpaper.
const NUDGE_COOLDOWN_MINS = parseInt(process.env.NUDGE_COOLDOWN_MINS || '360', 10);
// After this many unanswered nudges, stop. Escalating to "give up" is a
// decision the humans who own the task should make in the open, not something a
// cron job should make silently by never speaking again.
const MAX_NUDGES = parseInt(process.env.MAX_NUDGES || '3', 10);
// Past this age a task is not stalled, it is abandoned. Nudging an abandoned
// task every six hours for a month is how you get 40 nudges.
const ABANDONED_HRS = parseInt(process.env.ABANDONED_HRS || '72', 10);
const NUDGE_STATE_FILE = join(DATA_DIR, 'task-nudge-state.json');

const TERMINAL = ['DONE', 'CANCELLED', 'COMPLETED'];
// Stages that indicate the task is mid-flight and should be nudged if stalled
const ACTIVE_STAGES = ['PLANNING', 'EXECUTING', 'IN_PROGRESS', 'EXECUTE', 'REVIEWING', 'REVIEW', 'BUILDING', 'DISCUSS'];

function loadState() {
  try {
    if (existsSync(NUDGE_STATE_FILE)) return JSON.parse(readFileSync(NUDGE_STATE_FILE, 'utf8'));
  } catch {}
  return { lastNudged: {} };
}
function saveState(state) {
  try { writeFileSync(NUDGE_STATE_FILE, JSON.stringify(state)); } catch (e) { console.error('[task-nudge] save state failed: ' + e.message); }
}

async function pgQuery(sql, params) {
  try {
    const res = await fetch(`${RELAY_URL}/tools/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-id': 'hermes-agent' },
      body: JSON.stringify({ tool: 'db-query', args: { sql, params: params || [] } }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    return data.success ? data.rows || [] : [];
  } catch (e) {
    console.error(`[task-nudge] db query failed: ${e.message}`);
    return [];
  }
}

// Map app.agents id -> fleet-chat @mention handle. Fleet relay agents answer to
// their lowercase name (e.g. builder-001 -> @builder).
function mentionFor(assigneeId) {
  if (!assigneeId) return null;
  const base = assigneeId.split('-')[0].toLowerCase();
  const aliases = { 'global-communicator': 'global-communicator', 'globalcommunicator': 'global-communicator' };
  return aliases[base] || base;
}

async function main() {
  try {
    const state = loadState();
    const cutoff = new Date(Date.now() - STUCK_MINS * 60000).toISOString();
    const tasks = await pgQuery(`
      SELECT id, title, status, stage, priority, assignee_agent_id, progress_percentage, updated_at, blocking_reason
      FROM app.tasks
      WHERE status NOT IN ('DONE', 'CANCELLED', 'COMPLETED')
        AND updated_at < '${cutoff}'
      ORDER BY priority DESC, updated_at ASC
      LIMIT 10
    `);

    const now = Date.now();
    const needsNudge = tasks.filter(t => {
      const stage = (t.stage || '').toUpperCase();
      // Only nudge if the task is in an active stage (mid-flight) OR never left PENDING/DISCUSS.
      const midFlight = ACTIVE_STAGES.includes(stage) || stage === 'PENDING' || stage === '';
      if (!midFlight) return false;

      // The pre-2026-10-17 state format stored a bare timestamp per task. Read
      // both, or the first run after this change would compute NaN and
      // silently stop nudging every task that had ever been nudged.
      const raw = state.lastNudged[t.id];
      const rec = typeof raw === 'number' ? { at: raw, count: 1 } : (raw || {});
      const count = rec.count || 0;
      if (count >= MAX_NUDGES) return false; // said our piece, three times

      const ageHrs = (now - new Date(t.updated_at).getTime()) / 3600000;
      if (ageHrs >= ABANDONED_HRS) return false; // abandoned, not stalled

      const last = rec.at || 0;
      return (now - last) / 60000 >= NUDGE_COOLDOWN_MINS;
    });

    if (needsNudge.length === 0) {
      console.log('[task-nudge] nothing to nudge (cooldown, max reached, or abandoned)');
      return;
    }

    const lines = needsNudge.map(t => {
      const mention = mentionFor(t.assignee_agent_id);
      const tag = mention ? ` @${mention}` : '';
      const ageMin = Math.round((now - new Date(t.updated_at).getTime()) / 60000);
      const stage = t.stage || 'PENDING';
      const block = t.blocking_reason ? `\n  ⛔ Blocking reason: ${t.blocking_reason}` : '';
      return `🕒 **${t.title}**${tag} — stage ${stage}, no update for ~${ageMin}min${block}`;
    });

    const msg = `⏰ **TASK NUDGE** — these assigned tasks appear stalled (no update for ${STUCK_MINS}+ min):\n\n${lines.join('\n')}\n\nPlease post a progress update or mark the task blocked. If you need help (tools, access, direction), say so explicitly and I'll unblock you.`;

    const res = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'task-nudge', message: msg, channel: 'fleet' }),
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      // Record the count, not just the time, so MAX_NUDGES can be enforced
      // across restarts. The old format stored a bare timestamp, which meant a
      // state file reset would silently un-nudge every task ever nudged.
      for (const t of needsNudge) {
        const prev = state.lastNudged[t.id] || {};
        state.lastNudged[t.id] = { at: now, count: (prev.count || 0) + 1, lastTitle: t.title };
      }
      saveState(state);
      console.log(`[task-nudge] nudged ${needsNudge.length} stalled task(s)`);
    } else {
      console.error(`[task-nudge] fleet chat post failed: HTTP ${res.status}`);
    }
    return;
  } catch (e) {
    console.error(`[task-nudge] FAIL: ${e.message}`);
  }
}

main();
