/**
 * Loop contract 0.4 (Batch B, G42) — one spec per IR variant, driving the
 * projection goldens in loop-projection.test.ts. Kept beside the golden
 * JSON (and outside the test module) so the regeneration script can import
 * it without booting the test runner.
 */
export const LOOP_PROJECTION_SPECS: Record<string, string> = {
  cli: `
name: support-cli
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help users.
  thinking:
    effort: high
tools:
  - webFetch
  - read
evaluation:
  grader:
    type: llm_judge
    criteria: reply cites a source
  threshold: 0.8
  on_fail: retry
  max_retries: 2
budget:
  usd: 2.5
limits:
  max_tool_iterations: 40
  deadline_ms: 600000
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: read
continuity: false
`,
  workflow: `
name: pipeline-wf
target: workflow
model: claude-opus-4-7
steps:
  - name: draft
    instructions: Write the report.
    tools: [webSearch]
  - name: gate
    kind: judge
    judge:
      criteria: cites at least two sources
      threshold: 0.9
      on_fail: retry_previous
      max_retries: 2
  - name: publish
    instructions: Format and publish.
`,
  graph: `
name: triage-graph
target: graph
model: claude-opus-4-7
entry: classify
nodes:
  classify:
    instructions: Classify the ticket.
  billing:
    instructions: Handle billing.
  tech:
    instructions: Handle technical.
  gate:
    kind: judge
    judge:
      criteria: the reply resolves the ticket
      on_fail: halt
  review:
    instructions: Human-style review.
    hitl:
      prompt: Approve the reply?
edges:
  - {from: classify, to: billing, when: {key: classify, equals: billing}}
  - {from: classify, to: tech}
  - {from: billing, to: gate}
  - {from: tech, to: gate}
  - {from: gate, to: review}
parallel:
  - [billing, tech]
`,
  crew: `
name: newsroom
target: crew
model: claude-opus-4-7
entry: editor
roles:
  editor:
    instructions: Assign and review.
  writer:
    instructions: Write articles.
    tools: [webSearch]
routing:
  kind: match
  match:
    editor:
      - {contains: "DRAFT", to: writer}
    writer:
      - {contains: "READY", to: editor}
`,
  channel: `
name: helper-bot
target: channel
agent:
  model: claude-opus-4-7
  instructions: Answer questions.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
heartbeat:
  every: 2h
  instructions: Check the queue.
evaluation:
  grader: {type: contains, value: "thanks"}
  on_fail: note
continuity: false
`,
  managed: `
name: fleet
target: managed
agent:
  model: claude-opus-4-7
  instructions: Serve tenants.
tenants:
  - {id: acme, budget: {maxInputTokens: 100000, maxOutputTokens: 20000}}
continuity: false
`,
  pipeline: `
name: docs-rag
target: pipeline
agent: {model: claude-opus-4-7, instructions: Answer from docs.}
retrieve: {embedderModel: text-embedding-3-small, defaultK: 3}
indexing:
  documents:
    - {id: handbook, text: hello}
`,
  research: `
name: deep-dive
target: research
agent: {model: claude-opus-4-7, instructions: Research.}
goal: Map the field
branchingFactor: 2
tools: [webFetch]
`,
  batch: `
name: ticket-worker
target: batch
agent: {model: claude-opus-4-7, instructions: Process jobs.}
queue: {adapter: in-memory}
concurrency: 2
`,
  voice: `
name: phone
target: voice
agent: {model: claude-opus-4-7, instructions: Talk.}
voice: {provider: openai}
`,
  browser: `
name: surfer
target: browser
agent: {model: claude-opus-4-7, instructions: Browse.}
limits: {turn_timeout_ms: 30000}
`,
  eval: `
name: bench
target: eval
agent: {model: claude-opus-4-7, instructions: Solve.}
dataset: {name: d, version: '1'}
graders:
  - {name: exact}
`,
  onchain: `
name: watcher
target: onchain
agent: {model: claude-opus-4-7, instructions: Watch.}
chains:
  - {id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: {kind: finalized}}
triggers:
  - {kind: block, chainId: base, scanIntervalMs: 5000}
`,
  "onchain-game": `
name: player
target: onchain-game
agent: {model: claude-opus-4-7, instructions: Play.}
chain: {id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: {kind: finalized}}
wallet: {id: w1, chainId: base, custody: local, keyRef: $WALLET_KEY}
game:
  contract: {id: game, chainId: base, address: '0x1', abiRef: 'abi://erc20'}
  stateReader: getState
`,
};
