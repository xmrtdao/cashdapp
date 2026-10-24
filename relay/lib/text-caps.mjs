/**
 * relay/lib/text-caps.mjs — the two places a string must not be allowed to grow.
 *
 * WHY THIS EXISTS
 *
 * On 2026-10-23 the activity feed was found to be 4.3 GB, of which 3.7 GB was
 * TOAST: the `metadata` JSONB. The rows were not big. The *strings inside*
 * them were, and they came from one fault:
 *
 *   An agent called `search_knowledge` with the entire fleet-chat conversation
 *   as the search term. The relay put that term straight into a URL. The URL
 *   was 935,775 characters long, `fetch` refused it ("Invalid URL"), and the
 *   error message — which IS the URL — was written to the activity feed
 *   verbatim. 93 such rows a day is 55 MB a day. The same error string was
 *   also written to `function_usage_logs.error_message`, which had reached
 *   1.4 GB from the same fault.
 *
 * So the same text was being paid for twice, on every failure, forever.
 *
 * THE TWO RULES
 *
 *   1. A search term is a term, not a document. It rides in a URL, and a URL
 *      that long is not sent at all. Cut it before it is built.
 *
 *   2. Anything that lands in a row is bounded, and a bounded string says
 *      how long it was. A truncated fact is never passed off as a whole one:
 *      the reader is told the real length, so "this was 935,775 characters"
 *      is never mistaken for "this was the whole error".
 *
 * The second rule is the one that keeps the database honest. The first rule
 * is what makes the tool work.
 *
 * WHERE THE COUNTERPART LIVES
 *
 * The edge function that actually raises the fault runs on Deno and cannot
 * import from `relay/`, so `suite/supabase/functions/ai-chat/index.ts`
 * carries its own copy of these rules. The two must agree, and
 * `relay/tests/text-caps.test.mjs` checks that they do.
 */

// ── Limits ──────────────────────────────────────────────────────────────���─
//
// 200 characters is what the relay has always used for a search term, and it
// is far more than enough to name a knowledge entity. 2,000 characters is
// enough to read an error message and see what went wrong; a longer one is
// a payload that should not have been an error message at all.
export const MAX_SEARCH_TERM_CHARS = 200;
export const MAX_STORED_TEXT_CHARS = 2000;

/**
 * Slice without splitting a surrogate pair in half. A lone surrogate
 * survives JSON.stringify as an escape, but it reaches the reader as noise.
 */
export function sliceSafe(text, cap) {
  let s = text.slice(0, cap);
  if (s.length) {
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, s.length - 1);
  }
  return s;
}

/**
 * Cut a string to a length and say how long it was.
 *
 * The marker is not decoration. A reader who sees a cut string must be able
 * to tell that it was cut — otherwise a 2,000-character prefix of a
 * 935,775-character error reads exactly like a complete error, and the
 * indentation of "it failed at the URL stage" is lost.
 *
 * The original length is kept, not the dropped part, because the dropped
 * part is the part nobody can use and the length is the part that tells the
 * story.
 */
export function capText(value, max = MAX_STORED_TEXT_CHARS) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${sliceSafe(value, max)}… [truncated: ${value.length} chars total]`;
}

/**
 * Cut every string inside a value, however deeply nested.
 *
 * Used at the storage boundary, so a field nobody thought about is still
 * bounded. Objects and arrays are rebuilt; anything that is not a string,
 * number, boolean, null, object or array is passed through untouched.
 */
export function capDeep(value, max = MAX_STORED_TEXT_CHARS) {
  if (typeof value === 'string') return capText(value, max);
  if (Array.isArray(value)) return value.map((v) => capDeep(v, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capDeep(v, max);
    return out;
  }
  return value;
}

/**
 * Cut a search term to something that can travel in a URL.
 *
 * Returns the term and the facts about it, so the caller can record that a
 * cut happened rather than quietly searching for something the caller did
 * not ask for.
 */
export function capSearchTerm(value, max = MAX_SEARCH_TERM_CHARS) {
  const text = typeof value === 'string' ? value : '';
  const original_length = text.length;
  if (original_length <= max) {
    return { term: text, truncated: false, original_length };
  }
  return { term: sliceSafe(text, max), truncated: true, original_length };
}

/**
 * A search term, ready to splice into a URL.
 *
 * Same rule as capSearchTerm, but the caller gets a string and the URL is
 * not built if the term was empty.
 */
export function searchTermForUrl(value, max = MAX_SEARCH_TERM_CHARS) {
  const { term, truncated, original_length } = capSearchTerm(value, max);
  return { term, truncated, original_length, hasTerm: term.length > 0 };
}

export default {
  MAX_SEARCH_TERM_CHARS,
  MAX_STORED_TEXT_CHARS,
  capText,
  capDeep,
  capSearchTerm,
  searchTermForUrl,
  sliceSafe,
};
