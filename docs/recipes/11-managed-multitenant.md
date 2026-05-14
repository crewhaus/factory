---
test:
  spec: examples/hello-managed/crewhaus.yaml
  bun_scripts:
    - compile:hello-managed
    - run:hello-managed
---

# Recipe 11 — Managed Multitenant

Stand up a long-running gateway daemon that serves multiple tenants
behind a JSON-RPC protocol with HS256-JWT authentication, per-tenant
token budgets, hash-chained audit logs, and storage rebased per
tenant so cross-tenant reads are impossible.

You'd reach for `target: managed` when:

- You're shipping a **SaaS product** — multiple customers share one
  deployment, each isolated from the others.
- You need **per-tenant budgets** so one customer can't burn another's
  capacity.
- You need **audit evidence** for SOC 2 / ISO 27001 / HIPAA — every
  tool call recorded in a hash-chained log.
- You want **one deployment shape** for both internal API and the
  customer-facing SDK.

If you only have one tenant, use [`channel`](03-slack-bot.md) (for
chat input) or [`batch`](08-batch-worker.md) (for queue input).
Multi-tenant adds gateway overhead and operational discipline that's
not worth it for a single user.

<details>
<summary><strong>Architectural context</strong> — managed harnesses as a category, and the cost-per-successful-run frame</summary>

The `managed` target is crewhaus's open-source mapping for the
**managed harness platform** category that AWS AgentCore, Anthropic
Managed Agents, Azure Foundry, and Gemini Agent Engine all occupy
([docs/AI-Harness-Systems.md](../AI-Harness-Systems.md)). The
unifying lesson across those platforms is that the "managed" surface
is not just a deployment convenience — it's a **billing surface**.
Anthropic prices sessions in `running` state at $0.08/hour; OpenAI
charges tokens plus tool/container fees; Azure adds tool-specific
charges (Code Interpreter, Bing grounding); AWS bills AgentCore
runtime/gateway/memory separately. The architectural conclusion: when
sessions are long-lived and externally-triggered, **cost per
successful run** is the metric to instrument, not just token cost
per call.

That insight shapes three managed-target invariants:

- **Per-tenant budgets are first-class spec fields**, not external
  policy. The runtime stops the session when the budget exhausts;
  there is no graceful failure mode where one tenant's session
  silently bills another tenant.
- **Hash-chained audit logs** mirror the SOC 2 evidence collection
  pattern that every managed platform exposes (AgentCore observability,
  Foundry's Azure Monitor integration, Anthropic's persistent event
  history). The chain makes log tampering detectable, which is the
  property compliance auditors care about — not log volume.
- **Storage rebased per tenant** prevents the failure mode managed
  platforms work hardest to avoid: cross-tenant data leakage through
  a shared cache, a shared embedding store, or a shared session
  history. The same shape AWS uses for multi-tenant AgentCore
  deployments.

Pillar 3 implications ([CLAUDE.md](../../CLAUDE.md)): every JSON-RPC
inbound request carries authenticated tenant identity *and* unclassified
user text. Authentication says *who* sent the request; the
boundary-classifier still classifies the body as `TrustOrigin: "channel"`
before it reaches the model. Skipping the classifier for "authenticated"
tenants is the single most common managed-harness security regression
in the wild.

</details>

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md)
  for budget mechanics.
- [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md) if
  evidence collection is required.

## The smallest spec

The bundled example [`examples/hello-managed/crewhaus.yaml`](../../examples/hello-managed/crewhaus.yaml):

```yaml
name: hello-managed
target: managed
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a managed-daemon agent. Reply tersely (one short sentence).
tenants:
  - id: tenant-a
    budget:
      maxInputTokens: 100000
      maxOutputTokens: 20000
  - id: tenant-b
    budget:
      maxInputTokens: 100000
      maxOutputTokens: 20000
```

The shape:

- **`agent:`** is the **shared** chat-loop spec — every tenant runs
  the same agent. (If tenants need different agent configs, run
  multiple `target: managed` daemons.)
- **`tenants:`** declares the allowed tenant ids and each tenant's
  budget. Budgets are per-period; the default period is monthly
  rolling.

