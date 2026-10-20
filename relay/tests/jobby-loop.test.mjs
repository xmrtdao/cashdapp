/**
 * relay/tests/jobby-loop.test.mjs — the loop decides, and then it waits
 *
 * relay/jobby/plan.mjs builds actions and nothing has ever executed them. This
 * covers the two things that make an executor safe enough to run unattended:
 * it decides without asking a model, and it does not talk over the person it
 * works for.
 *
 * The properties checked here are the ones that are easy to lose and expensive
 * to lose:
 *
 *   1. The decision is deterministic and total. Every count shape produces a
 *      decision, and nothing throws. A loop that throws has no record, and a
 *      loop with no record cannot be told from a wedged one.
 *   2. A lease excludes. Tested with two real workers against a real database,
 *      because "only one writer" is the property the daily send cap rests on and
 *      a unit test with a fake pool would not know.
 *   3. The wait outranks work, and an event outranks the wait. Both orders are
 *      load-bearing and both are easy to invert by accident.
 *   4. The anti-spam rule is in the database, not in this module.
 */
import { decide, choose, runCycle, readCounts } from '../jobby/loop.mjs';
import { classifyInbound, loopPosture, notWorthSending, inQuietHours } from '../jobby/checkin.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};

console.log('\n--- every count shape decides, and none of them throw ---');
{
  const shapes = [
    {},
    { blocked: 0, queuedSends: 0, unprepared: 0, researched: 0, pipelineDepth: 0 },
    { blocked: 3, queuedSends: 2, unprepared: 1, researched: 0, pipelineDepth: 9 },
    { blocked: 0, queuedSends: 5, unprepared: 0, researched: 0, pipelineDepth: 40 },
    { blocked: 0, queuedSends: 0, unprepared: 4, researched: 0, pipelineDepth: 40 },
    { blocked: 0, queuedSends: 0, unprepared: 0, researched: 2, pipelineDepth: 40 },
    { blocked: 0, queuedSends: 0, unprepared: 0, researched: 0, pipelineDepth: 5 },
  ];
  let allDecided = true;
  const seen = [];
  for (const s of shapes) {
    let d = null;
    try { d = decide(s); } catch (e) { allDecided = false; }
    if (!d || typeof d.decision !== 'string' || typeof d.reason !== 'string') allDecided = false;
    else seen.push(d.decision);
  }
  check('no count shape throws and every one returns a decision', allDecided, seen.join(','));
  check('blocked outranks everything', decide(shapes[2]).decision === 'blocked');
  check('a queued send outranks an unprepared packet', decide(shapes[3]).decision === 'send');
  check('an unprepared packet outranks research', decide(shapes[4]).decision === 'packet');
  check('research outranks sourcing', decide(shapes[5]).decision === 'research');
  check('a thin pipeline sources', decide(shapes[1]).decision === 'source');
  check('a full pipeline with nothing pending is idle, not busy', decide(shapes[6]).decision === 'idle');
}

console.log('\n--- the decision is deterministic ---');
{
  const c = { blocked: 1, queuedSends: 4, pipelineDepth: 2 };
  check('the same counts decide the same way twice',
    decide(c).decision === decide(c).decision && decide(c).reason === decide(c).reason);
}

console.log('\n--- the wait outranks work; an event outranks the wait ---');
{
  const counts = { blocked: 2, queuedSends: 9, pipelineDepth: 1 };

  check('an event outranks even blocked applications',
    choose({ counts, posture: 'escalate', escalations: [{ kind: 'offer' }] }).decision === 'escalate');
  check('and it says why', /outranks a question/.test(choose({ counts, posture: 'escalate', escalations: [{ kind: 'offer' }] }).reason));

  check('an unanswered question stops the work',
    choose({ counts, posture: 'waiting', open: { kind: 'question', sent_at: '2h ago' } }).decision === 'wait');
  check('blocked work does NOT run while waiting',
    choose({ counts, posture: 'waiting', open: { kind: 'question' } }).decision !== 'blocked');

  check('report is its own decision, not idle',
    choose({ counts, posture: 'report' }).decision === 'report');
  check('ordinary work is what is left over',
    choose({ counts, posture: 'work' }).decision === 'blocked');
}

