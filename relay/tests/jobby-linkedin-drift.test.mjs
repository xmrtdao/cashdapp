/**
 * relay/tests/jobby-linkedin-drift.test.mjs — the profile must match the record
 *
 * The failure this guards against is the one that reached the candidate's own
 * account: a LinkedIn profile carrying Capital One, Nokia, BridgeBurma and
 * Google exploreCSR roles, and a University of Michigan engineering degree, none
 * of it his, while the dossier beside it stayed correct the entire time.
 * Nothing in the repo recorded it. The surface simply diverged.
 *
 * Three properties are load-bearing and each is checked here, because any one
 * of them alone leaves the hole open:
 *
 *   1. Drift is DETECTED - unexplained entries surface instead of being
 *      reconciled away by a fuzzy match.
 *   2. A check that could not run is NOT a pass. This is the one most likely to
 *      rot: a monitor that reports clean when it could not look is believed, and
 *      believed monitors stop being read.
 *   3. Nothing is WRITTEN. The module exposes no write of any kind.
 */
import { diff, runDriftCheck, renderReport, parseRange, normaliseProfileEntry } from '../jobby/linkedin-drift.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

// The corrected dossier, in the shape seed-dossier.json actually holds.
const DOSSIER = {
  employment: [
    { company: 'XMRT Solutions', title: 'Founder', start: '2023', end: null, current: true },
    { company: 'Party Favor Photo', title: 'Founder & Managing Director', start: '2016', end: null, current: true },
    { company: 'Freelance Journalism', title: 'Freelance Journalist', start: '2020', end: '2021', current: false },
    { company: 'United Service Organizations (USO)', title: 'Senior Multimedia Journalist', start: '2009', end: '2019', current: false },
    { company: 'Allianz', title: 'Project Manager, SaaS Implementation', start: '2008', end: '2009', current: false },
    { company: 'United States Marine Corps', title: 'Combat Correspondent, Sergeant (E-5)', start: '1997', end: '2008', current: false },
  ],
};

// The profile exactly as LinkedIn renders it.
const CLEAN = [
  { title: 'Founder', company: 'XMRT Solutions', dateRange: 'Jan 2023 - Present · 3 yrs 10 mos' },
  { title: 'Founder & Managing Director', company: 'Party Favor Photo', dateRange: 'Jan 2016 - Present · 10 yrs 10 mos' },
  { title: 'Freelance Journalist', company: 'Freelance', dateRange: 'Jan 2020 - Dec 2021 · 2 yrs' },
  { title: 'Senior Multimedia Journalist', company: 'United Service Organizations (USO)', dateRange: 'Jan 2009 - Dec 2019 · 11 yrs' },
  { title: 'Project Manager, SaaS Implementation', company: 'Allianz', dateRange: 'Jan 2008 - Dec 2009 · 2 yrs' },
  { title: 'Combat Correspondent, Sergeant (E-5)', company: 'United States Marine Corps', dateRange: 'Jan 1997 - Dec 2008 · 12 yrs' },
];

// Freelance is filed under "Freelance" on LinkedIn and "Freelance Journalism"
// in the dossier - the same employer written two ways, which role-match folds.
const CLEAN_ALT = CLEAN.map((e) =>
  e.company === 'Freelance' ? { ...e, company: 'Freelance Journalism' } : e);

console.log('\n--- LinkedIn date ranges are read, not guessed ---');
{
  const p = parseRange('Jan 2016 - Present · 10 yrs 10 mos');
  check('start year is read past the duration suffix', p.start === 2016, JSON.stringify(p));
  check('"Present" is the open-ended case, not a missing end', p.current === true && p.end === null, JSON.stringify(p));

  const q = parseRange('Jan 2009 - Dec 2019 · 11 yrs');
  check('a closed range yields both ends', q.start === 2009 && q.end === 2019 && q.current === false, JSON.stringify(q));

  const n = normaliseProfileEntry({ title: 'X', company: 'Y', dateRange: '' });
  check('an entry with no dates is known:false, not zero-valued', n.known === false, JSON.stringify(n));
}

console.log('\n--- a profile that agrees with the dossier is clean ---');
{
  const r = diff({ dossier: DOSSIER, profileEntries: CLEAN });
  check('no drift', r.ok === true, JSON.stringify(r.counts));
  check('all six matched', r.counts.matched === 6, JSON.stringify(r.counts));
  check('nothing unexplained', r.counts.unexplained === 0, JSON.stringify(r.counts));
}

console.log('\n--- months are never compared, because the dossier has none ---');
{
  // Dossier says 2023; profile says Aug 2023. Year-only comparison must pass.
  const shifted = CLEAN.map((e) => (e.company === 'XMRT Solutions' ? { ...e, dateRange: 'Aug 2023 - Present' } : e));
  const r = diff({ dossier: DOSSIER, profileEntries: shifted });
  check('a month the dossier never claimed is not a discrepancy', r.ok === true, JSON.stringify(r.counts));
}

