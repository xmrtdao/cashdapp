// relay/jobby/consolidate-rows.mjs — move a doomed client's rows without losing them
//
// WHY THIS EXISTS
//
// app.job_clients is the parent of twenty tables, every one of them
// ON DELETE CASCADE. reconcile.mjs deletes the duplicate's row. Anything not
// moved first is destroyed by the cascade - silently, inside the same
// transaction, with a successful commit.
//
// That is not hypothetical. job_applications was missing from the move list, so
// consolidating two records for one person deleted the entire application
// pipeline for that person: every packet, every eligibility verdict, every
// blocker, and the submitted_at that proves an application actually went out.
// job_claim_verifications went with it, which is evidence that a claim was
// checked against an independent source. job_client_mailboxes went with it,
// which is how a reply to a pre-rename address finds the right person.
//
// WHY A BLANKET UPDATE IS ALSO WRONG
//
// Six of those twenty tables carry a uniqueness constraint that the move itself
// can violate, and the most common one is not an edge case: job_applications is
// unique on (client_id, lower(url)), so two devices that applied to the SAME job
// produce exactly the collision a blanket UPDATE aborts on. The whole
// consolidation - including the dossier merge that already succeeded - rolls
// back. So the move resolves collisions rather than avoiding them, and reports
// what it had to drop.
//
// THE RULE THAT MATTERS MOST
//
// A verified verdict is never downgraded by a merge. If the doomed record holds
// "verified" and the survivor holds nothing, the survivor inherits "verified".
// Losing a verification is as damaging as losing the application it verified,
// and a merge is not allowed to be the thing that does it.

/** Strongest first. A merge takes the leftmost verdict present. */
export const VERDICT_RANK = ['verified', 'disputed', 'corroborated', 'unverifiable'];

function strongerOf(a, b) {
  const ai = VERDICT_RANK.indexOf(a);
  const bi = VERDICT_RANK.indexOf(b);
  if (ai === -1) return b ?? null;
  if (bi === -1) return a ?? null;
  return ai <= bi ? a : b;
}

function tableExists(client, table) {
  return client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='app' AND table_name=$1`, [table]
  ).then((r) => r.rowCount > 0);
}

/**
 * Move `table` from doomed to survivor, resolving uniqueness by hand.
 *
 * @param {import('pg').PoolClient} client  inside the caller's transaction
 * @param {string} table
 * @param {number} survivorId
 * @param {number[]} doomedIds
 * @param {object} opts  { column?, unique?, report, absorb? }
 * @returns {Promise<number>} rows moved
 */
async function moveColliding(client, table, survivorId, doomedIds, opts = {}) {
  const { report } = opts;
  const [colA, colB] = opts.unique || [];

  // Pull the doomed rows' keys, one row at a time, so a single collision costs
  // one row and not the transaction.
  const keys = await client.query(
    `SELECT ${colA} AS a, ${colB === undefined ? 'NULL' : colB} AS b, id
       FROM app.${table}
      WHERE client_id = ANY($1::int[])`, [doomedIds]
  );

  let moved = 0;
  let skipped = 0;

  for (const row of keys.rows) {
    // Does the survivor already hold this key?
    const clash = await client.query(
      `SELECT 1 FROM app.${table} WHERE client_id = $1 AND ${colA} = $2
         ${colB === undefined ? '' : `AND ${colB} IS NOT DISTINCT FROM $3`} LIMIT 1`,
      colB === undefined ? [survivorId, row.a] : [survivorId, row.a, row.b]
    );

    if (clash.rowCount) {
      if (opts.absorb) {
        // Keep the survivor's row and take the better of the two, rather than
        // throwing the duplicate's progress away.
        await client.query(opts.absorb(survivorId, row.id, table), []);
      }
      skipped += 1;
      report?.skipped?.push(`${table}: duplicate ${colA}=${JSON.stringify(row.a)} kept the survivor's row`);
      continue;
    }

    await client.query(`UPDATE app.${table} SET client_id = $1 WHERE id = $2`, [survivorId, row.id]);
    moved += 1;
  }

  if (moved) report && (report.moved[table] = (report.moved[table] || 0) + moved);
  if (skipped) report && (report.discarded = (report.discarded || 0) + skipped);
  return moved;
}

/**
 * Move everything that hangs off the doomed clients, so the cascade has nothing
 * left to destroy.
 *
 * @returns {Promise<void>}
 */
