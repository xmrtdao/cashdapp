/**
 * 1d-price-ticker worker — XMR price from CoinGecko / Kraken / Binance
 * Serves: price.mobilemonero.com/*
 *
 * Pages:
 *   GET /             -> Live XMR price + 24h chart-ish display (HTML, JWT required)
 *
 * API:
 *   GET /price/xmr    -> JSON {price_usd, change_24h, source, updated}
 *   GET /price/change -> JSON {change_24h, price_usd, source}
 *   GET /health       -> JSON ok (no auth)
 */

import { CORS, jsonResponse, errorResponse, pageShell, loginHTML, requireCert, escapeHtml } from './_shared.mjs';

const CORS2 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function fetchCoinGecko() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true",
    { headers: { "User-Agent": "MobileMonero-Worker/1.0", "Accept": "application/json" }, cf: { cacheTtl: 30 } }
  );
  if (!res.ok) throw new Error("CG_HTTP_" + res.status);
  const data = await res.json();
  return { price_usd: data.monero.usd, change_24h: data.monero.usd_24h_change || null, source: "coingecko" };
}
async function fetchKraken() {
  const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XMRUSD", { cf: { cacheTtl: 30 } });
  if (!res.ok) throw new Error("KR_HTTP_" + res.status);
  const data = await res.json();
  const pair = data.result.XXMRZUSD;
  if (!pair) throw new Error("KR_NO_PAIR");
  const price = parseFloat(pair.c[0]);
  const open = parseFloat(pair.o);
  return {
    price_usd: price,
    change_24h: parseFloat((((price - open) / open) * 100).toFixed(2)),
    source: "kraken",
    high_24h: parseFloat(pair.h[1]),
    low_24h: parseFloat(pair.l[1]),
    volume_24h: parseFloat(pair.v[1]),
  };
}
async function fetchBinance() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=XMRUSDT", { cf: { cacheTtl: 30 } });
  if (!res.ok) throw new Error("BN_HTTP_" + res.status);
  const data = await res.json();
  return { price_usd: parseFloat(data.price), change_24h: null, source: "binance" };
}

async function fetchPrice() {
  const errors = [];
  try { return await fetchCoinGecko(); } catch (e) { errors.push("cg:" + e.message); }
  try { return await fetchKraken(); } catch (e) { errors.push("kr:" + e.message); }
  try { return await fetchBinance(); } catch (e) { errors.push("bn:" + e.message); }
  throw new Error("All sources failed: " + errors.join(", "));
}

const PRICE_BODY = `
<div class="card">
  <h2>Current Price</h2>
  <div style="font-size:3rem;font-weight:700;color:var(--accent)" id="px">$…</div>
  <div class="stat"><span class="label">24h change</span><span class="value" id="chg">…</span></div>
  <div class="stat"><span class="label">Source</span><span class="value" id="src">…</span></div>
  <div class="stat"><span class="label">Updated</span><span class="value" id="upd">…</span></div>
</div>

<div class="card">
  <h2>24h Range (Kraken)</h2>
  <div class="stat"><span class="label">High</span><span class="value" id="hi">-</span></div>
  <div class="stat"><span class="label">Low</span><span class="value" id="lo">-</span></div>
  <div class="stat"><span class="label">Volume (XMR)</span><span class="value" id="vol">-</span></div>
</div>

<div class="card">
  <h2>API</h2>
  <p style="font-size:.8rem;color:var(--muted);margin-bottom:.5rem">Direct JSON endpoints:</p>
  <div class="msg"><a href="/price/xmr" style="color:var(--accent)">/price/xmr</a> &middot; full price payload</div>
  <div class="msg"><a href="/price/change" style="color:var(--accent)">/price/change</a> &middot; change only</div>
  <div class="msg"><a href="/health" style="color:var(--accent)">/health</a> &middot; worker health</div>
</div>
`;

const PRICE_SCRIPT = `
function esc(s){return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function load(){
  try{
    var r=await fetch('/price/xmr',{signal:AbortSignal.timeout(8000)});
    if(!r.ok) return;
    var d=await r.json();
    if(d.price_usd){
      document.getElementById('px').textContent='$'+Number(d.price_usd).toFixed(2);
      var chg=document.getElementById('chg');
      if(d.change_24h!==null&&d.change_24h!==undefined){
        chg.textContent=(d.change_24h>=0?'+':'')+Number(d.change_24h).toFixed(2)+'%';
        chg.style.color=d.change_24h>=0?'var(--ok)':'var(--err)';
      } else { chg.textContent='-'; }
      document.getElementById('src').textContent=d.source||'?';
      if(d.updated) document.getElementById('upd').textContent=new Date(d.updated).toLocaleTimeString();
    }
    if(d.high_24h) document.getElementById('hi').textContent='$'+Number(d.high_24h).toFixed(2);
    if(d.low_24h)  document.getElementById('lo').textContent='$'+Number(d.low_24h).toFixed(2);
    if(d.volume_24h) document.getElementById('vol').textContent=Number(d.volume_24h).toLocaleString(undefined,{maximumFractionDigits:0});
  }catch(e){}
}
load(); setInterval(load, 30000);
`;

function page(cert) {
  return pageShell({
    title: "XMR Price",
    primaryColor: "#f97316",
    currentNav: "Price",
    who: 'Welcome, <b>' + escapeHtml(cert.agent_id || cert.cert_id) + '</b>',
    body: PRICE_BODY,
    script: PRICE_SCRIPT,
    cert: cert.cert_id,
  });
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS2 });
  const url = new URL(request.url);
  const path = url.pathname;

  // Public endpoints (no auth)
  if (path === "/price/xmr" || path === "/price/xmr/") {
    try {
      const data = await fetchPrice();
      return jsonResponse({ price_usd: data.price_usd, change_24h: data.change_24h, source: data.source, high_24h: data.high_24h, low_24h: data.low_24h, volume_24h: data.volume_24h, updated: Date.now() });
    } catch (e) { return jsonResponse({ error: e.message }, 502); }
  }
  if (path === "/price/change" || path === "/price/change/") {
    try {
      const data = await fetchPrice();
      return jsonResponse({ change_24h: data.change_24h, price_usd: data.price_usd, source: data.source, updated: Date.now() });
    } catch (e) { return jsonResponse({ error: e.message }, 502); }
  }
  if (path === "/health") {
    return jsonResponse({ ok: true, worker: "1d-price-ticker", ts: Date.now(), supported: ["/price/xmr", "/price/change"], sources: ["coingecko", "kraken", "binance"] });
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
