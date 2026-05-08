/**
 * Catalog F4 `scaffold-templates` — Section 26 Studio.
 *
 * Built-in spec templates, one per target shape. Studio uses these as
 * the seed for the "new spec" wizard; the CLI's `crewhaus init` reads
 * the same map. Returning the YAML as a string (not a parsed object)
 * lets us keep the comments + formatting Authors will read after
 * scaffolding.
 */

export type TemplateId =
  | "cli-coding-agent"
  | "slack-bot"
  | "research-agent"
  | "rag-bot"
  | "crew-research"
  | "graph-stateful"
  | "managed-multitenant"
  | "batch-worker"
  | "voice-realtime"
  | "browser-driver";

export type Template = {
  readonly id: TemplateId;
  readonly target: string;
  readonly title: string;
  readonly description: string;
  readonly yaml: string;
};

export const TEMPLATES: ReadonlyArray<Template> = [
  {
    id: "cli-coding-agent",
    target: "cli",
    title: "CLI coding agent",
    description: "REPL coding agent with file + bash + grep tools.",
    yaml: `name: my-cli-agent
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a coding assistant. Use Read/Write/Edit/Bash to modify the
    user's project.
tools:
  - read
  - write
  - edit
  - glob
  - grep
  - bash
permissions:
  mode: default
`,
  },
  {
    id: "slack-bot",
    target: "channel",
    title: "Slack bot",
    description: "Long-running daemon that responds to Slack mentions.",
    yaml: `name: my-slack-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a helpful Slack bot. Answer questions in 1-3 sentences.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
permissions:
  mode: default
`,
  },
  {
    id: "research-agent",
    target: "research",
    title: "Autonomous research agent",
    description:
      "Decompose a research goal into sub-questions and synthesize a report with citations.",
    yaml: `name: my-research-agent
target: research
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a research agent. Use Source(uri) to load sources and
    CiteFact(uri, snippet) to record facts. End each branch with a
    3-5 sentence answer.
goal: "What are the trade-offs between approaches X and Y?"
branchingFactor: 3
maxDurationMs: 300000
retrieve:
  allowedFileRoots:
    - ./sources
permissions:
  mode: default
`,
  },
  {
    id: "rag-bot",
    target: "pipeline",
    title: "RAG-grounded chatbot",
    description: "Indexes seed documents at boot; answers questions via the Retrieve tool.",
    yaml: `name: my-rag-bot
target: pipeline
agent:
  model: claude-sonnet-4-6
  instructions: |
    Use Retrieve to fetch relevant context, then answer in 2-3 sentences
    citing the chunks by [N] reference number.
retrieve:
  embedderModel: mock/det
  vectorBackend: in-memory
  defaultK: 4
indexing:
  chunkStrategy: fixed
  chunkSize: 400
  chunkOverlap: 0
  documents:
    - id: doc-1
      text: |
        Replace this with your own seed documents.
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Retrieve
`,
  },
  {
    id: "crew-research",
    target: "crew",
    title: "Multi-agent research crew",
    description: "Researcher → writer → critic with handoff + A2A.",
    yaml: `name: my-crew
target: crew
model: claude-sonnet-4-6
entry: researcher
permissions:
  mode: default
roles:
  researcher:
    instructions: |
      Research the topic, list 3 facts, then Handoff to writer.
  writer:
    instructions: |
      Compose a short post from the researcher's facts. Optionally
      SendMessage to critic for clarification.
  critic:
    instructions: |
      Answer the writer's questions in one sentence.
`,
  },
  {
    id: "graph-stateful",
    target: "graph",
    title: "Stateful graph runtime",
    description: "Plan → execute → summarise with optional HITL pause.",
    yaml: `name: my-graph
target: graph
model: claude-sonnet-4-6
entry: plan
nodes:
  plan:
    instructions: Decompose the task.
  execute:
    instructions: Carry out the plan.
    hitl:
      prompt: Approve before execution?
  summarise:
    instructions: Summarise outcomes.
edges:
  - { from: plan, to: execute }
  - { from: execute, to: summarise }
permissions:
  mode: default
`,
  },
  {
    id: "managed-multitenant",
    target: "managed",
    title: "Multi-tenant managed daemon",
    description: "JWT-authenticated gateway with per-tenant budgets.",
    yaml: `name: my-managed
target: managed
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a multi-tenant assistant. Stick to the topic the tenant asks.
tenants:
  - id: tenant-a
    budget:
      maxInputTokens: 100000
      maxOutputTokens: 50000
permissions:
  mode: default
`,
  },
  {
    id: "batch-worker",
    target: "batch",
    title: "Queue worker",
    description: "Pulls jobs from an in-memory queue, runs the agent per job.",
    yaml: `name: my-batch-worker
target: batch
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    Process the input and return a one-sentence summary.
queue:
  adapter: in-memory
  visibilityTimeoutMs: 30000
  maxRetries: 3
  seedJobs:
    - "Process this job."
concurrency: 4
idempotencyWindowMs: 60000
permissions:
  mode: default
`,
  },
  {
    id: "voice-realtime",
    target: "voice",
    title: "Realtime voice agent",
    description: "OpenAI Realtime daemon with VAD-backed barge-in.",
    yaml: `name: my-voice-agent
target: voice
agent:
  model: gpt-4o-realtime-preview
  instructions: |
    You are a brief voice assistant. Reply in one short sentence.
voice:
  provider: openai
  voiceId: alloy
  vad: server
  bargeInTriggerFrames: 4
  bargeInWindowMs: 200
permissions:
  mode: default
`,
  },
  {
    id: "browser-driver",
    target: "browser",
    title: "Computer-use browser agent",
    description: "Drives chromium with Screenshot + FindElement + Click.",
    yaml: `name: my-browser-agent
target: browser
agent:
  model: claude-sonnet-4-6
  instructions: |
    You drive a chromium browser. Use Screenshot + FindElement + Click
    + Type + Key + Scroll to complete the user's task.
driver:
  backend: chromium
  viewport:
    width: 1280
    height: 720
groundingModel: claude-sonnet-4-6
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Screenshot
    - type: alwaysAllow
      pattern: FindElement
    - type: alwaysAllow
      pattern: Click
    - type: alwaysAllow
      pattern: Type
    - type: alwaysAllow
      pattern: Key
    - type: alwaysAllow
      pattern: Scroll
`,
  },
];

export function getTemplate(id: TemplateId): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function listTemplates(): ReadonlyArray<
  Pick<Template, "id" | "target" | "title" | "description">
> {
  return TEMPLATES.map(({ id, target, title, description }) => ({
    id,
    target,
    title,
    description,
  }));
}
