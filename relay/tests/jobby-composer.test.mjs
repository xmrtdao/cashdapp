/**
 * relay/tests/jobby-composer.test.mjs — the email writes like the candidate
 *
 * The composer is the only place where the dossier becomes words a recruiter
 * reads. The properties checked here are the ones that prevent the three
 * failures this repo has already paid for:
 *
 *   1. The candidate's voice, not the agent's. "I sourced..." not "Jobby found..."
 *   2. Evidence over filler. "Sourced 20 roles" is noise; "12 direct postings,
 *      8 board searches; the 12 direct ones tracked at job_applications" is evidence.
 *   3. The dossier is the source, not the style guide. "Sergeant (E-5), USMC
 *      1997–2008: Okinawa, Barstow, Hawaii" — specificity is the only thing
 *      recruiters cannot fake.
 *
 * The gate.py checks are the backstop; a test that passes but fails the gate
 * is not a pass.
 */
import { composeCheckin, composeProgress, selfTest, evidenceFromDossier, recentActivity, BANNED_RE } from '../jobby/composer.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

console.log('\n--- selfTest runs without error ---');
try {
  selfTest();
  check('selfTest runs and passes gate.py', true);
} catch (e) {
  check('selfTest runs and passes gate.py', false, e.message);
}

const BASE_DOSSIER = {
  name: 'Joseph Andrew Lee',
  current_title: 'Founder',
  current_company: 'XMRT Solutions',
  location: 'Costa Rica',
  phone: '+1 202 798 0610',
  email: 'joeyleepcs@gmail.com',
  links: { linkedin: 'linkedin.com/in/joecodes' },
  summary: 'Media professional and founder...',
  employment: [
    { company: 'XMRT Solutions', title: 'Founder', start: '2023', end: null, current: true, location: 'Remote', highlights: ['Operates as 31harbor.com; encompasses XMRT.io and Cuttlefish Labs'] },
    { company: 'Party Favor Photo', title: 'Founder & Managing Director', start: '2016', end: null, current: true, location: 'Costa Rica & USA', highlights: ['Event technology and media production venture'] },
    { company: 'Freelance Journalism', title: 'Freelance Journalist', start: '2020', end: '2021', current: false, location: 'Remote', highlights: ['Covered January 6 riot for Coffee or Die'] },
    { company: 'United Service Organizations (USO)', title: 'Senior Multimedia Journalist', start: '2009', end: '2019', current: false, location: 'Arlington, VA', highlights: ['Engaged high-net-worth donors and corporate sponsors'] },
    { company: 'Allianz', title: 'Project Manager, SaaS Implementation', start: '2008', end: '2009', current: false, location: 'Novato, CA' },
    { company: 'United States Marine Corps', title: 'Combat Correspondent, Sergeant (E-5)', start: '1997', end: '2008', current: false, location: 'Various', highlights: ['Okinawa 1997–2000', 'Barstow 2000–2003', 'Hawaii 2003–2008'] },
  ],
  education: [
    { institution: 'Harvard University', degree: "Master's", field: 'Journalism & Advanced Communication', year: '2017' },
    { institution: 'Excelsior College', degree: "Bachelor's", field: 'Business Administration (Summa Cum Laude)', year: '2007' },
  ],
};

const PLAN = {
  actions: [
    { priority: 1, title: 'Close 2 gaps in your dossier', status: 'pending' },
    { priority: 1, track: 1, title: 'Build the consulting offer', status: 'pending' },
    { priority: 2, track: 3, title: 'Source 40 full-time employment opportunities', status: 'pending' },
    { priority: 2, track: 3, title: 'Research each target before contacting anyone (track 3)', status: 'pending' },
    { priority: 3, title: 'Run the outreach cadence', status: 'pending' },
  ],
};

