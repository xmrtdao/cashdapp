/**
 * Shared XMRT University cert auth + dashboard helpers for CF Workers.
 * Imported as ES module by each worker:
 *   import { verifyCert, requireCert, pageShell, loginHTML, ... } from './_shared.mjs';
 *
 * Exports:
 *   verifyCert, requireCert, checkAllWorkers, jsonResponse, errorResponse,
 *   htmlResponse, loginHTML, pageShell, escapeHtml, SUPABASE_URL, CORS, certCache
 */

export const SUPABASE_URL = "https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1";
const CERT_VERIFY_PATH = "/xmrt-university";
const CACHE_TTL_MS = 60_000;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Certificate-Id",
};

export const certCache = new Map();

export function jsonResponse(data, status = 200) {
  const h = { "Content-Type": "application/json" };
  for (const k in CORS) h[k] = CORS[k];
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function errorResponse(msg, status = 500) {
  return jsonResponse({ error: msg, status }, status);
}

export function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function verifyCert(token) {
  if (!token) return { valid: false, error: "missing cert" };
  const cached = certCache.get(token);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached;
  try {
    const r = await fetch(SUPABASE_URL + CERT_VERIFY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", cert_id: token }),
      signal: AbortSignal.timeout(8000),
    });
    const body = r.ok ? await r.json() : { valid: false, error: "verify failed: " + r.status };
    const result = {
      valid: !!body.valid,
      cert_id: body.cert_id || token,
      agent_id: body.agent_id || null,
      permissions: body.permissions || [],
      expires_at: body.expires_at || null,
      ts: Date.now(),
    };
    certCache.set(token, result);
    return result;
  } catch (e) {
    return { valid: false, error: "verify error: " + e.message, ts: Date.now() };
  }
}

export async function requireCert(request) {
  let token = null;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) token = auth.slice(7).trim();
  if (!token) {
    const cookie = request.headers.get("Cookie") || "";
    const m = cookie.match(/(?:^|;\s*)xmrt_cert=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) return { ok: false, status: 401, body: { error: "Missing XMRT University cert. Send Authorization: Bearer <cert> or POST /api/login with {cert_id}." } };
  const v = await verifyCert(token);
  if (!v.valid) return { ok: false, status: 403, body: { error: "Invalid cert: " + (v.error || "rejected by university") } };
  return { ok: true, cert: v };
}

