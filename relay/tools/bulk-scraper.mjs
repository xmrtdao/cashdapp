#!/usr/bin/env node
/**
 * Bulk Campaign Scraper — Party Favor Photo
 * Targets DC area + Dallas-Fort Worth school/district directories for
 * PTSA contacts, event planners, and school staff emails.
 * 
 * Usage: node bulk-scraper.mjs [--target=5000]
 * 
 * Strategy: Parallel fetch of multiple high-yield directory pages,
 * extract all emails, dedup, save progressively.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = path.resolve(__dirname, '..', '..', 'relay-data');
const CONTACTS_FILE = path.join(DATA_DIR, 'campaign-contacts.json');
const LOG_FILE = path.join(DATA_DIR, 'campaign.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── CONFIG ────────────────────────────────────────────────
const TARGET = parseInt(process.argv.find(a => a.startsWith('--target='))?.split('=')[1]) || 5000;
const CONCURRENCY = 15;
const TIMEOUT_MS = 30000;

let totalFound = 0;
let totalErrors = 0;

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(entry);
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
}

// ── EMAIL EXTRACTION ─────────────────────────────────────
// Image extensions that are NOT valid TLDs — reject emails whose domain TLD is an image extension
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','tiff','tif','avif','heic','heif','raw','psd','eps','ico']);

function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(regex) || [];
  return [...new Set(emails.filter(e => {
    const parts = e.split('@');
    if (parts.length !== 2) return false;
    const tld = parts[1].split('.').pop().toLowerCase().replace(/[^a-z]/g, '');
    if (IMAGE_EXTENSIONS.has(tld)) return false;
    return e.includes('@') &&
      !e.includes('example.com') &&
      !e.includes('facebook.com') &&
      !e.includes('twitter.com') &&
      !e.includes('youtube.com') &&
      !e.includes('instagram.com') &&
      !e.includes('linkedin.com') &&
      !e.includes('tiktok.com') &&
      !e.includes('snapchat.com') &&
      !e.includes('.gov') &&
      !e.includes('.mil') &&
      !e.includes('noreply') &&
      !e.includes('donotreply') &&
      !e.includes('no-reply') &&
      parts[1]?.includes('.');
  }))];
}

// ── HTTP FETCH ───────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── CONTACT POOL MANAGEMENT ──────────────────────────────
function loadExisting() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } 
  catch { return []; }
}

function saveContacts(contacts) {
  const unique = [];
  const seen = new Set();
  for (const c of contacts) {
    const key = c.email.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(unique, null, 2));
  return unique;
}

// ── BULK DATA SOURCES ────────────────────────────────────
const DIRECTORIES = [
  // ── DC AREA: Fairfax County (largest in VA, 240+ schools) ─
  { url: 'https://www.fcps.edu/sites/default/files/media/pdf/contacts_7.pdf', region: 'Northern Virginia Washington DC', type: 'school-admin' },
  { url: 'https://www.fcps.edu/resources/student-safety-and-wellness/school-psychologists', region: 'Northern Virginia Washington DC', type: 'school-staff' },

  // ── DC AREA: Loudoun County ─
  { url: 'https://www.lcps.org/domain/23216', region: 'Northern Virginia Washington DC', type: 'school-admin' },  // LCPS school directory
  
  // ── DC AREA: Prince William County ─
  { url: 'https://www.pwcs.edu/about/school_directory', region: 'Northern Virginia Washington DC', type: 'school-admin' },

  // ── DC AREA: Arlington Public Schools ─
  { url: 'https://www.apsva.us/schools/', region: 'Northern Virginia Washington DC', type: 'school-admin' },

  // ── DC AREA: Alexandria City ─
  { url: 'https://www.acps.k12.va.us/schools', region: 'Northern Virginia Washington DC', type: 'school-admin' },

  // ── DC AREA: Montgomery County MD ─
  { url: 'https://www.montgomeryschoolsmd.org/schools/', region: 'Northern Virginia Washington DC', type: 'school-admin' },

  // ── DC AREA: DC Public Schools ─
  { url: 'https://dcps.dc.gov/page/schools', region: 'Northern Virginia Washington DC', type: 'school-admin' },

  // ── DALLAS-FORT WORTH: Dallas ISD ─
  { url: 'https://www.dallasisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Frisco ISD ─
  { url: 'https://www.friscoisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Plano ISD ─
  { url: 'https://www.pisd.edu/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Allen ISD ─
  { url: 'https://www.allenisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: McKinney ISD ─
  { url: 'https://www.mckinneyisd.net/schools/', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Richardson ISD ─
  { url: 'https://www.risd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Arlington ISD (TX) ─
  { url: 'https://www.aisd.net/schools/', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Garland ISD ─
  { url: 'https://www.garlandisd.net/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Carrollton-Farmers Branch ─
  { url: 'https://www.cfbisd.edu/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Lewisville ISD ─
  { url: 'https://www.lisd.net/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Mansfield ISD ─
  { url: 'https://www.mansfieldisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Keller ISD ─
  { url: 'https://www.kellerisd.net/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Grapevine-Colleyville ISD ─
  { url: 'https://www.gcisd.net/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Northwest ISD ─
  { url: 'https://www.nisdtx.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Denton ISD ─
  { url: 'https://www.dentonisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Mesquite ISD ─
  { url: 'https://www.mesquiteisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Grand Prairie ISD ─
  { url: 'https://www.gpisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Cedar Hill ISD ─
  { url: 'https://www.chisd.com/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: DeSoto ISD ─
  { url: 'https://www.desotoisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Duncanville ISD ─
  { url: 'https://www.duncanvilleisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Highland Park ISD ─
  { url: 'https://www.hpisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Coppell ISD ─
  { url: 'https://www.coppellisd.com/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Southlake Carroll ISD ─
  { url: 'https://www.southlakecarroll.edu/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Forney ISD ─
  { url: 'https://www.forneyisd.net/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DFW: Red Oak ISD ─
  { url: 'https://www.redoakisd.org/schools', region: 'Dallas Fort Worth Texas', type: 'school-admin' },

  // ── DC AREA: Maryland school districts near DC ─
  { url: 'https://www.pgcps.org/schools/', region: 'Northern Virginia Washington DC', type: 'school-admin' },  // Prince George's County
  { url: 'https://www.hcpss.org/schools/', region: 'Northern Virginia Washington DC', type: 'school-admin' },  // Howard County

  // ── Texas PTA - local rosters ─
  { url: 'https://www.txpta.org/local-pta-leaders', region: 'Dallas Fort Worth Texas', type: 'pta' },
];

// ── Generate FCPS individual school staff directory URLs ──
function generateFCPSDirectories() {
  // FCPS schools list from the PDF
  const fcpsschools = [
    'aldrin', 'annandale', 'annandaleterrace', 'armstrong', 'baileys', 'baileysupper',
    'beechtree', 'belleview', 'belvedere', 'bonniebrae', 'braddock', 'brenmarpark',
    'brookfield', 'bucknell', 'bullrun', 'burke', 'bushhill', 'camelot', 'cameron',
    'canterburywoods', 'cardinalforest', 'carson', 'cedarlane', 'centreridge',
    'centreville', 'chantilly', 'cherryrun', 'chesterbrook', 'churchillroad',
    'clearview', 'clermont', 'clifton', 'coates', 'columbia', 'colvinrun',
    'cooper', 'crestwood', 'crossfield', 'cubrun', 'cunninghampark', 'danielsrun',
    'deerpark', 'dogwood', 'dranesville', 'eagleview', 'edison', 'fairfax',
    'fairfaxvilla', 'fairhill', 'fairview', 'fallschurch', 'flinthill', 'floris',
    'forestedge', 'forestdale', 'forestville', 'fortbelvoir', 'forthunt', 'foxmill',
    'franconia', 'franklin', 'franklin', 'freedomhill', 'frost', 'garfield',
    'glasgow', 'glenforest', 'grahamroad', 'greatfalls', 'greenbriareast',
    'greenbriarwest', 'groveton', 'gunston', 'halley', 'haycock', 'hayfield',
    'herndon', 'hollinmeadows', 'holmes', 'hughes', 'huntvalley', 'hunterswoods',
    'hutchison', 'hyblavalley', 'irving', 'islandcreek', 'jackson', 'justice',
    'keenemill', 'kentgardens', 'key', 'kilmer', 'kingsglen', 'kingspark',
    'lakeanne', 'lakebraddock', 'lane', 'langley', 'lanier', 'laurelhill',
    'laurelridge', 'lee', 'leescorner', 'lemonroad', 'liberty', 'littlerun',
    'londontowne', 'longfellow', 'lortonstation', 'louisearcher', 'lynbrook',
    'madison', 'mantua', 'marshall', 'marshallroad', 'masoncrest', 'mclean',
    'mcnair', 'mosbywoods', 'mountainview', 'mteagle', 'mtvernon', 'mtvernonwoods',
    'navy', 'newingtonforest', 'northspringfield', 'oakhill', 'oakview', 'oakton',
    'oldecreek', 'orangehunt', 'parklawn', 'pimmithills', 'pinespring', 'poe',
    'poplartree', 'powell', 'providence', 'ravensworth', 'riverside', 'robinson',
    'rockyrun', 'rollingvalley', 'rosehill', 'sandburg', 'sangster', 'saratoga',
    'shrevewood', 'silverbrook', 'sleepyhollow', 'southcounty', 'southlakes',
    'springhill', 'springfieldestates', 'stenwood', 'stone', 'stratfordlanding',
    'sunrisevalley', 'teracentre', 'terraset', 'thoreau', 'timberlane', 'twain',
    'unionmill', 'vienna', 'virginiarun', 'wakefieldforest', 'waplesmill',
    'washingtonmill', 'waynewood', 'westpotomac', 'westspringfield', 'westbriar',
    'westfield', 'westgate', 'westlawn', 'weyanoke', 'whiteoaks', 'whitman',
    'willowsprings', 'wolftrap', 'woodburn', 'woodlawn', 'woodleyhills', 'woodson',
  ];

  return fcpsschools.map(s => ({
    url: `https://greatfallses.fcps.edu/staff-directory`,
    region: 'Northern Virginia Washington DC',
    type: 'school-staff',
    note: `FCPS staff directory (aggregate)`
  }));
}

// ── Scrape a single source ───────────────────────────────
async function scrapeSource(source) {
  try {
    const html = await fetchUrl(source.url);
    const emails = extractEmails(html);
    
    // For PDFs, try different extraction
    if (source.url.endsWith('.pdf')) {
      // PDFs might come as raw text if server sends as text
      // The FCPS PDF was returned as text with emails embedded
    }

    const contacts = emails.map(email => ({
      email: email.toLowerCase().trim(),
      source: source.url,
      added: new Date().toISOString(),
      region: source.region,
      topics: source.type,
      status: 'pending',
    }));

    if (contacts.length > 0) {
      log(`  ✓ ${source.url.split('/').pop().slice(0,40)} → ${contacts.length} emails [${source.region}]`);
    }

    return contacts;
  } catch (err) {
    totalErrors++;
    if (source.url.includes('fcps') || source.url.includes('dallasisd') || source.url.includes('txpta')) {
      log(`  ✗ ${source.url.split('/').pop().slice(0,40)} → ${err.message.slice(0,60)}`);
    }
    return [];
  }
}

// ── FCPS Individual School Pages ─────────────────────────
async function scrapeFCPSByLetter(letter) {
  // FCPS staff directories are per-school, per-letter
  // We'll use the main directory search to get bulk
  const url = `https://www.fcps.edu/schools-centers`;
  try {
    const html = await fetchUrl(url);
    const emails = extractEmails(html);
    return emails.map(email => ({
      email: email.toLowerCase().trim(),
      source: url,
      added: new Date().toISOString(),
      region: 'Northern Virginia Washington DC',
      topics: 'school-admin',
      status: 'pending',
    }));
  } catch {
    return [];
  }
}

// ── Parallel Fetch with Concurrency ──────────────────────
async function parallelFetch(sources, concurrency = CONCURRENCY) {
  const results = [];
  const chunks = [];
  
  for (let i = 0; i < sources.length; i += concurrency) {
    chunks.push(sources.slice(i, i + concurrency));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const batch = await Promise.all(chunk.map(s => scrapeSource(s)));
    for (const contacts of batch) {
      results.push(...contacts);
    }
    
    // Progress every chunk
    totalFound = results.length;
    const pct = Math.min(100, Math.round((totalFound / TARGET) * 100));
    const progressBar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
    process.stdout.write(`\r  Progress: [${progressBar}] ${totalFound}/${TARGET} (${pct}%) errors:${totalErrors}`);
    
    // Save progressively every chunk
    if (results.length > 0 && i % 3 === 0) {
      const existing = loadExisting();
      const merged = [...existing, ...results];
      const saved = saveContacts(merged);
      // Don't rewrite every time, just report
      if (saved.length > existing.length) {
        log(`\n  💾 Saved ${saved.length - existing.length} new contacts (total pool: ${saved.length})`);
      }
    }
  }

  return results;
}

// ── Additional targeted web searches ─────────────────────
async function searchAndScrape(queries, region) {
  const results = [];
  for (const q of queries) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      const html = await fetchUrl(url);
      const emails = extractEmails(html);
      for (const email of emails) {
        results.push({
          email: email.toLowerCase().trim(),
          source: `search: ${q}`,
          added: new Date().toISOString(),
          region,
          topics: 'search',
          status: 'pending',
        });
      }
    } catch {}
  }
  return results;
}

// ── MAIN ─────────────────────────────────────────────────
async function main() {
  log(`\n╔══════════════════════════════════════════════════╗`);
  log(`║   🎯 Party Favor Photo — Bulk Campaign Scraper   ║`);
  log(`║   Target: ${TARGET} contacts | Concurrency: ${CONCURRENCY}      ║`);
  log(`╚══════════════════════════════════════════════════╝\n`);

  const startTime = Date.now();
  let existing = loadExisting();
  log(`📦 Existing pool: ${existing.length} contacts\n`);

  // Phase 1: School district directories
  log(`📋 Phase 1: Scraping ${DIRECTORIES.length} school district directories...`);
  let allNew = await parallelFetch(DIRECTORIES);
  
  // Phase 2: Search for PTA/event contacts in both regions
  log(`\n\n🔍 Phase 2: Targeted searches for event planners & PTA...`);
  
  const searchQueries = [
    // DC Area
    { q: 'Fairfax County PTSA president email list "fcps"', region: 'Northern Virginia Washington DC' },
    { q: '"fairfax county" PTA president email directory', region: 'Northern Virginia Washington DC' },
    { q: '"loudoun county" PTA president email', region: 'Northern Virginia Washington DC' },
    { q: '"prince william" PTA president email', region: 'Northern Virginia Washington DC' },
    { q: '"arlington va" PTA president email', region: 'Northern Virginia Washington DC' },
    { q: '"montgomery county md" PTA president email', region: 'Northern Virginia Washington DC' },
    { q: '"dc" public schools PTA president email', region: 'Northern Virginia Washington DC' },
    { q: 'Washington DC event planner contact email photo booth', region: 'Northern Virginia Washington DC' },
    { q: 'Northern Virginia wedding venue coordinator email', region: 'Northern Virginia Washington DC' },
    { q: 'DMV corporate event planner contact email', region: 'Northern Virginia Washington DC' },
    
    // Dallas-Fort Worth
    { q: '"dallas isd" PTA president email', region: 'Dallas Fort Worth Texas' },
    { q: '"frisco isd" PTA president email', region: 'Dallas Fort Worth Texas' },
    { q: '"plano isd" PTA president email', region: 'Dallas Fort Worth Texas' },
    { q: '"allen tx" PTA president email', region: 'Dallas Fort Worth Texas' },
    { q: '"mckinney tx" PTA president email', region: 'Dallas Fort Worth Texas' },
    { q: 'Dallas Fort Worth event planner contact email photo booth', region: 'Dallas Fort Worth Texas' },
    { q: 'Dallas wedding venue coordinator email contact', region: 'Dallas Fort Worth Texas' },
    { q: '"fort worth" corporate event planner email', region: 'Dallas Fort Worth Texas' },
    { q: 'Texas PTA local unit directory email', region: 'Dallas Fort Worth Texas' },
    { q: '"dallas" festival organizer email contact', region: 'Dallas Fort Worth Texas' },
  ];

  for (const sq of searchQueries) {
    const found = await searchAndScrape([sq.q], sq.region);
    allNew.push(...found);
    if (found.length > 0) {
      log(`  ✓ "${sq.q.slice(0,50)}..." → ${found.length} emails`);
    }
    await new Promise(r => setTimeout(r, 2000)); // Rate limit
  }

  // Phase 3: Final merge and save
  log(`\n\n📦 Merging ${allNew.length} new contacts with existing pool (${existing.length})...`);
  const merged = [...existing, ...allNew];
  const saved = saveContacts(merged);
  
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  log(`\n╔══════════════════════════════════════════════════╗`);
  log(`║   ✅ COMPLETE                                    ║`);
  log(`║   Time: ${elapsed}s                               ║`);
  log(`║   Found: ${allNew.length} new contacts            ║`);
  log(`║   Pool: ${saved.length} total contacts            ║`);
  log(`║   Errors: ${totalErrors}                          ║`);
  log(`╚══════════════════════════════════════════════════╝\n`);
}

main().catch(e => {
  log(`\n❌ FATAL: ${e.message}`);
  log(e.stack);
  process.exit(1);
});
