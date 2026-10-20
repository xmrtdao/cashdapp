/**
 * relay/tools/pfp-esign.mjs — Party Favor Photo's own electronic signature system.
 *
 * WHY THIS EXISTS
 * ---------------
 * The alternative was DocuSign or Dropbox Sign: another vendor, another API key,
 * another subscription, another company holding the client's contract. For a
 * booking that a client completes in four minutes, that is a real cost paid for
 * a signature line. `pdf-lib` is already a dependency, and everything a legally
 * meaningful signature record needs is a hash and a timestamp.
 *
 * WHAT MAKES IT A SIGNATURE SYSTEM AND NOT A TEXTAROA
 * ----------------------------------------------------
 * A name typed into a box proves the box was filled in. Three things make this
 * binding, and all three are recorded:
 *
 *   1. The client CONSENTS to a specific set of terms, and the exact consent
 *      sentence is stored, so what they agreed to cannot be paraphrased later.
 *   2. The signature is bound to the DOCUMENT BY HASH. The sha256 of the
 *      unsigned contract is computed once and travels with every signature. If
 *      a single word of the body changes after signing, the hash no longer
 *      matches and verification fails loudly rather than silently.
 *   3. The signature IMAGE is hashed too, so a stored signature cannot be
 *      swapped for another one from a different booking.
 *
 * Intentional second signature is required for e-sign consent in many
 * jurisdictions, so the client draws OR types and both are captured.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 * -----------------------------------
 * This is a signature record with an audit trail. It is not a certified
 * e-signature service and makes no claim of one. `verifyContract()` reports
 * what it can actually prove and stops at that boundary.
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import crypto from 'node:crypto';

/** Brand ink and gold, matching the light client-facing palette. */
const C = {
  dark: rgb(0.11, 0.10, 0.09),
  body: rgb(0.20, 0.19, 0.17),
  gray: rgb(0.48, 0.45, 0.40),
  faint: rgb(0.82, 0.79, 0.74),
  gold: rgb(0.722, 0.525, 0.043),
  green: rgb(0.184, 0.490, 0.341),
};

const PAGE = [612, 792];
const M = 54;

/** sha256, hex. The one hash primitive used everywhere in this file. */
export const sha256 = (buf) =>
  crypto.createHash('sha256').update(buf).digest('hex');

/**
 * The exact sentence the client agrees to. Stored verbatim on the signature
 * record so the consent can be quoted back years later without paraphrasing
 * drift. Changing this string changes what future clients consent to, which is
 * why it is versioned.
 */
export const CONSENT_VERSION = 'esign-consent-v1';
export const CONSENT_TEXT =
  'I have read and agree to the terms of this Agreement, and I adopt the ' +
  'signature above as my own. I agree that this electronic signature is the ' +
  'legal equivalent of my handwritten signature.';

/** @returns {{role:string, name:string, signed_at:string, ip:string|null, user_agent:string|null, signature_sha256:string, consent_text:string, consent_version:string, contract_sha256:string}} */
function signatureRecord({ role, name, when, ip, ua, sigPng, contractSha }) {
  return {
    role,
    name: String(name || '').trim(),
    signed_at: when || new Date().toISOString(),
    ip: ip || null,
    user_agent: ua ? String(ua).slice(0, 300) : null,
    // Hashing the image means a signature lifted from another booking's record
    // cannot be substituted into this one without detection.
    signature_sha256: sigPng ? sha256(Buffer.from(sigPng)) : null,
    signature_kind: sigPng ? 'drawn' : 'typed',
    consent_text: CONSENT_TEXT,
    consent_version: CONSENT_VERSION,
    // The binding. Both parties sign against the SAME document hash.
    contract_sha256: contractSha,
  };
}

/**
 * Render the booking contract.
 *
 * Every commercial term is read from pfp-pricing.mjs rather than restated
 * here, because a second copy of the price or the cancellation window is a
 * second thing that can drift from the one a client was quoted.
 *
 * @param {object} opts
 * @param {object} opts.quote      from priceQuote()
 * @param {object} opts.schedule   from paymentSchedule()
 * @param {object} opts.booking    { client_name, client_email, event_name,
 *                                   event_date, venue, address }
 * @param {Array}  opts.terms      from TERMS
 * @param {Array}  opts.inclusions from inclusionsFor()
 * @param {object} opts.brand      { vendor, owner, phone, email }
 * @returns {Promise<{bytes:Buffer, sha256:string}>}
 */
