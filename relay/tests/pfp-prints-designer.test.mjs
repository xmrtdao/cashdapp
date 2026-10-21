// The PFP Prints studio: the designer's prompt, the studio's flow, and the
// rule that a design reference informs the background without displacing the
// client's own colours or their chosen event.
//
// The studio is the part of the business a paying client actually touches.
// It was reachable and looked finished, and three things about it were wrong:
// the backdrop tiles were large, picking one did nothing until a separate
// button was pressed, and there was only one document asked for, when a
// client has two different things to say - what the invitation says, and what
// the room should feel like.
//
// Runs against the router directly (no relay, no designer, no spend).

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artworkPrompt, STYLE_BANK } from '../tools/pfp-template-designer.mjs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '..');
const STUDIO = join(RELAY, 'public', 'pfp-prints', 'index.html');

// ─────────────────────────────────────────────────────────────────────────────
section('the studio asks for two documents, not one');
{
  const html = readFileSync(STUDIO, 'utf8');

  check('there is a step for the invitation or logo',
    html.includes('id="ob-drop"') && html.includes('Add your invitation or logo'));
  check('and a separate step for the design reference',
    html.includes('id="ob-drop2"') && html.includes('Show us the look you want'));
  check('the design reference says it is about the artwork, not the words',
    /about the artwork around the photo/.test(html),
    'it must not read like the invitation step');
  check('the invitation step says it reads the wording, colours and fonts',
    /wording, the colours and the fonts/.test(html));
  check('the flow has five steps', /<i class="on"><\/i><i><\/i><i><\/i><i><\/i><i><\/i>/.test(html));
  check('the copy says five steps', html.includes('Five quick steps'));
  check('the old three-step copy is gone', !html.includes('Three quick steps'));
}

section('the client can give more than one document');
{
  const html = readFileSync(STUDIO, 'utf8');
  check('the file input takes several files', /id="ob-file-input" accept="image\/\*" multiple/.test(html));
  check('and every file in a selection is used, not just the first',
    /for \(const f of files\) onFile\(f\)/.test(html),
    'a multi-selection that takes one file throws the rest away');
  check('each document is listed for the client',
    html.includes('id="ob-files"') && html.includes('obRenderFiles'));
  check('the dropzone stays so another can be added',
    /the dropzone stays so another can be added|dropzoneStillThere/.test(html)
    || !html.includes("$('#ob-drop').classList.add('hide')"),
    'the dropzone must not vanish after the first file');
}

section('the words on the print are confirmed, not assumed');
{
  const html = readFileSync(STUDIO, 'utf8');
  check('there is a confirmation step', html.includes('Check the words on your print'));
  check('with a field for the text', html.includes('id="ob-title"'));
  check('and a field for the date', html.includes('id="ob-date"'));
  check('the booking fills them in', html.includes('bookedTitle') && html.includes('B.event_date'));
  check('a title read off the document is used when there is no booking',
    html.includes('OB.parsedTitle') && html.includes('OB.parsedDate'));
  check('the studio placeholder is not offered back as the client\'s words',
    /your celebration/i.test(html) && html.includes('bookedTitle = ') && html.includes('? \'\''));
  check('and the confirmed words travel with the draft',
    html.includes('line1: OB.line1') && html.includes('line2: OB.line2'));
}

section('picking a backdrop moves the client on by itself');
{
  const html = readFileSync(STUDIO, 'utf8');
  check('tapping a tile advances the step',
    /onclick[\s\S]{0,400}obGo\(2\)/.test(html), 'no advance on selection');
  check('the Continue button steps aside when there is something to pick',
    html.includes('const pickOnly = OB.step === 1 && OB.backdrops > 0'));
  check('and the client is told why', html.includes('Tap a backdrop to carry on'));
}

section('the tiles are small, and reachable without a mouse');
{
  const html = readFileSync(STUDIO, 'utf8');
  check('four across on a phone', html.includes('grid-template-columns:repeat(4,1fr)'));
  check('eight across on a desktop', html.includes('grid-template-columns:repeat(8,1fr)'));
  check('a tile is a button, so it can be Tabbed to',
    html.includes('<button class="ob-bd"'), 'the tile is a div with a click handler');
  check('and it is labelled for a screen reader', html.includes('aria-label="Use the'));
}

section('the picked file replaces the dropzone');
{
  // The .hide class was used in the markup and in the script but was never
  // defined in the stylesheet, so the dropzone never went away and the
  // picked-file panel showed from the start - empty.
  const html = readFileSync(STUDIO, 'utf8');
  check('the hide class exists', /\.hide\{display:none\}/.test(html),
    '.hide was used but never defined');
  check('both dropzones can be hidden independently',
    html.includes("$('#ob-drop' + suffix).classList.add('hide')")
    && html.includes("$('#ob-picked' + suffix).classList.remove('hide')"));
}

section('the onboarding draws once');
{
  // An upload used to redraw on its own, and the onboarding drew again at
  // the end: two renders for one picture, at the client's expense.
  const html = readFileSync(STUDIO, 'utf8');
  check('the onboarding uploads are quiet', html.includes('upload(file, null, true)')
    && html.includes("upload(OB.themeFile, 'theme', true)"));
  check('and the quiet upload does not redraw', /if \(quiet\) return j;/.test(html));
  check('each document is read as it is added', html.includes('await upload(file, null, true)'));
}