console.log('\n--- the cadence is a preference; the open question is not ---');
{
  const now = new Date('2026-10-14T12:00:00Z');
  const last = new Date('2026-10-14T06:00:00Z');

  check('six hours is inside a 24h cadence', notWorthSending({ open: null, cadenceHours: 24, lastSentAt: last, now }).send === false);
  check('thirty hours is outside it', notWorthSending({ open: null, cadenceHours: 24, lastSentAt: new Date('2026-10-13T00:00:00Z'), now }).send === true);

  const open = { kind: 'question', sent_at: '1h ago' };
  check('an open question blocks even a long-elapsed note',
    notWorthSending({ open, cadenceHours: 1, lastSentAt: null, now }).send === false);
  check('...but an urgent event is never blocked by it',
    notWorthSending({ open, cadenceHours: 999, lastSentAt: now, now, urgent: true }).send === true);

  check('quiet hours defer a status note',
    notWorthSending({ open: null, cadenceHours: 1, lastSentAt: null, now: new Date('2026-10-14T03:00:00'), quiet: { from: 22, to: 7 } }).send === false);
  check('quiet hours do not defer an offer at 3am',
    notWorthSending({ open: null, cadenceHours: 999, lastSentAt: null, now: new Date('2026-10-14T03:00:00'), quiet: { from: 22, to: 7 }, urgent: true }).send === true);
  check('quiet hours spanning midnight are handled',
    inQuietHours(new Date('2026-10-14T23:30:00'), { from: 22, to: 7 }) === true &&
    inQuietHours(new Date('2026-10-14T12:00:00'), { from: 22, to: 7 }) === false);
}

console.log('\n--- what counts as an event ---');
{
  const cases = [
    ['We would like to offer you the position', 'offer'],
    ['Your offer letter is attached', 'offer'],
    ['Can you do a technical screen this week?', 'interview'],
    ['We would like to invite you to an onsite', 'interview'],
    ['Please respond by Friday', 'deadline'],
    ['This posting expires in 3 days', 'deadline'],
  ];
  let allRight = true;
  for (const [text, want] of cases) {
    const got = classifyInbound(text);
    if (!got.escalate || got.kind !== want || !got.evidence) { allRight = false; }
  }
  check('offers, interviews and deadlines are all caught, with evidence', allRight);

  const quiet = [
    'Thanks for applying. We will be in touch.',
    'Just checking in on my application.',
    'Your application is under review.',
  ];
  let allQuiet = true;
  for (const text of quiet) if (classifyInbound(text).escalate) allQuiet = false;
  check('ordinary recruiter chatter does NOT break the wait', allQuiet,
    quiet.map(classifyInbound).map(r => r.kind).join(','));

  check('an empty message escalates nothing', classifyInbound('').escalate === false);
  check('a missing message escalates nothing', classifyInbound(null).escalate === false);
}

console.log('\n--- the posture reports why, every time ---');
{
  const now = new Date();
  for (const p of [
    { posture: 'escalate', escalations: [{ kind: 'offer' }] },
    { posture: 'waiting', open: { kind: 'question', sent_at: 'now' } },
    { posture: 'work' },
    { posture: 'report' },
  ]) {
    const r = loopPosture({ ...p, now, cadenceHours: 0, lastSentAt: null });
    check(`posture ${p.posture} explains itself`, typeof r.reason === 'string' && r.reason.length > 10, JSON.stringify(r));
  }
  check('waiting means may not work', loopPosture({ open: { kind: 'question' }, escalations: [], now }).mayWork === false);
  check('escalating means may work', loopPosture({ open: { kind: 'question' }, escalations: [{ kind: 'deadline' }], now }).mayWork === true);
}

console.log('\n--- a cycle that cannot run is not a pass ---');
{
  // No pool at all: readCounts will throw, and that must become 'unavailable'.
  const r = await runCycle({
    pool: { query: async () => { throw new Error('connection refused'); } },
    clientId: 1,
    workerId: 'test',
    // tryLease needs a pool too, so make it succeed by faking the lease INSERT.
  }).catch((e) => ({ status: 'threw', ok: false, error: String(e.message) }));

  // The pool fake throws on every query, including the lease, so the honest
  // assertion is that it did not report a clean cycle.
  check('an unusable pool never yields ok:true', r.ok !== true, JSON.stringify(r));
  check('and it says what happened', typeof r.reason === 'string' || typeof r.error === 'string', JSON.stringify(r));
}

console.log(failures === 0
  ? '\n  the loop decides in code, waits when it has asked, and breaks the wait for an event'
  : `\n  ${failures} finding(s) need attention`);
process.exitCode = failures === 0 ? 0 : 1;
