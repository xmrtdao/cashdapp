/**
 * Phase 1 domain-opportunities tests.
 *
 * Two things are being protected here.
 *
 * The first is the claim that this feature cannot send. `assertNoSendPath`
 * greps the whole module set for a transport call. It is the test that would
 * fail if somebody wired a mailbox into a daemon that a brand-new candidate's
 * arrival starts, and it is cheap, so it runs on every pass.
 *
 * The second is that no contact address is ever invented or mis-sourced. A wrong
 * address here is not a display bug - it is a stranger's inbox. Every test
 * around `extractContact` is really one test wearing several hats.
 *
 * Pure logic only. The store talks to postgres and the scan talks to the
 * network; both take injected implementations, and those seams are what the
 * tests below drive. There is no HTTP mocking because there is no HTTP - the
 * daemon makes real requests to real servers and a test that pretended
 * otherwise would be testing the mock.
 *
 * Run: node tests/_run.mjs domain-ops
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyPage, extractContact, domainCandidates, hasAddress,
  __test__ as classifyTest,
} from '../jobby/domain-classify.mjs';
import { scanPass, scanOne } from '../jobby/domain-scan.mjs';
import {
  parseScoreResponse,
  __test__ as scoreTest,
} from '../jobby/domain-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBBY_DIR = join(HERE, '..', 'jobby');

/* ------------------------------------------------------------------ */
/* The claim this file exists to protect                              */
/* ------------------------------------------------------------------ */

