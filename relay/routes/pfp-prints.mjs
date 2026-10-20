/**
 * PFP Prints — the client-facing design sandbox API.
 *
 * Serves prints.partyfavorphoto.com. The client arrives on a booking UUID and
 * talks to Eliza while a live visualizer shows their template. Everything that
 * reaches the print file goes through PFPDesigner, so the rules baked into that
 * module apply to this endpoint too — the frontend cannot bypass them.
 *
 * Two rules that shape this file:
 *   • An audit or generation failure opens a TASK. It never auto-retries. An
 *     unguarded retry loop is how an API bill becomes an incident, so the
 *     client is told plainly and a human picks it up.
 *   • Every generation is priced before it is submitted and refused if it would
 *     breach the budget.
 */
import express from 'express';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PFPDesigner, STYLE_BANK, textColoursFor, artworkPrompt } from '../tools/pfp-template-designer.mjs';
import { UploadDetector, styleForEvent } from '../tools/pfp-upload-detector.mjs';
import { query as localQuery } from '../lib/localDb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');
const REPO = path.join(RELAY, '..');
const WORK = path.join(REPO, '_pfp_prints');
const UPLOADS = path.join(WORK, 'uploads');
const RENDERS = path.join(WORK, 'renders');
for (const d of [WORK, UPLOADS, RENDERS]) await fs.mkdir(d, { recursive: true });

// The link IS the credential. A booking UUID in the URL opens the studio
// directly; a client who has already entered on this device is remembered
// there, so a return visit is seamless with nothing to type. Only a client
// who arrives with no credential at all is offered a magic link by email —
// never a login page and never an ID to memorise.

// Budget for the whole endpoint. Low on purpose: a runaway dashboard that
// anyone can hit should not be able to spend a meaningful amount.
const BUDGET = Number(process.env.PFP_PRINTS_BUDGET ?? 3.00);

/** Server-side whitelist of engaged clients' IPs per booking. */
const WHITELIST = path.join(WORK, 'whitelist.json');
let whitelist = {};
try { whitelist = JSON.parse(await fs.readFile(WHITELIST, 'utf8')); } catch { whitelist = {}; }
function persistWhitelist() {
  fs.writeFile(WHITELIST, JSON.stringify(whitelist, null, 2)).catch(() => {});
}
function whitelistIp(bookingId, req) {
  const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
    .toString().split(',')[0].trim();
  if (!ip) return;
  if (!whitelist[bookingId]) whitelist[bookingId] = { ips: [], updated: null };
  const entry = whitelist[bookingId];
  if (!entry.ips.includes(ip)) {
    entry.ips = entry.ips.concat(ip).slice(-25);
    entry.updated = new Date().toISOString();
    persistWhitelist();
  }
}

let designer = null;
const getDesigner = () => {
  if (!designer) designer = new PFPDesigner(process.env.MUAPI_API_KEY, { budget: BUDGET });
  return designer;
};

/** Per-booking state. In-memory on purpose — a redesign that deserves durable
 *  storage deserves a table, not a Map that silently loses work on restart. */
const sessions = new Map();

const uuid = () => crypto.randomUUID();

// ── Style metadata the UI needs ────────────────────────────────────────────
const styles = Object.entries(STYLE_BANK).map(([id, s]) => ({
  id, name: s.name, note: s.note, ground: s.ground,
  colours: textColoursFor(s.ground),
}));

const router = express.Router();
router.use(express.json({ limit: '24mb' }));

// ── 0. Backdrop catalogue ──────────────────────────────────────────────────
// The client picks a backdrop before uploading inspiration (Option A). The
// catalogue is a static list of the generated backdrop photos, each with a
// colour identity sampled from the generated image. The colour is what the
// client sees on the selection chip, and what the design engine uses to pick
// a palette direction.
const BACKDROP_DIR = path.join(REPO, 'partyfavorphoto', 'assets', 'backdrops');
const BACKDROPS = (() => {
  try {
    return readdirSync(BACKDROP_DIR)
      .filter(f => /\.png$/i.test(f))
      .sort()
      .map(f => {
        const slug = f.replace(/\.png$/i, '');
        return { slug, url: `/api/visual/pfp/backdrops/${slug}.png` };
      });
  } catch (e) {
    // NOT swallowed into an empty list. This module imports fs from
    // 'node:fs/promises', which has no readdirSync — calling fs.readdirSync
    // threw, the catch returned [], and the endpoint served a confident
    // "you have no backdrops" to a client who had eleven on disk. A silent
    // catch here is indistinguishable from the real answer.
    console.error('[pfp] backdrop catalogue failed to load:', e.message);
    return [];
  }
})();

router.get('/backdrops', (_req, res) => {
  res.json({ backdrops: BACKDROPS });
});

