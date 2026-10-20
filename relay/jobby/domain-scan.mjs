/**
 * The scan pass: keyword -> candidate domain -> fetch -> classify -> record.
 *
 * `domain-classify.mjs` decides what a page IS. This decides what to do about it
 * and keeps the honesty rules in one place:
 *
 *   - `blocked` is recorded as blocked, never as unreachable or as "nothing
 *     there". A 403 is a page that exists and declined to be read.
 *   - A domain with no DNS record is recorded with `dns_state='no_record'`. It
 *     is a finding, not a failure.
 *   - Contact extraction runs on the LIVE site only. A parked page's broker
 *     contact is not recorded as an owner contact, because it is not one.
 *   - The run ledger records `requested` and `checked` separately, so a run that
 *     asked for 40 and actually looked at 3 is visible rather than reported as
 *     "no results".
 */

import { webScrape } from '../tools/web-scrape.mjs';
import {
  classifyPage, extractContact, domainCandidates, hasAddress,
} from './domain-classify.mjs';

/** How many domains one pass will look at. A cap, because each one is a real
 *  request to somebody's web server on a shared reputation. */
const DEFAULT_BUDGET = 25;

/** Concurrent fetches. Four, matching `pollFeeds`'s concurrency, deliberately
 *  low: this is the one scanner in the relay making requests to sites that have
 *  no idea a candidate is interested in them. */
const CONCURRENCY = 4;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Check one domain. Pure enough to test: every network dependency is injectable.
 *
 * @returns {{row:object, worthScoring:boolean}}
 */
