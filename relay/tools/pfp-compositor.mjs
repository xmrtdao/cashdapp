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
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: CARD_W, height: CARD_H, deviceScaleFactor: 1 });

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
    // A 600px strip has no room for a 38px headline across it; measuring the
    // run is what stops "Company Holiday Party" overflowing into the logo.
    const TEXT_MAX_W = sW - 110;
    const SERIF = 'Georgia, "Times New Roman", serif';
    const SANS = '"Segoe UI", Arial, sans-serif';
    const fit = (text, family, weight, maxW, startPx, minPx) => {
      let px = startPx;
      while (px > minPx) {
        ctx.font = `${weight} ${px}px ${family}`;
        if (ctx.measureText(text).width <= maxW) break;
        px -= 1;
      }
      return px;
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const f1 = fit(line1, SERIF, 600, TEXT_MAX_W, 38, 18);
    const f2 = fit(line2, SANS, 500, TEXT_MAX_W * 0.92, 30, 15);

    const LOGO_MAX_W = sW - 190;
    const LOGO_MAX_H = 150;

    // Identical on BOTH strips: the printer cuts down the middle, so two
    // different halves means the client receives two different products.
    for (const strip of [0, 1]) {
      const cx = strip * sW + sW / 2;
      let cursor = brandTop + 6;

      if (logoImage) {
        // Never past 1:1 — magnifying a small logo is what makes it blurry.
        const sc = Math.min(LOGO_MAX_W / logoImage.width,
                            LOGO_MAX_H / logoImage.height, 1);
        const lw = logoImage.width * sc, lh = logoImage.height * sc;
        ctx.drawImage(logoImage, cx - lw / 2, cursor, lw, lh);
        cursor += lh;
      }

      ctx.shadowColor = onLight ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 2;

      cursor += f1 * 0.62 + 10;
      ctx.fillStyle = ink.primary;
      ctx.fillText(line1, cx, cursor);

      cursor += f1 * 0.60 + 8;
      ctx.fillStyle = ink.secondary;
      ctx.fillText(line2, cx, cursor);
      ctx.shadowColor = 'transparent';
    }

    return { png: cv.toDataURL('image/png'), onLight, avgLuminance: avg };
  }, shell, logoSrc, backdropSrc, job.line1, job.line2, CARD_W, CARD_H, STRIP_W,
     WIN_W, WIN_H, FRAME_TOPS, BRAND_TOP);

  const buf = Buffer.from(result.png.split(',')[1], 'base64');
  await fs.mkdir(path.dirname(job.outPath), { recursive: true });
  await fs.writeFile(job.outPath, buf);
  await browser.close();

  return {
    out: job.outPath,
    card: `${CARD_W}x${CARD_H}`,
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