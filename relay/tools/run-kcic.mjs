/** KCIC holiday party — end to end through the production function.
 *  Uploads the real logo, reads the real palette from pixels, generates the
 *  artwork with the governed prompt, then composites the print file. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { PFPDesigner, textColoursFor, STYLE_BANK } from './pfp-template-designer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, '_probe_results');
const LOGO = path.join(OUT, 'logos', 'kcic-logo.png');

const key = (await fs.readFile(path.join(REPO, 'relay', '.env'), 'utf8'))
  .match(/MUAPI_API_KEY\s*=\s*"?([^"\r\n]+)"?/)?.[1]?.trim();

// Budget is a hard ceiling, enforced before each submit (rule 9).
const d = new PFPDesigner(key, { budget: 1.00 });

// Rule 5 — palette read from the client's actual file, not guessed.
const BRAND = ['#707070', '#F06020'];   // from _palette.py on kcic-logo.png
const STYLE = 'corporate_holiday';

// Rule 2 — real upload so the shell prompt can reference a URL that exists.
const logoUrl = await d.hostLogo(LOGO);
console.log('hosted logo ->', logoUrl);

console.log('resolving price...');
const { cost, remaining } = await d.price(d.shellModel, { prompt: 'x' });
console.log(`  ${d.shellModel} = $${cost.toFixed(4)}  (budget left $${remaining.toFixed(2)})`);

const shell = await d.render({
  kind: 'draft',
  styleId: STYLE,
  brandHexes: BRAND,
  hasLogo: true,
  workDir: OUT,
});
console.log(`shell: ${shell.model}  $${shell.cost.toFixed(4)}  ${shell.seconds ?? ''}s`);
console.log('       ' + shell.shellPath);

const out = path.join(OUT, 'KCIC_PFP_FUNCTION.png');
const done = await d.finish({
  shellPath: shell.shellPath,
  logoPath: LOGO,
  line1: 'Company Holiday Party',
  line2: 'December 4th, 2026',
  outPath: out,
});

console.log('\nprint file:', done.out);
console.log('geometry  :', done.geometry);
console.log('bytes     :', done.bytes.toLocaleString());

const bal = await d.balance();
console.log(`\nspent this run: $${d.spent.toFixed(4)}`);
console.log(`balance       : $${bal.balance}`);
console.log(`text colours  :`, JSON.stringify(textColoursFor(STYLE_BANK[STYLE].ground)));
console.log(`\nREVIEW ${out}`);