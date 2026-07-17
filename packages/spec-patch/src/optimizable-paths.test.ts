/**
 * Loop contract 0.4 (Batch A) — the OPTIMIZABLE_PATHS ⊆ spec-schema CI
 * guard. Every path the optimizer is allowed to touch must be DECLARABLE:
 * for each target, a fixture spec carries a value at every listed path and
 * must (a) round-trip through `parseSpec` (the strict schemas reject
 * phantom keys) and (b) textually carry the path per `specHasPath` (so
 * `replace` patches can target it).
 *
 * This is what forced the removal of the phantom entries
 * `["security","egressPolicy"]` (cli) and `["retrieve","maxDepth"]`
 * (research): neither key exists in the spec schema, so no fixture can
 * declare them. A future entry that doesn't parse fails HERE, not in a
 * user's optimize run.
 */
import { describe, expect, test } from "bun:test";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { OPTIMIZABLE_PATHS, specHasPath } from "./index";

const CHAIN_BLOCKS = `
chains:
  - id: mainnet
    kind: evm
    rpcUrls:
      - $RPC_URL
    finality:
      kind: finalized
contracts:
  - id: token
    chainId: mainnet
    address: "0x0000000000000000000000000000000000000001"
    abiRef: abi://erc20
transaction_policy:
  maxValueWei: "1000"
  allowedContracts:
    - token
`.trim();

const MODEL_POOL = `
  model_pool:
    candidates:
      - model: claude-haiku-4-5
        tags: [cheap]
      - model: claude-opus-4-8
        tags: [strong]
    policy: heuristic
    routing:
      strongTag: strong
    learning:
      minSamplesPerArm: 2
`.trimEnd();

const MEMORY_CONTINUITY = `
memory:
  recallK: 5
  autoCaptureThreshold: 2
  ttl: 90d
  wiki:
    recallK: 5
  dream:
    every: 24h
    budget_usd: 0.5
continuity:
  focusMaxChars: 4096
`.trim();

const FAILURE_TAXONOMY = `
failure_taxonomy:
  - class: rate-limit
    pattern: "429"
    recovery: retry
`.trim();

const LIMITS = `
limits:
  max_tool_iterations: 25
`.trim();

