/**
 * scripts/reconcile-duplicate-tasks.mjs — close the self-fed duplicates
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF THE MIGRATION
 *
 * migrations/jobby_010_task_dedupe.sql creates a unique index over OPEN task
 * titles, and it deliberately RAISES if duplicates already exist. That is the
 * right instinct - a migration must not quietly delete work somebody filed -
 * but it means the index cannot be applied to the live database until the
 * existing duplicates are dealt with by somebody who chose to deal with them.
 *
 * So this is the "somebody chose" part. It is a dry run unless you pass
 * --apply, it prints exactly what it would do first, and it writes down what it
 * did.
 *
 * WHAT IT CONSIDERS A DUPLICATE
 *
 * Only rows that are provably loop artifacts, which is a narrower test than
 * "same title":
 *
 *   - status is open (PENDING / IN_PROGRESS / DISCUSS / ...)
 *   - category = 'fleet-chat', which only the auto-creator sets
 *   - assignee_agent_id IS NULL - nobody ever picked it up
 *
 * Anything else is left alone and REPORTED, not closed. The first dry run on
 * the live database found 7 duplicated titles and 456 rows, and 8 of those rows
 * were not loop artifacts at all: four titles with two copies each, all
 * ASSIGNED, under categories `infra` and `other`. Those are somebody's work. A
 * rule that said "same title, keep one" would have deleted a real task, which
 * is why the test is category plus assignee and not title alone.
 *
 * For each loop-artifact title the OLDEST open row is kept and becomes the
 * canonical task. Every other copy is set to CANCELLED with a blocking_reason
 * that says what it was, why it is being closed, and which row supersedes it -
 * so the decision is legible from the row itself and nobody has to come read
 * this file.
 *
 * Review first:      node scripts/reconcile-duplicate-tasks.mjs
 * Then commit:       node scripts/reconcile-duplicate-tasks.mjs --apply
 */

import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const TERMINAL = ['DONE', 'CANCELLED', 'COMPLETED'];
const LOOP_CATEGORY = 'fleet-chat';

const pool = new pg.Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL,
});

