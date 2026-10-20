#!/usr/bin/env node
/**
 * browser-view — a browser this stack OWNS, streamed live.
 *
 * Why this exists
 * ---------------
 * The relay already drives the user's own Chrome through the Alibaba Page Agent
 * Chrome extension. An extension is a guest in the browser: it cannot attach a
 * debugger to its own host tab, and `chrome.tabs.captureVisibleTab` needs an
 * active-tab grant, so there is no way to stream what it is doing. That is a
 * property of extensions, not of browser automation — this service is the other
 * kind, where the process that launches the browser also watches it.
 *
 * How the stream works
 * --------------------
 * CDP `Page.startScreencast` emits base64 JPEG frames. They are written into a
 * `multipart/x-mixed-replace` HTTP response — the MJPEG trick every IP camera
 * used — so a plain `<img src="/stream">` renders them with no client library
 * and no WebSocket server. Chosen over WebSocket deliberately: `ws` is not a
 * dependency anywhere in this repo, and the point of a first slice is to prove a
 * frame lands, not to pick a transport.
 *
 * Two things learned the hard way, both documented upstream:
 *   1. Ack every frame with `Page.screencastFrameAck` as the first thing you do
 *      on receipt. Skipping the ack is the single most common cause of the
 *      stream stalling at a few FPS.
 *   2. `everyNthFrame` + a modest `quality` matter. Chromium tracks screencast
 *      cost as a real memory/CPU problem (crbug 40934921), and an animated page
 *      at quality 90 will hurt the box this runs on.
 *
 * Security: this exposes a browser that can hold real cookies and logins, and
 * `POST /click` is remote input. It binds 127.0.0.1 only and is meant to sit
 * behind the relay's trust gate. Do not tunnel it unauthenticated.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const HTTP_PORT = parseInt(process.env.BROWSER_VIEW_PORT || '9334', 10);
const CDP_PORT = parseInt(process.env.BROWSER_VIEW_CDP_PORT || '9333', 10);
// A visible window on purpose: the whole point of this browser is that a human
// can watch it and take over. Headless would reintroduce the exact problem
// page-agent has.
const HEADLESS = process.env.BROWSER_VIEW_HEADLESS === 'true';
const PROFILE_DIR = join(ROOT, 'relay-data', 'browser-view-profile');

const SCREENCAST = {
  format: 'jpeg',
  quality: 60,       // 60-70 is indistinguishable for a UI preview and much cheaper
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 2,
};

// Playwright is not a dependency of the relay. It exists in fleet-harness-gui,
// which is the only place in the tree with it installed; resolving from there
// avoids adding a ~150MB browser download to the relay's own tree.
const require = createRequire(import.meta.url);
let chromium;
for (const candidate of [
  join(ROOT, 'fleet-harness-gui', 'package.json'),
  join(__dirname, 'package.json'),
  join(ROOT, 'xmrt-openwork', 'apps', 'desktop', 'skills', 'dev-browser', 'package.json'),
]) {
  if (!existsSync(candidate)) continue;
  try {
    // createRequire(candidate)('playwright') already returns the resolved
    // module — do not wrap it in another require(), which resolves relative to
    // this file instead of the candidate's tree.
    ({ chromium } = createRequire(candidate)('playwright'));
    if (chromium) break;
  } catch (e) {
    console.log(`[browser-view] playwright not resolvable from ${candidate}: ${e.message}`);
  }
}
if (!chromium) {
  console.error('[browser-view] FATAL: playwright not resolvable from', ROOT);
  process.exit(1);
}

let browser = null;
let context = null;
let page = null;
let cdp = null;

// Latest frame per client is handled by broadcasting: every connected viewer
// gets the next frame the browser produces. Viewers are a set of response
// objects, not per-client screencasts — one screencast, N listeners.
const viewers = new Set();
let frameCount = 0;
let lastFrameAt = 0;
let lastUrl = '';
const log = (...a) => console.log('[browser-view]', ...a);

function broadcastFrame(buffer) {
  frameCount++;
  lastFrameAt = Date.now();
  for (const res of viewers) {
    // multipart boundary + headers, then raw JPEG bytes
    res.write(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`
    );
    res.write(buffer);
    res.write('\r\n');
  }
}

async function startBrowser() {
  // A persistent context keeps cookies and logins between runs, which is what
  // makes human takeover (CAPTCHA, passwords) viable at all.
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    channel: 'chrome', // use the installed Chrome, not the bundled build
    viewport: { width: 1280, height: 800 },
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30_000);

  cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');

  cdp.on('Page.screencastFrame', async (frame) => {
    // Ack FIRST. Chrome will not send the next frame until this lands.
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    } catch { /* page may have navigated; the next frame will re-sync */ }
    try {
      broadcastFrame(Buffer.from(frame.data, 'base64'));
    } catch { /* a viewer hung up mid-write */ }
  });

  await cdp.send('Page.startScreencast', SCREENCAST);

  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) lastUrl = f.url();
  });
  page.on('close', () => log('page closed'));

  log(`browser up (headless=${HEADLESS}) cdp=127.0.0.1:${CDP_PORT} profile=${PROFILE_DIR}`);
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);

  // ---- live frame stream -------------------------------------------------
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      Connection: 'close',
    });
    viewers.add(res);
    log(`viewer connected (${viewers.size} total)`);
    req.on('close', () => {
      viewers.delete(res);
      log(`viewer disconnected (${viewers.size} total)`);
    });
    return;
  }

  // ---- status ------------------------------------------------------------
  if (url.pathname === '/status') {
    return json(res, 200, {
      ok: true,
      up: !!page && !page.isClosed(),
      cdpPort: CDP_PORT,
      headed: !HEADLESS,
      profile: PROFILE_DIR,
      url: lastUrl,
      viewers: viewers.size,
      frames: frameCount,
      lastFrameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null,
    });
  }

  // ---- drive it ----------------------------------------------------------
  if (url.pathname === '/navigate' && req.method === 'POST') {
    const { url: target } = await readBody(req);
    if (!target) return json(res, 400, { error: 'url required' });
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      lastUrl = page.url();
      log('navigate', target);
      return json(res, 200, { ok: true, url: lastUrl });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Human takeover. This is the reason the browser is visible and persistent:
  // a person can click the real window, and this forwards clicks made in the
  // Suite's preview pane into the same page.
  if (url.pathname === '/click' && req.method === 'POST') {
    const { x, y, button = 'left', clickCount = 1 } = await readBody(req);
    if (typeof x !== 'number' || typeof y !== 'number') {
      return json(res, 400, { error: 'x and y required' });
    }
    try {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, clickCount,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, clickCount,
      });
      return json(res, 200, { ok: true, x, y });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (url.pathname === '/type' && req.method === 'POST') {
    const { text } = await readBody(req);
    if (typeof text !== 'string') return json(res, 400, { error: 'text required' });
    try {
      for (const ch of text) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ---- READ IT ────────────────────────────────────────────────────────────
  //
  // A stream of frames is for a human to watch. An agent cannot watch: it has
  // no eyes, and clicking at coordinates it cannot see is guessing. So the
  // browser also has to be able to SAY what is on the page, and to point at
  // the things on it.
  //
  // This is what makes the harness UIs steerable by an agent at all: the
  // opencode and dsh web UIs are reachable anonymously through the loopback
  // proxies on :4130 and :4131, and a prompt box is an input element with a
  // placeholder. Text, elements and a fill are all it takes to drive one.
  if (url.pathname === '/text' && req.method === 'GET') {
    const selector = url.searchParams.get('selector') || null;
    const maxChars = Math.min(40000, parseInt(url.searchParams.get('max') || '20000', 10) || 20000);
    try {
      const text = await page.evaluate((sel) => {
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) return null;
        return (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      }, selector);
      return json(res, 200, {
        ok: true,
        url: page.url(),
        text: text === null ? null : String(text).slice(0, maxChars),
        truncated: text !== null && String(text).length > maxChars,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (url.pathname === '/elements' && req.method === 'GET') {
    const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '120', 10) || 120);
    try {
      const elements = await page.evaluate((max) => {
        const out = [];
        const nodes = document.querySelectorAll(
          'input, textarea, select, button, a[href], [role="button"], [role="textbox"], [contenteditable="true"]'
        );
        for (const el of nodes) {
          if (out.length >= max) break;
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (r.width < 2 || r.height < 2) continue;
          out.push({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            id: el.id || null,
            name: el.getAttribute('name') || null,
            placeholder: el.getAttribute('placeholder') || null,
            aria: el.getAttribute('aria-label') || null,
            role: el.getAttribute('role') || null,
            testid: el.getAttribute('data-testid') || null,
            text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 90),
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
          });
        }
        return out;
      }, limit);
      return json(res, 200, { ok: true, url: page.url(), count: elements.length, elements });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Fill a field by selector. page.fill() sets the value AND fires the input
  // events a React-controlled input needs, which a raw key-by-key /type does
  // not - React would keep its own state and throw the characters away.
  if (url.pathname === '/fill' && req.method === 'POST') {
    const { selector, text } = await readBody(req);
    if (!selector || typeof text !== 'string') {
      return json(res, 400, { error: 'selector and text required' });
    }
    try {
      await page.fill(selector, text, { timeout: 15000 });
      return json(res, 200, { ok: true, selector, length: text.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (url.pathname === '/press' && req.method === 'POST') {
    const { key, selector } = await readBody(req);
    if (!key) return json(res, 400, { error: 'key required' });
    try {
      if (selector) await page.focus(selector, { timeout: 10000 });
      await page.keyboard.press(String(key));
      return json(res, 200, { ok: true, key });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: 'not found' });
});

// Loopback only. This browser holds real sessions and accepts remote input.
server.listen(HTTP_PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${HTTP_PORT}`);
});

async function shutdown() {
  log('shutting down');
  for (const v of viewers) { try { v.end(); } catch {} }
  try { await cdp?.send('Page.stopScreencast'); } catch {}
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startBrowser().catch((e) => {
  console.error('[browser-view] FATAL: browser failed to start:', e?.stack || e);
  process.exit(1);
});
