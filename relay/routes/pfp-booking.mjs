/**
 * relay/routes/pfp-booking.mjs — the client-facing booking funnel.
 *
 * Serves book.partyfavorphoto.com. The journey, in the order a client walks it:
 *
 *     1. GET  /config              what it costs, and on what terms
 *     2. GET  /availability        which dates still have a kit free
 *     3. POST /reserve             claim a kit, build THEIR contract
 *     4. POST /sign                they sign it, here, with consent
 *     5. POST /pay                 embedded Stripe Payment Element, deposit only
 *     6. POST /stripe/webhook      Stripe confirms; the date is now booked
 *     7. GET  /confirmation/:token receipt + countersigned contract + studio
 *
 * WHY INVENTORY, NOT COUNTERSIGNING
 * --------------------------------
 * Countersigning existed to stop two clients being booked for one date. It also
 * meant nobody was paid until Joe signed, so a client who had handed over money
 * waited on a human with no way to tell whether the booking was real. Four kits
 * with a nightly capacity moves that brake into the database, where it cannot be
 * forgotten: `app.reserve_pfp_kit` is atomic and `app.pfp_bookings` cannot be
 * paid for a date the database says is full. The provider still countersigns the
 * contract — that signature is what makes the agreement mutual, and it is
 * Joe's to give, not a database's.
 *
 * WHAT IS NEVER INVENTED
 * ----------------------
 * Every commercial term is read from pfp-pricing.mjs rather than restated here.
 * A second copy of the price or the cancellation window is a second thing that
 * can drift from the one the client was shown. Event details are stored exactly
 * as typed; nothing is inferred, defaulted or promoted between fields.
 */
import express from 'express';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  priceQuote, paymentSchedule, priceCard, inclusionsFor, TERMS,
  RATES, DURATIONS, MIN_HOURS, MAX_HOURS, PAYMENT_TERMS, openPricingGaps,
} from '../lib/pfp-pricing.mjs';
import {
  buildContractPdf, applyClientSignature, countersign, verifyContract, CONSENT_TEXT, CONSENT_VERSION,
} from '../tools/pfp-esign.mjs';
import { query as pg } from '../lib/localDb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dirname, '..');
const DOCS = path.join(RELAY, '..', '_pfp_booking', 'contracts');
await fs.mkdir(DOCS, { recursive: true });

/** Owner details printed on every contract. Read from the data file, not typed in. */
const BRAND = await (async () => {
  try {
    const p = path.join(RELAY, '..', 'partyfavorphoto', 'data', 'pfp-data.json');
    const d = JSON.parse(await fs.readFile(p, 'utf8'));
    return {
      vendor: d.businessName || 'Party Favor Photo',
      owner: d.ownerName || 'Joe Lee',
      phone: d.phone || '(202) 798-0610',
      email: d.email || null,
    };
  } catch { return { vendor: 'Party Favor Photo', owner: 'Joe Lee', phone: '(202) 798-0610' }; }
})();

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

/** How long a claimed date stays held while the client reads and signs. */
const HOLD_MINUTES = 60;

/** Stripe is loaded lazily so a missing key degrades one step, not the whole site. */
let StripeCtor = null;
async function stripeClient() {
  if (!STRIPE_SECRET) throw httpError(503, 'Payments are not configured on this server.');
  if (!StripeCtor) {
    const mod = await import('stripe');
    StripeCtor = mod.default;
  }
  return new StripeCtor(STRIPE_SECRET);
}

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

const token = () => crypto.randomBytes(24).toString('base64url');

/**
 * Price a booking, turning a pricing-engine refusal into a 422.
 *
 * priceQuote throws a plain Error with wording written for a developer. Left
 * alone that surfaces as a 500, which tells a client the server broke when in
 * fact they asked for nine hours. The engine's message is genuinely good — it
 * says what was received and what is allowed — so it is passed through
 * verbatim rather than replaced with something vaguer.
 */
function priceOr422(fn) {
  try {
    return fn();
  } catch (e) {
    throw httpError(422, e.message);
  }
}