async function main() {
  // Which titles have more than one open task, and how bad is each?
  const groups = await pool.query(
    `SELECT lower(title) AS title,
            count(*)::int AS open_copies,
            min(created_at)    AS oldest,
            max(created_at)    AS newest,
            count(*) FILTER (WHERE assignee_agent_id IS NOT NULL)::int AS assigned,
            array_agg(DISTINCT category) AS categories
       FROM app.tasks
      WHERE status <> ALL($1::text[])
      GROUP BY lower(title)
     HAVING count(*) > 1
      ORDER BY count(*) DESC, lower(title)`,
    [TERMINAL]);

  console.log(`${groups.rowCount} title(s) have more than one open copy.`);
  console.log(`${groups.rows.reduce((n, g) => n + g.open_copies, 0)} open rows involved.\n`);

  for (const g of groups.rows) {
    console.log(`  ${String(g.open_copies).padStart(4)}x  ${g.title}`);
    console.log(`         categories=${JSON.stringify(g.categories)} assigned=${g.assigned} `
      + `${String(g.oldest).slice(0, 16)} .. ${String(g.newest).slice(0, 16)}`);
  }

  // Decide, per group: keep the oldest loop artifact, close the rest.
  // Recorded here so the dry run and the apply make the identical decision.
  const plan = [];
  const needsHuman = [];

  for (const g of groups.rows) {
    const rows = await pool.query(
      `SELECT id, title, category, created_at, assignee_agent_id
         FROM app.tasks
        WHERE lower(title) = $1 AND status <> ALL($2::text[])
        ORDER BY created_at ASC, id ASC`,
      [g.title, TERMINAL]);

    const isLoop = (r) => r.category === LOOP_CATEGORY && r.assignee_agent_id === null;
    const loopRows = rows.rows.filter(isLoop);
    const otherRows = rows.rows.filter((r) => !isLoop(r));

    if (otherRows.length) needsHuman.push({ title: g.title, rows: otherRows });
    if (loopRows.length > 1) {
      plan.push({ keep: loopRows[0], close: loopRows.slice(1), title: g.title });
    }
  }

  if (needsHuman.length) {
    console.log('\nLEFT ALONGS - not loop artifacts, closing these would destroy real work:');
    for (const h of needsHuman) {
      console.log(`  "${h.title}"`);
      for (const r of h.rows) {
        console.log(`    ${r.id}  category=${String(r.category).padEnd(6)} `
          + `assignee=${r.assignee_agent_id}  created=${String(r.created_at).slice(0, 16)}`);
      }
    }
    console.log('\n  These need a human decision. The dedupe index cannot be created while they');
    console.log('  remain, because it covers ALL open titles, not just loop artifacts.');
  }

  const totalClose = plan.reduce((n, p) => n + p.close.length, 0);
  console.log(`\nplan: keep ${plan.length} canonical task(s), close ${totalClose} duplicate(s).`);

  if (!APPLY) {
    console.log('\nDRY RUN - nothing was written.');
    console.log('Re-run with --apply to execute this plan.');
    return 0;
  }

  if (totalClose === 0) {
    console.log('\nnothing to close.');
  } else {
    const client = await pool.connect();
    let closed = 0;
    try {
      await client.query('BEGIN');
      for (const p of plan) {
        for (const row of p.close) {
          await client.query(
            `UPDATE app.tasks
                SET status = 'CANCELLED',
                    stage = 'DISCUSS',
                    blocking_reason = $2,
                    updated_at = now()
              WHERE id = $1`,
            [row.id,
              `duplicate of ${p.keep.id}: ${p.close.length} open copies of the same title were `
              + `created by fleet-chat-task-creator reading its own announcements. Closed by `
              + `scripts/reconcile-duplicate-tasks.mjs; the canonical task is ${p.keep.id}.`]);
          closed++;
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[reconcile] ROLLED BACK, nothing was changed: ' + e.message);
      await client.end();
      return 1;
    }
    await client.end();
    console.log(`\nclosed ${closed} duplicate task(s).`);
  }

  const left = await pool.query(
    `SELECT count(*)::int AS n FROM app.tasks WHERE status <> ALL($1::text[])`, [TERMINAL]);
  console.log(`open tasks remaining: ${left.rows[0].n}`);

  // Report whether the index can now be created, rather than sending the
  // operator off to find out. A clean run of this script can still leave
  // assigned duplicates behind, and the index covers every open title.
  const blockers = await pool.query(
    `SELECT lower(title) AS t, count(*)::int AS n,
            array_agg(DISTINCT coalesce(assignee_agent_id, '(unassigned)')) AS who
       FROM app.tasks WHERE status <> ALL($1::text[])
      GROUP BY lower(title) HAVING count(*) > 1 ORDER BY n DESC`, [TERMINAL]);

  if (blockers.rowCount) {
    console.log(`\n${blockers.rowCount} duplicated title(s) REMAIN, so `
      + `migrations/jobby_010_task_dedupe.sql will still refuse to apply:`);
    for (const b of blockers.rows) {
      console.log(`  ${b.n}x ${b.t}  (${JSON.stringify(b.who)})`);
    }
    console.log('\nThese are not loop artifacts. Somebody has to decide whether each pair is two');
    console.log('tasks or one task filed twice.');
  } else {
    console.log('\nno duplicated open titles remain - migrations/jobby_010_task_dedupe.sql '
      + 'will apply cleanly.');
  }
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('[reconcile] FAIL: ' + e.message);
} finally {
  // Closed exactly once, here. An earlier version also closed it on the
  // rollback path, and the resulting unsettled top-level await made Node warn
  // and exit non-zero on a run that had actually succeeded.
  await pool.end().catch(() => {});
}
process.exit(code);