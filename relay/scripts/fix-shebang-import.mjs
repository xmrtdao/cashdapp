// Move a localDbUrl import that landed above a shebang to below it.
//
// fix-test-db-routing.mjs prepended its import to the top of each file, which
// put the import on line 1 and pushed a `#!/usr/bin/env node` shebang to line
// 2. A shebang is only recognised on line 1, so `node --check` and every run
// of the suite failed with SyntaxError. The routing script now inserts after
// the shebang; this repairs the files it already broke.
//
// Idempotent: a file whose line 1 is the shebang is left alone.
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS = join(__dirname, '..', 'tests');

let fixed = 0;
let already = 0;

for (const f of readdirSync(TESTS).filter(n => n.endsWith('.mjs'))) {
  const p = join(TESTS, f);
  const lines = readFileSync(p, 'utf8').split('\n');

  if (lines[0]?.startsWith('#!')) { already++; continue; }

  const impIdx = lines.findIndex(l => l.startsWith('import { localDbUrl }'));
  const shebangIdx = lines.findIndex(l => l.startsWith('#!'));
  if (impIdx === -1 || shebangIdx === -1) continue;

  const imp = lines[impIdx];
  lines.splice(impIdx, 1);
  const sb = lines.findIndex(l => l.startsWith('#!'));
  lines.splice(sb + 1, 0, '', imp);

  writeFileSync(p, lines.join('\n'), 'utf8');
  console.log(`[shebang] moved the import below the shebang in ${f}`);
  fixed++;
}

console.log(`[shebang] ${fixed} repaired, ${already} already correct`);