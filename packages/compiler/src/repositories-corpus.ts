/**
 * The specs that pin what a declared `repositories:` compiles to (#514, #516): one per shape
 * that delivers work, each with the workspace tools, the token variable's name, two bindings
 * declared out of name order (one with every key, one with none but its own) and an
 * `intent:`. `__fixtures__/delta-090/repositories.present.digests.json` pins the output, and
 * `repositories-lowering.test.ts` guards the key order of what is emitted.
 */

/** The marker a test looks for wherever the intent must not be. */
export const INTENT_MARKER = "Keep the budgeting app reliable and fast";

const BLOCK = `repositories:
  zeta:
    host: github
    repo: acme/zeta
  app:
    allow_private_target: true
    server: {git: "http://127.0.0.1:8099", api: "http://127.0.0.1:8098"}
    pull_requests: {require: [acceptance, checks], revalidate: refresh, max_lines: 400, max_files: 10, draft: false}
    check_image: oven/bun:1
    check_timeout: 5m
    checks: [[bun, install, --frozen-lockfile], [bun, test]]
    branch_prefix: steward/
    base: trunk
    repo: acme/budget-app
    host: github
intent:
  excludes: [UI redesigns]
  purpose: ${INTENT_MARKER}.
`;

const TOOLS = "[workspaceOpen, workspaceCheck, workspacePublish]";
const CONFIG = "{codehost: {token_env: GITHUB_TOKEN}}";

export const REPOSITORIES_CORPUS: Readonly<Record<string, string>> = Object.freeze({
  "cli-repositories": `name: support-cli
target: cli
agent:
  model: claude-opus-4-7
  instructions: Help users.
tools: ${TOOLS}
tool_config: ${CONFIG}
${BLOCK}`,
  "workflow-repositories": `name: pipeline-wf
target: workflow
model: claude-opus-4-7
steps:
  - name: draft
    instructions: Write the change.
    tools: ${TOOLS}
    tool_config: ${CONFIG}
${BLOCK}`,
  "channel-repositories": `name: helper-bot
target: channel
agent:
  model: claude-opus-4-7
  instructions: Answer questions.
  tools: ${TOOLS}
  tool_config: ${CONFIG}
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
${BLOCK}`,
  "managed-repositories": `name: fleet
target: managed
agent:
  model: claude-opus-4-7
  instructions: Serve tenants.
  tools: ${TOOLS}
  tool_config: ${CONFIG}
tenants:
  - {id: acme, budget: {maxInputTokens: 100000, maxOutputTokens: 20000}}
${BLOCK}`,
  "batch-repositories": `name: ticket-worker
target: batch
agent: {model: claude-opus-4-7, instructions: Process jobs.}
tools: ${TOOLS}
tool_config: ${CONFIG}
queue: {adapter: in-memory}
concurrency: 2
${BLOCK}`,
});