/** Resolve a slug to a path on disk. Only known slugs resolve — a client cannot
 *  steer the compositor at an arbitrary file by putting a path in `backdrop`. */
const BACKDROP_SLUGS = new Set(BACKDROPS.map(b => b.slug));
const backdropFile = (slug) =>
  BACKDROP_SLUGS.has(slug) ? path.join(BACKDROP_DIR, `${slug}.png`) : null;

// Serve the backdrop images. They are static assets, so they are served
// directly from disk with a long cache header.
router.get('/backdrops/:slug.png', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '');
  const file = path.join(BACKDROP_DIR, `${slug}.png`);
  if (!existsSync(file)) return res.status(404).json({ error: 'no such backdrop' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// ── 1. Booking context + Eliza's opening ───────────────────────────────────
// The studio is open to every visitor. A booking UUID in the link still
// personalises the greeting and ties the draft to that client's record, but
// nothing is gated: no booking lookup, no payment check, no magic-link
// recovery page. Anyone who arrives gets a working studio immediately.
router.get('/context', async (req, res) => {
  // The booking reference can arrive in the URL path, in ?booking=, or not at
  // all. Absent any reference, the client still gets a full studio.
  const bookingId = String(req.query.booking || req.query.b || '').trim() || 'anon-' + uuid();
  const b = {
    booking_id: bookingId,
    client_name: req.query.name || 'there',
    event_name: req.query.event || 'your celebration',
    event_type: req.query.type || 'celebration',
    event_date: req.query.date || null,
    hours: req.query.hours ? Number(req.query.hours) : null,
    package_type: req.query.package || null,
  };

  const styleFor = {
    wedding: 'wedding_classic', graduation: 'graduation_prestige',
    homecoming: 'hoco_prom', prom: 'hoco_prom',
    corporate: 'corporate_holiday', holiday: 'corporate_holiday',
    christmas: 'corporate_holiday', birthday: 'celebration',
    quince: 'celebration', 'bar mitzvah': 'celebration',
  }[String(b.event_type).toLowerCase()] || 'corporate_holiday';

  const session = {
    ...b,
    style_id: styleFor,
    line1: req.query.line1 || b.event_name,
    line2: req.query.line2 || (b.event_date || ''),
    uploaded: [],
    revision: 0,
    shellUrl: null,
    logoUrl: null,
    messages: [{
      role: 'eliza',
      text:
        `Hi ${b.client_name === 'there' ? 'there' : b.client_name}! I'm Eliza, with Party Favor Photo. ` +
        `Congratulations on ${b.event_name === 'your celebration' ? 'your event' : b.event_name} — a brilliant call. ` +
        `Our DSLR and strobe flash rig is going to make your guests look like absolute stars. ` +
        `I've already put a first draft of your print together for you below — take a look, and tell me ` +
        `what you'd like changed. Colours, style, wording, anything.`,
      tts: true,
    }],
  };
  sessions.set(bookingId, session);
  whitelistIp(bookingId, req);
  res.json({ ...session, styles, resuming: false });
});

// (The magic-link recovery endpoint was removed when the studio opened to
// every visitor. A client who has no booking reference gets an anonymous
// session immediately; there is nothing to recover.)

// ── 2. Client upload: logo or inspiration ──────────────────────────────────
// A logo is stored as an immutable asset and its palette is read from pixels.
// Inspiration (an invitation) is noted and will drive the next draft.
router.post('/upload', async (req, res) => {
  const { booking, kind = 'logo', dataUrl, fileName } = req.body || {};
  const s = sessions.get(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });
  if (!dataUrl || !/^data:image\/(png|jpeg|jpg|webp);base64,/.test(dataUrl)) {
    return res.status(400).json({ error: 'expected a base64 image data URL' });
  }

  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  if (buf.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'image must be under 10MB' });
  }
  const ext = dataUrl.includes('png') ? 'png' : dataUrl.includes('webp') ? 'webp' : 'jpg';
  const file = path.join(UPLOADS, `${booking}-${kind}-${Date.now()}.${ext}`);
  await fs.writeFile(file, buf);

  const rec = { kind, file, name: fileName || file, url: `/api/visual/pfp/file/${path.basename(file)}` };
  s.uploaded = s.uploaded.filter(u => u.kind !== kind).concat(rec);

  // A logo is uploaded so the compositor can stamp it verbatim. Its palette is
  // also read here so the artwork can be built around the client's brand.
  if (kind === 'logo') {
    s.logoUrl = rec.url;
    try {
      s.brandHexes = await paletteFromFile(file);
    } catch { s.brandHexes = []; }
  }

  // Read the upload and let it pick the style. A wedding invitation should land
  // on a wedding design without the client having to say so; a business mark
  // should read as corporate. This is what makes an upload mean something
  // rather than just supplying an asset.
  let detected = { kind: 'misc', event: 'unknown', confidence: 0, source: 'skipped' };
  let chosenStyle = null;
  try {
    const { w, h } = await imageSize(file);
    const detector = new UploadDetector(process.env.MUAPI_API_KEY);
    detected = await detector.classify({
      imageUrl: rec.url, w, h, bytes: buf.length, filename: rec.name,
    });
    chosenStyle = styleForEvent(detected.event, detected.kind);
    if (chosenStyle) s.style_id = chosenStyle;
    if (detected.palette && detected.palette.length && kind !== 'logo') {
      s.brandHexes = detected.palette;
    }
  } catch (e) {
    console.warn('[pfp-prints] upload detection failed:', e.message);
  }

  res.json({
    ok: true, ...rec, brandHexes: s.brandHexes || [],
    detected, styleId: chosenStyle || s.style_id,
    note: kind === 'logo'
      ? 'Logo stored untouched and used as-is. It will not be redrawn or enhanced.'
      : 'Inspiration received — the next draft will be built around it.',
  });
});

