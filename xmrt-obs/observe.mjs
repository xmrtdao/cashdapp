// XMRT Dashboard Observer
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'http://localhost:8080';

// The relay's API key. It was a literal here, which put a live credential in
// the source; it is read from relay/.env (or the environment) instead.
function relayApiKey() {
  if (process.env.RELAY_API_KEY) return process.env.RELAY_API_KEY;
  try {
    const env = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'relay', '.env'),
      'utf8');
    for (const line of env.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0 && t.slice(0, i).trim() === 'RELAY_API_KEY') {
        return t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* fall through */ }
  return '';
}
const API_KEY = relayApiKey();
if (!API_KEY) {
  console.error('RELAY_API_KEY not found in relay/.env or the environment');
  process.exit(1);
}
const SHOT_DIR = 'C:/Users/PureTrek/Desktop/xmrtdao/xmrt-obs/shots';
const REPORT = 'C:/Users/PureTrek/Desktop/xmrtdao/xmrt-obs/observations.jsonl';
const DURATION_MS = 3 * 60 * 1000; // 3 minutes

fs.mkdirSync(SHOT_DIR, { recursive: true });

const log = (obj) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(REPORT, line + '\n');
  if (obj.event) console.log(`[${new Date().toISOString().slice(11, 23)}] ${obj.event}: ${JSON.stringify(obj).slice(0, 200)}`);
};

