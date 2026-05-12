# Recipe 33 — Prompt Caching

How `prompt-cache-manager` rotates Anthropic `cache_control` markers
on a 7-day-default schedule (30-day hard limit), why it skips for
OpenAI (server-managed) and Bedrock Llama/Mistral (no caching), and
how to tune rotation cadence to match your prompt-stability profile.

You'd reach for explicit cache tuning when:

- Your agent has a **large stable system prompt** (skills registry,
  RAG corpus, instructions) and is re-invoked many times per day.
- You see **input-token costs dominate** your bill — caching cuts
  these by ~90% for the cacheable prefix.
- You're operating across **multiple providers** and want to
  understand per-provider cache behavior.

For low-volume CLI usage, caching is a nice-to-have — the manager's
defaults work without tuning.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- An Anthropic account (the explicit-caching path) for hands-on
  experimentation.

## How Anthropic prompt caching works

Anthropic's API accepts `cache_control: { type: "ephemeral" }`
markers on system blocks. Marked blocks (and everything that comes
before them in the request) are eligible for cache reuse on
subsequent requests.

Cache lifetime:

- A cache entry **expires after 5 minutes** of inactivity (sliding
  window).
- Re-hitting a cache entry **resets the 5-minute timer**.
- Cache **hits** cost ~10% of fresh input tokens; cache **writes**
  cost ~125% of fresh input tokens (one-time write cost).

So the math is: if your system prompt averages 2 hits per 5-minute
window, caching saves money. Below that, the write cost dominates.

## Why the manager exists

Without management, you'd have to:

- Decide which system blocks to mark `cache_control`.
- Rewrite the mark periodically (markers are tied to specific token
  positions; small prompt edits can invalidate them).
- Skip the mark on providers that don't support it.

The `prompt-cache-manager` ([packages/prompt-cache-manager](../../packages/prompt-cache-manager))
encapsulates this:

```typescript
const managed = promptCacheManager.manage(systemBlocks, {
  rotateAfterMs: 7 * 24 * 3600 * 1000   // 7 days
});
```

Returns a system-block array with the `cache_control` marker placed
on the last block. The marker is **rotated** on a schedule.

## The rotation policy

The manager keeps a tiny state file (`.crewhaus/prompt-cache-state.json`):

```json
{
  "lastRotation": "2026-05-08T14:00:00Z",
  "hash": "sha256:abc..."
}
```

Rules:

1. **Rotate if** the prompt hash changed since the last rotation
   (prompt content drifted).
2. **Rotate if** more than `rotateAfterMs` has elapsed (default 7
   days).
3. **Hard rotate every 30 days** regardless, so a static prompt
   doesn't sit on a stale cache reference forever.
4. **Skip rotation** for providers that don't need it (see next
   section).

What "rotate" means concretely:

- The manager **strips all existing `cache_control` markers** from
  intermediate blocks.
- Places a single fresh `{ type: "ephemeral" }` marker on the **last**
  block.

So at any given moment, only the last block carries the marker. The
rotation ensures that marker is "fresh enough" that the next request
within 5 minutes will hit cache.

## Per-provider behavior

The adapter declares its caching policy:

| Provider                         | `features.caching` | Manager behavior                              |
| -------------------------------- | ------------------ | --------------------------------------------- |
| Anthropic direct                 | `"explicit"`       | Apply markers, rotate per policy.             |
| Anthropic on Bedrock             | `"explicit"`       | Apply markers, rotate per policy.             |
| Gemini                           | `"explicit"`       | Apply markers (Gemini supports its own ephemeral caching). |
| OpenAI                           | `"automatic"`      | Skip — OpenAI caches server-side automatically. |
| Bedrock Llama / Mistral          | `false`            | Skip — provider has no caching layer.          |

For mixed-provider specs, the manager looks at the **active** model's
adapter declaration. A fallback list with both Anthropic and OpenAI
gets the marker only when routed to Anthropic.

## Where it runs in the call path

`runtime-core` calls `manage` during pre-stream system-block
construction:

```
runChatLoop
  └─ buildSystemBlocks
     ├─ render skills frontmatter
     ├─ render permissions / mode reminders
     ├─ render compaction status
     └─ promptCacheManager.manage(blocks, opts)
        ↓
       (final blocks with cache_control)
  └─ adapter.complete(blocks, ...)
```

The adapter never sees the rotation logic — it just receives
already-marked blocks. So adding a new adapter doesn't require any
cache-aware code.

## Cost impact

Per Anthropic's published rates (subject to change; see
[`packages/model-router/src/pricing.ts`](../../packages/model-router)
for the table the cost-tracker uses):