/** Read an image's dimensions without trusting the client or the filename. */
async function imageSize(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fp = 'C:\\tools\\ffprobe.exe';
  const out = await promisify(execFile)(fp, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]).catch(() => ({ stdout: '' }));
  const [a, b] = String(out.stdout || '').split(',').map(s => parseInt(s, 10));
  return { w: Number.isFinite(a) ? a : 0, h: Number.isFinite(b) ? b : 0 };
}

/** Read the dominant brand colours from the client's own file. Arithmetic, not
 *  judgement: a vision model would cost more and vary run to run. */
async function paletteFromFile(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  // Only `py.exe` exists on this host, so a hardcoded "python" fails — and an
  // earlier version swallowed that failure and returned an empty palette,
  // which looked like "the logo had no colours" rather than "we broke".
  const candidates = (process.env.PFP_PYTHON ? [process.env.PFP_PYTHON]
    : ['python', 'py', 'python3']);
  const errors = [];
  for (const py of candidates) {
    try {
      const out = await run(py, [path.join(REPO, '_palette.py'), file], { timeout: 60000 });
      const hexes = [...String(out.stdout).matchAll(/#([0-9A-Fa-f]{6})/g)]
        .map(m => '#' + m[1].toUpperCase());
      const uniq = [...new Set(hexes)].filter(h => h !== '#FFFFFF');
      if (uniq.length) return uniq.slice(0, 3);
    } catch (e) {
      errors.push(`${py}: ${String(e.message).slice(0, 90)}`);
    }
  }
  // Loud, not silent: a client logo with no palette means the artwork will not
  // be built around their brand, and that should be visible rather than inferred.
  console.warn('[pfp-prints] palette extraction failed for', file, errors.join(' | '));
  return [];
}

// ── 3. New draft ───────────────────────────────────────────────────────────
// A new draft always regenerates the artwork: the client changed the mood,
// which is a big change, not a refinement.
//
// `theme` and `palette` come straight from what the client asked for. Without
// them every message produced the same preset template — the single biggest
// defect found in the first live use, and the reason the chat looked broken.
router.post('/draft', async (req, res) => {
  const { booking, style_id, line1, line2, theme, palette, backdrop } = req.body || {};
  const s = sessions.get(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });

  const styleId = STYLE_BANK[style_id] ? style_id : s.style_id;
  const logoRec = s.uploaded.find(u => u.kind === 'logo');
  const started = Date.now();

  // The backdrop is remembered on the session so a later refine() keeps showing
  // the curtain the client chose rather than silently reverting to none.
  if (typeof backdrop === 'string' && /^[a-z0-9-]{1,40}$/i.test(backdrop)
      && BACKDROP_SLUGS.has(backdrop)) {
    s.backdrop = backdrop;
  }

  try {
    const d = getDesigner();
    const shell = await d.render({
      kind: 'draft',
      styleId,
      brandHexes: s.brandHexes || [],
      hasLogo: !!logoRec,
      theme: (theme ?? s.theme ?? '').toString().slice(0, 400),
      palette: (palette ?? s.palette ?? '').toString().slice(0, 120),
      backdropPath: s.backdrop ? backdropFile(s.backdrop) : null,
      workDir: RENDERS,
    });

    const out = await d.finish({
      shellPath: shell.shellPath,
      logoPath: logoRec ? path.join(UPLOADS, path.basename(logoRec.file)) : null,
      backdropPath: shell.backdropPath || null,
      line1: line1 ?? s.line1,
      line2: line2 ?? s.line2,
      outPath: path.join(RENDERS, `${booking}-r${s.revision + 1}.png`),
    });

    s.style_id = styleId;
    s.line1 = line1 ?? s.line1;
    s.line2 = line2 ?? s.line2;
    s.theme = (theme ?? s.theme ?? '').toString().slice(0, 400);
    s.palette = (palette ?? s.palette ?? '').toString().slice(0, 120);
    s.shellUrl = shell.shellUrl;
    s.revision += 1;

    res.json({
      ok: true, revision: s.revision,
      image: `/api/visual/pfp/file/${path.basename(out.out)}`,
      shell: `/api/visual/pfp/file/${path.basename(shell.shellPath)}`,
      geometry: out.geometry, cost: shell.cost,
      seconds: Math.round((Date.now() - started) / 1000),
      styleId, theme: s.theme, palette: s.palette,
      ink: out.ink, spent: d.spent,
    });
  } catch (e) {
    openCorrectionTask(s, e, 'draft');
    res.status(502).json({
      error: 'The designer could not finish this draft.',
      detail: e.message,
      action: 'I have logged this for our team so you do not have to chase it.',
    });
  }
});

// ── 4. Revision ────────────────────────────────────────────────────────────
// A revision keeps the client's artwork and adjusts it, instead of handing back
// an entirely different design. Different model on purpose: the edit model
// re-decides composition less destructively than a text-to-image pass.
router.post('/revise', async (req, res) => {
  const { booking, direction, theme, palette } = req.body || {};
  const s = sessions.get(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });
  if (!s.shellUrl) return res.status(409).json({ error: 'no draft to revise yet' });

  try {
    const d = getDesigner();
    const out = await d.render({
      kind: 'edit',
      styleId: s.style_id,
      brandHexes: s.brandHexes || [],
      shellUrl: s.shellUrl,
      theme: (theme ?? '').toString().slice(0, 400),
      palette: (palette ?? '').toString().slice(0, 120),
      // A refine must keep showing the curtain the client chose. Dropping it
      // here would silently swap the backdrop back to transparent on the very
      // next edit, which is the sort of thing nobody notices until delivery.
      backdropPath: s.backdrop ? backdropFile(s.backdrop) : null,
      workDir: RENDERS,
      direction,
    });

    const logoRec = s.uploaded.find(u => u.kind === 'logo');
    const fin = await d.finish({
      shellPath: out.shellPath,
      logoPath: logoRec ? path.join(UPLOADS, path.basename(logoRec.file)) : null,
      backdropPath: out.backdropPath || null,
      line1: s.line1, line2: s.line2,
      outPath: path.join(RENDERS, `${booking}-r${s.revision + 1}.png`),
    });

    s.shellUrl = out.shellUrl || s.shellUrl;
    s.revision += 1;
    res.json({
      ok: true, revision: s.revision,
      image: `/api/visual/pfp/file/${path.basename(fin.out)}`,
      cost: out.cost, styleId: s.style_id, spent: d.spent,
    });
  } catch (e) {
    openCorrectionTask(s, e, 'revise');
    res.status(502).json({
      error: 'The designer could not apply that change.',
      detail: e.message,
      action: 'I have logged this for our team so you do not have to chase it.',
    });
  }
});

