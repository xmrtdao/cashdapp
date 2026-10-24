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

// The TOTAL number of characters of note bodies the grounding block may carry.
//
// This is the budget that was missing.
//
// A per-note cap bounds one note. It does not bound the block, because the
// number of notes has no cap either: on 2026-10-23 the shared-memory table
// held 251 notes, and 251 notes at 300 characters each is 66,461 characters
// of body — a grounding block of 152 KB, which is about 38,000 prompt tokens
// on every single fleet-chat turn.
//
// And the notes are not a curated memory. They are a scratchpad that was
// never swept: `hermes-task-handoff-t-mucocw29-lma2`, `grok_build_input_
// 2026_09_18`, `deprecated_tasks_ground_truth_2026-09-07`, `dsh_cycle1_
// complete_2026_09_08`. Records of work that happened, kept forever and
// reread by the model on every turn, for a chat reply that needs a dozen
// words.
//
// So the bodies are rationed. The bodies go to the notes a model is most
// likely to need, and the INDEX — every key, type, description and author —
// is never cut. A note whose body did not make the budget says so.
//
// Nothing is dropped and nothing is invented. The note is still there, still
// named, and one shared-context tool call away:
//
//   "the full text of any note is one tool call away, and the
//    shared-context tool has always been able to read a note by key."
//
// Overridable, so it can be tuned without a code change.
const DEFAULT_SHARED_CONTEXT_CHARS = 12000;

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
 *
 * Two budgets apply, in this order:
 *
 *   1. the PER-NOTE budget, which bounds one body; and
 *   2. the TOTAL budget, which bounds the whole block.
 *
 * The second one is the one that actually matters, because the number of
 * notes is not bounded. Bodies are rationed newest-first: the note a model is
 * most likely to need is the one that was touched most recently, and the
 * table records when each note was last written.
 *
 * A note that does not get a body is marked `value_omitted`. It keeps its
 * key, its type, its description and its author, so the model can see that
 * the note exists, what it is called, and that it is worth one tool call.
 * It is never silently dropped, and it is never presented as empty.
 */
export function budgetSharedContext(rows, opts = {}) {
  const cap = opts.valueChars ?? envInt('GROUNDING_VALUE_CHARS', DEFAULT_VALUE_CHARS);
  const totalBudget = opts.totalChars
    ?? envInt('GROUNDING_SHARED_CONTEXT_CHARS', DEFAULT_SHARED_CONTEXT_CHARS);
  const list = Array.isArray(rows) ? rows : [];
  let before = 0;
  let after = 0;
  let truncated = 0;

  // Per-note first: what each body would look like on its own.
  const perNote = list.map((row, index) => {
    if (!row || typeof row !== 'object') return { row, index, value: row, wasCut: false, fullChars: 0, len: 0 };
    const { value, truncated: wasCut, fullChars } = previewValue(row.value, cap);
    before += fullChars;
    return { row, index, value, wasCut, fullChars, len: textOf(value).length };
  });

  // Then the total. Newest first, so the notes a model is most likely to
  // need get a body; the rest keep their identity and get a tool call.
  //
  // "Newest" is the note's own updated_at where the caller supplied one.
  // The rows arrive with `lastUpdated` (the relay's shape) or `updated_at`.
  const ageOf = (row) => {
    const raw = row?.lastUpdated || row?.updated_at || row?.updatedAt || null;
    if (!raw) return 0;               // unknown age sorts with the newest
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  };
  const order = [...perNote.keys()].sort((a, b) => {
    const ra = perNote[a].row || {};
    const rb = perNote[b].row || {};
    const d = ageOf(rb) - ageOf(ra);
    if (d !== 0) return d;
    return perNote[a].index - perNote[b].index;   // stable
  });

  const bodies = new Map();          // index -> allowed body length
  let spent = 0;
  for (const i of order) {
    const entry = perNote[i];
    if (!entry.row || typeof entry.row !== 'object') continue;
    if (entry.len === 0) { bodies.set(i, 0); continue; }
    if (spent + entry.len <= totalBudget) {
      bodies.set(i, entry.len);
      spent += entry.len;
      continue;
    }
    const room = Math.max(0, totalBudget - spent);
    if (room > 0) {
      // There is room for a PART of this body. Take it.
      const { value, truncated: wasCut, fullChars } = previewValue(entry.row.value, room);
      entry.value = value;
      entry.wasCut = wasCut || entry.wasCut;
      entry.fullChars = fullChars;
      entry.len = textOf(value).length;
      bodies.set(i, entry.len);
      spent += entry.len;
    } else {
      bodies.set(i, 0);
    }
  }

  const out = perNote.map((entry) => {
    const { row } = entry;
    if (!row || typeof row !== 'object') return row;
    const allowed = bodies.get(entry.index) ?? entry.len;
    if (allowed <= 0 && entry.fullChars > 0) {
      // No body at all. The note keeps its identity and says the body is
      // one tool call away.
      const { value: _dropped, ...rest } = row;
      return { ...rest, value_omitted: true, value_chars: entry.fullChars };
    }
    if (allowed < entry.len) {
      const { value, truncated: wasCut } = previewValue(row.value, allowed);
      truncated += 1;
      after += textOf(value).length;
      return { ...row, value, value_truncated: true };
    }
    after += entry.len;
    if (entry.wasCut) {
      truncated += 1;
      return { ...row, value: entry.value, value_truncated: true };
    }
    return row;
  });

  const omitted = out.filter(r => r && r.value_omitted).length;
  return {
    rows: out,
    report: {
      notes: list.length,
      truncated,
      omitted,
      charsBefore: before,
      charsAfter: after,
      valueChars: cap,
      totalChars: totalBudget,
    },
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
  sharedContextChars: DEFAULT_SHARED_CONTEXT_CHARS,
  historyMessageChars: DEFAULT_HISTORY_MESSAGE_CHARS,
  historyTotalChars: DEFAULT_HISTORY_TOTAL_CHARS,
};
