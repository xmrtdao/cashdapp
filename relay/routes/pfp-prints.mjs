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

// The DESIGN PHASE is a picture on a screen. The print is 4x6 at 300dpi; a
// design review does not need that, and a 4.4MB PNG per draft is a 4.4MB
// download per draft. So the studio composes at 72dpi - a quarter of each
// dimension, a sixteenth of the pixels - and the APPROVED file is written at
// 300dpi, once, when the client says yes.
const DESIGN_SCALE = Number(process.env.PFP_DESIGN_SCALE ?? 0.24);

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

/** Per-booking state.
 *
 * It was in a Map on purpose - "a redesign that deserves durable storage
 * deserves a table" - and then a RELAY RESTART took the client's design with
 * it. A paying client who refreshes, or whose server restarts mid-session,
 * came back to a blank studio and a message saying the first draft was
 * being prepared, which it never would be.
 *
 * So the session is written to disk as well. A table is the better answer
 * and still worth doing; until then, this is the difference between a
 * client's work existing and not.
 */
const sessions = new Map();
const SESSION_STORE = path.join(RELAY, 'relay-data', 'pfp-studio-sessions.json');
let storedSessions = {};
try {
  storedSessions = JSON.parse(await fs.readFile(SESSION_STORE, 'utf8'));
} catch { storedSessions = {}; }

let persistTimer = null;
function persistSessions() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const out = {};
      for (const [k, v] of sessions) out[k] = v;
      await fs.writeFile(SESSION_STORE, JSON.stringify(out));
    } catch (e) {
      console.warn('[pfp-prints] could not write the session store:', e.message);
    }
  }, 800);
  persistTimer.unref?.();
}

/** The session for a booking, from memory or from disk. */
function getSession(booking) {
  let s = sessions.get(booking);
  if (!s && storedSessions[booking]) {
    s = storedSessions[booking];
    sessions.set(booking, s);
  }
  return s;
}

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
//
// The THUMBNAIL matters as much as the picture: the full curtain is a
// 1,200-pixel PNG - a megabyte and a half each - and a picker row of eleven
// of them would pull down fifteen megabytes to show eleven swatches. The
// small "-backdrop.jpg" versions are twenty to two hundred kilobytes.
router.get('/backdrops/:slug.png', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '');
  const file = path.join(BACKDROP_DIR, `${slug}.png`);
  if (!existsSync(file)) return res.status(404).json({ error: 'no such backdrop' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

router.get('/backdrops/thumb/:slug.jpg', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '');
  const file = path.join(BACKDROP_DIR, `${slug}-backdrop.jpg`);
  if (!existsSync(file)) return res.status(404).json({ error: 'no such backdrop thumbnail' });
  res.setHeader('Cache-Control', 'public, max-age=604800');
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

  // The booking record is the authority on what this client actually booked:
  // their name, their event, their date. The studio link carries the booking
  // token, so those details are ALREADY in the system by the time the client
  // gets here - and reading them from the booking is the only way they
  // survive, because a link that lost its query string arrives with nothing.
  //
  // This is what lets the confirmation step show the client their own words
  // instead of asking them to type what they already told us.
  //
  // There are TWO ways a booking arrives, so there are two ways to find it:
  //
  //   1. the web funnel, which mints a booking_token in app.pfp_bookings;
  //   2. a booking that came in by REPLY EMAIL, which lands in
  //      public.pfp_bookings against a lead and has no token at all - the
  //      studio link for those clients carries the lead id instead.
  //
  // A studio that only knew about the first door would greet a real,
  // paying, email-booked client as a stranger.
  let booked = null;
  if (/^[A-Za-z0-9_-]{8,64}$/.test(bookingId)) {
    try {
      const rows = await localQuery(
        `SELECT client_name, event_name, event_date
           FROM app.pfp_bookings WHERE booking_token = $1 LIMIT 1`,
        [bookingId]);
      booked = rows[0] || null;
    } catch (e) {
      // A missing table or a database that is down must not take the studio
      // with it: the client gets the studio without the remembered details
      // and can still type them in.
      booked = null;
    }
  }
  if (!booked && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    try {
      const rows = await localQuery(
        `SELECT client_name, event_name, event_date, event_type, venue, package_type, hours
           FROM public.pfp_bookings WHERE lead_id = $1 LIMIT 1`,
        [bookingId]);
      booked = rows[0] || null;
      if (booked && booked.event_type) booked.event_type = booked.event_type;
    } catch (e) {
      booked = null;
    }
  }

  const b = {
    booking_id: bookingId,
    client_name: req.query.name || (booked && booked.client_name) || 'there',
    event_name: req.query.event || (booked && booked.event_name) || 'your celebration',
    event_type: req.query.type || (booked && booked.event_type) || 'celebration',
    event_date: req.query.date || (booked && booked.event_date) || null,
    venue: (booked && booked.venue) || null,
    hours: req.query.hours ? Number(req.query.hours) : (booked && booked.hours) || null,
    package_type: req.query.package || (booked && booked.package_type) || null,
  };

  const styleFor = {
    wedding: 'wedding_classic', graduation: 'graduation_prestige',
    homecoming: 'hoco_prom', prom: 'hoco_prom',
    corporate: 'corporate_holiday', holiday: 'corporate_holiday',
    christmas: 'corporate_holiday', birthday: 'celebration',
    quince: 'celebration', 'bar mitzvah': 'celebration',
  }[String(b.event_type).toLowerCase()] || 'corporate_holiday';

  // RESUME, do not start again.
  //
  // This route used to build a brand new session every time it was opened, so
  // a client who refreshed the page - or opened the studio in a second tab -
  // lost the draft they had already paid for, the documents they had
  // uploaded, and the conversation they had with Eliza. The session is the
  // work; opening the studio is not a request to throw it away.
  const existing = getSession(bookingId);
  if (existing) {
    // The booking is still the authority, but only where it says something
    // real: the placeholder must not overwrite what the client has already
    // told us.
    if (booked && booked.client_name) existing.client_name = booked.client_name;
    if (booked && booked.event_name) existing.event_name = booked.event_name;
    if (booked && booked.event_date) existing.event_date = booked.event_date;
    persistSessions();
    return res.json({ ...existing, styles, resuming: true });
  }

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
  persistSessions();
  res.json({ ...session, styles, resuming: false });
});

