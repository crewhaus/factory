# @crewhaus/tool-consult

The two **model-directed** hybrid tools of the 0.6.0 model-plan release
(design §7.2.4, §7.5; module brief 309). `@crewhaus/model-service`'s
`wireModels` registers them only when a pool declares
`model_pool.strategy.model_directed: true`; a `models:` profile can subset
them like any other tool (the usual shape: the cheap arm has `Escalate`, the
strong arm does not).

```yaml
agent:
  model: $fast
  model_pool:
    candidates:
      - { model: $fast,   tags: [cheap] }
      - { model: $strong, tags: [strong] }
    strategy: { model_directed: true, max_escalations: 1 }
```

## `Consult({ question, context?, to? })`

The serving model asks a **roster sibling** one question and gets one answer
back as a tool result. The composition root builds the tool over a runner
that performs a nested single-turn
`runChatLoop({ singleTurn: true, tools: [], sessionTarget: "consult", modelRole: "consult" })`
— through `runChatLoop`, never `adapter.stream`, so `model_request` /
`model_response`, `cost_accrual` and budget metering hold. The consulted
model has no tools and sees only the question and the context passed.

- **Posture** — the `Task` precedent: `readOnly: true`, `concurrencySafe: true`,
  `scope: "internal"`, no `ioCapability` (the socket is opened by the adapter
  layer inside the runtime's own metered loop). It never joins
  `BUILTIN_BOOKKEEPING_RULES`: it asks in default mode, is auto-allowed in
  auto mode and allowed in plan mode as a side-effect-free tool. A spec
  `yaml` permission rule auto-allows it headless.
- **Classified once, here** (Pillar 3). The reply re-enters the parent's
  context through `classifyBoundary(reply, { origin: "consult" })` — the new
  `TrustOrigin "consult"`, block-on-malicious like `skill` / `memory` —
  followed by `tagContent(ctx, reply, "consult")` for the egress fabric. The
  tool sets `classifyOutput: false` so the runtime does not re-classify the
  same text at origin `"tool"`.
- **Allowlist** — `to` is model-filled and resolves only against the roster:
  a profile name (`fast` / `$fast`), a tag (`strong`), or the declared model
  string. Anything else is refused as an `is_error` result; nothing
  model-filled can name a model outside the spec, and no adapter is resolved
  from model text at runtime. The default target is the strongest candidate
  (first `strong`-tagged, else the last declared).
- **Failure** — a runner failure or timeout is an `is_error` result; the
  parent turn continues (§7.13).
- **Tracking** — `model_stage { stage: "consult", strategy: "model_directed",
  role: "consult", outcome: started | done | failed }` on the parent bus; the
  nested call's own `model_request` / `model_response` carry `role: "consult"`.

## `Escalate({ reason })`

The serving model admits the turn is beyond it. The tool records
`model_stage { stage: "escalate", role: "escalation", cause: "self" }`,
captures a receipt on the **escalation latch** and returns it as JSON
(`{ escalated, receipt, to, profile?, reason, message }`). The loop consumes
the latch at its next model call, snapshotting `messages.length` onto the
receipt: in this release the rest of the turn is served by the escalation
target (`strategy.cascade.escalate_to`, else the strongest candidate); the
clean-prompt re-run through `runOneTurn(messages, { force })` lands with the
cascade (PR 9c) on the same seam. `strategy.max_escalations` (default 1)
bounds it — past the cap the call records `outcome: "skipped", cause:
"max_escalations"` and returns `{ escalated: false }`, which is not a failure.

## API

```ts
import {
  createConsultTool, createEscalateTool, createEscalationLatch,
  rosterFromPool, resolveRosterTarget, strongestOf,
  type ConsultRunner, type EscalationLatch,
} from "@crewhaus/tool-consult";

const roster = rosterFromPool(pool);            // enabled candidates only
const consult = createConsultTool({ roster, run /* ConsultRunner */ });
const latch = createEscalationLatch({ target: strongestOf(roster), maxEscalations: 1 });
const escalate = createEscalateTool({ latch });
```

The package is pure over the injected `ConsultRunner` — it depends on the
tool contract, the boundary classifier, the run context and the trace bus,
never on the runtime — so both tools are unit-testable with a scripted
runner. See module brief 309 in
[crewhaus/docs](https://github.com/crewhaus/docs).
