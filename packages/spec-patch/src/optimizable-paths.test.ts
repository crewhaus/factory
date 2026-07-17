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
import { parse } from "yaml";
import { OPTIMIZABLE_PATHS, applySpecEdits, diffSpecYaml, specHasPath } from "./index";

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

// Loop contract 0.4 (Batch B, G40) — threshold is llm_judge-only, so the
// fixture grader must be llm_judge for ["evaluation","threshold"] to be
// declarable.
const EVALUATION = `
evaluation:
  grader:
    type: llm_judge
    criteria: the answer is correct and complete
  threshold: 0.8
  on_fail: retry
  max_retries: 2
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
    EVALUATION,
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
    EVALUATION,
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
    EVALUATION,
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

/** Walk a parsed (plain-JS) value tree down a property-key path. */
function getAtPath(value: unknown, path: ReadonlyArray<string>): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Loop contract 0.4 (Batch B, G40) — the same whitelist, exercised through
 * the DECLARATIVE optimizer surface: every optimizable path must survive an
 * `applySpecEdits` round-trip under `restrictToOptimizable` with the
 * document's comments intact and zero value-level drift. A path that the
 * edit surface can't upsert (or that trips the whitelist check it is itself
 * listed in) fails HERE, not in a user's optimize run.
 */
describe("OPTIMIZABLE_PATHS × applySpecEdits (optimizer-surface round-trip)", () => {
  const targets = Object.keys(OPTIMIZABLE_PATHS) as Array<Spec["target"]>;

  for (const target of targets) {
    test(`${target}: every optimizable path round-trips with comments preserved`, () => {
      // A leading comment plus a structural comment pinned to a key every
      // fixture carries — both must survive every edit.
      const yaml = `# optimizer guard fixture\n${FIXTURES[target].replace(
        "failure_taxonomy:",
        "# recovery table\nfailure_taxonomy:",
      )}`;
      const parsed = parse(yaml) as Record<string, unknown>;
      for (const path of OPTIMIZABLE_PATHS[target]) {
        const value = getAtPath(parsed, path);
        expect(
          value,
          `fixture for "${target}" carries no value at [${path.join(", ")}]`,
        ).not.toBeUndefined();
        // Upsert the value the document already carries: a pure round-trip,
        // so the only acceptable outcome is "applied, byte-comments intact,
        // value-identical".
        const result = applySpecEdits(yaml, [{ path: [...path], value }], {
          restrictToOptimizable: true,
        });
        expect(result.applied).toBe(1);
        expect(result.spec.target).toBe(target);
        expect(result.yaml).toContain("# optimizer guard fixture");
        expect(result.yaml).toContain("# recovery table");
        expect(
          diffSpecYaml(yaml, result.yaml),
          `re-setting [${path.join(", ")}] to its own value drifted the parsed spec`,
        ).toEqual([]);
      }
    });
  }
});