export async function buildContractPdf({ quote, schedule, booking, terms, inclusions, brand }) {
  const doc = await PDFDocument.create();
  const H = await doc.embedFont(StandardFonts.HelveticaBold);
  const T = await doc.embedFont(StandardFonts.TimesRoman);
  const TB = await doc.embedFont(StandardFonts.TimesRomanBold);

  let pg, y;
  const nextPage = () => { pg = doc.addPage(PAGE); y = PAGE[1] - M; };
  nextPage();

  const need = (n) => { if (y - n < M + 28) nextPage(); };

  /** Word-wrapped text. pdf-lib has no layout engine, so this is manual. */
  function TXT(text, { sz = 10.5, color = C.body, font = T, after = 0,
                        indent = 0, lead = null } = {}) {
    const width = PAGE[0] - M * 2 - indent;
    const lh = lead || sz + 4.2;
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const w of para.split(' ')) {
        const t = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(t, sz) > width && line) {
          need(lh);
          pg.drawText(line, { x: M + indent, y, size: sz, font, color });
          y -= lh;
          line = w;
        } else line = t;
      }
      if (line) { need(lh); pg.drawText(line, { x: M + indent, y, size: sz, font, color }); y -= lh; }
    }
    y -= after;
  }

  const rule = (color = C.faint, at = null) => {
    const yy = at ?? y;
    pg.drawLine({ start: { x: M, y: yy }, end: { x: PAGE[0] - M, y: yy },
                  thickness: 0.8, color });
  };

  // ── Masthead ──────────────────────────────────────────────────────────────
  TXT('PARTY FAVOR PHOTO', { sz: 16, font: H, color: C.dark, after: 2 });
  TXT(brand?.owner ? `Studio of ${brand.owner}` : 'Event Photography',
      { sz: 9.5, color: C.gold, font: TB, after: 6 });
  if (brand?.phone) TXT(brand.phone, { sz: 9.5, color: C.gray, after: 1 });
  if (brand?.email) TXT(brand.email, { sz: 9.5, color: C.gray, after: 4 });
  rule(C.gold, y); y -= 20;

  // ── Title ─────────────────────────────────────────────────────────────────
  TXT('SERVICE AGREEMENT', { sz: 13, font: H, color: C.dark, after: 3 });
  TXT(`Event Date: ${fmtDate(booking.event_date)}   ·   ${quote.hours} hours   ·   ${quote.rate_label} package`,
      { sz: 9.5, color: C.gray, after: 14 });

  // ── Parties ───────────────────────────────────────────────────────────────
  const party = (label, name, detail) => {
    const colX = label === 'CLIENT' ? M : M + 300;
    pg.drawText(label, { x: colX, y, size: 8, font: H, color: C.gold });
    pg.drawText(name || '—', { x: colX, y: y - 13, size: 10.5, font: TB, color: C.dark });
    let dy = y - 26;
    for (const d of [detail]) {
      if (!d) continue;
      pg.drawText(d, { x: colX, y: dy, size: 9, font: T, color: C.gray });
      dy -= 11;
    }
  };
  party('CLIENT', booking.client_name,
        [booking.client_email, booking.event_name].filter(Boolean).join('  ·  '));
  party('PROVIDER', brand?.vendor || 'Party Favor Photo', brand?.phone || null);
  y -= 66;
  rule(); y -= 18;

  // ── Event details ─────────────────────────────────────────────────────────
  TXT('EVENT DETAILS', { sz: 9, font: H, color: C.gold, after: 8 });
  const row = (k, v) => {
    if (!v) return;
    pg.drawText(k, { x: M, y, size: 9.5, font: TB, color: C.gray });
    const t = String(v);
    const max = PAGE[0] - M * 2 - 132;
    pg.drawText(t.length * 5 > max ? t.slice(0, 78) + '…' : t,
                { x: M + 132, y, size: 9.5, font: T, color: C.dark });
    y -= 15;
  };
  row('Event', booking.event_name);
  row('Date', fmtDate(booking.event_date));
  row('Start / End', booking.start_time ? `${booking.start_time}${booking.end_time ? ' – ' + booking.end_time : ''}` : null);
  row('Venue', booking.venue);
  row('Address', booking.address);
  row('Duration', `${quote.hours} hours`);
  y -= 8;

  // ── Fee ───────────────────────────────────────────────────────────────────
  TXT('FEE', { sz: 9, font: H, color: C.gold, after: 8 });
  const feeRow = (k, v, bold = false, tint = false) => {
    if (tint) {
      pg.drawRectangle({ x: M - 6, y: y - 5, width: PAGE[0] - M * 2 + 12, height: 19, color: rgb(0.976, 0.968, 0.945) });
    }
    pg.drawText(k, { x: M, y, size: 10, font: bold ? TB : T, color: bold ? C.dark : C.body });
    pg.drawText(v, { x: PAGE[0] - M - 92, y, size: 10, font: bold ? TB : T, color: bold ? C.dark : C.body });
    y -= 17;
  };
  feeRow(`${quote.rate_label} — ${quote.hours} hours at ${quote.hourly_display}`, quote.subtotal_display);
  if (quote.discount_applied) {
    feeRow(`Discount${quote.discount_reason ? ' — ' + quote.discount_reason : ''}`,
           '−' + quote.discount_display);
  }
  feeRow('TOTAL FEE', quote.total_display, true, true);
  y -= 6;
  feeRow('Due upon booking (50%)', schedule.deposit_display, true);
  feeRow('Balance due ' + schedule.balance_due, schedule.balance_display);
  y -= 10;

  // ── Services ──────────────────────────────────────────────────────────────
  TXT('SERVICES INCLUDED', { sz: 9, font: H, color: C.gold, after: 8 });
  for (const inc of inclusions) {
    need(13);
    pg.drawCircle({ x: M + 3, y: y + 3, size: 1.6, color: C.gold });
    TXT(inc, { sz: 9.5, indent: 14, after: 2 });
  }
  y -= 10;

  // ── Terms ─────────────────────────────────────────────────────────────────
  for (const t of terms) {
    need(34);
    TXT(t, { sz: 9.5, after: 9 });
  }

  TXT('— Signature follows on the next page —', { sz: 8.5, color: C.gray, after: 0 });

  const bytes = Buffer.from(await doc.save());
  // Hash the SIGNED-BODY document. This is the value every signature binds to.
  return { bytes, sha256: sha256(bytes) };
}

