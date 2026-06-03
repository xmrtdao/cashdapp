#!/usr/bin/env node
/**
 * setup-pfp-worker-route.mjs
 *
 * One-shot script to deploy the inbox-proxy worker to the PFP CF account
 * and bind it to inbox.partyfavorphoto.com/* as a Worker route.
 *
 * REQUIRES: a Cloudflare API token for the PFP account with these scopes:
 *   - Account.Workers Scripts:Edit
 *   - Account.Workers Routes:Edit
 *   - Zone.Workers Routes:Edit (for the specific zone)
 *   - Zone.Zone:Read
 *
 * Generate one in the PFP CF dashboard:
 *   https://dash.cloudflare.com/?to=/profile/api-tokens
 *   -> Create Token -> Edit Cloudflare Workers template
 *   -> Zone Resources: Include -> Specific zone -> partyfavorphoto.com
 *   -> Account Resources: Include -> My Account
 *
 * Usage:
 *   export PFP_CF_TOKEN=cfut_xxxxxxxx
 *   node scripts/setup-pfp-worker-route.mjs
 *
 * Or hardcode the token in the script (not recommended).
 */

const PFP_CF_TOKEN = process.env.PFP_CF_TOKEN || 'PASTE_TOKEN_HERE';
const PFP_ACCOUNT_ID = '1d3c74dd5a48bd894d860555190bc457';
const PFP_ZONE_ID = '6b2d4294731fb155cbfa552c68e08062';
const WORKER_NAME = 'inbox-proxy';
const ROUTE_PATTERN = 'inbox.partyfavorphoto.com/*';

const WORKER_SCRIPT = `// Forward requests to relay.mobilemonero.com (which has the tunnel to the local relay).
// Used for inbox.partyfavorphoto.com because the named tunnel 5d954e14-...
// lives in the mobilemonero.com CF account and Cloudflare doesn't support
// cross-account tunnel routing.

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  const target = 'https://relay.mobilemonero.com' + url.pathname + url.search

  const newHeaders = new Headers(request.headers)
  newHeaders.delete('host')
  newHeaders.delete('cf-connecting-ip')
  newHeaders.delete('cf-ray')

  try {
    return await fetch(target, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: 'follow',
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'upstream fetch failed', detail: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
`;

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${PFP_CF_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  if (PFP_CF_TOKEN === 'PASTE_TOKEN_HERE') {
    console.error('ERROR: Set PFP_CF_TOKEN env var or edit the script');
    process.exit(1);
  }

  console.log(`[1/3] Verifying token...`);
  const v = await api('GET', '/user/tokens/verify');
  if (!v.ok) {
    console.error('  Token verify failed:', JSON.stringify(v.data.errors));
    process.exit(1);
  }
  console.log(`  Token: ${v.data.result.id} (${v.data.result.status})`);

  console.log(`[2/3] Deploying worker "${WORKER_NAME}"...`);
  // Workers script upload takes raw JS body, not JSON-wrapped
  const rawRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${PFP_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${PFP_CF_TOKEN}`,
      'Content-Type': 'application/javascript',
    },
    body: WORKER_SCRIPT,
  });
  const rawData = await rawRes.json().catch(() => ({}));
  if (!rawRes.ok) {
    console.error('  Worker deploy failed:', JSON.stringify(rawData.errors || rawData));
    process.exit(1);
  }
  console.log(`  Worker deployed: id=${rawData.result?.id}`);

  console.log(`[3/3] Creating Worker route "${ROUTE_PATTERN}"...`);
  const route = await api('POST', `/zones/${PFP_ZONE_ID}/workers/routes`,
    { pattern: ROUTE_PATTERN, script: WORKER_NAME });
  if (!route.ok) {
    console.error('  Route create failed:', JSON.stringify(route.data.errors));
    process.exit(1);
  }
  console.log(`  Route created: id=${route.data.result?.id}`);

  console.log('');
  console.log('=== Setup complete ===');
  console.log(`Worker: ${WORKER_NAME}`);
  console.log(`Route: ${ROUTE_PATTERN} -> ${WORKER_NAME}`);
  console.log('');
  console.log('Testing in 5 seconds (allow CF propagation)...');
  await new Promise(r => setTimeout(r, 5000));
  try {
    const res = await fetch('https://inbox.partyfavorphoto.com/health');
    const body = await res.text();
    console.log(`inbox.partyfavorphoto.com/health -> ${res.status}: ${body}`);
  } catch (e) {
    console.error('Test failed:', e.message);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
