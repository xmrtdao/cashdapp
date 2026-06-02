/**
 * hermes worker — fleet chat relay (hybrid: relay primary, memory fallback)
 * Serves: hermes.mobilemonero.com/*
 *
 * Pages:
 *   GET /        -> Live chat viewer (HTML, JWT required)
 *
 * API:
 *   GET    /health
 *   GET    /fleet/messages
 *   GET    /fleet/status
 *   POST   /fleet/broadcast       {from, message, type}
 *   GET    /from/hermes
 *   GET    /from/hermes/:agent
 */

import { CORS, jsonResponse, errorResponse, pageShell, loginHTML, requireCert, escapeHtml } from './_shared.mjs';

const CORS2 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const RELAY_URL = "https://relay.mobilemonero.com";

let RELAY_UP = false;
let LAST_RELAY_CHECK = 0;
const MESSAGES = [];
const AGENTS = {};

function ts() { return new Date().toISOString(); }
function jr(o, s) { return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }

async function checkRelay(force = false) {
  const now = Date.now();
  if (!force && now - LAST_RELAY_CHECK < 30000 && RELAY_UP) return true;
  try {
    const r = await fetch(RELAY_URL + "/health", { cf: { cacheTtl: 0 } });
    RELAY_UP = r.ok;
  } catch (e) { RELAY_UP = false; }
  LAST_RELAY_CHECK = now;
  return RELAY_UP;
}

async function proxyOrRelay(path, useRelay) {
  useRelay = useRelay && await checkRelay();
  if (useRelay) {
    try { return await fetch(RELAY_URL + path); } catch (e) { console.log("[hermes] relay fail", e.message); }
  }
  return null;
}

const CHAT_BODY = `
<div class="card">
  <h2>Live Chat</h2>
  <div id="chat" style="max-height:500px;overflow:auto;font-size:.8rem"></div>
  <div style="margin-top:1rem;display:grid;grid-template-columns:1fr auto;gap:.5rem">
    <input id="msg" placeholder="Type a message..." />
    <button class="btn" id="send">Send</button>
  </div>
  <div style="margin-top:.5rem;font-size:.7rem;color:var(--muted)">Posts to <b>fleet-broadcast</b> channel. You appear as <span id="meName">you</span>.</div>
</div>

<div class="card">
  <h2>Agents</h2>
  <div id="agents"></div>
</div>

<div class="card">
  <h2>API</h2>
  <div class="msg"><a href="/fleet/messages" style="color:var(--accent)">/fleet/messages</a> &middot; list messages</div>
  <div class="msg"><a href="/fleet/status" style="color:var(--accent)">/fleet/status</a> &middot; relay state</div>
  <div class="msg">POST <a href="#" style="color:var(--muted)">/fleet/broadcast</a> &middot; {from, message}</div>
</div>
`;

const CHAT_SCRIPT = `
function esc(s){return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function load(){
  try{
    var r=await fetch('/fleet/messages?limit=30',{signal:AbortSignal.timeout(8000)});
    if(!r.ok) return;
    var d=await r.json();
    var msgs=d.messages||d.items||[];
    var html=msgs.slice(0,30).map(function(m){
      var t=new Date(m.timestamp||m.time||m.ts).toLocaleTimeString();
      var who=esc(m.agent||m.from||m.agentLabel||'?');
      var msg=esc((m.message||m.text||'').slice(0,300));
      return '<div class="msg"><b>'+who+'</b> <span style="color:var(--muted)">'+t+'</span><br>'+msg+'</div>';
    }).join('');
    document.getElementById('chat').innerHTML=html||'<div style="color:var(--muted)">No messages</div>';
  }catch(e){}
}
async function loadAgents(){
  try{
    var r=await fetch('/api/dao/gossip?topic=agent-discovery&limit=20',{signal:AbortSignal.timeout(5000)});
    if(!r.ok){document.getElementById('agents').innerHTML='<div style="color:var(--muted)">No agent data</div>';return;}
    var d=await r.json();
    var msgs=d.messages||[];
    var agents={};
    msgs.forEach(function(m){
      var a=m.agent||m.from;
      if(a) agents[a]=(agents[a]||0)+1;
    });
    var html=Object.keys(agents).map(function(a){
      return '<div class="stat"><span class="value"><b>'+esc(a)+'</b></span><span class="label">'+agents[a]+' msgs</span></div>';
    }).join('')||'<div style="color:var(--muted)">No recent agent activity</div>';
    document.getElementById('agents').innerHTML=html;
  }catch(e){}
}
document.getElementById('send').onclick=async function(){
  var i=document.getElementById('msg');
  var v=i.value.trim();
  if(!v) return;
  try{
    var r=await fetch('/api/dao/gossip?topic=fleet-broadcast&limit=1',{method:'GET'});
    // We don't have a write endpoint exposed; show a notice
    document.getElementById('chat').innerHTML='<div class="msg"><b>Note:</b> posting via this UI is not yet wired. Use the <code>POST /api/fleet-chat/send</code> endpoint on the relay.</div>'+document.getElementById('chat').innerHTML;
    i.value='';
  }catch(e){}
};
load(); setInterval(load, 10000);
loadAgents(); setInterval(loadAgents, 60000);
`;

