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
import {
  HUMAN_OWNED_PATHS,
  OPTIMIZABLE_PATHS,
  STRUCTURAL_SEGMENTS,
  type SpecEditPathSegment,
  WILDCARD_SEGMENT,
  applySpecEdits,
  diffSpecYaml,
  humanOwnedReason,
  isOptimizable,
  specHasPath,
  validatePatch,
  wildcardPlacementIssues,
} from "./index";

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

// 0.6.0 §7.1 — the hybrid pool container on an agent block: every dial the
// §10.3 table whitelists is declared (rules[*].enabled, the strategy cost
// dials, classifier.max_tokens) beside the pre-0.6.0 policy knobs. The
// classifier block requires `policy: classifier` and labels that are
// candidate tags; cascade roles are tags.
const MODEL_POOL = `
  model_pool:
    candidates:
      - model: claude-haiku-4-5
        tags: [cheap]
      - model: claude-opus-4-8
        tags: [strong]
    policy: classifier
    routing:
      strongTag: strong
    learning:
      minSamplesPerArm: 2
    rules:
      - id: code-goes-strong
        when: { message_matches: "refactor" }
        use: strong
        enabled: true
    classifier:
      model: claude-haiku-4-5
      labels: { cheap: simple lookup, strong: multi-step reasoning }
      max_tokens: 16
    strategy:
      cascade: { draft: cheap, escalate_to: strong, clean_prompt: true }
      guide: { model: claude-opus-4-8, every: first_turn, max_tokens: 400 }
      shadow: { candidate: claude-sonnet-4-6, sample_rate: 0.1 }
      max_escalations: 1
`.trimEnd();

/** The same pool re-indented for a positional block (a step / node / role). */
const indent = (block: string, spaces: number): string =>
  block
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(spaces)}${line}`))
    .join("\n");

// 0.6.0 §4.1 — a `models:` registry carrying every per-profile dial. Two
// profiles because `temperature` and `thinking` are mutually exclusive on ONE
// profile: `fast` carries the temperature / max_tokens / timeout dials, `deep`
// the explicit thinking budget.
const MODELS = `
models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
    max_tokens: 4096
    temperature: 0.2
    limits: { model_call_timeout_ms: 20000 }
  deep:
    model: claude-opus-4-8
    tags: [strong]
    thinking: { budget_tokens: 2048 }
`.trim();

const MEMORY_CONTINUITY = `
memory:
  recallK: 5
  autoCaptureThreshold: 2
  ttl: 90d
  refreshEvery: 3
  wiki:
    recallK: 5
  dream:
    every: 24h
    budget_usd: 0.5
continuity:
  focusMaxChars: 4096
`.trim();

// Loop contract 0.4 (Batch E) — the agent-shape RAG block (cli/channel/
// managed). `sources` is required so the fixture declares one; the
// optimizable paths are the tuning dials underneath it.
const KNOWLEDGE = `
knowledge:
  default_k: 5
  chunk:
    size: 400
    overlap: 40
  sources:
    - path: ./docs
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
    repeats: 3
  threshold: 0.8
  on_fail: retry
  max_retries: 2
`.trim();

// 0.6.0 — a `kind: judge` gate carrying its three dials (positional shapes).
const JUDGE_GATE = `
    kind: judge
    judge:
      criteria: the draft is grounded
      threshold: 0.7
      max_retries: 2
      repeats: 3
