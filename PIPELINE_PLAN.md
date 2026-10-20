# Jobs and tasks: what exists now, and the plan to make it one pipeline

**Status: investigation complete, no changes made yet.** This is the plan that was
asked for. Every number below was read from the running database (`xmrt_suite`) and
from the running scheduler, not from a README.

---

## How this was established

- Enumerated every base table and view in every schema whose name implies work
  (`task`, `job`, `work`, `queue`, `run`, `schedul`, `pipeline`, `execution`,
  `dispatch`, `todo`, `action`, `item`, `step`, `ticket`, `issue`).
- Took live row counts for each.
- Read the scheduler itself (`relay/cron-engine-v2.mjs`) to see which sources it
  loads, rather than assuming.
- Read `public.cron_execution_log` for the last 24 hours and all-time per loop.
- Found writers and readers by grep, then confirmed intent by reading the call site.
- **Did not trust names.** Several names lie; they are called out below.

---

## 1. The stores that hold "work" — there are five, across three schemas

| Store | Rows | Written by | Read by | Verdict |
|---|---|---|---|---|
| `app.tasks` | 694 | relay `/api/tasks` (`server.js` 3022, 5827), `xmrtdao-suite-mcp.mjs`, `fleet-chat-task-creator`, `task-orchestrator`, `agent-work-executor` (removed) | relay, `fleet-announcer.mjs`, dashboard | **the only real board.** `public.tasks` is a view over it. |
| `app.work_queue` (view: `public.work_queue`) | 23 | three cuttlefish endpoints: agent-onboard, proposal-submit, agent-x-post (`server.js` 15212, 15306, 15366) | **nothing** except one `count(*)` in a stats endpoint (`server.js` 2421) | **orphan queue.** Oldest row 2026-06-25; 4 `timed_out`, 19 `pending` forever. |
| `public.agent_tasks` | 2 | page-agent path | — | **duplicate** of `agent.agent_tasks` |
| `agent.agent_tasks` | 0 | relay `agent_tasks` tool (`server.js` 18559) | relay tool | same concept, different schema |
| `public.task_executions` | 0 | nothing | `timeout-stale-tasks` cron updates it | **dead table with a live cron** (4×/hour, forever) |
| `fleet_ops.work_claims` / `execution_receipts` | 8 / 23 | retired workgate | nothing | frozen history — leave it |

Also empty and unreferenced: `public.task_templates`, `public.task_blocker_resolutions`,
`public.util_scheduled_tasks` (0) alongside `util.util_scheduled_tasks` (12).

The `public.work_queue` view is a simple `SELECT ... FROM app.work_queue`, so the
three endpoints' inserts silently land in `app.work_queue`. Nothing ever consumes
them, so a governance request becomes a row that no one reads.

---

## 2. The loops: they all "succeed", and none of them closes a task

From `cron_execution_log`, last 24 hours. "Recorded result" is the actual payload
the runner stored for the most recent run.

| Loop | Schedule | Runs/24h | Recorded result | What it visibly changes |
|---|---|---|---|---|
| `task-auto-advance-fast` (JSON 169) | `*/10` | 388 | `{"rows": null, "status": 200}` | **9 tasks are past the 48h threshold and still open** |
| `task-orchestrator-assign` (83) | `*/10` | 388 | `{"rows": null, "status": 200}` | 32 tasks still `PENDING/PENDING`; several unassigned, oldest 2026-09-27 |
| `task-orchestrator-blockers` (85) | `0,10,...,50` | 388 | `{"rows": null, "status": 200}` | — |
| `task-orchestrator-rebalance` (84) | `0,15,30,45` | 243 | `{"rows": null, "status": 200}` | — |
| `task-orchestrator-report` (86) | `14 * * * *` | 44 | `{"rows": null, "status": 200}` | — |
| `fleet-chat-task-creator` (227) | `17,47` | 86 | `{"rows": null, "status": null}` | created **445** identical `"Process update request from fleet discussion"` tasks; they were bulk-cancelled on 2026-10-17 |
| `task-nudge` (`cron.job` 13) | `17 * * * *` | 58 | `{"rows": 68}` | 368 rows in `task_nudge_log`, **0 acknowledged** |
| `agent-workflow-engine` (`cron.job` 3) | `*/10` | 388 | completed | **its command is `node relay/scripts/health-check.mjs`** — the name lies; this is a health check, not the task workflow engine |
| `agent-work-executor` | removed | — | — | removed this session (0 tasks ever reached DONE; narration and empty searches only) |

`app.task_artifacts`: 11 rows across 5 tasks, and **8 of the 11 have an empty
`artifact_url`**. The evidence-based advancement mechanism exists and is almost
never used, and its few rows are empty shells.

So: eight "completed" runs per 10 minutes, and the visible, dated outcome is a
board whose oldest item has not moved since 2026-09-27.

---

## 3. Two schedulers, and one runner with two disagreeing sources

