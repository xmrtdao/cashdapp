#!/usr/bin/env node
/**
 * pfp-two-stations-contract.mjs — ONE-OFF contract renderer for a multi-StudioStation event.
 *
 * WHY THIS EXISTS
 * ---------------
 * `pfp-contract-pdf.mjs` renders exactly one StudioStation: it hardcodes
 * `${q.hours}-Hour ... Package`, `$249/hr x ${q.hours}hrs`, `Service Hours: ${q.hours} hours`
 * and `Total booked time: ${q.hours} hours`, and `pfp-pricing.mjs` has no `stations`
 * parameter at all. Passing hours=6 to reach a two-booth total would have printed
 * "6-Hour Standard Package" / "Total booked time: 6 hours" — describing ONE booth
 * running six hours instead of TWO booths running three. A header reading $747
 * beside a total reading $1,249 is arithmetically self-contradictory on a signed
 * document.
 *
 * The owner chose the one-off over extending the catalogue. So the layout forks
 * HERE, deliberately, and this file says so at the top rather than letting the
 * fork pass as the real renderer.
 *
 * WHAT IS *NOT* FORKED
 * --------------------
 * Every fact on the page is imported, never typed in:
 *   identity, EIN, governing law, insurance  <- partyfavorphoto-repo/data/pfp-data.json
 *   hourly rate, inclusions, TERMS           <- relay/lib/pfp-pricing.mjs
 *   money formatting                          <- formatCents from the same module
 *
 * The per-station subtotal is computed by calling the catalogue's own
 * `priceQuote(hours, rate)` and multiplying by the station count, so the
 * per-station arithmetic on this contract is the catalogue's, not this script's.
 *
 * WHAT IT STILL DOES NOT DO
 * -------------------------
 * It does not add stations to the catalogue. `priceQuote(3,'standard')` still
 * means one station. A second two-booth event must be priced the same way or it
 * will not match this document.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  priceQuote, formatCents, inclusionsFor,
  TERMS, RATES, OWNER_AUTHORIZED_LABEL, PUBLISHED_DISCOUNTED,
} from '../lib/pfp-pricing.mjs';
import { normalizeProvider } from '../lib/pfp-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);                                   // ...\relay
const REPO = join(ROOT, '..', 'partyfavorphoto-repo');
const DATA = JSON.parse(readFileSync(join(REPO, 'data', 'pfp-data.json'), 'utf8'));
const ASSETS = join(REPO, 'assets');

/**
 * Provider identity, mapped through the catalogue's own validator.
 *
 * The first pass of this script read DATA.contact_name straight into the page and
 * printed the literal word "undefined" twice, in the parties block and again in
 * the signature block, because the key in pfp-data.json is `contactName`. That is
 * the exact failure `normalizeProvider` exists to prevent: it REFUSES an identity
 * with a missing field instead of printing it. Every identity string on this page
 * goes through it now. If the key is renamed again, this throws rather than
 * shipping a contract signed by "undefined".
 */
const PROVIDER = normalizeProvider({
  business_name: DATA.dba,
  legal_name: DATA.legal_name,
  dba: DATA.dba,
  ein: DATA.ein,
  contact_name: DATA.contactName,
  contact_title: DATA.contact_title,
  email: DATA.email,
  phone: DATA.phone,
  website: DATA.website,
  insurance: DATA.insurance,
  governing_law: DATA.governing_law,
});

/**
 * Terms, with the payment clauses swapped when the whole fee is due on booking.
 *
 * The catalogue's TERMS are written for the published 50/50 schedule. Rendering
 * them unchanged under a pay-in-full section produced a document that contradicted
 * itself: section 4 said "TOTAL DUE UPON BOOKING ... no deposit" while clause 5.2
 * said "Fifty per cent (50%) of the Total Fee is due upon booking" and 5.3 talked
 * about forfeiting "the deposit". A client reading 5.2 has been told they owe half,
 * on a contract that says they owe all. The substitutions are listed below and
 * reported on stdout so the override is visible rather than silent.
 */
