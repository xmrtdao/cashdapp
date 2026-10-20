/**
 * Logo quality gate + safe repair.
 *
 * WHY THIS EXISTS, AND WHY IT REFUSES THE OBVIOUS FIX
 * ----------------------------------------------------
 * A 150x83 logo cannot print at 400px without softening, and the obvious
 * repair is an AI upscaler. That is exactly the wrong tool for a logo, and
 * this repo has the receipts: given a genuinely uploaded KCIC mark through
 * MuAPI's own image-edit path, nano-banana-2-1 rendered the wordmark as
 * "HORN". A diffusion model does not upscale a logo — it reinterprets it, and
 * letterforms are precisely what it cannot keep faithful. "It looked better"
 * and "it is still the client's logo" are different questions.
 *
 * So the safe path is deterministic: Lanczos resampling. It adds no detail
 * that was not there, but it never moves, invents, or mis-shapes a single
 * letter. That is the correct trade for a brand mark.
 *
 * The gate answers the real question — can this file print at the size we
 * intend? — and reports honestly instead of pretending an upscale created
 * resolution that was never there.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The branding zone of a 4x6 card. A logo is placed at most this wide.
export const LOGO_MAX_W = 410;
export const LOGO_MAX_H = 150;

/**
 * Measure a logo against the size it will actually be printed at.
 * @returns {{w:number,h:number,fitScale:number,effectiveDpi:number,verdict:string,note:string}}
 */
export async function assessLogo(filePath) {
  const py = process.env.PFP_PYTHON
    || 'C:\\Users\\PureTrek\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';

  // ffprobe gives dimensions without loading the image.
  let w = 0, h = 0;
  try {
    const fp = 'C:\\tools\\ffprobe.exe';
    const out = await run(fp, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath]);
    const [a, b] = String(out.stdout).split(',').map(s => parseInt(s.trim(), 10));
    if (Number.isFinite(a) && Number.isFinite(b)) { w = a; h = b; }
  } catch { /* fall through to the Python probe below */ }

  if (!w || !h) {
    try {
      const probe = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
                              '..', '..', '_logo_probe.py');
      const out = await run(py, [probe, filePath]);
      const m = String(out.stdout).match(/(\d+)x(\d+)/);
      if (m) { w = +m[1]; h = +m[2]; }
    } catch { /* report unknown rather than guessing */ }
  }

  if (!w || !h) {
    return { w: 0, h: 0, fitScale: 0, effectiveDpi: 0,
             verdict: 'unreadable', note: 'could not measure this file' };
  }

  // How far do we have to grow it to fill the branding zone?
  const fitScale = Math.min(LOGO_MAX_W / w, LOGO_MAX_H / h);

  // A 4x6 card is 4in wide at 300dpi. The branding zone spans most of one
  // strip, so the logo's printed width in inches gives its effective DPI.
  const printedWidthIn = (w * fitScale) / 300;
  const effectiveDpi = printedWidthIn > 0 ? Math.round(w / printedWidthIn) : 0;

  let verdict, note;
  if (effectiveDpi >= 300) {
    verdict = 'print-ready';
    note = 'meets 300dpi at the intended size';
  } else if (effectiveDpi >= 200) {
    verdict = 'marginal';
    note = `prints acceptably at ${effectiveDpi}dpi but not at full 300dpi; ` +
           'it will look slightly soft at arm’s length';
  } else {
    verdict = 'too-low';
    note = `only ~${effectiveDpi}dpi at the intended size — visibly soft on a print`;
  }

  return {
    w, h,
    fitScale: Number(fitScale.toFixed(2)),
    effectiveDpi,
    verdict,
    note,
  };
}

/**
 * Deterministic upscale. Adds no invented detail, and — critically — cannot
 * alter a letterform. This is the only automatic repair we perform.
 */
export async function safeUpscale(filePath, outPath) {
  const py = process.env.PFP_PYTHON
    || 'C:\\Users\\PureTrek\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
  const script = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
    '..', '..', '_logo_resize.py');
  await run(py, [script, filePath, outPath]);
  return outPath;
}

export default { assessLogo, safeUpscale, LOGO_MAX_W, LOGO_MAX_H };