/** Strip and bound a free-text field the client typed. */
const clean = (v, max = 300) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null;

/** Validate a YYYY-MM-DD date and reject impossible calendar days. */
function isoDate(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(422, `date must be YYYY-MM-DD; got "${v}"`);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw httpError(422, `"${s}" is not a real calendar date`);
  }
  return s;
}

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Config: the rate card and the terms, straight from the pricing engine.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', (_req, res) => {
  res.json({
    rates: priceCard(),
    durations: DURATIONS,
    min_hours: MIN_HOURS,
    max_hours: MAX_HOURS,
    print_formats: Object.fromEntries(Object.entries(RATES).map(([k, v]) => [k, v.print_format])),
    payment_terms: PAYMENT_TERMS,
    terms: TERMS,
    inclusions: { standard: inclusionsFor('standard'), premium: inclusionsFor('premium') },
    brand: BRAND,
    consent: { text: CONSENT_TEXT, version: CONSENT_VERSION },
    hold_minutes: HOLD_MINUTES,
    // Surfaced, not hidden: these are unresolved disagreements in the business's
    // own paperwork and a booking is a contract, so the caller may see them.
    open_pricing_gaps: openPricingGaps(),
    hold_max: 4,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Availability. One query for the whole window; the UI never guesses.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/availability', async (req, res, next) => {
  try {
    const from = isoDate(req.query.from || new Date().toISOString().slice(0, 10));
    const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 120);
    // `days` counts DATES, not the gap between them. `from + days` would give
    // days+1 entries and quietly return one more day than asked for.
    const to = isoDate(new Date(Date.parse(from + 'T00:00:00Z') + (days - 1) * 864e5)
      .toISOString().slice(0, 10));

    // Group by the GENERATED date, not by a.booking_date. A date with no
    // availability rows yet joins to NULL through the LEFT JOIN, so grouping by
    // the joined column collapses every empty date in the window into one NULL
    // group — the calendar comes back empty and the whole funnel is dead.
    const rows = await pg(
      `SELECT d.booking_date::date      AS booking_date,
              count(*)                  AS kits,
              count(*) FILTER (WHERE COALESCE(a.booked_count,0) + COALESCE(a.held_count,0) < k.capacity)
                                   AS open_kits,
              coalesce(sum(COALESCE(a.booked_count,0) + COALESCE(a.held_count,0)), 0) AS claimed,
              coalesce(sum(k.capacity), 0) AS capacity
         FROM generate_series($1::date, $2::date, '1 day') d(booking_date)
         CROSS JOIN app.pfp_kits k
         LEFT JOIN app.pfp_availability a
                ON a.kit_id = k.id AND a.booking_date = d.booking_date
        WHERE k.active
     GROUP BY d.booking_date
     ORDER BY 1`,
      [from, to]
    );
    const asIso = (v) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const byDate = new Map(rows.map(r => [asIso(r.booking_date), r]));
    const capacity = Number(rows[0]?.capacity ?? 0);
    const out = [];
    for (let d = from; d <= to; d = asIso(new Date(Date.parse(d + 'T00:00:00Z') + 864e5))) {
      const r = byDate.get(d);
      const cap = r ? Number(r.capacity) : capacity;
      const open = r ? Number(r.open_kits) : cap;
      out.push({
        date: d,
        capacity: cap,
        claimed: r ? Number(r.claimed) : 0,
        available: open,
        state: open <= 0 ? 'full' : open < cap ? 'limited' : 'open',
      });
    }
    res.json({ from, to, days: out });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reserve: claim a kit and build the contract for THIS booking.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reserve', async (req, res, next) => {
  try {
    const b = req.body || {};
    const event_date = isoDate(b.event_date);

    // Reject a date in the past before touching inventory.
    const today = new Date().toISOString().slice(0, 10);
    if (event_date < today) throw httpError(422, `${event_date} has already passed. Choose a future date.`);

    // Hours and rate go through the pricing engine, which is strict about type:
    // a string "3" is refused rather than coerced, because hours become money.
    const hours = typeof b.hours === 'number' ? b.hours
      : (typeof b.hours === 'string' && /^\d+$/.test(b.hours.trim()) ? Number(b.hours.trim()) : b.hours);
    const rate_id = clean(b.rate_id, 20) || 'standard';
    const quote = priceOr422(() => priceQuote(hours, rate_id, {
      discount: b.discount || undefined,
      discount_reason: b.discount_reason || undefined,
    }));
    const schedule = priceOr422(() => paymentSchedule(quote.total_cents));

    const client = {
      name: clean(b.client_name, 120),
      email: clean(b.client_email, 200),
      phone: clean(b.client_phone, 40),
    };
    if (!client.name) throw httpError(422, 'A name is required — the contract is signed by a person.');
    if (!client.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(client.email)) {
      throw httpError(422, 'A valid email is required — the receipt and countersigned contract go there.');
    }

    const event = {
      name: clean(b.event_name, 160),
      event_location: clean(b.event_location, 160),
      address: clean(b.address, 240),
      start_time: clean(b.start_time, 20),
      end_time: clean(b.end_time, 20),
    };
    if (!event.name) {
      throw httpError(422,
        'An event name is required (e.g. "Jaffee–Knapp Wedding"). ' +
        'It is not guessed from the date or from your name.');
    }

    // The brake. Zero rows returned means every kit is taken for that date.
    const held = await pg(
      'SELECT kit_id, kit_name, avail FROM app.reserve_pfp_kit($1, 1, $2)', [event_date, HOLD_MINUTES]);
    if (!held.length) {
      throw httpError(409,
        `${event_date} is fully booked — all four kits are committed. ` +
        `Pick another date, or call (202) 798-0610 and we will find you a slot.`, { full: true });
    }
    const kitId = held[0].kit_id;

    // Everything past this point can fail — a PDF that will not render, a column
    // that moved, a disk that is full. The kit is ALREADY claimed at that
    // moment, so any failure has to hand it straight back. Otherwise a client
    // who hits an error burns a kit invisibly, and after four such errors the
    // date is unsellable with nothing on screen to explain why.
    //
    // This was not hypothetical: an earlier run of the journey test left three
    // kits held on a date with no booking row behind them, because the INSERT
    // failed after reserve_pfp_kit had already committed.
    try {
      const body = await finishReserve({
        event_date, quote, schedule, kitId, rate_id,
        kitName: held[0].kit_name, kitRemaining: held[0].avail, client, event,
      });
      res.json(body);
      return;
    } catch (err) {
      try {
        await pg('SELECT app.commit_pfp_kit($1, $2, false)', [kitId, event_date]);
      } catch (releaseErr) {
        // A leaked hold is invisible until the date is full, so an operator has
        // to hear about a failed release rather than discover it later from a
        // client who cannot book.
        console.error('[pfp-book] FAILED TO RELEASE HOLD after a failed reserve', {
          kitId, event_date, original: err.message, release: releaseErr.message,
        });
      }
      throw err;
    }
  } catch (e) { next(e); }
});