function termsFor(payInFull, stations) {
  if (!payInFull) return { terms: TERMS, substituted: [] };
  const plural = stations > 1;
  const booth = 'booth';
  const boothS = plural ? 'booths' : 'booth';
  const stationNoun = plural ? 'StudioStation booths' : 'StudioStation';
  const substituted = [];
  const out = TERMS.map((body) => {
    let text = body;
    // 5.2 Payment -> in full on booking
    if (text.startsWith('Payment.')) {
      substituted.push('5.2 Payment -> 100% due upon booking');
      return 'Payment. One hundred per cent (100%) of the Total Fee is due upon booking. ' +
        'No deposit and no later balance apply.';
    }
    // 5.3 Cancellation -> the 50/50 rationale ("that date is when the balance is
    // due") no longer describes this contract, so it is rewritten around the fee.
    if (text.startsWith('Cancellation and Rescheduling.')) {
      substituted.push('5.3 Cancellation -> forfeits the fee already paid in full');
      return 'Cancellation and Rescheduling. The Provider will accommodate a reschedule ' +
        'with reasonable notice. Because the Total Fee is paid in full upon booking, a ' +
        'cancellation inside seven (7) days of the Event Date may forfeit that amount.';
    }
    // 5.1 Services / 5.4 Client Responsibilities -> plural, so the service
    // description matches the number of stations actually delivered.
    if (text.startsWith('Services.')) {
      substituted.push(`5.1 Services -> ${stations} ${stationNoun}`);
      return `Services. The Provider will deliver ${stations} professional ${stationNoun}, ` +
        'each with its own attendant, lighting, backdrop and digital delivery for the hours ' +
        'booked, at the locations designated by the Client.';
    }
    if (text.startsWith('Client Responsibilities.')) {
      substituted.push(`5.4 Client Responsibilities -> ${stations} ${boothS}`);
      return `Client Responsibilities. The Client will ensure venue access, power, and a ` +
        `defensible location for each ${booth}, and will confirm the Event Date and hours in ` +
        'writing before the Event Date.';
    }
    return text;
  });
  return { terms: out, substituted };
}
const OUT = join(ROOT, '..', 'reviews', 'custom-contracts');
mkdirSync(OUT, { recursive: true });

const C = {
  red: rgb(0.82, 0.18, 0.20), dark: rgb(0.15, 0.15, 0.15),
  gray: rgb(0.50, 0.50, 0.50), lg: rgb(0.92, 0.92, 0.92), gold: rgb(0.85, 0.65, 0.13),
};
const BLANK = '____________________';
const FIELD = (v) => (v === null || v === undefined || v === '' ? BLANK : String(v));

/**
 * Price a multi-station booking off the catalogue, then apply the owner's figure.
 *
 * The discount is NAMED only if the reduction lands exactly on a published
 * school/military figure. Anything else is printed as the owner-authorized
 * reduction with the owner's own words, never as a category nobody chose. That
 * rule is copied from `priceQuoteFromTotal` rather than re-decided here.
 */
