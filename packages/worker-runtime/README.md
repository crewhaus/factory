# @crewhaus/worker-runtime

A platform-neutral agent-loop runtime — the pure loop core (turn FSM,
model-stream orchestration, tool dispatch + validation + permission gating,
tool_result feedback, budget/limit enforcement, loop detection, trace
emission) with every host capability injected via a `WorkerPlatform`.

Imports **no** `node:*` builtin and calls neither `Date.now()` nor
`Math.random()`, so it runs on Cloudflare Workers (and any other `fetch`
runtime). `@crewhaus/runtime-core` consumes it for the shared core on Node and
wraps it with the node-coupled services (event log, session store, compaction,
recovery, audit sinks); the three `target-cf-worker-*` emitters generate
bundles that call it with a stateless `WorkerPlatform`.

## v1 scope

Tools + budget + limits + trace. Compaction and recovery are deliberately
Node-only; on the edge a context overflow ends the run with a classified
`context_overflow` frame rather than compacting.

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
});
```

## cf-worker tool policy

`@crewhaus/worker-runtime/tool-policy` is the single source of truth for which
builtin tools are edge-safe; the compiler imports it to gate cf-worker
emission (host tools such as `bash`/`read`/`python` fail the compile; edge-safe
tools such as `fetch`/`webSearch`/`mcp__*` compile and run).

## License

Apache-2.0