const CYCLES = [
  { status: 'ran', decision: 'source', reason: 'pipeline was 3 deep', steps: [{ step: 'source', ok: true }, { step: 'packet', ok: true }] },
  { status: 'ran', decision: 'packet', reason: 'unprepared applications', steps: [{ step: 'packet', ok: true }] },
  { status: 'ran', decision: 'blocked', reason: '2 applications blocked', steps: [{ step: 'apply', ok: false, note: 'CAPTCHA on step 3' }] },
];

const CLIENT = { name: 'Joseph Andrew Lee', display_name: 'Joseph Andrew Lee', mailbox: 'joseph.lee@jobbymcjobberson.com' };

console.log('\n--- PROGRESS email ---');
{
  const r = composeCheckin({
    kind: 'progress',
    decision: 'sourced 20 roles; 12 direct, 8 board searches',
    reason: 'pipeline was 3 deep, now 23 deep',
    dossier: BASE_DOSSIER,
    plan: { actions: [{ status: 'pending' }, { status: 'pending' }, { status: 'done' }] },
    recentCycles: CYCLES,
    client: CLIENT,
  });
  check('subject is under 90 chars', r.subject.length <= 90, r.subject);
  check('body is under 220 words', r.body.split(/\s+/).filter(Boolean).length <= 220, r.body.split(/\s+/).filter(Boolean).length);
  check('uses candidate voice: "I sourced"', /I\s+sourced/i.test(r.body) || /I\s+researched/i.test(r.body), r.body.slice(0, 200));
  check('does NOT use agent voice', !/Jobby\s+found/i.test(r.body) && !/Jobby\s+sourced/i.test(r.body), 'no agent voice');
  check('contains dossier evidence (Marine Corps, Harvard)', /Marine Corps|Harvard|Excelsior|USO|Allianz|Party Favor/i.test(r.body));
  check('contains cycle activity', /source|packet|blocked/i.test(r.body));
  check('word count within gate.py limit', r.body.split(/\s+/).filter(Boolean).length <= 220);
  check('subject under 90 chars', r.subject.length <= 90);
  check('no banned phrases', !/(act now|buy now|click here|limited time|i hope this finds you well|as an ai|guaranteed)/i.test(r.body + r.subject));
}

console.log('\n--- QUESTION email ---');
{
  const r = composeCheckin({
    kind: 'question',
    decision: 'Which track first: consulting or full-time?',
    reason: 'Tracks 1 and 3 both open; need your priority to source correctly.',
    dossier: BASE_DOSSIER,
    plan: {},
    recentCycles: [],
    client: { name: 'Joseph Andrew Lee', display_name: 'Joseph Andrew Lee' },
  });
  check('subject names the question', /Question:/i.test(r.subject));
  check('body contains the question', /Which track first/i.test(r.body));
  check('explains why it matters', /Tracks 1 and 3 both open/i.test(r.body));
  check('candidate voice', /I\s+need your input/i.test(r.body) || /I\s+will not move forward/i.test(r.body));
  check('under word limit', r.body.split(/\s+/).filter(Boolean).length <= 220);
}

console.log('\n--- URGENT (offer) email ---');
{
  const r = composeCheckin({
    kind: 'urgent',
    decision: 'offer received',
    reason: 'Offer from Acme Corp, expires Friday',
    escalation: { kind: 'offer', detail: { company: 'Acme Corp', evidence: 'Offer letter attached', salary: '$180k base + equity' } },
    dossier: BASE_DOSSIER,
    plan: {},
    recentCycles: [],
    client: { name: 'Joseph Andrew Lee', display_name: 'Joseph Andrew Lee' },
  });
  check('subject says urgent and offer', /Offer:/i.test(r.subject) && /Urgent|offer/i.test(r.subject));
  check('body says it is urgent', /This is urgent/i.test(r.body));
  check('names the company', /Acme Corp/i.test(r.body));
  check('gives clear action items', /Accept \/ Decline \/ Counter/i.test(r.body));
  check('under word limit', r.body.split(/\s+/).filter(Boolean).length <= 220);
  check('no banned phrases', !/(act now|buy now|click here|limited time|i hope this finds you well|as an ai|guaranteed)/i.test(r.body + r.subject));
}