// (The magic-link recovery endpoint was removed when the studio opened to
// every visitor. A client who has no booking reference gets an anonymous
// session immediately; there is nothing to recover.)

/**
 * The theme line for the artwork prompt.
 *
 * Two things can carry a theme: what the client typed, and the mood read off
 * the design reference they uploaded. Both are the client's own words, so both
 * are passed through - but the typed one goes first, because it is the more
 * deliberate signal and the mood is a reading of a picture.
 */
function themeText(typed, mood) {
  const bits = [String(typed || '').trim(), String(mood || '').trim()].filter(Boolean);
  return bits.join(' — ').slice(0, 400);
}

// ── 2. Client upload: logo, inspiration, or design theme ───────────────────
// A logo is stored as an immutable asset and its palette is read from pixels.
// Inspiration (an invitation) is noted and will drive the next draft.
//
// The THIRD kind is the design reference: a picture of the look the client
// wants, rather than of the words on the invitation. It is kept separate on
// purpose. The invitation upload is about CONTENT - the wording, the fonts,
// the logo to keep - so it drives the client's brand colours and, when it
// reads clearly enough, the event style. The theme upload is about the
// BACKGROUND - the mood, the colours, the feel of the artwork - so it must
// never overwrite the brand colours or the event type the client already
// chose. One upload answering two different questions at once is how a
// client's invitation colours end up nowhere.
router.post('/upload', async (req, res) => {
  const { booking, kind = 'logo', dataUrl, fileName } = req.body || {};
  const s = getSession(booking);
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
  // A logo is stamped verbatim, so there is only ever one: a new one replaces
  // the old. A design reference is one picture, so it replaces too. Everything
  // else is a DOCUMENT the client gave us, and those ACCUMULATE - a menu and
  // a details sheet are two documents, not two versions of one, and keeping
  // only the last would silently throw half of their wording away.
  if (kind === 'inspiration') {
    s.uploaded = s.uploaded.concat(rec);
  } else {
    s.uploaded = s.uploaded.filter(u => u.kind !== kind).concat(rec);
  }

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
    if (kind === 'theme') {
      // A design reference is not an event document. It must not move the
      // style: the client has already said what kind of event this is, and a
      // picture of a floral arrangement is not a reason to call it a wedding.
      // What it does carry is the mood and the colours of the background.
      s.themeMood = String(detected.mood || '').slice(0, 120);
      s.themePalette = Array.isArray(detected.palette) ? detected.palette.slice(0, 3) : [];
    } else {
      chosenStyle = styleForEvent(detected.event, detected.kind);
      // A logo is a logo wherever it came from; anything else only moves the
      // style if it actually reads as an event. The most recent definite read
      // wins, and a file that reads as nothing leaves the style alone.
      if (chosenStyle) s.style_id = chosenStyle;
      if (detected.palette && detected.palette.length && kind !== 'logo') {
        s.brandHexes = detected.palette;
      }
      // The words on the document, when they can be read. These are what the
      // client is asked to confirm - we would rather ask than print a date
      // nobody checked.
      if (kind === 'inspiration') {
        if (detected.title) s.parsedTitle = String(detected.title).slice(0, 120);
        if (detected.date) s.parsedDate = String(detected.date).slice(0, 60);
      }
    }
  } catch (e) {
    console.warn('[pfp-prints] upload detection failed:', e.message);
  }

  res.json({
    ok: true, ...rec, brandHexes: s.brandHexes || [],
    detected, styleId: chosenStyle || s.style_id,
    themeMood: s.themeMood || '', themePalette: s.themePalette || [],
    // What the documents said, so the client can be shown it and asked to
    // confirm it rather than printing a date nobody checked.
    parsedTitle: s.parsedTitle || '', parsedDate: s.parsedDate || '',
    documents: s.uploaded.filter(u => u.kind === 'inspiration').length,
    note: kind === 'logo'
      ? 'Logo stored untouched and used as-is. It will not be redrawn or enhanced.'
      : kind === 'theme'
        ? 'Design reference received — the background will be built around it.'
        : 'Inspiration received — the next draft will be built around it.',
  });
  // The client's work outlives the process: a restart must not take it away.
  persistSessions();
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
  const s = getSession(booking);
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
      theme: themeText(theme ?? s.theme, s.themeMood),
      palette: (palette ?? s.palette ?? '').toString().slice(0, 120),
      moodHexes: s.themePalette || [],
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
      scale: DESIGN_SCALE,
    });

    s.style_id = styleId;
    s.line1 = line1 ?? s.line1;
    s.line2 = line2 ?? s.line2;
    s.theme = (theme ?? s.theme ?? '').toString().slice(0, 400);
    s.palette = (palette ?? s.palette ?? '').toString().slice(0, 120);
    s.shellUrl = shell.shellUrl;
    // The shell on disk as well as in the cloud: changing the curtain
    // re-composites the design they already have, and that needs the file.
    s.shellPath = shell.shellPath;
    // The finished print, so that a client who comes back - or whose page is
    // reloaded - sees their design rather than a message saying the first
    // draft is being prepared.
    s.printUrl = `/api/visual/pfp/file/${path.basename(out.out)}`;
    s.revision += 1;

    res.json({
      ok: true, revision: s.revision,
      image: `/api/visual/pfp/file/${path.basename(out.out)}`,
      shell: `/api/visual/pfp/file/${path.basename(shell.shellPath)}`,
      geometry: out.geometry, cost: shell.cost,
      seconds: Math.round((Date.now() - started) / 1000),
      styleId, theme: s.theme, palette: s.palette,
      themeMood: s.themeMood || '', themePalette: s.themePalette || [],
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
  // The client's work outlives the process: a restart must not take it away.
  persistSessions();
});