test('no send path exists in the domain-ops modules', () => {
  // Everything that could put a message in an outbox. If this test ever fails,
  // the answer is not "good, we shipped sending" - it is that phase 1 grew a
  // transport without anyone deciding to.
  const FORBIDDEN = [
    'sendViaResend',
    'jobby_send',
    'RESEND_API_KEY',
    'api.resend.com',
    'nodemailer',
    'smtp',
    'assertCanRepresent',
    'recordOutreach',
    'canSend',
  ];
  for (const file of [
    'domain-classify.mjs', 'domain-store.mjs', 'domain-scan.mjs',
    'domain-score.mjs', 'domain-daemon.mjs',
  ]) {
    // Strip comments before checking. A comment explaining why we don't send is
    // valuable documentation; a call to a send function is a bug. The test
    // should catch the second, not the first.
    const src = readFileSync(join(JOBBY_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const needle of FORBIDDEN) {
      assert.ok(
        !src.includes(needle),
        `${file} must not reference ${needle}: phase 1 sends nothing`,
      );
    }
  }
});

test('the daemon says out loud that it does not send', () => {
  const src = readFileSync(join(JOBBY_DIR, 'domain-daemon.mjs'), 'utf8');
  assert.match(src, /does not send/i,
    'the daemon should state its own no-send property where the operator reads it');
});

/* ------------------------------------------------------------------ */
/* WHOIS is not a source. This is the finding that shaped the schema. */
/* ------------------------------------------------------------------ */

test('no WHOIS or RDAP lookup anywhere in the scanner', () => {
  // The registry returns no registrant contact for modern .com registrations,
  // and its terms of use forbid the use this feature would have made of it. A
  // future reader adding a whois call has not read jobby_007's header.
  for (const file of [
    'domain-classify.mjs', 'domain-store.mjs', 'domain-scan.mjs',
    'domain-score.mjs', 'domain-daemon.mjs',
  ]) {
    const src = readFileSync(join(JOBBY_DIR, file), 'utf8');
    assert.ok(!/\bwhois\b/i.test(src), `${file} must not query WHOIS`);
    assert.ok(!/\brdap\b/i.test(src), `${file} must not query RDAP`);
  }
});

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

test('broker pages classify as parked and name the broker', () => {
  const cases = [
    ['<body>Sedo Domain Parking. sedo.com</body>', 'sedo'],
    ['<body>This domain may be for sale. afternic.com</body>', 'afternic'],
    ['<body>Buy this domain at dan.com</body>', 'dan'],
    ['<body>This domain is for sale. GoDaddy.com, LLC</body>', 'godaddy'],
    ['<body>ParkingCrew. This domain is parked.</body>', 'parkingcrew'],
  ];
  for (const [html, expected] of cases) {
    const r = classifyPage(html, []);
    assert.equal(r.http_state, 'parked', `expected parked for ${expected}`);
    assert.equal(r.signature, expected);
  }
});

test('a live business is never called parked', () => {
  // The regression this file was written after. A byte-count rule put a real
  // 2KB page into live_weak; a model-based rule would have been worse.
  const dated = `<html><head><meta name="viewport" content="w"><meta name="description" content="Acme"></head>
    <body><table>${'<a href="page.htm">x</a>'.repeat(10)}</table><p>&copy; 2011 Acme Roofing</p></body></html>`;
  const r = classifyPage(dated, []);
  assert.equal(r.http_state, 'live_weak');
  assert.ok(r.evidence.maintained.length < 2,
    'a 2011 site should not look maintained');
});

test('a maintained site is called strong', () => {
  const year = new Date().getFullYear();
  const modern = `<html><head><meta name="viewport" content="w"><script src="/_next/a.js"></script></head>
    <body>&copy; ${year} Acme ${'Serving the county since 1994. '.repeat(40)}</body></html>`;
  assert.equal(classifyPage(modern, []).http_state, 'live_strong');
});

test('an empty page is a stub, not a finding of absence', () => {
  const r = classifyPage('', []);
  assert.equal(r.http_state, 'live_weak');
  assert.equal(r.signature, 'empty-stub');
});

test('every parked signature is ordered before the generic fallback', () => {
  // "make an offer" appears on real services pages. If it were first, a live
  // business would be reported as a parking page.
  const ids = classifyTest.PARKED_SIGNATURES.map(s => s.id);
  assert.equal(ids[ids.length - 1], 'for-sale-text',
    'the generic string must be last or it decides pages nothing else claimed');
});

/* ------------------------------------------------------------------ */
/* Contact extraction - a wrong address is a stranger's inbox          */
/* ------------------------------------------------------------------ */

test('a mailto on the page is found and lowercased', () => {
  const r = extractContact('<a href="mailto:Info@Acme.com">mail</a>',
    [{ kind: 'mailto', href: 'mailto:Info@Acme.com' }], 'acme.com');
  assert.equal(r.email, 'info@acme.com');
  assert.equal(r.source, 'mailto_href');
});

test('a named mailto yields a bare address', () => {
  const r = extractContact('<a href="mailto:Jane Doe <jane@acme.com>">jane</a>',
    [{ kind: 'mailto', href: 'mailto:Jane Doe <jane@acme.com>' }], 'acme.com');
  assert.equal(r.email, 'jane@acme.com');
});

test('image filenames are not addresses', () => {
  const r = extractContact('<img src="logo@2x.png"><img src="icon@3x.webp">', [], 'acme.com');
  assert.equal(r.email, null);
  assert.equal(r.rejected.length, 2, 'a rejection should be recorded, not silent');
});

test('a registrar abuse desk is not an owner contact', () => {
  // This is the exact shape of the false positive the WHOIS investigation found:
  // the only address available is a registrar's abuse mailbox, and it tells us
  // nothing about the owner.
  const r = extractContact('Hosted by GoDaddy. abuse@godaddy.com', [], 'acme.com');
  assert.equal(r.email, null);
});

test('no contact means source none, not null', () => {
  const r = extractContact('<body>nothing here</body>', [], 'acme.com');
  assert.equal(r.email, null);
  assert.equal(r.source, 'none');
  assert.equal(r.evidence.checked, true,
    '"we looked and found nothing" must differ from "we never looked"');
});

test('role addresses are preferred and every candidate is kept', () => {
  const r = extractContact(
    '<a href="mailto:info@acme.com">a</a><a href="mailto:owner@acme.com">b</a>',
    [
      { kind: 'mailto', href: 'mailto:info@acme.com' },
      { kind: 'mailto', href: 'mailto:owner@acme.com' },
    ],
    'acme.com');
  assert.equal(r.email, 'owner@acme.com');
  assert.equal(r.evidence.considered.length, 2);
});

test('the global email regex is not used statefully', () => {
  // EMAIL_RE is /g. A .test() on it carries lastIndex between calls and drops
  // every second address. Two consecutive extractions must both succeed.
  const a = extractContact('<body>first@acme.com</body>', [], 'acme.com');
  const b = extractContact('<body>second@acme.com</body>', [], 'acme.com');
  assert.equal(a.email, 'first@acme.com');
  assert.equal(b.email, 'second@acme.com');
});

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

test('candidates are generated, deduped and bounded', () => {
  assert.equal(domainCandidates('roofing').length, 15);
  assert.equal(domainCandidates('ab').length, 0, 'too short to be a real word');
  assert.ok(domainCandidates('Acme Roofing!').some(d => d.domain === 'acmeroofing.com'));
});

/* ------------------------------------------------------------------ */
/* The scan pass, with the network injected                            */
/* ------------------------------------------------------------------ */

const livePage = {
  url: 'https://acmeroofing.com',
  status: 200,
  title: 'Acme Roofing',
  content: `${'We have served the county since 1994. '.repeat(30)} info@acmeroofing.com`,
  links: [{ kind: 'mailto', href: 'mailto:info@acmeroofing.com' }],
};
const parkedPage = {
  url: 'https://sedomarket.io',
  status: 200,
  title: 'Domain for sale',
  content: 'This domain is for sale. Sedo Domain Parking. Buy this domain. broker@sedo.com',
  links: [{ kind: 'mailto', href: 'mailto:broker@sedo.com' }],
};

const resolves = async () => ({ resolves: true, addresses: ['93.184.216.34'] });
const noDns = async () => ({ resolves: false, addresses: [] });

test('a parked page records no contact even when it publishes one', () => {
  // The broker's address is not the owner's. Recording it would put a stranger's
  // inbox in front of the candidate as though it were a lead.
  return scanOne('sedomarket.io', {
    lookupImpl: resolves,
    scrapeImpl: async () => parkedPage,
  }).then(({ row }) => {
    assert.equal(row.http_state, 'parked');
    assert.equal(row.contact_email, null,
      'a broker address must never be stored as an owner contact');
  });
});

test('a live site with a published contact is worth scoring', () => {
  return scanOne('acmeroofing.com', {
    lookupImpl: resolves,
    scrapeImpl: async () => livePage,
  }).then(({ row, worthScoring }) => {
    assert.equal(row.contact_email, 'info@acmeroofing.com');
    assert.equal(worthScoring, true);
  });
});

test('a 403 is blocked, not unreachable', () => {
  // A page that exists and declined to be read is a different finding from a
  // page we could not reach. Collapsing them reports "nothing there" about
  // something that is there.
  return scanOne('walled.com', {
    lookupImpl: resolves,
    scrapeImpl: async () => ({ url: 'https://walled.com', status: 403, error: 'forbidden', content: '' }),
  }).then(({ row, worthScoring }) => {
    assert.equal(row.http_state, 'blocked');
    assert.equal(row.http_status, 403);
    assert.equal(worthScoring, false);
  });
});

test('a dead DNS record is a finding, not a crash', () => {
  return scanOne('gone.com', {
    lookupImpl: noDns,
    scrapeImpl: async () => { throw new Error('should not be called'); },
  }).then(({ row }) => {
    assert.equal(row.dns_state, 'no_record');
    assert.equal(row.http_state, 'unreachable');
  });
});

test('a fetch error records why rather than claiming absence', () => {
  return scanOne('broken.com', {
    lookupImpl: resolves,
    scrapeImpl: async () => ({ error: 'All fetch attempts failed' }),
  }).then(({ row }) => {
    assert.equal(row.http_state, 'unreachable');
    assert.match(row.evidence.error, /fetch attempts/i);
  });
});

test('extractLinks is always requested', async () => {
  // Without it the scraper strips every href before returning, so a site that
  // publishes its address reads as having none. That would be a false finding,
  // not a gap, and it is invisible without this assertion.
  let seen = null;
  await scanOne('acmeroofing.com', {
    lookupImpl: resolves,
    scrapeImpl: async (_url, opts) => { seen = opts; return livePage; },
  });
  assert.equal(seen.extractLinks, true);
});

test('a pass dedupes generated domains and records every row', async () => {
  const recorded = [];
  const pass = await scanPass({
    keywords: ['acmeroofing'],
    budget: 50,
    lookupImpl: resolves,
    scrapeImpl: async () => livePage,
    recordImpl: async (row) => { recorded.push(row); },
  });
  const unique = new Set(recorded.map(r => r.domain));
  assert.equal(unique.size, recorded.length, 'no domain recorded twice');
  assert.equal(pass.checked, pass.generated);
  assert.ok(pass.stoppedReason === null || /budget/.test(pass.stoppedReason));
});

test('the budget is reported rather than silently truncating', async () => {
  const pass = await scanPass({
    keywords: ['roofing'],
    budget: 3,
    lookupImpl: resolves,
    scrapeImpl: async () => livePage,
    recordImpl: async () => {},
  });
  assert.equal(pass.checked, 3);
  assert.match(pass.stoppedReason, /budget 3 of 15/,
    'a truncated pass must say so');
});

test('one throwing domain does not end the pass', async () => {
  const recorded = [];
  const pass = await scanPass({
    keywords: ['roofing'],
    budget: 5,
    lookupImpl: resolves,
    scrapeImpl: async (url) => {
      // roofing.com is the first candidate generated, so it is always in the
      // first 5. Throwing for a later domain would never trigger.
      if (url.includes('roofing.com')) throw new Error('boom');
      return livePage;
    },
    recordImpl: async (row) => { recorded.push(row); },
  });
  assert.equal(pass.checked, 5, 'every domain still gets a row');
  assert.ok(recorded.some(r => r.dns_state === 'error' && /boom/.test(r.evidence.error)),
    'the failure is recorded on its row');
});

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

test('scores parse from fenced, prefixed and bare JSON', () => {
  const want = { score: 72, verdict: 'underused' };
  for (const raw of [
    '{"score":72,"verdict":"underused","reason":"nav is four .htm links"}',
    '```json\n{"score":72,"verdict":"underused","reason":"nav is four .htm links"}\n```',
    'Here is the JSON:\n{"score":72,"verdict":"underused","reason":"nav is four .htm links"}',
  ]) {
    const r = parseScoreResponse(raw);
    assert.equal(r.score, want.score, raw.slice(0, 20));
    assert.equal(r.verdict, want.verdict);
  }
});

test('an unparseable score is null, never a guess', () => {
  // A fabricated 0 and a real low score are indistinguishable on the board, and
  // one of them is a lie. The table's CHECK constraint requires a reason, so a
  // reasonless response must not become a score at all.
  assert.equal(parseScoreResponse('this site looks quite dated to me'), null);
  assert.equal(parseScoreResponse('{"score":50}'), null, 'no reason, no score');
  assert.equal(parseScoreResponse(''), null);
  assert.equal(parseScoreResponse(null), null);
});

test('scores are clamped and verdicts constrained', () => {
  assert.equal(parseScoreResponse('{"score":9999,"verdict":"healthy","reason":"x"}').score, 100);
  assert.equal(parseScoreResponse('{"score":-5,"verdict":"healthy","reason":"x"}').score, 0);
  assert.equal(
    parseScoreResponse('{"score":50,"verdict":"excellent","reason":"x"}').verdict,
    'unknown', 'an invented verdict falls back rather than being stored');
});

test('the scoring prompt does not ask the model to identify the owner', () => {
  // The model cannot see WHOIS data. Letting it speculate produces a name that
  // looks like a finding, which is the failure AGENTS.md calls inventing.
  const p = scoreTest.buildPrompt({
    domain: 'acme.com', page_title: 'Acme', http_state: 'live_weak',
    signature: null, contact_email: 'info@acme.com', evidence: { text: 'hello' },
  });
  assert.match(scoreTest.SYSTEM, /never claim to know who the owner is/i);
  assert.match(p, /info@acme\.com/);
  assert.ok(!/whois/i.test(p), 'the prompt must not invite a WHOIS-shaped answer');
});

/* ------------------------------------------------------------------ */
/* DNS helper                                                          */
/* ------------------------------------------------------------------ */

test('hasAddress reports a missing record rather than throwing', async () => {
  assert.deepEqual(
    await hasAddress('x.com', async () => { throw new Error('ENOTFOUND'); }),
    { resolves: false, addresses: [] });
  assert.equal((await hasAddress('x.com', async () => ['1.2.3.4'])).resolves, true);
});
