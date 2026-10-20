#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fleet-announcer.mjs — the 30-minute fleet summary, spoken.
//
// WHAT THIS IS
// Every 30 minutes, gather what actually happened and put ONE message on the
// fleet board: what the agents were discussing, how the task board moved, what
// errored, what the fleet actually produced, and what should happen next. It
// carries `speech`, so the operator's dashboard reads it aloud through the free
// browser voice — the same escalation channel agents use, reached from a cron
// instead of from an agent.
//
// EVERY NUMBER HERE IS A QUERY RESULT
// There is no model in this script. That is a deliberate constraint, not a
// limitation of the build: a summary that reaches a human's ears has to be
// checkable, and a generated "the fleet is making good progress" is the exact
// thing that would be unfalsifiable. If a section has nothing to report, it says
// nothing happened. A quiet window produces a short, honest post — never a
// padded one.
//
// NEXT STEPS ARE DERIVED, NOT PREDICTED
// Each item in the plan is a response to something observed in this window (a
// job failing, tasks stalling, a repeat loop, zero completions against N runs).
// No step is offered because it sounds like good practice.
//
// RESPECTING THE SWITCH
// If the operator has the voice off, this still posts to the board — the
// summary is information and they may want to read it — but posts it as an
// ordinary message. Muting the voice must not quietly delete the reporting.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8080';
const PG_URL = process.env.PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

// Window: the gap since the previous announcement, so consecutive summaries
// cover consecutive periods instead of overlapping one fixed hour.
const argMinutes = Number((process.argv.find(a => a.startsWith('--minutes=')) || '').split('=')[1]);
const WINDOW_MIN = Number.isFinite(argMinutes) && argMinutes > 0 ? argMinutes : 30;

const TERMINAL = ['DONE', 'COMPLETED', 'CANCELLED', 'CLOSED'];
// "Completed" has to mean finished, not merely no longer open. Folding
// CANCELLED and CLOSED in reported 445 completions in 24h against 0 tasks
// actually DONE — the same board, two opposite stories, from one careless IN
// list. A summary that flatters by counting abandments as wins is worse than no
// summary.
const FINISHED = ['DONE', 'COMPLETED'];

function ago(min) { return new Date(Date.now() - min * 60000).toISOString(); }

