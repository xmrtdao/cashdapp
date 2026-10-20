// relay/jobby/composer.mjs — write the email the loop actually sends
//
// The loop decides *what* to say (escalate/wait/report/work) and the check-in
// machinery decides *when* it may be said. This module owns HOW it is said:
// the voice, the structure, the evidence, and the call to action.
//
// Three principles, each learned from a real failure:
//
// 1. EVIDENCE OVER FILLER. "I sourced 20 roles" is noise. "I sourced 20 roles;
//    12 were direct postings; 8 were board searches. The 12 direct ones are
//    tracked at app.job_applications with packet + eligibility." is evidence.
//    The candidate can forward this to a recruiter and it still reads like work.
//
// 2. THE DOSSIER IS THE SOURCE, NOT THE STYLE GUIDE. If the dossier says
//    "Combat Correspondent, Sergeant (E-5), USMC 1997–2008" the email does
//    not say "extensive military background". It says "Sergeant (E-5), USMC
//    1997–2008: Okinawa, Barstow, Hawaii." Specificity is the only thing
//    recruiters cannot fake, and it is the only thing the candidate owns.
//
// 3. THE CANDIDATE'S VOICE, NOT THE AGENT'S. Jobby writes *as* the candidate
//    ("I sourced...", "My dossier shows..."), never *about* the candidate
//    ("Jobby found..."). The email is the candidate's voice with Jobby's
//    research and structure behind it. The signature is the candidate's name.

import { CHECKIN_KINDS } from './checkin.mjs';

/** Hard ceilings from gate.py and the persona's style rules. */
export const MAX_SUBJECT = 90;
export const MAX_BODY_WORDS = 220;          // hard ceiling; sequences aim far lower
export const BANNED = [
  'act now', 'buy now', 'click here', 'click below', 'limited time',
  'limited offer', 'exclusive deal', 'special offer', 'risk-free',
  'no obligation', '100% free', 'make money', 'double your',
  'guaranteed results', 'winner', 'congratulations',
  'i hope this finds you well', 'hope this email finds you well',
  'i hope this email finds you', 'picture this', 'what if i told you',
  'in today\'s fast-paced world', 'game-changer', 'game changer',
  'cutting-edge solution', 'revolutionize your', 'unlock your',
  'supercharge your', 'as an ai', 'i\'m an ai', 'i am an ai',
  'as a language model',
];

export const BANNED_RE = new RegExp(`\\b(?:${BANNED.join('|')})\\b`, 'i');

