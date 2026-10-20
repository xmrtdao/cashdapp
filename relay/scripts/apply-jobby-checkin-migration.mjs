#!/usr/bin/env node
// Apply the check-in migration, then verify by breaking the rules it promises.
//
// The promise is one unanswered question per client, ever. That is only true if
// the index refuses a second one, so that is what gets tested - not the CREATE.
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite';
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  let failed = 0;
  const ok = (label, cond, extra = '') => {
    if (cond) console.log('    PASS  ' + label);
    else { failed += 1; console.log('    FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
  };

  const sql = readFileSync(join(here, '..', 'migrations', 'jobby_009_checkin.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '60s'");
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('\n  migration applied');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('  migration FAILED:', e.message);
    await pool.end();
    process.exit(1);
  } finally {
    client.release();
  }

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='app' AND table_name IN ('job_checkins','job_escalations') ORDER BY 1`
  );
  ok('both tables exist', tables.rows.length === 2, tables.rows.map(r => r.table_name).join(','));

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='app'
      AND indexname IN ('job_checkins_one_open_idx','job_escalations_one_unacted_idx')`
  );
  const idxNames = idx.rows.map(r => r.indexname);
  console.log('\n  indexes: %s', idxNames.join(', ') || '(none)');
  ok('the one-open-check-in index exists', idxNames.includes('job_checkins_one_open_idx'));

  const owner = await pool.query(
    `INSERT INTO app.job_clients (session_key, display_name, daily_send_cap)
     VALUES ('verify-checkin-' || floor(random()*1e9)::text, 'Checkin Verify', 15)
     ON CONFLICT (session_key) DO UPDATE SET display_name = 'Checkin Verify'
     RETURNING id`
  );
  const clientId = owner.rows[0].id;

  const { openCheckinWith, answerCheckin, recordEscalation, markEscalationActed, loopPosture, classifyInbound } =
    await import(pathToFileURL(join(here, '..', 'jobby', 'checkin.mjs')).href);

  // THE anti-spam property, through the real module.
  const first = await openCheckinWith({
    pool, clientId, kind: 'question', to: 'joeyleepcs@gmail.com',
    from: 'jobby@jobbymcjobberson.com', subject: 'One question', body: 'Which track first?',
  });
  ok('a first check-in is accepted', first.ok === true, JSON.stringify(first));

  const second = await openCheckinWith({
    pool, clientId, kind: 'progress', to: 'joeyleepcs@gmail.com',
    from: 'jobby@jobbymcjobberson.com', subject: 'While you were away', body: 'Three things moved.',
  });
  ok('a SECOND check-in is refused while the first is open',
    second.ok === false && second.status === 'declined', JSON.stringify(second));

  // And it is the database refusing, not the function.
  let dbRefused = false;
  try {
    await pool.query(
      `INSERT INTO app.job_checkins (client_id, kind, from_address, to_address, body)
       VALUES ($1,'progress','a@b.test','c@d.test','raw insert, bypassing the module')`,
      [clientId]
    );
  } catch (e) {
    dbRefused = /job_checkins_one_open_idx/.test(e.message);
  }
  ok('a raw INSERT bypassing the module is refused by the index', dbRefused);

  ok('the loop is waiting, and may not push work',
    loopPosture({ open: { kind: 'question', sent_at: 'now' }, escalations: [], now: new Date() }).mayWork === false);

  const answered = await answerCheckin(pool, clientId, 'track 3 first');
  ok('answering closes the question', answered?.id === first.id, JSON.stringify(answered));

  const third = await openCheckinWith({
    pool, clientId, kind: 'progress', to: 'joeyleepcs@gmail.com',
    from: 'jobby@jobbymcjobberson.com', subject: 'Progress', body: 'Now that you answered.',
  });
  ok('once answered, the loop may speak again', third.ok === true, JSON.stringify(third));
  await answerCheckin(pool, clientId, 'ok');

  // An empty note is the failure that looks most like working.
  const blank = await openCheckinWith({
    pool, clientId, kind: 'progress', to: 'joeyleepcs@gmail.com',
    from: 'jobby@jobbymcjobberson.com', subject: 'x', body: '   ',
  });
  ok('a blank check-in is refused', blank.ok === false, JSON.stringify(blank));

  // An urgent note must get through even when a question is open, or the loop
  // holds an offer behind its own unanswered question - the one failure that
  // would cost the candidate the job.
  const q = await openCheckinWith({
    pool, clientId, kind: 'question', to: 'joeyleepcs@gmail.com',
    from: 'jobby@jobbymcjobberson.com', subject: 'Which track?', body: 'Three or five?',
  });
  ok('a question is open', q.ok === true, JSON.stringify(q));

  const urgent = await openCheckinWith({
    pool, clientId, kind: 'urgent', urgent: true, decision: 'escalate',
    to: 'joeyleepcs@gmail.com', from: 'jobby@jobbymcjobberson.com',
    subject: 'An offer came in', body: 'They want you on the platform team.',
  });
  ok('an urgent note gets through an open question', urgent.ok === true, JSON.stringify(urgent));
  ok('...and says which question it superseded', urgent.supersededId === q.id, JSON.stringify(urgent));

  const stillOpen = await pool.query(
    `SELECT count(*)::int AS n FROM app.job_checkins WHERE client_id = $1 AND still_open`, [clientId]);
  ok('still exactly one open check-in afterwards', stillOpen.rows[0].n === 1, JSON.stringify(stillOpen.rows[0]));

  const sup = await pool.query(
    `SELECT answered_at FROM app.job_checkins WHERE id = $1`, [q.id]);
  ok('the superseded question is not recorded as ANSWERED',
    sup.rows[0].answered_at === null, JSON.stringify(sup.rows[0]));
  await answerCheckin(pool, clientId, 'ack');

  // ...and if the urgent send FAILS, the question comes back.
  const q2 = await openCheckinWith({
    pool, clientId, kind: 'question', to: 'joeyleepcs@gmail.com',
    from: 'jobby@jobbymcjobberson.com', subject: 'Rate?', body: 'What is your floor?',
  });
  const failedUrgent = await openCheckinWith({
    pool, clientId, kind: 'urgent', urgent: true,
    to: 'joeyleepcs@gmail.com', from: 'jobby@jobbymcjobberson.com',
    subject: 'Offer', body: 'They said yes.',
    send: async () => { throw new Error('resend 502'); },
  });
  ok('a failed urgent send is reported, not swallowed', failedUrgent.ok === false, JSON.stringify(failedUrgent));
  const restored = await pool.query(
    `SELECT still_open, answered_at FROM app.job_checkins WHERE id = $1`, [q2.id]);
  ok('...and the question it superseded is put back',
    restored.rows[0].still_open === true && restored.rows[0].answered_at === null, JSON.stringify(restored.rows[0]));
  await answerCheckin(pool, clientId, 'ack');

  // Escalations: once per unacted, and they break the wait.
  const e1 = await recordEscalation(pool, clientId, 'offer', { from: 'recruiter@example.test' });
  const e2 = await recordEscalation(pool, clientId, 'offer', { from: 'recruiter@example.test' });
  ok('an offer raises an escalation', e1.raised === true, JSON.stringify(e1));
  ok('the same offer twice raises it once', e2.raised === false, JSON.stringify(e2));

  const posture = loopPosture({ open: null, escalations: [{ kind: 'offer' }], now: new Date() });
  ok('an escalation breaks the wait', posture.posture === 'escalate', JSON.stringify(posture));

  ok('an escalation can be acted on once', await markEscalationActed(pool, e1.id, 'candidate notified'));
  ok('...and not twice', (await markEscalationActed(pool, e1.id, 'again')) === false);

  const unknown = await recordEscalation(pool, clientId, 'vibes', {}).catch((err) => err);
  ok('an invented escalation kind is refused', /unknown escalation kind/.test(String(unknown?.message || unknown)));

  // Classification, which decides whether the wait ends.
  ok('an offer letter escalates',
    classifyInbound('We would like to offer you the role').kind === 'offer');
  ok('an interview invite escalates',
    classifyInbound('Can you do a technical screen this week?').kind === 'interview');
  ok('a deadline escalates',
    classifyInbound('Please respond by Friday').kind === 'deadline');
  ok('ordinary chatter does not escalate',
    classifyInbound('Thanks for applying, we will be in touch').escalate === false);

  await pool.query(`DELETE FROM app.job_clients WHERE id = $1`, [clientId]);

  console.log(failed === 0
    ? '\n  verified: one open question at a time, and an event can break the wait'
    : `\n  ${failed} check(s) failed`);
  process.exitCode = failed === 0 ? 0 : 1;
  await pool.end();
}

main().catch((e) => { console.error('  ' + e.message); process.exit(1); });
