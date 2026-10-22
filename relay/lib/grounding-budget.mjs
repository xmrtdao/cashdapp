/**
 * relay/lib/grounding-budget.mjs — how much of the world fits in one prompt.
 *
 * WHY THIS EXISTS
 *
 * The fleet chat grounds every reply in a JSON blob of live system state:
 * services, cron, trust scores, the shared-memory table, the tool catalogue.
 * That blob is what stops an agent inventing a fact, and it is worth having.
 *
 * It was also, by itself, almost the entire prompt. Measured on 2026-10-21
 * against the running relay:
 *
 *   GET /api/fleet-chat/grounded            298,221 characters
 *     sharedContext                         253,692   (85%)
 *     tools                                  42,815   (14%)
 *     everything else                         ~1,400   (<1%)
 *
 * and one fleet chat turn cost 82,973 prompt tokens — measured at the provider
 * that actually served it, not estimated — to produce about 500 output tokens.
 * Over the 30 days to 2026-10-21 the fleet chat path spent 60.9M input
 * tokens across 834 calls: 73,027 in against 501 out, a 145:1 ratio, which is
 * the shape of a prompt that is mostly repeated static payload.
 *
 * The shared-memory table was the reason. Every turn inlined the *whole* value
 * of all 249 notes — a 12.9KB service-topology plan, a 10.2KB gate writeup,
 * a 6KB strategy document — into every prompt, for every agent, on every
 * message. And when a reply triggered a tool call, the whole blob went out a
 * second time for the synthesis pass.
 *
 * WHAT THIS DOES
 *
 * It keeps the index and trims the bodies.
 *
 *   * Every shared-memory note keeps its key, type, description, author and
 *     date, so the model can still see that a note exists, what it is about,
 *     and how fresh it is.
 *   * A note's body is cut to a budget, and a cut note says so — the row
 *     carries value_truncated — so a partial fact is never passed off as a
 *     whole one.
 *   * The full text of any note is one tool call away, and the
 *     shared-context tool has always been able to read a note by key.
 *
 * A trimmed note is still a *pointer*. Nothing is invented and nothing is
 * quietly dropped: what the grounding block no longer carries, the tool can
 * still fetch, and the grounding rules tell the model which to call.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not trim the tool catalogue. Descriptions there carry the argument
 * names, and a tool whose arguments are half-documented is a tool that gets
 * called wrong. Twelve descriptions run over 400 characters; saving about
 * 3,500 characters is not worth 214 tools becoming less reliable.
 *
 * It does not cache the grounding block. A cache would cut the relay's own
 * work — the blob is rebuilt per agent, per turn — but it would not cut a
 * single token out of any prompt, and a cached "real-time" service status is
 * a lie waiting to be told.
 *
 * It does not send cache_control upstream. The provider will cache a
 * byte-identical prefix, and the grounding block is not byte-identical
 * between turns (fetchedAt, live service status, recent chat all move), so
 * there is no prefix to hit. The counters are still recorded, because a
 * provider that starts caching must not look like one that did not.
 */

// ── Budgets ───────────────────────────────────────────────────────────────
//
// The shared-memory budget is the one that matters. 300 characters is enough
// for the opening of a note to say what it is about, which is the only reason
// the body is in the grounding block at all: so the model can decide whether
// it is worth fetching. Overridable so it can be tuned without a code change.
const DEFAULT_VALUE_CHARS = 300;
const DEFAULT_HISTORY_MESSAGE_CHARS = 600;
const DEFAULT_HISTORY_TOTAL_CHARS = 6000;

const ELLIPSIS = '…';

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Slice without splitting a surrogate pair in half. A lone surrogate
 * survives JSON.stringify as an escape, but it reaches the model as noise.
 */
function sliceSafe(text, cap) {
  let s = text.slice(0, cap);
  if (s.length) {
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, s.length - 1);
  }
  return s;
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The preview of one shared-memory value.
 *
 * A value that fits is returned untouched — same object, same type, so
 * nothing downstream has to know this function ran. A value that does not
 * fit comes back as a preview: a string cut at the budget, for objects and
 * arrays the cut JSON text, which keeps the leading keys and therefore the
 * summary that is usually at the front of the note.
 *
 * Either way the caller is told whether the body is the whole of it.
 */