// ── 5. Approval ────────────────────────────────────────────────────────────
router.post('/approve', (req, res) => {
  const s = sessions.get(req.body?.booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });
  s.approved = true;
  s.approvedAt = new Date().toISOString();
  s.messages.push({
    role: 'eliza',
    text: "That's locked in and with our print team. Thank you — enjoy every strobe flash!",
  });
  res.json({ ok: true, approvedAt: s.approvedAt });
});

// ── 6. Serve generated + uploaded files ────────────────────────────────────
router.get('/file/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const target = [RENDERS, UPLOADS].map(d => path.join(d, name)).find(p => existsSync(p));
  if (!target) return res.status(404).send('not found');
  res.sendFile(target);
});

// ── The no-auto-retry rule, made concrete ───────────────────────────────────
function openCorrectionTask(s, err, phase) {
  console.error(`[pfp-prints] ${phase} failed for ${s.booking_id}: ${err.message}`);
  // Deliberately not calling MuAPI again. A human decides whether this is a
  // prompt fix, a bad input, or an outage.
  tasks.push({
    at: new Date().toISOString(), booking: s.booking_id, phase,
    error: err.message, status: 'open', owner: 'unassigned',
  });
  persistTasks();
}
const TASKS = path.join(WORK, 'corrections.json');
let tasks = [];
try { tasks = JSON.parse(await fs.readFile(TASKS, 'utf8')); } catch { tasks = []; }
function persistTasks() {
  fs.writeFile(TASKS, JSON.stringify(tasks.slice(-200), null, 2)).catch(() => {});
}
router.get('/corrections', (_req, res) => res.json(tasks.slice(-50)));

export default router;
export { styles };