function priceMultiStation({ stations, hours, rate, quoted_total_cents }) {
  if (!Number.isInteger(stations) || stations < 1) throw new Error(`stations must be a whole number >= 1; got ${JSON.stringify(stations)}`);
  const per_station = priceQuote(hours, rate);              // the catalogue's own arithmetic
  const hourly_cents = per_station.hourly_cents;
  const subtotal_cents = hourly_cents * hours * stations;
  if (typeof quoted_total_cents !== 'number' || !Number.isInteger(quoted_total_cents) || quoted_total_cents <= 0) {
    throw new Error(`quoted_total_cents must be a positive integer; got ${JSON.stringify(quoted_total_cents)}`);
  }
  if (quoted_total_cents > subtotal_cents) {
    throw new Error(
      `quoted ${formatCents(quoted_total_cents)} is ABOVE the ${formatCents(subtotal_cents)} list ` +
      `price for ${stations} x ${hours}hr ${rate}. That is a surcharge, not a discount.`
    );
  }
  const discount_cents = subtotal_cents - quoted_total_cents;

  // A published column exists per DURATION and is single-station, so it can only
  // be compared against a single-station subtotal. Two stations never match one,
  // and pretending otherwise is how a $245 reduction gets called "School".
  const published = stations === 1 ? PUBLISHED_DISCOUNTED[hours] : undefined;
  const basis_identified = published !== undefined && quoted_total_cents === published;

  return {
    stations, hours, rate,
    hourly_cents,
    hourly_display: formatCents(hourly_cents) + '/hr',
    per_station_cents: per_station.subtotal_cents,
    per_station_display: per_station.subtotal_display,
    subtotal_cents, subtotal_display: formatCents(subtotal_cents),
    total_cents: quoted_total_cents, total_display: formatCents(quoted_total_cents),
    discount_applied: discount_cents > 0,
    discount_cents, discount_display: formatCents(discount_cents),
    discount_label: basis_identified ? 'School / Education' : (discount_cents > 0 ? OWNER_AUTHORIZED_LABEL : null),
    basis_identified,
    requires_basis: discount_cents > 0 && !basis_identified,
    booth_hours: stations * hours,
  };
}

