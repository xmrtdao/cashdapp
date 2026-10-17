// ─────────────────────────────────────────────────────────────────────────────
// announcer.mjs — the fleet "outside voice", and the operator's right to stop it.
//
// WHAT THIS IS
// An announcement is a short spoken summary delivered through the browser's own
// speech synthesis on the operator's Nexus dashboard. Two things produce one:
// the 30-minute summary job, and any agent escalating something to a human who
// may not be looking at the screen.
//
// WHY THE STATE LIVES ON THE SERVER
// A mute enforced only in the browser is a mute an agent can talk around. If the
// switch existed solely in the page, the next dashboard code change — or an agent
// that posts with its own announce flag — would put the voice back on without
// anybody deciding to. So the switch is here, on the relay, checked at the moment
// of posting. The browser's toggle is a remote control for this file, not the
// thing that decides.
//
// The asymmetry is deliberate and is the whole design: an agent can ASK for the
// voice (rate-limited, audited, always allowed to try), and only a human holding
// the relay key can turn it off. No amount of agent persistence re-enables it.
//
// A MUTE SILENCES THE VOICE, NOT THE INFORMATION
// A suppressed escalation is still recorded and surfaced as a badge on the
// dashboard. An agent that keeps trying to reach a human who asked for silence
// is exactly the thing the human needs to know about — muting the audio while
// swallowing the attempts would convert "stop talking to me" into "stop telling
// me".
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'relay-data');
const STATE_FILE = join(DATA_DIR, 'announcer-state.json');

const MIN = 60 * 1000;

// Rate limits. These are not anti-abuse theatre: an agent that can announce
// every time it wants turns the operator's speakers into a chattering lobby in
// which the one message that mattered is the one that got talked over.
const COOLDOWN_MS = { normal: 10 * MIN, urgent: 15 * MIN };
const FLEET_WINDOW_MS = 30 * MIN;
const FLEET_MAX_PER_WINDOW = 4;      // escalations + summaries together
const URGENT_MAX_PER_HOUR = 2;
const MAX_SPEECH_CHARS = 900;

const DEFAULTS = {
  muted: false,
  mutedAt: null,
  mutedReason: null,
  mutedBy: null,
  lastSpokenId: null,
  lastSpokenAt: null,
  history: [],          // [{ id, agent, urgency, at, heard }]
  attempts: [],         // suppressed attempts, kept for the badge
};

function load() {
  try {
    if (!existsSync(STATE_FILE)) return { ...DEFAULTS };
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    // A corrupt state file must not take the fleet's voice with it. Start from
    // defaults and say so — silently resetting to UNMUTED would be the one
    // reset the human would mind least and notice most.
    console.warn(`[announcer] state file unreadable (${e.message}); starting from defaults`);
    return { ...DEFAULTS };
  }
}

let state = load();
let saveTimer = null;

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      // Write-then-rename: a half-written state file read back as JSON.parse
      // throws, and the fallback above would then quietly unmute a muted fleet.
      const tmp = STATE_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, STATE_FILE);
    } catch (e) {
      console.error(`[announcer] could not persist state: ${e.message}`);
    }
  }, 250);
  if (saveTimer.unref) saveTimer.unref();
}

function prune() {
  const now = Date.now();
  state.history = state.history.filter(h => now - new Date(h.at).getTime() < 24 * 3600 * 1000);
  state.attempts = state.attempts.filter(a => now - new Date(a.at).getTime() < 6 * 3600 * 1000);
}

export function announcerStatus() {
  prune();
  const now = Date.now();
  const inWindow = state.history.filter(h => now - new Date(h.at).getTime() < FLEET_WINDOW_MS);
  return {
    ok: true,
    muted: state.muted,
    mutedAt: state.mutedAt,
    mutedReason: state.mutedReason,
    mutedBy: state.mutedBy,
    lastSpokenId: state.lastSpokenId,
    lastSpokenAt: state.lastSpokenAt,
    spokenLast24h: state.history.length,
    spokenInWindow: inWindow.length,
    windowBudget: FLEET_MAX_PER_WINDOW,
    suppressed: state.attempts.length,
    suppressedLatest: state.attempts.slice(-5).reverse(),
    cooldownMs: COOLDOWN_MS,
    limits: { fleetWindowMs: FLEET_WINDOW_MS, fleetMax: FLEET_MAX_PER_WINDOW, urgentMaxPerHour: URGENT_MAX_PER_HOUR },
  };
}

