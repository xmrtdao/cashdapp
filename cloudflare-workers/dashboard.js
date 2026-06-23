/**
 * dashboard worker — MobileMonero Fleet
 * Serves: dashboard.mobilemonero.com/*
 *
 * Pages:
 *   GET /                -> Fleet dashboard (live XMRT DAO health + workers + gossip)
 *   GET /workers         -> Worker health detail
 *   GET /agents          -> Fleet agents list
 *   GET /tasks           -> Recent tasks
 *   GET /gossip          -> Live gossip feed
 *
 * API:
 *   GET  /api/dao/health, /api/dao/gossip, /api/dao/github, /api/dao/mining
 *   GET  /api/workers/status, /api/me
 *   POST /api/login, /api/logout
 *   GET  /health
 */

import { SUPABASE_URL, CORS, certCache,
         jsonResponse, errorResponse, htmlResponse,
         verifyCert, requireCert, checkAllWorkers,
         escapeHtml, pageShell, loginHTML } from './_shared.mjs';

const GITHUB_ORG = "xmrtdao";

const SUBWORKERS = [
  { name: "API Gateway",   url: "https://api.mobilemonero.com/health",       role: "Proxy" },
  { name: "Price Ticker",  url: "https://price.mobilemonero.com/price/xmr",  role: "XMR/USD" },
  { name: "Fleet Status",  url: "https://fleet.mobilemonero.com/health",     role: "Heartbeat" },
  { name: "MTV Lyrics",    url: "https://mtv.mobilemonero.com/health",       role: "AI Lyrics" },
  { name: "Hermes",        url: "https://hermes.mobilemonero.com/health",    role: "Chat" },
  { name: "Inbox",         url: "https://inbox.mobilemonero.com/health",     role: "Email" },
  { name: "Mesh Sync",     url: "https://mesh.mobilemonero.com/health",      role: "Offline" },
  { name: "AI Gateway",    url: "https://ai.mobilemonero.com/health",        role: "AI" },
];

const DASH_BODY = `
<div class="card">
  <h2>Workers</h2>
  <div id="workerList"></div>
</div>

<div class="card">
  <h2>XMRT DAO Health</h2>
  <div class="stat"><span class="label">Supabase</span><span class="value" id="dao-health-status">…</span></div>
  <div class="stat"><span class="label">Health Score</span><span class="value" id="dao-health-score">-</span></div>
  <div class="stat"><span class="label">Agents</span><span class="value" id="dao-agent-count">-</span></div>
  <div class="stat"><span class="label">Tasks</span><span class="value" id="dao-task-count">-</span></div>
  <div class="stat"><span class="label">Edge Functions</span><span class="value" id="dao-fn-count">-</span></div>
  <div class="stat"><span class="label">Gossip Hub</span><span class="value" id="dao-gossip-status">-</span></div>
</div>

<div class="card">
  <h2>GitHub Activity</h2>
  <div class="stat"><span class="label">Total Repos</span><span class="value" id="gh-repo-count">-</span></div>
  <div class="stat"><span class="label">Last Commit</span><span class="value" id="gh-last-commit" style="font-size:.7rem">-</span></div>
  <div id="gh-recent-commits" style="margin-top:.6rem"></div>
</div>

<div class="card">
  <h2>Recent Gossip</h2>
  <div id="gossip-list" style="font-size:.75rem;max-height:280px;overflow:auto"></div>
</div>
`;