/**
 * The second half of /reserve, once the kit is claimed.
 *
 * Split out so the caller can wrap it in the hold-release guard above.
 */
async function finishReserve({ event_date, quote, schedule, kitId, rate_id,
                              kitName, kitRemaining, client, event }) {
    const t = token();
    const draft = {
      client_name: client.name, client_email: client.email,
      event_name: event.name, event_date,
      start_time: event.start_time, end_time: event.end_time,
      venue: event.event_location, address: event.address,
    };
    const { bytes, sha256: bodySha } = await buildContractPdf({
      quote, schedule, booking: draft, terms: TERMS,
      inclusions: inclusionsFor(rate_id), brand: BRAND,
    });
    await fs.writeFile(path.join(DOCS, `${t}-contract.pdf`), bytes);

    const rows = await pg(
      `INSERT INTO app.pfp_bookings
         (booking_token, kit_id, client_name, client_email, client_phone,
          event_name, event_date, event_location, address, start_time, end_time,
          duration_hours, rate_id, total_price, amount_total, amount_deposit,
          package_id, payment_status, status, funnel_stage, source,
          contract_sha256, hold_expires_at, studio_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,
               'unpaid','held','contracted','web',$17,
               now() + make_interval(mins => $18), $19, NULL)
       RETURNING id, booking_token, created_at`,
      [t, kitId, client.name, client.email, client.phone,
       event.name, event_date, event.event_location, event.address, event.start_time, event.end_time,
       quote.hours, rate_id, (quote.total_cents / 100).toFixed(2),
       (schedule.deposit_cents / 100).toFixed(2), null,
       bodySha, HOLD_MINUTES, `https://prints.partyfavorphoto.com/${t}`]
    );
    const booking = rows[0];

    // "Remaining" means the DATE's remaining kits, not the one you were handed.
    // The per-kit figure is always 0 — you just took its only slot — which
    // tells a client nothing. What they are deciding is whether to pick another
    // date, and that depends on whether any kit is still free that night.
    // Each column is coalesced individually, NOT the sum. A kit with no
    // availability row yet joins to NULL, and `k.capacity - NULL - NULL` is
    // NULL, so sum() over [0, NULL, NULL, NULL] is NULL and an outer coalesce
    // reports 0 free on a date with four kits and one hold. Same LEFT JOIN trap
    // as the availability endpoint, failing in the other direction.
    const after = await pg(
      `SELECT coalesce(sum(k.capacity
                           - coalesce(a.booked_count, 0)
                           - coalesce(a.held_count, 0)), 0)::int AS free
         FROM app.pfp_kits k
         LEFT JOIN app.pfp_availability a
                ON a.kit_id = k.id AND a.booking_date = $1
        WHERE k.active`, [event_date]);

    // Returned rather than sent: the caller owns the response so that a throw
    // anywhere in here still passes through the hold-release guard.
    return {
      token: t,
      booking_id: booking.id,
      quote, schedule,
      kit: { name: kitName, remaining_that_night: after[0]?.free ?? 0 },
      contract: { url: `/api/pfp-book/file/${t}/contract`, sha256: bodySha },
      hold_expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(),
      consent: { text: CONSENT_TEXT, version: CONSENT_VERSION },
      next: 'Read the contract, then sign to continue to payment.',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sign. Consent is required and recorded verbatim — not assumed by the click.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sign', async (req, res, next) => {
  try {
    const b = req.body || {};
    const t = clean(b.token, 64);
    if (!t) throw httpError(422, 'token is required');
    const name = clean(b.name, 120);
    if (!name) throw httpError(422, 'Type your full legal name to sign.');
    if (b.consent !== true && b.consent_text !== CONSENT_TEXT) {
      throw httpError(422,
        'The consent box must be ticked. Signing without agreeing to the terms is not a signature.');
    }

    const rows = await pg(
      `SELECT * FROM app.pfp_bookings WHERE booking_token = $1`, [t]);
    const bk = rows[0];
    if (!bk) throw httpError(404, 'That booking link is not valid.');
    if (bk.funnel_stage === 'paid') throw httpError(409, 'This booking is already paid.');
    if (bk.sign_records) throw httpError(409, 'This contract has already been signed.');

    // The hold may have lapsed while they were reading. Reassert it, and refuse
    // clearly if the date filled up in the meantime — the client must be told the
    // truth at the moment they try to pay, not after.
    await pg(`UPDATE app.pfp_availability
                 SET hold_expires_at = now() + make_interval(mins => $3), updated_at = now()
               WHERE kit_id = $1 AND booking_date = $2`, [bk.kit_id, bk.event_date, HOLD_MINUTES]);
    const av = await pg(
      `SELECT k.capacity - a.booked_count - a.held_count AS free
         FROM app.pfp_availability a JOIN app.pfp_kits k ON k.id = a.kit_id
        WHERE a.kit_id = $1 AND a.booking_date = $2`, [bk.kit_id, bk.event_date]);
    if (!av.length || av[0].free < 0) {
      throw httpError(409,
        `${bk.event_date} filled up while you were reading the contract, so this booking can no longer ` +
        `be completed. Nothing has been charged. Call (202) 798-0610 and we will find a date.`, { full: true });
    }

    const file = path.join(DOCS, `${t}-contract.pdf`);
    let unsigned;
    try { unsigned = await fs.readFile(file); }
    catch { throw httpError(500, 'The contract for this booking is missing from disk. Nothing was signed. Support has been notified.'); }

    const { bytes, record } = await applyClientSignature({
      bytes: unsigned,
      bodySha: bk.contract_sha256,
      sigPng: typeof b.signature_png_base64 === 'string' ? b.signature_png_base64 : null,
      name,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    await fs.writeFile(path.join(DOCS, `${t}-signed.pdf`), bytes);

    const up = await pg(
      `UPDATE app.pfp_bookings
          SET sign_records = $2::jsonb, signed_at = now(), funnel_stage = 'signed', updated_at = now()
        WHERE booking_token = $1
      RETURNING signed_at`,
      [t, JSON.stringify([record])]);

    res.json({
      token: t,
      signed_at: up[0].signed_at,
      contract: { url: `/api/pfp-book/file/${t}/signed`, sha256: bk.contract_sha256 },
      next: 'Signed. Continue to payment to confirm the date.',
    });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Pay. Deposit only — the balance is due seven days out, per the terms.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pay', async (req, res, next) => {
  try {
    const t = clean(req.body?.token, 64);
    const rows = await pg('SELECT * FROM app.pfp_bookings WHERE booking_token = $1', [t]);
    const bk = rows[0];
    if (!bk) throw httpError(404, 'That booking link is not valid.');
    if (!bk.sign_records) throw httpError(409, 'Sign the contract before paying.');
    if (bk.paid_at) return res.json({ already_paid: true, token: t, ...(await confirmPayload(t)) });

    const quote = priceOr422(() => priceQuote(Number(bk.duration_hours), bk.rate_id || 'standard'));
    const schedule = priceOr422(() => paymentSchedule(quote.total_cents));
    const stripe = await stripeClient();

    // An idempotency key per booking means a double-clicked Pay button returns
    // the SAME intent rather than creating a second charge.
    const intent = await stripe.paymentIntents.create({
      amount: schedule.deposit_cents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      description: `Party Favor Photo — ${bk.event_name} (${quote.hours}hr ${quote.rate_label}) deposit`,
      receipt_email: bk.client_email,
      metadata: {
        booking_token: t, booking_id: String(bk.id),
        event_date: String(bk.event_date), kit_id: String(bk.kit_id),
        kind: 'pfp_booking_deposit',
      },
    }, { idempotencyKey: `pfp-deposit-${t}` });

    await pg(
      `UPDATE app.pfp_bookings
          SET stripe_payment_intent = $2, funnel_stage = 'paying', updated_at = now()
        WHERE booking_token = $1`, [t, intent.id]);

    const pk = process.env.STRIPE_PUBLISHABLE_KEY || '';
    res.json({
      client_secret: intent.client_secret,
      publishable_key: pk,
      deposit: schedule,
      total: quote.total_display,
    });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Stripe webhook. The ONLY place a hold becomes a booking.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/stripe/webhook', async (req, res, next) => {
  try {
    const stripe = await stripeClient();
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      // Sign the RAW bytes. req.rawBody is captured by the global express.json()
      // verify hook; using req.body here would refuse every real delivery.
      event = stripe.webhooks.constructEvent(req.rawBody ?? req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      throw httpError(400, `signature verification failed: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const t = pi.metadata?.booking_token;
      if (pi.metadata?.kind !== 'pfp_booking_deposit' || !t) {
        return res.json({ received: true, ignored: 'not a pfp booking deposit' });
      }
      const out = await markPaid(t, {
        intentId: pi.id, amount: pi.amount, receiptUrl: pi.latest_charge
          ? (typeof pi.latest_charge === 'string' ? null : pi.latest_charge.receipt_url)
          : null,
      });
      return res.json({ received: true, ...out });
    }

    if (event.type === 'charge.refunded' || event.type === 'refund.created') {
      const obj = event.data.object;
      const piId = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (piId) {
        const rows = await pg(
          `UPDATE app.pfp_bookings
              SET payment_status = 'refunded', refunded_at = now(), updated_at = now()
            WHERE stripe_payment_intent = $1 RETURNING booking_token`, [piId]);
        if (rows.length) {
          // Refunding frees the date again, or the kit stays gone for a night
          // nobody is paying for.
          await pg(`SELECT app.commit_pfp_kit(kit_id, event_date, false)
                      FROM app.pfp_bookings WHERE booking_token = $1`, [rows[0].booking_token]);
        }
      }
    }
    res.json({ received: true });
  } catch (e) { next(e); }
});

/** Idempotent: Stripe redelivers, and a replay must not double-book. */
async function markPaid(t, { intentId, amount, receiptUrl }) {
  // `paid_at IS NULL` is the whole guard. Without it a redelivered webhook
  // increments booked_count a second time and commits a kit already gone.
  const rows = await pg(
    `UPDATE app.pfp_bookings
        SET payment_status = 'paid', paid_at = now(),
            funnel_stage = 'paid', receipt_url = coalesce($2, receipt_url),
            stripe_payment_intent = coalesce(stripe_payment_intent, $3), updated_at = now()
      WHERE booking_token = $1 AND paid_at IS NULL
      RETURNING *`, [t, receiptUrl, intentId]);
  const bk = rows[0];
  if (!bk) return { already: true, token: t };

  await pg('SELECT app.commit_pfp_kit($1, $2, true)', [bk.kit_id, bk.event_date]);

  // Queue the fleet notification rather than calling chat from inside a webhook:
  // a Stripe retry must not produce two messages, and a chat outage must not
  // fail a payment. Unique on (booking_id, channel) enforces the first.
  const quote = priceQuote(Number(bk.duration_hours), bk.rate_id || 'standard');
  const schedule = paymentSchedule(quote.total_cents);
  await pg(
    `INSERT INTO app.pfp_outbox (booking_id, channel, payload)
     VALUES ($1, 'fleet_chat', $2::jsonb)
     ON CONFLICT (booking_id, channel) DO NOTHING`,
    [bk.id, JSON.stringify({
      kind: 'pfp_booking_paid',
      token: t, name: bk.client_name, email: bk.client_email, phone: bk.client_phone,
      event: bk.event_name, date: bk.event_date, event_location: bk.event_location,
      hours: quote.hours, rate: quote.rate_label,
      total: quote.total_display, deposit: schedule.deposit_display,
      balance: schedule.balance_display, balance_due: schedule.balance_due,
      kit: bk.kit_id, studio: bk.studio_url,
    })]);

  return { token: t, stage: 'paid' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Confirmation: what the client is entitled to see after paying.
// ─────────────────────────────────────────────────────────────────────────────
async function confirmPayload(t) {
  const rows = await pg('SELECT * FROM app.pfp_bookings WHERE booking_token = $1', [t]);
  const bk = rows[0];
  if (!bk) throw httpError(404, 'That booking link is not valid.');
  const quote = priceQuote(Number(bk.duration_hours), bk.rate_id || 'standard');
  const schedule = paymentSchedule(quote.total_cents);
  return {
    token: t,
    booking_id: bk.id,
    client_name: bk.client_name,
    event_name: bk.event_name,
    event_date: bk.event_date,
    event_location: bk.event_location,
    address: bk.address,
    start_time: bk.start_time,
    end_time: bk.end_time,
    hours: quote.hours,
    rate_label: quote.rate_label,
    print_format: quote.print_format,
    total_display: quote.total_display,
    deposit_display: schedule.deposit_display,
    balance_display: schedule.balance_display,
    balance_due: schedule.balance_due,
    paid_at: bk.paid_at,
    funnel_stage: bk.funnel_stage,
    signed_at: bk.signed_at,
    countersigned_at: bk.countersigned_at,
    contract_sha256: bk.contract_sha256,
    contracts: {
      unsigned: `/api/pfp-book/file/${t}/contract`,
      signed: `/api/pfp-book/file/${t}/signed`,
      countersigned: bk.countersigned_at ? `/api/pfp-book/file/${t}/countersigned` : null,
    },
    studio_url: bk.studio_url,
    verification: verifyContract({ contractSha: bk.contract_sha256, records: bk.sign_records || [] }),
  };
}

router.get('/confirmation/:token', async (req, res, next) => {
  try { res.json(await confirmPayload(clean(req.params.token, 64))); }
  catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Documents. The token is the credential, same as the studio link.
// ─────────────────────────────────────────────────────────────────────────────
const FILE_KINDS = { contract: 'contract', signed: 'signed', countersigned: 'countersigned' };
router.get('/file/:token/:kind', async (req, res, next) => {
  try {
    const t = clean(req.params.token, 64);
    const kind = FILE_KINDS[clean(req.params.kind, 20)];
    if (!kind) throw httpError(404, 'No such document.');
    const file = path.join(DOCS, `${t}-${kind}.pdf`);
    let buf;
    try { buf = await fs.readFile(file); }
    catch { throw httpError(404, 'That document is not available yet.'); }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="PFP-${kind}-${t.slice(0, 8)}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator endpoints. Countersigning, and the outbox drain.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/operator/:token/countersign', async (req, res, next) => {
  try {
    const t = clean(req.params.token, 64);
    const name = clean(req.body?.name, 120) || BRAND.owner;
    const rows = await pg('SELECT * FROM app.pfp_bookings WHERE booking_token = $1', [t]);
    const bk = rows[0];
    if (!bk) throw httpError(404, 'No such booking.');
    if (!bk.sign_records) throw httpError(409, 'The client has not signed yet.');
    if (bk.countersigned_at) throw httpError(409, 'Already countersigned.');

    const buf = await fs.readFile(path.join(DOCS, `${t}-signed.pdf`));
    const { bytes, record } = await countersign({
      bytes: buf, bodySha: bk.contract_sha256, name,
      ip: clientIp(req), userAgent: req.headers['user-agent'],
    });
    await fs.writeFile(path.join(DOCS, `${t}-countersigned.pdf`), bytes);
    await pg(
      `UPDATE app.pfp_bookings SET provider_signature = $2::jsonb, countersigned_at = now(),
              updated_at = now() WHERE booking_token = $1`, [t, JSON.stringify(record)]);

    // Only now does the confirmation email go out. The brief is explicit: the
    // client is not told the booking is confirmed until Joe has accepted it.
    await pg(
      `INSERT INTO app.pfp_outbox (booking_id, channel, payload)
       VALUES ($1, 'confirmation_email', $2::jsonb)
       ON CONFLICT (booking_id, channel) DO NOTHING`,
      [bk.id, JSON.stringify({ kind: 'pfp_booking_confirm', token: t, to: bk.client_email })]);

    res.json({ token: t, countersigned_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

router.post('/operator/outbox/drain', async (req, res, next) => {
  try {
    const rows = await pg(
      `SELECT * FROM app.pfp_outbox WHERE state = 'pending' ORDER BY created_at LIMIT $1`,
      [Math.min(Number(req.body?.limit) || 20, 100)]);
    res.json({ pending: rows.length, items: rows });
  } catch (e) { next(e); }
});

const clientIp = (req) =>
  (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
    .toString().split(',')[0].trim() || null;

// Errors carry the real cause. A generic "something went wrong" on a payment
// page is how a client pays twice or gives up.
router.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[pfp-book]', err);
  res.status(status).json({
    error: err.message || 'Unexpected server error',
    ...(err.full ? { full: true } : {}),
  });
});

export default router;
