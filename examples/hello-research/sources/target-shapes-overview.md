# CrewHaus Factory — Target Shapes (Overview)

CrewHaus Factory compiles a single high-level harness spec into one of
several runtime target shapes. The shapes are:

- **CLI** (cli) — single-agent REPL coding agent. Tool catalog, hooks,
  skills, slash commands, MCP servers. The default shape.
- **WORKFLOW** (workflow) — sequential steps run in order. Each step is
  one user→assistant turn; the prior step's terminal text threads into
  the next step's input.
- **CHANNEL** (channel) — long-running daemon that listens for inbound
  channel events (Slack today). One agent turn per inbound message,
  routed by thread / user / channel.
- **GRAPH** (graph) — stateful node/edge runtime. Nodes are LLM-backed
  invocations; edges link nodes; HITL pauses interrupt with
  `requestApproval()`. Resumable from checkpoints.
- **MANAGED** (managed) — multi-tenant gateway daemon with HS256 JWT
  auth, per-tenant budgets, hash-chained audit trail.
- **PIPELINE** (pipeline) — RAG-shaped component DAG runtime. Indexing
  pipeline (chunk → embed → store) at boot; agent uses the `Retrieve`
  tool.
- **CREW** (crew) — multi-agent crew with explicit Handoff baton-passes
  and in-crew A2A SendMessage. All roles share one trace id; refusal-loop
  guard at depth 2.
