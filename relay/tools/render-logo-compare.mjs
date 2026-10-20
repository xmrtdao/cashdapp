/**
 * Render the traced SVG so it can be LOOKED at, not just measured.
 *
 * cairosvg needs a native cairo library that is not present on this box, so
 * this renders in Chromium — which the repo already has via Puppeteer and which
 * renders SVG natively. A vector that traces to 82 paths proves nothing about
 * fidelity; the only test that matters is whether the letterforms survived.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const [rasterArg, vectorArg, outArg] = process.argv.slice(2);
if (!rasterArg || !vectorArg || !outArg) {
  console.error('usage: node render-logo-compare.mjs <raster.png> <vector.svg> <out.png>');
  process.exit(2);
}

const svg = await fs.readFile(vectorArg, 'utf8');
const rasterBuf = await fs.readFile(rasterArg);
const rasterData = `data:image/png;base64,${rasterBuf.toString('base64')}`;
const WIDTH = 1100;

// The traced SVG carries its source's intrinsic width/height, so it renders
// tiny. Strip those and let CSS drive the size — that is the whole point of
// having a vector, and it is worth seeing at print scale.
const scalable = svg
  .replace(/\swidth="[^"]*"/i, '')
  .replace(/\sheight="[^"]*"/i, '')
  .replace('<svg', `<svg width="100%" height="auto"`);

const html = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;background:#fff;font:13px system-ui,sans-serif;color:#555}
  .row{padding:18px 24px;border-bottom:1px solid #eee}
  .lbl{margin-bottom:10px;letter-spacing:.4px;text-transform:uppercase;font-size:11px}
  .art{display:block;width:${WIDTH}px;height:auto}
</style>
<div class="row"><div class="lbl">original raster ${WIDTH}px &mdash; what upscaling gives you</div>
  <img class="art" src="${rasterData}"></div>
<div class="row"><div class="lbl">traced vector at ${WIDTH}px &mdash; what vectorising gives you</div>
  <div class="art">${scalable}</div>`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: WIDTH + 60, height: 1600, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle0' });
const buf = await page.screenshot({ fullPage: true });
await fs.writeFile(outArg, buf);
await browser.close();

const w = await (async () => {
  const { PNG_MAGIC } = {};
  return PNG_MAGIC;
})().catch(() => null);
console.log(`rendered ${path.basename(outArg)}  (${(buf.length / 1024).toFixed(0)} KB)`);
console.log('  top    : original raster enlarged');
console.log('  bottom : traced SVG paths');