/** One fixture per target, declaring a value at EVERY optimizable path. */
const FIXTURES: Readonly<Record<Spec["target"], string>> = {
  cli: [
    "name: fx",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: be helpful",
    "  max_tokens: 9000",
    "  thinking:",
    "    budget_tokens: 4096",
    MODEL_POOL,
    FAILURE_TAXONOMY,
    "compaction:",
    "  threshold: 0.85",
    "  curate: true",
    "  dedupeThreshold: 0.92",
    "  relevanceTopK: 20",
    "security:",
    "  justification:",
    "    judge: rule-based",
    LIMITS,
    CHAIN_BLOCKS,
    MEMORY_CONTINUITY,
  ].join("\n"),
  workflow: [
    "name: fx",
    "target: workflow",
    "model: m",
    "steps:",
    "  - name: one",
    "    instructions: do it",
    FAILURE_TAXONOMY,
    LIMITS,
    CHAIN_BLOCKS,
  ].join("\n"),
  channel: [
    "name: fx",
    "target: channel",
    "agent:",
    "  model: m",
    "  instructions: i",
    "  thinking:",
    "    budget_tokens: 4096",
    MODEL_POOL,
    "channels:",
    "  slack:",
    "    botToken: $SLACK_BOT_TOKEN",
    "    signingSecret: $SLACK_SIGNING_SECRET",
    "routing:",
    "  sessionKey: thread",
    FAILURE_TAXONOMY,
    LIMITS,
    CHAIN_BLOCKS,
    MEMORY_CONTINUITY,
  ].join("\n"),
  graph: [
    "name: fx",
    "target: graph",
    "model: m",
    "entry: a",
    "nodes:",
    "  a:",
    "    instructions: do a",
    FAILURE_TAXONOMY,
    LIMITS,
    CHAIN_BLOCKS,
  ].join("\n"),
  managed: [
    "name: fx",
    "target: managed",
    "agent:",
    "  model: m",
    "  instructions: i",
    "  thinking:",
    "    budget_tokens: 4096",
    MODEL_POOL,
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    FAILURE_TAXONOMY,
    LIMITS,
    MEMORY_CONTINUITY,
  ].join("\n"),
  pipeline: [
    "name: fx",
    "target: pipeline",
    "agent:",
    "  model: m",
    "  instructions: i",
    "retrieve:",
    "  embedderModel: e",
    "  defaultK: 5",
    "indexing:",
    "  chunkSize: 400",
    "  chunkOverlap: 40",
    "  documents:",
    "    - id: d1",
    "      text: t",
    FAILURE_TAXONOMY,
  ].join("\n"),
  crew: [
    "name: fx",
    "target: crew",
    "model: m",
    "entry: lead",
    "roles:",
    "  lead:",
    "    instructions: lead it",
    FAILURE_TAXONOMY,
    LIMITS,
    CHAIN_BLOCKS,
    MEMORY_CONTINUITY,
  ].join("\n"),
  research: [
    "name: fx",
    "target: research",
    "agent:",
    "  model: m",
    "  instructions: i",
    "goal: learn",
    FAILURE_TAXONOMY,
    LIMITS,
    CHAIN_BLOCKS,
    MEMORY_CONTINUITY,
  ].join("\n"),
  batch: [
    "name: fx",
    "target: batch",
    "agent:",
    "  model: m",
    "  instructions: i",
    "queue:",
    "  adapter: in-memory",
    FAILURE_TAXONOMY,
    LIMITS,
    CHAIN_BLOCKS,
  ].join("\n"),
  voice: [
    "name: fx",
    "target: voice",
    "agent:",
    "  model: m",
    "  instructions: i",
    "voice:",
    "  provider: openai",
    FAILURE_TAXONOMY,
  ].join("\n"),
  browser: [
    "name: fx",
    "target: browser",
    "agent:",
    "  model: m",
    "  instructions: i",
    FAILURE_TAXONOMY,
    LIMITS,
  ].join("\n"),
  eval: [
    "name: fx",
    "target: eval",
    "agent:",
    "  model: m",
    "  instructions: i",
    "dataset:",
    "  name: d",
    "  version: v1",
    "graders:",
    "  - name: g",
    FAILURE_TAXONOMY,
  ].join("\n"),
  onchain: [
    "name: fx",
    "target: onchain",
    "agent:",
    "  model: m",
    "  instructions: i",
    CHAIN_BLOCKS,
    "triggers:",
    "  - kind: block",
    "    chainId: mainnet",
    "    scanIntervalMs: 60000",
    "idempotencyWindowMs: 60000",
    FAILURE_TAXONOMY,
  ].join("\n"),
  "onchain-game": [
    "name: fx",
    "target: onchain-game",
    "agent:",
    "  model: m",
    "  instructions: i",
    "chain:",
    "  id: mainnet",
    "  kind: evm",
    "  rpcUrls:",
    "    - $RPC_URL",
    "  finality:",
    "    kind: finalized",
    "wallet:",
    "  id: hot",
    "  chainId: mainnet",
    "  custody: local",
    "  keyRef: $WALLET_KEY",
    "game:",
    "  contract:",
    "    id: board",
    "    chainId: mainnet",
    '    address: "0x0000000000000000000000000000000000000002"',
    "    abiRef: abi://erc721",
    "  stateReader: getState",
    "transaction_policy:",
    '  maxValueWei: "1000"',
    "  allowedContracts:",
    "    - board",
    FAILURE_TAXONOMY,
  ].join("\n"),
};

describe("OPTIMIZABLE_PATHS ⊆ spec schema (subset-of-schema guard)", () => {
  const targets = Object.keys(OPTIMIZABLE_PATHS) as Array<Spec["target"]>;

  test("every target has a fixture", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...targets].sort());
  });

  for (const target of targets) {
    test(`${target}: fixture parses and textually carries every optimizable path`, () => {
      const yaml = FIXTURES[target];
      const spec = parseSpec(yaml); // throws on any phantom key (strict schemas)
      expect(spec.target).toBe(target);
      for (const path of OPTIMIZABLE_PATHS[target]) {
        // specHasPath reads the CST — the same check applySpecPatch's
        // replace-vs-add split relies on. A path the fixture cannot carry
        // is a phantom the optimizer could never patch.
        expect(
          specHasPath(yaml, path),
          `optimizable path [${path.join(", ")}] is not declarable on target "${target}" — phantom entry in OPTIMIZABLE_PATHS or fixture gap`,
        ).toBe(true);
      }
    });
  }
});