| Operation                        | Cost factor                                |
| -------------------------------- | ------------------------------------------ |
| Fresh input tokens               | 1.0× (baseline)                            |
| Cache write                      | ~1.25× the input cost (one-time per cache entry) |
| Cache read (hit)                  | ~0.1× the input cost                        |

For a 10k-token system prompt with 100 requests in 5 minutes:

- **Without caching**: 100 × 10k × 1.0 = 1,000,000 input tokens.
- **With caching**: 1 × 10k × 1.25 + 99 × 10k × 0.1 = 12,500 + 99,000
  = 111,500 input tokens.

~9× savings. The break-even is **about 2 hits per cache window**
(write cost / fresh cost = 1.25; one write + N hits = N × 0.1 +
1.25 must beat (N+1) × 1.0, giving N ≥ 2).

## Tuning

Defaults:

| Option            | Default                                       |
| ----------------- | --------------------------------------------- |
| `rotateAfterMs`   | 7 days (7 × 24 × 3600 × 1000 ms).             |
| `hardLimitMs`     | 30 days.                                       |
| `stateFile`       | `.crewhaus/prompt-cache-state.json`.          |

When to tune:

- **`rotateAfterMs` shorter** (e.g. 24 hours) — for prompts that
  evolve daily (RAG corpus updated nightly, skills added often).
  Each rotation costs a cache write, so rotate only as often as
  the prompt actually changes.
- **`rotateAfterMs` longer** (e.g. 14 days) — for very stable prompts
  (large but unchanging system instructions). The 30-day hard limit
  caps the upper end.
- **Per-run** rather than per-day — for ephemeral specs (one-off
  scripts), pass `rotateAfterMs: 0` to disable persistence and let
  the per-process cache marker handle the brief lifetime.

## Observability

Cache hits show up in `cost_accrual` events as discounted input
tokens:

```json
{
  "kind": "cost_accrual",
  "model": "claude-sonnet-4-6",
  "inputTokens": 10240,
  "cachedInputTokens": 9892,   // these cost ~0.1× normal
  "freshInputTokens": 348,
  "outputTokens": 412
}
```

`cost-tracker` aggregates these per session, per tenant, per model.
The grafana panel in [Recipe 17](17-observability.md) carries a
`prompt_cache_hit_rate` metric: `cachedInputTokens / inputTokens`.

A healthy production agent should have a cache hit rate above 70%
on a steady-state hour. Below 50% suggests either a too-short cache
window (5-minute timer expiring between requests) or a prompt that's
churning more than expected.

## Cache invalidation triggers

Things that invalidate a cache entry:

- **Any change to system blocks before the marker.** Even a one-byte
  diff in a stable block breaks the cache (it's position-tied).
- **5-minute idle.** No reads = expiry.
- **30-day hard rotation.** Forced fresh cache.

Things that **don't** invalidate:

- Conversation turns appended after the marked system blocks.
- New tool calls / tool results.
- Per-request variations after the marker.

So order matters: put **stable content first** in your system blocks
(instructions, skill registry, RAG corpus), then put **dynamic content
last** (today's date, current user context). Only the stable prefix
caches.

## Worked observation

```bash
CREWHAUS_TRACE=json bun run run:hello 2>&1 | jq -c 'select(.kind=="cost_accrual")'
```

After 10 turns in the same session:

```json
{"inputTokens": 4823, "cachedInputTokens": 0,    "freshInputTokens": 4823, ...}
{"inputTokens": 4892, "cachedInputTokens": 4612, "freshInputTokens": 280, ...}
{"inputTokens": 4951, "cachedInputTokens": 4612, "freshInputTokens": 339, ...}
```

First turn: cold cache (write cost). Subsequent turns: ~95% of input
tokens served from cache.

## Things that look like cache tuning but aren't

| Symptom                                                            | Better tool                                       |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| Long-running daemon, intermittent prompt changes.                  | Default settings; the manager handles it.          |
| Per-tenant prompts with no cross-tenant sharing.                   | Default settings; the marker is per-prompt-hash.   |
| Want to **disable** caching for a regulated workload.              | `agent.promptCache: false` in spec.                |
| Want to **share cache** across agents with similar prompts.        | Already happens — same prompt hash → same cache.   |

## What to read next

- **Cost reporting that proves caching works.** [Recipe 17 — Observability](17-observability.md).
- **Multi-provider with mixed cache behavior.** [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- **Local models (no caching).** [Recipe 32 — Local Models](32-local-models.md).

## Pointers to source

- **Cache manager:** [`packages/prompt-cache-manager`](../../packages/prompt-cache-manager).
- **Anthropic adapter (consumes the markers):** [`packages/adapter-anthropic`](../../packages/adapter-anthropic).
- **Module catalog reference:** §27 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
