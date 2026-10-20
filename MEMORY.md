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

## OpenCode Zen free tier is in-client only
Every `*-free` Zen model except `space-bunny-free` returns
`403 "OpenCode's free tier can only be used from within OpenCode"` when called from
outside the OpenCode client. Verified and recorded in
`suite/supabase/functions/_shared/unifiedAIFallback.ts` (~line 926). Do not re-add
other free Zen models to `OPENCODE_ZEN_MODELS` without a fresh 200 from this runtime.

## Jev is not free and not usable here
Investigated 2026-10-05. TypeSafe's Jev decision model:
- OpenRouter `typesafe/jev-1.13` = $0.042/MTok in; `:free` variant has `endpoints: []`
- Zen `jev-1.13-free` exists but is in-client-only (above)
- `models.dev` has no `typesafe` provider, so opencode cannot select it at all
- Zen endpoint is `/zen/v1/systemone`, not `/chat/completions` — not a cascade tier

Verdict: not reliably free from either provider. Decision was to skip it.
