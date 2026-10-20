import pg from 'pg';
import { pathToFileURL } from 'node:url';
const { advanceLeadStage } = await import(
  pathToFileURL('C:/Users/PureTrek/Desktop/xmrtdao/relay/lib/pfp-lead-stages.mjs').href
);

const EMAIL = 'tdent@lpc.com';
const LEAD = '0c6f96ab-128d-4d89-adc1-4fe7360ea89b';
const DETAIL = 'STOP - Remove for list. - RE: The difference: DSLR + strobe vs tablet + ring light';

const c = new pg.Client({ connectionString: process.env.LOCAL_DATABASE_URL });
await c.connect();
const q = (sql, params) => c.query(sql, params);
let ok = true;

try {
  await q('BEGIN');

  await q(`INSERT INTO public.pfp_campaign_suppressions (email, reason, detail)
           VALUES ($1,'inbound_opt_out',$2) ON CONFLICT (email) DO NOTHING`, [EMAIL, DETAIL]);

  const upd = await q(`UPDATE public.pfp_inbound_emails SET outcome='suppressed'
                        WHERE lower(sender_email)=$1 AND outcome='lead_created'
                        RETURNING id`, [EMAIL]);
  console.log(`inbound rows corrected: ${upd.rowCount}`);

  await advanceLeadStage(q, {
    lead_id: LEAD,
    to_stage: 'lost',
    actor: 'hermes',
    reason: 'opted_out',
    note: 'sender replied to a campaign with "STOP - Remove for list"; not a lead',
  });

  // `status` is the legacy vocabulary that still has readers; keep it from
  // disagreeing with `stage` rather than leaving stage=lost, status=NEW.
  await q(`UPDATE public.pfp_leads SET status='lost', updated_at=NOW() WHERE id=$1`, [LEAD]);

  const sup = await q(`SELECT email, reason FROM public.pfp_campaign_suppressions WHERE lower(email)=$1`, [EMAIL]);
  const inb = await q(`SELECT count(*)::int AS n FROM public.pfp_inbound_emails
                        WHERE lower(sender_email)=$1 AND outcome='suppressed'`, [EMAIL]);
  const lead = await q(`SELECT stage, lost_reason FROM public.pfp_leads WHERE id=$1`, [LEAD]);

  console.log('suppression: ' + JSON.stringify(sup.rows[0] ?? null));
  console.log('inbound suppressed rows: ' + inb.rows[0].n);
  console.log('lead: ' + JSON.stringify(lead.rows[0]));

  ok = sup.rows.length === 1
    && inb.rows[0].n >= 1
    && lead.rows[0].stage === 'lost'
    && lead.rows[0].lost_reason === 'opted_out';

  if (ok) { await q('COMMIT'); console.log('\nCOMMITTED'); }
  else { await q('ROLLBACK'); console.log('\nROLLED BACK (checks failed)'); }
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error('FAIL: ' + e.message);
  ok = false;
} finally {
  await c.end();
}
process.exit(ok ? 0 : 1);
