/** Smoke test for the PFP designer module. No generation — this checks that
 *  the baked-in rules produce correct prompts and a correct print file, and it
 *  spends nothing. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  PFPDesigner, STYLE_BANK, artworkPrompt, textColoursFor,
} from './pfp-template-designer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, '_probe_results');

let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) fail++;
};

console.log('STYLE BANK');
for (const [id, s] of Object.entries(STYLE_BANK)) {
  check(`${id} has ground + accents`, /^#[0-9A-Fa-f]{6}$/.test(s.ground) && s.accentHexes.length > 0);
}

console.log('\nTEXT COLOUR BY GROUND LUMINANCE (rule: light ground needs dark type)');
const light = textColoursFor('#FFFFFF');
const dark = textColoursFor('#0B3B22');
check('light ground -> dark text', light.onLight && light.primary !== '#F2F4F5', JSON.stringify(light));
check('dark ground  -> light text', !dark.onLight && dark.primary === '#F2F4F5', JSON.stringify(dark));
// The bug this prevents: wedding/celebration grounds are near-white, so a
// hard-coded light fill would be invisible on them.
check('wedding_classic resolves to dark type',
  textColoursFor(STYLE_BANK.wedding_classic.ground).onLight);
check('celebration resolves to dark type',
  textColoursFor(STYLE_BANK.celebration.ground).onLight);

console.log('\nARTWORK PROMPT (rule 1: no frames/text/logo in the shell prompt)');
const p = artworkPrompt('corporate_holiday', {
  brandHexes: ['#707070', '#F06020'], hasLogo: true });
const banned = ['draw the frames', 'include the text', 'add the logo'];
check('forbids frames', /do not draw any photo frames/i.test(p));
check('forbids text', /do not draw any text/i.test(p));
check('forbids logo', /do not draw any text, letters, numbers, words, logos/i.test(p));
check('tells the model not to attempt the logo',
  /do not attempt it/i.test(p));
check('grades density (rule 4)', /GRADED, NOT UNIFORM/i.test(p) && /lower third/i.test(p));
check('injects brand hexes (rule 5)', p.includes('#707070') && p.includes('#F06020'));
console.log('\n--- prompt ---\n' + p + '\n--------------');

console.log('FINISH (rules 1,3,6,7,11,12)');
const d = new PFPDesigner('not-used', { budget: 0 });
const res = await d.finish({
  shellPath: path.join(OUT, 'kcic_artwork_v2.jpg'),
  logoPath: path.join(OUT, 'logos', 'kcic-logo.png'),
  line1: 'Company Holiday Party',
  line2: 'December 4th, 2026',
  outPath: path.join(OUT, 'MODULE_TEST.png'),
});
console.log('  ', JSON.stringify(res));
const st = await fs.stat(res.out);
check('wrote a file', st.size > 100000, `${(st.size / 1024).toFixed(0)} KB`);
check('geometry is 3 windows of 3:2', res.window === '510x340 (1.50:1)' && res.framesPerStrip === 3);
check('card is 4x6 @300dpi', res.card === '1200x1800');
check('no credits spent by finish()', d.spent === 0);

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);