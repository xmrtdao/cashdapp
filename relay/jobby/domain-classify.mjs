/**
 * Domain classification for the money-opportunities scanner.
 *
 * The question this answers is narrow and mechanical: given what we actually
 * read off this page, is it a parking/broker page, a live site, or something we
 * were not allowed to read?
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not ask a model whether a page looks parked. That was the original
 * design and it is the wrong shape for the first layer, for two reasons:
 *
 *   1. A model asked "is this parked?" will answer. It will produce a confident
 *      verdict for a page it has never been shown, a page that failed to load,
 *      and a page whose content is an error message. The failure mode is not an
 *      error, it is a plausible sentence - which is the hardest kind of wrong to
 *      notice downstream.
 *
 *   2. The thing we act on is the email address. A wrong parked/not-parked call
 *      costs a wasted row. A wrong contact call puts a stranger's inbox in
 *      front of the candidate as though it were a business prospect.
 *
 * So this layer is string signatures over fetched content. It is boring, it is
 * auditable, and when it is wrong the `signature` column says which string it
 * matched so a human can check the call in one glance. The model gets the second
 * job - scoring a live site for how improvable it is - where judgement is the
 * actual requirement and a signature table cannot help.
 *
 * The parked/live split here is the same evidence discipline as
 * `company-domain.mjs`, which already had to reject parked pages and TLD
 * marketplaces to identify a company's own site. This is that rule, pointed the
 * other way: instead of "a parked page fails to name the company", it is "a
 * parked page names a broker".
 */

import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Broker / parking page signatures.
 *
 * Ordered most-specific first, because the first match is the one reported and
 * "godaddy" alone tells you nothing - every GoDaddy-hosted live site has a
 * GoDaddy footer. The broker names below appear on the parking page's own body
 * copy, not in a footer, which is why they discriminate.
 */
const PARKED_SIGNATURES = [
  // The big aftermarket brokers. If the page is selling this domain, these are
  // who is selling it.
  { id: 'sedo',        re: /\bsedo\b/i },
  { id: 'dan',         re: /\bdan\.com\b/i },
  { id: 'afternic',    re: /\bafternic\b/i },
  { id: 'hugedomains', re: /\bhugedomains\b/i },
  { id: 'above',       re: /\babove\.com\b|\babove\.com domain/i },
  { id: 'namebright',  re: /\bnamebright\b/i },
  { id: 'parkingcrew', re: /\bparkingcrew\b/i },
  { id: 'undeveloped', re: /\bundeveloped\.com\b|\bthis domain is undeveloped\b/i },

  // Registrar-owned parking. GoDaddy, Namecheap, Gandi, Hostinger, and the
  // generic "this may be for sale" copy they share.
  { id: 'godaddy',     re: /\b(?:godaddy|this domain (?:is|may be) for sale)/i },
  { id: 'namecheap',   re: /\bnamecheap\b.*\b(?:parked|for sale)\b/i },
  { id: 'gandi',       re: /\bgandi\b.*\b(?:parked|for sale)\b/i },

  // Generic aftermarket copy. Weakest signal in the table, which is why it is
  // last - a live business can and does write "make an offer" on a services
  // page. It is kept because some broker pages are so heavily rebuilt they
  // carry nothing else, and it is listed after the named brokers so it only
  // decides a page nothing else claimed.
  { id: 'for-sale-text', re: /\b(?:inquiry to purchase|make an offer|buy this domain|this domain is for sale)\b/i },
];

/**
 * Signals that a page is a real site rather than a placeholder.
 *
 * Deliberately weak. The purpose is not to be sure a site is good - the model
 * scores that - it is only to avoid calling a live business a parking page
 * because one generic string happened to appear on it.
 */
