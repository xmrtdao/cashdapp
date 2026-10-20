// relay/jobby/linkedin-drift.mjs — does the public LinkedIn profile still
// match the dossier?
//
// The failure this exists to catch is not hypothetical, and it reached the
// candidate's own account. His profile carried a complete software-engineering
// career he never had — Capital One, Nokia, BridgeBurma, Google exploreCSR —
// plus a University of Michigan engineering degree, none of it his, and none
// of it present in any file on this machine. There is no trace of it in the
// repo, in the relay's browser profile, or in the dossier. It simply appeared
// on the most public page he owns, and the dossier was clean the whole time.
//
// That is the shape of the problem. The dossier is the record; LinkedIn is a
// surface. Every other part of this system treats the dossier as the thing that
// must be true, and a surface that is edited by hand, by a person, or by any
// agent handed a logged-in browser session can diverge from it silently. There
// is no write path from this module to LinkedIn and there will not be one:
// LinkedIn emits no notification when a profile section changes, so a wrong
// write is invisible to the person it happens to.
//
// So this module only ever READS and REPORTS. Three rules follow from that, and
// each has been a bug once:
//
//  1. A check that did not run is not a pass. If the profile cannot be read —
//     no token, no network, an unparseable shape — the result is
//     `status: 'unavailable'` and `ok: false`. A monitor that reports success
//     when it could not look is worse than no monitor, because it is believed.
//
//  2. An entry the dossier cannot explain is surfaced, never resolved. The CTO
//     role at his own company is the case that matters: the company is his, the
//     title is not what he says it is, and the entry carries no dates at all.
//     Any automatic rule here would either delete a real job or invent one.
//
//  3. Dates are compared at YEAR granularity only. The dossier records years.
//     LinkedIn shows months. Comparing months would manufacture a discrepancy
//     out of a month the dossier never claimed to know, which is the same class
//     of error as inventing a tenure.
//
// The read itself is injected. This module never opens a browser and never
// scrapes: the repo already records that reading a LinkedIn profile has no open
// API and that scraping violates the ToS, so a caller must supply the profile
// from a sanctioned source and say which one it used.

import { sameRole } from './role-match.mjs';

const PRESENT = /present|current|now|ongoing/i;

/**
 * Years out of whatever a field holds. LinkedIn renders "Aug 2024 - Present ·
 * 2 yrs 3 mos" and the dossier holds "2024", so the duration suffix has to come
 * off before the year can be read, and "Present" is the open-ended case rather
 * than a missing value.
 */
