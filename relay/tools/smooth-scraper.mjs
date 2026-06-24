#!/usr/bin/env node
/**
 * smooth-scraper.mjs — Slow is smooth, smooth is fast.
 * Uses Supabase explore-curiosity to find PTA/event contacts
 * for DC + Dallas areas. Runs until we have enough.
 * 
 * Usage: node smooth-scraper.mjs [--target=5000]
 */

import fs from 'fs';
import path from 'path';
import { fetchUrl, startpageSearch } from './search-provider.mjs';

const DATA_DIR = 'C:/Users/PureTrek/Desktop/DevGruGold/relay-data';
const CONTACTS_FILE = path.join(DATA_DIR, 'campaign-contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'campaign.log');

const TARGET = parseInt(process.argv.find(a => a.startsWith('--target='))?.split('=')[1]) || 5000;
const CONCURRENCY = 6; // 6 parallel explore queries

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(entry);
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
}

// Image extensions that are NOT valid TLDs — reject emails whose domain TLD is an image extension
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','tiff','tif','avif','heic','heif','raw','psd','eps','ico']);

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(regex) || [];
  return [...new Set(found.filter(e => {
    const parts = e.split('@');
    if (parts.length !== 2) return false;
    const tld = parts[1].split('.').pop().toLowerCase().replace(/[^a-z]/g, '');
    if (IMAGE_EXTENSIONS.has(tld)) return false;
    return e.includes('@') && !e.toLowerCase().includes('example') &&
      !['facebook','twitter','instagram','linkedin','youtube','tiktok','snapchat','whatsapp','telegram']
        .some(d => e.toLowerCase().includes(d)) &&
      !e.toLowerCase().includes('.gov') && !e.toLowerCase().includes('.mil') &&
      !e.toLowerCase().includes('noreply') && parts[1]?.includes('.');
  }))];
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { return []; }
}