async function render(job) {
  const q = priceMultiStation(job);
  const { terms, substituted } = termsFor(job.pay_in_full === true, q.stations);

  const doc = await PDFDocument.create();
  const h = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = await doc.embedFont(StandardFonts.TimesRoman);
  const tb = await doc.embedFont(StandardFonts.TimesRomanBold);

  const M = 50, W = 512;
  let pg, y = 0;
  const newPage = () => { pg = doc.addPage([612, 950]); y = 880; };
  newPage();

  function TXT(text, o = {}) {
    const { sz = 11, color = C.dark, font = t, indent = 0, after = 0, align = 'left' } = o;
    if (text === null || text === undefined || text === '') return;
    const lead = sz + 5;
    let line = '';
    for (const word of String(text).split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, sz) > W - indent && line) {
        if (y < 55) newPage();
        pg.drawText(line, { x: align === 'right' ? 562 - font.widthOfTextAtSize(line, sz) : M + indent, y, size: sz, font, color });
        y -= lead; line = word;
      } else { line = test; }
    }
    if (line) {
      if (y < 55) newPage();
      pg.drawText(line, { x: align === 'right' ? 562 - font.widthOfTextAtSize(line, sz) : M + indent, y, size: sz, font, color });
      y -= lead;
    }
    if (after) y -= after;
  }
  const HR = (thick = 1) => { if (y < 80) newPage(); pg.drawLine({ start: { x: M, y: y + 6 }, end: { x: 562, y: y + 6 }, thickness: thick, color: C.red }); y -= 18; };
  const SEC = (num, title) => { if (y < 180) newPage(); TXT('', { after: 10 }); TXT(`${num}. ${title}`, { sz: 14, font: h, color: C.red, after: 6 }); HR(1.5); };

  // --- draft banner ---------------------------------------------------------
  // Accurate wording. The catalogue's own banner says "N unconfirmed field(s)",
  // which would be false here: every field below is confirmed. This one is
  // stamped because the owner has not approved it for sending yet.
  if (job.draft !== false) {
    pg.drawRectangle({ x: M, y: y - 26, width: W, height: 26, color: C.gold });
    TXT('DRAFT - NOT FOR SIGNATURE - PENDING OWNER REVIEW', { sz: 10, font: h, indent: 8 });
    y -= 40;
  }

  // --- header ---------------------------------------------------------------
  const logo = join(ASSETS, 'logo.png');
  if (existsSync(logo)) {
    const li = await doc.embedPng(readFileSync(logo));
    pg.drawImage(li, { x: M, y: y - 44, width: 140, height: Math.round(140 / (li.width / li.height)) });
  }
  TXT(`${PROVIDER.business_name.toUpperCase()} CONTRACT`, { sz: 22, font: h, color: C.red, align: 'right', after: 2 });
  TXT(`${q.stations} x ${q.hours}-Hour ${RATES[q.rate].label} Package`, { sz: 14, color: C.gray, align: 'right', after: 1 });
  TXT(
    `${RATES[q.rate].label} - ${q.hourly_display} x ${q.hours}hrs x ${q.stations} stations = ${q.subtotal_display}`,
    { sz: 11, color: C.gray, align: 'right', after: 1 }
  );
  if (q.discount_applied) {
    TXT(`Less ${q.discount_display} - ${q.discount_label} = ${q.total_display}`, { sz: 9, color: C.gold, align: 'right', after: 6 });
  }
  HR(1.5);

  // --- parties --------------------------------------------------------------
  TXT(`THIS AGREEMENT is drafted on ${job.drafted_on}`, { after: 4 });
  TXT('between:', { sz: 11, font: tb, color: C.red, after: 4 });
  y -= 6;
  pg.drawRectangle({ x: M, y: y - 50, width: W, height: 50, color: C.lg });
  TXT(`${PROVIDER.legal_name || PROVIDER.business_name} ("Provider")`, { sz: 11, font: h, indent: 10 }); y += 4;
  TXT(`${PROVIDER.contact_name}, ${PROVIDER.contact_title}`, { sz: 10, indent: 10 }); y += 3;
  TXT(`${PROVIDER.email} | ${PROVIDER.phone} | ${String(PROVIDER.website).replace(/^https?:\/\//, '')}`, { sz: 10, indent: 10, color: C.red }); y += 3;
  TXT(`EIN ${PROVIDER.ein} - ${PROVIDER.insurance}`, { sz: 9, indent: 10, color: C.gray });
  y = y - 50 - 10;

  TXT('and', { after: 4 }); y -= 6;
  pg.drawRectangle({ x: M, y: y - 40, width: W, height: 40, color: C.lg });
  TXT(`${job.client_name} ("Client")`, { sz: 11, font: h, indent: 10 }); y += 4;
  TXT(`Event: ${FIELD(job.event_name)}     Date: ${job.event_weekday}, ${job.event_date_display}`, { sz: 10, indent: 10 });
  y = y - 40 - 14;

  // --- event details --------------------------------------------------------
  SEC('2', 'EVENT DETAILS');
  const rows = [
    ['Event Name:', FIELD(job.event_name)],
    ['Event Date:', `${job.event_weekday}, ${job.event_date_display}`],
    ['Event Location:', FIELD(job.venue_name)],
    ...(job.venue_address ? [['Event Address:', job.venue_address]] : []),
    ...(job.venue_room ? [['Room / Area:', job.venue_room]] : []),
    ['Stations Provided:', `${q.stations} (two) Professional StudioStations`],
    ['Event Window:', FIELD(job.event_window)],
    ['Service Hours:', `${q.hours} hours per station (${q.stations} stations x ${q.hours} hours = ${q.booth_hours} station-hours)`],
    ['Sponsoring Organization:', FIELD(job.sponsoring_org)],
    ['Contact Person:', FIELD(job.contact_name)],
    ['Contact Phone:', FIELD(job.contact_phone)],
    ['Contact Email:', FIELD(job.contact_email)],
    ['Number of Guests Expected:', FIELD(job.guests_expected)],
  ];
  for (const [l, v] of rows) {
    TXT(l, { sz: 11, font: tb, after: 1 });
    TXT(v, { sz: 11, color: C.gray, after: 4 });
  }

  // --- services -------------------------------------------------------------
  SEC('3', 'SERVICES');
  TXT(`Each of the ${q.stations} StudioStations booked for ${q.hours} hours includes:`, { font: tb, after: 4 });
  for (const inc of inclusionsFor(q.rate)) TXT(`   - ${inc}`, { sz: 10, indent: 16, after: 1 });
  TXT('', { after: 4 });
  TXT(
    `Total booked time: ${q.stations} stations x ${q.hours} hours at ${q.hourly_display} = ${q.subtotal_display} ` +
      `(${q.booth_hours} station-hours). Overtime billed at ${q.hourly_display} per station.`,
    { sz: 10, font: tb }
  );
  if (job.staffing_note) TXT(job.staffing_note, { sz: 10, color: C.dark, after: 4 });

  // --- pricing & payment ----------------------------------------------------
  SEC('4', 'PRICING & PAYMENT');
  TXT(
    `Service: ${q.stations} x ${q.hours}-Hour ${RATES[q.rate].label} StudioStation - ` +
      `${q.hourly_display} x ${q.hours}hrs x ${q.stations} stations = ${q.subtotal_display}`,
    { after: 1 }
  );
  if (q.discount_applied) {
    TXT(`List price (${q.stations} stations x ${q.hours} hrs @ ${q.hourly_display}): ${q.subtotal_display}`, { sz: 10, after: 1 });
    TXT(`Discount - ${q.discount_label}: -${q.discount_display}`, { sz: 10, color: C.gold, after: 1 });
    if (job.discount_reason) TXT(`Basis: ${job.discount_reason}`, { sz: 9, color: C.gray, after: 2 });
  }
  TXT(`TOTAL FEE: ${q.total_display}`, { sz: 13, font: h, after: 2 });
  // Payment in full. Written out rather than left to the 50/50 schedule, because
  // the 50% balance date (seven days before the Event) has already passed for a
  // booking taken inside that window, and a contract demanding money on a dead
  // date is a contract that reads as breached on arrival.
  // Clauses 5.2 and 5.3 are rewritten to match by termsFor(), or the document
  // would say "no deposit" here and "50% due upon booking" there.
  if (job.pay_in_full === true) {
    TXT(`TOTAL DUE UPON BOOKING: ${q.total_display} (100% - no deposit)`, { sz: 12, font: h, after: 2 });
    TXT(
      `Payment in full is due upon booking. The Event Date falls within seven (7) days of ` +
        `the date of this Agreement, so no deposit or later balance applies.`,
      { sz: 9, color: C.gray, after: 6 }
    );
  } else {
    const deposit = Math.round(q.total_cents * 50) / 100;
    TXT(`Deposit Due (50%): ${formatCents(deposit)} upon booking`, { sz: 12, font: h, after: 2 });
    TXT(`Balance Due: ${formatCents(q.total_cents - deposit)} seven (7) days before the Event Date`, { after: 6 });
  }

  // --- terms ----------------------------------------------------------------
  SEC('5', 'TERMS & CONDITIONS');
  terms.forEach((body, i) => {
    const [heading, ...rest] = body.split('. ');
    TXT(`5.${i + 1} ${heading}.`, { sz: 10, font: tb, after: 1 });
    TXT(`     ${rest.join('. ')}`, { sz: 10, indent: 8, after: 4 });
  });
  TXT(`5.${terms.length + 1} Governing Law. This agreement is governed by the laws of ${PROVIDER.governing_law}.`, { sz: 10, font: tb, after: 1 });

  // --- signatures -----------------------------------------------------------
  if (y < 220) newPage();
  SEC('6', 'SIGNATURES');
  const sbt = y;
  pg.drawRectangle({ x: M, y: y - 85, width: W, height: 85, color: C.lg });
  const sig = join(ASSETS, 'signature.png');
  if (existsSync(sig)) {
    const si = await doc.embedPng(readFileSync(sig));
    const hh = Math.round(130 / (si.width / si.height));
    pg.drawImage(si, { x: M + 14, y: sbt - 14 - hh, width: 130, height: hh });
    y = sbt - 14 - hh - 4;
  }
  TXT(`${PROVIDER.contact_name} - ${PROVIDER.contact_title}, ${PROVIDER.legal_name || PROVIDER.business_name}`, { sz: 11, font: tb, indent: 10 }); y += 4;
  TXT(`Date: ${BLANK}`, { sz: 10, indent: 10 });
  y = sbt - 85 - 16;
  pg.drawRectangle({ x: M, y: y - 55, width: W, height: 55, color: C.lg });
  TXT(`Client Signature: ${BLANK}`, { sz: 11, indent: 10 }); y += 4;
  TXT(`Printed Name: ${job.client_name}`, { sz: 10, indent: 10 }); y += 3;
  TXT(`Date: ${BLANK}`, { sz: 10, indent: 10 });
  y = y - 55 - 14;

  HR(1);
  TXT([PROVIDER.business_name, PROVIDER.email, PROVIDER.phone, PROVIDER.website].join(' - '), { sz: 8, color: C.gray, after: 1 });
  TXT(
    `${q.stations} x ${q.hours}hr ${RATES[q.rate].label} - ${q.booth_hours} station-hours - ${q.total_display} total` +
      `${job.draft !== false ? ' - DRAFT, NOT FOR SIGNATURE' : ''}`,
    { sz: 7, color: C.gray }
  );

  const bytes = await doc.save();
  const path = join(OUT, job.out);
  writeFileSync(path, bytes);
  const probe = await PDFDocument.load(bytes);
  return { path, quote: q, page_count: probe.getPageCount(), bytes: bytes.length, substituted };
}

