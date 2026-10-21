/**
 * PFP Production Compositor — owns everything a print file must be exact about.
 *
 * WHY THIS EXISTS (measured, not assumed)
 *   nano-banana-2-1 and nano-banana-pro were both given "exactly THREE windows
 *   in a strict 3:2 aspect ratio" on the same prompt. Both returned FOUR
 *   near-square windows. The $0.12 model did not fix a problem the $0.04 model
 *   failed at. Pixel geometry is not a prompt problem, so it is owned here.
 *
 *   The same two models, given a genuinely uploaded logo via the reference
 *   prompt, still redrew it (one produced "HORN" in place of the KCIC mark).
 *   A client's logo is therefore ALWAYS stamped from the original file.
 *
 * WHAT THE MODEL SUPPLIES : background, ornament, brand mood.
 * WHAT THIS FILE SUPPLIES : exact geometry, true alpha windows, the original
 *                           logo, and real font rendering — identical on both
 *                           strips because the printer cuts down the middle.
 *
 * Output: 1200x1800 PNG (4x6in @ 300dpi), 6 transparent 3:2 windows.
 *
 * CONTRAST IS DERIVED, NOT ASSUMED
 *   The first pass hard-coded light type and a dark scrim. On a cream wedding
 *   ground that produced white-on-cream text and a dark green band across the
 *   bottom of the card. Two of the six house styles have light grounds, so the
 *   scrim and both text colours are now measured from the artwork's own lower
 *   band and flipped to suit.
 *
 * THE TYPE FOLLOWS THE INVITATION
 *   The first pass set the headline in Georgia at 38px on a 1200px card. That
 *   is a caption: the client was shown a line of small type in a band of
 *   empty cream, in a face that looked nothing like the invitation they had
 *   sent. The invitation sets a flowing script for the names and an elegant
 *   serif for the date, so the print does the same - and the headline wraps
 *   and fills the band instead of hiding in it.
 *
 * THE FILE IS AS BIG AS IT NEEDS TO BE
 *   4x6 at 300dpi is the PRINT. During the design phase the client is
 *   reviewing a picture on a screen, and a 4.4MB PNG for that is a 4.4MB
 *   download per draft. The composition is drawn at print size and scaled
 *   down on the way out, so the geometry is identical either way; only the
 *   file gets smaller. The approved proof is still written at 300dpi.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

// ── Print geometry. 4x6in @ 300dpi ─────────────────────────────────────────
export const CARD_W = 1200;
export const CARD_H = 1800;
export const STRIP_W = CARD_W / 2;              // 600 — two 2x6 strips
const MARGIN_X = 45;
export const WIN_W = STRIP_W - MARGIN_X * 2;   // 510
export const WIN_H = WIN_W / 1.5;              // 340 — strict 3:2
const FRAME_TOP = 70;
const FRAME_GAP = 70;
export const FRAME_TOPS = [0, 1, 2].map(i => FRAME_TOP + i * (WIN_H + FRAME_GAP));
export const BRAND_TOP = FRAME_TOPS[2] + WIN_H + 60;

// ── The type, taken from the invitation ────────────────────────────────────
// Great Vibes is the flowing script the client's invitation is set in;
// Cormorant Garamond is the quiet serif under it. Both are fetched once and
// cached on disk, then embedded in the page as base64: a page with no
// filesystem access cannot load a font from a file:// URL, and the headless
// browser has no origin to fetch one from either.
const FONT_FAMILIES = [
  { family: 'Great Vibes', query: 'Great+Vibes' },
  { family: 'Cormorant Garamond', query: 'Cormorant+Garamond:wght@400;500;600' },
];
const FONT_CACHE = path.join(REPO, 'partyfavorphoto', 'assets', 'fonts');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let fontCssPromise = null;
/** The @font-face rules for the two families, with the woff2 files inlined. */
function fontCss() {
  if (fontCssPromise) return fontCssPromise;
  fontCssPromise = (async () => {
    const rules = [];
    for (const { family, query } of FONT_FAMILIES) {
      const url = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
      const css = await fetch(url, { headers: { 'User-Agent': UA } }).then((r) => r.text());
      // Every @font-face block in the response, with its file inlined. The
      // response carries one block per unicode range; keeping them all is
      // what makes the ligatures and the ampersand render right.
      const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
      for (const block of blocks) {
        const src = block.match(/url\((https:[^)]+\.woff2)\)/);
        if (!src) continue;
        const file = path.join(FONT_CACHE, `${family}-${path.basename(src[1])}`);
        let b64;
        try {
          b64 = (await fs.readFile(file)).toString('base64');
        } catch {
          const buf = Buffer.from(await fetch(src[1]).then((r) => r.arrayBuffer()));
          await fs.mkdir(FONT_CACHE, { recursive: true });
          await fs.writeFile(file, buf);
          b64 = buf.toString('base64');
        }
        rules.push(block.replace(src[1], `data:font/woff2;base64,${b64}`));
      }
    }
    return rules.join('\n');
  })();
  return fontCssPromise;
}