export async function checkAllWorkers(SUBWORKERS) {
  return await Promise.all(SUBWORKERS.map(async (w) => {
    const t0 = Date.now();
    try {
      const r = await fetch(w.url, { signal: AbortSignal.timeout(4000) });
      return { name: w.name, role: w.role, url: w.url, status: r.ok ? "up" : ("http_" + r.status), ms: Date.now() - t0 };
    } catch (e) {
      return { name: w.name, role: w.role, url: w.url, status: "down", error: e.message, ms: Date.now() - t0 };
    }
  }));
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function pageShell(opts) {
  const primary = opts.primaryColor || "#f97316";
  const nav = [
    { label: "Hub",      href: "https://relay.mobilemonero.com/" },
    { label: "Dashboard",href: "https://dashboard.mobilemonero.com/" },
    { label: "Price",    href: "https://price.mobilemonero.com/" },
    { label: "Fleet",    href: "https://fleet.mobilemonero.com/" },
    { label: "Hermes",   href: "https://hermes.mobilemonero.com/" },
    { label: "Inbox",    href: "https://inbox.mobilemonero.com/" },
    { label: "MTV",      href: "https://mtv.mobilemonero.com/" },
  ];
  const navHtml = nav.map(n => {
    const active = n.label === opts.currentNav ? ' style="color:' + primary + ';border-bottom:2px solid ' + primary + '"' : '';
    return '<a href="' + n.href + '"' + active + ' style="color:var(--muted);text-decoration:none;font-size:.8rem;padding:.4rem .6rem">' + n.label + '</a>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<title>' + escapeHtml(opts.title) + '</title><meta name="theme-color" content="' + primary + '">' +
    '<style>' +
    ':root{--bg:#0f0818;--card:#1a1025;--border:#2a1f35;--accent:' + primary + ';--accent2:#a855f7;--ok:#22c55e;--err:#ef4444;--warn:#f59e0b;--text:#e4e4e7;--muted:#a1a1aa}' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.4;min-height:100vh}' +
    'header{background:linear-gradient(135deg,#1a1025,#2a1f35);padding:1rem 1.2rem;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}' +
    'header h1{font-size:1.2rem;font-weight:700;display:flex;align-items:center;gap:.5rem}' +
    'header h1 small{color:var(--muted);font-size:.7rem;font-weight:400;display:block;margin-top:.1rem}' +
    'header .who{font-size:.7rem;color:var(--muted);margin-top:.3rem}' +
    'header .who b{color:var(--ok)}' +
    'nav{padding:.5rem 1.2rem;background:#120a1c;border-bottom:1px solid var(--border);display:flex;gap:.2rem;flex-wrap:wrap;overflow-x:auto}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:.75rem;padding:1rem}' +
    '.card{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1rem}' +
    '.card h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.6rem}' +
    '.stat{display:flex;align-items:center;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.85rem}' +
    '.stat:last-child{border-bottom:0}' +
    '.stat .label{color:var(--muted);font-size:.75rem}' +
    '.stat .value{font-weight:600}' +
    '.footer{text-align:center;padding:1.5rem;color:var(--muted);font-size:.75rem;border-top:1px solid var(--border)}' +
    '.pulse{animation:pulse 2s infinite}@keyframes pulse{0%{opacity:1}50%{opacity:.5}100%{opacity:1}}' +
    '.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.7rem;font-weight:700}' +
    '.badge-ok{background:rgba(34,197,94,.2);color:var(--ok)}.badge-warn{background:rgba(245,158,11,.2);color:var(--warn)}.badge-err{background:rgba(239,68,68,.2);color:var(--err)}' +
    '.btn{background:linear-gradient(135deg,var(--accent),#ea580c);color:#fff;border:0;padding:.5rem .8rem;border-radius:.6rem;font-size:.8rem;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;display:inline-block}' +
    '.btn.secondary{background:transparent;border:1px solid var(--border);color:var(--text)}' +
    'pre{background:#0a0510;border:1px solid var(--border);border-radius:.5rem;padding:.6rem;overflow:auto;font-size:.75rem;color:var(--muted);max-height:300px}' +
    '.msg{padding:.6rem;background:#0a0510;border-radius:.5rem;font-family:monospace;font-size:.75rem;margin:.4rem 0;border-left:3px solid var(--accent)}' +
    '.msg b{color:var(--accent)}' +
    'input,textarea,select{width:100%;background:#0a0510;border:1px solid var(--border);color:var(--text);padding:.6rem;border-radius:.5rem;font-family:inherit;font-size:.85rem}' +
    'textarea{min-height:80px;resize:vertical}' +
    'table{width:100%;border-collapse:collapse;font-size:.8rem}' +
    'th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--border)}' +
    'th{color:var(--muted);font-weight:600;font-size:.7rem;text-transform:uppercase}' +
    '</style></head><body>' +
    '<header><h1>' +
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="' + primary + '" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' +
    escapeHtml(opts.title) +
    '</h1>' +
    '<div class="who" id="who">' + (opts.who || '') + '</div>' +
    '</header>' +
    '<nav>' + navHtml + '</nav>' +
    '<div class="grid">' + (opts.body || '') + '</div>' +
    '<div class="footer">' + (opts.footerText || 'MobileMonero · XMRT DAO') +
    (opts.cert ? ' · <span id="fc">' + escapeHtml(opts.cert) + '</span>' : '') +
    '</div>' +
    '<script>' + (opts.script || '') + '</script>' +
    '</body></html>';
}

export function loginHTML(error, returnTo) {
  const msg = error ? '<div style="color:var(--err);font-size:.8rem;margin-bottom:.6rem">' + escapeHtml(error) + '</div>' : '';
  const rt = returnTo ? '&return_to=' + encodeURIComponent(returnTo) : '';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>MobileMonero — Sign in</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0"><style>' +
    ':root{--bg:#0f0818;--card:#1a1025;--border:#2a1f35;--accent:#f97316;--text:#e4e4e7;--muted:#a1a1aa;--err:#ef4444}' +
    '*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}' +
    '.box{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.6rem;max-width:420px;width:100%}' +
    'h1{font-size:1.2rem;margin-bottom:.3rem}h1 small{color:var(--accent);font-size:.8rem;display:block;margin-top:.2rem}' +
    'p{color:var(--muted);font-size:.85rem;margin-bottom:1rem}' +
    'input{width:100%;background:#0f0818;border:1px solid var(--border);color:var(--text);padding:.6rem .8rem;border-radius:.5rem;font-family:monospace;font-size:.85rem;margin-bottom:.6rem}' +
    'button{width:100%;background:linear-gradient(135deg,var(--accent),#ea580c);color:#fff;border:0;padding:.6rem;border-radius:.5rem;font-weight:600;cursor:pointer;font-size:.9rem}' +
    'button:hover{opacity:.9}' +
    'a{color:var(--accent);font-size:.8rem;text-decoration:none}' +
    '</style></head><body><div class="box"><h1>MobileMonero <small>Sign in</small></h1>' +
    '<p>Sign in with your XMRT University certificate. Don\'t have one? Enroll at <a href="https://xmrtdao.github.io/university" target="_blank">xmrtdao.github.io/university</a>.</p>' +
    msg +
    '<form onsubmit="event.preventDefault();fetch(\'/api/login\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({cert_id:document.getElementById(\'c\').value.trim()})}).then(r=>r.ok?location.reload():r.json().then(j=>{document.getElementById(\'err\').textContent=j.error||\'login failed\'}));">' +
    '<input id="c" placeholder="XMRT-CERT-XXXXXXXX" required>' +
    '<button type="submit">Sign in</button></form>' +
    '<div id="err" style="color:var(--err);font-size:.75rem;margin-top:.6rem"></div></div></body></html>';
}