export async function moveAllChildRows(client, { survivorId, doomedIds, report }) {
  if (!doomedIds.length) return;
  const ids = doomedIds.map(Number);

  // ── 1. Tables with no uniqueness constraint on the move ──────────────────
  // These cannot collide, so one statement each.
  const PLAIN = [
    'job_actions', 'job_chat_messages', 'job_dossier_edits',
    'job_opportunities', 'job_outreach', 'job_seen_replies', 'job_sent_messages',
    'job_cycles',
  ];
  for (const table of PLAIN) {
    if (!(await tableExists(client, table))) continue;
    const res = await client.query(
      `UPDATE app.${table} SET client_id = $1 WHERE client_id = ANY($2::int[])`,
      [survivorId, ids]
    );
    if (res.rowCount) report?.moved && (report.moved[table] = (report.moved[table] || 0) + res.rowCount);
  }

  // ── 2. job_applications: unique on (client_id, lower(url)) ────────────────
  // The common collision. Two devices, one job. The survivor's row is kept and
  // the duplicate contributes the parts that only the duplicate knows: a later
  // attempt count, and a submitted_at the survivor never recorded.
  if (await tableExists(client, 'job_applications')) {
    await moveColliding(client, 'job_applications', survivorId, ids, {
      report,
      unique: ['lower(url)', null],
      absorb: (survivor, doomed) => `
        UPDATE app.job_applications SET
          attempts = GREATEST(attempts, (SELECT attempts FROM app.job_applications WHERE id = ${doomed})),
          submitted_at = COALESCE(submitted_at, (SELECT submitted_at FROM app.job_applications WHERE id = ${doomed})),
          notified_at  = COALESCE(notified_at,  (SELECT notified_at  FROM app.job_applications WHERE id = ${doomed})),
          resumed_at   = COALESCE(resumed_at,   (SELECT resumed_at   FROM app.job_applications WHERE id = ${doomed})),
          packet       = COALESCE(packet,       (SELECT packet       FROM app.job_applications WHERE id = ${doomed})),
          eligibility  = COALESCE(eligibility,  (SELECT eligibility  FROM app.job_applications WHERE id = ${doomed})),
          validation   = COALESCE(validation,   (SELECT validation   FROM app.job_applications WHERE id = ${doomed})),
          updated_at   = now()
        WHERE id = ${survivor}`,
    });
  }

  // ── 3. job_client_sessions: unique on (client_id, session_key) ───────────
  // A session key held by both records is the same browser, so the survivor's
  // copy is the live one and the duplicate is simply dropped.
  if (await tableExists(client, 'job_client_sessions')) {
    await moveColliding(client, 'job_client_sessions', survivorId, ids, {
      report, unique: ['session_key', null],
    });
  }

  // ── 4. job_client_mailboxes: unique on the address ───────────────────────
  // This is the table that lets a reply to an old address still find the right
  // person, so losing it is losing history, not just a row.
  if (await tableExists(client, 'job_client_mailboxes')) {
    await moveColliding(client, 'job_client_mailboxes', survivorId, ids, {
      report, unique: ['lower(address)', null],
    });
    // Only one mailbox may be active per client, and the partial unique index
    // says so. Moving a second active row in would trip it, so the newest
    // active one wins and the rest are retired rather than deleted.
    await client.query(
      `UPDATE app.job_client_mailboxes SET is_active = false
        WHERE client_id = $1 AND is_active
          AND id <> (SELECT id FROM app.job_client_mailboxes
                      WHERE client_id = $1 AND is_active
                      ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, id DESC LIMIT 1)`,
      [survivorId]
    );
  }

  // ── 5. job_claim_codes: one LIVE code per (client, address) ───────────────
  // Superseded rather than dropped, because a superseded code is still evidence
  // that a code was issued for that address. Only one stays live, because the
  // live slot is what the index protects.
  if (await tableExists(client, 'job_claim_codes')) {
    await client.query(
      `UPDATE app.job_claim_codes SET superseded_at = now()
        WHERE client_id = ANY($1::int[])
          AND verified_at IS NULL AND superseded_at IS NULL
          AND id NOT IN (
            SELECT MIN(id) FROM app.job_claim_codes
             WHERE client_id = ANY($1::int[])
               AND verified_at IS NULL AND superseded_at IS NULL
             GROUP BY lower(email))`,
      [ids]
    );
    const res = await client.query(
      `UPDATE app.job_claim_codes SET client_id = $1 WHERE client_id = ANY($2::int[])`, [survivorId, ids]);
    if (res.rowCount) report?.moved && (report.moved.job_claim_codes = (report.moved.job_claim_codes || 0) + res.rowCount);
  }

  // ── 6. job_claim_verifications: unique on (client_id, path) ──────────────
  // The verdict is never weakened. verified beats everything; an expired or
  // stale verdict never wins over a live one.
  if (await tableExists(client, 'job_claim_verifications')) {
    const doomed = await client.query(
      `SELECT id, path, verdict, source_independent FROM app.job_claim_verifications
        WHERE client_id = ANY($1::int[])`, [ids]);

    for (const v of doomed.rows) {
      const existing = await client.query(
        `SELECT id, verdict, source_independent FROM app.job_claim_verifications
          WHERE client_id = $1 AND path = $2`, [survivorId, v.path]);

      if (!existing.rowCount) {
        await client.query(`UPDATE app.job_claim_verifications SET client_id = $1 WHERE id = $2`, [survivorId, v.id]);
        report?.moved && (report.moved.job_claim_verifications = (report.moved.job_claim_verifications || 0) + 1);
        continue;
      }

      const keep = existing.rows[0];
      const take = strongerOf(v.verdict, keep.verdict);
      const independent = keep.source_independent === true || v.source_independent === true;
      if (take !== keep.verdict || independent !== keep.source_independent) {
        await client.query(
          `UPDATE app.job_claim_verifications
              SET verdict = $2, source_independent = $3, updated_at = now()
            WHERE id = $1`, [keep.id, take, independent]);
        report?.keptStronger && report.keptStronger.push({ path: v.path, verdict: take });
      }
      await client.query(`DELETE FROM app.job_claim_verifications WHERE id = $1`, [v.id]);
    }
  }

  // ── 7. job_checkins: ONE may be open ─────────────────────────────────────
  // The conversation the candidate is in the middle of follows them across the
  // merge. If both records left one open, the survivor's stays open and the
  // duplicate's is closed as superseded - closed, not answered, because nobody
  // replied to it.
  if (await tableExists(client, 'job_checkins')) {
    const closed = await client.query(
      `UPDATE app.job_checkins SET client_id = $1
        WHERE client_id = ANY($2::int[]) AND NOT still_open`, [survivorId, ids]);
    if (closed.rowCount) report?.moved && (report.moved.job_checkins = (report.moved.job_checkins || 0) + closed.rowCount);

    const survivorHasOpen = await client.query(
      `SELECT 1 FROM app.job_checkins WHERE client_id = $1 AND still_open LIMIT 1`, [survivorId]);
    if (survivorHasOpen.rowCount) {
      const dropped = await client.query(
        `UPDATE app.job_checkins SET still_open = false
          WHERE client_id = ANY($1::int[]) AND still_open`, [ids]);
      if (dropped.rowCount) {
        report?.skipped?.push(`job_checkins: ${dropped.rowCount} open question(s) closed, the survivor already had one`);
      }
    } else {
      const open = await client.query(
        `UPDATE app.job_checkins SET client_id = $1
          WHERE client_id = ANY($2::int[]) AND still_open`, [survivorId, ids]);
      if (open.rowCount) report?.moved && (report.moved.job_checkins = (report.moved.job_checkins || 0) + open.rowCount);
    }
  }

  // ── 8. job_escalations: one UNACTED per kind ─────────────────────────────
  // An event nobody acted on must not be closed by a merge. Where both records
  // hold the same kind, the survivor's is the live one and the duplicate is
  // marked acted with the reason, so the audit shows a decision rather than a
  // disappearance.
  if (await tableExists(client, 'job_escalations')) {
    const acted = await client.query(
      `UPDATE app.job_escalations SET client_id = $1
        WHERE client_id = ANY($2::int[]) AND acted_on_at IS NOT NULL`, [survivorId, ids]);
    if (acted.rowCount) report?.moved && (report.moved.job_escalations = (report.moved.job_escalations || 0) + acted.rowCount);

    const open = await client.query(
      `SELECT id, kind FROM app.job_escalations
        WHERE client_id = ANY($1::int[]) AND acted_on_at IS NULL`, [ids]);
    for (const e of open.rows) {
      const clash = await client.query(
        `SELECT 1 FROM app.job_escalations
          WHERE client_id = $1 AND kind = $2 AND acted_on_at IS NULL LIMIT 1`, [survivorId, e.kind]);
      if (clash.rowCount) {
        await client.query(
          `UPDATE app.job_escalations SET acted_on_at = now(), action = 'superseded by consolidation'
            WHERE id = $1`, [e.id]);
        report?.skipped?.push(`job_escalations: unacted ${e.kind} superseded by the survivor's`);
      } else {
        await client.query(`UPDATE app.job_escalations SET client_id = $1 WHERE id = $2`, [survivorId, e.id]);
        report?.moved && (report.moved.job_escalations = (report.moved.job_escalations || 0) + 1);
      }
    }
  }

  // ── 9. job_cycle_leases: released, not moved ─────────────────────────────
  // A lease is a lock, not history - the history is job_cycles, which moved in
  // step 1. The survivor's worker keeps its own live lock. Carrying a doomed
  // client's lock across would mean holding a lock on a row that no longer
  // exists, which is a leak that only clears when the lease expires.
  if (await tableExists(client, 'job_cycle_leases')) {
    const res = await client.query(
      `DELETE FROM app.job_cycle_leases WHERE client_id = ANY($1::int[])`, [ids]);
    if (res.rowCount) report?.released && (report.released = (report.released || 0) + res.rowCount);
  }
}

export { strongerOf };
