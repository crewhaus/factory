/**
 * Per-shape structural assertions for the smoke matrix.
 *
 * Each entry pins the load-bearing behaviour of one target emitter:
 *   - `expectedFiles`: the sorted file set the bundle must produce.
 *   - `anchors`: substrings that must appear in the named file (use
 *     "any" to assert across the union of every file's content).
 *
 * Anchors are deliberately specific enough to catch the kind of drift
 * we hit in PR #107 (emitter silently dropped a tool import) and the
 * Navigate-tool gap that started this PR series (browser bundle
 * launched chromium but had no way to navigate). They are not a
 * replacement for the per-emitter unit tests — those still cover the
 * shape-internal logic. The smoke matrix gives us a fast, single-pass
 * "does every shape still compile and wire its baseline imports?"
 * gate in CI.
 *
 * Adding a new target shape: extend `SHAPE_ASSERTIONS` with an entry
 * and drop a matching `fixtures/<shape>.yaml`. The harness picks it
 * up automatically.
 */

export type Anchor = {
  /** "any" means: the substring must appear in at least one file. */
  readonly in: "any" | string;
  readonly contains: string;
};

export type ShapeAssertion = {
  readonly shape: string;
  readonly expectedFiles: readonly string[];
  readonly anchors: readonly Anchor[];
};

