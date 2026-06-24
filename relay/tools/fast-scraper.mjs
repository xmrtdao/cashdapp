#!/usr/bin/env node
/**
 * Fast PFP Contact Scraper
 * Uses Supabase explore-curiosity function + direct DuckDuckGo HTML search
 * to find 5000+ PTA/event contacts for DC and Dallas areas.
 */

import fs from 'fs';
import path from 'path';
import { fetchUrl as sfetchUrl, startpageSearch } from './search-provider.mjs';

const DATA_DIR = 'C:/Users/PureTrek/Desktop/DevGruGold/relay-data';
const CONTACTS_FILE = path.join(DATA_DIR, 'campaign-contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'campaign.log');

const TARGET = 5000;

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
      !e.toLowerCase().includes('facebook') && !e.toLowerCase().includes('twitter') &&
      !e.toLowerCase().includes('instagram') && !e.toLowerCase().includes('linkedin') &&
      !e.toLowerCase().includes('.gov') && !e.toLowerCase().includes('.mil') &&
      !e.toLowerCase().includes('noreply') && !e.toLowerCase().includes('donotreply') &&
      parts[1]?.includes('.');
  }))];
}

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { return []; }
}

function saveContacts(contacts) {
  const unique = [];
  const seen = new Set();
  for (const c of contacts) {
    const key = c.email.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(unique, null, 2));
  return unique;
}

// ── DuckDuckGo HTML Search (no API key needed) ─────────
async function duckSearch(query) {
  try {
    const html = await sfetchUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    // Extract result URLs from DDG HTML
    const links = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g;
    let m;
    while ((m = linkRegex.exec(html)) !== null) {
      const href = m[1];
      if (href.startsWith('http') && !href.includes('duckduckgo.com')) links.push(href);
    }
    
    // Also extract emails directly from the page
    const emails = extractEmails(html);
    
    return { links: links.slice(0, 8), emails };
  } catch { return { links: [], emails: [] }; }
}

// ── Startpage search + scrape replacement for explore-curiosity ──
async function exploreTopic(seedTopic) {
  try {
    const urls = await startpageSearch(seedTopic);
    const allEmails = [];
    const seen = new Set();
    for (const url of urls.slice(0, 8)) {
      try {
        const html = await sfetchUrl(url);
        const emails = extractEmails(html);
        for (const email of emails) {
          const key = email.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            allEmails.push(email);
          }
        }
      } catch {
        // skip
      }
    }
    return { insights: allEmails.map(e => ({ title: '', highlights: [], url: '', summary: '' })), emails: allEmails };
  } catch { return { insights: [], emails: [] }; }
}

// ── Scrape and extract emails from page ────────────────
async function scrapePage(url) {
  try {
    const html = await sfetchUrl(url);
    return extractEmails(html);
  } catch { return []; }
}