export function previewValue(value, cap) {
  const full = textOf(value);
  const fullChars = full.length;
  if (fullChars <= cap) {
    return { value, truncated: false, fullChars };
  }
  return { value: sliceSafe(full, cap) + ELLIPSIS, truncated: true, fullChars };
}

/**
 * Trim the shared-memory block.
 *
 * Every note keeps its identity. Only the body is cut, and only a body that
 * was cut is marked.
 */
export function budgetSharedContext(rows, opts = {}) {
  const cap = opts.valueChars ?? envInt('GROUNDING_VALUE_CHARS', DEFAULT_VALUE_CHARS);
  const list = Array.isArray(rows) ? rows : [];
  let before = 0;
  let after = 0;
  let truncated = 0;

  const out = list.map(row => {
    if (!row || typeof row !== 'object') return row;
    const { value, truncated: wasCut, fullChars } = previewValue(row.value, cap);
    before += fullChars;
    after += textOf(value).length;
    if (!wasCut) return row;
    truncated += 1;
    // value_truncated is the whole point: a cut body must not read as a
    // whole body. The key is already on the row, so the note is one
    // shared-context tool call away.
    return { ...row, value, value_truncated: true };
  });

  return {
    rows: out,
    report: { notes: list.length, truncated, charsBefore: before, charsAfter: after, valueChars: cap },
  };
}

/**
 * Trim the grounding block as a whole.
 *
 * Only the shared-memory table is touched. Everything else in the block is
 * live state the model is supposed to quote from, and it is small.
 */
export function budgetGrounding(ctx, opts = {}) {
  if (!ctx || typeof ctx !== 'object' || !Array.isArray(ctx.sharedContext)) {
    return {
      context: ctx,
      report: { notes: 0, truncated: 0, charsBefore: 0, charsAfter: 0, valueChars: null },
    };
  }
  const { rows, report } = budgetSharedContext(ctx.sharedContext, opts);
  return { context: { ...ctx, sharedContext: rows }, report };
}

/**
 * Bound the recent conversation that rides along with a prompt.
 *
 * Two problems, one fix. The obvious one is size: the history is added to
 * every prompt, so it is paid for on every turn. The subtle one is that a
 * single message is unbounded — the table holds messages up to 92KB, and one
 * of those in the recent window would be pasted into a prompt whole.
 *
 * The newest messages are kept longest: recent is what the reply is about.
 */
export function budgetHistory(messages, opts = {}) {
  const perMessage = opts.messageChars ?? envInt('GROUNDING_HISTORY_MESSAGE_CHARS', DEFAULT_HISTORY_MESSAGE_CHARS);
  const total = opts.totalChars ?? envInt('GROUNDING_HISTORY_TOTAL_CHARS', DEFAULT_HISTORY_TOTAL_CHARS);
  const list = Array.isArray(messages) ? messages : [];

  let used = 0;
  let cut = 0;
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const content = typeof m.content === 'string' ? m.content : textOf(m.content);
    const room = total - used;
    if (room <= 0) break;
    let body = content;
    if (body.length > perMessage) body = sliceSafe(body, perMessage) + ELLIPSIS;
    if (body.length > room) body = sliceSafe(body, Math.max(0, room - 1)) + ELLIPSIS;
    if (body.length < content.length) cut += 1;
    used += body.length;
    out.push({ ...m, content: body });
  }
  return { messages: out, report: { kept: out.length, of: list.length, cut, totalChars: used } };
}

export const GROUNDING_BUDGET_DEFAULTS = {
  valueChars: DEFAULT_VALUE_CHARS,
  historyMessageChars: DEFAULT_HISTORY_MESSAGE_CHARS,
  historyTotalChars: DEFAULT_HISTORY_TOTAL_CHARS,
};