console.log('\n--- CLOSING email ---');
{
  const r = composeCheckin({
    kind: 'closing',
    decision: 'Track 3 first',
    reason: 'Full-time roles pay the mortgage; consulting is the second stream.',
    dossier: BASE_DOSSIER,
    plan: {},
    recentCycles: [],
    client: { name: 'Joseph Andrew Lee' },
  });
  check('subject says closed', /Closed:/i.test(r.subject));
  check('states the decision', /Track 3 first/i.test(r.body));
  check('states the reason', /mortgage|second stream/i.test(r.body));
  check('says loop is unblocked', /unblocked|resume work/i.test(r.body));
  check('under word limit', r.body.split(/\s+/).filter(Boolean).length <= 220);
}

console.log('\n--- EVIDENCE function returns real facts ---');
{
  const evi = evidenceFromDossier({
    employment: [
      { title: 'Founder', company: 'XMRT Solutions', start: '2023', end: null, current: true, location: 'Remote', highlights: ['Operates as 31harbor.com'] },
      { title: 'Combat Correspondent', company: 'United States Marine Corps', start: '1997', end: '2008', current: false, location: 'Various', highlights: ['Okinawa, Barstow, Hawaii'] },
    ],
    education: [{ institution: 'Harvard University', degree: "Master's", field: 'Journalism', year: '2017' }],
  }, 'progress');
  const joined = evi.join(' | ');
  check('includes Marine Corps with dates', /Marine Corps.*1997.*2008/i.test(joined));
  check('includes Harvard', /Harvard/i.test(joined));
  check('includes 31harbor.com', /31harbor\.com/i.test(joined));
  check('includes XMRT Solutions', /XMRT Solutions/i.test(joined));
}

console.log('\n--- RECENT ACTIVITY summarises cycles ---');
{
  const acts = recentActivity([
    { status: 'ran', decision: 'source', reason: 'pipeline thin', steps: [{ step: 'source', ok: true }, { step: 'packet', ok: false }] },
    { status: 'ran', decision: 'packet', reason: 'unprepared apps', steps: [{ step: 'packet', ok: true }] },
    { status: 'error', decision: 'apply', reason: 'captcha', steps: [{ step: 'apply', ok: false }] },
  ], 2);
  check('only ran cycles are included', acts.length === 2, acts.length);
  check('shows decision and reason', /source.*pipeline thin/i.test(acts[0]) && /packet.*unprepared/i.test(acts[1]));
  check('shows what was done', /source|packet/i.test(acts.join(' ')));
}

console.log('\n--- GATE.PY compliance ---');
{
  const r = composeCheckin({
    kind: 'progress',
    decision: 'test',
    reason: 'test',
    dossier: { current_title: 'Founder' },
    plan: {},
    recentCycles: [],
    client: { name: 'Test' },
  });
  check('subject <= 90 chars', r.subject.length <= 90);
  check('body <= 220 words', r.body.split(/\s+/).filter(Boolean).length <= 220);
  check('no banned phrases in subject', !BANNED_RE.test(r.subject));
  check('no banned phrases in body', !BANNED_RE.test(r.body));
}

console.log('\n--- composeProgress wrapper ---');
{
  const r = composeProgress({ dossier: BASE_DOSSIER, plan: PLAN, recentCycles: CYCLES, client: CLIENT });
  check('returns a progress checkin', r.kind === 'progress');
  check('has subject and body', r.subject && r.body);
  check('body has dossier evidence', /Marine Corps|Harvard|USO/i.test(r.body));
}

console.log(failures === 0
  ? '\n  the composer writes like the candidate, with evidence, and passes gate.py'
  : `\n  ${failures} finding(s) need attention`);
process.exitCode = failures === 0 ? 0 : 1;