// ── Main ───────────────────────────────────────────────
async function main() {
  const start = Date.now();
  const existing = loadExisting();
  let allNew = [];
  let errors = 0;
  
  log(`╔══════════════════════════════════════════╗`);
  log(`║  ⚡ Fast Scraper — Target: ${TARGET}      ║`);
  log(`║  Pool: ${existing.length} existing        ║`);
  log(`╚══════════════════════════════════════════╝\n`);

  // Phase 1: DuckDuckGo searches for PTA/event directories
  log(`📋 Phase 1: Searching for PTA & event directories...\n`);
  
  const searchQueries = [
    // DC Area
    `"fairfax county" "PTA" OR "PTSA" "president" email`,
    `"loudoun county" Virginia "PTA" "president" email OR contact`,
    `"Washington DC" "PTA" OR "PTSA" "president" email`,
    `"Montgomery County" Maryland "PTA" president email contact`,
    `"Prince William County" "PTA" president email`,
    `Northern Virginia "school" "contact" email list directory`,
    `"DC" "public schools" "email" "principal" OR "president" list`,
    `"ANGP" OR "all night grad party" Virginia email contact`,
    `Northern Virginia "festival" OR "event" "coordinator" email`,
    `"Washington DC" "wedding" "venue" "email" OR "contact"`,
    `Virginia high school "graduation" "committee" email`,
    `NOVA "PTA" OR "PTO" email list school`,
    `"Fairfax" "FCPS" "email" "school" directory`,
    `Maryland "PTA" "president" email "high school"`,
    
    // Dallas Area
    `"Dallas ISD" "PTA" OR "PTSA" "president" email`,
    `"Frisco" Texas "PTA" "president" email school`,
    `"Plano" Texas "PTA" "president" email contact`,
    `"Allen" Texas "PTA" "president" email high school`,
    `"McKinney" Texas "PTA" "president" email`,
    `"Fort Worth" Texas "PTA" OR "PTSA" email`,
    `Dallas "school" "email" "principal" OR "president" list`,
    `DFW "wedding" "venue" "email" OR "contact" list`,
    `"Dallas" "festival" OR "event" "coordinator" email`,
    `Texas "ANGP" OR "all night grad party" email contact`,
    `"Dallas" "high school" "graduation" "committee" email`,
    `"Richardson" OR "Garland" Texas "PTA" email`,
    `"Arlington" Texas "PTA" president email`,
    `Collin County Texas "PTA" president email`,
  ];

  for (const q of searchQueries) {
    const result = await duckSearch(q);
    let count = 0;
    
    // Add emails found directly in search results
    for (const email of result.emails) {
      if (!allNew.some(c => c.email === email.toLowerCase())) {
        allNew.push({ email: email.toLowerCase(), source: `search: ${q.slice(0,60)}`, added: new Date().toISOString(), region: 'mixed', topics: 'search', status: 'pending' });
        count++;
      }
    }
    
    // Scrape the result pages
    for (const link of result.links) {
      const emails = await scrapePage(link);
      for (const email of emails) {
        if (!allNew.some(c => c.email === email.toLowerCase())) {
          const region = q.toLowerCase().includes('dallas') || q.toLowerCase().includes('texas') || q.toLowerCase().includes('dfw') ? 
            'Dallas Fort Worth Texas' : 'Northern Virginia Washington DC';
          allNew.push({ email: email.toLowerCase(), source: link, added: new Date().toISOString(), region, topics: 'directory', status: 'pending' });
          count++;
        }
      }
    }
    
    if (count > 0) {
      log(`  ✓ ${q.slice(0,55)} → ${count} emails`);
    } else {
      log(`  · ${q.slice(0,55)} → 0`);
    }
    
    // Save every 200
    if (allNew.length > 0 && allNew.length % 200 < 20) {
      const merged = [...existing, ...allNew];
      saveContacts(merged);
      log(`  💾 Checkpoint: ${allNew.length} new, ${merged.length} total`);
    }
  }

  // Phase 2: Startpage search + scrape discovery (targeted)
  log(`\n🔍 Phase 2: Startpage-powered discovery...\n`);
  
  const topics = [
    'Fairfax County Virginia high school PTSA ANGP committee contacts',
    'Northern Virginia Washington DC area school PTA presidents email list',
    'Dallas Fort Worth Texas high school PTSA all night grad party organizers',
    'Texas PTA local unit presidents email directory contact list',
    'Washington DC corporate event planners and wedding coordinators email',
    'Dallas Texas wedding venues and event planners contact directory',
    'FCPS school parent teacher association email contacts directory',
    'Virginia PTA council local unit presidents email list 2026',
  ];

  for (const topic of topics) {
    try {
      const data = await exploreTopic(topic);
      const emails = data.emails || [];
      let count = 0;

      for (const email of emails) {
        if (!allNew.some(c => c.email === email.toLowerCase())) {
          const region = topic.toLowerCase().includes('dallas') || topic.toLowerCase().includes('texas') ?
            'Dallas Fort Worth Texas' : 'Northern Virginia Washington DC';
          allNew.push({ email: email.toLowerCase(), source: topic, added: new Date().toISOString(), region, topics: 'startpage-discovered', status: 'pending' });
          count++;
        }
      }

      log(`  ${count > 0 ? '✓' : '·'} "${topic.slice(0,55)}" → ${count} emails`);
    } catch {
      errors++;
    }

    // Progressive save
    if (allNew.length > 0) {
      const merged = [...existing, ...allNew];
      saveContacts(merged);
      log(`  💾 ${allNew.length} new contacts saved`);
    }
  }

  // Final save
  const merged = [...existing, ...allNew];
  const saved = saveContacts(merged);
  const elapsed = Math.round((Date.now() - start) / 1000);
  
  log(`\n╔══════════════════════════════════════════╗`);
  log(`║  ✅ DONE in ${elapsed}s                    ║`);
  log(`║  Found: ${allNew.length} new               ║`);
  log(`║  Pool: ${saved.length} total               ║`);
  log(`║  Errors: ${errors}                         ║`);
  log(`╚══════════════════════════════════════════╝`);
}

main().catch(e => {
  log(`\n❌ Fatal: ${e.message}`);
  process.exit(1);
});