// ── Joseph Petrucelli — West Potomac High School Homecoming, Sat Oct 10 2026 ──
// FINAL: owner reviewed the draft and approved. draft:false removes the
// "DRAFT - NOT FOR SIGNATURE" banner and the draft suffix on the footer line.
// Every field below was supplied by the owner; nothing here is a guess.
const joseph = await render({
  out: 'PFP-Contract-Joseph-Petrucelli-West-Potomac-Homecoming-Oct10-2026.pdf',
  stations: 2, hours: 3, rate: 'standard',
  quoted_total_cents: 124900,
  discount_reason: 'Joe authorized a discount - 2 booths necessary for the crowd.',
  client_name: 'Joseph Petrucelli',
  sponsoring_org: 'West Potomac High School (Fairfax County Public Schools)',
  event_name: 'West Potomac High School Homecoming Dance',
  venue_name: 'West Potomac High School',
  venue_address: '6500 Quander Road, Alexandria, VA 22307',
  venue_room: '',
  event_window: '7:00 PM - 10:00 PM',
  contact_name: 'Joseph Petrucelli',
  contact_phone: '', contact_email: 'jrpetrucelli@fpcs.edu',
  guests_expected: '',
  staffing_note: 'Each StudioStation is operated by its own dedicated professional attendant for all booked hours.',
  event_date_display: 'October 10, 2026',
  event_weekday: 'Saturday',
  drafted_on: 'October 5, 2026',
  pay_in_full: true,
  draft: false,
});