There are **two independent duplication mechanisms**, and they multiplied.

**(a) Two daemons.** `relay/server.js:16353` started an in-process
`runDaemon()` (unless `SKIP_CRON=1`, which nothing sets), while
`supervisor.mjs:285` separately starts `node relay/cron-engine-v2.mjs --daemon`.
Both daemons share `relay-data/cron-engine-v2-state.json`. Each loaded the state
before the other had saved `lastRun`, so the per-minute guard
(`lastRun[job.id] === thisMin`) did not hold and a job scheduled in a given
minute ran once per daemon. Measured: every job recorded **2 rows per scheduled
minute**; jobs that were also duplicated across sources recorded **4**. Fixed
2026-10-19 by removing the in-process daemon.

**(b) Two sources merged by id.** `relay/cron-engine-v2.mjs:232`
`loadJobsFromPg()` reads **both** `cron.job` (a 53-row table in the DB) **and**
`relay-data/cron-jobs.json` (82 entries), and merges them by id. The two files
use different id ranges for the same logical job, so 19 jobs were loaded twice.

Evidence:

- `cron.job` has **19 duplicate-name pairs.** Eighteen are an "off" mirror and an
  "on" one. `purge-cron-execution-logs` (ids 31 and 52) are **both enabled**, so it
  purges twice an hour.
- `cron-jobs.json` carries its own duplicates, with notes admitting it:
  - `task-auto-advance` (170, disabled, note "Duplicate of 169"), `task-auto-advance-batch` (197, disabled), `task-auto-advance-fast` (169, enabled)
  - `suite-task-automation-engine` (181, **disabled**), `suite-task-automation-alt` (168, **disabled**), `suite-task-auto-engine` (182, **disabled**)
  - three entries invoking `task-orchestrator` under different names (83/84/85 enabled)
- The engine's own comment claims it audited "all 85 commands in cron.job plus
  cron-jobs.json"; `cron.job` actually holds 53 rows and the JSON 82 entries.

The fix that was applied earlier to duplicated *ghost* jobs (repointing
`public.cuttlefish_agents` → `app.registry_agents`, deleting broken ids) treated
symptoms. The duplication is structural.

---

## 4. The STAE the question asked about

`suite-task-automation-engine` is invoked by three JSON entries — 181
(`suite-task-automation-engine`), 168 (`suite-task-automation-alt`), 182
(`suite-task-auto-engine`) — and **all three are `disabled: true`**, each carrying
the note:

> `[DISABLED: was writing FABRICATION_DETECTED events directly, bypassing graduated scoring]`

It has **zero rows in `cron_execution_log`**. So the STAE is real code, is
scheduled, and has been switched off — it was disabled for writing fabrication
events, which is a governance decision, not an accident. It is not part of any
running loop today.

---

## 5. The one loop that does run is a different domain and errors every pass

