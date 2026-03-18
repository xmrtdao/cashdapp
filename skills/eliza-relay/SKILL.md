---
name: eliza-relay
description: >
  Bidirectional communication with cloud Eliza (SuiteAI). Use to:
  (1) send a request TO Eliza and get her Gemini-powered reply (eliza-relay),
  (2) poll for messages FROM Eliza addressed to you (openclaw-relay poll),
  (3) post your reply back to Eliza after handling her request (openclaw-relay reply).
  Never use "session send Eliza" — she is cloud-only and unreachable via local sessions.
---

# Eliza Relay Skill

## Direction 1 — OpenClaw → Eliza (you want Eliza's answer)

Call `eliza-relay` with `action: send`. Returns Eliza's Gemini reply **synchronously** in one round-trip — no polling needed.

### Edge Function (fast — PREFERRED)

```bash
curl -s -X POST "https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/eliza-relay" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhd291dWd0endtZWp4cWtlcXFqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc2OTcxMiwiZXhwIjoyMDY4MzQ1NzEyfQ.QH0k26R2xbf4U5z6BmdYG1h_lkeNQ41zDjqL2zWxzxU" \
  -H "Content-Type: application/json" \
  -d '{"action":"send","message":"What is the current Bitcoin price?","agent_name":"OpenClaw"}'
```

Response: `{ "relay_tag": "openclaw-relay-xxxx", "message_id": "...", "reply": "Eliza's answer", "reply_id": "..." }`

### Local Script (fallback if edge function unavailable)

```bash
node C:\Users\PureTrek\Desktop\DevGruGold\suite\scripts\eliza-relay.mjs "What is the current Bitcoin price?"
```

The script calls the same edge function internally — no polling loop.

---

## Direction 2 — Eliza → OpenClaw (Eliza sent you a task)

Eliza queues messages via `openclaw-relay send`. You must **poll** to retrieve them since you
have no public HTTP endpoint for Eliza to push to directly.

### Step A — Poll your inbox

```bash
curl -s -X POST "https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/openclaw-relay" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhd291dWd0endtZWp4cWtlcXFqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc2OTcxMiwiZXhwIjoyMDY4MzQ1NzEyfQ.QH0k26R2xbf4U5z6BmdYG1h_lkeNQ41zDjqL2zWxzxU" \
  -H "Content-Type: application/json" \
  -d '{"action":"poll"}'
```

Response: `{ "messages": [{ "id": "...", "content": "task text", "metadata": { "relay_tag": "eliza-relay-xxxx", ... } }] }`

Messages are automatically marked as read after polling — act on them before the next poll.

### Step B — Post your reply back to Eliza

After completing the task Eliza assigned, reply with:

```bash
curl -s -X POST "https://vawouugtzwmejxqkeqqj.supabase.co/functions/v1/openclaw-relay" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhd291dWd0endtZWp4cWtlcXFqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc2OTcxMiwiZXhwIjoyMDY4MzQ1NzEyfQ.QH0k26R2xbf4U5z6BmdYG1h_lkeNQ41zDjqL2zWxzxU" \
  -H "Content-Type: application/json" \
  -d '{"action":"reply","relay_tag":"eliza-relay-xxxx","reply":"Task complete. Result: ...","original_message_id":"<id from poll>"}'
```

---

## Function Reference

| Function | URL | Actions | Purpose |
|---|---|---|---|
| `eliza-relay` | `.../functions/v1/eliza-relay` | `send`, `check_reply`, `status` | OpenClaw→Eliza: send message, get Gemini reply |
| `openclaw-relay` | `.../functions/v1/openclaw-relay` | `send`, `poll`, `reply`, `status` | Eliza→OpenClaw: queue messages + OpenClaw polls |

Base URL: `https://vawouugtzwmejxqkeqqj.supabase.co`

## Key Notes

- `eliza-relay send` → synchronous reply (no polling needed after v2)
- `openclaw-relay poll` retrieves AND marks messages as read — process them before next poll
- Use `relay_tag` from Eliza's message when calling `reply` so she can correlate your response
- All messages are also visible in the SuiteAI Inbox at suite-beta.vercel.app
- Auth: service role key (hardcoded above) OR `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` env var
