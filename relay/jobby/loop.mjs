// relay/jobby/loop.mjs — the executor Jobby's planner never had
//
// relay/jobby/plan.mjs builds a list of actions for a candidate to read. Nothing
// has ever picked one up and done it. This is the thing that wakes up, looks at
// what is actually true in the database, decides what matters most, and does
// exactly one piece of it.
//
// Four properties, each chosen over the more obvious alternative:
//
//  1. THE DECISION IS CODE, NOT A MODEL.
//
//     Harvey's README puts it as: "It decides deterministically, not by asking
//     a model what to do - that would burn a call on something derivable from
//     four counts." The same holds here, and harder: the decision picks which
//     side of the send gate to approach, and a model that misreads the counts
//     does not produce a bad sentence, it produces a second send. Every branch
//     in decide() below is a comparison of integers.
//
//  2. A LEASE PER CLIENT, TAKEN ATOMICALLY.
//
//     The daily send cap is enforced by COUNTING rows in job_outreach. That is
//     only a cap if there is one writer. Two workers reading the cap at the
//     same moment both see room, and both send. So a cycle is entered through
//     tryLease(), which is a single INSERT ... ON CONFLICT ... WHERE, and which
//     returns no row - rather than throwing - when somebody else holds it.
//
//  3. A CYCLE THAT COULD NOT RUN IS NOT A SUCCESS.
//
//     The recurring failure in this repo is a check that reports clean when it
//     could not look. `ok` is false for unavailable and error, in code AND in a
//     CHECK constraint, and every cycle writes a row including the ones that
//     found nothing. A loop whose only evidence is silence cannot be told apart
//     from a wedged loop.
//
//  4. THE EXISTING GATES ARE CALLED, NEVER REIMPLEMENTED.
//
//     kill switch, draft mode, daily cap and the claimed-email gate all already
//     exist in store.canSend() and claim.assertCanRepresent(). This module holds
//     no notion of its own about whether it may send, because a second
//     implementation of the cap is a second, quieter version of the bug this
//     file exists to prevent. Steps that would send ask canSend() and stop when
//     it says no - recording the refusal as the reason, which is a finding, not
//     a failure.

import pg from 'pg';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/**
 * What the database says is true right now, for one client.
 * Four counts, because four counts is all a decision needs.
 */