Run it:

```bash
bun run compile:hello-managed
bun run run:hello-managed
```

The daemon binds to `:3000` (override with `PORT=...`). The first
output line prints the auto-generated JWT secret — copy it. (For
production, set `CREWHAUS_GATEWAY_JWT_SECRET=<at least 16 chars>`
explicitly.)

## The gateway protocol

JSON-RPC 2.0 over HTTP. The methods:

| Method                   | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `runs.create`            | Start a new agent run; returns `runId`.                |
| `runs.continue`          | Send a follow-up user message to an existing run.      |
| `runs.cancel`            | Cancel an in-progress run.                             |
| `runs.subscribe`         | SSE stream of events for one run (live tail).          |
| `sessions.list`          | List the tenant's sessions.                            |
| `sessions.fork`          | Branch off a prior session at a chosen turn index.     |
| `audit.tail`             | Tail the tenant's audit log (admin-only).              |

Example call:

```bash
curl -X POST http://localhost:3000/rpc \
  -H "Authorization: Bearer $TENANT_A_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "runs.create",
    "params": {
      "input": "What's the capital of France?"
    }
  }'
```

The response carries `{ "runId": "run_abc123", "status": "running" }`.
Subsequent `runs.subscribe(runId)` streams events (each event is one
SSE `data:` line).

## JWT authentication

Every request must carry `Authorization: Bearer <jwt>` where the JWT
is HS256-signed with the gateway secret and has a `tenant` claim:

```json
{
  "tenant": "tenant-a",
  "iat": 1715472000,
  "exp": 1715558400
}
```

The gateway:

1. Verifies the signature against `CREWHAUS_GATEWAY_JWT_SECRET`.
2. Rejects expired tokens (`exp` < now).
3. Checks the `tenant` claim is in the spec's `tenants:` list.
4. Stores the tenant id in `AsyncLocalStorage` for the duration of
   the call.

JWT issuance is **out of scope** for the gateway — your auth service
issues them, the gateway only verifies. For development, a helper:

```bash
node -e 'console.log(require("jsonwebtoken").sign({ tenant: "tenant-a" }, "your-secret-here", { expiresIn: "1h" }))'
```

## Per-tenant storage rebase

Every storage operation in the call (`runChatLoop`, the JSONL writer,
the tool-result store) reads its base path from the tenant's
`AsyncLocalStorage` slot. So:

- `tenant-a`'s sessions live in `.crewhaus/<base>/tenant-a/sessions/`.
- `tenant-a`'s tool results live in `.crewhaus/<base>/tenant-a/tool-results/`.
- `tenant-a`'s audit log lives in `.crewhaus/<base>/tenant-a/audit/`.

Cross-tenant reads are **impossible** because every storage layer
resolves paths relative to the AsyncLocalStorage tenant base. There's
no code path that bypasses the rebase — the [`tenancy`](../../packages/tenancy)
module is the single source of truth.

`CREWHAUS_TENANT_BASE_DIR=/var/lib/crewhaus` overrides the default
for production deployments. Volume-mount this for persistence across
restarts.

## Hash-chained audit log

Each tenant gets one JSONL file per day under `<base>/audit/`. Every
event includes the SHA-256 of the prior event, forming an immutable
chain:

```json
{ "ts": "2026-05-11T08:00:00Z", "kind": "run_started", "runId": "run_a", "prevHash": "0000..." }
{ "ts": "2026-05-11T08:00:01Z", "kind": "tool_use", "runId": "run_a", "tool": "Bash", ..., "prevHash": "abc1..." }
{ "ts": "2026-05-11T08:00:05Z", "kind": "run_ended", "runId": "run_a", ..., "prevHash": "def4..." }
```

Verify the chain:

```bash
crewhaus audit verify <tenant-id>
```

Any tampering — editing an event, deleting a line, reordering —
breaks a hash and the verifier reports the offending line.

The audit log is the source of truth for **what the agent did**, not
what the model output. Tool calls (with arguments), permission
decisions, errors, and tenant-level events all land in audit; freeform
model text does not (that lives in the session JSONL only).