// ── evidence ──
async function gather(db) {
  const q = async (label, sql, params) => {
    const t0 = Date.now();
    try {
      const r = await db.query(sql, params);
      return { ok: true, rows: r.rows, ms: Date.now() - t0 };
    } catch (e) {
      // A missing table is not a reason to lose the whole summary. Record it and
      // let the section say "not available" — silence about a broken query reads
      // as "nothing wrong", which is the failure mode this script exists to stop.
      console.warn(`[announcer] query "${label}" failed: ${e.message}`);
      return { ok: false, error: e.message, rows: [] };
    }
  };

  const since = ago(WINDOW_MIN);
  const sinceDay = ago(60 * 24);

  // Sequential, not Promise.all. A single pg Client cannot have two queries in
  // flight: the second one is queued against the first and the driver warns that
  // the behaviour is going away. These are millisecond queries on a local
  // database, so waiting costs nothing and buys not one deprecation warning per
  // run that will eventually become a dropped query.
  const chat = await q('chat', `SELECT agent_id,
              -- First NON-EMPTY line only. Taking the first 160 characters of the
              -- whole message splices the opening line into the middle of a
              -- paragraph and produces "Herme  back online ... mobilemone", which
              -- is not a thing anyone said.
              split_part(coalesce(nullif(split_part(message, E'\\n', 1), ''),
                                  nullif(split_part(message, E'\\n', 2), ''),
                                  split_part(message, E'\\n', 3)), '**', 1) AS line,
              created_at
              FROM public.fleet_messages WHERE created_at > $1 ORDER BY created_at ASC LIMIT 200`, [since]);
  const chatByAgent = await q('chatByAgent', `SELECT agent_id, count(*)::int AS n FROM public.fleet_messages
                     WHERE created_at > $1 GROUP BY 1 ORDER BY n DESC`, [since]);
  // Repeated identical first lines are a signal in their own right: a job
  // posting the same thing every cycle is a loop, not activity.
  const dupes = await q('dupes', `SELECT left(split_part(regexp_replace(message, E'\\s+', ' ', 'g'), '**', 1), 90) AS line, count(*)::int AS n
               FROM public.fleet_messages WHERE created_at > $1
               GROUP BY 1 HAVING count(*) > 1 ORDER BY n DESC LIMIT 5`, [since]);
  const created = await q('created', `SELECT count(*)::int AS n FROM app.tasks WHERE created_at > $1`, [since]);
  const completed = await q('completed', `SELECT id, left(title, 80) AS title, updated_at FROM app.tasks
                    WHERE status = ANY($2::text[]) AND updated_at > $1 ORDER BY updated_at DESC LIMIT 8`, [since, FINISHED]);
  const moved = await q('moved', `SELECT id, left(title, 70) AS title, status, assignee_agent_id, progress_percentage, updated_at
                FROM app.tasks WHERE status <> ALL($2::text[]) AND updated_at > $1
                ORDER BY updated_at DESC LIMIT 8`, [since, TERMINAL]);
  const stalled = await q('stalled', `SELECT id, left(title, 70) AS title, status, assignee_agent_id, updated_at
                  FROM app.tasks WHERE status <> ALL($2::text[]) AND assignee_agent_id IS NOT NULL
                  AND updated_at < $1 ORDER BY priority DESC NULLS LAST, updated_at ASC LIMIT 6`, [ago(WINDOW_MIN + 20), TERMINAL]);
  const blocked = await q('blocked', `SELECT count(*)::int AS n FROM app.tasks WHERE blocking_reason IS NOT NULL
                  AND status <> ALL($1::text[])`, [TERMINAL]);
  const statusCounts = await q('statusCounts', `SELECT status, count(*)::int AS n FROM app.tasks GROUP BY 1 ORDER BY n DESC`);
  // `result` is jsonb and `error` is text, so COALESCE has to be told which is
  // which. Coalescing them raw fails at parse time and this section silently
  // becomes "no failures recorded", which is the one answer that must never be
  // produced by a broken query.
  const cronFail = await q('cronFail', `SELECT job_name, left(coalesce(error, result::text, ''), 120) AS err, count(*)::int AS n,
                          max(created_at) AS last_at
                   FROM cron_execution_log WHERE status <> 'completed' AND created_at > $1
                   GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`, [since]);
  const done24h = await q('done24h', `SELECT count(*)::int AS n FROM app.tasks WHERE status = ANY($2::text[]) AND updated_at > $1`, [sinceDay, FINISHED]);
  const closed24h = await q('closed24h', `SELECT count(*)::int AS n FROM app.tasks
                       WHERE status = ANY($2::text[]) AND updated_at > $1`, [sinceDay, ['CANCELLED', 'CLOSED']]);

  let services = null;
  try {
    const r = await fetch(`${RELAY}/api/supervisor/status`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) services = await r.json();
  } catch (e) {
    console.warn(`[announcer] supervisor status unavailable: ${e.message}`);
  }

  return { chat, chatByAgent, dupes, created, completed, moved, stalled, blocked,
           statusCounts, cronFail, done24h, closed24h, services };
}

// ── rendering ──
// Cut at a word boundary. Slicing mid-word ("mobilemone") turns a quoted line
// into something the operator never said.
function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

// A line of pure emoji is not a topic. Without this, an image-only post
// contributes "📥" as a discussion topic and "Investigate repeated post: '' ×4"
// as a next step — which is not a finding, it is an artefact of reading the
// wrong column.
function meaningful(s) {
  const letters = String(s || '').replace(/[^\p{L}\p{N}]/gu, '');
  return letters.length >= 3;
}