export async function scanOne(domain, opts = {}) {
  const {
    scrapeImpl = webScrape,
    lookupImpl = hasAddress,
    timeout = 15000,
  } = opts;

  const host = String(domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // DNS first. A domain with no A record is cheap to record and worth a row -
  // it may be expired, or parked with the web server switched off, and both are
  // real answers to "is anything here".
  const dns = await lookupImpl(host);
  if (!dns.resolves) {
    return {
      row: {
        domain: host,
        dns_state: 'no_record',
        http_state: 'unreachable',
        evidence: { reason: 'no DNS record', checked_at: new Date().toISOString() },
      },
      worthScoring: false,
    };
  }

  const url = `https://${host}/`;
  const page = await scrapeImpl(url, {
    timeout,
    // Non-negotiable. Without extractLinks the scraper strips every href before
    // returning, so a site that publishes `mailto:info@...` reads as having no
    // contact - and that would be a false finding, not a gap.
    extractLinks: true,
  });

  const stamp = { checked_at: new Date().toISOString(), url };

  // Status is checked before the error field. A scraper can return both a
  // status and an error string - a 403 with "forbidden" in the error field is
  // still a 403, and recording it as unreachable would report "nothing there"
  // about a page that is there and declined to be read.
  const status = Number(page?.status || 0);
  if (status === 401 || status === 403 || status === 429) {
    return {
      row: {
        domain: host,
        dns_state: 'resolves',
        http_state: 'blocked',
        http_status: status,
        final_url: page?.url || url,
        evidence: { ...stamp, note: 'site refused an automated read' },
      },
      worthScoring: false,
    };
  }

  if (!page || page.error) {
    // A fetch failure is not evidence of absence. Recorded as unreachable with
    // the reason attached, so the next reader knows we tried and could not tell.
    return {
      row: {
        domain: host,
        dns_state: 'resolves',
        http_state: 'unreachable',
        final_url: url,
        evidence: { ...stamp, error: page?.error || 'fetch failed' },
      },
      worthScoring: false,
    };
  }

  // The scraper returns extracted *text* by default, and text has had every tag
  // stripped - which would make the parked-signature table below match nothing,
  // because every signature in it is a phrase in visible copy but several are
  // markup-level. So classification runs on the text and the signature table is
  // written to work on text, not HTML. See `signature_source` below.
  const body = page.content || '';
  const classified = classifyPage(body, page.links || []);

  // Contact extraction runs on live pages only. On a parked page the address
  // present is the broker's - recording it would put a stranger's business inbox
  // in front of the candidate as though it were the owner's, which is the exact
  // mistake this module exists to avoid.
  let contact = { email: null, source: null, evidence: null };
  if (classified.http_state !== 'parked') {
    contact = extractContact(body, page.links || [], host);
  }

  return {
    row: {
      domain: host,
      dns_state: 'resolves',
      http_state: classified.http_state,
      http_status: status || null,
      page_title: page.title || null,
      final_url: page.url || url,
      signature: classified.signature,
      contact_email: contact.email,
      contact_source: contact.source,
      contact_evidence: contact.evidence,
      evidence: {
        ...stamp,
        classification: classified.evidence,
        // Recorded so a reader can tell what was actually matched against.
        // The body here is extracted text, not raw markup.
        signature_source: 'extracted_text',
      },
    },
    // Only live, contactable domains are worth a model call. Scoring a parked
    // page costs a round-trip to judge something already known, and scoring a
    // domain with no owner address produces an "opportunity" nobody can act on.
    worthScoring: Boolean(contact.email) &&
      (classified.http_state === 'live_weak' || classified.http_state === 'live_strong'),
  };
}

/**
 * One scan pass over a keyword set.
 *
 * @param {object}   opts
 * @param {string[]} opts.keywords
 * @param {number}   [opts.budget]     domains to look at
 * @param {Function} [opts.scrapeImpl] injected for tests
 * @param {Function} [opts.lookupImpl] injected for tests
 * @param {Function} [opts.recordImpl] injected for tests; defaults to the store
 */
export async function scanPass(opts = {}) {
  const {
    keywords = [],
    budget = DEFAULT_BUDGET,
    scrapeImpl,
    lookupImpl,
    recordImpl,
  } = opts;

  const generated = [];
  for (const keyword of keywords) {
    for (const cand of domainCandidates(keyword)) {
      generated.push({ ...cand, keyword });
    }
  }

  // De-duplicate across keywords before spending anything. Two keywords that
  // produce `acmeroofing.com` are one domain and one request.
  const seen = new Set();
  const unique = [];
  for (const cand of generated) {
    if (seen.has(cand.domain)) continue;
    seen.add(cand.domain);
    unique.push(cand);
  }

  const slice = unique.slice(0, Math.max(0, budget));
  const results = [];
  let checked = 0;
  let stoppedReason = null;

  // Bounded-concurrency map. Four at a time, because every fetch here is a real
  // request to a server that has no idea it is being scanned.
  let cursor = 0;
  async function worker() {
    while (cursor < slice.length) {
      const cand = slice[cursor++];
      let result;
      try {
        result = await scanOne(cand.domain, { scrapeImpl, lookupImpl });
      } catch (err) {
        // One domain throwing must not end the pass. The error is recorded on
        // the row so it is a finding rather than a silent gap in the ledger.
        result = {
          row: {
            domain: cand.domain,
            dns_state: 'error',
            http_state: 'unreachable',
            evidence: { error: String(err && err.message || err) },
          },
          worthScoring: false,
        };
      }
      checked++;
      const row = { ...result.row, keyword: cand.keyword, tld: cand.tld };
      if (recordImpl) await recordImpl(row);
      results.push({ row, worthScoring: result.worthScoring });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, slice.length || 1) }, () => worker())
  );

  if (unique.length > slice.length) {
    stoppedReason = `budget ${slice.length} of ${unique.length} generated domains`;
  }

  return {
    requested: generated.length,
    generated: unique.length,
    checked,
    results,
    toScore: results.filter(r => r.worthScoring),
    stoppedReason,
  };
}

export const __test__ = { DEFAULT_BUDGET, CONCURRENCY, BROWSER_UA };