const DASH_SCRIPT = `
function badge(score){
  if(score >= 80) return '<span class="badge badge-ok">HEALTHY ('+score+')</span>';
  if(score >= 50) return '<span class="badge badge-warn">DEGRADED ('+score+')</span>';
  return '<span class="badge badge-err">CRITICAL ('+score+')</span>';
}
function esc(s){return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
var WORKERS = ${JSON.stringify(SUBWORKERS)};

async function check(url){
  try{var r=await fetch(url,{signal:AbortSignal.timeout(5000)});return r.ok}catch(e){return false}
}
function renderWorkers(){
  var el=document.getElementById('workerList');
  el.innerHTML=WORKERS.map(function(w){
    return '<div class="stat" data-url="'+w.url+'"><div><b>'+esc(w.name)+'</b><br><span class="label">'+esc(w.role)+'</span></div><span class="value"><span class="badge badge-warn">…</span></span></div>';
  }).join('');
  WORKERS.forEach(async function(w,i){
    var row=el.querySelectorAll('.stat')[i]; if(!row) return;
    var ok=await check(w.url);
    var v=row.querySelector('.value');
    v.innerHTML=ok?'<span class="badge badge-ok">UP</span>':'<span class="badge badge-err">DOWN</span>';
  });
}
async function loadDao(){
  try{
    var r=await fetch('/api/dao/health',{signal:AbortSignal.timeout(10000)});
    if(!r.ok){document.getElementById('dao-health-status').innerHTML='<span class="badge badge-err">UNREACHABLE</span>';return;}
    var d=await r.json();
    var score=0,status='unknown';
    if(d.health&&d.health.overall_health){score=d.health.overall_health.score||0;status=d.health.overall_health.status||'unknown';}
    else if(d.status&&d.status.health_score){score=d.status.health_score;status=d.status.overall_status||'unknown';}
    document.getElementById('dao-health-status').innerHTML=badge(score);
    document.getElementById('dao-health-score').textContent=score+' / 100 ('+status+')';
    if(d.status&&d.status.components){
      var c=d.status.components;
      if(c.edge_functions&&c.edge_functions.total_calls_24h!==undefined) document.getElementById('dao-fn-count').textContent=c.edge_functions.total_calls_24h+' / 24h';
      if(c.agents) document.getElementById('dao-agent-count').textContent=c.agents.total+' ('+c.agents.busy+' busy)';
      if(c.tasks) document.getElementById('dao-task-count').textContent=c.tasks.total+' ('+c.tasks.completed+' done)';
    }
  }catch(e){document.getElementById('dao-health-status').innerHTML='<span class="badge badge-err">offline</span>';}
}
async function loadGithub(){
  try{
    var r=await fetch('/api/dao/github',{signal:AbortSignal.timeout(10000)});
    if(!r.ok) return;
    var d=await r.json();
    if(d.total_repos) document.getElementById('gh-repo-count').textContent=d.total_repos;
    if(d.recent_commits&&d.recent_commits.length){
      var last=d.recent_commits[0];
      var msg=(last.commit&&last.commit.message||'').split('\\n')[0].slice(0,40);
      var when=new Date(last.commit.author.date).toLocaleDateString();
      document.getElementById('gh-last-commit').textContent=msg+' ('+when+')';
      document.getElementById('gh-recent-commits').innerHTML=d.recent_commits.slice(0,5).map(function(c){
        var m=(c.commit&&c.commit.message||'').split('\\n')[0].slice(0,34);
        var repo=(c.html_url||'').split('/').slice(-2,-1)[0]||'?';
        var w=new Date(c.commit.author.date).toLocaleDateString();
        return '<div class="msg" style="margin:.25rem 0"><b>'+esc(repo)+'</b>: '+esc(m)+' <span style="color:var(--muted)">('+w+')</span></div>';
      }).join('');
    }
  }catch(e){}
}
async function loadGossip(){
  try{
    var r=await fetch('/api/dao/gossip?topic=fleet-broadcast&limit=8',{signal:AbortSignal.timeout(8000)});
    if(!r.ok) return;
    var d=await r.json();
    var el=document.getElementById('gossip-list');
    if(d.success&&d.messages&&d.messages.length){
      el.innerHTML=d.messages.map(function(m){
        var t=new Date(m.timestamp||m.time).toLocaleTimeString();
        var who=esc(m.agent||m.agentLabel||'?');
        var msg=esc((m.message||'').slice(0,140));
        return '<div class="msg"><b>'+who+'</b> <span style="color:var(--muted)">'+t+'</span><br>'+msg+'</div>';
      }).join('');
    } else { el.innerHTML='<div style="color:var(--muted)">No recent messages</div>'; }
  }catch(e){}
}
renderWorkers(); setInterval(renderWorkers, 60000);
loadDao();    setInterval(loadDao,30000);
loadGithub(); setInterval(loadGithub,60000);
loadGossip(); setInterval(loadGossip,30000);
`;