/** Perceived luminance of a hex colour, 0..1. */
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Type + scrim colours for a given ground. One rule, both directions. */
export function paletteForGround(groundHex) {
  return luminance(groundHex) > 0.55
    ? { onLight: true,  primary: '#1B1B1B', secondary: '#A2540F',
        scrimTop: 'rgba(255,253,248,0)', scrimMid: 'rgba(255,253,248,0.62)', scrimEnd: 'rgba(255,253,248,0.80)' }
    : { onLight: false, primary: '#F2F4F5', secondary: '#F06020',
        scrimTop: 'rgba(8,26,17,0)',    scrimMid: 'rgba(8,26,17,0.55)',   scrimEnd: 'rgba(8,26,17,0.78)' };
}

export async function composite(job) {
  const shell = await toDataUri(job.shellPath);
  const logoSrc = job.logoPath ? await toDataUri(job.logoPath) : null;
  const backdropSrc = job.backdropPath ? await toDataUri(job.backdropPath) : null;

  // The type, as the invitation sets it. Embedded rather than linked: the
  // page has no origin to fetch a font from, and a canvas silently falls back
  // to a default face when the wanted one never arrives - which is how the
  // print ended up in a plain sans while the invitation was in a script.
  const css = await fontCss();

  // The file is only as big as it needs to be. The composition is drawn at
  // print size and scaled on the way out, so the geometry is identical; the
  // design phase just does not carry a 300dpi file around.
  const scale = Math.max(0.05, Math.min(1, Number(job.scale) || 1));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox'],
  });
  // The browser is closed however this ends. A composite that throws used to
  // leave a headless Chrome running, and the NEXT composite then refused to
  // start because that profile was still in use - so one failure broke every
  // render after it.
  try {
    return await compositeIn(browser, job, css, scale, shell, logoSrc, backdropSrc);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function compositeIn(browser, job, css, scale, shell, logoSrc, backdropSrc) {
  const page = await browser.newPage();
  await page.setViewport({ width: CARD_W, height: CARD_H, deviceScaleFactor: 1 });
  await page.evaluate((fontCssText) => {
    const s = document.createElement('style');
    s.textContent = fontCssText;
    document.head.appendChild(s);
  }, css);
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await Promise.all([
        document.fonts.load('400 190px "Great Vibes"'),
        document.fonts.load('500 74px "Cormorant Garamond"'),
      ]).catch(() => {});
      await document.fonts.ready;
    }
  });

  const result = await page.evaluate(async (shellSrc, logo, backdrop, line1, line2,
                                           cW, cH, sW, winW, winH, tops, brandTop) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shellSrc; });

    // The client's chosen curtain, shown THROUGH the windows so they can see
    // what the finished strip will look like on the night. Loaded here rather
    // than passed as a raw path: the page has no filesystem access.
    let bdImg = null;
    if (backdrop) {
      bdImg = new Image();
      await new Promise((res, rej) => { bdImg.onload = res; bdImg.onerror = rej; bdImg.src = backdrop; });
    }

    const cv = document.createElement('canvas');
    cv.width = cW; cv.height = cH;
    const ctx = cv.getContext('2d');

    // Crop to fill, never letterbox: a print has no white margin to hide behind.
    const scale = Math.max(cW / img.width, cH / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (cW - dw) / 2, (cH - dh) / 2, dw, dh);

    // ── Measure the ground we actually got ─────────────────────────────────
    // Sampling the artwork is why this is right for an unanticipated style:
    // no per-style table can drift out of sync with what was generated.
    const band = ctx.getImageData(0, Math.floor(cH * 0.72), cW,
                                  Math.floor(cH * 0.24)).data;
    let sum = 0;
    for (let i = 0; i < band.length; i += 4) {
      sum += 0.2126 * band[i] + 0.7152 * band[i + 1] + 0.0722 * band[i + 2];
    }
    const avg = sum / (band.length / 4) / 255;
    const onLight = avg > 0.55;
    const ink = onLight
      ? { primary: '#1B1B1B', secondary: '#A2540F',
          s0: 'rgba(255,253,248,0)', s1: 'rgba(255,253,248,0.62)', s2: 'rgba(255,253,248,0.82)' }
      : { primary: '#F2F4F5', secondary: '#F06020',
          s0: 'rgba(8,26,17,0)',    s1: 'rgba(8,26,17,0.55)',    s2: 'rgba(8,26,17,0.78)' };

    // ── Windows ───────────────────────────────────────────────────────────
    const BEVEL = 9;
    for (const strip of [0, 1]) {
      const x = strip * sW + (sW - winW) / 2;
      for (const top of tops) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = '#000';
        ctx.fillRect(x, top, winW, winH);
        ctx.globalCompositeOperation = 'source-over';

        // Fill the hole with the curtain, BEFORE the bevel is stroked, so the
        // bevel sits on top of the image rather than being covered by it.
        //
        // Cover-crop, not contain: a print window has no letterbox to hide
        // behind, and a pillarboxed curtain would read as a mistake. The
        // horizontal offset varies per window so six identical crops do not
        // read as six copies of one photograph.
        if (bdImg) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, top, winW, winH);
          ctx.clip();
          const bs = Math.max(winW / bdImg.width, winH / bdImg.height);
          const bdw = bdImg.width * bs, bdh = bdImg.height * bs;
          const seed = (strip * 3 + tops.indexOf(top)) * 0.17;
          ctx.drawImage(bdImg, x + (winW - bdw) / 2 - bdw * seed * 0.06,
                        top + (winH - bdh) / 2, bdw, bdh);
          ctx.restore();
        }

        const g = ctx.createLinearGradient(x, top, x, top + winH);
        g.addColorStop(0, '#F2F4F5');
        g.addColorStop(0.45, '#9AA0A6');
        g.addColorStop(0.5, '#5B6068');
        g.addColorStop(1, '#C9CDD2');
        ctx.strokeStyle = g;
        ctx.lineWidth = BEVEL;
        ctx.strokeRect(x - BEVEL / 2, top - BEVEL / 2, winW + BEVEL, winH + BEVEL);
      }
    }

    // ── Logo: knock the white substrate out to alpha ────────────────────────
    // Logos arrive as marks on a white page. Printing that page would drop a
    // white rectangle onto the card.
    let logoImage = null;
    if (logo) {
      const li = new Image();
      await new Promise((res, rej) => { li.onload = res; li.onerror = rej; li.src = logo; });
      const lc = document.createElement('canvas');
      lc.width = li.width; lc.height = li.height;
      const lx = lc.getContext('2d', { willReadFrequently: true });
      lx.drawImage(li, 0, 0);
      const d = lx.getImageData(0, 0, lc.width, lc.height);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] > 236 && p[i + 1] > 236 && p[i + 2] > 236) p[i + 3] = 0;
      }
      lx.putImageData(d, 0, 0);
      logoImage = lc;
    }

    // ── Scrim: a gradient, not a panel, so ornament still reads through ─────
    // Sized to the branding block itself. An earlier pass started it 110px above
    // the block and ran it to the card's foot, which turned the whole bottom
    // quarter into a near-black band on a dark ground and swallowed the artwork.
    const scrimTop = brandTop - 40;
    const scrimH = 420;
    const sg = ctx.createLinearGradient(0, scrimTop, 0, scrimTop + scrimH);
    sg.addColorStop(0.00, ink.s0);
    sg.addColorStop(0.55, ink.s1);
    sg.addColorStop(1.00, ink.s2);
    ctx.fillStyle = sg;
    ctx.fillRect(0, scrimTop, cW, scrimH);

    // ── Type, fitted to the strip ──────────────────────────────────────────
    // The client's invitation sets the type: a flowing script for the names
    // and a quiet serif under it. The print follows it, and the headline
    // WRAPS - "Natalia Jaffee" over "Jonathan Knapp" - because a single line
    // squeezed to fit a 490px strip is what made the old setting a caption.
    const TEXT_MAX_W = sW - 90;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Greedy wrap, then the largest size at which the wrapped lines still
    // fit the strip AND the band.
    const wrap = (text, family, weight, maxW, px) => {
      ctx.font = `${weight} ${px}px ${family}`;
      const words = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (!words.length) return { lines: [], px };
      const lines = [];
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const next = line + ' ' + words[i];
        if (ctx.measureText(next).width <= maxW) { line = next; continue; }
        lines.push(line);
        line = words[i];
        if (lines.length >= 3) break;
      }
      lines.push(line);
      return { lines, px };
    };

    // The biggest size at which the text fits, found by trying sizes down.
    // The script is short and wide-spaced, so it is measured, not guessed.
    const fitWrapped = (text, family, weight, maxW, startPx, minPx, maxLines) => {
      for (let px = startPx; px >= minPx; px -= 2) {
        const { lines } = wrap(text, family, weight, maxW, px);
        if (lines.length > maxLines) continue;
        ctx.font = `${weight} ${px}px ${family}`;
        const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
        if (widest <= maxW) return { lines, px };
      }
      const { lines } = wrap(text, family, weight, maxW, minPx);
      return { lines, px: minPx };
    };

    const SCRIPT = '"Great Vibes", "Snell Roundhand", cursive';
    const SERIF = '"Cormorant Garamond", Georgia, "Times New Roman", serif';

    // The headline breaks the way the invitation breaks it: the names on
    // their own lines with the ampersand between them. Greedy wrapping alone
    // produced "Natalia Jaffee / & Jonathan / Knapp" - which splits a name
    // across two lines, the one thing a wedding invitation must not do.
    // "Mr & Mrs Smith" is three words and is left alone; four or more with
    // an ampersand in the middle is two couples.
    const headlineParts = (() => {
      const text = String(line1 || '').trim();
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length > 3 && words.includes('&')) {
        const at = words.indexOf('&');
        const left = words.slice(0, at).join(' ');
        const right = words.slice(at + 1).join(' ');
        return [left, '&', right];
      }
      return [text];
    })();

    // Greedy wrap inside a part, then the largest size at which the whole
    // headline still fits the strip AND the band.
    const wrapPart = (text, family, weight, maxW, px) => {
      ctx.font = `${weight} ${px}px ${family}`;
      const words = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const lines = [];
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const next = line + ' ' + words[i];
        if (ctx.measureText(next).width <= maxW) { line = next; continue; }
        lines.push(line);
        line = words[i];
        if (lines.length >= 2) break;
      }
      lines.push(line);
      return lines;
    };

    const fitHeadline = (parts, family, weight, maxW, startPx, minPx) => {
      for (let px = startPx; px >= minPx; px -= 2) {
        const lines = [];
        for (const p of parts) lines.push(...wrapPart(p, family, weight, maxW, px));
        if (lines.length > 3) continue;
        // Every line has to FIT, not just be the right number of them. A
        // single word longer than the strip - "Jaffee-Knapp" - cannot be
        // split, so it overflowed into the other strip and the two copies of
        // the headline landed on top of each other.
        ctx.font = `${weight} ${px}px ${family}`;
        const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
        if (widest <= maxW) return { lines, px };
      }
      const lines = [];
      for (const p of parts) lines.push(...wrapPart(p, family, weight, maxW, minPx));
      return { lines, px: minPx };
    };

    const t1 = fitHeadline(headlineParts, SCRIPT, 400, TEXT_MAX_W, 150, 52);
    const t2 = fitWrapped(line2, SERIF, 500, TEXT_MAX_W * 0.92, 64, 22, 1);

    // Line heights, measured for the faces in use. A script at 150px needs the
    // full 150px between its lines: its ascenders and descenders are the
    // type, and setting them 60% apart draws one line through the other.
    const H1 = t1.px * 1.02;
    const H2 = t2.px * 0.92;

    const LOGO_MAX_W = sW - 190;
    const LOGO_MAX_H = 150;

    // Identical on BOTH strips: the printer cuts down the middle, so two
    // different halves means the client receives two different products.
    for (const strip of [0, 1]) {
      const cx = strip * sW + sW / 2;

      // The type sits in the band under the windows, and is CENTRED in what
      // is left of it: the old setting started at the top of the band and ran
      // off the bottom of the card.
      const blockH = t1.lines.length * H1 + t2.lines.length * H2 + 16;
      let logoBottom = brandTop + 8;
      let logoH = 0;
      if (logoImage) {
        // Never past 1:1 — magnifying a small logo is what makes it blurry.
        const sc = Math.min(LOGO_MAX_W / logoImage.width,
                            LOGO_MAX_H / logoImage.height, 1);
        logoH = logoImage.height * sc;
        ctx.drawImage(logoImage, cx - (logoImage.width * sc) / 2, logoBottom,
                      logoImage.width * sc, logoH);
        logoBottom += logoH + 10;
      }

      const room = cH - logoBottom;
      let cursor = logoBottom + Math.max(0, (room - blockH) / 2) + H1 / 2;

      ctx.shadowColor = onLight ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 2;

      // The headline, wrapped and centred.
      ctx.font = `400 ${t1.px}px ${SCRIPT}`;
      ctx.fillStyle = ink.primary;
      for (const l of t1.lines) {
        ctx.fillText(l, cx, cursor);
        cursor += H1;
      }

      // The date, with the air the invitation gives it.
      cursor += 8;
      ctx.font = `500 ${t2.px}px ${SERIF}`;
      ctx.fillStyle = ink.secondary;
      for (const l of t2.lines) {
        ctx.fillText(l, cx, cursor);
        cursor += H2;
      }
      ctx.shadowColor = 'transparent';
    }

    return { png: cv.toDataURL('image/png'), onLight, avgLuminance: avg };
  }, shell, logoSrc, backdropSrc, job.line1, job.line2, CARD_W, CARD_H, STRIP_W,
     WIN_W, WIN_H, FRAME_TOPS, BRAND_TOP);

  let buf = Buffer.from(result.png.split(',')[1], 'base64');

  // Scale on the way out. The composition above is the print, exactly; this
  // only decides how big the FILE is. 72dpi is a quarter of each dimension -
  // a sixteenth of the pixels - which is all a design review on a screen
  // needs, and it is the difference between a 4.4MB download per draft and
  // a couple of hundred kilobytes.
  if (scale < 0.999) {
    const out = await page.evaluate(async (src, w, h) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const cv = document.createElement('canvas');
      cv.width = Math.round(w); cv.height = Math.round(h);
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    }, `data:image/png;base64,${buf.toString('base64')}`, CARD_W * scale, CARD_H * scale);
    buf = Buffer.from(out.split(',')[1], 'base64');
  }

  await fs.mkdir(path.dirname(job.outPath), { recursive: true });
  await fs.writeFile(job.outPath, buf);

  return {
    out: job.outPath,
    card: `${CARD_W}x${CARD_H}`,
    file: `${Math.round(CARD_W * scale)}x${Math.round(CARD_H * scale)}`,
    dpi: Math.round(300 * scale),
    window: `${WIN_W}x${WIN_H} (${(WIN_W / WIN_H).toFixed(2)}:1)`,
    framesPerStrip: 3,
    strips: 2,
    brandingTop: BRAND_TOP,
    // Surfaced so the UI can explain a dark-on-light flip instead of the
    // client silently wondering why the template changed tone.
    ink: result.onLight ? 'dark-on-light' : 'light-on-dark',
    groundLuminance: Number(result.avgLuminance.toFixed(3)),
    bytes: buf.length,
  };
}

// Inlined as a data URI: a page built with setContent() cannot read local
// files, and a data URI avoids a CORS-taint path entirely.
async function toDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${(await fs.readFile(filePath)).toString('base64')}`;
}

export { FRAME_TOP, FRAME_GAP, MARGIN_X };

// Windows-safe entrypoint check: compare resolved paths, not URL strings.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [, , shellArg, logoArg, outArg, l1, l2] = process.argv;
  if (!shellArg) {
    console.error('usage: node pfp-compositor.mjs <shell.jpg> <logo.png|none> <out.png> "<line1>" "<line2>"');
    process.exit(2);
  }
  const res = await composite({
    shellPath: path.resolve(shellArg),
    logoPath: logoArg && logoArg !== 'none' ? path.resolve(logoArg) : null,
    line1: l1 || '', line2: l2 || '',
    outPath: path.resolve(outArg || path.join(__dirname, '..', '..', '_probe_results', 'final.png')),
  });
  console.log(JSON.stringify(res, null, 2));
}