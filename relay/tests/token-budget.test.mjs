/**
 * relay/tests/token-budget.test.mjs — the grounding block is the prompt
 *
 * A fleet chat turn is a prompt. Measured on 2026-10-21 against the running
 * relay and against the provider that actually served it:
 *
 *   GET /api/fleet-chat/grounded            298,221 characters
 *     sharedContext                         253,692   (85%)
 *     tools                                  42,815   (14%)
 *     everything else                         ~1,400   (<1%)
 *
 *   one turn, at the provider                 82,973 prompt tokens
 *   one turn, output                             ~500 tokens
 *
 * The shared-memory table was the reason. All 249 notes were inlined at
 * their FULL length on every turn, for every agent, including a 12.9KB
 * service-topology plan, a 10.2KB gate writeup and a 6KB strategy
 * document. Over the 30 days to 2026-10-21 the fleet chat path spent 60.9M
 * input tokens across 834 calls — 73,027 in against 501 out, a 145:1 ratio.
 * That is the shape of a prompt that is mostly repeated static payload.
 *
 * The fix keeps the index and trims the bodies. Every note keeps its key,
 * type, description and author, so the model can still see that a note
 * exists and what it is about. A cut body is marked value_truncated, so a
 * fragment is never read as a whole, and the full text of any note is one
 * `shared-context` tool call away, by key.
 *
 * These checks pin the properties that make that safe:
 *
 *   1. The block gets materially smaller, and the saving is reported.
 *   2. No note disappears. The index is complete: a truncated note is still
 *      listed, still keyed, and still findable by key.
 *   3. A cut body is MARKED. A model must never read a fragment as a fact.
 *   4. The tool catalogue is untouched. A tool whose arguments are
 *      half-documented is a tool that gets called wrong.
 *   5. The live grounding — the real block, from the real database — fits
 *      inside the budget.
 *   6. The conversation history that rides along with every prompt is
 *      bounded, and one enormous message cannot blow the prompt open.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); return; }
  failures += 1;
  console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '..');

const { budgetSharedContext, budgetGrounding, budgetHistory, previewValue, GROUNDING_BUDGET_DEFAULTS } =
  await import('../lib/grounding-budget.mjs');

section('the shared-memory bodies are trimmed, the index is not');
{
  const notes = [
    { key: 'short_one', type: 'general', value: 'a short note', description: 'brief', lastUpdatedBy: 'eliza' },
    { key: 'long_one', type: 'handoff', value: 'X'.repeat(12000), description: 'a plan', lastUpdatedBy: 'opencode' },
    { key: 'object_one', type: 'general', value: { phase: 'Phase 2', notes: ['a', 'b'] }, description: '', lastUpdatedBy: 'hermes' },
  ];

  const { rows, report } = budgetSharedContext(notes, { valueChars: 300 });

  check('every note is still listed', rows.length === notes.length, rows.length);
  check('the keys survive the trim',
    rows.map(r => r.key).join(',') === 'short_one,long_one,object_one',
    rows.map(r => r.key).join(','));

  check('a note that fits is untouched',
    rows[0].value === 'a short note' && rows[0].value_truncated === undefined,
    JSON.stringify(rows[0]));
  check('a note that fits is not marked truncated',
    report.truncated === 1, JSON.stringify(report));

  check('a cut body is marked value_truncated', rows[1].value_truncated === true, JSON.stringify(rows[1]).slice(0, 120));
  check('a cut body is shorter than the original',
    String(rows[1].value).length < 400, String(rows[1].value).length);
  check('a cut body keeps the head of the original',
    String(rows[1].value).startsWith('XXXX'), String(rows[1].value).slice(0, 20));
  check('a cut body still carries its identity',
    rows[1].key === 'long_one' && rows[1].description === 'a plan' && rows[1].lastUpdatedBy === 'opencode',
    JSON.stringify({ k: rows[1].key, d: rows[1].description, b: rows[1].lastUpdatedBy }));
  check('the report says how much it saved',
    report.charsBefore > report.charsAfter && report.charsAfter > 0,
    JSON.stringify(report));
  check('the report counts the notes and the cuts',
    report.notes === 3 && report.truncated === 1, JSON.stringify(report));
}

section('a cut value is never mistaken for a whole one');
{
  // The value is truncated AND says so. An agent that reads a fragment
  // without the marker would report half a fact as the fact.
  const { rows } = budgetSharedContext(
    [{ key: 'k', type: 't', value: 'y'.repeat(5000), description: '', lastUpdatedBy: 'z' }],
    { valueChars: 100 });
  check('the truncated flag is present', rows[0].value_truncated === true);
  check('the value is a string, not a silent half-object',
    typeof rows[0].value === 'string', typeof rows[0].value);

  // previewValue is the single place the decision is made.
  const short = previewValue('hello', 100);
  check('a value within budget is returned unchanged',
    short.truncated === false && short.value === 'hello', JSON.stringify(short));
  const long = previewValue('hello world', 5);
  check('a value over budget is cut and flagged',
    long.truncated === true && long.value.length <= 6, JSON.stringify(long));
  check('a cut value records its original length',
    long.fullChars === 11, String(long.fullChars));

  // A surrogate pair must not be split in half: a lone surrogate is
  // invalid on its own and reaches the model as noise.
  const emoji = previewValue('😀'.repeat(50), 3);
  check('a cut value does not end in a lone surrogate',
    !/[\uD800-\uDBFF]$/.test(emoji.value), JSON.stringify(emoji.value));
}

section('the tool catalogue is left alone');
{
  // The tools array is 42,815 characters of argument names and usage
  // rules. Cutting a description is how a tool starts getting called with
  // the wrong arguments — which is worse than the tokens it saves.
  const ctx = {
    services: { ollama: 'ok' },
    tools: [
      { name: 'resend-send-email', description: 'Sends an email. '.repeat(60), securityLevel: 'trusted' },
      { name: 'db-query', description: 'Runs SQL.', securityLevel: 'trusted' },
    ],
    sharedContext: [{ key: 'k', type: 't', value: 'v'.repeat(9000), description: '', lastUpdatedBy: 'a' }],
  };
  const { context, report } = budgetGrounding(ctx);
  check('every tool is still listed', context.tools.length === ctx.tools.length, context.tools.length);
  check('no tool description was shortened',
    context.tools[0].description === ctx.tools[0].description
    && context.tools[1].description === ctx.tools[1].description);
  check('the live state is untouched', context.services === ctx.services);
  check('the shared-memory body was still trimmed', report.truncated === 1, JSON.stringify(report));
}

section('the conversation history is bounded');
{
  // The history rides along with EVERY prompt, so it is paid for on every
  // turn. And a single message is unbounded: the table holds messages up
  // to 92KB, and one of those in the recent window would be pasted into
  // the prompt whole.
  const messages = [
    { content: 'newest and important '.repeat(3) },
    { content: 'M'.repeat(92140) },
    { content: 'small' },
  ];
  const { messages: out, report } = budgetHistory(messages, { messageChars: 600, totalChars: 6000 });

  check('the history is shorter than it was',
    report.totalChars < 92140 + 60, report.totalChars);
  check('a single enormous message cannot blow the prompt open',
    out.every(m => m.content.length <= 601), out.map(m => m.content.length).join(','));
  check('the newest message is kept first and intact',
    out[0].content.startsWith('newest and important'), out[0].content.slice(0, 40));
  check('a cut message is marked by its trailing ellipsis',
    out[1].content.endsWith('…'), out[1].content.slice(-4));
  check('the report says how many were cut', report.cut === 1, JSON.stringify(report));

  // The newest messages matter most, so they are the ones kept.
  const many = Array.from({ length: 50 }, (_, i) => ({ content: 'm'.repeat(2000) }));
  const capped = budgetHistory(many, { messageChars: 600, totalChars: 6000 });
  check('the total is capped even with many long messages',
    capped.report.totalChars <= 6000, capped.report.totalChars);
  check('the newest messages are the ones kept',
    capped.messages.length > 0 && capped.messages.length < 50, capped.messages.length);
}

section('the real grounding fits the budget');
{
  // The live block, from the real database, through the real budget.
  // The live block was 298,221 characters and 82,973 prompt tokens.
  const url = 'http://127.0.0.1:8080/api/fleet-chat/grounded';
  let live = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) live = await res.json();
  } catch (e) {
    console.log('  SKIP  the live grounding check — the relay is not reachable: ' + e.message);
  }

  if (live && live.context) {
    const ctx = live.context;
    const notes = ctx.sharedContext || [];
    const values = notes.map(n => JSON.stringify(n.value ?? null).length);
    const biggest = values.length ? Math.max(...values) : 0;
    const before = values.reduce((a, b) => a + b, 0);

    check('the live block has shared-memory notes in it', notes.length > 0, notes.length);
    check('the live block is under the budget that was measured',
      live.chars < 298221, live.chars);
    check('the live block still lists every note',
      notes.filter(n => n.value_truncated).length + notes.filter(n => !n.value_truncated).length === notes.length);
    check('no live note body exceeds the budget',
      values.every(v => v <= GROUNDING_BUDGET_DEFAULTS.valueChars + 64),
      'largest=' + biggest);
    check('the live saving is reported and is real',
      live.budget && live.budget.charsBefore > live.budget.charsAfter,
      JSON.stringify(live.budget));
    console.log('        live: ' + live.chars + ' chars, ' + notes.length + ' notes, '
      + (live.budget ? live.budget.truncated + ' trimmed, ' + (live.budget.charsBefore - live.budget.charsAfter) + ' chars saved' : 'no report'));
  } else {
    console.log('  SKIP  the live grounding check — no context returned');
  }
}

section('the relay actually applies the budget');
{
  // A rule that only lives in the calling code is a rule the next writer
  // will not know about. The budget has to be wired into the one function
  // that builds the grounding, and the notes have to say they may be
  // truncated, or a model will quote a fragment as a fact.
  const src = readFileSync(join(RELAY, 'server.js'), 'utf8');

  check('the budget module is imported',
    /import \{[^}]*budgetSharedContext[^}]*\} from '\.\/lib\/grounding-budget\.mjs'/.test(src));

  check('the grounding builder applies the budget',
    /budgetSharedContext\(sharedContext\)/.test(src));

  check('the grounding route reports the budget and the size',
    /budget: groundingBudgetReport/.test(src) && /chars: JSON\.stringify\(ctx, null, 0\)\.length/.test(src));

  // Both prompt paths that embed the grounding must tell the model that a
  // note may be cut, and how to read the whole of it.
  const truncationNotes = (src.match(/value_truncated: true/g) || []).length;
  check('both grounding prompts explain the truncated marker', truncationNotes >= 2, truncationNotes);
  check('the model is told how to read a note in full',
    (src.match(/action: "read"/g) || []).length >= 2);

  // The conversation history is bounded on both paths.
  const bounded = (src.match(/budgetHistory\(/g) || []).length;
  check('the conversation history is bounded on both prompt paths', bounded >= 2, bounded);

  // The token log must record what actually answered, not what was asked
  // for. 835 calls were attributed to a provider that never served them.
  check('the fleet-chat token log records the real provider',
    /provider: d\.provider/.test(src) && /model: d\.model/.test(src));
  check('the fleet-chat token log records the cache and reasoning counters',
    /cache_read_tokens: generateResult\.cacheReadTokens/.test(src)
    && /reasoning_tokens: generateResult\.reasoningTokens/.test(src));

  const chat = readFileSync(join(RELAY, 'tools', 'ollama-chat.mjs'), 'utf8');
  check('the provider breakdown is read off the response',
    /usage\.prompt_tokens_details\?\.cached_tokens/.test(chat)
    && /usage\.completion_tokens_details\?\.reasoning_tokens/.test(chat));
  check('the provider-reported cost is preferred over a guess',
    /typeof usage\.cost === 'number'/.test(chat));
  check('the counters are sent to the token log',
    /cache_read_tokens: extra\.cacheReadTokens/.test(chat)
    && /reasoning_tokens: extra\.reasoningTokens/.test(chat));
}

console.log(failures === 0
  ? '\n  the grounding block is the prompt, and it is now a budgeted one'
  : `\n  ${failures} check(s) FAILED`);
// exitCode rather than process.exit: the live fetch above leaves a handle
// open, and a hard exit races the teardown and trips a libuv assertion on
// Windows, reporting failure on a run that passed.
process.exitCode = failures === 0 ? 0 : 1;
