#!/usr/bin/env node
// agent-work-executor-tick.mjs — one bounded executor pass, for cron.
// POSTs execute_pending_work (max 5) to the local edge function and prints
// a one-line result. Non-zero exit on transport/edge failure so the cron
// log records it. The edge function itself is fail-safe: no AI means
// work_failed with nothing written (honesty gate).
const res = await fetch('http://127.0.0.1:54321/functions/v1/agent-work-executor', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: 'local-anon-key' },
  body: JSON.stringify({ action: 'execute_pending_work', max_tasks: 5 }),
  signal: AbortSignal.timeout(240000),
});
const data = await res.json().catch(() => ({}));
const results = data.results || [];
const done = results.filter((r) => r.status === 'work_done').length;
const failed = results.filter((r) => r.status !== 'work_done').length;
console.log(`[executor-tick] processed=${data.tasksProcessed || 0} done=${done} failed=${failed}`);
for (const r of results) {
  console.log(`  - ${r.task_id} ${r.status} ${r.item_completed || r.error || ''}`);
}
if (!res.ok || data.error) {
  console.error('[executor-tick] edge error:', data.error || res.status);
  process.exit(1);
}