console.log('\n--- the real failure: a fabricated career on the profile ---');
{
  const polluted = [
    // The CTO entry: his company, not his title, and no dates at all.
    { title: 'Chief Technology Officer', company: 'XMRT Solutions', dateRange: '' },
    ...CLEAN,
    { title: 'Software Engineer', company: 'Capital One', dateRange: 'Aug 2024 - Present · 2 yrs 3 mos' },
    { title: 'Software Engineer', company: 'Capital One', dateRange: 'Aug 2023 - Aug 2024 · 1 yr 1 mo' },
    { title: 'Software Engineer Intern', company: 'Capital One', dateRange: 'Jun 2022 - Aug 2022 · 3 mos' },
    { title: 'Full Stack Engineer', company: 'BridgeBurma', dateRange: 'Sep 2020 - Dec 2021 · 1 yr 4 mos' },
    { title: 'Software Engineer Intern', company: 'Nokia', dateRange: 'Jun 2021 - Aug 2021 · 3 mos' },
    { title: 'Research Assistant', company: 'Google exploreCSR', dateRange: 'Jan 2021 - Apr 2021 · 4 mos' },
  ];
  const r = diff({ dossier: DOSSIER, profileEntries: polluted });

  check('drift is detected', r.ok === false, JSON.stringify(r.counts));
  check('all six fabricated roles are unexplained', r.counts.unexplained === 7, JSON.stringify(r.counts));

  const firms = r.unexplained.filter((u) => /Capital One|BridgeBurma|Nokia|Google/.test(u.company)).map((u) => u.company);
  check('Capital One is named', firms.includes('Capital One'), firms.join(','));
  check('BridgeBurma is named', firms.includes('BridgeBurma'), firms.join(','));
  check('Nokia is named', firms.includes('Nokia'), firms.join(','));
  check('Google exploreCSR is named', firms.includes('Google exploreCSR'), firms.join(','));

  check('the CTO entry is surfaced, not deleted and not matched',
    r.undated.some((u) => u.title === 'Chief Technology Officer'), JSON.stringify(r.undated));
  check('the undated CTO did not steal the match for Founder at XMRT',
    r.counts.missing === 0, JSON.stringify(r.counts));

  const text = renderReport(r);
  check('the report names Capital One', /Capital One/.test(text));
  check('the report states nothing was changed', /Nothing was changed/.test(text));
}

console.log('\n--- a deleted role is drift too ---');
{
  const amputated = CLEAN.filter((e) => e.company !== 'Allianz');
  const r = diff({ dossier: DOSSIER, profileEntries: amputated });
  check('a role in the dossier but absent from the profile is reported',
    r.ok === false && r.counts.missing === 1, JSON.stringify(r.counts));
  check('it names Allianz', r.missing[0]?.company === 'Allianz', JSON.stringify(r.missing));
}

console.log('\n--- disagreeing years are reported per field ---');
{
  const wrong = CLEAN.map((e) =>
    e.company === 'Allianz' ? { ...e, dateRange: 'Jan 2008 - Dec 2015 · 8 yrs' } : e);
  const r = diff({ dossier: DOSSIER, profileEntries: wrong });
  check('the role still matches', r.counts.matched === 6, JSON.stringify(r.counts));
  check('the wrong end year is reported', r.mismatched.length === 1, JSON.stringify(r.mismatched));
  check('end is the field, with both values',
    r.mismatched[0]?.fields?.end?.dossier === 2009 && r.mismatched[0]?.fields?.end?.profile === 2015,
    JSON.stringify(r.mismatched[0]?.fields));
  check('start is NOT reported as wrong when it agrees',
    r.mismatched[0]?.fields?.start === undefined, JSON.stringify(r.mismatched[0]?.fields));
}

console.log('\n--- A CHECK THAT COULD NOT RUN IS NOT A PASS ---');
{
  const boom = async () => { throw new Error('Linked API token missing'); };
  const r = await runDriftCheck({ dossier: DOSSIER, readProfile: boom });
  check('status is unavailable, not checked', r.status === 'unavailable', r.status);
  check('ok is FALSE - an unrun check must not read as clean', r.ok === false, String(r.ok));
  check('the reason is carried', /token missing/.test(r.reason || ''), r.reason);
  const text = renderReport(r);
  check('the report says it could not run', /COULD NOT RUN/.test(text));
  check('the report says explicitly it is not a pass', /not a pass/i.test(text));
}

{
  // No reader at all - the module must not quietly fall back to a browser.
  const r = await runDriftCheck({ dossier: DOSSIER });
  check('a missing reader is unavailable, not a pass', r.ok === false && r.status === 'unavailable', JSON.stringify(r));
  check('and it says why', /does not open a browser/.test(r.reason || ''), r.reason);
}

{
  // A reader that returns something unparseable must not become an empty
  // profile, which would trivially look like "everything is missing".
  const junk = async () => ({ nothing: true });
  const r = await runDriftCheck({ dossier: DOSSIER, readProfile: junk });
  check('unparseable output is unavailable, not six missing roles',
    r.status === 'unavailable', JSON.stringify({ status: r.status, ok: r.ok }));
}

console.log('\n--- the report is readable, and names its source ---');
{
  const r = await runDriftCheck({
    dossier: DOSSIER,
    readProfile: async () => ({ entries: CLEAN_ALT, source: 'linked-api' }),
  });
  const text = renderReport(r);
  check('clean with an alternate spelling of one employer', r.ok === true, JSON.stringify(r.counts));
  check('the source is stated', /linked-api/.test(text), text.slice(0, 200));
  check('a clean report still says what it checked', /Dossier roles: 6/.test(text), text.slice(0, 200));
}

console.log('\n--- nothing in this module can write to LinkedIn ---');
{
  const mod = await import('../jobby/linkedin-drift.mjs');
  const exported = Object.keys(mod);
  const suspicious = exported.filter((k) => /write|update|delete|post|put|patch|save|apply|send/i.test(k));
  check('no write-shaped export exists', suspicious.length === 0, suspicious.join(','));
  check('the surface is exactly the four reporting functions',
    ['diff', 'runDriftCheck', 'renderReport'].every((k) => exported.includes(k)),
    exported.join(','));
}

console.log(failures === 0
  ? '\n  the profile is checked against the record, and an unrun check is not a pass'
  : `\n  ${failures} finding(s) need attention`);
process.exitCode = failures === 0 ? 0 : 1;
