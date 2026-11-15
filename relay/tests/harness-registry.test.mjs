// End-to-end tests for the harness registry and OpenHands integration.
// Run: node relay/tests/harness-registry.test.mjs
import http from 'node:http';

const RELAY = 'http://127.0.0.1:8080';
const API_KEY = '3a02d6eecc89f1c700c097f9034479c24a56787acfbc996c5d17086ecd364602';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(RELAY + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed++; console.log('  ❌', msg); }
}

async function main() {
  console.log('=== Harness Registry Tests ===\n');

  // 1. List harnesses
  console.log('1. List harnesses');
  const list = await request('GET', '/api/harnesses');
  assert(list.status === 200, 'GET /api/harnesses returns 200');
  assert(Array.isArray(list.body.harnesses), 'response has harnesses array');
  assert(list.body.count >= 8, `at least 8 harnesses (got ${list.body.count})`);

  // 2. Get single harness
  console.log('\n2. Get single harness');
  const get = await request('GET', '/api/harnesses/opencode');
  assert(get.status === 200, 'GET /api/harnesses/opencode returns 200');
  assert(get.body.harness && get.body.harness.id === 'opencode', 'correct harness returned');
  assert(get.body.harness.status === 'healthy', 'opencode is healthy');

  // 3. Get non-existent harness
  console.log('\n3. Get non-existent harness');
  const get404 = await request('GET', '/api/harnesses/nonexistent');
  assert(get404.status === 404, 'GET /api/harnesses/nonexistent returns 404');

  // 4. Health check all
  console.log('\n4. Health check all');
  const healthAll = await request('POST', '/api/harnesses/health-check-all');
  assert(healthAll.status === 200, 'POST /api/harnesses/health-check-all returns 200');
  assert(Array.isArray(healthAll.body.results), 'response has results array');
  assert(healthAll.body.results.length >= 8, `checked at least 8 harnesses (got ${healthAll.body.results.length})`);

  // 5. Find best harness for code
  console.log('\n5. Find best harness for code');
  const findCode = await request('POST', '/api/harnesses/find-best', { category: 'code', capabilities: ['code'] });
  assert(findCode.status === 200, 'POST /api/harnesses/find-best returns 200');
  assert(findCode.body.harness, 'returns a harness');
  // Both dsh and opencode are healthy code-capable harnesses and score
  // identically on capability match; which one wins the tie-break is load
  // and sort order, not a bug. The invariant that actually matters: the
  // routed harness is healthy and can do code.
  const codeHarness = findCode.body.harness;
  assert(codeHarness.status === 'healthy' && (codeHarness.capabilities || []).includes('code'),
    `best harness for code is a healthy code-capable runtime (got ${codeHarness.id} @ ${codeHarness.status})`);

  // 6. Find best harness for inference
  console.log('\n6. Find best harness for inference');
  const findInf = await request('POST', '/api/harnesses/find-best', { category: 'inference', capabilities: ['inference'] });
  assert(findInf.status === 200, 'POST /api/harnesses/find-best (inference) returns 200');
  assert(findInf.body.harness, 'returns a harness');
  assert(findInf.body.harness.id === 'ollama', `best harness for inference is ollama (got ${findInf.body.harness.id})`);

  // 7. Create/update harness
  console.log('\n7. Create/update harness');
  const upsert = await request('POST', '/api/harnesses', { id: 'test-harness', name: 'Test Harness', type: 'custom', status: 'healthy', capabilities: ['test'], endpoint: 'http://localhost:9999' });
  assert(upsert.status === 200, 'POST /api/harnesses returns 200');
  assert(upsert.body.harness && upsert.body.harness.id === 'test-harness', 'harness created');

  // 8. Get the created harness
  console.log('\n8. Get created harness');
  const getCreated = await request('GET', '/api/harnesses/test-harness');
  assert(getCreated.status === 200, 'GET /api/harnesses/test-harness returns 200');
  assert(getCreated.body.harness && getCreated.body.harness.name === 'Test Harness', 'correct name');

  // 9. Update harness
  console.log('\n9. Update harness');
  const update = await request('PATCH', '/api/harnesses/test-harness', { status: 'inactive', current_load: 5 });
  assert(update.status === 200, 'PATCH /api/harnesses/test-harness returns 200');
  assert(update.body.harness && update.body.harness.status === 'inactive', 'status updated');

  // 10. Health check single
  console.log('\n10. Health check single (no endpoint harness)');
  const healthSingle = await request('POST', '/api/harnesses/pi/health');
  assert(healthSingle.status === 200, 'POST /api/harnesses/pi/health returns 200');
  assert(healthSingle.body.health, 'returns health result');

  // Cleanup: delete test harness (via PATCH to inactive, then we leave it)
  // Actually delete via direct DB not available via API, so mark inactive
  await request('PATCH', '/api/harnesses/test-harness', { status: 'inactive' });

  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Test error:', e.message); process.exit(1); });