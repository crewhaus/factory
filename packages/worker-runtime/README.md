# @crewhaus/worker-runtime

A platform-neutral agent-loop runtime — the pure loop core (turn FSM,
model-stream orchestration, tool dispatch and validation, a permission decision
before every tool call, tool_result feedback, limit enforcement, loop
detection, trace emission) with every host capability injected via a
`WorkerPlatform`.

Imports **no** `node:*` builtin and calls neither `Date.now()` nor
`Math.random()`, so it runs on Cloudflare Workers (and any other `fetch`
runtime). `@crewhaus/runtime-core` consumes it for the shared core on Node and
wraps it with the node-coupled services (event log, session store, compaction,
recovery, audit sinks); the three `target-cf-worker-*` emitters generate
bundles that call it with a stateless `WorkerPlatform`.

## v1 scope

Tools, permission rules, limits and trace. The loop keeps no spend meter and
runs no hooks. Compaction and recovery are deliberately Node-only; on the edge
a context overflow ends the run with a classified `context_overflow` frame
rather than compacting. `limits.deadlineMs` is checked before each model call,
so a call already in flight finishes.

Every message the loop is handed, whatever its role, is screened at TrustOrigin
`channel` before the first model call; a message the prompt-injection check
refuses ends the run with an `input_blocked` failure and no model call. What a
tool returns is classified at TrustOrigin `tool` before the next model call; a
malicious output reaches the model as a redaction notice.

```ts
import { runWorkerLoop } from "@crewhaus/worker-runtime";

const result = await runWorkerLoop({
  platform: {
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    fetch: fetch.bind(globalThis),
  },
  model: "claude-sonnet-5",
  instructions: "You are a helpful assistant.",
  messages: [{ role: "user", content: "hello" }],
  apiKey: env.ANTHROPIC_API_KEY,
  tools: edgeSafeTools,
  permissions: { rules: [{ type: "alwaysAllow", pattern: "WebFetch" }] },
});
```

## Permission rules

Given `permissions` (the spec's `permissions.mode` and `permissions.rules`),
the loop decides every tool call before it runs, with `decideWorkerToolCall`.
A worker has nobody to give an approval, so a tool runs only when an
`alwaysAllow` rule covers the call:

- a matching `alwaysDeny` or `alwaysAsk` rule wins over any `alwaysAllow`,
  wherever each is listed;
- `mode: auto` reads as `default`, and `mode: plan` runs only read-only tools;
- a tool that needs a sandbox or the intent gate is refused;
- any other call gets an error tool result saying it needs approval, and the
  tool does not run.

Rules are matched as `@crewhaus/permission-engine` matches them (an allow needs
every operative value of the call to match its argument glob, a deny or ask
any one, against the input the tool's schema parsed). Each decision is one
`permission_decision` trace frame. A refusal names the tool and the rule type,
never the rule's pattern. Without `permissions`, every advertised tool is
permitted; the cf-worker emitters always pass it.

`@crewhaus/worker-runtime/permissions` is the decision alone, without the
loop: the compiler imports it to say, at compile time, which wired tool a
worker refuses on every call.

## `/chat` bearer check

`chatAuthRefusal(authorization, chatToken)` is the check the cf-worker
emitters put in front of `POST /chat`, before the body is read. It answers
`undefined` when the request's `Authorization: Bearer <token>` header matches
the worker's `CHAT_TOKEN` secret, compared in constant time (SHA-256 digests
over WebCrypto). A missing or wrong token gets 401 `UNAUTHORIZED`; while
`CHAT_TOKEN` is unset or empty, every request gets 503 `NO_CHAT_TOKEN`.

## cf-worker tool policy

`@crewhaus/worker-runtime/tool-policy` is the single source of truth for which
builtin tools are edge-safe; the compiler imports it to gate cf-worker
emission. A host tool such as `bash`, `read` or `python` fails the compile. An
edge-safe builtin such as `fetch` or `webSearch` compiles, and a worker runs it
only when an `alwaysAllow` rule covers the call. `mcp__*` and custom names
compile and are not wired on a worker.

## License

Apache-2.0
