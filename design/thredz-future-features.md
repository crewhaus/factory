# Thredz feature requests from CrewHaus v0.3.0 (the memory release)

**Destination:** `thredz-api/docs/feature-requests/` — same format as `thredz-feature-requests.md`, whose prior 15 items all shipped.
**Rule of engagement:** nothing here is on the 0.3.0 critical path. Each item lists the 0.3.0 feature that wants it and the local workaround 0.3.0 ships in the meantime. Priorities: **P1** = unblocks a designed 0.3.x/0.4.x capability, **P2** = quality/scale, **P3** = nice-to-have.

---

## P1 — Sharing & scoping

### 1. Account-scoped (or grant-based) goals/tasks visibility
Goals/tasks reads are hard-scoped to the calling **keyId** (`pages/api/goals/index.js:16-25`), so two agents (keys) under one account cannot see a shared plan; `allowedGraphs` is reserved and unenforced. CrewHaus multi-agent harnesses (crew shape, fleet) want a shared goal board.
**Proposed:** a per-key `goalScope: key | account` (default `key` for compat), or graph-level grants that actually enforce `allowedGraphs`.
**0.3.0 workaround:** shared plans stay in the local plan store; only single-key goal sync is wired.

### 2. Team / selective sharing tier for wiki articles
Visibility today is binary: `private` (one account) or `shared` (**every** Thredz account, globally — and it's the default). "Share between a chosen set of agents/accounts" doesn't exist.
**Proposed:** `visibility: team` + a team/namespace grant object (account allowlist), with slug shadowing rules documented (`private` > `team` > `shared`).
**0.3.0 workaround:** CrewHaus forces `visibility: private` on every write; cross-harness sharing goes through local `crewhaus knowledge sync`.

### 3. Account-level default visibility + visibility everywhere on the write path
`shared`-by-default is a foot-gun for agent memory (docs already carry a warning). thredz-mcp v0.2.0 adds a `visibility` param to `wiki_write` (CrewHaus enforces `private` deterministically), but the safe default belongs server-side.
**Proposed:** `defaultVisibility` on the account/key doc; honored by POST/PATCH and by dispatch `wiki.write`.

## P1 — Proof, state, and failure surfacing

### 4. Evidence payloads on task/goal completion (proof-of-action)
CrewHaus 0.3.0's proof ladder attaches verifiable evidence (`toolUseId`, input hash, result digest) to every locally-proven step. Thredz `tasks/{id}/complete` takes no evidence, and the activity feed records API mutations only.
**Proposed:** optional `evidence: [{kind, ref, digest, note?}]` on task/goal completion, stored immutably and returned in `/history`; a `verified` flag distinct from "completed".
**0.3.0 workaround:** proof excerpts are frozen into local plan/wiki records only.

### 5. Usage / entitlement introspection endpoint
A key cannot ask "what plan am I on, how many goals/articles/messages remain, is billing healthy?" — quota state surfaces only reactively as 402/403 at write time. CrewHaus goal-6 failure messaging wants to warn **before** the failure.
**Proposed:** `GET /api/usage` → `{plan, entitlements, counts: {goals, tasks, wikiArticles, messagesToday}, remaining, keyDisabled, rateLimit: {rpm, remaining}}`.
**0.3.0 workaround:** boot-time `wiki_stats` probe + reactive mapping of 402/403/429 into clear degrade messages.

### 6. TTL'd session-state / checkpoint KV
Everything durable in Thredz is an article, record, log, or message. CrewHaus keeps focus/ledger/handoff local because a racy reserved-slug convention is the only server-side option (version-checked PATCH helps but isn't a state primitive).
**Proposed:** a small KV object store: `PUT /api/state/{key}` `{value ≤64KB, ttl?}`, `GET`, `DELETE`, CAS via version — the "current focus / handoff" slot a fresh session fetches in one call.
**0.3.0 workaround:** focus/ledger/dream state are local-only by design.

## P1 — Events & scheduling

### 7. `wiki.*` webhook events
`VALID_EVENTS` covers task/goal/record/message/milestone/threshold — **no wiki events** (`lib/webhookEvents.js:10-21`). A continual-learning harness cannot be woken by wiki changes (e.g., a teammate-agent's contradicting edit).
**Proposed:** `wiki.created / wiki.updated / wiki.signals_changed` (content-free doorbell like `message.received`).

### 8. Server-side consolidation ("dream on the server")
CrewHaus 0.3.0 orchestrates consolidation client-side (dedupe, staleness, merge candidates). Some of it is cheaper and atomic server-side.
**Proposed (incremental):** batch endpoints first — `POST /api/wiki/dedupe-report` (near-duplicate/contradiction candidates by semantic similarity), `POST /api/wiki/merge {into, from[], editMessage}` (atomic, versioned) — then optionally a scheduled server job emitting a `wiki.consolidation_report` webhook.
**0.3.0 workaround:** dream-engine does all of this locally via wiki_list/related/write.

### 9. Agent wake-up scheduling
Task cron replication exists, but nothing can *wake an agent* on a schedule; CrewHaus scaffolds GH-Actions crons instead.
**Proposed:** scheduled webhook (`schedule.tick` event with a payload the harness maps to `crewhaus dream run` or a heartbeat) — pairs with item 7 to make Thredz the fleet's clock.

## P2 — Retrieval & search

### 10. Cross-entity recall
`/wiki/context` is the only recall bundle; goals/tasks/records have field filters but no text/semantic search. "What was I doing about X" spans goals+tasks+wiki+messages.
**Proposed:** `GET /api/context?q=` returning a typed, ranked bundle across entities (wiki hits with bodies, matching open tasks/goals, recent related messages).

### 11. HTTP-manageable embedding providers
`wikiEmbeddingProviders` are Desktop/Electron-IPC-managed only; a hosted account cannot select or rotate its embedding provider via the API, so semantic quality depends on the operator's active provider.
**Proposed:** CRUD under `/api/wiki/embedding-providers` (admin key), provider health in `/wiki/stats`.

## P2 — API ergonomics & scale

### 12. Normalize the goals API quirks
`GET /goals/{id}` returns a single-element **array**; `increase`/`decrease` are atomic but not idempotent (no Idempotency-Key support on those verbs). The MCP client papers over both; the API should fix them (versioned route or opt-in header).

### 13. Redis-backed rate limiting & quota counters
The RPM limiter is an in-process Map and quotas are count-then-insert (documented bounded overage) — fine today, but a CrewHaus **fleet** hammering one hosted instance behind a load balancer needs the documented Redis-backed variant before fleet-scale Thredz adoption.

## P3

### 14. Wiki revision-history & restore via MCP-visible API surface
Versions/diff/rollback exist over HTTP but aren't exposed as MCP tools; an agent reflecting on "how did this article evolve" would use `GET .../versions` + `/diff`. (This is mostly a thredz-mcp addition, listed here so the API's pagination on versions is confirmed stable for tool use.)

### 15. Read-only "memory audit" export for operators
One call that exports an account's agent-memory footprint (articles + signals + gaps + goals) in a reviewable bundle — pairs with CrewHaus's `crewhaus memory show` so operators can audit what their agents know on the server side, and supports GDPR-style review/delete workflows.

---

### Cross-reference: which 0.3.0 feature wants what

| 0.3.0 feature | Items |
|---|---|
| Shared plans / crew + fleet memory | 1, 2, 13 |
| Safe-by-default wiki writes | 3 |
| Proof ladder server-side | 4, 15 |
| Failure messaging (goal 6) | 5 |
| Session pickup via Thredz | 6 |
| Continual learning triggers | 7, 8, 9 |
| Best-in-class recall | 10, 11 |
| Goals backend | 12 |