## Per-tenant budgets

The budget block has two fields:

| Field             | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `maxInputTokens`  | Sum of input tokens the tenant can use per period. |
| `maxOutputTokens` | Sum of output tokens the tenant can use per period. |

Default period is monthly rolling. Override with
`budget.period: "monthly"`, `"daily"`, or `"perRun"`.

When a `runs.create` call arrives:

1. The gateway sums the tenant's usage in the current period.
2. If usage + estimated-request-tokens > limit, reject with
   `{ "error": { "code": "BUDGET_EXCEEDED", "message": "tenant-a out of input tokens" } }`.
3. Otherwise allow; the run streams; on completion the actual tokens
   used update the tenant's counter.

Estimated request tokens come from the model adapter's pre-flight
tokenization (a fast approximate counter). If a long run blows past
the budget mid-stream, the run terminates and the model bills only
through the cutoff — the gateway does not return tokens already paid for.

## Policy engine — fail-closed for new tools

Every tool used by the agent is checked against the
[`policy-engine`](../../packages/policy-engine). Default policy:

| `sideEffect` tag       | Default action                              |
| ---------------------- | ------------------------------------------- |
| `internal`             | `allow`                                     |
| `audit-and-allow`      | `allow` + audit-log entry                   |
| `external`             | `deny` (fail-closed)                        |

The `tool-catalog` ([packages/tool-catalog](../../packages/tool-catalog))
ships every built-in tool with the appropriate tag. Adding a new tool
without a `sideEffect` tag means `external` by default — `deny`.

For per-tool overrides per tenant:

```yaml
tenants:
  - id: tenant-a
    policy:
      - tool: Bash
        action: deny       # tenant A can't run Bash even with allow rules elsewhere
      - tool: WebFetch
        action: audit-and-allow
```

The policy engine evaluates **before** the runtime's `permissions:`
block — denial at the gateway is final.

## Operating the daemon

| Operation                | How                                                                  |
| ------------------------ | -------------------------------------------------------------------- |
| **Rolling restart**       | SIGTERM + restart; in-flight runs persist via session JSONL.        |
| **Add a tenant**          | Edit spec, recompile, redeploy. New tenant lives in fresh storage.  |
| **Remove a tenant**       | Remove from spec; **manually archive their storage** (the gateway doesn't garbage-collect). |
| **Evidence export**       | `crewhaus audit export <tenant> --since <date>` produces a tarball. |
| **Rate-limit tuning**     | `gateway.rateLimits.{rps, burst}` in spec.                          |

## Things that look like managed but aren't

| Symptom                                          | Wrong shape | Right shape                                       |
| ------------------------------------------------ | ----------- | ------------------------------------------------- |
| One customer, many users.                        | managed     | [channel](03-slack-bot.md) keyed by user.         |
| Same agent across many isolated dev environments.| managed     | [batch](08-batch-worker.md) per env               |
| Different agent configs per tenant.              | managed     | Multiple `managed` daemons or [federation](27-federation.md) |

Managed is the right shape when tenants share the **same agent** but
need isolated **storage, budgets, and audit**.

## What to read next

- **Canary rollouts.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md)
  — ship a new spec to one tenant first.
- **Evidence collection.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **PII safety.** [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- **Kubernetes deployment.** [Recipe 24 — Docker and Helm](24-docker-and-helm.md).

## Pointers to source

- **Example:** [`examples/hello-managed/crewhaus.yaml`](../../examples/hello-managed/crewhaus.yaml).
- **Codegen:** [`packages/target-managed`](../../packages/target-managed).
- **Gateway protocol:** [`packages/gateway-protocol`](../../packages/gateway-protocol).
- **Gateway server:** [`packages/gateway-server`](../../packages/gateway-server).
- **Tenancy:** [`packages/tenancy`](../../packages/tenancy).
- **Audit log:** [`packages/audit-log`](../../packages/audit-log).
- **Policy engine:** [`packages/policy-engine`](../../packages/policy-engine).
- **Spec schema (managed variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `managedSchema`).
- **Module catalog reference:** §20 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
