#!/usr/bin/env node
/**
 * Seasonal Campaign Intelligence Engine
 * 
 * Runs nightly at 11 PM. Determines what's 4 months ahead on the event calendar,
 * finds new contacts for those events, and feeds them into the daily campaign pool.
 * 
 * Annual Event Calendar (reference):
 * Jan-Feb:   Late holiday parties, winter balls, Super Bowl, Valentine's Day, Father-Daughter dances
 * Mar-Apr:   Spring break, homecoming, prom, spring weddings
 * May-Jun:   Graduation season, ANGP events, spring weddings (peak)
 * Jun-Aug:   Pool parties, cultural street fairs, summer festivals, Pride, 4th of July
 * Aug-Sep:   Back to school, American football season, fall weddings begin
 * Oct:       Halloween parties, fall festivals, Oktoberfest
 * Nov-Dec:   Corporate holiday parties, Thanksgiving, NYE parties
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startpageSearch, fetchUrl } from './search-provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'relay-data');
const CONTACTS_FILE = path.join(DATA_DIR, 'campaign-contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'campaign.log');
const EVENTS_FILE = path.join(DATA_DIR, 'seasonal-events.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── ANNUAL EVENT CALENDAR ─────────────────────────────────
const SEASONS = [
  // We search 4 months ahead from today, so this covers the full year
  { months: [1, 2],   events: ['Holiday Party', 'Winter Gala', 'Super Bowl Party', 'Valentine Day Dance', 'Father Daughter Dance', 'Mardi Gras', 'Winter Convention', 'Corporate Conference', 'Winter Wedding'], keywords: ['super bowl', 'valentine', 'father daughter', 'winter gala', 'holiday party', 'mardi gras', 'conference', 'convention', 'corporate event'] },
  { months: [3, 4],   events: ['Spring Break', 'Homecoming Dance', 'Prom', 'Spring Wedding', 'Easter', 'Spring Festival', 'Conference', 'Trade Show'], keywords: ['prom', 'homecoming', 'spring wedding', 'easter', 'spring festival', 'conference', 'trade show', 'bridal'] },
  { months: [5, 6],   events: ['Graduation Party', 'ANGP', 'All Night Grad Party', 'Spring Wedding', 'Memorial Day', 'Graduation', 'Pride Festival', 'Juneteenth'], keywords: ['graduation', 'all night grad', 'angp', 'senior party', 'wedding', 'memorial day', 'pride festival', 'juneteenth'] },
  { months: [7, 8],   events: ['Fourth of July', 'Pool Party', 'Summer Festival', 'Street Fair', 'Cultural Festival', 'Back to School', 'Summer Concert', 'Outdoor Movie'], keywords: ['street festival', 'cultural festival', 'pool party', 'july 4th', 'summer fest', 'back to school', 'block party', 'food festival', 'art festival'] },
  { months: [9, 10],  events: ['Back to School', 'Football Season', 'Fall Festival', 'Oktoberfest', 'Fall Wedding', 'Halloween Party', 'Harvest Festival'], keywords: ['fall festival', 'oktoberfest', 'halloween', 'fall wedding', 'football', 'tailgate', 'harvest festival', 'homecoming'] },
  { months: [11, 12], events: ['Thanksgiving', 'Corporate Holiday Party', 'Christmas Party', 'New Year Eve', 'Holiday Gala', 'Winter Festival', 'NYE Party'], keywords: ['holiday party', 'christmas party', 'new year', 'thanksgiving', 'corporate holiday', 'winter festival', 'nye', 'gala'] },
];

function getEventsForMonth(month) {
  return SEASONS.find(s => s.months.includes(month)) || SEASONS[0];
}

function getTargetMonth(daysAhead = 1) {
  // Look 4 months ahead for planning
  const target = new Date();
  target.setMonth(target.getMonth() + 4);
  return target.getMonth() + 1; // 1-indexed
}

function getCurrentSeasonTag() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const season = SEASONS.find(s => s.months.includes(m)) || SEASONS[0];
  return season.events[0];
}

// ── CONTACT POOL MANAGEMENT ──────────────────────────────
function loadContacts() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } 
  catch { return []; }
}

function saveContacts(contacts) {
  // Deduplicate by email
  const unique = [];
  const seen = new Set();
  for (const c of contacts) {
    if (!seen.has(c.email)) {
      seen.add(c.email);
      unique.push(c);
    }
  }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(unique, null, 2));
  return unique;
}

// ── RUN TRACKING (prevents scraping same topics every night) ──
function loadRunHistory() {
  const f = path.join(DATA_DIR, 'scraper-runs.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { runs: [], searchedQueries: [], contactedEmails: [] }; }
}

function saveRunHistory(h) {
  const f = path.join(DATA_DIR, 'scraper-runs.json');
  // Keep only last 500 queries to prevent unbounded growth
  if (h.searchedQueries.length > 500) h.searchedQueries = h.searchedQueries.slice(-500);
  fs.writeFileSync(f, JSON.stringify(h, null, 2));
}

function getEventCoverage(contacts) {
  // Count contacts per topic category
  const coverage = {};
  for (const c of contacts) {
    const topic = c.topic || 'unknown';
    coverage[topic] = (coverage[topic] || 0) + 1;
  }
  return coverage;
}

function findUnderservedEvents(targetSeason, currentSeason, coverage) {
  // Find events that have < 10 contacts — those are underserved
  const underserved = [];
  for (const events of [currentSeason.events, targetSeason.events]) {
    for (const e of events) {
      const count = 0;
      // Check if any topic in coverage relates to this event
      let found = false;
      for (const [topic, cnt] of Object.entries(coverage)) {
        if (topic.toLowerCase().includes(e.toLowerCase().slice(0, 6))) {
          found = true;
          if (cnt < 10) underserved.push(e);
          break;
        }
      }
      if (!found) underserved.push(e);
    }
  }
  return [...new Set(underserved)].slice(0, 6);
}

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(entry.trim());
  fs.appendFileSync(LOG_FILE, entry);
}

// ── WEB SCRAPING ─────────────────────────────────────────

function extractEmails(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex) || [];
  // Filter out common non-contact emails
  return emails.filter(e => 
    !e.includes('example.com') && 
    !e.includes('facebook.com') && 
    !e.includes('twitter.com') &&
    !e.includes('youtube.com') &&
    !e.includes('instagram.com') &&
    !e.includes('.gov') &&
    !e.includes('.mil')
  );
}

function extractNames(text) {
  // Look for patterns like "President: Name" or "President Name"
  const patterns = [
    /president[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    /chair[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    /director[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    /coordinator[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
  ];
  const names = [];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      names.push(m[1]);
    }
  }
  return [...new Set(names)];
}

async function scrapeRegion(region, query) {
  log(`Scraping ${region}: ${query}`);
  const contacts = [];

  try {
    const urls = await startpageSearch(query);
    const pageUrls = urls.slice(0, 6);

    for (const url of pageUrls) {
      try {
        const html = await fetchUrl(url);
        const emails = extractEmails(html);
        for (const email of emails) {
          contacts.push({
            email,
            source: url,
            query,
            added: new Date().toISOString(),
            region,
            topics: query,
            status: 'pending',
          });
        }
      } catch {
        // skip failed URL
      }
    }
  } catch {
    // skip failed search
  }

  return contacts;
}

async function findContactsForEvent(eventType, keywords, region) {
  const queries = [];
  
  if (eventType.includes('Graduation') || eventType.includes('ANGP') || eventType.includes('grad')) {
    queries.push(`${region} high school PTSA president email all night grad party 2026`);
    queries.push(`${region} high school graduation party committee email`);
    queries.push(`${region} PTSA ANGP chair email`);
  }
  if (eventType.includes('Festival') || eventType.includes('Street') || eventType.includes('Cultural')) {
    queries.push(`${region} summer street festival organizer email ${new Date().getFullYear()}`);
    queries.push(`${region} cultural festival vendor coordinator email`);
    queries.push(`${region} community event coordinator email`);
  }
  if (eventType.includes('Wedding')) {
    queries.push(`${region} wedding venue coordinator email`);
    queries.push(`${region} bridal show vendor application`);
  }
  if (eventType.includes('Corporate') || eventType.includes('Conference')) {
    queries.push(`${region} corporate event planner email`);
    queries.push(`${region} conference trade show vendor`);
  }
  if (eventType.includes('Holiday') || eventType.includes('Christmas') || eventType.includes('NYE')) {
    queries.push(`${region} holiday party venue coordinator`);
    queries.push(`${region} new year eve event organizer`);
  }
  if (eventType.includes('Halloween')) {
    queries.push(`${region} halloween event organizer`);
    queries.push(`${region} fall festival coordinator`);
  }
  if (eventType.includes('Football') || eventType.includes('Tailgate')) {
    queries.push(`${region} football tailgate party organizer`);
    queries.push(`${region} sports bar event coordinator`);
  }
  if (eventType.includes('Back to School')) {
    queries.push(`${region} back to school event coordinator`);
    queries.push(`${region} PTA back to school party`);
  }
  if (eventType.includes('Father') || eventType.includes('Valentine')) {
    queries.push(`${region} father daughter dance school PTA`);
    queries.push(`${region} valentine day dance organizer`);
  }
  if (eventType.includes('Pool') || eventType.includes('Summer')) {
    queries.push(`${region} pool party event planner`);
    queries.push(`${region} summer concert series coordinator`);
  }
  if (eventType.includes('Super Bowl')) {
    queries.push(`${region} super bowl party event venue`);
  }
  if (eventType.includes('Pride')) {
    queries.push(`${region} pride festival vendor application`);
  }
  
  // Generic fallback
  queries.push(`${region} event planner contact email`);
  queries.push(`${region} festival organizer email`);

  const allContacts = [];
  for (const q of queries) {
    const found = await scrapeRegion(region, q);
    allContacts.push(...found);
    // Small delay between queries
    await new Promise(r => setTimeout(r, 1000));
  }
  return allContacts;
}

// ── MAIN ─────────────────────────────────────────────────
async function run() {
  const targetMonth = getTargetMonth();
  const targetSeason = getEventsForMonth(targetMonth);
  const currentSeason = getEventsForMonth(new Date().getMonth() + 1);
  const currentTag = getCurrentSeasonTag();
  const runHistory = loadRunHistory();
  const todayStr = new Date().toISOString().slice(0, 10);

  log(`=== Seasonal Campaign Intelligence ===`);
  log(`Current: ${currentSeason.events[0]} | Planning 4mo ahead: ${targetSeason.events[0]}`);
  log(`Target month: ${targetMonth} (${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][targetMonth-1]})`);
  log(`Previous runs: ${runHistory.runs.length} | Queries searched: ${runHistory.searchedQueries.length}`);

  let existing = loadContacts();
  const coverage = getEventCoverage(existing);
  log(`Existing pool: ${existing.length} contacts`);
  log(`Coverage: ${Object.entries(coverage).map(([k,v]) => `${k}:${v}`).join(', ')}`);

  // Find events that need more contacts
  const underserved = findUnderservedEvents(targetSeason, currentSeason, coverage);
  log(`Underserved events to target: ${underserved.join(', ') || 'none (rotating through all)'}`);
  
  // Pick which events to scrape tonight — prioritize underserved, rotate through the rest
  const eventsToScrape = underserved.length > 0 
    ? underserved 
    : [...currentSeason.events, ...targetSeason.events].sort(() => Math.random() - 0.5).slice(0, 6);

  const newContacts = [];
  const regions = [
    'Northern Virginia Washington DC',
    'Dallas Fort Worth Texas',
  ];
  
  // Pick region rotation based on day of month
  const region = regions[new Date().getDate() % regions.length];
  log(`Focus region tonight: ${region}`);

  for (const event of eventsToScrape) {
    // Generate dynamic date-aware queries
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const currentMonthName = monthNames[new Date().getMonth()];
    const targetMonthName = monthNames[targetMonth - 1];
    const year = new Date().getFullYear();
    const nextYear = year + 1;
    
    const queries = [
      `${region} ${event} organizer email ${year}`,
      `${region} ${event} coordinator contact`,
      `${region} ${event} ${currentMonthName} ${year}`,
      `${region} ${event} ${targetMonthName} ${nextYear}`,
      `${region} ${event} vendor application`,
      `${region} PTA PTSO ${event} chair`,
    ];
    
    // Filter out already-searched queries
    const freshQueries = queries.filter(q => !runHistory.searchedQueries.includes(q));
    const queriesToRun = freshQueries.length > 0 ? freshQueries : queries;
    
    for (const q of queriesToRun.slice(0, 3)) {  // Max 3 per event per night
      const found = await scrapeRegion(region, q);
      
      // Tag each contact with which event topic they relate to
      for (const c of found) {
        c.topic = event;
        c.query = q;
      }
      
      newContacts.push(...found);
      runHistory.searchedQueries.push(q);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  log(`Found ${newContacts.length} new potential contacts`);

  // Merge with existing pool
  const merged = [...existing, ...newContacts];
  const saved = saveContacts(merged);
  
  // Record this run
  runHistory.runs.push({
    date: todayStr,
    eventsScraped: eventsToScrape,
    region,
    newContacts: newContacts.length,
    poolSize: saved.length,
  });
  saveRunHistory(runHistory);
  
  log(`Pool now: ${saved.length} contacts (${newContacts.length} new)`);
  log(`Next daily send will pick 50 fresh contacts from pool.`);
  
  // Save event calendar state
  fs.writeFileSync(EVENTS_FILE, JSON.stringify({
    lastRun: new Date().toISOString(),
    currentSeason: currentSeason.events[0],
    planningAhead: targetSeason.events[0],
    targetMonth,
    poolSize: saved.length,
    runsToday: runHistory.runs.filter(r => r.date === todayStr).length,
  }, null, 2));
}

run().catch(e => log(`Error: ${e.message}`));