// The operator's switch. `by` is recorded because "the voice went off at 3am"
// and "the voice went off at 3am after I asked for silence" are different
// incidents, and the log has to tell them apart.
export function setMuted(muted, { reason, by } = {}) {
  state.muted = !!muted;
  state.mutedAt = state.muted ? new Date().toISOString() : null;
  state.mutedReason = state.muted ? String(reason || 'operator asked for silence').slice(0, 200) : null;
  state.mutedBy = state.muted ? String(by || 'operator').slice(0, 60) : null;
  if (!state.muted) state.attempts = [];   // clearing silence clears its badge
  persist();
  console.log(`[announcer] voice ${state.muted ? 'MUTED' : 'ARMED'} by ${state.mutedBy} — ${state.mutedReason || 'no reason given'}`);
  return announcerStatus();
}

function recordAttempt(entry) {
  state.attempts.push(entry);
  persist();
}

/**
 * Decide whether an announcement may speak, and say why not when it may not.
 *
 * Returns { allowed, reason } and never throws: a refused announcement is a
 * normal outcome that the caller reports to the agent, not an error.
 */
export function checkAnnouncement({ agent, urgency = 'normal' }) {
  prune();
  if (state.muted) {
    return { allowed: false, reason: 'muted', detail: state.mutedReason || 'the operator has the voice off' };
  }
  const now = Date.now();
  const lastFromAgent = [...state.history].reverse().find(h => h.agent === agent);
  if (lastFromAgent) {
    const elapsed = now - new Date(lastFromAgent.at).getTime();
    const need = COOLDOWN_MS[urgency] ?? COOLDOWN_MS.normal;
    if (elapsed < need) {
      return {
        allowed: false,
        reason: 'cooldown',
        detail: `${agent} announced ${Math.round(elapsed / MIN)} min ago; ${Math.round(need / MIN)} min between ${urgency} announcements`,
        retryInMs: need - elapsed,
      };
    }
  }
  const inWindow = state.history.filter(h => now - new Date(h.at).getTime() < FLEET_WINDOW_MS);
  if (inWindow.length >= FLEET_MAX_PER_WINDOW) {
    return { allowed: false, reason: 'fleet-budget', detail: `${FLEET_MAX_PER_WINDOW} announcements already spoken in the last ${FLEET_WINDOW_MS / MIN} minutes` };
  }
  if (urgency === 'urgent') {
    const lastHour = state.history.filter(h => h.urgency === 'urgent' && now - new Date(h.at).getTime() < 3600 * 1000);
    if (lastHour.length >= URGENT_MAX_PER_HOUR) {
      return { allowed: false, reason: 'urgent-budget', detail: `${URGENT_MAX_PER_HOUR} urgent announcements already used this hour` };
    }
  }
  return { allowed: true };
}

/**
 * Claim an announcement slot and produce the message payload to post.
 * Call only AFTER checkAnnouncement returned allowed.
 */
export function claimAnnouncement({ agent, urgency = 'normal', text, speech, id, kind = 'escalation' }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'text is required' };
  const spoken = String(speech || body).replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CHARS);
  const entry = {
    id,
    agent,
    urgency: urgency === 'urgent' ? 'urgent' : 'normal',
    kind,
    at: new Date().toISOString(),
    heard: true,
    chars: spoken.length,
  };
  state.history.push(entry);
  persist();
  return { ok: true, announcement: entry, speech: spoken };
}

/**
 * Record an attempt that was refused. The operator sees the badge; the agent
 * sees the reason. Silence is never mistaken for "nobody asked".
 */
export function noteSuppressed({ agent, urgency = 'normal', reason, detail, text }) {
  recordAttempt({
    agent: String(agent || 'unknown').slice(0, 60),
    urgency: urgency === 'urgent' ? 'urgent' : 'normal',
    reason,
    detail: String(detail || '').slice(0, 240),
    preview: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    at: new Date().toISOString(),
  });
  return announcerStatus();
}

export function markSpoken(id) {
  state.lastSpokenId = id;
  state.lastSpokenAt = new Date().toISOString();
  persist();
}

export { COOLDOWN_MS, FLEET_MAX_PER_WINDOW, MAX_SPEECH_CHARS };