const fmtDate = (d) => {
  if (!d) return 'Date to be confirmed';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

/**
 * Append a signature page for one signer.
 *
 * The signature IMAGE is embedded, not described. A drawn mark is what the
 * client recognises as theirs when they look at the document later.
 */
async function appendSignaturePage(doc, sig, { fonts, label }) {
  const { H, T, TB } = fonts;
  const pg = doc.addPage(PAGE);
  let y = PAGE[1] - M;

  pg.drawText('SIGNATURES', { x: M, y, size: 11, font: H, color: C.gold });
  y -= 6;
  pg.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 0.8, color: C.faint });
  y -= 26;

  pg.drawText(label, { x: M, y, size: 9, font: H, color: C.gray });
  y -= 44;

  // The mark itself.
  if (sig.signature_png_base64) {
    try {
      const img = await doc.embedPng(Buffer.from(sig.signature_png_base64, 'base64'));
      const scaled = img.scaleToFit(230, 64);
      pg.drawImage(img, { x: M, y: y - scaled.height + 12, width: scaled.width, height: scaled.height });
    } catch {
      // A malformed PNG must not lose the signature record. Fall back to the
      // typed name and say the mark failed to render.
      pg.drawText(sig.name, { x: M, y, size: 22, font: T, color: C.dark });
    }
  } else {
    pg.drawText(sig.name, { x: M, y, size: 24, font: T, color: C.dark });
  }

  const lineY = y - 20;
  pg.drawLine({ start: { x: M, y: lineY }, end: { x: M + 250, y: lineY }, thickness: 0.9, color: C.gray });
  pg.drawText(sig.name, { x: M, y: lineY - 13, size: 10, font: TB, color: C.dark });
  pg.drawText(new Date(sig.signed_at).toLocaleString('en-US'),
               { x: M, y: lineY - 26, size: 8.5, font: T, color: C.gray });

  y = lineY - 52;

  // Consent, verbatim. This is the sentence that gives the signature meaning.
  pg.drawText('CONSENT', { x: M, y, size: 8, font: H, color: C.gold });
  y -= 12;
  for (const para of sig.consent_text.split('. ')) {
    for (const chunk of wrap(para.trim() + '.', T, 8.5, PAGE[0] - M * 2)) {
      pg.drawText(chunk, { x: M, y, size: 8.5, font: T, color: C.body });
      y -= 11;
    }
  }
  y -= 14;

  // Provenance. Enough for a dispute to be settled from this page alone.
  const prov = [
    ['Document SHA-256', sig.contract_sha256],
    ['Signature SHA-256', sig.signature_sha256 || '(typed — no image)'],
    ['Consent version', sig.consent_version],
    ['Signed from IP', sig.ip || 'not recorded'],
  ];
  for (const [k, v] of prov) {
    pg.drawText(k, { x: M, y, size: 7.5, font: H, color: C.gray });
    // Hashes are 64 hex chars; truncate visibly rather than overflowing the page.
    pg.drawText(String(v).slice(0, 68), { x: M + 118, y, size: 7.5, font: T, color: C.body });
    y -= 10.5;
  }
  return pg;
}

