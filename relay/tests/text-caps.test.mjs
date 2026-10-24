#!/usr/bin/env node
// Guards the bound on text that travels in a URL or lands in a row.
//
// The fault this guards against
// -----------------------------
//
// On 2026-10-23 the activity feed was 4.3 GB, of which 3.7 GB was TOAST —
// the `metadata` JSONB — and `function_usage_logs` was 1.4 GB.
//
// The cause was one line of code. An agent called `search_knowledge` with
// the whole fleet-chat conversation as the search term. The term was put
// straight into a URL. The URL was 935,775 characters long, `fetch` refused
// it ("Invalid URL"), and the error message — which IS the URL — was written
// to both tables verbatim. 93 such rows a day is 55 MB a day.
//
// So two things have to hold:
//
//   1. A search term is cut before it is put in a URL, so the request is
//      actually sent and the tool actually works.
//   2. Anything that lands in a row is bounded, and a bounded string says
//      how long it was — so a truncated error is never read as a whole one.
//
// The edge function that raises the fault runs on Deno and cannot import
// from `relay/`, so it carries its own copy of the rules. These checks hold
// both copies to the same limits, because a rule that lives in one place
// and drifts in the other is not a rule.
import { readFileSync } from 'node:fs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const { capText, capDeep, capSearchTerm, searchTermForUrl,
        MAX_SEARCH_TERM_CHARS, MAX_STORED_TEXT_CHARS } =
  await import('../lib/text-caps.mjs');

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const aiChat = readFileSync(
  new URL('../../suite/supabase/functions/ai-chat/index.ts', import.meta.url), 'utf8');

section('a search term is a term, not a document');
{
  const small = capSearchTerm('paragraph api');
  check('a short term is untouched', small.term === 'paragraph api' && !small.truncated, small);
  check('a short term reports its length', small.original_length === 13, small);

  const huge = capSearchTerm('x'.repeat(935775));
  check('a huge term is cut', huge.term.length <= MAX_SEARCH_TERM_CHARS, huge.term.length);
  check('the cut is reported', huge.truncated === true, huge);
  check('the real length survives', huge.original_length === 935775, huge.original_length);
  check('the real length is what was lost', huge.term.length < huge.original_length, huge);

  // The term that broke it: the fleet-chat conversation.
  const conversation = 'Recent conversation context:\n[undefined] announcer: Fleet summary...';
  const cut = capSearchTerm(conversation.repeat(5000));
  check('a conversation cannot make an unsendable URL', cut.term.length <= MAX_SEARCH_TERM_CHARS);
  check('the limit is 200 characters', MAX_SEARCH_TERM_CHARS === 200, MAX_SEARCH_TERM_CHARS);
}

section('a bounded string says how long it was');
{
  const small = capText('something went wrong');
  check('a short string is untouched', small === 'something went wrong', small);

  const big = capText('e'.repeat(935775));
  check('a big string is cut', big.length < 935775 + 100, big.length);
  check('the cut is visible', /truncated/.test(big), big.slice(-60));
  check('the real length is in the marker', /935775/.test(big), big.slice(-60));
  check('the limit is 2,000 characters', MAX_STORED_TEXT_CHARS === 2000, MAX_STORED_TEXT_CHARS);

  check('a non-string is passed through', capText(42) === 42);
  check('null is passed through', capText(null) === null);
  check('undefined is passed through', capText(undefined) === undefined);
}

section('a nested row is bounded all the way down');
{
  const row = {
    tool_name: 'search_knowledge',
    args: { search_term: 'q'.repeat(900000) },
    nested: [{ deep: { deeper: 'z'.repeat(5000) } }],
    keep: 'short',
    number: 7,
  };
  const out = capDeep(row);
  check('a deep string is cut', out.nested[0].deep.deeper.length < 5100, out.nested[0].deep.deeper.length);
  check('the cut is marked', /truncated/.test(out.nested[0].deep.deeper));
  check('a short field is untouched', out.keep === 'short', out.keep);
  check('a number is untouched', out.number === 7, out.number);
  check('the tool name is untouched', out.tool_name === 'search_knowledge', out.tool_name);
}