// ── 5. Options: several designs for the client to choose between ───────────
//
// A client does not know what they want. They know they want it to look
// like the invitation, and like the picture they showed you, and they would
// rather not have to describe it in words. So the studio offers three
// DESIGNS, and each one is a direction that came from their own documents:
//
//   1. the colours on their invitation
//   2. the colours in the design reference they showed us
//   3. the style's own palette - the classic version of what they chose
//
// The shell is what costs money, so the options are rendered as shells and
// composited locally; picking one afterwards re-composites and costs nothing
// further. A failure opens a task and never auto-retries, like every other
// generation here.
router.post('/options', async (req, res) => {
  const { booking } = req.body || {};
  const s = getSession(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });
  if (!s.shellUrl) {
    return res.status(409).json({ error: 'no design yet — draw one first' });
  }

  const style = STYLE_BANK[s.style_id] || STYLE_BANK[Object.keys(STYLE_BANK)[0]];
  const candidates = [];
  const push = (label, hexes, source) => {
    const list = (hexes || []).filter(Boolean);
    if (!list.length) return;
    const palette = list.join(', ');
    if (candidates.some((c) => c.palette === palette)) return;
    candidates.push({ label, palette, source });
  };
  push('The colours on your invitation', s.brandHexes, 'brand');
  push('The design you showed us', s.themePalette, 'reference');
  push('The classic version', style.accentHexes, 'style');
  if (!candidates.length) push('The classic version', style.accentHexes, 'style');

  const logoRec = s.uploaded.find((u) => u.kind === 'logo');
  const theme = themeText(s.theme, s.themeMood);
  const started = Date.now();
  const options = [];
  let spent = 0;

  try {
    const d = getDesigner();
    for (const c of candidates) {
      const shell = await d.render({
        kind: 'draft',
        styleId: s.style_id,
        brandHexes: s.brandHexes || [],
        hasLogo: !!logoRec,
        theme,
        palette: c.palette,
        moodHexes: s.themePalette || [],
        backdropPath: s.backdrop ? backdropFile(s.backdrop) : null,
        workDir: RENDERS,
      });
      spent += shell.cost || 0;
      const out = await d.finish({
        shellPath: shell.shellPath,
        logoPath: logoRec ? path.join(UPLOADS, path.basename(logoRec.file)) : null,
        backdropPath: shell.backdropPath || null,
        line1: s.line1,
        line2: s.line2,
        outPath: path.join(RENDERS, `${booking}-opt${options.length + 1}.png`),
        scale: DESIGN_SCALE,
      });
      options.push({
        label: c.label,
        source: c.source,
        palette: c.palette,
        image: `/api/visual/pfp/file/${path.basename(out.out)}`,
        shellUrl: shell.shellUrl,
        shellPath: shell.shellPath,
      });
    }

    // Kept on the session so that choosing one is free: the shell is already
    // rendered, it only has to be composited onto the print.
    s.options = options.map((o) => ({
      label: o.label, source: o.source, palette: o.palette,
      image: o.image, shellUrl: o.shellUrl, shellPath: o.shellPath,
    }));

    res.json({
      ok: true, options,
      cost: Number(spent.toFixed(3)),
      seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (e) {
    openCorrectionTask(s, e, 'options');
    res.status(502).json({
      error: 'The designer could not finish those options.',
      detail: e.message,
      action: 'I have logged this for our team so you do not have to chase it.',
    });
  }
  // The client's work outlives the process: a restart must not take it away.
  persistSessions();
});

/** Adopt one of the options: the shell is already rendered, so this is free. */
router.post('/options/choose', async (req, res) => {
  const { booking, index } = req.body || {};
  const s = getSession(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });
  const opt = (s.options || [])[Number(index)];
  if (!opt) return res.status(404).json({ error: 'no such option' });

  try {
    const d = getDesigner();
    const logoRec = s.uploaded.find((u) => u.kind === 'logo');
    s.palette = opt.palette;
    const out = await d.finish({
      shellPath: opt.shellPath,
      logoPath: logoRec ? path.join(UPLOADS, path.basename(logoRec.file)) : null,
      backdropPath: s.backdrop ? backdropFile(s.backdrop) : null,
      line1: s.line1,
      line2: s.line2,
      outPath: path.join(RENDERS, `${booking}-r${s.revision + 1}.png`),
      scale: DESIGN_SCALE,
    });
    s.shellUrl = opt.shellUrl;
    s.printUrl = `/api/visual/pfp/file/${path.basename(out.out)}`;
    s.revision += 1;
    res.json({
      ok: true, revision: s.revision,
      image: `/api/visual/pfp/file/${path.basename(out.out)}`,
      shell: opt.shellUrl,
      geometry: out.geometry, cost: 0, spent: d.spent,
      label: opt.label, palette: opt.palette,
    });
  } catch (e) {
    openCorrectionTask(s, e, 'options/choose');
    res.status(502).json({
      error: 'The designer could not apply that option.',
      detail: e.message,
      action: 'I have logged this for our team so you do not have to chase it.',
    });
  }
});

// ── 5b. Change the curtain, keep the design ────────────────────────────────
//
// The backdrop is a LAYER of the print, not a part of the artwork: the
// artwork is the shell, and the curtain is composited behind it. So changing
// the curtain re-composites the design they already have and costs nothing
// - no model, no money, and the design they chose is not thrown away and
// redrawn into something else.
router.post('/backdrop', async (req, res) => {
  const { booking, backdrop } = req.body || {};
  const s = getSession(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });

  // The shell on disk. A session that was drawn before the path was kept has
  // only the cloud copy, so fetch it once - it is the design the client
  // chose, and re-drawing it would be a different design.
  let shellPath = s.shellPath;
  if (!shellPath && s.shellUrl) {
    try {
      const buf = Buffer.from(await (await fetch(s.shellUrl)).arrayBuffer());
      shellPath = path.join(RENDERS, `${s.booking_id}-shell.jpg`);
      await fs.writeFile(shellPath, buf);
      s.shellPath = shellPath;
    } catch (e) {
      return res.status(409).json({ error: 'the design could not be fetched — draw it again' });
    }
  }
  if (!shellPath) return res.status(409).json({ error: 'no design yet' });

  // "none" is a real choice: some clients want the transparent cut-out.
  const slug = String(backdrop || '').trim();
  const file = slug && slug !== 'none' ? backdropFile(slug) : null;
  if (slug && slug !== 'none' && !file) {
    return res.status(400).json({ error: 'unknown backdrop' });
  }

  try {
    const d = getDesigner();
    const logoRec = s.uploaded.find((u) => u.kind === 'logo');
    s.backdrop = file ? slug : null;
    const out = await d.finish({
      shellPath,
      logoPath: logoRec ? path.join(UPLOADS, path.basename(logoRec.file)) : null,
      backdropPath: file,
      line1: s.line1,
      line2: s.line2,
      outPath: path.join(RENDERS, `${booking}-r${s.revision + 1}.png`),
      scale: DESIGN_SCALE,
    });
    s.revision += 1;
    s.printUrl = `/api/visual/pfp/file/${path.basename(out.out)}`;
    persistSessions();
    res.json({
      ok: true, image: s.printUrl, revision: s.revision,
      backdrop: s.backdrop, cost: 0, spent: d.spent,
    });
  } catch (e) {
    openCorrectionTask(s, e, 'backdrop');
    res.status(502).json({
      error: 'The designer could not change the curtain.',
      detail: e.message,
      action: 'I have logged this for our team so you do not have to chase it.',
    });
  }
});

