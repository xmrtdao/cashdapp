// relay/jobby/email.mjs — Email functions for Jobby (shared by server and cron engine)
//
// This module provides email-related functions that can be used by both
// the main server and the cron engine without starting the full relay server.

import { ensureMailbox, MAILBOX_DOMAIN } from './store.mjs';
import { formatFrom, isCandidateMailbox, domainOf, displayNameFor } from './mailbox.mjs';
import { sendViaResend, resolveJobbySender } from '../server.js'; // These are re-exported from server.js

// Re-export for convenience
export { sendViaResend, resolveJobbySender, isCandidateMailbox, domainOf, formatFrom, displayNameFor, MAILBOX_DOMAIN };

/**
 * Ensure a candidate has a jobbymcjobserson.com mailbox and return the address.
 * Used by both the server and cron engine.
 */
export async function ensureCandidateMailbox(client) {
  const name = client.display_name || null;
  try {
    const { ensureMailbox } = await import('./store.mjs');
    const r = await ensureMailbox(client.id, name);
    if (r.address) return { mailbox: r.address, displayName: r.displayName || name };
    console.warn(`[jobby] could not assign an address to client ${client.id} (${r.reason}); sending as the agent`);
  } catch (e) {
    console.warn(`[jobby] address assignment failed for client ${client.id}: ${e.message}`);
  }
  return { mailbox: client.mailbox || null, displayName: client.display_name || null };
}

/**
 * Compose and send a morning summary email to a client.
 */
export async function sendMorningSummary(pool, client) {
  const { composeCheckin } = await import('./composer.mjs');
  const { sendViaResend, resolveJobbySender } = await import('../server.js');
  
  const { rows: planRows } = await pool.query(`
    SELECT priority, title, detail, track, status
    FROM app.job_actions
    WHERE client_id = $1 AND status IN ('pending', 'active')
    ORDER BY priority, track, id
  `, [client.id]);
  
  const plan = {
    actions: planRows.map(r => ({
      priority: r.priority,
      track: r.track,
      title: r.title,
      detail: r.detail,
      status: r.status
    }))
  };
  
  const { rows: cycleRows } = await pool.query(`
    SELECT decision, reason, status, steps, finished_at
    FROM app.job_cycles
    WHERE client_id = $1 AND finished_at > now() - INTERVAL '24 hours'
    ORDER BY finished_at DESC LIMIT 5
  `, [client.id]);
  
  const recentCycles = cycleRows.map(r => ({
    decision: r.decision,
    reason: r.reason,
    status: r.status,
    steps: r.steps,
    finished_at: r.finished_at
  }));
  
  const { rows: clientInfo } = await pool.query(`
    SELECT display_name, email, phone, location
    FROM app.job_clients WHERE id = $1
  `, [client.id]);
  
  const dossier = {
    name: clientInfo[0]?.display_name || 'there',
    current_title: clientInfo[0]?.current_title || 'Professional',
    current_company: clientInfo[0]?.current_company || 'Self-employed',
    location: clientInfo[0]?.location
  };
  
  const email = composeCheckin({
    kind: 'progress',
    decision: 'Morning briefing',
    reason: `Your Jobby agent has ${plan.actions.filter(a => a.status === 'pending').length} pending actions for today`,
    dossier,
    plan: { actions: planRows.map(r => ({ title: r.title, status: r.status, track: r.track, priority: r.priority })) },
    recentCycles,
    client: { name: clientInfo[0]?.display_name || 'there', display_name: clientInfo[0]?.display_name }
  });
  
  const { ensureCandidateMailbox } = await import('./store.mjs');
  const mailboxInfo = await ensureCandidateMailbox(client);
  const sender = resolveJobbySender({ mailbox: mailboxInfo.mailbox, claimed_email: client.claimed_email });
  const sent = await sendViaResend({
    from: sender.from,
    to: client.claimed_email,
    subject: email.subject,
    text: email.body
  });
  
  return sent;
}

/**
 * Compose and send an evening summary email to a client.
 */