function saveContacts(contacts) {
  const seen = new Set();
  const unique = contacts.filter(c => {
    const key = c.email.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(unique, null, 2));
  return unique;
}

const QUERIES = [
  // === DC AREA — SCHOOLS & PTA ===
  { q: 'Fairfax County Virginia high school PTSA president email 2026', r: 'Northern Virginia Washington DC' },
  { q: 'Loudoun County Virginia high school PTA PTSO officer email contact', r: 'Northern Virginia Washington DC' },
  { q: 'Prince William County Virginia school PTSA board email list', r: 'Northern Virginia Washington DC' },
  { q: 'Arlington Virginia public schools PTA president email directory', r: 'Northern Virginia Washington DC' },
  { q: 'Alexandria Virginia school PTA PTSO contact email', r: 'Northern Virginia Washington DC' },
  { q: 'Montgomery County Maryland high school PTSA president email', r: 'Northern Virginia Washington DC' },
  { q: 'Prince Georges County Maryland school PTA board email', r: 'Northern Virginia Washington DC' },
  { q: 'Washington DC public charter school PTA president email', r: 'Northern Virginia Washington DC' },
  { q: 'FCPS Fairfax County school ANGP all night grad party committee', r: 'Northern Virginia Washington DC' },
  { q: 'Virginia high school graduation party coordinator email', r: 'Northern Virginia Washington DC' },
  { q: 'Northern Virginia PTSA council regional director email', r: 'Northern Virginia Washington DC' },
  { q: 'Virginia PTA state board of managers email contacts', r: 'Northern Virginia Washington DC' },
  { q: 'NOVA school PTO parent teacher organization email president', r: 'Northern Virginia Washington DC' },
  { q: 'DC Maryland Virginia area school parent association email list', r: 'Northern Virginia Washington DC' },
  { q: 'Northern Virginia public high school activities director email', r: 'Northern Virginia Washington DC' },
  { q: 'Fairfax County FCPS school email directory staff contacts', r: 'Northern Virginia Washington DC' },
  { q: 'Loudoun County LCPS school directory email principals', r: 'Northern Virginia Washington DC' },
  { q: 'Virginia independent school PTA parent teacher fellowship email', r: 'Northern Virginia Washington DC' },
  { q: 'Washington DC area high school senior class parent email', r: 'Northern Virginia Washington DC' },
  { q: 'Northern Virginia private school PTO board member email', r: 'Northern Virginia Washington DC' },
  { q: 'FCPS school PTA student activities coordinator email', r: 'Northern Virginia Washington DC' },
  { q: 'Maryland school PTA president email directory by county', r: 'Northern Virginia Washington DC' },
  { q: 'Washington DC metro area event planner community coordinator email', r: 'Northern Virginia Washington DC' },
  { q: 'Northern Virginia wedding and event vendor directory email', r: 'Northern Virginia Washington DC' },
  { q: 'DC area school spring festival PTA organizer email', r: 'Northern Virginia Washington DC' },
  { q: 'Virginia high school prom graduation committee parent email', r: 'Northern Virginia Washington DC' },
  { q: 'Fairfax County Council PTA email directory member list', r: 'Northern Virginia Washington DC' },
  { q: 'NOVA community festival street fair organizer email', r: 'Northern Virginia Washington DC' },
  { q: 'Northern Virginia summer concert series event planner email', r: 'Northern Virginia Washington DC' },
  { q: 'DC Maryland Virginia school parent liaison email contacts', r: 'Northern Virginia Washington DC' },

  // === DALLAS-FORT WORTH — SCHOOLS & PTA ===
  { q: 'Dallas ISD Texas high school PTSA president email 2026', r: 'Dallas Fort Worth Texas' },
  { q: 'Frisco Texas ISD school PTA board president email contact', r: 'Dallas Fort Worth Texas' },
  { q: 'Plano Texas ISD high school PTA PTSO officer email', r: 'Dallas Fort Worth Texas' },
  { q: 'Allen Texas high school PTA president email', r: 'Dallas Fort Worth Texas' },
  { q: 'McKinney Texas ISD PTA council email director', r: 'Dallas Fort Worth Texas' },
  { q: 'Fort Worth Texas ISD school PTA president email', r: 'Dallas Fort Worth Texas' },
  { q: 'Arlington Texas ISD school PTA board email', r: 'Dallas Fort Worth Texas' },
  { q: 'Garland Texas ISD PTA president email contact', r: 'Dallas Fort Worth Texas' },
  { q: 'Richardson Texas ISD school PTA PTO email', r: 'Dallas Fort Worth Texas' },
  { q: 'Carrollton Texas school PTA president email', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas Fort Worth area school PTA council directory email', r: 'Dallas Fort Worth Texas' },
  { q: 'Texas PTA local unit president email directory list', r: 'Dallas Fort Worth Texas' },
  { q: 'Collin County Texas school PTA board member email', r: 'Dallas Fort Worth Texas' },
  { q: 'Denton Texas ISD school PTA president email', r: 'Dallas Fort Worth Texas' },
  { q: 'Lewisville Texas ISD PTA email contact', r: 'Dallas Fort Worth Texas' },
  { q: 'Mansfield Texas ISD school PTA board email', r: 'Dallas Fort Worth Texas' },
  { q: 'Keller Texas ISD PTA president email', r: 'Dallas Fort Worth Texas' },
  { q: 'Southlake Carroll Texas PTA email', r: 'Dallas Fort Worth Texas' },
  { q: 'Coppell Texas ISD PTA board email', r: 'Dallas Fort Worth Texas' },
  { q: 'Grapevine Texas school PTA president email', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas Fort Worth high school ANGP all night grad party committee', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas Texas high school senior graduation party parent email', r: 'Dallas Fort Worth Texas' },
  { q: 'DFW area school PTSA board director email list', r: 'Dallas Fort Worth Texas' },
  { q: 'Texas high school prom graduation event committee email', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas Fort Worth wedding venue coordinator event planner email', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas Texas corporate event planner vendor directory email', r: 'Dallas Fort Worth Texas' },
  { q: 'DFW community festival street fair organizer email', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas area summer concert series event coordinator email', r: 'Dallas Fort Worth Texas' },
  { q: 'Dallas Fort Worth area chamber of commerce event email', r: 'Dallas Fort Worth Texas' },
  { q: 'Texas Region 10 education service center PTA email', r: 'Dallas Fort Worth Texas' },
];

async function explore(query, region) {
  try {
    const urls = await startpageSearch(query);
    const contacts = [];
    const seen = new Set();

    for (const url of urls.slice(0, 8)) {
      try {
        const html = await fetchUrl(url);
        const emails = extractEmails(html);
        for (const email of emails) {
          const key = email.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            contacts.push({
              email: key,
              source: url,
              added: new Date().toISOString(),
              region,
              topics: query.slice(0, 40),
              status: 'pending',
            });
          }
        }
      } catch {
        // skip failed page
      }
    }
    return contacts;
  } catch {
    return [];
  }
}

async function main() {
  const start = Date.now();
  let existing = loadExisting();
  let allNew = [];
  let total = 0;

  log(`╔═══════════════════════════════════════════╗`);
  log(`║  🐢 Smooth Scraper — Target: ${TARGET}       ║`);
  log(`║  Pool: ${existing.length} | Queries: ${QUERIES.length}  ║`);
  log(`╚═══════════════════════════════════════════╝\n`);

  for (let i = 0; i < QUERIES.length; i += CONCURRENCY) {
    const batch = QUERIES.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(q => explore(q.q, q.r)));
    
    for (const contacts of results) {
      for (const c of contacts) {
        if (!allNew.some(x => x.email === c.email) && !existing.some(x => x.email.toLowerCase() === c.email)) {
          allNew.push(c);
        }
      }
    }

    total += results.reduce((s, r) => s + r.length, 0);
    
    for (let j = 0; j < batch.length; j++) {
      const count = results[j]?.length || 0;
      const q = batch[j].q.slice(0, 50);
      process.stdout.write(`${count > 0 ? '✓' : '·'} ${q.padEnd(52)} ${String(count).padStart(3)}\n`);
    }

    // Save progress
    if (allNew.length > 0) {
      const merged = [...existing, ...allNew];
      const saved = saveContacts(merged);
      log(`  💾 ${saved.length} total (${allNew.length} new this round)\n`);
    }
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  const merged = [...existing, ...allNew];
  const saved = saveContacts(merged);

  log(`╔═══════════════════════════════════════════╗`);
  log(`║  ✅ DONE in ${elapsed}s                     ║`);
  log(`║  Emails found: ${allNew.length}               ║`);
  log(`║  Final pool: ${saved.length}                  ║`);
  log(`╚═══════════════════════════════════════════╝\n`);
}

main().catch(e => {
  log(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});