function renderBoard(e) {
  const L = [];
  L.push(`📢 **Fleet summary — last ${WINDOW_MIN} minutes**`);
  L.push('');

  // 1. Discussion
  const chat = e.chat.rows;
  const byAgent = e.chatByAgent.rows;
  L.push(`**Discussion** — ${chat.length} message${chat.length === 1 ? '' : 's'}` +
    (byAgent.length ? ` (${byAgent.map(a => `${a.agent_id}: ${a.n}`).join(', ')})` : ''));
  if (chat.length) {
    const topics = new Map();
    for (const m of chat) {
      // Collapse identical subjects so a loop shows up as a repeat count rather
      // than as several separate lines of "activity".
      const k = clip(m.line, 68);
      if (meaningful(k)) topics.set(k, (topics.get(k) || 0) + 1);
    }
    const top = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [k, n] of top) L.push(`- ${n > 1 ? `(${n}×) ` : ''}${k}`);
  } else {
    L.push('- No fleet chat traffic in this window.');
  }

  // 2. Task movement
  L.push('');
  L.push(`**Task movement** — ${e.created.rows[0]?.n ?? 0} created, ${e.completed.rows.length} completed`);
  const open = e.statusCounts.rows.filter(r => !TERMINAL.includes(r.status));
  const inProgress = e.statusCounts.rows.find(r => r.status === 'IN_PROGRESS');
  L.push(`- Open board: ${open.reduce((a, r) => a + r.n, 0)} across ${open.length} status` +
    (inProgress ? `, ${inProgress.n} in progress` : ''));
  for (const t of e.moved.rows.slice(0, 4)) {
    L.push(`- **${t.title}** — ${t.status}${t.assignee_agent_id ? ` @${t.assignee_agent_id}` : ''}${t.progress_percentage != null ? ` ${t.progress_percentage}%` : ''}`);
  }
  if (!e.moved.rows.length) L.push('- Nothing updated in this window.');

  // 3. Errors
  L.push('');
  const unhealthy = e.services ? (e.services.services || []).filter(s => !s.healthy) : null;
  const flapping = e.services ? (e.services.services || []).filter(s => s.flapping || s.lastHourRestarts > 0) : [];
  const cronFails = e.cronFail.rows;
  L.push(`**Errors**`);
  if (cronFails.length) {
    for (const f of cronFails) L.push(`- \`${f.job_name}\` failed ${f.n}× — ${f.err || 'no detail'} (last ${f.last_at})`);
  } else {
    L.push('- No cron job failures recorded in this window.');
  }
  if (unhealthy) L.push(unhealthy.length ? `- Services unhealthy: ${unhealthy.map(s => s.name).join(', ')}` : '- All supervised services healthy.');
  if (flapping.length) L.push(`- Restarted or flapping in the last hour: ${flapping.map(s => s.name).join(', ')}`);
  for (const qk of ['chat', 'completed', 'stalled', 'cronFail', 'statusCounts']) {
    if (e[qk] && e[qk].ok === false) L.push(`- \`${qk}\` could not be read: ${e[qk].error}`);
  }

  // 4. Productivity
  // There is no task executor. This section used to report "Executor ran Nx" by
  // counting `agent-work-executor` rows, which is why the fleet kept discussing a
  // job that was removed: the announcer was its last public voice. It now reports
  // only what actually happened, and says plainly that nothing runs tasks
  // automatically when nothing does.
  L.push('');
  const doneWin = e.completed.rows.length;
  const doneDay = e.done24h.rows[0]?.n ?? 0;
  const closedDay = e.closed24h.rows[0]?.n ?? 0;
  L.push(`**Productivity**`);
  L.push(`- ${doneWin} task${doneWin === 1 ? '' : 's'} finished this window (no automated executor exists).`);
  L.push(`- Last 24h: ${doneDay} finished (DONE/COMPLETED), ${closedDay} cancelled or closed. Tasks marked blocked: ${e.blocked.rows[0]?.n ?? 0}.`);
  const stalled = e.stalled.rows;
  if (stalled.length) L.push(`- Stalled (assigned, no movement in ${WINDOW_MIN + 20}+ min): ${stalled.length} shown.`);
  for (const d of e.dupes.rows.slice(0, 2)) L.push(`- Repeated ${d.n}× this window: "${d.line}"`);

  // 5. Next steps — every line answers something above.
  const steps = [];
  for (const f of cronFails) steps.push(`Fix \`${f.job_name}\` — ${f.err || 'failing'} (${f.n}× in ${WINDOW_MIN}m).`);
  // Only repeats that contain words. An image-only post repeated four times is
  // not a loop worth a next step; it is an empty string with a count on it.
  for (const d of e.dupes.rows.filter(x => meaningful(x.line))) {
    steps.push(`Investigate repeated post: "${clip(d.line, 70)}" ×${d.n} — a loop, not progress.`);
  }
  if (stalled.length) steps.push(`Nudge or unassign ${stalled.length} stalled task(s); oldest: "${stalled[0].title}" (${stalled[0].assignee_agent_id || 'unassigned'}).`);
  if (doneDay === 0 && open.some(r => r.status === 'IN_PROGRESS')) steps.push('Nothing finished in 24h while tasks are IN_PROGRESS — throughput is zero; a person has to unblock them.');
  if (unhealthy && unhealthy.length) steps.push(`Restore ${unhealthy.map(s => s.name).join(', ')} — reported unhealthy right now.`);
  if (!steps.length) steps.push('Nothing requires intervention in this window.');

  L.push('');
  L.push(`**Next steps**`);
  steps.slice(0, 5).forEach((s, i) => L.push(`${i + 1}. ${s}`));

  L.push('');
  L.push(`<sub>Generated by relay/scripts/fleet-announcer.mjs from direct queries. No model in this loop; every count above is reproducible.</sub>`);
  return L.join('\n');
}