(async () => {
  log({ event: 'start', duration_ms: DURATION_MS });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      log({ event: 'console', type: t, text: msg.text().slice(0, 500) });
    }
  });
  page.on('pageerror', (err) => {
    log({ event: 'pageerror', text: err.message });
  });
  page.on('requestfailed', (req) => {
    log({ event: 'requestfailed', url: req.url(), reason: req.failure()?.errorText });
  });

  log({ event: 'navigating', url: ROOT });
  await page.goto(ROOT, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));

  const isLoginPage = await page.evaluate(() => !!document.getElementById('loginForm'));
  if (isLoginPage) {
    log({ event: 'login_form_found' });
    await page.type('#keyInput', API_KEY);
    await page.click('#loginForm button[type="submit"]');
    await new Promise((r) => setTimeout(r, 2500));
  } else {
    log({ event: 'already_loaded' });
  }

  const url = page.url();
  log({ event: 'post_login_url', url });
  const hasDashboard = await page.evaluate(() => {
    return {
      hasFleetChat: !!document.getElementById('fleet-chat-msgs'),
      hasTrajectory: !!document.getElementById('trust-trajectory-canvas'),
      hasQDSupervisor: !!document.getElementById('qds-supervisor'),
      title: document.title,
    };
  });
  log({ event: 'dashboard_check', ...hasDashboard });

  if (!hasDashboard.hasFleetChat) {
    log({ event: 'error', msg: 'fleet-chat-msgs element not found; not on dashboard?' });
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '00-initial.png'), fullPage: false });
  log({ event: 'shot', name: '00-initial.png' });

  const start = Date.now();
  let prevFleetChatEmpty = false;
  let prevTrajectoryEmpty = false;
  let shotCounter = 0;
  let pollCounter = 0;
  let apiCallLog = [];

  page.on('response', async (resp) => {
    const u = resp.url();
    if (u.includes('/api/fleet-chat/messages') || u.includes('/api/trustgraph/trajectory')) {
      const status = resp.status();
      apiCallLog.push({
        ts: Date.now(),
        url: u.split('?')[0],
        status,
      });
      if (apiCallLog.length > 200) apiCallLog = apiCallLog.slice(-200);
    }
  });

  while (Date.now() - start < DURATION_MS) {
    pollCounter++;
    try {
      const snap = await page.evaluate(() => {
        const fcEl = document.getElementById('fleet-chat-msgs');
        const trEl = document.getElementById('trust-trajectory-canvas');
        const supEl = document.getElementById('qds-supervisor');
        const evCount = document.getElementById('trajectory-event-count');
        const agCount = document.getElementById('trajectory-agent-count');

        const fcHTML = fcEl ? fcEl.innerHTML : null;
        const fcText = fcEl ? fcEl.textContent.slice(0, 600) : null;
        const fcMsgCount = fcEl ? fcEl.querySelectorAll(':scope > div').length : 0;

        let trDataURL = null;
        let trWidth = null, trHeight = null;
        if (trEl) {
          trWidth = trEl.width;
          trHeight = trEl.height;
          trDataURL = trEl.toDataURL ? trEl.toDataURL().slice(0, 200) : null;
        }

        const fcEmpty = !fcHTML || /Comms temporarily offline|Ship-to-ship comms active/.test(fcHTML);
        const trEmpty = !trEl || trWidth === 0 || trHeight === 0;

        return {
          ts: Date.now(),
          supervisor: supEl ? supEl.textContent.trim() : null,
          fcMsgCount,
          fcHTMLHash: fcHTML ? fcHTML.length : 0,
          fcHTMLShort: fcHTML ? fcHTML.slice(0, 80).replace(/\s+/g, ' ') : null,
          fcTextSample: fcText ? fcText.slice(0, 200).replace(/\s+/g, ' ') : null,
          fcEmpty,
          trWidth, trHeight,
          trDataURLShort: trDataURL,
          trajectoryEventCount: evCount ? evCount.textContent : null,
          trajectoryAgentCount: agCount ? agCount.textContent : null,
          trEmpty,
        };
      });

      const fcWasEmpty = prevFleetChatEmpty;
      const trWasEmpty = prevTrajectoryEmpty;

      if (snap.fcEmpty && !fcWasEmpty) {
        log({ event: 'fleet_chat_WENT_EMPTY', poll: pollCounter, snap });
        shotCounter++;
        const name = `fc-empty-${shotCounter}-${Date.now()}.png`;
        await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
        log({ event: 'shot', name, reason: 'fleet_chat_empty' });
      } else if (!snap.fcEmpty && fcWasEmpty) {
        log({ event: 'fleet_chat_RECOVERED', poll: pollCounter, snap: { fcMsgCount: snap.fcMsgCount } });
      }

      if (snap.trEmpty && !trWasEmpty) {
        log({ event: 'trajectory_WENT_EMPTY', poll: pollCounter, snap });
        shotCounter++;
        const name = `tr-empty-${shotCounter}-${Date.now()}.png`;
        await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
        log({ event: 'shot', name, reason: 'trajectory_empty' });
      } else if (!snap.trEmpty && trWasEmpty) {
        log({ event: 'trajectory_RECOVERED', poll: pollCounter, snap: { trWidth: snap.trWidth } });
      }

      if (pollCounter % 10 === 0) {
        log({
          event: 'periodic',
          poll: pollCounter,
          elapsed_ms: Date.now() - start,
          fcMsgCount: snap.fcMsgCount,
          fcEmpty: snap.fcEmpty,
          trEmpty: snap.trEmpty,
          fcHTMLHash: snap.fcHTMLHash,
          trWidth: snap.trWidth,
          supervisor: snap.supervisor,
          trajectoryEvents: snap.trajectoryEventCount,
          trajectoryAgents: snap.trajectoryAgentCount,
        });
      }

      prevFleetChatEmpty = snap.fcEmpty;
      prevTrajectoryEmpty = snap.trEmpty;
    } catch (err) {
      log({ event: 'evaluate_error', error: err.message });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '99-final.png'), fullPage: false });
  log({ event: 'shot', name: '99-final.png' });

  fs.writeFileSync('C:/Users/PureTrek/Desktop/xmrtdao/xmrt-obs/api-calls.json', JSON.stringify(apiCallLog, null, 2));
  log({ event: 'api_calls_dumped', count: apiCallLog.length });

  await browser.close();
  log({ event: 'done' });
})().catch((err) => {
  console.error('FATAL:', err);
  log({ event: 'fatal', error: err.message, stack: err.stack });
  process.exit(1);
});
