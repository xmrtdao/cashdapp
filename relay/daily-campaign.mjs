#!/usr/bin/env node
/**
 * Daily Campaign Send — Party Favor Photo
 * Sends outreach emails from the seasonal-scraper contact pool. Usage: daily-campaign.mjs [count=50]
 * Called by Windows Task Scheduler at 8:00 AM daily.
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = path.join(__dirname, '.env');
const env = fs.readFileSync(envPath, 'utf8').split('\n').reduce((acc, line) => {
  const [k, ...v] = line.split('=');
  if (k) acc[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
  return acc;
}, {});

const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const FALLBACK_KEY = env.RESEND_XMRT_API_KEY;
if (!KEY) { console.error('No SUPABASE key'); process.exit(1); }

const API = 'https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/resend-email';
const CONTACTS_FILE = path.join(__dirname, '..', 'relay-data', 'campaign-contacts.json');
const LOG_FILE = path.join(__dirname, '..', 'relay-data', 'campaign.log');
const SENT_FILE = path.join(__dirname, '..', 'relay-data', 'campaign-sent.json');

// Load contacts, mark sent ones
let contacts = [];
try { contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { contacts = []; }

let sentHistory = [];
try { sentHistory = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch { sentHistory = []; }

// Filter out already-sent emails (last 30 days)
const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
const recentSent = new Set(sentHistory.filter(s => s.ts > cutoff).map(s => s.email));

const available = contacts.filter(c => !recentSent.has(c.email) && c.email.includes('@'));

// Pick 50, prioritizing untried ones
const day = new Date().getDate();
const sorted = [...available].sort((a, b) => (a.sentCount || 0) - (b.sentCount || 0));
const count = parseInt(process.argv[2]) || 50;
const batch = sorted.slice(0, count);

if (batch.length === 0) {
  console.log('No fresh contacts available. Run seasonal-scraper first.');
  process.exit(0);
}

let sent = 0, errors = 0;
const logDir = path.join(__dirname, '..', 'relay-data');
const LOCK_FILE = path.join(logDir, 'campaign.lock');

// File-based lock to prevent concurrent campaign runs
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge < 3600000) {
        console.log('Campaign already running (age: ' + Math.round(lockAge/1000) + 's) — exiting');
        return false;
      }
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, String(Date.now()));
    return true;
  } catch { return false; }
}
function releaseLock() {
  try { if (existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
}

if (!acquireLock()) process.exit(0);
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(1); });
process.on('uncaughtException', () => { releaseLock(); process.exit(1); });

function appendSent(email) {
  sentHistory.push({ email, ts: Date.now() });
  fs.writeFileSync(SENT_FILE, JSON.stringify(sentHistory, null, 2));
}

function sendNext() {
  if (batch.length === 0 || sent + errors >= count) {
    const summary = `[${new Date().toISOString()}] Campaign: ${sent} sent, ${errors} errors`;
    console.log(summary);
    fs.appendFileSync(LOG_FILE, summary + '\n');
    releaseLock();
    return;
  }
  const entry = batch.shift();
  
  // Double-check this email hasn't been sent already (defense in depth)
  const recentSentCheck = new Set(sentHistory.filter(s => s.ts > Date.now() - 30*24*60*60*1000).map(s => s.email));
  if (recentSentCheck.has(entry.email)) {
    // Already sent in this session — skip
    sent++;
    setTimeout(sendNext, 10);
    return;
  }
  // Build dynamic email body with Stripe booking links
  const stripeGeneral = 'https://buy.stripe.com/8x25kD7ezg6h4iC15YbZe03';
  const stripe3hr = 'https://buy.stripe.com/9B63cv9mH07j3eyeWObZe06';
  const stripe4hr = 'https://buy.stripe.com/eVqcN556r4nz16qeWObZe04';
  
  // Choose template based on contact topic
  const topic = (entry.topic || '').toLowerCase();
  const isCorporate = topic.includes('conference') || topic.includes('corporate') || topic.includes('trade') || topic.includes('convention');
  
  const body = isCorporate ? `Hi there,

I'm Joe, the owner of Party Favor Photo. We provide photo experiences for corporate conferences and trade shows across the DC and Dallas areas.

What makes us different: we can serve your event from both ends.

**Morning Session — Professional Corporate Headshots**
Set up in the conference hall or a breakout room. Attendees get polished, professional headshots they can use for LinkedIn, badges, and company directories. No more hunting people down for photos later.

**Evening Reception — Branded Photo Booth**
Custom branded templates, props, and instant sharing. The perfect way to cap off a conference day — keeps people networking, having fun, and creating shareable content that promotes your event.

Double the value from a single vendor booking.

Here's our corporate pricing:

  Half-Day (headshots or reception) — $747
  ${stripe3hr}

  Full Conference Day (headshots + reception) — $996
  ${stripe4hr}

We handle setup, breakdown, and all equipment. Your attendees get pro-quality results, your event gets documented, and you get one less thing to worry about.

Click a link above to book or reply for a custom quote.

Warmly,

Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com` : `Hi there,

I'm Joe, the owner of Party Favor Photo — we're an award-winning photo booth company serving the DC and Dallas areas. We specialize in high school graduation parties, ANGP events, and school celebrations.

Our StudioStation photo booth features a professional DSLR camera, studio strobe lighting, sequin backdrops, unlimited custom prints, and QR code sharing. We handle everything from setup to breakdown.

Here's what we offer:

  StudioStation 2hr — $498
  ${stripeGeneral}

  StudioStation 3hr — $747
  ${stripe3hr}

  StudioStation 4hr — $996
  ${stripe4hr}

Click a link above to book instantly! No commitment until deposit. Questions? Reply to this email or call/text.

Warmly,

Joe Lee
Party Favor Photo
(202) 798-0610
partyfavorphoto.com
5.0 on The Knot & WeddingWire`;
  
  const req = https.request(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (data.includes('"status":"sent"')) {
        sent++;
        appendSent(entry.email);
      } else {
        errors++;
      }
      process.stdout.write(sent + errors < count ? '.' : '.\n');
      setTimeout(sendNext, 120);
    });
  });
  req.on('error', () => { errors++; setTimeout(sendNext, 120); });
  const subject = isCorporate ? 'Conference photo experience — headshots + evening booth' : 'Hello from Party Favor Photo';
  req.write(JSON.stringify({ to: entry.email, subject, body }));
  req.end();
}

console.log(`Pool: ${contacts.length}, Available: ${available.length}, Target: ${count}, Sending: ${batch.length}`);
sendNext();