section('the relay bounds every term it puts in a URL');
{
  check('the relay imports the caps', /from '\.\/lib\/text-caps\.mjs'/.test(server));

  // Every term that is spliced into a URL must be cut first.
  check('the knowledge search term is cut',
    /capSearchTerm\(rawQuery\)/.test(server) && /capSearchTerm\(rawTerm\)/.test(server));

  // The handler that had no cut at all.
  const kSearch = server.slice(server.indexOf("'ef:knowledge-search'"), server.indexOf("'ef:generate-payment-link'"));
  check('the knowledge-search handler cuts its term', /capSearchTerm/.test(kSearch));
  check('the knowledge-search handler never encodes an unbounded term',
    !/encodeURIComponent\(query\)/.test(kSearch), 'raw query still reaches the URL');
  check('the knowledge-search handler reports the cut',
    /search_term_truncated/.test(kSearch));

  const kHandler = server.slice(server.indexOf("'ef:knowledge': async"), server.indexOf("'ef:knowledge-search'"));
  check('the knowledge handler cuts its term', /capSearchTerm/.test(kHandler));
  check('the knowledge handler reports the cut', /search_term_truncated/.test(kHandler));

  // GitHub code search took an agent's query straight into a URL.
  check('the github code search cuts its query', /capSearchTerm\(data\?\.query/.test(server));
}

section('the edge function bounds the same things');
{
  check('the edge function has the search-term cut', /function boundSearchTerm/.test(aiChat));
  check('the edge function has the row bound', /function boundForStorage/.test(aiChat));
  check('the edge function has the text bound', /function boundText/.test(aiChat));

  // The two copies must agree, or the rule drifts.
  check('the edge function uses a 200-character term limit',
    /const MAX_SEARCH_TERM = 200;/.test(aiChat), 'the edge limit differs');
  check('the edge function uses a 2,000-character row limit',
    /const MAX_ROW_STRING = 2000;/.test(aiChat), 'the edge limit differs');

  // The row must be bounded at the boundary, so a field nobody thought
  // about is still bounded.
  check('the function-usage row is bounded',
    /function_usage_logs\)\.insert\(boundForStorage\(entry\)\)/.test(aiChat));
  check('the activity row is bounded',
    /eliza_activity_log\)\.insert\(boundForStorage\(entry\)\)/.test(aiChat));
  check('the tool-activity row is bounded',
    /body: JSON\.stringify\(boundForStorage\(\{/.test(aiChat));

  // The error is bounded where it is born, not only where it is stored.
  check('the error is bounded at the point it is born',
    /error_message = boundText\(error\?\.message/.test(aiChat));
  check('the arguments are bounded before they are logged',
    /boundForStorage\(parseToolArguments\(args\)\)/.test(aiChat));

  // The fault itself: a term spliced into a URL with no cut.
  check('the knowledge search term is cut',
    /boundSearchTerm\(rawSearchTerm\)/.test(aiChat));
  check('the recall name is cut',
    /boundSearchTerm\(entityName\)/.test(aiChat));
  check('the tool filter is cut',
    /boundSearchTerm\(query\)/.test(aiChat));
  check('the knowledge search reports the cut',
    /search_term_truncated: searchTermTruncated/.test(aiChat));

  // No URL in the edge function may take an unbounded caller-supplied term.
  const encoded = [...aiChat.matchAll(/encodeURIComponent\(([^)]+)\)/g)].map(m => m[1].trim());
  check('every encoded URL term is a bounded one',
    encoded.every(v => ['search_term', 'boundedEntityName', 'this.ipAddress', 'this.sessionId'].includes(v)),
    encoded);
}

section('nothing unbounded still reaches the activity feed');
{
  // The relay writes the relay's own rows; the edge function writes the
  // tool rows. Both go through a bound now.
  check('the relay bounds what it logs', /capDeep|capText/.test(server));

  // A cut must never be silent. If the marker is removed from the caps, a
  // truncated error would read like a whole one.
  const caps = readFileSync(new URL('../lib/text-caps.mjs', import.meta.url), 'utf8');
  check('the marker names the original length', /truncated: \$\{value\.length\} chars total/.test(caps));
  check('the edge copy marks the cut too',
    /truncated: \$\{value\.length\} chars total/.test(aiChat));
}

console.log(fails === 0
  ? '\n  a term is a term, a row is a row, and a cut says so'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