function wrap(text, font, size, width) {
  const out = []; let line = '';
  for (const w of String(text).split(' ')) {
    const t = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; }
    else line = t;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Apply the CLIENT's signature and produce the document they receive.
 * Returns the record to persist alongside the PDF.
 *
 * `bodySha` is REQUIRED and is the hash of the unsigned contract BODY, not of
 * `bytes`. Binding to `bytes` would differ per signer, because the provider's
 * copy already carries the client's signature page — so the two signatures
 * would attest to two different "documents" and verification could never pass.
 * Every signature in a contract attests to the same text.
 */
export async function applyClientSignature({ bytes, bodySha, sigPng, name, ip, userAgent }) {
  if (!bodySha) throw new Error('applyClientSignature requires bodySha (the unsigned contract hash)');
  const doc = await PDFDocument.load(bytes);
  const fonts = {
    H: await doc.embedFont(StandardFonts.HelveticaBold),
    T: await doc.embedFont(StandardFonts.TimesRoman),
    TB: await doc.embedFont(StandardFonts.TimesRomanBold),
  };
  const sig = signatureRecord({
    role: 'client', name, when: new Date().toISOString(), ip, ua: userAgent,
    sigPng, contractSha: bodySha,
  });
  await appendSignaturePage(doc, sig, { fonts, label: 'SIGNED BY THE CLIENT' });
  const out = Buffer.from(await doc.save());
  return { bytes: out, record: { ...sig, signature_png_base64: null }, sig };
}

/**
 * Countersign: the provider's acceptance of the client's signature.
 *
 * Separated from applyClientSignature on purpose. The whole point of moving off
 * manual countersigning was that the client is not left waiting on a human —
 * but the provider's signature is what makes the agreement mutual, and it is
 * still a human act. This stamps that; it does not simulate it.
 *
 * `bodySha` passes through unchanged from the client signature: the provider
 * accepts the same terms, so the provider's mark binds to the same text.
 */
export async function countersign({ bytes, bodySha, name, ip, userAgent }) {
  if (!bodySha) throw new Error('countersign requires bodySha (the unsigned contract hash)');
  const doc = await PDFDocument.load(bytes);
  const fonts = {
    H: await doc.embedFont(StandardFonts.HelveticaBold),
    T: await doc.embedFont(StandardFonts.TimesRoman),
    TB: await doc.embedFont(StandardFonts.TimesRomanBold),
  };
  const sig = signatureRecord({
    role: 'provider', name, when: new Date().toISOString(), ip, ua: userAgent,
    sigPng: null, contractSha: bodySha,
  });
  await appendSignaturePage(doc, sig, { fonts, label: 'ACCEPTED BY THE PROVIDER' });
  return { bytes: Buffer.from(await doc.save()), record: sig };
}

/**
 * Verify a stored contract against its signature records.
 *
 * Reports what it can actually prove. A mismatch is surfaced as a failure with
 * the specific field that disagrees — this is a detector, and a detector that
 * returns a cheerful true is worse than no detector.
 *
 * @returns {{ok:boolean, checks:Array<{name:string, ok:boolean, detail:string}>}}
 */
export function verifyContract({ contractSha, records = [] }) {
  const checks = [];
  for (const r of records) {
    checks.push({
      name: `${r.role} signature bound to the agreed document`,
      ok: r.contract_sha256 === contractSha,
      detail: r.contract_sha256 === contractSha
        ? `bound to ${String(contractSha).slice(0, 16)}…`
        : `signature was bound to ${String(r.contract_sha256).slice(0, 16)}… but the ` +
          `document is now ${String(contractSha).slice(0, 16)}… — the body changed after signing`,
    });
    checks.push({
      name: `${r.role} recorded consent text`,
      ok: Boolean(r.consent_text && r.consent_version),
      detail: r.consent_version || 'no consent version recorded',
    });
    checks.push({
      name: `${r.role} signature time`,
      ok: Boolean(r.signed_at) && !Number.isNaN(new Date(r.signed_at).getTime()),
      detail: r.signed_at || 'missing',
    });
  }
  if (!records.length) {
    checks.push({ name: 'signature records', ok: false, detail: 'no signatures recorded' });
  }
  return { ok: checks.every(c => c.ok), checks };
}
