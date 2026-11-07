import type { Spec } from "@crewhaus/spec";

/**
 * One minimal spec per target shape, declaring none of the keys added since
 * 0.9.0 (#514). `__fixtures__/delta-090/absent-corpus.digests.json` pins what
 * each one compiles to, so a new key that moves a byte for a spec that does not
 * use it fails a test. `sentinel.ts` scans the same specs through every exit.
 *
 * These live outside `__fixtures__/` because the published sentinel re-exports
 * them. Every spec passes `compile({ strict: true })`, as the compiler worker
 * runs it. The cli, workflow and graph specs also build with `emitAs:
 * "cf-worker"`, so they carry no host tool and no human-in-the-loop gate.
 */
export const ABSENT_CORPUS: Record<Spec["target"], string> = {
  cli: `name: support-cli
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help users.
`,
  workflow: `name: pipeline-wf
target: workflow
model: claude-opus-4-7
steps:
  - name: draft
    instructions: Write the report.
`,
  channel: `name: helper-bot
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
`,
  graph: `name: triage-graph
target: graph
model: claude-opus-4-7
entry: classify
nodes:
  classify:
    instructions: Classify the ticket.
edges: []
`,
  managed: `name: fleet
target: managed
agent:
  model: claude-opus-4-7
  instructions: Serve tenants.
tenants:
  - {id: acme, budget: {maxInputTokens: 100000, maxOutputTokens: 20000}}
`,
  pipeline: `name: docs-rag
target: pipeline
agent: {model: claude-opus-4-7, instructions: Answer from docs.}
retrieve: {embedderModel: text-embedding-3-small, defaultK: 3}
indexing:
  documents:
    - {id: handbook, text: hello}
`,
  crew: `name: newsroom
target: crew
model: claude-opus-4-7
entry: editor
roles:
  editor:
    instructions: Assign and review.
routing:
  kind: match
  match: {}
`,
  research: `name: deep-dive
target: research
agent: {model: claude-opus-4-7, instructions: Research.}
goal: Map the field
branchingFactor: 2
`,
  batch: `name: ticket-worker
target: batch
agent: {model: claude-opus-4-7, instructions: Process jobs.}
queue: {adapter: in-memory}
concurrency: 2
`,
  voice: `name: phone
target: voice
agent: {model: claude-opus-4-7, instructions: Talk.}
voice: {provider: openai}
`,
  browser: `name: surfer
target: browser
agent: {model: claude-opus-4-7, instructions: Browse.}
limits: {turn_timeout_ms: 30000}
`,
  eval: `name: bench
target: eval
agent: {model: claude-opus-4-7, instructions: Solve.}
dataset: {name: d, version: '1'}
graders:
  - {name: exact}
`,
  onchain: `name: watcher
target: onchain
agent: {model: claude-opus-4-7, instructions: Watch.}
chains:
  - {id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: {kind: finalized}}
triggers:
  - {kind: block, chainId: base, scanIntervalMs: 5000}
`,
  "onchain-game": `name: player
target: onchain-game
agent: {model: claude-opus-4-7, instructions: Play.}
chain: {id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: {kind: finalized}}
wallet: {id: w1, chainId: base, custody: local, keyRef: $WALLET_KEY}
game:
  contract: {id: game, chainId: base, address: '0x1', abiRef: 'abi://erc20'}
  stateReader: getState
`,
};
