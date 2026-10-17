// ─────────────────────────────────────────────────────────────────────────────
// fleet-announcer.js — the dashboard end of the fleet's outside voice.
//
// WHAT THIS DOES
// Speaks ONE kind of message: announcements. Ordinary fleet chat — an agent
// replying to a thread, a tool card, the operator's own message — is never read
// aloud. The rule is a flag on the message (`announce === true`), set server-side
// only for messages that passed the announcer's gates. Nothing is matched by
// reading the text and guessing, because "this looks like a summary" is exactly
// the kind of heuristic that eventually reads something aloud that should not be.
//
// WHY BROWSER SPEECH SYNTHESIS
// It is free, offline, and already on the operator's machine. No key, no vendor,
// no per-character cost, and nothing leaves the browser — which matters for a
// system whose whole premise is not shipping the fleet's contents to a service.
//
// THE TWO GATES, and why there are two
//   1. The relay's switch (GET/POST /api/announcer). This is the operator's
//      decision, it outlives the tab, and no agent can lift it.
//   2. This tab's audio unlock. Browsers will not produce sound until a user
//      gesture has happened on the page, so an armed relay is not yet a speaking
//      one. Both have to be true, and the button says which one is missing.
//
// A SUPPRESSED ESCALATION IS NOT HIDDEN
// When the operator has the voice off and an agent tries anyway, the attempt is
// counted and shown. Muting is not "pretend nobody called": an agent that keeps
// trying to reach a human who asked for silence is exactly the thing the human
// needs to know about.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  var KEY = {
    enabled: 'fleetAnnouncer.enabled',   // this tab's audio unlock
    lastSpokenTs: 'fleetAnnouncer.lastSpokenTs',
    voice: 'fleetAnnouncer.voice',
    rate: 'fleetAnnouncer.rate',
  };

  var S = {
    relay: { muted: false },
    unlocked: false,
    speaking: false,
    queue: [],
    lastAnnouncement: null,
    lastSpokenId: null,
    voices: [],
    ui: {},
    mutedByUserThisSession: false,
    // Announcement ids already handled by THIS tab. Keyed by id, because the
    // poll hands over freshly parsed objects every 3 seconds — see offer().
    seen: {},
    primed: false,
    speakStartedAt: 0,
    speakChars: 0,
  };

  // ── helpers ──
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* private mode: fall back to in-memory only */ }
    return null;
  }
  function el(id) { return document.getElementById(id); }
  function api(path, opts) {
    opts = opts || {};
    var f = window.apiFetch ? window.apiFetch(path, opts) : fetch(path, opts);
    return f;
  }
  function hasTTS() { return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined'; }

  // Markdown, emoji and URLs all read terribly aloud. This is the difference
  // between "three tasks moved, two blocked" and "asterisk asterisk Investigate
  // cron job errors asterisk asterisk".
  function forSpeech(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^[>#\s]+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/[|]/g, ',')
      // Symbols, dingbats, arrows and pictographs all become either silence or
      // a name the engine reads aloud ("white heavy check mark"). Either way it
      // is noise in a sentence written for ears.
      .replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u2500-\u27BF\u2B00-\u2BFF]/g, ' ')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}]/gu, ' ')
      .replace(/[\uFE0E\uFE0F\u200D]/g, ' ')
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── voice selection ──
  function loadVoices() {
    if (!hasTTS()) return [];
    try { S.voices = window.speechSynthesis.getVoices() || []; } catch (e) { S.voices = []; }
    return S.voices;
  }

  function pickVoice() {
    var wanted = store(KEY.voice);
    var en = S.voices.filter(function (v) { return /^en(-|_|$)/i.test(v.lang || ''); });
    if (!en.length) en = S.voices;
    if (wanted) {
      for (var i = 0; i < en.length; i++) if (en[i].voiceURI === wanted || en[i].name === wanted) return en[i];
    }
    // Default: a local (offline) voice, because the whole point is that this
    // works without a network round trip. Falls back to any English voice.
    var local = en.filter(function (v) { return v.localService; });
    return (local[0] || en[0] || null);
  }

  function refreshVoices() {
    loadVoices();
    if (S.ui.voice) {
      var cur = pickVoice();
      S.ui.voice.innerHTML = '';
      var en = S.voices.filter(function (v) { return /^en(-|_|$)/i.test(v.lang || ''); });
      var list = en.length ? en : S.voices;
      list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = v.name + (v.localService ? '' : ' (network)');
        S.ui.voice.appendChild(o);
      });
      if (cur) S.ui.voice.value = cur.voiceURI;
    }
    render();
  }

  // ── speaking ──
  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    var tag = (a.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || a.isContentEditable === true;
  }

  function say(text, opts) {
    opts = opts || {};
    if (!hasTTS()) return;
    var clean = forSpeech(text);
    if (!clean) return;
    var u = new SpeechSynthesisUtterance(clean);
    var v = pickVoice();
    if (v) u.voice = v;
    u.rate = parseFloat(store(KEY.rate) || '1.05');
    u.pitch = 1.0;
    u.volume = 1.0;
    // `ended` guards the ordering below. speak() is asynchronous in a browser,
    // but not by contract: a short utterance on a loaded engine can reach onend
    // before the next statement runs, and assigning S.speaking = true afterwards
    // would then leave the announcer wedged for the rest of the session.
    var ended = false;
    var finish = function () {
      ended = true;
      S.speaking = false;
      S.speakStartedAt = 0;
      render();
      pump();
    };
    u.onstart = function () { if (ended) return; S.speaking = true; S.speakStartedAt = Date.now(); render(); };
    u.onend = finish;
    u.onerror = finish;
    try {
      window.speechSynthesis.cancel();     // clears the stuck-utterance state some builds leave behind
      window.speechSynthesis.speak(u);
      if (!ended) { S.speaking = true; S.speakStartedAt = Date.now(); }
    } catch (e) {
      console.warn('[fleet-announcer] speech failed:', e && e.message);
      ended = true;
      S.speaking = false;
      S.speakStartedAt = 0;
    }
    render();
  }

  // Recover from a wedge.
  //
  // `S.speaking` is cleared by the utterance's own onend/onerror, and those do
  // not always arrive: Chrome silently drops utterances longer than about 15
  // seconds, and a `cancel()` at the wrong moment can leave the engine paused
  // with no event at all. When that happens the flag stays true forever, pump()
  // refuses to speak anything, and the announcer goes quietly dead — the worst
  // possible failure for a feature whose only job is to be noticed.
  //
  // So the flag is treated as a claim, not a fact: if the engine is not
  // actually speaking, or has been "speaking" far longer than the text could
  // possibly take, the claim is dropped and the queue moves again.
  function recoverIfWedged() {
    if (!S.speaking) return false;
    if (!hasTTS()) { S.speaking = false; return true; }
    let stuck = false;
    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        stuck = true;                       // it was paused, not finished
      } else if (!window.speechSynthesis.speaking) {
        stuck = true;                       // engine says it is not speaking
      }
    } catch (e) { stuck = true; }
    if (!stuck && S.speakStartedAt) {
      const expected = Math.max(5000, S.speakChars * 400);
      if (Date.now() - S.speakStartedAt > expected) stuck = true;   // overran its own length
    }
    if (stuck) {
      S.speaking = false;
      S.speakStartedAt = 0;
      render();
      return true;
    }
    return false;
  }

  function pump() {
    recoverIfWedged();
    if (!S.queue.length) { S.speaking = false; render(); return; }
    if (!armed() || S.speaking) { render(); return; }
    // Never talk over the operator. A queue entry waits rather than speaking,
    // and the next poll or input event retries — so a human mid-sentence is not
    // interrupted by a machine.
    if (isTyping()) { render(); return; }
    var next = S.queue.shift();
    S.lastAnnouncement = next;
    S.speakChars = forSpeech(next.speech || next.message).length;
    say(next.speech || next.message, { urgent: next.urgent });
    api('/api/announcer/spoken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: next.id }),
    }).catch(function () {});
  }

  function armed() {
    return !!(S.relay && S.relay.muted === false && S.unlocked && hasTTS());
  }

  function offer(messages) {
    if (!messages || !messages.length) return;
    // Dedup by message ID, held in a set that outlives the poll.
    //
    // This used to mark the message object itself (`m._annSeen = true`), which
    // looked correct and was not: the dashboard polls every 3 seconds and each
    // poll parses a fresh JSON array, so every object was new and every mark was
    // gone. The same announcement was therefore re-queued on every single poll
    // and read aloud over and over — the operator heard one announcement three
    // times in a row. A set keyed by id is the thing that can remember.
    var fresh = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m || m.announce !== true || m.id == null) continue;
      if (S.seen[m.id]) continue;
      S.seen[m.id] = true;
      fresh.push(m);
    }
    if (!fresh.length) return;
    fresh.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });

    var lastTs = parseInt(store(KEY.lastSpokenTs) || '0', 10) || 0;
    if (!S.primed) {
      // First load: do not read the backlog aloud. Everything already on the
      // board was seen (or ignored) in silence once; replaying every summary
      // from before the page was opened is not an announcement.
      S.primed = true;
      var newest = fresh.reduce(function (acc, m) { return Math.max(acc, m.ts || 0); }, 0);
      if (newest) store(KEY.lastSpokenTs, String(newest));
      return;
    }
    fresh = fresh.filter(function (m) { return (m.ts || 0) > lastTs; });
    if (!fresh.length) return;

    if (S.queue.length) {
      // Only ever the newest matters; a backlog read in order is the opposite
      // of a summary.
      S.queue = [fresh[fresh.length - 1]];
    } else {
      S.queue = fresh;
    }
    var urgent = S.queue.filter(function (m) { return m.urgency === 'urgent'; });
    if (urgent.length) {
      var u = urgent[urgent.length - 1];
      S.queue = [u];
      if (hasTTS()) window.speechSynthesis.cancel();   // urgency interrupts
      S.speaking = false;
    }
    pump();
  }

  // ── relay state ──
  function refreshStatus() {
    return api('/api/announcer').then(function (r) { return r.json(); })
      .then(function (s) {
        S.relay = s;
        // Muting has to clear what is waiting, not park it. A queue left full
        // means the next un-mute speaks stale announcements the operator asked
        // never to hear — and it keeps the "N queued" counter lit while silent.
        if (s && s.muted && S.queue.length) {
          S.queue = [];
          if (hasTTS()) window.speechSynthesis.cancel();
          S.speaking = false;
        }
        render();
        return s;
      })
      .catch(function () { return null; });
  }

  function setVoice(muted, reason) {
    // Optimistic, then reconciled.
    //
    // The switch has to feel instant — an operator who asked for silence should
    // not sit there watching a button that still says "voice on" until a round
    // trip completes. But optimism without reconciliation is worse: if the POST
    // is refused (stale key, relay restarting) the page would keep claiming a
    // state the relay does not hold, and the next announcement would either be
    // wrongly silenced or wrongly spoken. So: draw the intended state now, and
    // let the relay's answer overwrite it either way.
    S.relay = Object.assign({}, S.relay, { muted: !!muted, pending: true });
    render();
    return api('/api/announcer/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: muted, reason: reason || 'operator toggled the fleet announcer' }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (out) {
        S.relay.pending = false;
        if (out.body && out.body.ok) { S.relay = out.body; render(); return out.body; }
        // The relay refused. Put the truth back — the operator asked for
        // silence and did not get it, which is exactly when a wrong label
        // matters most.
        console.warn('[fleet-announcer] voice switch refused:', out.body && out.body.error);
        refreshStatus();
        return null;
      })
      .catch(function (e) {
        S.relay.pending = false;
        console.warn('[fleet-announcer] voice switch failed:', e && e.message);
        refreshStatus();
        return null;
      });
  }

  // ── UI ──
  function render() {
    if (!S.ui.button) return;
    var muted = S.relay && S.relay.muted === true;
    var noTTS = !hasTTS();
    var b = S.ui.button, label, color, title;

    if (muted) {
      label = S.relay.pending ? 'switching…' : 'voice off'; color = '#6C7263';
      title = 'Agents cannot speak. They can still post to fleet chat.'
        + (S.relay.mutedReason ? '\nReason given: ' + S.relay.mutedReason : '')
        + '\nClick to switch the voice back on.';
    } else if (noTTS) {
      label = 'no browser TTS'; color = '#E4695A';
      title = 'This browser has no speech synthesis. Announcements stay on the board as text.';
    } else if (!S.unlocked) {
      label = 'tap to arm'; color = '#DC8A1E';
      title = 'The voice is armed, but the browser will not play sound until you interact with this page.\nClick once to switch it on.';
    } else if (S.speaking) {
      label = 'speaking…'; color = '#4ade80';
      title = 'Reading the last announcement aloud. Click to stop.';
    } else {
      label = 'voice on'; color = '#4ade80';
      title = 'Announcements are spoken aloud. Click to switch the voice off.';
    }

    b.textContent = (muted ? '🔇 ' : noTTS ? '⚠️ ' : (S.unlocked && !muted) ? '🔊 ' : '🔈 ') + label;
    b.style.color = color;
    b.style.borderColor = color;
    b.title = title;

    if (S.ui.status) {
      var parts = [];
      if (S.relay && S.relay.suppressed) {
        parts.push('📵 ' + S.relay.suppressed + ' escalation' + (S.relay.suppressed === 1 ? '' : 's') + ' suppressed');
      }
      if (S.relay && S.relay.spokenLast24h) parts.push('spoken 24h: ' + S.relay.spokenLast24h);
      if (S.queue.length) parts.push(S.queue.length + ' queued');
      S.ui.status.textContent = parts.join(' · ');
      S.ui.status.style.color = (S.relay && S.relay.suppressed) ? '#DC8A1E' : '#6C7263';
    }
    if (S.ui.stop) S.ui.stop.style.display = (S.speaking || S.queue.length) ? '' : 'none';
    if (S.ui.repeat) S.ui.repeat.style.display = S.lastAnnouncement ? '' : 'none';
  }

  function buildUI() {
    var host = el('fleet-chat-status');
    if (!host || !host.parentNode) return false;
    var row = host.parentNode;

    var wrap = document.createElement('span');
    wrap.setAttribute('id', 'fleet-announcer-controls');
    wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap;';

    var b = document.createElement('span');
    b.id = 'fleet-announcer-toggle';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('tabindex', '0');
    b.style.cssText = 'cursor:pointer;padding:1px 7px;border:1px solid;border-radius:3px;font-size:10px;user-select:none;';
    b.onclick = toggle;
    b.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };

    var stop = document.createElement('span');
    stop.id = 'fleet-announcer-stop';
    stop.style.cssText = 'cursor:pointer;padding:1px 6px;border:1px solid #3a3a5a;border-radius:3px;color:#DC8A1E;font-size:10px;user-select:none;';
    stop.title = 'Stop talking now. The relay stays armed.';
    stop.textContent = 'stop';
    stop.onclick = function () { S.queue = []; if (hasTTS()) window.speechSynthesis.cancel(); S.speaking = false; render(); };

    var repeat = document.createElement('span');
    repeat.id = 'fleet-announcer-repeat';
    repeat.style.cssText = 'cursor:pointer;padding:1px 6px;border:1px solid #3a3a5a;border-radius:3px;color:#60a5fa;font-size:10px;user-select:none;display:none;';
    repeat.title = 'Read the last announcement again.';
    repeat.textContent = 'again';
    repeat.onclick = function () {
      if (!S.lastAnnouncement) return;
      S.queue = [S.lastAnnouncement];
      S.speaking = false;
      pump();
    };

    var st = document.createElement('span');
    st.id = 'fleet-announcer-status';
    st.style.cssText = 'color:#6C7263;font-size:10px;';

    var voice = document.createElement('select');
    voice.id = 'fleet-announcer-voice';
    voice.title = 'Voice used for announcements.';
    voice.style.cssText = 'background:#1a1a2a;color:#D8DACE;border:1px solid #2a2a3a;border-radius:3px;font-size:10px;max-width:130px;';
    voice.onchange = function () { store(KEY.voice, voice.value); };

    var rate = document.createElement('select');
    rate.id = 'fleet-announcer-rate';
    rate.title = 'Speaking rate.';
    rate.style.cssText = 'background:#1a1a2a;color:#D8DACE;border:1px solid #2a2a3a;border-radius:3px;font-size:10px;';
    [['0.9', 'slow'], ['1.05', 'normal'], ['1.2', 'fast']].forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0]; o.textContent = p[1];
      rate.appendChild(o);
    });
    rate.value = store(KEY.rate) || '1.05';
    rate.onchange = function () { store(KEY.rate, rate.value); };

    wrap.appendChild(b);
    wrap.appendChild(stop);
    wrap.appendChild(repeat);
    wrap.appendChild(voice);
    wrap.appendChild(rate);
    wrap.appendChild(st);
    row.appendChild(wrap);

    S.ui = { button: b, stop: stop, repeat: repeat, status: st, voice: voice, rate: rate };
    render();
    return true;
  }

  // ── the switch ──
  function toggle() {
    // This click is also the gesture browsers require before any audio plays,
    // which is why arming happens here rather than on load.
    if (S.relay && S.relay.muted === true) {
      S.unlocked = true;
      store(KEY.enabled, '1');
      setVoice(false, 'operator switched the fleet announcer back on');
      // One short utterance as proof the speakers work. Silently arming and
      // waiting 30 minutes to find out it does not is the bad version of this.
      say('Fleet announcements are on.');
      return;
    }
    if (!S.unlocked) {
      S.unlocked = true;
      store(KEY.enabled, '1');
      say('Fleet announcements are on.');
      render();
      return;
    }
    // Armed and unlocked -> the operator is asking for silence. Mute the relay,
    // not just this tab: an agent must not be able to find a second window.
    S.unlocked = false;
    store(KEY.enabled, '0');
    S.queue = [];
    if (hasTTS()) window.speechSynthesis.cancel();
    setVoice(true, 'operator clicked the voice off');
  }

  // ── boot ──
  function init() {
    if (!buildUI()) return;
    S.unlocked = store(KEY.enabled) === '1';
    loadVoices();
    if (hasTTS()) {
      // Voice lists populate asynchronously in Chrome; without this the select
      // is empty until something else happens to make it populate.
      window.speechSynthesis.onvoiceschanged = refreshVoices;
      if (!S.voices.length) setTimeout(refreshVoices, 400);
    }
    refreshStatus().then(function (s) {
      // A relay that is muted but a tab that thinks it is armed is the exact
      // state that makes people think the switch does nothing.
      if (s && s.muted) S.unlocked = false;
      render();
    });
    setInterval(function () { refreshStatus(); pump(); }, 20000);
    // Typing is the most common reason a queued announcement must wait.
    ['input', 'keyup', 'blur', 'click'].forEach(function (ev) {
      document.addEventListener(ev, function () { if (S.queue.length) setTimeout(pump, 250); }, true);
    });
    console.log('[fleet-announcer] dashboard voice ready');
  }

  // Public surface — dashboard.js feeds the poll results straight in, so the
  // speaking decision is made in ONE place from data the board already has.
  window.FleetAnnouncer = {
    ingest: offer,
    status: function () { return S.relay; },
    isArmed: armed,
    refresh: refreshStatus,
    stop: function () { S.queue = []; if (hasTTS()) window.speechSynthesis.cancel(); S.speaking = false; render(); },
    repeat: function () { if (S.lastAnnouncement) { S.queue = [S.lastAnnouncement]; S.speaking = false; pump(); } },
    forSpeech: forSpeech,
    test: function () { say('Fleet announcements are on.'); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();