function dashboardHTML(cert) {
  return pageShell({
    title: "Fleet Dashboard",
    primaryColor: "#f97316",
    currentNav: "Dashboard",
    who: 'Welcome, <b>' + escapeHtml(cert.agent_id || cert.cert_id) + '</b>',
    body: DASH_BODY,
    script: DASH_SCRIPT,
    cert: cert.cert_id,
  });
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") return jsonResponse({ ok: true, worker: "dashboard", ts: Date.now() });

  // Login
  if (path === "/api/login" && request.method === "POST") {
    let body; try { body = await request.json(); } catch(e) { return errorResponse("invalid json", 400); }
    if (!body || !body.cert_id) return errorResponse("missing cert_id", 400);
    const v = await verifyCert(body.cert_id);
    if (!v.valid) return errorResponse("invalid cert: " + (v.error || "rejected"), 403);
    const cookie = "xmrt_cert=" + encodeURIComponent(body.cert_id) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400";
    return new Response(JSON.stringify({ ok: true, cert_id: v.cert_id, agent_id: v.agent_id }), {
      status: 200, headers: Object.assign({ "Content-Type": "application/json", "Set-Cookie": cookie }, CORS),
    });
  }
  if (path === "/api/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: Object.assign({ "Content-Type": "application/json", "Set-Cookie": "xmrt_cert=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" }, CORS),
    });
  }

  // Authenticated API endpoints (same as api-gateway)
  if (path.startsWith("/api/")) {
    const auth = await requireCert(request);
    if (!auth.ok) return jsonResponse(auth.body, auth.status);

    if (path === "/api/me") {
      return jsonResponse({ cert_id: auth.cert.cert_id, agent_id: auth.cert.agent_id, permissions: auth.cert.permissions, expires_at: auth.cert.expires_at });
    }
    if (path === "/api/workers/status") {
      const results = await checkAllWorkers(SUBWORKERS);
      return jsonResponse({ ok: true, ts: Date.now(), workers: results });
    }
    if (path === "/api/dao/health") {
      try {
        const [hr, sr] = await Promise.all([
          fetch(SUPABASE_URL + "/system-health", { signal: AbortSignal.timeout(8000) }),
          fetch(SUPABASE_URL + "/system-status", { signal: AbortSignal.timeout(8000) }),
        ]);
        const health = hr.ok ? await hr.json() : { error: "system-health " + hr.status };
        const status = sr.ok ? await sr.json() : { error: "system-status " + sr.status };
        return jsonResponse({ success: true, supabase_via: "relay.mobilemonero.com", health, status, ts: new Date().toISOString() });
      } catch (e) { return jsonResponse({ success: false, error: e.message }, 502); }
    }
    if (path === "/api/dao/gossip") {
      const topic = url.searchParams.get("topic") || "fleet-broadcast";
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      try {
        const gr = await fetch(SUPABASE_URL + "/gossip-hub/history", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, limit }), signal: AbortSignal.timeout(8000),
        });
        const gbody = gr.ok ? await gr.json() : { error: "gossip " + gr.status };
        return jsonResponse({ success: gr.ok, topic, messages: gbody.messages || gbody.result || [], ts: new Date().toISOString() });
      } catch (e) { return jsonResponse({ success: false, error: e.message, topic }, 502); }
    }
    if (path === "/api/dao/github") {
      try {
        const [reposR, commitsR] = await Promise.all([
          fetch("https://api.github.com/search/repositories?q=org:" + GITHUB_ORG + "&sort=updated&per_page=8", {
            headers: { "Accept": "application/vnd.github+json", "User-Agent": "xmrt-dao-dashboard" },
            signal: AbortSignal.timeout(8000),
          }),
          fetch("https://api.github.com/repos/" + GITHUB_ORG + "/mobilemonero/commits?per_page=5", {
            headers: { "Accept": "application/vnd.github+json", "User-Agent": "xmrt-dao-dashboard" },
            signal: AbortSignal.timeout(8000),
          }),
        ]);
        const repos = reposR.ok ? await reposR.json() : { items: [], total_count: 0 };
        const commits = commitsR.ok ? await commitsR.json() : [];
        return jsonResponse({ success: true, total_repos: repos.total_count || 0, repos: (repos.items || []).slice(0,8), recent_commits: commits });
      } catch (e) { return jsonResponse({ success: false, error: e.message }, 502); }
    }
    if (path === "/api/dao/mining") {
      try {
        const mr = await fetch("https://pool.supportxmr.com/api/network/stats", { signal: AbortSignal.timeout(8000) });
        const mbody = mr.ok ? await mr.json() : { error: "pool " + mr.status };
        return jsonResponse({ success: mr.ok, stats: mbody });
      } catch (e) { return jsonResponse({ success: false, error: e.message }, 502); }
    }
    return errorResponse("Not Found: " + path, 404);
  }

  // HTML pages
  if (path === "/" || path === "" || path === "/index.html" || path === "/dashboard") {
    const auth = await requireCert(request);
    if (!auth.ok) {
      return new Response(loginHTML(auth.body.error), { status: auth.status, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS) });
    }
    return new Response(dashboardHTML(auth.cert), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return errorResponse("Not Found: " + path, 404);
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request); }
};