// ─────────────────────────────────────────────────────────────────────────────
section('a design reference informs the background and nothing else');
{
  const styleId = Object.keys(STYLE_BANK)[0];
  const prompt = artworkPrompt(styleId, {
    brandHexes: ['#AA1122', '#33BB44'],
    hasLogo: true,
    theme: 'a Toy Story birthday',
    moodHexes: ['#FFCC00', '#2255AA'],
  });

  check('the client\'s own theme reaches the prompt', prompt.includes('a Toy Story birthday'));
  check('the reference\'s colours reach the prompt',
    prompt.includes('#FFCC00') && prompt.includes('#2255AA'));
  check('the brand colours survive alongside it',
    prompt.includes('#AA1122') && prompt.includes('#33BB44'));
  check('the reference steers the background, not the accents',
    /background should carry the mood/i.test(prompt));
  check('the prohibitions still hold', /ABSOLUTE PROHIBITIONS/.test(prompt)
    && prompt.includes('Do not draw any text'));
}

section('and the prompt does not invent a reference it was not given');
{
  const styleId = Object.keys(STYLE_BANK)[0];
  const prompt = artworkPrompt(styleId, { brandHexes: [], hasLogo: false, theme: '', palette: '' });
  check('no mood line without a reference', !/background should carry the mood/i.test(prompt));
  check('no brand line without brand colours', !/brand colours/.test(prompt));
}

// ─────────────────────────────────────────────────────────────────────────────
section('the API keeps the two questions apart');
{
  const { default: router } = await import('../routes/pfp-prints.mjs');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/studio', router);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/studio`;
  const booking = 'test-theme-' + Date.now();
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const written = [];

  try {
    const ctx = await (await fetch(`${base}/context?booking=${booking}&type=celebration`)).json();
    check('the session opens', !!ctx.booking_id, JSON.stringify(ctx).slice(0, 120));

    const upload = async (kind, fileName) => {
      const r = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking, kind, dataUrl: PNG, fileName }),
      });
      return { status: r.status, body: await r.json() };
    };

    const invitation = await upload('inspiration', 'invitation.png');
    written.push(invitation.body.file);
    check('the invitation is accepted', invitation.status === 200, invitation.status);
    check('and it is kept as the invitation', invitation.body.kind === 'inspiration');

    // A second document must be kept, not swallowed by the first.
    const second = await upload('inspiration', 'details-sheet.png');
    written.push(second.body.file);
    check('a second document is accepted', second.status === 200, second.status);
    check('and both documents are kept',
      second.body.documents === 2, `documents=${second.body.documents}`);

    const theme = await upload('theme', 'golden-reference.png');
    written.push(theme.body.file);
    check('the design reference is accepted', theme.status === 200, theme.status);
    check('and it is kept as its own thing', theme.body.kind === 'theme');
    check('it does not move the event style',
      theme.body.styleId === invitation.body.styleId,
      `${invitation.body.styleId} -> ${theme.body.styleId}`);
    check('it does not overwrite the brand colours',
      JSON.stringify(theme.body.brandHexes) === JSON.stringify(invitation.body.brandHexes));
    check('it reports its own mood and palette',
      'themeMood' in theme.body && 'themePalette' in theme.body);
    check('it reports what was read off the documents',
      'parsedTitle' in theme.body && 'parsedDate' in theme.body);
    check('and it says what it is for', /background/i.test(theme.body.note || ''));

    // Both files exist and are different files - one slot each.
    check('the two uploads are separate files',
      theme.body.file !== invitation.body.file
      && theme.body.file.includes('-theme-') && invitation.body.file.includes('-inspiration-'));

    // Clean up what the test wrote.
    const unlink = (await import('node:fs/promises')).unlink;
    for (const f of written) {
      if (f) { try { await unlink(f); } catch {} }
    }
  } finally {
    // Wait for the close, and drop the keep-alive sockets that fetch() left
    // behind - otherwise the process exits with a socket still open and Node
    // aborts on an assertion instead of exiting cleanly.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

section('the print is the size it needs to be, and the type follows the invitation');
{
  const src = readFileSync(join(RELAY, 'tools', 'pfp-compositor.mjs'), 'utf8');
  const routes = readFileSync(join(RELAY, 'routes', 'pfp-prints.mjs'), 'utf8');
  const studio = readFileSync(STUDIO, 'utf8');

  check('the type is the invitation\'s script, not a plain serif',
    src.includes('Great Vibes') && src.includes('Cormorant Garamond'));
  check('the fonts are embedded, not linked',
    src.includes('data:font/woff2;base64') && src.includes('document.fonts.load'));
  check('the headline is not a caption any more', /fitHeadline\(headlineParts, SCRIPT, 400, TEXT_MAX_W, 1\d\d/.test(src));
  check('and every line has to FIT the strip, not merely be the right number',
    /widest <= maxW/.test(src),
    'a word longer than the strip overflowed into the other strip');
  check('the names break apart the way the invitation breaks them',
    src.includes("words.includes('&')"));
  check('the design phase works at 72dpi',
    routes.includes('DESIGN_SCALE') && /PFP_DESIGN_SCALE \?\? 0\.24/.test(routes));
  check('and the approved print is written at 300dpi',
    /scale: 1,/.test(routes) && routes.includes('-print.png'));
  check('the file is scaled on the way out',
    src.includes('imageSmoothingQuality') && src.includes('cv.width = Math.round(w)'));
  check('the frame is bounded by the stage, not by the image',
    /height:100%;width:auto;aspect-ratio:2\/3/.test(studio));
  check('the browser is closed even when a composite throws',
    src.includes('await browser.close().catch(() => {})'),
    'a leaked headless Chrome stopped every render after it');
}

console.log(fails === 0
  ? '\nall checks passed'
  : `\n${fails} check(s) FAILED`);
// exitCode, not process.exit(): tearing the process down while a socket is
// still closing makes Node abort on a libuv assertion on Windows, and the
// exit code becomes something nobody can read.
process.exitCode = fails === 0 ? 0 : 1;
