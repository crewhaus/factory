# Recipe 33 — Prompt Caching

> **Status:** stub.

## What you'll learn

How `prompt-cache-manager` rotates Anthropic `cache_control` markers
on a 7-day-default schedule (30-day hard limit), why it skips for
OpenAI (server-managed) and Bedrock Llama/Mistral (no caching), and
how to tune rotation cadence to match your prompt-stability profile.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The Anthropic `cache_control` model: ephemeral cache markers on system blocks; markers expire after 5 minutes by default; rotation extends life.
2. `prompt-cache-manager.manage(systemBlocks, opts)`: walks blocks, strips intermediate markers, places fresh `{ type: "ephemeral" }` on the LAST block when the most recent rotation is past `rotateAfterMs` (default 7 days).
3. The hard limit: rotation never exceeds 30 days — stale prompts always get re-cached.
4. Per-provider behavior: skip when `features.caching === "automatic"` (OpenAI) or `=== false` (Bedrock Llama/Mistral); apply when `=== "explicit"` (Anthropic + Anthropic-on-Bedrock + Gemini).
5. Where it lives in the call path: `runtime-core` runs it during pre-stream system-block construction so adapters never need to know.
6. Cost impact: re-using a cache hit costs a tiny fraction vs the input-token cost of re-priming.
7. Tuning: lower `rotateAfterMs` for prompts that change daily, higher for static prompts.
8. Observability: cache hits show up in cost_accrual events as zero/discounted input tokens.

## Run it now

```bash
bun test packages/prompt-cache-manager
```

## Pointers to existing material

- **Module:** [`packages/prompt-cache-manager`](../../packages/prompt-cache-manager).
- **Adapter integration:** [`packages/adapter-anthropic`](../../packages/adapter-anthropic).
- **Catalog:** §27.

## Where to go next

- For cost reporting that proves the cache is working → [Recipe 17 — Observability](17-observability.md).
- For the Anthropic auth setup → see `.env.example` at the repo root and the [Anthropic billing docs](https://docs.anthropic.com/en/api/getting-started).