`app.job_cycles`: **18,913 rows.** `cron-engine-v2` (worker id `PURETREK:12464`,
i.e. the engine's own PID) runs "Jobby Heartbeat" **192×/24h**. Every recent cycle:

```
status=error   decision=source
reason: "Pipeline is 0 deep, under the floor of 5. Sourcing is cheaper than
         discovering the pipeline was empty later."
step worklist: { ok:false, note:"no dossier on file yet, so there is no plan to work from" }
```

So the job-search loop spins ~190 times a day and every single pass is the same
error. It is busy, not working.

---

## 6. The stage vocabulary is not enforced, and it disagrees with itself

`app.tasks` has **two** axes, `stage` and `status`, and **no CHECK constraint on
either** (verified: `pg_constraint` has no `contype='c'` rows for `app.tasks`).
The values in use:

```
stage : PENDING, DISCUSS, PLANNING, EXECUTE, INTEGRATE, COMPLETION, COMPLETED, CLOSED
status: PENDING, IN_PROGRESS, REVIEW, DONE, COMPLETED, CANCELLED, CLOSED
```

`COMPLETION` and `COMPLETED` are both stages; `DONE` and `COMPLETED` are both
statuses; `CLOSED` is both. Because nothing constrains the pair, rows exist in
combinations that mean nothing: `PENDING/DONE`, `CLOSED/CLOSED`,
`COMPLETED/DONE` **and** `COMPLETED/COMPLETED`.

`app.suite_pipeline_stages` (`scraping → qualify → quote → contract → paid →
fulfilled`) is a **separate, coherent sales pipeline** joined to `app.suite_leads`,
not to tasks. That one is fine. The confusion in reading the code is that both are
called "pipelines" and both live under `app`, while the task board's own vocabulary
is the unconstrained one.

---

## 7. The diagnosis, in one paragraph

There is no pipeline. There is one task board (`app.tasks`) with two unconstrained
and contradictory status axes; an orphan governance queue written by three
endpoints and read by nobody; two more agent-task tables in two schemas; a dead
table updated four times an hour; two scheduler daemons plus two merged job
sources, so jobs run two to four times per scheduled minute; eight loops that
report `{"rows": null, "status": 200}` every
few minutes and close nothing; one of those eight is misnamed and is actually a
health check; the real automation engine (STAE) is disabled for fabricating events;
and the only loop that genuinely runs (Jobby) fails identically ~190 times a day.
The board's only recent movement was a human bulk-cancelling 445 tasks a bot had
auto-created from chat. **Nothing in this system advances a piece of work because
of evidence.**

---

## 8. Target model — one board, one queue, one scheduler, one closing rule

**A. One task store.** `app.tasks` stays (most truth; `public.tasks` already aliases
it). Everything else is migrated in or retired:
- `app.work_queue` → migrate its 23 rows into `app.tasks` (`category='governance'`),
  repoint the three cuttlefish endpoints, drop the view and table. A queue with no
  consumer is a table, not a queue.
- `public.agent_tasks` → merge into `agent.agent_tasks` (the relay tool already
  targets it), drop the other.
- `public.task_executions` → drop it and the `timeout-stale-tasks` cron that writes it.
- `fleet_ops.*` → leave frozen as history.

**B. One scheduler, one source.** `relay-data/cron-jobs.json` becomes the single
source (it is versioned, reviewable, and already carries `disabled` + `note`).
`cron.job` is generated from it at engine start, or dropped. No job may exist in two
places. Then remove the duplicate ids (170, 197, 168, 182) and the 19 mirror rows in
`cron.job`.

**C. One vocabulary, enforced as constraints.** Define the real task stages
(`PENDING → PLANNING → EXECUTE → VERIFY → REVIEW → DONE`, plus terminal
`CANCELLED`/`CLOSED`), migrate the 694 existing rows with a script that **reports
every value it cannot map**, then add CHECK constraints. A comment is not a
constraint.

**D. The closing rule: evidence, never time.**
- A task may only leave `EXECUTE` when `app.task_artifacts` has a row with a
  **non-empty `artifact_url`** and an allowed `artifact_type`.
- Empty artifacts do not count. (The 8 empty `screenshot` rows are exactly what to
  reject.)
- No artifact → cannot pass `VERIFY` → goes to `REVIEW` with a reason, which is the
  honest terminal state the removed executor already used.
- `auto_advance_threshold_hours` stops being an advancement trigger; elapsed time
  becomes a *stall flag* only.

**E. Loops must report what they changed.** Every loop returns the count of rows it
actually modified. The runner records it. A loop that reports 0 changes for N
consecutive runs is auto-disabled and announced once — instead of being logged
`completed` with `rows: null` forever.

**F. Chat does not create a task per message.** `fleet-chat-task-creator` produced
445 identical tasks in a day and a half. It should produce at most one *reviewable*
suggestion per explicit request, deduplicated by subject.

---

## 9. Migration order — each step independently verifiable

1. **Freeze and count** (done). Snapshot: 694 tasks, 23 queue rows, 2+0 agent-tasks.
2. **Kill duplicate engines** — **done 2026-10-19.** See §12.
3. **One scheduler**: engine loads only `cron-jobs.json`, or generates `cron.job`
   from it. *Verify:* diff the loaded list against the file; no side can add a job.
4. **Migrate the orphan queue**: `app.work_queue` → `app.tasks`; repoint the three
   endpoints; drop the view then the table after confirming 0 readers.
   *Verify:* submitting one proposal creates exactly one `app.tasks` row and zero
   `work_queue` rows.
5. **Merge agent-task tables** into one; drop the other. *Verify:* both writers land
   in the same table.
6. **Drop `task_executions` + its cron.** *Verify:* table gone, no cron references it.
7. **Stage vocabulary + CHECKs**, via a mapping script that reports unmappable rows.
   *Verify:* the constraint exists in `pg_constraint`; the script's unmappable count
   is 0 or is explained, never silently coerced.
8. **De-conflate the two pipelines**: rename the task board's vocabulary so it cannot
   be read as the sales pipeline, and ensure no query mixes them.
9. **Evidence-gated advancement** (rule D), with `task-auto-advance` returning counts.
10. **Auto-disable dead loops** (rule E).
11. **Jobby heartbeat**: either fix the dossier precondition or stop scheduling it.
    190 erroring passes a day is worse than no loop — it makes the log look busy.

---

## 10. What I will not do

- Not mark tasks DONE to clear the board.
- Not invent a stage for a row I cannot classify — unmappable rows get reported.
- Not rewrite an archive/manifest from live state.
- Not delete `fleet_ops` history.
- Not claim a loop works because it returns HTTP 200.

---

## 11. The one decision this plan needs

Whether **`app.tasks` remains the canonical board** (recommended — highest truth,
fewest migrations) or a new table is built and `app.tasks` is imported into it.
Everything else in the plan follows from that choice.

---

## 12. Applied 2026-10-19 — duplicate schedulers

Decision taken: keep `app.tasks`; first cut is the duplicate schedulers.

**What was found and changed**

- **Removed the in-process cron daemon** from `relay/server.js` (it called
  `runDaemon()` at startup while the supervisor also ran
  `cron-engine-v2.mjs --daemon`). This was the second, independent cause of
  double execution and it was not visible in the code the runner uses.
- **`relay/scripts/dedupe-cron-sources.mjs`** (new, dry-run by default,
  idempotent) then:
  - deleted **19** redundant `cron.job` rows: 18 disabled mirrors and the
    duplicate enabled `purge-cron-execution-logs` (52; 31 kept);
  - disabled **19** JSON entries whose SQL *and* schedule already existed as an
    enabled `cron.job` row (78, 79, 80, 81, 82, 103, 104, 105, 141, 153, 173,
    174, 175, 198, 199, 201, 221, 301, 302);
  - deleted **12** JSON entries: the four disabled duplicates (170, 197, 168,
    182) and eight `SELECT 1` placeholders (ids 1–7, 12) whose ids are shadowed
    by `cron.job` and which were never loaded — they claimed, for example, that
    `sync-hermes-memory` ran `SELECT 1`.
  - wrote an immutable record of the deleted DB rows to
    `relay-data/cron-job-removed.json`.

**Verification**

- `loadJobsFromPg()`: 103 jobs loaded, 62 enabled, **0 enabled logical
  duplicates** (grouped by command/function + schedule).
- `cron.job`: 53 → 34 rows. `cron-jobs.json`: 82 → 70 entries. Second run of the
  script: 0 deletions, 0 disables.
- Live `cron_execution_log`, after the relay restart, five consecutive ticks:

  ```
  12:15  capture-lock-blockers      n=1   (was 2-4)
  12:18  timeout-stale-tasks        n=1   (was 2-4)
  12:19  process-scheduled-actions  n=1   (was 2)
  12:20  capture-lock-blockers      n=1
  12:20  task-auto-advance-fast     n=1   (was 2)
  12:20  task-orchestrator-assign   n=1   (was 2)
  ```

**Left running, deliberately**

- `task-auto-advance-fast`, the four `task-orchestrator-*` loops, and
  `fleet-chat-task-creator` still run (once each now). They are the subject of
  §8–§9, not of this cut.
- `sync-hermes-memory`, `pipeline-orchestrator`, `hermes-comms` are **disabled in
  `cron.job`**, so they do not run at all. The JSON `SELECT 1` copies made them
  look scheduled. This is reported, not silently re-enabled.
- `suite-task-automation-engine` remains disabled by its own entry (all three
  had `disabled: true`); the two duplicate entries are now deleted.

---

## 13. The pipeline that could not run (2026-10-19, later)

§12 left the board clean and the scheduler de-duplicated. It did not make
anything EXECUTE, and the reason was not the one the fleet was reporting.

### 13.1 Three diagnoses, all wrong

| Claim | Checked against | What the evidence said |
|---|---|---|
| "the executor is blind to the database - ECONNREFUSED 127.0.0.1:5432" | `relay-data/cron-engine-v2.log` | 6625 occurrences, the last at **2026-10-17T22:50** - an outage two days old. None since; Postgres answered every query in this session (32 of 200 connections in use). |
| "task-runner.mjs is in-memory only, that is the root cause" | `relay/lib/task-runner.mjs` | It is an in-memory queue, but it is not on the task path: nothing that advances `app.tasks` imports it. |
| "fleet-chat-followup 'state is not defined' is live" | `cron_execution_log` | The last failure was 17:30; the 12 runs after it were clean. |

The executor was not failing either. The `agent-work-executor` job called
`app.run_agent_work_executor(integer)`, and that function does not exist - a
ghost job, retired at 17:21 after 2438 consecutive failures.

### 13.2 Nothing could be assigned

`app.agents` had **no CHECK on status**, so two spellings of one state could
exist. Twelve agents said `BUSY` while holding zero tasks; the only row the
orchestrator could see said `idle`, and it belonged to "Eliza-Dev", which is not
in `app.registry_agents` at all.

- `relay/migrations/tasks_013_agent_status_vocab.sql`: one vocabulary
  (`IDLE|BUSY|OFFLINE`), status and workload derived from the tasks an agent
  actually holds, `OFFLINE` preserved.
- `task-orchestrator`: assignment is limited to **registered** agents and
  **unowned** tasks, so a free agent can no longer take a task Vex or Eliza is
  already working. The `clear_all_workloads` action - which deleted every task
  on the board with no record - is refused.

**Verified**: at 20:30 the orchestrator assigned **9 unowned tasks to 9
registered idle agents**. No task owned by Vex, Eliza or Builder moved; the
held GPU task was not assigned; `clear_all_workloads` left the task count at
695.

### 13.3 The evidence gate now covers both doors

`trg_enforce_task_completion_evidence` fired `BEFORE UPDATE OF stage`. A task
could be marked `COMPLETED` by updating only its status, with no artifact and
no trigger. `relay/migrations/tasks_014_completion_status_evidence.sql` closes
that door.

**Verified**: `UPDATE ... SET status='COMPLETED'` is rejected with 23514
without an artifact and accepted with one.

### 13.4 The shared AI gateway did not compile

`suite/supabase/functions/_shared/ai-gateway.ts` had one line collapsed into
literal `\n` escapes, leaving the original provider array orphaned outside the
object literal. Every function importing it failed to load - which is why nine
`superduper-*` jobs failed on **every** run with "operation aborted due to
timeout".

Repaired and re-measured from this runtime before anything was put in the list:

| Provider | Model | Measured |
|---|---|---|
| OpenRouter | `minimax/minimax-m3.1-flash:free` | 200 in 1015 ms, native tool_calls |
| OpenRouter | `nvidia/nemotron-3.5-lightning:free` | 200 in 1746 ms, native tool_calls |
| OpenRouter | `google/gemma-4-31b-it:free` | in the catalog; 429 "rate-limited upstream" |
| OpenCode | `minimax-m3.1-flash-free` | **403** outside OpenCode; paid slugs **402** (no funds) |
| Ollama cloud | `gemma4:31b`, `glm-5.3-flash:cloud` | **429** - all three keys out of quota |
| Local Ollama | `gemma3:1b` | 200, but 21 s on CPU |

The free tier leads the cascade, the unfunded and exhausted providers are tried
last, and a quota answer now marks the provider unavailable instead of being
retried forever.

**Verified**: `superduper-research-intelligence` returns HTTP 200 in 13.5 s,
and the 21:18 cron run of it **completed** - against 130 consecutive timeouts
before.

### 13.5 The PFP inbox had a lead in it and no pipeline behind it

`/webhook/resend-inbound` never called `captureInboundEmail`; only the
15-minute poller did, and it was also writing a second lead per sender into
`app.suite_leads` - the exact duplicate-lead behaviour the contact model exists
to prevent.

- the webhook now captures PFP inbound as it arrives, keyed on Resend's own
  message id so it and the poller cannot both create a lead;
- `app.suite_leads` is no longer written for PFP (the dashboard reads
  `pfp_leads` via `/api/leads/pfp`);
- an inbound row with no outcome is now treated as **unfinished**, not as a
  processed duplicate, so a capture that threw can be run again.

`pfp_leads.first_reply_at` and `contract_sent_at` were `text` columns while
the code wrote `NOW()` into them and read one back as a timestamp:
`COALESCE(text, NOW())` has no common type, so **every reply from a known
contact raised 42804** and left its inbound row with `outcome IS NULL`.
`relay/migrations/pfp_012_lead_timestamp_types.sql` gives them the type they
were always meant to have.

**Verified end to end** through the real webhook: a stranger's message creates
one lead, the studio's own address is `internal_ignored`, and a second sender
on the same thread is `contact_attached` to that same lead with no second lead
created. 73 lost replies were recovered onto the leads they belonged to
(67 attachments, 6 internal, **0 new leads**); the NULL-outcome backlog went
from 184 to 111.

The Jaffee booking is now one row with two contacts - lead `80c50fb4`, stage
`booked`, 2026-11-08, Historic Rosemont (Rosemont Manor) - and all eleven
messages on that thread resolve to it.

### 13.6 Tests

`relay/tests/pfp-lead-contacts.test.mjs` covers the six cases: an internal
address, a known contact, a second sender on one thread, a merged duplicate
resolving to its survivor, a contact that belongs to somebody else's event,
and two leads both claiming one booking. All checks pass.

Full suite: **43 passed, 7 failed**. The same seven fail on a pristine
checkout of HEAD (dashboard template, function catalog, cron classification,
markdown rendering, fleet-chat dedupe, supervisor services) - pre-existing,
not from this work.

### 13.7 Left open

- **111 inbound rows** still have no outcome. They are first-time senders -
  newsletters, funding mail, receipts - and deciding which were genuine
  enquiries is a judgement about the business, not a repair. Twenty mention our
  service; eight of those are an FCPS school contract thread worth a look.
- **nine `superduper-*` jobs** still fail on every run. The gateway is fixed,
  but each of them is a persona that posts to fleet chat, and they are the
  source of most of the noise in it.
- **`agent-workflow-engine`** is named in `cron.job` but runs `health-check.mjs`.
  Its own advancement code duplicates `task-auto-advance` with a second stage
  vocabulary (`PLAN`, `VERIFY`), so it must not be scheduled until that is
  reconciled.
- local Ollama is the only provider that does not depend on somebody else's
  quota, and it answers in 21 s on this box.

---

## 14. The pipeline that ran, and what it actually did (2026-10-20)

At 02:00 the board looked alive: the ten tasks assigned at 20:30 had been
executed between 23:10 and 23:50, each with an artifact, each now `DONE`. It
was the first evidence that the pipeline worked end to end. It was also the
first evidence that "worked" and "done" had nothing to do with each other.

### 14.1 What the ten completions contained

| Task | Assignee | Done | Evidence |
|---|---|---|---|
| Implement Sovereign Nervous System Core | sovereign-001 | 23:10 | work-log → the task's own page |
| GH#89 Deploy Local XMRT University Edge Function | hermes-001 | 23:20 | 2 empty-URL screenshots + work-log → own page |
| GH#95 Dashboard Bulletin Board Integration | arch-001 | 23:20 | work-log → own page |
| GH#147 PFP Lead Coordination (Da'Monique) | trib-001 | 23:20 | work-log → own page |
| GH#187 Fleet Chat / Gossip Hub Endpoint | global-communicator-001 | 23:20 | 1 empty screenshot + work-log → own page |
| GH#188 CRITICAL: Fleet Relay Connectivity | trustgraph-001 | 23:20 | 2 empty screenshots + work-log → own page |
| Review knowledge base health | alice-001 | 23:30 | 2 work-items + work-log, all → own page |
| Fix stale PFP inbox feed | dao-001 | 23:40 | work-log → own page |
| Implement Proactive Initiation Listeners | jobby-001 | 23:40 | work-log → own page |
| Canonicalize PFP bookings persistence | vex-001 | 23:50 | 1 empty screenshot + work-item + work-log → own page |

The checklist on the five GitHub-imported tasks was the generic template
("Analyze requirements", "Plan implementation", "Implement solution", "Create
PR", "Review and merge"), and the recorded work result for most items was
`Executed knowledge-manager: {"ok":true,"data":{"entities":[],"count":0}}` - a
knowledge search that found nothing. For GH#187 the agent's own summary said
"none of the available tools (...)" could do the work, and the item was
recorded as complete anyway.

The artifact URL in every case was
`https://relay.mobilemonero.com/api/suite/tasks/<the task's own id>`.

### 14.2 The evidence rule, and what it was missing

`trg_enforce_task_completion_status_evidence` asked for "an artifact carrying
a non-empty artifact_url" and got one - a pointer to the thing that was
supposed to be proven. The guard could check the shape of evidence but not its
substance.

**The whole system's evidence ledger**: 25 artifacts - 11 screenshots with an
empty URL, 11 work-logs and 3 work-items, every one of the 14 with a URL
pointing at its own task. **Zero acceptable artifacts, ever.**

`relay/migrations/tasks_016_evidence_not_self_referential.sql` now rejects
self-referential evidence: an artifact whose URL points back at its own task
does not count. `app.task_has_real_evidence(task_id)` answers the question
for any task.

Consequences, applied to the live board:

- the 11 executor-completed tasks were **reopened** to `REVIEW` with
  `terminal_reason='evidence_self_referential'`. The work is not proven, and
  the board must not say it is;
- the other 173 terminal tasks were **flagged**, not reopened. Their work may
  well be real - pull requests, deployments, a 93-task cleanup session on
  2026-09-27 - and it simply never recorded a URL. The status was left alone
  and the gap recorded on the task.

### 14.3 A task can leave the board without being done

`relay/migrations/tasks_015_task_closure_reasons.sql` adds `closed_reason`
(`superseded | already_done | duplicate | not_needed | blocked | cancelled`)
and `superseded_by`, with the rules as constraints: a task cannot be called
superseded without naming the survivor, cannot be its own survivor, and a
superseded task must be terminal.

### 14.4 The executor now asks whether the work is still work

`relay/functions/agent-work-executor/index.ts`:

- **held tasks are never worked** - the batch query filters on
  `blocking_reason IS NULL`, and the check is repeated inside the work
  function so `process_single_task` cannot bypass it;
- **a pre-flight** asks one question, against the state of the whole board
  (the other open tasks are read and the near-misses by title are shown):
  `NEEDED | ALREADY_DONE | SUPERSEDED | CANNOT_PROCEED`. Anything unclear is
  NEEDED - doing a task that did not need doing costs one pass, dropping a task
  that did costs work nobody notices is missing;
- **the proof has to resolve.** Asking a model for a URL and believing it is
  how a completion gets an invented address on it: in a live test the model
  answered ALREADY_DONE with `https://example.com/pfp-booking-tables-state` for
  a task whose only work had been a knowledge search that returned nothing.
  That URL does not exist. Evidence is now fetched, and only a 2xx/3xx
  counts;
- **a completion needs a deliverable that points at the work** - a file, a
  pull request, a deployed endpoint. With none, the task goes to `REVIEW` with
  `terminal_reason='no_deliverable_evidence'`; with one that does not
  resolve, `evidence_url_unresolved`.

**Verified live**: a held task is skipped (`awaiting_operator`), a worked task
that produced no deliverable is parked in `REVIEW` instead of being marked
done, and the database independently refuses `status='DONE'` for it.

### 14.5 The stall: a cache of the board, never refreshed

Nine agents held **zero** tasks, said `BUSY`, and so the orchestrator saw no
free agent - while thirteen unowned tasks sat on the board. `app.agents` was a
cache of the board that nothing ever recomputed.

The orchestrator now reads the live task set every cycle, corrects each
agent's status and workload to match, and assigns from that count rather than
from the stored flag. Reconciled: 4 BUSY (15 tasks), 9 IDLE, and the
unowned backlog released.

### 14.6 The honest limit

The executor's tool set is a knowledge search and edge-function invocation. It
cannot write a file, open a pull request, or deploy anything. Every task that
asks for an implementation is therefore beyond it - which is why the five
GitHub tasks were "completed" by a search that found nothing. Those tasks
will now park in `REVIEW` instead of being completed, and that is the correct
outcome: the board will show that they were not done, and the work needs an
executor with hands.

### 14.7 Tests

- `relay/tests/task-evidence-gate.test.mjs` - the self-referential rule, the
  closure vocabulary, the supersede rules, and the hold. All pass.
- `relay/tests/pfp-lead-contacts.test.mjs` - one event, many people. All pass.
- Full suite: **44 passed, 6 failed** - the same six that fail on a pristine
  checkout of HEAD, plus `catalog-render`, which now passes.
- `tasks_one_open_per_title` exists in the test database (a migration creates
  it there) but **not in production**: eight rows - four pairs of assigned
  duplicate tasks - still block it, which is the known blocker from §12.

---

## 15. The harness: the fleet gets hands (2026-10-20)

The executor could not implement anything. Its whole tool set was a knowledge
search and an edge-function call, so "Implement X" became a plan written into
a work log, and the work log was then cited as proof (§14). The stack already
had a coding agent with hands - OpenCode - and it was unreachable.

### 15.1 Two supervisors, and the one that was running

There are two supervisor files: `supervisor.mjs` at the root and
`relay/supervisor.mjs`. The **root** one is what runs (`node supervisor.mjs
--serve`).

It spawns services with `env: { ...process.env }` and **never applied the
`env` a service declared**. The opencode service declared an env block - and
it was dead code. So the OpenCode server took its API key and its password
from whatever the operator's launcher happened to carry, the fleet's client had
no way to know that password, and every connection was refused.

Three fixes to the root supervisor:

- a service's declared env is applied last, so what it declares wins;
- `relay/.env` is read at boot and handed to the services that ask for it;
- the opencode service's env names the OpenCode API key and the one password
  the server and its client must agree on, both from `relay/.env`.

The supervisor was restarted (it health-checks every service and adopts the
healthy ones, so only the opencode server was actually replaced).

### 15.2 How the password is presented

The CLI sends `Authorization: Basic base64("opencode:" + password)`. With the
shared value in `relay/.env`:

- `GET /api/info` -> 200
- `GET /api/session` -> 200
- `POST /api/session` -> 200 (a session is created)
- `POST /api/session/{id}/prompt` -> 200, with `text` as the body key (not
  `parts`; `/message` is a GET route and 404s on POST)
- `GET /api/session/{id}/message` -> the reply, once the message has
  `time.completed`

### 15.3 The proxy injects it, so nothing has to know it

`relay/harness-proxy.mjs` already injected dsh's auth cookie. It now injects
the OpenCode credential the same way, for requests that arrive without one.
So the path an agent uses is the path the operator's dashboard uses: the
loopback proxy on **:4130** (opencode) and **:4131** (dsh), which the
dashboard's opencode and dsh buttons already point at.

**Verified with no credential anywhere in the caller**: a session was created
through :4130, prompted, and answered.

### 15.4 The free models

- `opencode-go`'s `minimax-m3.1-flash-free` answers **403: "an active OpenCode
  Go subscription is required to use Go models"** on this account, and the
  other key in the tree is invalid (401) with no funds (402). That is an
  account fact, not a code fault: it needs a Go subscription or a balance.
- Leaving the model unset makes the server choose, and it picks
  `ollama-cloud/minimax-m3.1-flash`, which is free and answered in seconds.
  That is why the executor does not force a model.
- OpenRouter's free tier works and needs no subscription:
  `minimax/minimax-m3.1-flash:free` -> 200 in ~1s with native tool calls, and
  it is already the gateway's primary (§13).

### 15.5 The executor uses it

`relay/functions/agent-work-executor/index.ts` now asks OpenCode to do the
work when a checklist item is a verb, and falls back to the knowledge path
when it is not. It waits for the message to finish streaming before reading it
(the parts of an unfinished message are the model's reasoning, which is how a
finished piece of work was once recorded as "the worker replied with nothing"),
and it records the tools the worker used, because "wrote the file" is evidence
in a way a paraphrase of it is not.

**Verified**: a probe task with the step "Create the file worker-probe.md in
the repository root" was executed by the executor; the file was really
written; the work log records the summary and the tool calls; the item was
completed and the progress moved to 100%.

The worker is asked to commit and to reply with the commit URL. Until it does,
the task parks in `REVIEW` with `no_deliverable_evidence` - which is the
honest outcome: the work is recorded, and completion still needs an address
that can be checked.

## 16. Two faults the audits had stopped looking at (2026-10-20)

Both of these were found by walking the product rather than by reading it.
Neither was visible in a log, and one of them was hidden by the very rule
that was supposed to catch it.

### 16.1 The evidence gate was asking about the wrong task

`app.task_has_real_evidence(task_id)` was written as:

```sql
SELECT EXISTS (
  SELECT 1 FROM app.task_artifacts a
   WHERE a.task_id = task_id
     AND a.artifact_url IS NOT NULL
     AND btrim(a.artifact_url) <> ''
     AND NOT app.artifact_is_self_referential(a.artifact_url, task_id))
```

In PostgreSQL, when a SQL function's parameter has the same name as a column
of a table in its FROM clause, **the column wins** for an unqualified
reference. So `a.task_id = task_id` was really `a.task_id = a.task_id` - true
of every row in the table - and the function answered *does ANY artifact
anywhere carry a real URL?* instead of *does THIS task?*

It did not show, and that is the dangerous part of it. Every artifact the
fleet had produced was either an empty screenshot or a pointer to its own
task, so the global answer and the per-task answer happened to be the same
answer. The first real deliverable - a pull request URL - would have opened
the gate for every task on the board at once, silently, and the board would
have said the work was done.

The **triggers** that enforce the rule were already correct
(`a.task_id = NEW.id`), so the guard itself held. The published oracle did
not, and the oracle is what the executor, the board and the next reader
trust.

The parameters are now renamed rather than qualified - a name a column can
shadow is a trap - which means dropping and recreating both functions.
PostgreSQL will not rename a parameter through `CREATE OR REPLACE`, and
nothing depends on them: the triggers call them from inside a plpgsql body,
which is resolved at run time.

`app.task_artifacts` also had **no foreign key to `app.tasks`**, so an
artifact could outlive the task it described and sit in the table pointing
at nothing. It carries one now, `ON DELETE CASCADE`: an artifact whose task
is gone cannot be opened or checked by anyone.

**Verified**: `app.task_has_real_evidence('no-such-task-id-xyz')` returns
false in both databases; another task's evidence is not this task's
evidence; an artifact for a task that does not exist is refused (23503);
deleting a task takes its evidence with it.

### 16.2 Fifty-seven pairs of functions shared a port

The local runtime served each edge function on a port derived from its name:
`37000 + (md5(name) % 1000)`. A thousand ports, about three hundred and
fifty functions. Fifty-seven pairs of functions were allocated the same port,
and the first one to bind it answered for the other.

The catalogue endpoint was one of them. `list-available-functions` was being
answered by the **task orchestrator**, which is why the dashboard's function
list had lost every description and fallen back to a flat array of names. The
relay's own comment said the function "is not responding" and could not be
fixed from there. It was answering perfectly well - for a different function.

The hash now spreads over eight hex digits across the window Deno will
accept (37,000-64,999; it refuses a port of 65536 or above), and the caller
checks the port is not already held and steps past it if it is, which is
what actually makes a collision harmless.

**Verified on the running runtime**: fifteen function processes, none sharing
a port; every function probed answers with its own shape; the catalogue comes
back from the edge function with 250 entries and no missing descriptions.

### 16.3 Five audits that had stopped auditing

The suite was 44 of 51, and most of the failures were audits whose premise
had rotted - which is how an audit stops being an audit without anyone
noticing.

- The dashboard template was extracted out of `server.js` into
  `campus-page.mjs` on 2026-10-10. Three tests still read `server.js` for
  it. They now read the page for the template and `server.js` for the
  generator and the registry, which is where the two halves now live.
- The supervisor audit **could not evaluate the services array at all**: its
  sandbox wrapped everything in a proxy that claimed every name, so
  `process.env` resolved to the proxy's empty string and the array threw
  before a single assertion ran. It is the check that would have caught the
  supervisor ignoring the environment a service declares, and the one that
  would have caught a service that was listed but never started.
- `fleet-chat-dedupe` completed its probe task by updating the status
  directly. That is no longer allowed - a task reaches DONE only with an
  artifact that points at the work - so the probe is given one, and the test
  now checks the task really closed rather than taking the completion on
  trust.
- The announcer exists only in `cron.job` since the JSON placeholder was
  removed on 2026-10-19. `cron.job` is production configuration and the test
  database is a schema-only copy whose `cron.job` has no rows, so asking it
  proved nothing. Both audits read the live schedule now, and skip loudly if
  it cannot be reached.

### 16.4 The suite is green

**51 of 51 pass.** That is the whole relay suite, against the throwaway test
database, with the exit code checked.
