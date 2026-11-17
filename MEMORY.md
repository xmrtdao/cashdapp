# Memory

## Live AI provider credentials
`relay/.env` is the single place the live AI provider keys live:
- `OPENROUTER_API_KEY` — SET, 73 chars
- `OPENCODE_API_KEY` — SET, 51 chars
- `OPENCODE_BASE_URL` — SET, 26 chars (OpenCode Zen)
- `OPENCODE_MODELS` — SET, 16 chars

**Never print these values.** Report shape and length only, per `AGENTS.md`.

Note: these are **not** in the process environment — an agent that only checks `Env:`
will conclude no key exists. Read `relay/.env` directly.

## OpenCode Zen free tier status (updated 2026-11-17)

`space-bunny-free` (the one slug previously thought reachable) now returns
`400 "Model is unavailable"` from `https://opencode.ai/zen/v1/chat/completions`.
Verified live on 2026-11-17: status 400, body `{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`.

Conclusion: **no** `*-free` Zen model is reachable from the relay anymore —
all of them (space-bunny-free included) are in-client-only / retired. The
OpenCode Zen tier in `relay/tools/ollama-chat.mjs` is now an empty list so it
is skipped instead of burning the timeout budget. Do not re-add any free Zen
slug without a fresh 200 from this runtime.

## Jev is not free and not usable here
Investigated 2026-10-05. TypeSafe's Jev decision model:
- OpenRouter `typesafe/jev-1.13` = $0.042/MTok in; `:free` variant has `endpoints: []`
- Zen `jev-1.13-free` exists but is in-client-only (above)
- `models.dev` has no `typesafe` provider, so opencode cannot select it at all
- Zen endpoint is `/zen/v1/systemone`, not `/chat/completions` — not a cascade tier

Verdict: not reliably free from either provider. Decision was to skip it.