export const SHAPE_ASSERTIONS: readonly ShapeAssertion[] = [
  {
    shape: "cli",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/runtime-core" },
      { in: "agent.ts", contains: "runChatLoop" },
      { in: "agent.ts", contains: "@crewhaus/tool-catalog" },
      // Section 11 extension surface (hooks/skills/slash-commands) — load-bearing.
      { in: "agent.ts", contains: "@crewhaus/hooks-engine" },
      { in: "agent.ts", contains: "@crewhaus/skills-registry" },
      { in: "agent.ts", contains: "@crewhaus/slash-commands" },
    ],
  },
  // Cross-provider compile-path fixtures (no keys needed): the SAME cli
  // emitter must compile cleanly for every model-router provider prefix and
  // bake the full router string into the bundle verbatim — runtime-core's
  // resolveModel strips it at run time. These pin the provider-agnostic
  // consumer surface (Section 17) against emitter drift.
  {
    shape: "cli-openai",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "openai/gpt-4o-mini" },
      { in: "agent.ts", contains: "runChatLoop" },
    ],
  },
  {
    shape: "cli-gemini",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "gemini/gemini-2.5-flash" },
      { in: "agent.ts", contains: "runChatLoop" },
    ],
  },
  {
    shape: "cli-bedrock",
    expectedFiles: ["agent.ts"],
    anchors: [
      // Geo-prefixed cross-region inference-profile id, verbatim.
      { in: "agent.ts", contains: "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
      { in: "agent.ts", contains: "runChatLoop" },
    ],
  },
  {
    shape: "cli-local",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "local/llama3.2@http://localhost:11434/v1" },
      { in: "agent.ts", contains: "runChatLoop" },
    ],
  },
  {
    shape: "browser",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/computer-use-driver" },
      // The exact gap that started this PR series — guard it forever.
      { in: "agent.ts", contains: "@crewhaus/tool-navigate" },
      { in: "agent.ts", contains: "createNavigateTool" },
      { in: "agent.ts", contains: "@crewhaus/tool-screen-capture" },
      { in: "agent.ts", contains: "createScreenshotTool" },
      { in: "agent.ts", contains: "@crewhaus/tool-mouse-keyboard" },
      { in: "agent.ts", contains: "@crewhaus/tool-vision-grounding" },
      // Event-stream contract surfaced by runRunBrowser + the bundle.
      { in: "agent.ts", contains: '"browser_start"' },
      { in: "agent.ts", contains: '"browser_done"' },
      // Navigate must sit ahead of Screenshot in the tools array so
      // the agent's first reasonable action is a navigation.
      { in: "agent.ts", contains: "[navigateTool, screenshotTool" },
    ],
  },
  {
    shape: "voice",
    expectedFiles: ["agent.ts", "daemon.ts", "voice-loop.ts"],
    anchors: [
      { in: "voice-loop.ts", contains: "@crewhaus/voice-runtime" },
      { in: "voice-loop.ts", contains: "@crewhaus/vad-engine" },
      { in: "voice-loop.ts", contains: "@crewhaus/barge-in-controller" },
    ],
  },
  {
    shape: "channel",
    expectedFiles: ["agent.ts", "daemon.ts", "gateway.ts", "session-router.ts"],
    anchors: [
      { in: "daemon.ts", contains: "@crewhaus/channel-adapter-slack" },
      { in: "daemon.ts", contains: "createSlackAdapter" },
      { in: "daemon.ts", contains: "@crewhaus/tool-message-channel" },
      // Env-ref secret rewriting: the spec uses $SMOKE_SLACK_BOT_TOKEN,
      // the bundle must reach for the env var by exact name.
      { in: "daemon.ts", contains: "SMOKE_SLACK_BOT_TOKEN" },
      { in: "daemon.ts", contains: "SMOKE_SLACK_SIGNING_SECRET" },
      // Ops item 36 — boot-time self-heal janitor wired into the daemon.
      { in: "daemon.ts", contains: "createJanitor" },
    ],
  },
  {
    shape: "batch",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/queue-protocol" },
      { in: "agent.ts", contains: "@crewhaus/queue-consumer" },
      { in: "agent.ts", contains: "@crewhaus/idempotency-keys" },
      { in: "agent.ts", contains: '"worker_start"' },
      { in: "agent.ts", contains: '"job_start"' },
      // Ops item 36 — boot-time self-heal janitor wired into the worker.
      { in: "agent.ts", contains: "createJanitor" },
    ],
  },
  {
    shape: "crew",
    expectedFiles: ["agent_researcher.ts", "agent_writer.ts", "daemon.ts", "orchestrator.ts"],
    anchors: [
      { in: "orchestrator.ts", contains: "@crewhaus/crew-orchestrator" },
      { in: "agent_researcher.ts", contains: "RoleDefinition" },
      { in: "agent_writer.ts", contains: "RoleDefinition" },
    ],
  },
  {
    shape: "eval",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/dataset-registry" },
      { in: "agent.ts", contains: "@crewhaus/eval-grader" },
      { in: "agent.ts", contains: "@crewhaus/eval-runner" },
    ],
  },
  {
    shape: "graph",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/graph-engine" },
      { in: "agent.ts", contains: "@crewhaus/checkpoint-store" },
      { in: "agent.ts", contains: "createGraph" },
    ],
  },
  {
    shape: "managed",
    expectedFiles: ["agent.ts", "daemon.ts"],
    anchors: [
      { in: "daemon.ts", contains: "@crewhaus/gateway-server" },
      { in: "daemon.ts", contains: "@crewhaus/policy-engine" },
      { in: "daemon.ts", contains: "@crewhaus/tenancy" },
      // Ops item 36 — boot-time self-heal janitor + pluggable budget store.
      { in: "daemon.ts", contains: "createJanitor" },
      { in: "daemon.ts", contains: "createBudgetStore" },
    ],
  },
  {
    shape: "onchain",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/chain-adapter-evm" },
      // §47 boundary-fabric requirement — every onchain trigger must
      // classify through the egress fabric before the agent sees it.
      { in: "agent.ts", contains: "@crewhaus/boundary-classifier" },
      // The trigger config from the spec must round-trip into the bundle.
      { in: "agent.ts", contains: '"event"' },
      { in: "agent.ts", contains: "base-mainnet" },
    ],
  },
  {
    shape: "onchain-game",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/chain-adapter-evm" },
      { in: "agent.ts", contains: "@crewhaus/boundary-classifier" },
      { in: "agent.ts", contains: "base-sepolia" },
    ],
  },
  {
    shape: "pipeline",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/pipeline-engine" },
      { in: "agent.ts", contains: "@crewhaus/embedder" },
      { in: "agent.ts", contains: "@crewhaus/vector-store" },
      { in: "agent.ts", contains: "@crewhaus/tool-retrieve" },
    ],
  },
  {
    shape: "research",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/planner" },
      { in: "agent.ts", contains: "@crewhaus/crawler" },
      { in: "agent.ts", contains: "@crewhaus/citation-tracker" },
      { in: "agent.ts", contains: "@crewhaus/report-writer" },
      { in: "agent.ts", contains: '"branch_start"' },
    ],
  },
  {
    shape: "workflow",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "@crewhaus/runtime-core" },
      { in: "agent.ts", contains: "runChatLoop" },
      // Workflow is sequential; each step name from the fixture must
      // surface in the bundle's step banner so the orchestration
      // scaffold is wired in spec order.
      { in: "agent.ts", contains: "[step 1/2: list]" },
      { in: "agent.ts", contains: "[step 2/2: summarise]" },
    ],
  },
];