/** Count words conservatively. */
function wordCount(s) {
  return String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** Fail loud if the output would be rejected by gate.py. */
function assertClean({ subject, body }) {
  const reasons = [];
  if (subject.length > MAX_SUBJECT) reasons.push(`subject ${subject.length} > ${MAX_SUBJECT}`);
  if (wordCount(body) > MAX_BODY_WORDS) reasons.push(`body ${wordCount(body)} > ${MAX_BODY_WORDS}`);
  if (BANNED_RE.test(subject)) reasons.push('banned phrase in subject');
  if (BANNED_RE.test(body)) reasons.push('banned phrase in body');
  if (reasons.length) {
    const err = new Error('composer output failed gate.py checks: ' + reasons.join('; '));
    err.reasons = reasons;
    throw err;
  }
}

/** Simple template helper — no engine, just safe interpolation. */
export function t(str, vars = {}) {
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

/** Evidence from the dossier, phrased as the candidate would say it. */
export function evidenceFromDossier(dossier, kind) {
  const out = [];
  if (!dossier) return out;

  // Roles with dates and one distinguishing fact each
  const roles = Array.isArray(dossier.employment) ? dossier.employment : [];
  for (const r of roles) {
    const years = r.start ? (r.end ? `${r.start}–${r.end}` : `${r.start}–present`) : '';
    const loc = r.location ? `, ${r.location}` : '';
    const fact = r.highlights?.[0] || r.description || '';
    out.push(`${r.title} at ${r.company}${years}${loc}${fact ? ' — ' + fact : ''}`);
  }

  // Education
  const edu = Array.isArray(dossier.education) ? dossier.education : [];
  for (const e of edu) {
    const yr = e.year ? ` (${e.year})` : '';
    out.push(`${e.degree || 'Degree'} in ${e.field || 'unspecified'} from ${e.institution}${yr}`);
  }

  // Verifications
  const flags = Array.isArray(dossier.verification_flags) ? dossier.verification_flags : [];
  if (flags.length) out.push(`Verified: ${flags.join(', ')}`);

  return out;
}

/** Recent activity from the cycle log, summarised as the candidate would say it. */
export function recentActivity(cycles, limit = 3) {
  if (!Array.isArray(cycles) || !cycles.length) return ['No cycles recorded yet.'];
  return cycles
    .slice(0, limit)
    .filter(c => c.status === 'ran')
    .map(c => {
      const parts = [];
      if (c.decision) parts.push(c.decision);
      if (c.reason) parts.push(c.reason);
      if (c.steps && c.steps.length) {
        const done = c.steps.filter(s => s.ok).map(s => s.step).join(', ');
        if (done) parts.push(`did: ${done}`);
      }
      return parts.join(' — ');
    })
    .slice(0, 3);
}

/** A single track rendered as one paragraph the candidate would recognise. */
function trackBlurb(trackId, dossier, plan) {
  const trackNames = {
    1: 'Contract consulting',
    2: 'Temporary & contract roles',
    3: 'Full-time employment',
    4: 'ATS automation',
    5: 'FIFO & remote-site roles',
  };
  const name = trackNames[trackId] || `Track ${trackId}`;
  const actions = Array.isArray(plan?.actions) ? plan.actions.filter(a => a.track === trackId) : [];
  const open = actions.filter(a => a.status === 'pending').length;
  const done = actions.filter(a => a.status === 'done').length;
  return `${name}: ${open} open, ${done} done.`;
}

/** Compose one check-in email.
 *
 * @param {{
 *   kind: 'progress'|'question'|'urgent'|'closing',
 *   decision: string,
 *   reason: string,
 *   dossier: object,
 *   plan: object,
 *   recentCycles: array,
 *   escalation: object|null,
 *   supersededQuestion: object|null,
 *   client: { name, mailbox, display_name },
 *   cadenceHours: number,
 *   quietHours: {from,to}|null,
 * }} opts
 * @returns {{ subject: string, body: string, kind: string, decision: string, reason: string, evidence: string[] }}
 */
export function composeCheckin({
  kind,
  decision,
  reason,
  dossier,
  plan,
  recentCycles,
  escalation = null,
  supersededQuestion = null,
  client = {},
  cadenceHours = 24,
  quietHours = null,
}) {
  const name = client.display_name || client.name || 'you';
  const lines = [];

  // ── Subject ──────────────────────────────────────────────────────────────
  // Subject must be under 90 chars and pass gate.py. No "Update" or "Checking in".
  let subject;
  switch (kind) {
    case 'urgent':
      subject = `Offer: ${(escalation?.detail?.company || 'a company')} — action needed`;
      break;
    case 'question':
      subject = `Question: ${decision || 'next step'}`;
      break;
    case 'progress':
      subject = `Progress: ${(dossier?.current_title || 'your search')} — ${reason}`;
      break;
    case 'closing':
      subject = `Closed: ${decision || 'the question'}`;
      break;
    default:
      subject = `Update: ${decision || 'status'}`;
  }
  if (subject.length > 90) subject = subject.slice(0, 87) + '...';

  // ── Opening ──────────────────────────────────────────────────────────────
  const greeting = `Hi ${name.split(' ')[0]},`;

  // ── Body per kind ───────────────────────────────────────────────────────
  const bodyLines = [greeting, ''];

  if (kind === 'urgent') {
    const esc = arguments[0]?.escalation;
    const detail = esc?.detail || {};
    lines.push(
      `This is urgent.`,
      '',
      `${esc?.kind === 'offer' ? 'An offer came in' : esc?.kind === 'interview' ? 'An interview was scheduled' : esc?.kind === 'deadline' ? 'A deadline is approaching' : 'A blocker needs action'} ${detail.company ? `from ${detail.company}` : ''}.`,
      detail.evidence ? `Evidence: ${detail.evidence}` : '',
      '',
      'What you need to decide:',
      '- Accept / Decline / Counter (offer)',
      '- Confirm availability / Request alternate time (interview)',
      '- Respond by the deadline / Ask for extension (deadline)',
      '- Tell me what to change / Authorise the fix (blocker)',
      '',
      'Reply with your decision and I will act on it immediately.'
    );
  } else if (kind === 'question') {
    lines.push(
      `I need your input to move forward.`,
      '',
      `Question: ${decision}`,
      '',
      `Why this matters: ${reason}`,
      '',
      'Please reply with your answer. I will not move forward on this track until you respond.'
    );
  } else if (kind === 'progress') {
    const activity = recentActivity(recentCycles, 3);
    const done = activity.filter(a => a.startsWith('source') || a.startsWith('packet') || a.startsWith('research')).length;
    const wrote = activity.filter(a => a.startsWith('source')).length > 0
      ? `I sourced ${done} role${done === 1 ? '' : 's'}${activity.some(a => a.includes('direct')) ? ' — direct postings' : ''}.`
      : `I ${activity.length ? 'worked through' : 'ran a cycle with no'} ${activity.length} step${activity.length === 1 ? '' : 's'}.`;
    const why = reason ? ` ${reason}` : '';

    lines.push(
      wrote + why,
      ''
    );
    for (const a of activity) lines.push(`- ${a}`);
    if (activity.length === 0) lines.push('- No cycles recorded yet.');
    lines.push('');

    const evi = evidenceFromDossier(arguments[0]?.dossier, 'progress');
    for (const e of evi) lines.push(`- ${e}`);
    lines.push('');

    const planArg = arguments[0]?.plan;
    if (planArg?.actions?.length) {
      const open = planArg.actions.filter(a => a.status === 'pending').length;
      lines.push(`Open actions: ${open}. Next: ${planArg.actions.find(a => a.status === 'pending')?.title || 'none'}.`);
    }
  } else if (kind === 'closing') {
    lines.push(
      `The question is resolved.`,
      '',
      `Decision: ${decision}`,
      `Reason: ${reason}`,
      '',
      'The loop is unblocked and will resume work on the next cycle.'
    );
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push('', '—', 'Sent by Jobby on your behalf. Reply to this email and I will read it.');

  // ── Assemble ─────────────────────────────────────────────────────────────
  const body = lines.filter(Boolean).join('\n');
  const subjectFinal = subject;

  // Evidence summary for the caller
  const finalEvidence = evidenceFromDossier(arguments[0]?.dossier, kind);

  const out = {
    subject: subjectFinal,
    body,
    kind,
    decision,
    reason,
    evidence: finalEvidence,
  };

  // Gate check — fail loud if we produced something gate.py would reject
  assertClean({ subject: subjectFinal, body: out.body });

  return out;
}

/** Compose a progress email from a cycle summary (called when no question is open). */
export function composeProgress({ dossier, plan, recentCycles, client }) {
  return composeCheckin({
    kind: 'progress',
    decision: 'cycle complete',
    reason: 'The loop ran and here is what changed.',
    dossier: arguments[0]?.dossier,
    plan: arguments[0]?.plan,
    recentCycles: arguments[0]?.recentCycles,
    client: arguments[0]?.client,
  });
}

/** A tiny self-test that the output passes gate.py. */
export function selfTest() {
  const dossier = {
    name: 'Test User',
    current_title: 'Founder',
    employment: [
      { title: 'Founder', company: 'Test Co', start: '2023', end: null, current: true, highlights: ['Built X'] },
    ],
    education: [{ institution: 'Test U', degree: 'BS', field: 'CS', year: '2020' }],
  };
  const plan = { actions: [{ title: 'Source 20 roles', status: 'pending' }] };
  const cycles = [{ status: 'ran', decision: 'source', reason: 'pipeline thin', steps: [{ step: 'source', ok: true }] }];

  const r1 = composeCheckin({
    kind: 'progress',
    decision: 'sourced 20 roles',
    reason: 'pipeline was 3 deep',
    dossier: { current_title: 'Founder', employment: [{ title: 'Founder', company: 'Test Co', start: '2023', current: true }] },
    plan: { actions: [{ title: 'Source 20 roles', status: 'pending' }] },
    recentCycles: cycles,
    client: { name: 'Test User' },
  });
  console.log('progress:', r1.subject, '| words:', r1.body.split(/\s+/).filter(Boolean).length);

  const r2 = composeCheckin({
    kind: 'question',
    decision: 'Which track first?',
    reason: 'Track 1 and 2 both open; need your priority.',
    dossier: { current_title: 'Founder' },
    plan: {},
    recentCycles: [],
    client: { name: 'Test User' },
  });
  console.log('question:', r2.subject, '| words:', r2.body.split(/\s+/).filter(Boolean).length);

  const r3 = composeCheckin({
    kind: 'urgent',
    decision: 'offer received',
    reason: 'Offer from Acme Corp, expires Friday',
    escalation: { kind: 'offer', detail: { company: 'Acme Corp', evidence: 'Offer letter attached' } },
    dossier: {},
    plan: {},
    recentCycles: [],
    client: { name: 'Test User' },
  });
  console.log('urgent:', r3.subject, '| words:', r3.body.split(/\s+/).filter(Boolean).length);

  console.log('All self-test emails passed gate.py checks.');
}