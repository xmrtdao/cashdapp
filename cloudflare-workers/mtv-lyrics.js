/**
 * mtv-lyrics worker — AI lyrics generator (Cloudflare Workers AI)
 * Serves: mtv.mobilemonero.com/*, mtv-lyrics.mobilemonero.com/*
 *
 * Pages:
 *   GET /        -> Lyrics generator UI (HTML, JWT required)
 *
 * API:
 *   POST /generate        {theme, genre, title?, sections?, vibe?, model?}
 *   POST /music-payload   {prompt, duration?}
 *   POST /ai-call         {messages[], model?}
 *   GET  /health
 */

import { CORS, jsonResponse, errorResponse, pageShell, loginHTML, requireCert, escapeHtml } from './_shared.mjs';

const CORS2 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function parseLyrics(text) {
  const sections = [];
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\[(Intro|Verse|Chorus|Bridge|Outro|Hook|Pre-Chorus)\d*\]$/i);
    if (m) { current = { tag: m[1].toLowerCase(), lines: [] }; sections.push(current); }
    else if (current && line.trim()) { current.lines.push(line.trim()); }
  }
  return sections;
}

function buildPrompt(body) {
  const theme = body.theme || "";
  const genre = body.genre || "";
  const title = body.title || "";
  const vibe = body.vibe || "dark tech-noir";
  const sections = body.sections || ["Intro", "Verse", "Chorus", "Verse", "Chorus", "Outro"];
  return "You are XMRT DAO's AI songwriter. Write original " + genre + " lyrics about " + theme + "."
    + (title ? "\nTitle: " + title : "")
    + "\nVibe: " + vibe + "."
    + "\nStructure: " + sections.join(", ") + "."
    + "\nRules:"
    + "\n- Use section tags exactly like [Intro], [Verse], [Chorus], [Bridge], [Outro]."
    + "\n- Each tag on its own line. Lyrics follow immediately after each tag."
    + "\n- No extra commentary. No introductory text. Return ONLY the tagged lyrics.";
}

const MTV_BODY = `
<div class="card">
  <h2>Generate Lyrics</h2>
  <label style="font-size:.75rem;color:var(--muted)">Theme (required)</label>
  <input id="theme" placeholder="e.g. decentralized mining, cypherpunk freedom" />
  <label style="font-size:.75rem;color:var(--muted)">Genre (required)</label>
  <input id="genre" placeholder="e.g. synthwave, lofi hip-hop, cyberpunk rap" />
  <label style="font-size:.75rem;color:var(--muted)">Title (optional)</label>
  <input id="title" placeholder="e.g. Ghost in the Hash" />
  <label style="font-size:.75rem;color:var(--muted)">Vibe (optional)</label>
  <input id="vibe" placeholder="dark tech-noir" value="dark tech-noir" />
  <label style="font-size:.75rem;color:var(--muted)">Sections (comma-separated, optional)</label>
  <input id="sections" placeholder="Intro,Verse,Chorus,Verse,Chorus,Outro" value="Intro,Verse,Chorus,Verse,Chorus,Outro" />
  <button class="btn" id="go" style="margin-top:.6rem;width:100%">Generate</button>
  <div id="status" style="margin-top:.5rem;font-size:.75rem;color:var(--muted)"></div>
</div>

<div class="card">
  <h2>Output</h2>
  <div id="out" style="font-size:.8rem"></div>
</div>

<div class="card">
  <h2>API</h2>
  <div class="msg">POST <a href="#" style="color:var(--muted)">/generate</a> &middot; {theme, genre, ...} + Bearer CF token</div>
  <div class="msg">POST <a href="#" style="color:var(--muted)">/music-payload</a> &middot; {prompt, duration}</div>
  <div class="msg">POST <a href="#" style="color:var(--muted)">/ai-call</a> &middot; {messages[], model?}</div>
</div>
`;

