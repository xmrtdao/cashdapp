/**
 * scripts/fix-test-db-routing.mjs — stop the suites writing to production
 *
 * Ten test files built their own pool as
 *
 *   new Pool({ connectionString: process.env.LOCAL_PG_URL || 'postgres://postgres@127.0.0.1:5432/xmrt_suite' })
 *
 * which means: unless the developer happened to have LOCAL_PG_URL exported,
 * every fixture row went into xmrt_suite - the live database. app.job_clients
 * on that database now carries rows named "test-google-state-1792257902455".
 *
 * Two consequences, and the second is why the suites were failing:
 *
 *   1. Tests wrote to production on every run.
 *   2. Running the suite with LOCAL_DATABASE_URL pointed at xmrt_suite_test
 *      put the fixtures in one database and the code under test in another, so
 *      job_claim_codes / job_oauth_states / job_google_accounts foreign keys
 *      failed against clients that demonstrably existed. The symptom read as a
 *      referential-integrity bug and was a database-routing bug.
 *
 * Replaces each with the shared resolver from lib/local-db-url.mjs, which reads
 * LOCAL_DATABASE_URL first. Idempotent: a file already using localDbUrl is
 * skipped.
 *
 * --check reports without writing.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS = join(__dirname, '..', 'tests');
const CHECK_ONLY = process.argv.includes('--check');

// Any of these spellings, across line breaks and quoting. The third form is a
// module-level CONN constant rather than an inline connectionString, used by
// the suites that hand the URL to execFileSync as well as to their own pool.
const PATTERNS = [
  /connectionString:\s*process\.env\.LOCAL_PG_URL\s*\|\|\s*'[^']*'/g,
  /connectionString:\s*process\.env\.LOCAL_PG_URL\s*\|\|\s*"[^"]*"/g,
  /=\s*process\.env\.LOCAL_PG_URL\s*\|\|\s*'[^']*'/g,
];

const files = readdirSync(TESTS).filter(f => f.endsWith('.mjs') || f.endsWith('.test.mjs'));
let changed = 0;
let already = 0;
const touched = [];

for (const f of files) {
  const p = join(TESTS, f);
  const src = readFileSync(p, 'utf8');
  if (!/LOCAL_PG_URL/.test(src)) continue;
  if (/localDbUrl/.test(src)) { already++; continue; }

  let out = src;
  for (const re of PATTERNS) {
    out = out.replace(re, re.source.startsWith('=') ? '= localDbUrl()' : 'connectionString: localDbUrl()');
  }

  if (out === src) {
    // LOCAL_PG_URL present but not in a connectionString - report, do not guess.
    console.log(`[routing] SKIP ${f}: LOCAL_PG_URL present in a form this script will not rewrite`);
    continue;
  }

  // Make sure localDbUrl is imported. Tests are ESM with top-level await, so a
  // dynamic import inside the module body is fine and does not have to be
  // placed next to the use.
  //
  // After the shebang, never before it. A shebang is only a shebang on line 1,
  // and prepending an import above one turns the file into a SyntaxError -
  // which is a loud failure, so it cannot ship silently, but it is still a
  // failure this script caused.
  const rel = relative(TESTS, join(__dirname, '..', 'lib', 'local-db-url.mjs')).replace(/\\/g, '/');
  const spec = rel.startsWith('.') ? rel : './' + rel;
  if (!/local-db-url\.mjs/.test(out)) {
    const imp = `import { localDbUrl } from '${spec}';`;
    out = out.startsWith('#!')
      ? out.replace(/^(#![^\n]*)\n/, `$1\n${imp}\n`)
      : imp + '\n' + out;
  }

  changed++;
  touched.push(f);
  console.log(`[routing] ${f}: LOCAL_PG_URL pool -> localDbUrl()`);
  if (!CHECK_ONLY) writeFileSync(p, out, 'utf8');
}

console.log(`\n[routing] ${changed} file(s) ${CHECK_ONLY ? 'would change' : 'rewritten'}, ${already} already correct`);
if (touched.length) console.log('[routing] files: ' + touched.join(', '));