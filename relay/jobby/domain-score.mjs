/**
 * The model's half of the judgement: how improvable is this site, and why.
 *
 * The parked/live split is deliberately NOT done here. That is string matching
 * in `domain-classify.mjs`, because a model asked to classify a page produces a
 * confident sentence whether or not the page loaded, and a plausible sentence
 * is the hardest kind of wrong to catch downstream. Classification is mechanical
 * and auditable; this is judgement, which is where a model belongs.
 *
 * What the model is asked is narrower and harder than "is this parked":
 *
 *   - a 0-100 score for how much this site is leaving money on the table
 *   - a verdict: underused (worth contacting) | healthy | parked | unknown
 *   - a reason, in words a person can argue with
 *
 * The reason is not decoration. `app.job_domain_candidates` has a CHECK
 * constraint requiring it, and the migration says why: an opportunity score
 * with no stated reason is not an opportunity, it is a number.
 *
 * Output is parsed defensively. A model that returns prose instead of JSON
 * returns `null`, and a null score is stored as null. It is never coerced to 0
 * or to a guess, because a fabricated 0 and a real low score are indistinguishable
 * on the board and one of them is a lie.
 */

import { ollamaChat } from '../tools/ollama-chat.mjs';

/** The system prompt. Short on purpose: this runs unattended, many times a day,
 *  and the cost of a sprawling prompt is paid on every tick. */
const SYSTEM = `You assess small business websites for a person who offers to rebuild them for free.

You will be given a domain, its page title, some of its visible text, and technical signals.

Score 0-100 for how much this business is losing by having this site:
- 0-40  healthy. A maintained, modern site. There is nothing to sell here.
- 41-70 underused. A real business with a real owner, visibly neglected.
- 71-100 badly neglected. Live but clearly dated, broken, or effectively unusable.

Rules:
- Judge only from what you are given. If the text is thin, say so in the reason.
- Never claim to know who the owner is. You cannot see that.
- "underused" requires evidence of a real business: a service, a location, a
  trade, a phone number, real prose about real work.
- A page with no business content at all is "unknown", whatever it scores.
- Your reason must name the specific thing you saw. "Looks dated" is useless;
  "copyright says 2011 and the nav is four .htm links" is a reason.`;

function buildPrompt(row) {
  const evidence = row.evidence || {};
  const text = (evidence.text || '').slice(0, 1200);
  return `Domain: ${row.domain}
Page title: ${row.page_title || '(none published)'}
Classification: ${row.http_state}
Signature matched: ${row.signature || '(none)'}
Contact address published on the site: ${row.contact_email || '(none found)'}

Visible text:
"""
${text || '(no text captured)'}
"""

Reply with JSON only, no prose, no code fence:
{"score": 0, "verdict": "underused", "reason": "one or two sentences naming what you saw"}`;
}

/**
 * Pull a JSON object out of whatever came back.
 *
 * Models wrap JSON in code fences, prepend "Here is the JSON:", and occasionally
 * return a bare number. All three are handled. Anything genuinely unparseable
 * returns null and the caller stores null - which is the honest outcome.
 */
export function parseScoreResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // First balanced-looking object. Non-greedy on the closing brace fails on
  // nested objects, so this scans for the first '{' and the last '}'.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const scoreNum = Number(parsed.score);
  if (!Number.isFinite(scoreNum)) return null;

  const verdict = ['parked', 'underused', 'healthy', 'unknown']
    .includes(parsed.verdict) ? parsed.verdict : 'unknown';

  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  // The CHECK constraint on the table requires a reason with a score. Returning
  // null here rather than a placeholder means the row is stored unscored and
  // rescored later, instead of carrying a reason nobody wrote.
  if (!reason) return null;

  return {
    score: Math.max(0, Math.min(100, Math.round(scoreNum))),
    verdict,
    reason: reason.slice(0, 600),
  };
}

/**
 * Score one domain row.
 *
 * @param {object} row   a row from `unscoredContactable()`
 * @param {object} opts  { llmChat } injected in tests
 * @returns {Promise<{score:number, verdict:string, reason:string, model:string}|null>}
 */
export async function scoreCandidate(row, opts = {}) {
  const { llmChat = ollamaChat } = opts;

  let answer;
  try {
    answer = await llmChat(buildPrompt(row), {
      system: SYSTEM,
      temperature: 0.2,
      maxTokens: 300,
      timeout: 45000,
      agent: 'domain-scorer',
      source: 'domain-ops',
    });
  } catch (err) {
    // A model failure is not a score of zero. The caller stores nothing and the
    // domain stays on the unscored queue.
    return null;
  }

  if (!answer || answer.error) return null;
  const parsed = parseScoreResponse(answer.response);
  if (!parsed) return null;
  return { ...parsed, model: answer.model || null };
}

/**
 * Score a batch, sequentially.
 *
 * Not concurrent. Each call is up to 45s against a shared model cascade, and a
 * batch of 20 fired at once would queue behind itself and hold the daemon's tick
 * open far longer than it needs to. The daemon is a background job; being
 * slower than it could be is free, being faster than the cascade can serve is
 * not.
 */
export async function scoreBatch(rows, opts = {}) {
  const out = [];
  for (const row of rows || []) {
    const scored = await scoreCandidate(row, opts);
    if (scored) out.push({ id: row.id, domain: row.domain, ...scored });
  }
  return out;
}

export const __test__ = { SYSTEM, buildPrompt, parseScoreResponse };