// The spoken version. Deliberately shorter than the board post: an announcement
// read verbatim is a wall of numbers, and the numbers the operator needs first
// are the ones that demand something of them.
function renderSpeech(e) {
  const chat = e.chat.rows.length;
  const doneWin = e.completed.rows.length;
  const doneDay = e.done24h.rows[0]?.n ?? 0;
  const cronFails = e.cronFail.rows;
  const unhealthy = e.services ? (e.services.services || []).filter(s => !s.healthy) : [];
  const stalled = e.stalled.rows.length;

  const bits = [`Fleet summary for the last ${WINDOW_MIN} minutes.`];
  bits.push(`${chat} fleet chat message${chat === 1 ? '' : 's'}.`);
  bits.push(`${e.created.rows[0]?.n ?? 0} tasks created, ${doneWin} finished.`);
  bits.push(`${doneDay} tasks finished in the last day.`);

  if (cronFails.length) {
    const names = cronFails.slice(0, 2).map(f => f.job_name).join(' and ');
    bits.push(`Attention: ${cronFails.length} cron job${cronFails.length === 1 ? '' : 's'} failing, ${cronFails.length === 1 ? 'it is' : 'they are'} ${names}.`);
  }
  if (unhealthy.length) bits.push(`${unhealthy.length} service${unhealthy.length === 1 ? ' is' : 's are'} unhealthy.`);
  if (stalled) bits.push(`${stalled} stalled task${stalled === 1 ? '' : 's'}.`);
  for (const d of e.dupes.rows.slice(0, 1)) bits.push(`A post repeated ${d.n} times this window, which looks like a loop.`);

  return bits.join(' ').slice(0, 880);
}

// ── post ──
async function main() {
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  let evidence;
  try {
    evidence = await gather(db);
  } finally {
    await db.end();
  }

  const board = renderBoard(evidence);
  const speech = renderSpeech(evidence);

  // The operator's switch, read at post time. Muted means the message is posted
  // as ordinary board traffic: the voice is off, the reporting is not.
  let muted = false;
  try {
    const r = await fetch(`${RELAY}/api/announcer`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) muted = (await r.json()).muted === true;
  } catch (e) {
    console.warn(`[announcer] could not read voice state (${e.message}); posting as board text only`);
  }

  const res = await fetch(`${RELAY}/api/fleet-chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-id': 'announcer' },
    body: JSON.stringify({
      agent: 'announcer',
      message: board,
      speech,
      announce: !muted,
      channel: 'fleet',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[announcer] post failed HTTP ${res.status}: ${data.error || ''}`);
    process.exit(1);
  }
  if (data.success === false) {
    console.log(`[announcer] not spoken (${data.reason}): ${data.detail || ''}`);
    // The voice is rate-limited; the report is not. A summary cycle that lost its
    // slot to a cooldown would otherwise leave the operator with nothing at all,
    // which is the opposite of what a status announcement is for. So the same
    // post goes up as ordinary board text — readable, silent.
    if (data.reason === 'cooldown' || data.reason === 'fleet-budget') {
      const quiet = await fetch(`${RELAY}/api/fleet-chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-id': 'announcer' },
        body: JSON.stringify({ agent: 'announcer', message: board, channel: 'fleet' }),
        signal: AbortSignal.timeout(20000),
      });
      const q = await quiet.json().catch(() => ({}));
      if (q.success) console.log('[announcer] posted to the board only (voice budget spent)');
    }
  } else {
    console.log(`[announcer] posted${muted ? ' (voice muted — board only)' : ' and armed for speech'}`);
  }
  // Let the event loop drain naturally: a bare process.exit() while an
  // AbortSignal timer is pending trips a libuv assertion that the cron engine
  // records as a FAIL.
}

main().catch((e) => {
  console.error(`[announcer] FAIL: ${e.stack || e.message}`);
  process.exit(1);
});