export async function sendEveningSummary(pool, client) {
  const { composeCheckin } = await import('./composer.mjs');
  const { sendViaResend, resolveJobbySender } = await import('../server.js');
  
  const { rows: completedRows } = await pool.query(`
    SELECT decision, reason, status, steps, finished_at
    FROM app.job_cycles
    WHERE client_id = $1 AND status IN ('ran', 'no_work')
      AND finished_at > CURRENT_DATE
    ORDER BY finished_at DESC
  `, [client.id]);
  
  const { rows: plannedRows } = await pool.query(`
    SELECT title, status FROM app.job_actions
    WHERE client_id = $1 AND priority <= 2
    ORDER BY priority, track, id
  `, [client.id]);
  
  const { rows: clientInfo } = await pool.query(`
    SELECT display_name, email, phone, location
    FROM app.job_clients WHERE id = $1
  `, [client.id]);
  
  const dossier = {
    name: clientInfo[0]?.display_name || 'there',
    current_title: clientInfo[0]?.current_title || 'Professional',
    current_company: clientInfo[0]?.current_company || 'Self-employed',
    location: clientInfo[0]?.location
  };
  
  const completedCount = completedRows.filter(r => r.status === 'ran').length;
  const pendingPlanned = plannedRows.filter(r => r.status === 'pending').length;
  
  const email = composeCheckin({
    kind: 'progress',
    decision: `Day complete: ${completedCount} cycles ran`,
    reason: `${pendingPlanned} high-priority actions remain for tomorrow`,
    dossier: {
      name: clientInfo[0]?.display_name || 'there',
      current_title: clientInfo[0]?.current_title,
      current_company: clientInfo[0]?.current_company
    },
    plan: { actions: plannedRows.map(r => ({ title: r.title, status: r.status })) },
    recentCycles: completedRows.map(r => ({
      decision: r.decision,
      reason: r.reason,
      status: r.status,
      steps: r.steps,
      finished_at: r.finished_at
    })),
    client: { name: clientInfo[0]?.display_name || 'there', display_name: clientInfo[0]?.display_name }
  });
  
  const { ensureCandidateMailbox } = await import('./store.mjs');
  const mailboxInfo = await ensureCandidateMailbox(client);
  const sender = resolveJobbySender({ mailbox: mailboxInfo.mailbox, claimed_email: client.claimed_email });
  const sent = await sendViaResend({
    from: sender.from,
    to: client.claimed_email,
    subject: email.subject,
    text: email.body
  });
  
  return sent;
}

export async function sendMorningSummaries() {
  const { getPool } = await import('../lib/db.mjs');
  const pool = await getPool();
  
  const { rows: clients } = await pool.query(`
    SELECT id, display_name, claimed_email, daily_send_cap
    FROM app.job_clients
    WHERE claimed_email IS NOT NULL
  `);
  
  if (!clients.length) {
    return { ok: true, result: 'No clients with claimed emails to notify' };
  }
  
  let sent = 0;
  let failed = 0;
  
  for (const client of clients) {
    try {
      const result = await sendMorningSummary(pool, client);
      if (result.error) {
        console.error(`[Morning Summary] Failed to send to ${client.claimed_email}:`, result.error);
      } else {
        console.log(`[Morning Summary] Sent to ${client.claimed_email} (Resend ID: ${result.id})`);
      }
    } catch (e) {
      console.error(`[Morning Summary] Error for client ${client.id}:`, e.message);
    }
  }
  
  return { ok: true, result: `Morning summaries: ${sent} sent, ${failed} failed` };
}

export async function sendEveningSummaries() {
  const { getPool } = await import('../lib/db.mjs');
  const pool = await getPool();
  
  const { rows: clients } = await pool.query(`
    SELECT id, display_name, claimed_email, daily_send_cap
    FROM app.job_clients
    WHERE claimed_email IS NOT NULL
  `);
  
  if (!clients.length) {
    return { ok: true, result: 'No clients with claimed emails to notify' };
  }
  
  let sent = 0;
  let failed = 0;
  
  for (const client of clients) {
    try {
      const result = await sendEveningSummary(pool, client);
      if (result.error) {
        console.error(`[Evening Summary] Failed to send to ${client.claimed_email}:`, result.error);
      } else {
        console.log(`[Evening Summary] Sent to ${client.claimed_email} (Resend ID: ${result.id})`);
      }
    } catch (e) {
      console.error(`[Evening Summary] Error for client ${client.id}:`, e.message);
    }
  }
  
  return { ok: true, result: `Evening summaries: ${sent} sent, ${failed} failed` };
}