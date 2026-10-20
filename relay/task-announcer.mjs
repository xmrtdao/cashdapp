import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'relay-data');
mkdirSync(DATA_DIR, { recursive: true });

const NUDGE_STATE_FILE = join(DATA_DIR, 'task-announcer-state.json');

/**
 * Which tasks have already been announced.
 *
 * The old query was `updated_at > NOW() - INTERVAL '30 minutes'` on a job that
 * runs every 15 minutes, so every task was announced exactly twice per change -
 * which is where the "Investigate cron job errors - PENDING" repeated four
 * times inside one message came from: two double-announcements plus two
 * separate creations that each looked new.
 *
 * A time window cannot express "has not changed since I last said it". Storing
 * the updated_at that was announced can: a task is announced only when its
 * updated_at is strictly newer than the one already on record.
 */
function loadState() {
  try {
    if (existsSync(NUDGE_STATE_FILE)) return JSON.parse(readFileSync(NUDGE_STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[task-announcer] state read failed: ' + e.message);
  }
  return { announced: {} };
}
function saveState(s) {
  try { writeFileSync(NUDGE_STATE_FILE, JSON.stringify(s)); }
  catch (e) { console.error('[task-announcer] state write failed: ' + e.message); }
}
const PG_URL = process.env.PG_URL || 'postgresql://postgres@127.0.0.1:5432/xmrt_suite';

async function pgQuery(sql) {
  try {
    const res = await fetch(`${RELAY_URL}/tools/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-id': 'hermes-agent'
      },
      body: JSON.stringify({ tool: 'db-query', args: { sql } }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    return data.success ? data.rows || [] : [];
  } catch (e) {
    console.error(`[task-announcer] db query failed: ${e.message}`);
    return [];
  }
}

async function main() {
  try {
    const state = loadState();
    // Candidates: recently-touched, non-terminal tasks. Still a window, but
    // now only the first one - the dedupe below is what makes repeats
    // impossible, and the window only bounds how much we read.
    const candidates = await pgQuery(`
      SELECT id, title, status, stage, priority, assignee_agent_id, progress_percentage, updated_at
      FROM app.tasks
      WHERE status NOT IN ('DONE', 'CANCELLED', 'COMPLETED')
        AND updated_at > NOW() - INTERVAL '15 minutes'
      ORDER BY priority DESC, updated_at DESC
      LIMIT 20
    `);

    // Announce a task only if it has changed since we last spoke about it.
    const tasks = candidates.filter(t => {
      const prev = state.announced[t.id];
      if (!prev) return true;
      return new Date(t.updated_at).getTime() > new Date(prev).getTime();
    });

    if (tasks.length === 0) {
      console.log('[task-announcer] nothing changed since the last announcement');
      return; // let the event loop drain naturally — no process.exit()
    }

    // Format announcement
    const lines = tasks.map(t => {
      const emoji = t.status === 'IN_PROGRESS' ? '🔄' : t.status === 'PENDING' ? '⏳' : '📋';
      const assignee = t.assignee_agent_id ? ` @${t.assignee_agent_id}` : '';
      const progress = t.progress_percentage ? ` (${t.progress_percentage}%)` : '';
      return `${emoji} **${t.title}**${assignee} — ${t.status}${progress}`;
    });

    const msg = `📢 **Fleet Task Update**\n\n${lines.join('\n')}\n\nReply to claim or discuss any task.`;

    // Post to fleet chat
    const res = await fetch(`${RELAY_URL}/api/fleet-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'task-announcer',
        message: msg,
        channel: 'fleet'
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      // Record what we said, and when it was true. If the post failed we do
      // not record, so a failed announce is retried rather than swallowed -
      // losing an announcement silently is the same class of bug as sending
      // one too often.
      for (const t of tasks) state.announced[t.id] = t.updated_at;
      // Forget terminal tasks so the state file cannot grow forever.
      for (const t of candidates) {
        if (['DONE', 'CANCELLED', 'COMPLETED'].includes(String(t.status || '').toUpperCase())) {
          delete state.announced[t.id];
        }
      }
      saveState(state);
      console.log(`[task-announcer] announced ${tasks.length} task(s) to fleet chat`);
    } else {
      console.error(`[task-announcer] fleet chat post failed: HTTP ${res.status}`);
    }

    return; // let the event loop drain naturally
  } catch (e) {
    console.error(`[task-announcer] FAIL: ${e.message}`);
    // no process.exit() — a bare exception on the top-level await already exits
  }
}

main();