`.trimEnd();

/**
 * Fixtures per target. Together they declare a value at EVERY optimizable
 * path — one fixture cannot always do it alone: `agent.temperature` and
 * `agent.thinking.budget_tokens` are mutually exclusive on one block, so the
 * agent-shape targets carry a second fixture with the other dial. A path is
 * declarable when SOME fixture of its target carries it.
 */
const AGENT_THINKING = ["  thinking:", "    budget_tokens: 4096"];
const AGENT_TEMPERATURE = ["  temperature: 0.3"];

function cliFixture(dial: readonly string[]): string {
  return [
    "name: fx",
    "target: cli",
    MODELS,
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: be helpful",
    "  max_tokens: 9000",
    ...dial,
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
    KNOWLEDGE,
  ].join("\n");
}

function channelFixture(dial: readonly string[]): string {
  return [
    "name: fx",
    "target: channel",
    MODELS,
    "agent:",
    "  model: m",
    "  instructions: i",
    ...dial,
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
    KNOWLEDGE,
  ].join("\n");
}

function managedFixture(dial: readonly string[]): string {
  return [
    "name: fx",
    "target: managed",
    MODELS,
    "agent:",
    "  model: m",
    "  instructions: i",
    ...dial,
    MODEL_POOL,
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    FAILURE_TAXONOMY,
    LIMITS,
    MEMORY_CONTINUITY,
    EVALUATION,
    KNOWLEDGE,
  ].join("\n");
}

/** The pooled single-agent shapes (pipeline / research / batch / browser) share one agent block. */
const POOLED_AGENT = [
  "agent:",
  "  model: m",
  "  instructions: i",
  "  temperature: 0.3",
  MODEL_POOL,
];

const FIXTURES: Readonly<Record<Spec["target"], ReadonlyArray<string>>> = {
  cli: [cliFixture(AGENT_THINKING), cliFixture(AGENT_TEMPERATURE)],
  workflow: [
    [
      "name: fx",
      "target: workflow",
      MODELS,
      "model: m",
      "steps:",
      "  - name: one",
      "    instructions: do it",
      "    temperature: 0.3",
      indent(MODEL_POOL, 2),
      "  - name: gate",
      JUDGE_GATE,
      FAILURE_TAXONOMY,
      LIMITS,
      CHAIN_BLOCKS,
    ].join("\n"),
  ],
  channel: [channelFixture(AGENT_THINKING), channelFixture(AGENT_TEMPERATURE)],
  graph: [
    [
      "name: fx",
      "target: graph",
      MODELS,
      "model: m",
      "entry: a",
      "nodes:",
      "  a:",
      "    instructions: do a",
      "    temperature: 0.3",
      indent(MODEL_POOL, 2),
      "  gate:",
      JUDGE_GATE,
      "edges:",
      "  - { from: a, to: gate }",
      FAILURE_TAXONOMY,
      LIMITS,
      CHAIN_BLOCKS,
    ].join("\n"),
  ],
  managed: [managedFixture(AGENT_THINKING), managedFixture(AGENT_TEMPERATURE)],
  pipeline: [
    [
      "name: fx",
      "target: pipeline",
      MODELS,
      ...POOLED_AGENT,
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
  ],
  crew: [
    [
      "name: fx",
      "target: crew",
      MODELS,
      "model: m",
      "entry: lead",
      "roles:",
      "  lead:",
      "    instructions: lead it",
      "    temperature: 0.3",
      indent(MODEL_POOL, 2),
      FAILURE_TAXONOMY,
      LIMITS,
      CHAIN_BLOCKS,
      MEMORY_CONTINUITY,
    ].join("\n"),
  ],
  research: [
    [
      "name: fx",
      "target: research",
      MODELS,
      ...POOLED_AGENT,
      "goal: learn",
      FAILURE_TAXONOMY,
      LIMITS,
      CHAIN_BLOCKS,
      MEMORY_CONTINUITY,
    ].join("\n"),
  ],
  batch: [
    [
      "name: fx",
      "target: batch",
      MODELS,
      ...POOLED_AGENT,
      "queue:",
      "  adapter: in-memory",
      FAILURE_TAXONOMY,
      LIMITS,
      CHAIN_BLOCKS,
    ].join("\n"),
  ],
  voice: [
    [
      "name: fx",
      "target: voice",
      MODELS,
      "agent:",
      "  model: m",
      "  instructions: i",
      "voice:",
      "  provider: openai",
      FAILURE_TAXONOMY,
    ].join("\n"),
  ],
  browser: [
    ["name: fx", "target: browser", MODELS, ...POOLED_AGENT, FAILURE_TAXONOMY, LIMITS].join("\n"),
  ],
  eval: [
    [
      "name: fx",
      "target: eval",
      MODELS,
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
  ],
  onchain: [
    [
      "name: fx",
      "target: onchain",
      MODELS,
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
  ],
  "onchain-game": [
    [
      "name: fx",
      "target: onchain-game",
      MODELS,
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
  ],
};

/** Walk a parsed (plain-JS) value tree down a property-key path. */
function getAtPath(value: unknown, path: ReadonlyArray<SpecEditPathSegment>): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[String(seg)];
  }
  return cur;
}

/**
 * 0.6.0 — turn a wildcard entry into the CONCRETE path a fixture carries:
 * each `"*"` is replaced by a key (or index) of the fixture value at that
 * position under which the rest of the entry resolves. `undefined` when no
 * such key exists (the fixture does not carry the path).
 */
function concretize(
  parsed: unknown,
  entry: ReadonlyArray<string>,
): ReadonlyArray<SpecEditPathSegment> | undefined {
  const walk = (
    value: unknown,
    i: number,
    acc: SpecEditPathSegment[],
  ): ReadonlyArray<SpecEditPathSegment> | undefined => {
    if (i === entry.length) return value === undefined ? undefined : acc;
    if (typeof value !== "object" || value === null) return undefined;
    const seg = entry[i] as string;
    if (seg !== WILDCARD_SEGMENT) {
      return walk((value as Record<string, unknown>)[seg], i + 1, [...acc, seg]);
    }
    const keys: SpecEditPathSegment[] = Array.isArray(value)
      ? value.map((_, idx) => idx)
      : Object.keys(value as Record<string, unknown>);
    for (const key of keys) {
      const hit = walk((value as Record<string, unknown>)[String(key)], i + 1, [...acc, key]);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(parsed, 0, []);
}

/** The first fixture of `target` that carries `entry`, with the concrete path. */
function declaring(
  target: Spec["target"],
  entry: ReadonlyArray<string>,
): { yaml: string; path: ReadonlyArray<SpecEditPathSegment> } | undefined {
  for (const yaml of FIXTURES[target]) {
    const path = concretize(parse(yaml), entry);
    if (path !== undefined) return { yaml, path };
  }
  return undefined;
}

describe("OPTIMIZABLE_PATHS ⊆ spec schema (subset-of-schema guard)", () => {
  const targets = Object.keys(OPTIMIZABLE_PATHS) as Array<Spec["target"]>;

  test("every target has at least one fixture", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...targets].sort());
    for (const target of targets) expect(FIXTURES[target].length).toBeGreaterThan(0);
  });

  for (const target of targets) {
    test(`${target}: every fixture parses and, together, they textually carry every optimizable path`, () => {
      for (const yaml of FIXTURES[target]) {
        const spec = parseSpec(yaml); // throws on any phantom key (strict schemas)
        expect(spec.target).toBe(target);
      }
      for (const entry of OPTIMIZABLE_PATHS[target]) {
        // A wildcard entry is declarable when SOME fixture carries a concrete
        // instance of it; specHasPath reads the CST — the same check
        // applySpecPatch's replace-vs-add split relies on. A path no fixture
        // can carry is a phantom the optimizer could never patch.
        const hit = declaring(target, entry);
        expect(
          hit,
          `optimizable path [${entry.join(", ")}] is not declarable on target "${target}" — phantom entry in OPTIMIZABLE_PATHS or fixture gap`,
        ).toBeDefined();
        if (hit === undefined) continue;
        expect(
          specHasPath(
            hit.yaml,
            hit.path.map((seg) => String(seg)),
          ),
          `[${hit.path.join(", ")}] is not in the CST of the "${target}" fixture that declares it`,
        ).toBe(true);
        // The concrete instance is admitted by the matcher (exact match).
        expect(isOptimizable(target, hit.path)).toBe(true);
      }
    });
  }
});

/**
 * Loop contract 0.4 (Batch B, G40) — the same whitelist, exercised through
 * the DECLARATIVE optimizer surface: every optimizable path must survive an
 * `applySpecEdits` round-trip under `restrictToOptimizable` with the
 * document's comments intact and zero value-level drift. A path that the
 * edit surface can't upsert (or that trips the whitelist check it is itself
 * listed in) fails HERE, not in a user's optimize run. 0.6.0: this is also
 * the comment-preserving round-trip fixture for every path the §10.3 table
 * added — wildcard entries round-trip through their concrete instance.
 */
describe("OPTIMIZABLE_PATHS × applySpecEdits (optimizer-surface round-trip)", () => {
  const targets = Object.keys(OPTIMIZABLE_PATHS) as Array<Spec["target"]>;

  for (const target of targets) {
    test(`${target}: every optimizable path round-trips with comments preserved`, () => {
      for (const entry of OPTIMIZABLE_PATHS[target]) {
        const hit = declaring(target, entry);
        expect(hit, `no "${target}" fixture carries [${entry.join(", ")}]`).toBeDefined();
        if (hit === undefined) continue;
        // A leading comment plus a structural comment pinned to a key every
        // fixture carries — both must survive every edit.
        const yaml = `# optimizer guard fixture\n${hit.yaml.replace(
          "failure_taxonomy:",
          "# recovery table\nfailure_taxonomy:",
        )}`;
        const value = getAtPath(parse(yaml), hit.path);
        expect(
          value,
          `fixture for "${target}" carries no value at [${hit.path.join(", ")}]`,
        ).not.toBeUndefined();
        // Upsert the value the document already carries: a pure round-trip,
        // so the only acceptable outcome is "applied, byte-comments intact,
        // value-identical".
        const result = applySpecEdits(yaml, [{ path: [...hit.path], value }], {
          restrictToOptimizable: true,
        });
        expect(result.applied).toBe(1);
        expect(result.spec.target).toBe(target);
        expect(result.yaml).toContain("# optimizer guard fixture");
        expect(result.yaml).toContain("# recovery table");
        expect(
          diffSpecYaml(yaml, result.yaml),
          `re-setting [${hit.path.join(", ")}] to its own value drifted the parsed spec`,
        ).toEqual([]);
      }
    });
  }

  test("a wildcard entry round-trips through validatePatch too (string-indexed path)", () => {
    // `SpecPatch.path` is string-only; a step index travels as "0".
    const hit = declaring("workflow", ["steps", "*", "model_pool", "rules", "*", "enabled"]);
    if (hit === undefined) throw new Error("fixture gap");
    const spec = parseSpec(hit.yaml);
    expect(() =>
      validatePatch(spec, {
        target: "workflow",
        path: hit.path.map((seg) => String(seg)),
        op: "replace",
        value: false,
      }),
    ).not.toThrow();
    const cli = declaring("cli", ["models", "*", "max_tokens"]);
    if (cli === undefined) throw new Error("fixture gap");
    expect(() =>
      validatePatch(parseSpec(cli.yaml), {
        target: "cli",
        path: cli.path.map((seg) => String(seg)),
        op: "replace",
        value: 2048,
      }),
    ).not.toThrow();
  });
});

/**
 * Batch G, Item 9 (G37) — per-role / per-step model routing is optimizer-
 * reachable via the WHOLE-BLOCK entries (`["roles"]` on crew, `["steps"]` on
 * workflow) rather than standalone paths: the role name / step index is
 * positional, so no static narrower path exists, and whole-block replacement
 * already spans model/instructions. These tests pin that reachability so a
 * future refactor that narrows the entries can't silently orphan the routing.
 */
describe("Item 9 (G37) — role/step model_pool rides the whole-block optimizable entry", () => {
  test("crew: replacing [roles] with a model_pool-bearing role round-trips under restrictToOptimizable", () => {
    const yaml = [
      "name: cr",
      "target: crew",
      "model: base-model",
      "entry: lead",
      "roles:",
      "  lead:",
      "    instructions: lead it",
    ].join("\n");
    const nextRoles = {
      lead: {
        instructions: "lead it",
        model_pool: {
          candidates: [
            { model: "claude-haiku-4-5", tags: ["cheap"] },
            { model: "claude-opus-4-8", tags: ["strong"] },
          ],
          policy: "learned",
        },
      },
    };
    const result = applySpecEdits(yaml, [{ path: ["roles"], value: nextRoles }], {
      restrictToOptimizable: true,
    });
    expect(result.applied).toBe(1);
    if (result.spec.target !== "crew") throw new Error("unexpected target");
    expect(result.spec.roles.lead?.model_pool?.policy).toBe("learned");
  });

  test("workflow: replacing [steps] with a model_pool-bearing step round-trips under restrictToOptimizable", () => {
    const yaml = [
      "name: w",
      "target: workflow",
      "model: base-model",
      "steps:",
      "  - name: route",
      "    instructions: pick a path",
    ].join("\n");
    const nextSteps = [
      {
        name: "route",
        instructions: "pick a path",
        model_pool: {
          candidates: [
            { model: "claude-haiku-4-5", tags: ["cheap"] },
            { model: "claude-opus-4-8", tags: ["strong"] },
          ],
          policy: "heuristic",
        },
      },
    ];
    const result = applySpecEdits(yaml, [{ path: ["steps"], value: nextSteps }], {
      restrictToOptimizable: true,
    });
    expect(result.applied).toBe(1);
    if (result.spec.target !== "workflow") throw new Error("unexpected target");
    const step = result.spec.steps[0];
    if (step === undefined || "kind" in step) throw new Error("expected a regular step");
    expect(step.model_pool?.policy).toBe("heuristic");
  });
});

/**
 * 0.6.0 (plan §10.3, mechanism 2) — the STRUCTURAL rule. The whole-block
 * entries `["steps"]` (workflow), `["nodes"]` (graph) and `["roles"]` (crew)
 * admit sub-paths by PREFIX, and from 0.6.0 every routed block carries the
 * hybrid `model_pool` container, `temperature`, a `kind: judge` gate's
 * `escalate_to` and sub-agent routing — all human-owned per the §10.3 verdict
 * table. Without the rule they were optimizer-reachable on these three
 * shapes the moment the spec accepted them. Per target: the structural paths
 * are rejected, the exact entries and the plain prefix paths keep working.
 */
describe("§10.3 structural rule — model_pool / judge / sub_agents / temperature are never admitted by prefix", () => {
  const WORKFLOW = [
    "name: w",
    "target: workflow",
    "model: base-model",
    "steps:",
    "  - name: draft",
    "    instructions: write it",
    "    model_pool:",
    "      candidates:",
    "        - { model: m1, tags: [cheap] }",
    "        - { model: m2, tags: [strong] }",
    "  - name: gate",
    "    kind: judge",
    "    judge: { criteria: c }",
  ].join("\n");
  const GRAPH = [
    "name: g",
    "target: graph",
    "model: base-model",
    "entry: a",
    "nodes:",
    "  a:",
    "    instructions: x",
    "  gate:",
    "    kind: judge",
    "    judge: { criteria: c }",
    "edges: [{from: a, to: gate}]",
  ].join("\n");
  const CREW = [
    "name: cr",
    "target: crew",
    "model: base-model",
    "entry: lead",
    "roles:",
    "  lead:",
    "    instructions: lead it",
    "    sub_agents:",
    "      helper: { description: helps, instructions: help }",
  ].join("\n");

  const POOL_LEAVES = [
    "strategy",
    "rules",
    "reward",
    "directives",
    "classifier",
    "candidates",
    "scope",
  ];

  const rejected = (yaml: string, path: ReadonlyArray<string | number>): void => {
    expect(
      () =>
        applySpecEdits(yaml, [{ path: [...path], value: true }], { restrictToOptimizable: true }),
      `[${path.join(", ")}] must NOT be optimizer-reachable`,
    ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
  };

  test("workflow: steps[*].model_pool.*, temperature and judge.* are rejected", () => {
    for (const leaf of POOL_LEAVES) rejected(WORKFLOW, ["steps", 0, "model_pool", leaf]);
    rejected(WORKFLOW, ["steps", 0, "model_pool", "strategy", "model_directed"]);
    rejected(WORKFLOW, ["steps", 0, "model_pool", "rules", 0, "use"]);
    rejected(WORKFLOW, ["steps", 0, "model_pool", "reward", "floor", "arm"]);
    // The pre-0.6.0 roster leak the in-code comment already claimed closed.
    rejected(WORKFLOW, ["steps", 0, "model_pool", "candidates", 0, "model"]);
    rejected(WORKFLOW, ["steps", 1, "judge", "escalate_to"]);
    rejected(WORKFLOW, ["steps", 1, "judge", "judges"]);
    rejected(WORKFLOW, ["steps", 1, "judge", "criteria"]);
    rejected(WORKFLOW, ["steps", 1, "judge", "model"]);
    rejected(WORKFLOW, ["steps", 1, "judge", "temperature"]);
    // PR 19: `steps[*].temperature` and the judge gate's `repeats` /
    // `threshold` / `max_retries` are EXACT wildcard entries now — the
    // structural segment still blocks the prefix route (asserted above),
    // never the listed dial.
    for (const path of [
      ["steps", 0, "temperature"],
      ["steps", 1, "judge", "repeats"],
      ["steps", 1, "judge", "threshold"],
      ["steps", 1, "judge", "max_retries"],
      ["steps", 0, "model_pool", "policy"],
      ["steps", 0, "model_pool", "strategy", "max_escalations"],
    ] as const) {
      expect(isOptimizable("workflow", [...path]), `[${path.join(", ")}]`).toBe(true);
    }
  });

  test("graph: nodes.<n>.model_pool.*, temperature and judge.* are rejected", () => {
    for (const leaf of POOL_LEAVES) rejected(GRAPH, ["nodes", "a", "model_pool", leaf]);
    rejected(GRAPH, ["nodes", "a", "model_pool"]);
    rejected(GRAPH, ["nodes", "gate", "judge", "escalate_to"]);
    rejected(GRAPH, ["nodes", "gate", "judge", "judges"]);
    rejected(GRAPH, ["nodes", "gate", "judge", "criteria"]);
    expect(isOptimizable("graph", ["nodes", "a", "temperature"])).toBe(true);
    expect(isOptimizable("graph", ["nodes", "gate", "judge", "repeats"])).toBe(true);
  });

  test("crew: roles.<r>.model_pool.*, temperature and sub_agents.* are rejected", () => {
    for (const leaf of POOL_LEAVES) rejected(CREW, ["roles", "lead", "model_pool", leaf]);
    rejected(CREW, ["roles", "lead", "model_pool"]);
    expect(isOptimizable("crew", ["roles", "lead", "temperature"])).toBe(true);
    rejected(CREW, ["roles", "lead", "sub_agents", "helper", "allowed_profiles"]);
    rejected(CREW, ["roles", "lead", "sub_agents", "helper", "budget_share"]);
    rejected(CREW, ["roles", "lead", "sub_agents", "helper", "inherit_routing"]);
    rejected(CREW, ["roles", "lead", "sub_agents", "helper", "model_pool"]);
    // Pre-0.6.0 sub-agent keys are identity / security surface too.
    rejected(CREW, ["roles", "lead", "sub_agents", "helper", "permissions"]);
    rejected(CREW, ["roles", "lead", "sub_agents", "helper", "tools"]);
  });

  test("the exact entries and the plain prefix paths keep working on the same shapes", () => {
    const wf = applySpecEdits(
      WORKFLOW,
      [{ path: ["steps", 0, "instructions"], value: "write it with citations" }],
      { restrictToOptimizable: true },
    );
    expect(wf.applied).toBe(1);
    // Whole-block replacement carries no structural SEGMENT in its path, so it
    // is unchanged (the G37 tests above pin that a pool-bearing block rides it).
    const cr = applySpecEdits(
      CREW,
      [{ path: ["roles", "lead", "instructions"], value: "lead harder" }],
      {
        restrictToOptimizable: true,
      },
    );
    expect(cr.applied).toBe(1);
    const g = applySpecEdits(GRAPH, [{ path: ["nodes", "a", "instructions"], value: "y" }], {
      restrictToOptimizable: true,
    });
    expect(g.applied).toBe(1);
    // The cli pool's exact POLICY entries are exact matches, not prefix ones.
    const cli = [
      "name: c",
      "target: cli",
      "agent:",
      "  model: m",
      "  instructions: hi",
      "  model_pool:",
      "    candidates:",
      "      - { model: m1, tags: [cheap] }",
      "      - { model: m2, tags: [strong] }",
    ].join("\n");
    const pooled = applySpecEdits(
      cli,
      [{ path: ["agent", "model_pool", "policy"], value: "learned" }],
      {
        restrictToOptimizable: true,
      },
    );
    expect(pooled.applied).toBe(1);
    // … and a sub-path UNDER an exact pool entry is exact-only too.
    rejected(cli, ["agent", "model_pool", "routing", "strongTag"]);
    rejected(cli, ["agent", "model_pool", "candidates", 0, "enabled"]);
  });

  test("every structural segment is a spec key on at least one routed block (no phantom rule)", () => {
    // If the spec ever renames one of these, the rule silently stops biting;
    // pin the four names against the parsed shapes they guard.
    const wf = parseSpec(WORKFLOW);
    if (wf.target !== "workflow") throw new Error("unexpected target");
    const draft = wf.steps[0];
    const gate = wf.steps[1];
    if (draft === undefined || "kind" in draft) throw new Error("expected a regular step");
    if (gate === undefined || !("kind" in gate)) throw new Error("expected a judge step");
    expect("model_pool" in draft && draft.model_pool !== undefined).toBe(true);
    expect("judge" in gate).toBe(true);
    const cr = parseSpec(CREW);
    if (cr.target !== "crew") throw new Error("unexpected target");
    expect(cr.roles.lead?.sub_agents?.helper).toBeDefined();
    expect(STRUCTURAL_SEGMENTS).toEqual(["model_pool", "judge", "sub_agents", "temperature"]);
    expect(
      parseSpec(
        `${WORKFLOW.replace("    instructions: write it", "    instructions: write it\n    temperature: 0")}`,
      ),
    ).toBeDefined();
  });
});

/**
 * 0.6.0 acceptance item 10, the NEGATIVE half: the roster stays human-owned
 * on every host. Each patch must hard-fail `validatePatch` (and therefore
 * `applySpecEdits({ restrictToOptimizable })`) — no route, exact or prefix,
 * admits it. The positive half (the dials the table promises) is the
 * fixture round-trip above.
 */
describe("§10.3 — the roster patches hard-fail validatePatch on every host", () => {
  const CLI = [
    "name: c",
    "target: cli",
    MODELS,
    "agent:",
    "  model: $fast",
    "  instructions: hi",
    "  model_pool:",
    "    candidates:",
    "      - { model: $fast, tags: [cheap] }",
    "      - { model: $deep, tags: [strong], enabled: false }",
    "    rules:",
    "      - { id: r1, when: { has_images: true }, use: strong }",
  ].join("\n");

  test("candidates, a profile's model, and a rule's target are refused", () => {
    const spec = parseSpec(CLI);
    for (const path of [
      ["agent", "model_pool", "candidates"],
      ["agent", "model_pool", "candidates", "0", "model"],
      ["agent", "model_pool", "candidates", "1", "enabled"],
      ["agent", "model_pool", "candidates", "0", "tools"],
      ["models", "fast", "model"],
      ["models", "fast", "tools"],
      ["models", "fast", "permissions"],
      ["models", "fast", "tags"],
      ["models", "fast", "instructions"],
      ["models", "deep", "thinking", "effort"],
      ["agent", "model_pool", "rules", "0", "use"],
      ["agent", "model_pool", "rules", "0", "when"],
      ["agent", "model_pool", "rules", "0", "id"],
      ["agent", "model_pool", "reward"],
      ["agent", "model_pool", "reward", "floor", "arm"],
      ["agent", "model_pool", "directives"],
      ["agent", "model_pool", "strategy", "model_directed"],
      ["agent", "model_pool", "strategy", "cascade", "escalate_to"],
      ["agent", "model_pool", "classifier", "model"],
      ["agent", "model_pool", "classifier", "labels"],
      ["agent", "model_pool", "objective"],
      ["agent", "model"],
      ["agent", "sub_agents", "helper", "allowed_profiles"],
      ["budget", "judge_share"],
      ["evaluation", "on_fail"],
      ["evaluation", "grader", "judges"],
      ["observability", "slo", "escalation_rate"],
    ]) {
      expect(
        () => validatePatch(spec, { target: "cli", path, op: "replace", value: "x" }),
        `[${path.join(", ")}] must hard-fail`,
      ).toThrow(/not listed in OPTIMIZABLE_PATHS/);
      // …and every one of them is CLASSIFIED as excluded, with a reason.
      expect(humanOwnedReason(path), `[${path.join(", ")}] has no exclusion row`).toBeDefined();
    }
  });

  test("the same roster paths are refused on the positional hosts", () => {
    for (const [target, path] of [
      ["workflow", ["steps", 0, "model_pool", "candidates", 0, "enabled"]],
      ["workflow", ["steps", 0, "model_pool", "rules", 0, "use"]],
      ["graph", ["nodes", "a", "model_pool", "reward", "floor", "arm"]],
      ["crew", ["roles", "lead", "model_pool", "strategy", "committee", "judge"]],
      ["crew", ["roles", "lead", "sub_agents", "helper", "inherit_routing"]],
      ["pipeline", ["agent", "model_pool", "candidates"]],
      ["research", ["models", "fast", "model"]],
    ] as const) {
      expect(isOptimizable(target, [...path]), `${target}: [${path.join(", ")}]`).toBe(false);
      expect(humanOwnedReason([...path])).toBeDefined();
    }
  });

  test("a wildcard matches exactly one segment — never zero, never two, never a literal *", () => {
    expect(isOptimizable("cli", ["models", "fast", "max_tokens"])).toBe(true);
    expect(isOptimizable("cli", ["models", "max_tokens"])).toBe(false);
    expect(isOptimizable("cli", ["models", "a", "b", "max_tokens"])).toBe(false);
    // A literal "*" key in a PATCH is a key like any other: it matches the
    // wildcard entry (the spec's profile-name grammar rejects it at apply).
    expect(isOptimizable("cli", ["models", "*", "max_tokens"])).toBe(true);
    // Numeric and string indices are the same segment.
    expect(isOptimizable("workflow", ["steps", 0, "temperature"])).toBe(true);
    expect(isOptimizable("workflow", ["steps", "0", "temperature"])).toBe(true);
    // A wildcard entry is never a PREFIX for what hangs below its leaf.
    expect(isOptimizable("cli", ["models", "fast", "limits"])).toBe(false);
    expect(isOptimizable("cli", ["models", "fast"])).toBe(false);
    expect(isOptimizable("cli", ["models"])).toBe(false);
  });
});

/**
 * 0.6.0 §10.3, mechanism 1 — the wildcard placement guard: no shipped entry
 * lets `"*"` sit above a human-owned key, and the guard itself bites.
 */
describe("wildcard placement guard", () => {
  test("the shipped table has no placement issue", () => {
    expect(wildcardPlacementIssues()).toEqual([]);
  });

  test("a trailing wildcard, a human-owned leaf, or a structural leaf under a wildcard is an issue", () => {
    const issues = wildcardPlacementIssues({
      cli: [
        ["models", WILDCARD_SEGMENT],
        ["models", WILDCARD_SEGMENT, "tools"],
        ["steps", WILDCARD_SEGMENT, "model_pool"],
        ["steps", WILDCARD_SEGMENT, "model_pool", "candidates"],
        ["models", WILDCARD_SEGMENT, "max_tokens"], // fine
      ],
    });
    expect(issues).toHaveLength(4);
    expect(issues[0]).toContain("ends in a wildcard");
    expect(issues[1]).toContain('human-owned key "tools"');
    expect(issues[2]).toContain('structural block "model_pool"');
    expect(issues[3]).toContain('human-owned key "candidates"');
  });

  test("every exclusion row is well-formed and no row is itself whitelisted verbatim", () => {
    for (const row of HUMAN_OWNED_PATHS) {
      expect(row.pattern.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(10);
      expect(row.pattern[row.pattern.length - 1]).not.toBe(WILDCARD_SEGMENT);
    }
  });
});