export async function readCounts(pool, clientId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM app.job_applications
         WHERE client_id = $1 AND status = 'blocked')                        AS blocked,
       (SELECT count(*)::int FROM app.job_outreach
         WHERE client_id = $1 AND status IN ('queued','draft'))              AS queued_sends,
       (SELECT count(*)::int FROM app.job_applications
         WHERE client_id = $1 AND status = 'pending' AND packet IS NULL)    AS unprepared,
       (SELECT count(*)::int FROM app.job_opportunities
         WHERE client_id = $1 AND status = 'researched')                     AS researched,
       (SELECT count(*)::int FROM app.job_opportunities
         WHERE client_id = $1 AND status IN ('new','researched'))            AS pipeline_depth,
       (SELECT count(*)::int FROM app.job_outreach
         WHERE client_id = $1 AND status = 'sent'
           AND created_at > now() - INTERVAL '24 hours')                     AS sent_24h`,
    [clientId]
  );
  const r = rows[0] || {};
  return {
    blocked: r.blocked ?? 0,
    queuedSends: r.queued_sends ?? 0,
    unprepared: r.unprepared ?? 0,
    researched: r.researched ?? 0,
    pipelineDepth: r.pipeline_depth ?? 0,
    sent24h: r.sent_24h ?? 0,
  };
}

/**
 * Choose ONE thing to do. Pure, total, and synchronous on purpose.
 *
 * The order is not alphabetical and not by severity - it is by what goes stale
 * fastest. A reply waiting three days is a conversation that has already gone
 * cold; an unsent application is merely late. Everything that waits on a human
 * is deliberately absent, because a loop cannot unblock those and a loop that
 * keeps re-deciding to try is just noise in the log.
 *
 * @returns {{decision: string, reason: string}}
 */
export function decide(counts) {
  const c = counts || {};

  if (c.blocked > 0) {
    return {
      decision: 'blocked',
      reason: `${c.blocked} application(s) are blocked. A blocked application is the only thing here that is actively losing ground - everything else is waiting.`,
    };
  }
  if (c.queuedSends > 0) {
    return {
      decision: 'send',
      reason: `${c.queuedSends} message(s) are written and waiting. Sending is the step that turns work already done into income.`,
    };
  }
  if (c.unprepared > 0) {
    return {
      decision: 'packet',
      reason: `${c.unprepared} application(s) have no packet yet. Nothing can be sent on them until one is built.`,
    };
  }
  if (c.researched > 0) {
    return {
      decision: 'research',
      reason: `${c.researched} opportunit(y|ies) have been researched but not turned into an application.`,
    };
  }
  if (c.pipelineDepth < 5) {
    return {
      decision: 'source',
      reason: `Pipeline is ${c.pipelineDepth ?? 0} deep, under the floor of 5. Sourcing is cheaper than discovering the pipeline was empty later.`,
    };
  }
  return {
    decision: 'idle',
    reason: `Pipeline is ${c.pipelineDepth} deep and nothing is waiting. Nothing to do that would not be work for its own sake.`,
  };
}

/**
 * The full decision: what posture is the loop in, and therefore what is worth
 * doing this cycle.
 *
 * Kept separate from decide() so the counts stay testable on their own and the
 * waiting rule stays testable on its own. The composition matters more than
 * either half: escalate before waiting, and waiting before work. An event is
 * the world changing; an open question is us having asked; work is everything
 * else, and it is the thing that waits.
 *
 * @param {{counts: object, posture?: string, escalations?: Array, open?: object|null}} s
 */
export function choose({ counts, posture = 'work', escalations = [], open = null }) {
  if (posture === 'escalate') {
    return {
      decision: 'escalate',
      reason: `${escalations.length} event(s) break the wait: ${escalations.map((e) => e.kind).join(', ')}. This is the one thing that outranks a question the candidate has not answered yet.`,
    };
  }
  if (posture === 'waiting') {
    return {
      decision: 'wait',
      reason: open
        ? `asked the candidate a ${open.kind} at ${open.sent_at} and has not been answered. Working past your own question is talking over somebody.`
        : 'waiting on the candidate to answer. Nothing is pushed until they do.',
    };
  }
  if (posture === 'report') {
    return {
      decision: 'report',
      reason: 'nothing is outstanding and the cadence has elapsed, so the useful thing to do is tell them what actually changed.',
    };
  }
  return decide(counts);
}

/**
 * Take the lease, or return null because somebody else holds it.
 *
 * Null rather than throw, on purpose: not holding a lease is the single most
 * common outcome of a loop with more than one worker, and a caller that had to
 * catch an exception for it would eventually swallow real errors the same way.
 *
 * The WHERE on the DO UPDATE is the whole mechanism. An expired lease or one
 * this worker already holds is taken; a live lease held by anyone else is not,
 * and the statement matches no row.
 */
export async function tryLease(pool, clientId, workerId, leaseMs = DEFAULT_LEASE_MS) {
  const { rows } = await pool.query(
    `INSERT INTO app.job_cycle_leases (client_id, worker_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
     ON CONFLICT (client_id) DO UPDATE
        SET worker_id = EXCLUDED.worker_id,
            acquired_at = now(),
            expires_at = EXCLUDED.expires_at
      WHERE app.job_cycle_leases.expires_at < now()
         OR app.job_cycle_leases.worker_id = EXCLUDED.worker_id
     RETURNING client_id`,
    [clientId, workerId, leaseMs / 1000]
  );
  return rows.length === 1;
}

export async function releaseLease(pool, clientId, workerId) {
  const { rowCount } = await pool.query(
    `DELETE FROM app.job_cycle_leases
      WHERE client_id = $1 AND worker_id = $2`,
    [clientId, workerId]
  );
  return rowCount === 1;
}

/** Record the cycle. Always. Including the ones where nothing happened. */
export async function recordCycle(pool, cycle) {
  const { rows } = await pool.query(
    `INSERT INTO app.job_cycles
       (client_id, worker_id, started_at, finished_at, decision, reason, status, ok, steps, error)
     VALUES ($1,$2,COALESCE($3, now()),$4,$5,$6,$7,$8,$9::jsonb,$10)
     RETURNING id`,
    [
      cycle.clientId,
      cycle.workerId,
      cycle.startedAt ?? null,
      cycle.finishedAt ?? null,
      cycle.decision ?? null,
      cycle.reason ?? null,
      cycle.status,
      cycle.ok === true,
      JSON.stringify(cycle.steps ?? []),
      cycle.error ?? null,
    ]
  );
  return rows[0]?.id ?? null;
}

/**
 * One pass for one client.
 *
 * `steps` is injected so the decision and the recording can be tested without
 * a database and without a mail server. The default runs nothing but the drift
 * check, because that is the only step that is unambiguously safe to run
 * unattended while the rest are being built.
 */
export async function runCycle({ pool, clientId, workerId, steps = {}, leaseMs = DEFAULT_LEASE_MS, posture = null }) {
  const held = await tryLease(pool, clientId, workerId, leaseMs);
  if (!held) {
    return { status: 'skipped', ok: false, reason: 'another worker holds the lease for this client' };
  }

  const startedAt = new Date();
  // Which phase we are in, so the catch block can name the real failure rather
  // than assuming it was the read. Set before each await that can throw.
  let phase = 'read the client state';
  try {
    const counts = await readCounts(pool, clientId);

    // The posture is optional. When it is absent the loop is in the ordinary
    // working state, which is what a caller that knows nothing about check-ins
    // should get - not a guess about whether somebody is waiting.
    let state = posture;
    if (!state) {
      state = { posture: 'work', escalations: [], open: null };
    }
    const { decision, reason } = choose({ counts, posture: state.posture, escalations: state.escalations, open: state.open });

    const performed = [];
    phase = 'run the steps';
    for (const name of Object.keys(steps)) {
      if (steps[name].only && !steps[name].only.includes(decision)) continue;
      try {
        const r = await steps[name].run({ clientId, counts, decision, reason, pool, posture: state });
        performed.push({ step: name, ok: r?.ok !== false, note: r?.note ?? null });
      } catch (err) {
        // A failing step is a finding. It is recorded and the cycle continues,
        // because one broken step is not evidence that the rest are broken.
        performed.push({ step: name, ok: false, note: String(err?.message || err) });
      }
    }

    const anyFailed = performed.length > 0 && performed.every((s) => s.ok === false);
    const status = performed.length === 0 ? 'no_work' : anyFailed ? 'error' : 'ran';
    const out = {
      status,
      ok: status === 'ran' || (status === 'no_work' && anyFailed === false),
      decision,
      reason,
      posture: state.posture,
      counts,
      steps: performed,
    };
    // finishedAt is not optional decoration. job_cycles_settled_has_a_time
    // refuses any row whose status is ran or no_work without one, and this
    // call omitted it - so every settled cycle raised inside this try, was
    // caught below, and was re-recorded as 'unavailable' with a constraint
    // error as its explanation. 542 cycles read "the cycle could not read the
    // client state" and not one of them had failed to read anything: they had
    // failed to write down that they had succeeded. The reason field said
    // 'unavailable' because the writer was the thing that was broken.
    const finishedAt = new Date().toISOString();
    phase = 'record its own result';
    const id = await recordCycle(pool, { clientId, workerId, startedAt, finishedAt, status: out.status, ok: out.ok, decision, reason, steps: performed });
    out.cycleId = id;
    out.startedAt = startedAt.toISOString();
    return out;
  } catch (err) {
    const message = String(err?.message || err);
    // Name the phase that failed instead of asserting a read failure. A cycle
    // that broke while writing its own result is a different defect from one
    // that broke reading state, and telling them apart costs one variable.
    const failedDuring = phase;
    // ok is false here and the CHECK constraint refuses anything else.
    const id = await recordCycle(pool, {
      clientId, workerId, status: 'unavailable', ok: false,
      reason: `the cycle could not ${failedDuring}`, error: message,
    });
    return { status: 'unavailable', ok: false, reason: `the cycle could not ${failedDuring}`, error: message, cycleId: id };
  } finally {
    await releaseLease(pool, clientId, workerId).catch(() => {});
  }
}

/**
 * The heartbeat.
 *
 * Quiet hours and a max-cycles-per-tick are here rather than in the caller,
 * because a loop that only knows how to run on every tick is a loop that will
 * run at 3am and will run twice if the interval is misread.
 *
 * `steps` is a parameter, not something each caller assembles. The heartbeat
 * previously took no steps at all, so every tick ran
 * `for (const name of Object.keys({}))` — decided a decision, performed
 * nothing, and recorded a cycle that said so. 543 times.
 */
export function createHeartbeat({ pool, workerId, intervalMs = 15 * 60 * 1000, quietHours = null, steps = {}, log = () => {} }) {
  let timer = null;
  let running = false;

  function inQuietHours(now) {
    if (!quietHours) return false;
    const { from, to } = quietHours;
    const h = now.getHours();
    return from <= to ? h >= from && h < to : h >= from || h < to;
  }

  async function tick() {
    if (running) { log('tick skipped: previous tick still running'); return; }
    running = true;
    try {
      const { rows } = await pool.query(
        `SELECT id FROM app.job_clients
          WHERE kill_switch IS NOT TRUE
          ORDER BY id`
      );
      if (inQuietHours(new Date())) {
        log(`quiet hours: ${rows.length} client(s) skipped`);
        return;
      }
      for (const { id } of rows) {
        try {
          const r = await runCycle({ pool, clientId: id, workerId, steps });
          log(`${id} ${r.status}${r.decision ? ' → ' + r.decision : ''}` +
            (r.steps?.length ? ' [' + r.steps.map(s => `${s.step}:${s.ok ? 'ok' : 'FAIL'}${s.note ? ' ' + s.note : ''}`).join('; ') + ']' : ''));
        } catch (err) {
          // Per-client isolation. One client's failure must not stop the loop
          // for everyone else, which is the difference between a loop and a
          // single point of failure wearing a loop's clothes.
          log(`${id} CRASHED: ${err?.message || err}`);
        }
      }
    } catch (err) {
      log(`tick failed: ${err?.message || err}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return this;
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
      log(`heartbeat started: worker=${workerId} interval=${intervalMs}ms`);
      return this;
    },
    async stop() {
      if (timer) { clearInterval(timer); timer = null; log('heartbeat stopped'); }
    },
    tick,
  };
}

export function defaultWorkerId() {
  const host = process.env.COMPUTERNAME || process.env.HOSTNAME || 'worker';
  return `${host}:${process.pid}`;
}

export { pg };