function page(cert) {
  return pageShell({
    title: "Hermes — Fleet Chat",
    primaryColor: "#a855f7",
    currentNav: "Hermes",
    who: 'Welcome, <b>' + escapeHtml(cert.agent_id || cert.cert_id) + '</b> · cert valid until ' + (cert.expires_at || '').slice(0, 10),
    body: CHAT_BODY,
    script: CHAT_SCRIPT.replace('id="meName">you</span>', 'id="meName">' + escapeHtml(cert.agent_id || cert.cert_id) + '</span>'),
    cert: cert.cert_id,
  });
}

async function sendToRelay(path, body) {
  try {
    const r = await fetch(RELAY_URL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) console.log("[hermes] relay OK", path, body.agent);
  } catch (e) { console.log("[hermes] relay err", e.message); }
}

async function handleRequest(request, event) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS2 });
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  try {
    if (method === "GET" && path === "/health") {
      await checkRelay();
      return jr({ ok: true, service: "hermes", relay_up: RELAY_UP, messages: MESSAGES.length, version: "3.0.2" });
    }
    if (method === "GET" && path === "/fleet/status") {
      return jr({ relay: "hermes-hybrid", agents: AGENTS, messages: MESSAGES.length, relay_up: RELAY_UP });
    }
    if (method === "GET" && path === "/fleet/messages") {
      const r = await proxyOrRelay("/api/fleet-chat/messages" + url.search, true);
      if (r && r.ok) return r;
      const L = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const O = parseInt(url.searchParams.get("offset") || "0");
      return jr({ total: MESSAGES.length, limit: L, offset: O, messages: MESSAGES.slice(O, O + L), source: "worker-memory" });
    }
    if (method === "POST" && path === "/fleet/broadcast") {
      // Require XMRT University cert to broadcast to the fleet
      const auth = await requireCert(request);
      if (!auth.ok) return new Response(JSON.stringify(auth.body), { status: auth.status, headers: { "Content-Type": "application/json" } });
      const b = await request.json().catch(() => ({}));
      const msg = { msg_id: MESSAGES.length + 1, from: b.from || "anonymous", message: b.message || "", ts: ts(), type: b.type || "broadcast" };
      MESSAGES.unshift(msg);
      if (MESSAGES.length > 2000) MESSAGES.length = 2000;
      if (event && event.waitUntil) event.waitUntil(sendToRelay("/api/fleet-chat/send", { agent: msg.from, message: msg.message, channel: "all" }));
      return jr({ ok: true, logged: true, msg_id: msg.msg_id, relay: RELAY_UP });
    }
    if (method === "POST" && path.startsWith("/from/")) {
      const auth = await requireCert(request);
      if (!auth.ok) return new Response(JSON.stringify(auth.body), { status: auth.status, headers: { "Content-Type": "application/json" } });
      const b = await request.json().catch(() => ({}));
      const msg = { msg_id: MESSAGES.length + 1, from: b.from || "anonymous", to: b.to, message: b.message || "", ts: ts(), type: b.type || "dm" };
      MESSAGES.unshift(msg);
      if (MESSAGES.length > 2000) MESSAGES.length = 2000;
      if (event && event.waitUntil) event.waitUntil(sendToRelay("/api/fleet-chat/send", { agent: msg.from, message: msg.message, channel: msg.to || "fleet" }));
      return jr({ ok: true, logged: true, msg_id: msg.msg_id, relay: RELAY_UP });
    }
    if (method === "GET" && path === "/from/hermes") {
      const r = await proxyOrRelay(path + url.search, true);
      if (r && r.ok) return r;
      const L = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const O = parseInt(url.searchParams.get("offset") || "0");
      return jr({ total: MESSAGES.length, messages: MESSAGES.slice(O, O + L), source: "worker-memory" });
    }
    if (method === "GET" && path.startsWith("/from/hermes/")) {
      const agent = path.split("/")[2];
      const r = await proxyOrRelay(path + url.search, true);
      if (r && r.ok) return r;
      const L = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const msgs = MESSAGES.filter(m => m.from === agent).slice(0, L);
      return jr({ total: msgs.length, agent, messages: msgs, source: "worker-memory" });
    }

    // HTML page — requires cert
    if (path === "/" || path === "" || path === "/index.html") {
      const auth = await requireCert(request);
      if (!auth.ok) {
        return new Response(loginHTML(auth.body.error), { status: auth.status, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS2) });
      }
      return new Response(page(auth.cert), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return jr({ error: "not found" }, 404);
  } catch (e) { return jr({ error: "Server error", detail: String(e) }, 500); }
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request, ctx); }
};