export function yearOf(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function isCurrentText(v) {
  return PRESENT.test(String(v ?? ''));
}

/**
 * Split one rendered profile date range, e.g. "Jan 2016 - Present · 10 yrs 10 mos"
 * or "2009 - 2019", into the shape role-match reads.
 */
export function parseRange(text) {
  const raw = String(text ?? '').split('·')[0].trim();
  if (!raw) return { start: null, end: null, current: false, known: false };
  const parts = raw.split(/\s+[-–—]\s+/);
  const start = yearOf(parts[0]);
  const endPart = parts[1];
  if (isCurrentText(endPart)) return { start, end: null, current: true, known: start !== null };
  const end = yearOf(endPart);
  return { start, end, current: false, known: start !== null || end !== null };
}

/**
 * Bring one profile entry to the same shape the dossier uses. Accepts the
 * Linked API shape and the flatter scraped shape alike, because the caller
 * supplies the source and this should not care which.
 */
export function normaliseProfileEntry(e) {
  const company = e?.company ?? e?.organization ?? e?.companyName ?? '';
  const title = e?.title ?? e?.position ?? e?.jobTitle ?? '';
  const rangeText = e?.dateRange ?? e?.dates ?? e?.date_range ?? null;
  const range = rangeText ? parseRange(rangeText) : {
    start: yearOf(e?.start),
    end: e?.end === null || e?.end === undefined ? null : yearOf(e?.end),
    current: e?.current === true,
    known: yearOf(e?.start) !== null || yearOf(e?.end) !== null,
  };
  return {
    company: String(company).trim(),
    title: String(title).trim(),
    start: range.start,
    end: range.end,
    current: range.current,
    known: range.known,
  };
}

/** The dossier's own employment, in its own shape. */
export function expectedRoles(dossier) {
  const list = Array.isArray(dossier?.employment) ? dossier.employment : [];
  return list.map((e) => ({
    company: String(e?.company ?? '').trim(),
    title: String(e?.title ?? '').trim(),
    start: yearOf(e?.start),
    end: e?.current === true ? null : yearOf(e?.end),
    current: e?.current === true,
    known: yearOf(e?.start) !== null || yearOf(e?.end) !== null,
  }));
}

function label(x) {
  const years = x.start === null ? '?' : `${x.start}-${x.current ? 'present' : (x.end ?? '?')}`;
  return `${x.title} · ${x.company} · ${years}`;
}

/**
 * Compare the dossier against the live profile.
 *
 * `profileEntries` must be the raw entries as read. Returns a report that is
 * always safe to show a person: it lists what is missing, what cannot be
 * explained, and which fields disagree. It never edits anything.
 */
export function diff({ dossier, profileEntries }) {
  const expected = expectedRoles(dossier);
  const actual = (Array.isArray(profileEntries) ? profileEntries : []).map(normaliseProfileEntry);

  const matched = [];
  const missing = [];
  const mismatched = [];

  for (const want of expected) {
    let best = null;
    for (const got of actual) {
      if (matched.some((m) => m.actual === got)) continue;
      if (want.known && !got.known) continue; // undated entries cannot confirm a dated one
      const r = sameRole(want, got);
      if (r.same && (!best || r.score > best.score)) best = { actual: got, score: r.score, match: r };
    }
    if (!best) { missing.push(want); continue; }

    matched.push({ expected: want, actual: best.actual, score: best.score });

    // Matched is not the same as agreeing. Report the fields that differ.
    const fields = {};
    if (want.known && best.actual.known) {
      if (want.start !== null && best.actual.start !== null && want.start !== best.actual.start) {
        fields.start = { dossier: want.start, profile: best.actual.start };
      }
      if (!want.current && !best.actual.current) {
        if (want.end !== null && best.actual.end !== null && want.end !== best.actual.end) {
          fields.end = { dossier: want.end, profile: best.actual.end };
        }
      } else if (want.current !== best.actual.current) {
        fields.current = { dossier: want.current, profile: best.actual.current };
      }
    }
    if (Object.keys(fields).length) mismatched.push({ expected: want, actual: best.actual, fields });
  }

  // Anything on the profile the dossier did not vouch for.
  const unexplained = actual.filter((got) => !matched.some((m) => m.actual === got));

  // An entry with no dates at all can neither confirm nor deny a role. It is
  // called out separately because it is exactly how the CTO entry presents.
  const undated = unexplained.filter((x) => !x.known);
  const dated = unexplained.filter((x) => x.known);

  const problems = missing.length + unexplained.length + mismatched.length;
  return {
    status: 'checked',
    ok: problems === 0,
    counts: {
      expected: expected.length,
      onProfile: actual.length,
      matched: matched.length,
      missing: missing.length,
      unexplained: unexplained.length,
      undated: undated.length,
      mismatched: mismatched.length,
    },
    missing,
    unexplained,
    undated,
    mismatched,
  };
}

/**
 * Run the check.
 *
 * `readProfile` is injected and must resolve to `{ entries, source }`. Anything
 * that goes wrong resolving it produces an UNAVAILABLE report - ok:false, with
 * the reason - never a silent pass.
 */
export async function runDriftCheck({ dossier, readProfile, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  try {
    if (typeof readProfile !== 'function') {
      throw new Error('no readProfile supplied - this module does not open a browser or scrape LinkedIn');
    }
    const res = await readProfile();
    const entries = Array.isArray(res) ? res : res?.entries;
    if (!Array.isArray(entries)) throw new Error('readProfile returned no entries array');

    const report = diff({ dossier, profileEntries: entries });
    return { ...report, checkedAt, source: (res && !Array.isArray(res) && res.source) || null };
  } catch (err) {
    // A check that could not run must not be mistaken for a clean one.
    return {
      status: 'unavailable',
      ok: false,
      checkedAt,
      source: null,
      reason: String(err?.message || err),
      counts: null,
      missing: [],
      unexplained: [],
      undated: [],
      mismatched: [],
    };
  }
}

/** A report a person can act on, in plain sentences. */
export function renderReport(report) {
  if (report.status === 'unavailable') {
    return [
      'LinkedIn drift check: COULD NOT RUN.',
      `  Reason: ${report.reason}`,
      '  This is not a pass. Nothing was verified either way.',
    ].join('\n');
  }

  const lines = [`LinkedIn drift check (${report.checkedAt})`];
  if (report.source) lines.push(`  Source: ${report.source}`);
  lines.push(`  Dossier roles: ${report.counts.expected} · on profile: ${report.counts.onProfile}`);

  if (report.ok) {
    lines.push('  No drift. Every dossier role is on the profile with agreeing dates,');
    lines.push('  and nothing is on the profile the dossier does not account for.');
    return lines.join('\n');
  }

  if (report.missing.length) {
    lines.push('', `  MISSING from the profile (${report.missing.length}) - in the dossier, not on LinkedIn:`);
    for (const m of report.missing) lines.push('    - ' + label(m));
  }
  if (report.unexplained.length) {
    lines.push('', `  UNEXPLAINED on the profile (${report.unexplained.length}) - LinkedIn lists these, the dossier does not:`);
    for (const m of report.unexplained) lines.push('    - ' + label(m));
  }
  if (report.mismatched.length) {
    lines.push('', `  DISAGREEING dates (${report.mismatched.length}) - same role, different years:`);
    for (const m of report.mismatched) {
      lines.push('    - ' + label(m.expected));
      for (const [field, v] of Object.entries(m.fields)) {
        lines.push(`        ${field}: dossier ${JSON.stringify(v.dossier)} vs profile ${JSON.stringify(v.profile)}`);
      }
    }
  }
  lines.push('', '  Nothing was changed. Each line above is a question for the person, not a verdict.');
  return lines.join('\n');
}