const LIVE_SIGNATURES = [
  { id: 'has-viewport',  re: /<meta[^>]+name=["']viewport["']/i },
  { id: 'has-description', re: /<meta[^>]+name=["']description["']/i },
  { id: 'has-og',        re: /<meta[^>]+property=["']og:/i },
  { id: 'has-many-links', re: /(?:<a\s|<a href)/gi, count: 8 },
];

/**
 * Markers of a site that has been maintained recently.
 *
 * These are what separate `live_strong` from `live_weak`, and they are markers
 * of *recency*, not of size or quality. An earlier version used a byte-count
 * multiple for that, and it was wrong in a way worth recording: a real 2KB
 * business page with a viewport tag, a meta description, twelve nav links and
 * genuine prose came back `live_weak`, because 1905 bytes is under three times
 * a stub. `live_weak` is precisely the bucket this feature exists to find - a
 * site with a real owner that could be improved - so a measure that
 * reclassified small real sites into it was measuring bytes, not neglect.
 *
 * A site carrying a modern framework, a current copyright year or an analytics
 * tag has been touched recently by definition. Absence of all three is weak
 * evidence, not proof, and `http_state` says "weak" where it means "weak".
 */
const MAINTAINED_SIGNATURES = [
  { id: 'has-viewport', re: /<meta[^>]+name=["']viewport["']/i },
  { id: 'current-year', re: new RegExp(`(?:©|&copy;|copyright)[^<]{0,40}\\b${new Date().getFullYear()}\\b`, 'i') },
  { id: 'modern-runtime', re: /__NEXT_DATA__|nuxt|react|vue|webpack|gtag\(|googletagmanager|google-analytics/i },
];

/**
 * A page smaller than this is a stub. Parking pages are usually tiny because
 * there is nothing on them; a real business site almost never is. This is a
 * supporting signal, not a decision on its own - some parked pages are heavy
 * with tracking scripts, and one small legitimate site should not be called
 * parked for it.
 */
const STUB_BYTES = 1200;

/** Words that look like domains in prose but are not contact addresses. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Filenames that end in something that looks like a TLD. `logo@2x.png` and
 * `icon@3x.webp` are extremely common in real site markup and are not
 * addresses. Same guard as `isRealEmail` in the PFP campaign code, which found
 * this the hard way.
 */
const IMAGE_SUFFIX_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|woff2?|ttf)$/i;

/**
 * Addresses that belong to the site we are scanning, or to a tool, rather than
 * to the owner. Offering to rebuild the site of someone whose only contact is
 * their own registrar's abuse desk is not an opportunity.
 *
 * This list is short on purpose and is not a general-purpose blocklist. The
 * rule is: an address is excluded if it is on the scanned domain's own registrar
 * or a known infrastructure provider, because reaching it tells us nothing about
 * the owner.
 */
const INFRASTRUCTURE_RE = /@(?:.*\.)?(?:godaddy\.com|namecheap\.com|cloudflare\.com|squarespace\.com|wix\.com|weebly\.com|shopify\.com|hostinger\.com|gandi\.net|hover\.com|networksolutions\.com|registrar\.com|letsencrypt\.org|example\.(?:com|org|net)|sentry\.io|googlemail\.com)\s*$/i;

/**
 * Role addresses worth preferring, because a person wrote them intending to be
 * written to. Ordered by how likely a human is to read them.
 */
const ROLE_PRIORITY = [
  { re: /^(info|hello|hi|contact|enquiries|enquiries|general)@/i, rank: 1 },
  { re: /^owner@/i,                                             rank: 0 },
  { re: /^(sales|support|customerservice|help)@/i,             rank: 2 },
  { re: /^(admin|webmaster|postmaster|hostmaster)@/i,          rank: 3 },
  { re: /^(marketing|press|pr)@/i,                              rank: 4 },
];

function roleRank(address) {
  const lower = address.toLowerCase();
  for (const entry of ROLE_PRIORITY) {
    if (entry.re.test(lower)) return entry.rank;
  }
  return 9;
}

/**
 * Pull contact addresses out of a fetched page.
 *
 * `links` is the output of `webScrape({extractLinks:true})`. That module reads
 * href attributes *before* the text extractor deletes every tag, which is the
 * only reason a `mailto:` on the page is visible to us at all - see the note in
 * tools/web-scrape.mjs. Without extractLinks a page that publishes its address
 * reads as having none, and the finding would be wrong rather than absent.
 *
 * @param {string} html          raw page body
 * @param {Array}  links         extractHtmlLinks() output, may be []
 * @param {string} scannedDomain the domain being scanned, for self-contact
 *                               and infrastructure filtering
 * @returns {{email:string|null, source:string|null, evidence:object|null, rejected:string[]}}
 */
export function extractContact(html, links, scannedDomain) {
  const rejected = [];
  const fromMailto = [];
  const fromBody = [];
  const seen = new Set();

  // Single-address check. Deliberately a separate non-global pattern: EMAIL_RE
  // is /g, so calling .test() on it is stateful - lastIndex persists between
  // calls and the same address can alternate between matching and failing,
  // which drops contacts out of a list for no visible reason.
  const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const accept = (raw, source) => {
    const address = String(raw || '').trim().toLowerCase()
      // "Name <a@b.com>" is legal in a mailto and the name is not an address.
      .replace(/^.*</, '').replace(/>.*$/, '').trim();
    if (!ADDRESS_RE.test(address)) return;
    if (seen.has(address)) return;
    if (IMAGE_SUFFIX_RE.test(address)) { rejected.push(address); return; }
    // An address on the domain being scanned, addressed to itself, is a loop.
    if (scannedDomain && address.endsWith('@' + scannedDomain)) {
      // Not rejected: an owner publishing info@theirdomain.com IS the owner.
      // Recorded, not filtered.
    }
    if (INFRASTRUCTURE_RE.test(address)) {
      rejected.push(address);
      return;
    }
    seen.add(address);
    (source === 'mailto_href' ? fromMailto : fromBody).push(address);
  };

  for (const link of links || []) {
    if (link && link.kind === 'mailto' && link.href) {
      accept(link.href.replace(/^mailto:/i, ''), 'mailto_href');
    }
  }
  // match() on a /g regex is not stateful, so this is safe here. It is `test()`
  // on a /g regex that is not - see ADDRESS_RE above.
  for (const match of String(html || '').match(EMAIL_RE) || []) {
    accept(match, 'body_regex');
  }

  // mailto beats body text: a link is a deliberate act of publication, while a
  // bare string in body copy is sometimes an example in a privacy notice.
  const pool = fromMailto.length ? fromMailto : fromBody;
  if (!pool.length) {
    return {
      email: null,
      source: 'none',
      evidence: { checked: true, mailto: 0, body: 0, rejected: rejected.slice(0, 10) },
      rejected,
    };
  }
  pool.sort((a, b) => roleRank(a) - roleRank(b));
  return {
    email: pool[0],
    source: fromMailto.length ? 'mailto_href' : 'body_regex',
    evidence: {
      checked: true,
      mailto: fromMailto.length,
      body: fromBody.length,
      chose: pool[0],
      // Every candidate, so a reader can see what the choice was between.
      considered: pool.slice(0, 10),
      rejected: rejected.slice(0, 10),
    },
    rejected,
  };
}

/**
 * Classify a fetched page into parked / live_weak / live_strong.
 *
 * `blocked` and `unreachable` are decided by the caller, which knows the HTTP
 * status. This function only sees a page that arrived.
 *
 * @returns {{http_state:string, signature:string|null, evidence:object}}
 */
export function classifyPage(html, links) {
  const body = String(html || '');
  const signals = { matched: [], live_signals: [], bytes: body.length };

  for (const entry of PARKED_SIGNATURES) {
    if (entry.re.test(body)) {
      signals.matched.push(entry.id);
      // First match wins, and the list is ordered most-specific-first, so the
      // reported signature is the informative one rather than whichever
      // generic footer string happened to be earlier in the document.
      return {
        http_state: 'parked',
        signature: entry.id,
        evidence: { ...signals, matched: signals.matched },
      };
    }
  }

  for (const entry of LIVE_SIGNATURES) {
    if (entry.count) {
      const found = (body.match(entry.re) || []).length;
      if (found >= entry.count) signals.live_signals.push(entry.id);
    } else if (entry.re.test(body)) {
      signals.live_signals.push(entry.id);
    }
  }

  // A tiny page with nothing on it is a stub. A tiny page with real signals is
  // a small site, and calling that parked would be the exact error this whole
  // module exists to avoid.
  const isStub = body.length < STUB_BYTES && signals.live_signals.length === 0;
  if (isStub) {
    signals.matched.push('empty-stub');
    return { http_state: 'live_weak', signature: 'empty-stub', evidence: signals };
  }

  // Weak vs strong is deliberately a low bar: real structure at all is weak;
  // several live signals plus enough real prose is strong. The model does the
  // rest of the thinking, in score.mjs, where it can be argued with.
  //
  // The size gate is 2x the stub threshold, not 3x. An earlier version used 3x,
  // which put a genuine 2KB business page - three live signals, real nav, real
  // prose - into `live_weak` purely on byte count. That bucket is exactly the
  // one this feature exists to find, so a size multiple that reclassified real
  // sites was measuring the wrong thing. Signal count leads; size only confirms.
  // Strong claims "this has been maintained", evidenced by maintenance markers.
  // It deliberately does not claim "this is big", and size is not on the
  // decision path - see the note on MAINTAINED_SIGNATURES for why that was
  // reversed.
  const maintained = [];
  for (const entry of MAINTAINED_SIGNATURES) {
    if (entry.re.test(body)) maintained.push(entry.id);
  }
  signals.maintained = maintained;
  const strong = maintained.length >= 2;
  return {
    http_state: strong ? 'live_strong' : 'live_weak',
    signature: (maintained.length ? maintained : signals.live_signals).slice(0, 3).join('+') || null,
    evidence: signals,
  };
}

/**
 * Does this host resolve?
 *
 * Aimed at callers that want to inject a lookup in tests, the same
 * `lookupImpl` seam `company-domain.mjs` uses. `no_record` is a finding, not a
 * failure: an unresolving domain may be parked-but-unserviced or genuinely
 * expired, and both are worth a row.
 */
export async function hasAddress(host, lookupImpl = dnsLookup) {
  try {
    const addrs = await lookupImpl(host);
    return { resolves: Array.isArray(addrs) ? addrs.length > 0 : Boolean(addrs), addresses: addrs };
  } catch {
    return { resolves: false, addresses: [] };
  }
}

/**
 * The keyword -> domain shapes the scanner generates.
 *
 * Kept small and boring. The value here is not in the permutation count, it is
 * in the classifier and the scoring; a wider generator just finds more parked
 * pages faster, and parked pages are the branch that cannot produce a contact.
 */
export const DEFAULT_TLDS = ['com', 'net', 'org', 'io', 'co'];

export function domainCandidates(keyword, tlds = DEFAULT_TLDS) {
  const cleaned = String(keyword || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
  if (cleaned.length < 3) return [];

  const stems = [cleaned, `${cleaned}app`, `${cleaned}hq`];
  const out = [];
  for (const stem of stems) {
    for (const tld of tlds) {
      out.push({ domain: `${stem}.${tld}`, tld });
    }
  }
  return out;
}

export const __test__ = {
  PARKED_SIGNATURES,
  MAINTAINED_SIGNATURES,
  STUB_BYTES,
  roleRank,
  INFRASTRUCTURE_RE,
};