const q = joseph.quote;
console.log('JOSEPH PETRUCELLI — West Potomac High School Homecoming Dance');
console.log('  file       :', joseph.path.split(/[\\/]/).pop());
console.log('  pages      :', joseph.page_count, '|', (joseph.bytes / 1024).toFixed(0) + 'KB');
console.log(`  stations   : ${q.stations} x ${q.hours}hr @ ${q.hourly_display}`);
console.log(`  per station: ${q.per_station_display} (catalogue priceQuote(${q.hours}, '${q.rate}'))`);
console.log(`  list price : ${q.subtotal_display}  (${q.stations} x ${q.per_station_display})`);
console.log(`  discount   : -${q.discount_display}  [${q.discount_label}]`);
console.log(`  TOTAL      : ${q.total_display}   due in full upon booking`);
console.log(`  station-hrs: ${q.booth_hours}`);
console.log('');
console.log('Terms clauses substituted for pay-in-full / multi-station:');
for (const s of joseph.substituted) console.log('  - ' + s);
console.log('');
console.log(joseph.quote && joseph.path.endsWith('-DRAFT.pdf')
  ? 'DRAFT build - not for signature.'
  : 'FINAL build - DRAFT banner removed.');
console.log('NOT SENT. NOT UPLOADED. This script writes a file and nothing else;');
console.log('delivering it to the client is a separate, deliberate step.');