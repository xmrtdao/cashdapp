/**
 * fleet-status worker — checks relay, supabase, mtv-lyrics health
 * Serves: fleet.mobilemonero.com/*
 *
 * Pages:
 *   GET /        -> Live fleet health status (HTML, JWT required)
 *
 * API:
 *   GET /health       -> JSON ok (no auth)
 *   GET /fleet/status -> JSON {fleet: {relay, supabase, mtv_lyrics}}
 */

import { CORS, jsonResponse, errorResponse, pageShell, loginHTML, requireCert, escapeHtml } from './_shared.mjs';

const CORS2 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function checkHealth(name, url, options) {
  const start = Date.now();
  try {
    const res = await fetch(url, options || { method: "GET" });
    const latency = Date.now() - start;
    return { status: "up", latency_ms: latency, http_status: res.status };
  } catch (e) {
    return { status: "down", latency_ms: Date.now() - start, error: e.message };
  }
}

async function getFleetStatus() {
  return {
    fleet: {
      relay: await checkHealth("relay", "http://relay.mobilemonero.com:9090/json_rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "get_info" }),
      }),
      supabase: await checkHealth("supabase", "https://vawouugtzwmejxqkeqqj.supabase.co"),
      mtv_lyrics: await checkHealth("mtv_lyrics", "https://mtv-lyrics.mobilemonero.com/health"),
    },
    ts: Date.now(),
  };
}

const FLEET_BODY = `
<div class="card">
  <h2>Relay</h2>
  <div class="stat"><span class="label">Status</span><span class="value" id="relay-status">…</span></div>
  <div class="stat"><span class="label">Latency</span><span class="value" id="relay-latency">-</span></div>
  <div class="stat"><span class="label">HTTP</span><span class="value" id="relay-http">-</span></div>
</div>

<div class="card">
  <h2>Supabase</h2>
  <div class="stat"><span class="label">Status</span><span class="value" id="supa-status">…</span></div>
  <div class="stat"><span class="label">Latency</span><span class="value" id="supa-latency">-</span></div>
  <div class="stat"><span class="label">HTTP</span><span class="value" id="supa-http">-</span></div>
</div>

<div class="card">
  <h2>MTV Lyrics</h2>
  <div class="stat"><span class="label">Status</span><span class="value" id="mtv-status">…</span></div>
  <div class="stat"><span class="label">Latency</span><span class="value" id="mtv-latency">-</span></div>
  <div class="stat"><span class="label">HTTP</span><span class="value" id="mtv-http">-</span></div>
</div>

<div class="card">
  <h2>API</h2>
  <div class="msg"><a href="/fleet/status" style="color:var(--accent)">/fleet/status</a> &middot; JSON health check</div>
  <div class="msg"><a href="/health" style="color:var(--accent)">/health</a> &middot; worker self-check</div>
</div>
`;

const FLEET_SCRIPT = `
function esc(s){return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function statusBadge(s, lat){
  if(s==='up') return '<span class="badge badge-ok">UP ('+lat+'ms)</span>';
  return '<span class="badge badge-err">DOWN</span>';
}
async function load(){
  try{
    var r=await fetch('/fleet/status',{signal:AbortSignal.timeout(12000)});
    if(!r.ok) return;
    var d=await r.json();
    var c=d.fleet||{};
    if(c.relay){
      document.getElementById('relay-status').innerHTML=statusBadge(c.relay.status,c.relay.latency_ms);
      document.getElementById('relay-latency').textContent=(c.relay.latency_ms||0)+' ms';
      document.getElementById('relay-http').textContent=c.relay.http_status||'err';
    }
    if(c.supabase){
      document.getElementById('supa-status').innerHTML=statusBadge(c.supabase.status,c.supabase.latency_ms);
      document.getElementById('supa-latency').textContent=(c.supabase.latency_ms||0)+' ms';
      document.getElementById('supa-http').textContent=c.supabase.http_status||'err';
    }
    if(c.mtv_lyrics){
      document.getElementById('mtv-status').innerHTML=statusBadge(c.mtv_lyrics.status,c.mtv_lyrics.latency_ms);
      document.getElementById('mtv-latency').textContent=(c.mtv_lyrics.latency_ms||0)+' ms';
      document.getElementById('mtv-http').textContent=c.mtv_lyrics.http_status||'err';
    }
  }catch(e){}
}
load(); setInterval(load, 30000);
`;

function page(cert) {
  return pageShell({
    title: "Fleet Status",
    primaryColor: "#22d3ee",
    currentNav: "Fleet",
    who: 'Welcome, <b>' + escapeHtml(cert.agent_id || cert.cert_id) + '</b>',
    body: FLEET_BODY,
    script: FLEET_SCRIPT,
    cert: cert.cert_id,
  });
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS2 });
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") return jsonResponse({ ok: true, worker: "fleet-status", ts: Date.now() });
  if (path === "/fleet/status" || path === "/fleet/status/") {
    return jsonResponse(await getFleetStatus());
  }

  // HTML page (root) — requires cert
  const auth = await requireCert(request);
  if (!auth.ok) {
    return new Response(loginHTML(auth.body.error), { status: auth.status, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS2) });
  }
  return new Response(page(auth.cert), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request); }
};
