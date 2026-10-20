/**
 * relay/lib/local-db-url.mjs — which database, exactly, and said out loud
 *
 * WHY THIS EXISTS
 *
 * Four modules built their own pg.Pool and each resolved the URL from a
 * slightly different list of environment variables:
 *
 *   store.mjs        LOCAL_DATABASE_URL || LOCAL_PG_URL || DATABASE_URL || ...
 *   lib/db.mjs       LOCAL_DATABASE_URL || DATABASE_URL || ...
 *   claim.mjs        LOCAL_PG_URL || ...                        <-- no LOCAL_DATABASE_URL
 *   calendly-store.mjs  LOCAL_PG_URL || ...
 *   google-store.mjs    LOCAL_PG_URL || ...
 *
 * Run the suite with LOCAL_DATABASE_URL pointed at xmrt_suite_test, and
 * store.mjs correctly wrote to the test database while claim.mjs quietly read
 * and wrote xmrt_suite - the production database. The visible symptom was a
 * foreign key violation: `Key (client_id)=(922) is not present in table
 * "job_clients"`, for a client that demonstrably existed, one pool away.
 *
 * That symptom looks like a referential integrity bug and is not. It is two
 * modules disagreeing about which database they are in, which is the worst
 * kind of bug to have, because the wrong one is the one with the real data in
 * it.
 *
 * So: one resolver, used by every module that opens a local pool. A test that
 * points LOCAL_DATABASE_URL at a scratch database now either reaches the whole
 * system or is loudly wrong, rather than silently half-reaching it.
 *
 * LOCAL_DATABASE_URL is read first on purpose. It is the name that appears in
 * this repo's own notes as the override that works; LOCAL_PG_URL is kept as a
 * fallback so nothing that sets only that regresses.
 */

export const LOCAL_DB_FALLBACK = 'postgres://postgres@127.0.0.1:5432/xmrt_suite';

/**
 * The connection string for the local PostgreSQL instance.
 *
 * Order matters and is documented above. DATABASE_URL is deliberately last of
 * the three explicit names: in a deployed environment DATABASE_URL often points
 * at a remote instance, and a developer running tests with LOCAL_DATABASE_URL
 * set must not be silently redirected to it.
 */
export function localDbUrl(env = process.env) {
  return (
    env.LOCAL_DATABASE_URL ||
    env.LOCAL_PG_URL ||
    env.DATABASE_URL ||
    LOCAL_DB_FALLBACK
  );
}

/**
 * True when the resolved URL is not the default xmrt_suite database.
 *
 * Used by tests and by apply scripts to refuse to touch production by
 * accident, and to print which database they are actually in.
 */
export function isScratchDatabase(env = process.env) {
  const url = localDbUrl(env);
  const db = url.replace(/^.*\//, '').replace(/\?.*$/, '');
  return db !== 'xmrt_suite';
}