const MTV_SCRIPT = `
function esc(s){return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
document.getElementById('go').onclick=async function(){
  var body={
    theme: document.getElementById('theme').value.trim(),
    genre: document.getElementById('genre').value.trim(),
    title: document.getElementById('title').value.trim(),
    vibe: document.getElementById('vibe').value.trim(),
  };
  var secRaw=document.getElementById('sections').value.trim();
  if(secRaw) body.sections=secRaw.split(',').map(function(s){return s.trim()});
  if(!body.theme||!body.genre){document.getElementById('status').textContent='Theme and genre required';return;}
  var st=document.getElementById('status');
  st.textContent='Generating... (this may take 10-30s)';
  document.getElementById('out').innerHTML='';
  // Note: /generate requires a CF API token in Authorization header.
  // For browser use we'd need a backend proxy. Show note.
  st.innerHTML='<span style="color:var(--warn)">Browser calls to /generate require a CF API token in the Authorization header, which is not safe in client JS. Use the CLI or a server-side call. Showing example payload below.</span>';
  document.getElementById('out').innerHTML='<pre>'+esc(JSON.stringify(body,null,2))+'</pre>';
};
`;

function page(cert) {
  return pageShell({
    title: "MTV — Lyrics",
    primaryColor: "#ef4444",
    currentNav: "MTV",
    who: 'Welcome, <b>' + escapeHtml(cert.agent_id || cert.cert_id) + '</b>',
    body: MTV_BODY,
    script: MTV_SCRIPT,
    cert: cert.cert_id,
  });
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS2 });
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    return new Response(JSON.stringify({ ok: true, worker: "mtv-lyrics", ts: Date.now() }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/generate" && request.method === "POST") {
    try {
      const body = await request.json();
      const theme = body.theme;
      const genre = body.genre;
      if (!theme || !genre) return jsonResponse({ error: "theme and genre are required" }, 400);
      const authHeader = request.headers.get("Authorization") || "";
      const cfToken = authHeader.replace(/^Bearer\s+/, "");
      if (!cfToken) return jsonResponse({ error: "Missing Authorization: Bearer <CF_API_TOKEN> header" }, 401);
      const model = body.model || "@cf/meta/llama-3-8b-instruct";
      const prompt = buildPrompt(body);
      const aiRes = await fetch(
        "https://api.cloudflare.com/client/v4/accounts/ef8e3637c4a00a43860b679ecd138a05/ai/run/" + model,
        { method: "POST", headers: { "Authorization": "Bearer " + cfToken, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }) }
      );
      const aiJson = await aiRes.json();
      const rawText = (aiJson.result && aiJson.result.response) ? aiJson.result.response : JSON.stringify(aiJson);
      const sections = parseLyrics(rawText);
      return jsonResponse({ title: body.title || (theme + " (" + genre + ")"), genre, theme, vibe: body.vibe || "dark tech-noir", model, lyrics_raw: rawText, sections, generated_at: new Date().toISOString() });
    } catch (e) { return jsonResponse({ error: e.message, stack: e.stack }, 500); }
  }

  if (path === "/music-payload" && request.method === "POST") {
    try {
      const body = await request.json();
      const prompt = body.prompt;
      const duration = body.duration || 30;
      if (!prompt) return jsonResponse({ error: "prompt is required" }, 400);
      return jsonResponse({ model: "music-2.6", prompt, duration, source: "mtv-worker", minimax_endpoint: "https://api.minimaxi.chat/v1/music_generation" });
    } catch (e) { return jsonResponse({ error: e.message }, 500); }
  }

  if (path === "/ai-call" && request.method === "POST") {
    try {
      const body = await request.json();
      const model = body.model || "@cf/meta/llama-3-8b-instruct";
      const authHeader = request.headers.get("Authorization") || "";
      const cfToken = authHeader.replace(/^Bearer\s+/, "");
      if (!cfToken) return jsonResponse({ error: "Missing Authorization: Bearer <CF_API_TOKEN> header" }, 401);
      const aiRes = await fetch(
        "https://api.cloudflare.com/client/v4/accounts/ef8e3637c4a00a43860b679ecd138a05/ai/run/" + model,
        { method: "POST", headers: { "Authorization": "Bearer " + cfToken, "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      const aiJson = await aiRes.json();
      return jsonResponse({ model, result: aiJson });
    } catch (e) { return jsonResponse({ error: e.message, stack: e.stack }, 500); }
  }

  if (path === "/" || path === "" || path === "/index.html") {
    if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
    const auth = await requireCert(request);
    if (!auth.ok) {
      return new Response(loginHTML(auth.body.error), { status: auth.status, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS2) });
    }
    return new Response(page(auth.cert), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(JSON.stringify({ error: "Not Found", paths: ["/", "/health", "/generate", "/music-payload", "/ai-call"] }), { status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request); }
};
