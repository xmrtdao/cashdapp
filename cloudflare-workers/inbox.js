/**
 * inbox worker — MobileMonero / Party Favor Photo inbound email viewer
 * Serves: inbox.mobilemonero.com/*
 *
 * Pages:
 *   GET /        -> Email inbox viewer (HTML, JWT required)
 *
 * API:
 *   POST /webhook/resend-inbound        — PFP inbound (no auth, called by Resend)
 *   POST /webhook/resend-mobilemonero   — XMRT inbound
 *   GET  /inbox/pfp?limit=&offset=
 *   GET  /inbox/mobilemonero?limit=&offset=
 *   GET  /inbox/brief                   — public summary
 *   GET  /sent?limit=&offset=
 *   GET  /health
 */

import { CORS, jsonResponse, errorResponse, pageShell, loginHTML, requireCert, escapeHtml } from './_shared.mjs';
const CORS2 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SHARED_SECRET = "mmx-shared-2026-inbox-v1";

const PFP_INBOX = [];
const XMRT_INBOX = [];
const SENT_EMAILS = [];

function now() { return new Date().toISOString(); }
function auth_fail() { return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }); }
function check_auth(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  return header.slice(7) === SHARED_SECRET;
}

function handleWebhook(body, store) {
  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    from: body.from || body.senderEmail || "",
    to: body.to || "",
    subject: body.subject || "",
    text: body.text || "",
    html: body.html || "",
    created_at: body.created_at || now(),
    raw: body,
  };
  store.unshift(record);
  if (store.length > 5000) store.length = 5000;
  return new Response(JSON.stringify({ ok: true, id: record.id }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

function listInbox(store, url, max = 50) {
  // Auth is checked by the caller (handleRequest).
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const items = store.slice(offset, offset + limit).map(e => ({ id: e.id, from: e.from, to: e.to, subject: e.subject, created_at: e.created_at }));
  return new Response(JSON.stringify({ total: store.length, limit, offset, items }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

function brief() {
  const latestPfp = PFP_INBOX[0];
  const latestXmrt = XMRT_INBOX[0];
  return new Response(JSON.stringify({
    pfp: { count: PFP_INBOX.length, latest_subject: latestPfp ? latestPfp.subject : null },
    mobilemonero: { count: XMRT_INBOX.length, latest_subject: latestXmrt ? latestXmrt.subject : null },
    sent: { count: SENT_EMAILS.length },
  }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

const INBOX_BODY = `
<div class="card">
  <h2>PFP Inbox</h2>
  <div class="stat"><span class="label">Total</span><span class="value" id="pfp-total">-</span></div>
  <div class="stat"><span class="label">Latest</span><span class="value" id="pfp-latest" style="font-size:.75rem">-</span></div>
  <div id="pfp-list" style="margin-top:.6rem;max-height:240px;overflow:auto"></div>
</div>

<div class="card">
  <h2>XMRT Inbox</h2>
  <div class="stat"><span class="label">Total</span><span class="value" id="xmrt-total">-</span></div>
  <div class="stat"><span class="label">Latest</span><span class="value" id="xmrt-latest" style="font-size:.75rem">-</span></div>
  <div id="xmrt-list" style="margin-top:.6rem;max-height:240px;overflow:auto"></div>
</div>

<div class="card">
  <h2>Sent</h2>
  <div class="stat"><span class="label">Total</span><span class="value" id="sent-total">-</span></div>
</div>

<div class="card">
  <h2>Webhooks</h2>
  <p style="font-size:.8rem;color:var(--muted);margin-bottom:.5rem">Resend inbound → Supabase webhook → these endpoints:</p>
  <div class="msg">POST <code>/webhook/resend-inbound</code> → PFP_INBOX</div>
  <div class="msg">POST <code>/webhook/resend-mobilemonero</code> → XMRT_INBOX</div>
</div>
`;

const INBOX_SCRIPT = `
function esc(s){return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function relTime(iso){
  if(!iso) return '?';
  var d=new Date(iso); var ms=Date.now()-d.getTime();
  if(ms<60000) return Math.floor(ms/1000)+'s ago';
  if(ms<3600000) return Math.floor(ms/60000)+'m ago';
  if(ms<86400000) return Math.floor(ms/3600000)+'h ago';
  return Math.floor(ms/86400000)+'d ago';
}
async function load(){
  // Brief is public, full lists need auth via /api/me endpoint (use cookie)
  try{
    var r=await fetch('/inbox/brief',{signal:AbortSignal.timeout(5000)});
    if(!r.ok) return;
    var d=await r.json();
    if(d.pfp){
      document.getElementById('pfp-total').textContent=d.pfp.count;
      document.getElementById('pfp-latest').textContent=d.pfp.latest_subject||'(none)';
    }
    if(d.mobilemonero){
      document.getElementById('xmrt-total').textContent=d.mobilemonero.count;
      document.getElementById('xmrt-latest').textContent=d.mobilemonero.latest_subject||'(none)';
    }
    if(d.sent){
      document.getElementById('sent-total').textContent=d.sent.count;
    }
  }catch(e){}
  // Try to fetch full lists if auth allows
  await loadList('/inbox/pfp', 'pfp-list');
  await loadList('/inbox/mobilemonero', 'xmrt-list');
}
async function loadList(path, elId){
  try{
    var r=await fetch(path+'?limit=15',{signal:AbortSignal.timeout(5000)});
    if(!r.ok) return;
    var d=await r.json();
    var el=document.getElementById(elId);
    if(!d.items||!d.items.length){el.innerHTML='<div style="color:var(--muted)">No items</div>';return;}
    el.innerHTML=d.items.map(function(i){
      return '<div class="msg"><b>'+esc(i.from||'?')+'</b> <span style="color:var(--muted)">'+relTime(i.created_at)+'</span><br>'+esc((i.subject||'').slice(0,80))+'</div>';
    }).join('');
  }catch(e){}
}
load(); setInterval(load, 30000);
`;

function page(cert) {
  return pageShell({
    title: "Inbox",
    primaryColor: "#ec4899",
    currentNav: "Inbox",
    who: 'Welcome, <b>' + escapeHtml(cert.agent_id || cert.cert_id) + '</b>',
    body: INBOX_BODY,
    script: INBOX_SCRIPT,
    cert: cert.cert_id,
  });
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS2 });
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  try {
    if (method === "POST" && path === "/webhook/resend-inbound") {
      const body = await request.json().catch(() => ({}));
      return handleWebhook(body, PFP_INBOX);
    }
    if (method === "POST" && path === "/webhook/resend-mobilemonero") {
      const body = await request.json().catch(() => ({}));
      return handleWebhook(body, XMRT_INBOX);
    }
    if (method === "GET" && path === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "inbox", version: "1.0.0" }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    if (method === "GET" && path === "/inbox/brief") return brief();

    // Authenticated endpoints — require XMRT University cert
    // (webhooks above are public so Resend can POST without a cert)
    const isProtected =
      path === "/" || path === "" || path === "/index.html" ||
      path === "/inbox/pfp" || path === "/inbox/pfp/" ||
      path === "/inbox/mobilemonero" || path === "/inbox/mobilemonero/" ||
      path === "/sent" || path === "/sent/" ||
      path.startsWith("/inbox/pfp/") ||
      path.startsWith("/inbox/mobilemonero/");
    if (isProtected) {
      const auth = await requireCert(request);
      if (!auth.ok) return new Response(JSON.stringify(auth.body), { status: auth.status, headers: { "Content-Type": "application/json" } });
    } else if (!check_auth(request)) {
      return auth_fail();
    }

    if (method === "GET" && (path === "/inbox/pfp" || path === "/inbox/pfp/")) return listInbox(PFP_INBOX, url);
    if (method === "GET" && (path === "/inbox/mobilemonero" || path === "/inbox/mobilemonero/")) return listInbox(XMRT_INBOX, url);
    if (method === "GET" && (path === "/sent" || path === "/sent/")) return listInbox(SENT_EMAILS, url);
    if (method === "POST" && path === "/sent") {
      const body = await request.json().catch(() => ({}));
      SENT_EMAILS.unshift({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        to: body.to || "", subject: body.subject || "", created_at: now(), raw: body,
      });
      if (SENT_EMAILS.length > 2500) SENT_EMAILS.length = 2500;
      return new Response(JSON.stringify({ ok: true, count: SENT_EMAILS.length }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    if (method === "GET" && path.startsWith("/inbox/pfp/")) {
      const id = path.split("/").pop();
      const item = PFP_INBOX.find(e => e.id === id);
      return item ? new Response(JSON.stringify(item), { status: 200, headers: { "Content-Type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    if (method === "GET" && path.startsWith("/inbox/mobilemonero/")) {
      const id = path.split("/").pop();
      const item = XMRT_INBOX.find(e => e.id === id);
      return item ? new Response(JSON.stringify(item), { status: 200, headers: { "Content-Type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    // HTML page — requires cert
    if (path === "/" || path === "" || path === "/index.html") {
      const auth = await requireCert(request);
      if (!auth.ok) {
        return new Response(loginHTML(auth.body.error), { status: auth.status, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS2) });
      }
      return new Response(page(auth.cert), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Server error", detail: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request); }
};