// ── 6. Revision ────────────────────────────────────────────────────────────
// A revision keeps the client's artwork and adjusts it, instead of handing back
// an entirely different design. Different model on purpose: the edit model
// re-decides composition less destructively than a text-to-image pass.
router.post('/revise', async (req, res) => {
  const { booking, direction, theme, palette } = req.body || {};
  const s = getSession(booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });
  if (!s.shellUrl) return res.status(409).json({ error: 'no draft to revise yet' });

  try {
    const d = getDesigner();
    const out = await d.render({
      kind: 'edit',
      styleId: s.style_id,
      brandHexes: s.brandHexes || [],
      shellUrl: s.shellUrl,
      // A refinement keeps the client's own direction, including the mood of
      // the design reference they uploaded - otherwise the first refinement
      // would quietly lose it.
      theme: themeText(theme ?? s.theme, s.themeMood),
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
      scale: DESIGN_SCALE,
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
  // The client's work outlives the process: a restart must not take it away.
  persistSessions();
});

// ── 5. Approval ────────────────────────────────────────────────────────────
// Approving writes the PRINT: the same design, composited at 300dpi, which is
// the file the print team cuts. The studio was working at 72dpi because the
// client was reviewing a picture on a screen; this is the moment that stops
// being true. It is a local composite of the shell they already chose - no
// model, no money, and not a redraw that might not be the design they liked.
router.post('/approve', async (req, res) => {
  const s = getSession(req.body?.booking);
  if (!s) return res.status(404).json({ error: 'unknown booking' });

  let print = null;
  if (s.shellPath) {
    try {
      const d = getDesigner();
      const logoRec = s.uploaded.find((u) => u.kind === 'logo');
      const out = await d.finish({
        shellPath: s.shellPath,
        logoPath: logoRec ? path.join(UPLOADS, path.basename(logoRec.file)) : null,
        backdropPath: s.backdrop ? backdropFile(s.backdrop) : null,
        line1: s.line1,
        line2: s.line2,
        outPath: path.join(RENDERS, `${s.booking_id}-print.png`),
        scale: 1,
      });
      print = {
        file: `/api/visual/pfp/file/${path.basename(out.out)}`,
        dpi: out.dpi, size: out.file, bytes: out.bytes,
      };
      s.printFile = print.file;
    } catch (e) {
      // The approval is still recorded - the client said yes - and the
      // failure is logged for a human, exactly like every other generation
      // failure here. Never auto-retried.
      openCorrectionTask(s, e, 'print');
    }
  }

  s.approved = true;
  s.approvedAt = new Date().toISOString();
  s.messages.push({
    role: 'eliza',
    text: "That's locked in and with our print team. Thank you — enjoy every strobe flash!",
  });
  persistSessions();
  res.json({ ok: true, approvedAt: s.approvedAt, print });
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