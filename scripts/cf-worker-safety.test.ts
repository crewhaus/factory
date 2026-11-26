/**
 * The cf-worker edge gate, held to the schema: every setting a cli, workflow
 * or graph spec can declare under a gated root either changes the worker it
 * builds, is enforced by how the worker runs, or is refused, naming its path.
 * So every safety setting a worker is built with is one the worker enforces.
 *
 * The probe keys come from the zod `Spec` union, not from a hand-kept list:
 * every leaf under `CF_WORKER_GATED_ROOTS` collapses into one key, and the
 * probe table must name exactly those keys, so a leaf the schema gains fails
 * here until it has a probe. Each probe runs through both entry points, the
 * CLI's `emitCfWorkerBundle` and the hosted compiler-worker's `POST /compile`,
 * and the two must agree.
 *
 * What each probe should do is read from the gate's own tables
 * (`CF_WORKER_ENFORCED_KEYS`, `CF_WORKER_REFUSAL_REASONS`), and the test holds
 * the tables to what the build does: a `config` row changes worker.js, a
 * `construction` row leaves it the same, a row's refused value is refused,
 * and no other value of a row is. The decisions themselves are pinned too.
 */
import { describe, expect, test } from "bun:test";
import type { ZodTypeAny } from "zod";
import { CF_WORKER_EMIT_TARGETS, emitCfWorkerBundle } from "../apps/cli/src/cf-worker-emit";
import { permissionRuleWarnings } from "../apps/cli/src/lint";
import { loadBuiltinTools } from "../apps/cli/src/tool-packages";
import { CLI_RUNTIME_TOOL_KEYS } from "../apps/cli/src/tools-cli";
import compilerWorker from "../packages/compiler-worker/src/index";
import {
  CF_WORKER_ENFORCED_KEYS,
  CF_WORKER_GATED_ROOTS,
  CF_WORKER_REFUSAL_REASONS,
  lowerWithWarnings,
  parseSpec,
} from "../packages/compiler/src/index";
import { Spec } from "../packages/spec/src/index";
import { preparePermissionSubject } from "../packages/tool-executor/src/index";
import { TOOL_FLAGS } from "../packages/tool-registry-manifest/src/flags";
import { decideWorkerToolCall } from "../packages/worker-runtime/src/permissions";
import { EDGE_SAFE_TOOLS } from "../packages/worker-runtime/src/tool-policy";

const WILDCARD_SEGMENT = "*";
type Shape = (typeof CF_WORKER_EMIT_TARGETS)[number];
type Block = Record<string, unknown>;

// --- the schema walker (as spec-patch's classification invariant walks it) --

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let cur: ZodTypeAny = schema;
  while (true) {
    const def = cur._def as {
      typeName?: string;
      innerType?: ZodTypeAny;
      schema?: ZodTypeAny;
      type?: ZodTypeAny;
    };
    switch (def.typeName) {
      case "ZodOptional":
      case "ZodNullable":
      case "ZodDefault":
      case "ZodCatch":
      case "ZodReadonly":
        cur = def.innerType as ZodTypeAny;
        continue;
      case "ZodBranded":
        cur = def.type as ZodTypeAny;
        continue;
      case "ZodEffects":
        cur = def.schema as ZodTypeAny;
        continue;
      case "ZodLazy":
        cur = (cur._def as { getter: () => ZodTypeAny }).getter();
        continue;
      case "ZodPipeline":
        cur = (cur._def as { in: ZodTypeAny }).in;
        continue;
      default:
        return cur;
    }
  }
}

/** Every leaf path of a schema (`*` for an array index or record key), with the options of an enum or literal leaf. */
function leaves(schema: ZodTypeAny, prefix: string[], out: Map<string, Set<string>>): void {
  const s = unwrap(schema);
  const def = s._def as {
    typeName: string;
    shape?: () => Record<string, ZodTypeAny>;
    type?: ZodTypeAny;
    valueType?: ZodTypeAny;
    options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
    left?: ZodTypeAny;
    right?: ZodTypeAny;
    items?: ZodTypeAny[];
    values?: readonly string[];
    value?: unknown;
  };
  switch (def.typeName) {
    case "ZodObject":
      for (const [key, child] of Object.entries(
        (def.shape as () => Record<string, ZodTypeAny>)(),
      )) {
        leaves(child, [...prefix, key], out);
      }
      return;
    case "ZodArray":
      leaves(def.type as ZodTypeAny, [...prefix, WILDCARD_SEGMENT], out);
      return;
    case "ZodRecord":
      leaves(def.valueType as ZodTypeAny, [...prefix, WILDCARD_SEGMENT], out);
      return;
    case "ZodTuple":
      for (const item of def.items ?? []) leaves(item, [...prefix, WILDCARD_SEGMENT], out);
      return;
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options instanceof Map ? [...def.options.values()] : (def.options ?? []);
      for (const option of options) leaves(option, prefix, out);
      return;
    }
    case "ZodIntersection":
      leaves(def.left as ZodTypeAny, prefix, out);
      leaves(def.right as ZodTypeAny, prefix, out);
      return;
    default: {
      if (prefix.length === 0) return;
      const key = prefix.join(".");
      const options = out.get(key) ?? new Set<string>();
      if (def.typeName === "ZodEnum") for (const v of def.values ?? []) options.add(v);
      if (def.typeName === "ZodLiteral") options.add(String(def.value));
      out.set(key, options);
    }
  }
}

function targetOf(shape: ZodTypeAny): string {
  const fields = (unwrap(shape)._def as { shape: () => Record<string, ZodTypeAny> }).shape();
  return (unwrap(fields["target"] as ZodTypeAny)._def as { value: string }).value;
}

const ROOTS = CF_WORKER_GATED_ROOTS.map((root) => root.split("."));

/** The gated root a leaf path sits under, if any. */
function rootOf(path: readonly string[]): readonly string[] | undefined {
  return ROOTS.find((root) => root.every((seg, i) => seg === path[i]));
}

/** A leaf's probe key: a pool's root, else the path up to its first wildcard after the root. */
function probeKeyOf(path: readonly string[]): string | undefined {
  const root = rootOf(path);
  if (root === undefined) return undefined;
  if (root[root.length - 1] === "model_pool") return root.join(".");
  const rest = path.slice(root.length);
  const star = rest.indexOf(WILDCARD_SEGMENT);
  return [...root, ...(star === -1 ? rest : rest.slice(0, star))].join(".");
}

/** Per shape: each probe key, and the enum options of each gated leaf. */
function schemaKeys(): Map<Shape, { keys: Set<string>; enums: Map<string, Set<string>> }> {
  const out = new Map<Shape, { keys: Set<string>; enums: Map<string, Set<string>> }>();
  for (const shape of Spec.options as ReadonlyArray<ZodTypeAny>) {
    const target = targetOf(shape) as Shape;
    if (!(CF_WORKER_EMIT_TARGETS as readonly string[]).includes(target)) continue;
    const all = new Map<string, Set<string>>();
    leaves(shape, [], all);
    const keys = new Set<string>();
    const enums = new Map<string, Set<string>>();
    for (const [leaf, options] of all) {
      const key = probeKeyOf(leaf.split("."));
      if (key === undefined) continue;
      keys.add(key);
      if (options.size > 0) enums.set(leaf, options);
    }
    out.set(target, { keys, enums });
  }
  return out;
}

// --- the probes ---------------------------------------------------------------

const POOL = {
  policy: "static",
  candidates: [{ model: "claude-haiku-4-5" }, { model: "claude-sonnet-4-6" }],
};
const HOOK_EVENTS = [
  "session-start",
  "stop",
  "pre-tool",
  "post-tool",
  "pre-model",
  "post-model",
  "pre-compact",
  "post-compact",
  "pre-slash",
  "alert",
];

/** The probes every shape shares: the safety blocks a cli, workflow and graph all carry. */
const SHARED: Readonly<Record<string, ReadonlyArray<Block>>> = {
  "permissions.mode": ["default", "plan", "auto"].map((mode) => ({ permissions: { mode } })),
  "permissions.rules": ["alwaysAllow", "alwaysDeny", "alwaysAsk"].map((type) => ({
    permissions: { rules: [{ type, pattern: "WebFetch" }] },
  })),
  "permissions.ask_mode": ["pause", "deny"].map((ask_mode) => ({ permissions: { ask_mode } })),
  "permissions.delegation.max_days": [1, 7, 90].map((max_days) => ({
    permissions: { delegation: { max_days } },
  })),
  hooks: [
    { hooks: HOOK_EVENTS.map((event) => ({ event, command: "exit 2" })) },
    { hooks: [{ event: "pre-tool", matcher: "Web*", command: "exit 2", timeout_ms: 500 }] },
  ],
  "limits.max_tool_iterations": [{ limits: { max_tool_iterations: 7 } }],
  "limits.max_concurrent_tools": [
    { limits: { max_concurrent_tools: 1 } },
    { limits: { max_concurrent_tools: 4 } },
  ],
  "limits.context_limit": [{ limits: { context_limit: 50000 } }],
  "limits.deadline_ms": [{ limits: { deadline_ms: 30000 } }],
  "limits.turn_timeout_ms": [{ limits: { turn_timeout_ms: 1000 } }],
  "limits.model_call_timeout_ms": [{ limits: { model_call_timeout_ms: 1000 } }],
  "limits.loop_detection.window": [{ limits: { loop_detection: { window: 6 } } }],
  "limits.loop_detection.threshold": [{ limits: { loop_detection: { threshold: 3 } } }],
  "limits.loop_detection.escalation": ["warn", "justify", "abort"].map((escalation) => ({
    limits: { loop_detection: { escalation } },
  })),
  "budget.usd": [{ budget: { usd: 1 } }],
  "budget.on_exceed.action": [
    { budget: { usd: 1, on_exceed: { action: "stop" } } },
    { budget: { usd: 1, on_exceed: { action: "degrade", model: "claude-haiku-4-5" } } },
  ],
  "budget.on_exceed.model": [
    { budget: { usd: 1, on_exceed: { action: "degrade", model: "claude-haiku-4-5" } } },
  ],
  "budget.scope": ["run", "session"].map((scope) => ({ budget: { usd: 1, scope } })),
  "budget.judge_share": [{ budget: { usd: 1, judge_share: 0.2 } }],
  "budget.period.every": ["day", "week", "month"].map((every) => ({
    budget: { usd: 1, period: { every, usd: 10 } },
  })),
  "budget.period.usd": [{ budget: { usd: 1, period: { every: "day", usd: 10 } } }],
  "budget.period.starts": [
    { budget: { usd: 1, period: { every: "week", usd: 10, starts: "2026-11-02" } } },
  ],
  "budget.period.timezone": [
    { budget: { usd: 1, period: { every: "day", usd: 10, timezone: "Europe/Berlin" } } },
  ],
};

const PROBES: Readonly<Record<Shape, Readonly<Record<string, ReadonlyArray<Block>>>>> = {
  cli: {
    ...SHARED,
    "security.justification.judge": ["rule-based", "claude"].map((judge) => ({
      security: { justification: { judge } },
    })),
    "security.justification.model": [
      { security: { justification: { judge: "claude", model: "claude-haiku-4-5" } } },
    ],
    "security.egressMatcher": ["substring", "semantic"].map((egressMatcher) => ({
      security: { egressMatcher },
    })),
    "agent.rate_limits": [
      { agent: { rate_limits: { WebFetch: { rpm: 10 } } } },
      { agent: { rate_limits: { "*": { rpm: 5, burst: 2 } } } },
    ],
    "agent.model_pool": [{ agent: { model_pool: POOL } }],
  },
  workflow: { ...SHARED, "steps.*.model_pool": [{ steps: [{ model_pool: POOL }] }] },
  graph: { ...SHARED, "nodes.*.model_pool": [{ nodes: { a: { model_pool: POOL } } }] },
};

/** Each shape's base spec: one agent site that lists webFetch. */
const BASES: Readonly<Record<Shape, Block>> = {
  cli: {
    name: "edge-probe",
    target: "cli",
    agent: { model: "claude-haiku-4-5", instructions: "Answer briefly." },
    tools: ["webFetch"],
  },
  workflow: {
    name: "edge-probe",
    target: "workflow",
    model: "claude-haiku-4-5",
    steps: [{ name: "fetch", instructions: "Fetch it.", tools: ["webFetch"] }],
  },
  graph: {
    name: "edge-probe",
    target: "graph",
    model: "claude-haiku-4-5",
    entry: "a",
    nodes: { a: { instructions: "Fetch it.", tools: ["webFetch"] } },
  },
};

/** `probe` laid over `base`: objects merge key by key, arrays element by element. */
function overlay(base: unknown, probe: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(probe)) {
    return probe.map((item, i) => overlay(base[i], item));
  }
  const isObject = (v: unknown): v is Block =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObject(base) && isObject(probe)) {
    const out: Block = { ...base };
    for (const [k, v] of Object.entries(probe)) out[k] = overlay(base[k], v);
    return out;
  }
  return probe;
}

/** The spec path a probe declares at, as the gate spells it (step 0, node `a`). */
const concrete = (key: string): string =>
  key.replace("steps.*", "steps[0]").replace("nodes.*", "nodes.a");

/** Every scalar leaf of a probe, by path (`*` for an array index), with its value. */
function probeLeaves(value: unknown, path: string[] = [], out: Array<[string, unknown]> = []) {
  if (Array.isArray(value)) {
    for (const item of value) probeLeaves(item, [...path, WILDCARD_SEGMENT], out);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) probeLeaves(v, [...path, k], out);
  } else out.push([path.join("."), value]);
  return out;
}

// --- the two entry points -------------------------------------------------------

type Outcome = { readonly refused: string } | { readonly worker: string };

function viaCli(yaml: string): Outcome {
  const spec = parseSpec(yaml);
  try {
    const bundle = emitCfWorkerBundle(spec, lowerWithWarnings(spec).ir);
    return { worker: bundle.files.find((f) => f.path === "worker.js")?.content ?? "" };
  } catch (err) {
    if ((err as Error).name !== "CompilerError") throw err;
    return { refused: (err as Error).message };
  }
}

async function viaHosted(yaml: string): Promise<Outcome> {
  const res = await compilerWorker.fetch(
    new Request("https://cw.test/compile", {
      method: "POST",
      body: JSON.stringify({ yaml, emitAs: "cf-worker" }),
    }),
    { ALLOWED_ORIGINS: "http://localhost:4322" },
  );
  const body = (await res.json()) as {
    bundle?: { files: Array<{ path: string; content: string }> };
    error?: { code: string; message: string };
  };
  if (res.status === 400 && body.error?.code === "COMPILE") return { refused: body.error.message };
  expect(res.status).toBe(200);
  return { worker: body.bundle?.files.find((f) => f.path === "worker.js")?.content ?? "" };
}

// --- the matrix -------------------------------------------------------------------

type Expectation =
  | { readonly kind: "refused"; readonly line: string; readonly pinned: string }
  | { readonly kind: "changed" | "construction" };

/** What the gate's tables say a probe does. */
function expected(key: string, probe: Block): Expectation {
  const row = CF_WORKER_ENFORCED_KEYS.find((r) => r.path === key);
  if (row !== undefined) {
    const value = probeLeaves(probe).find(([path]) => path === key)?.[1];
    const refusal = row.refuse;
    if (refusal?.values.includes(String(value)) === true) {
      return {
        kind: "refused",
        line: `  ${concrete(key)}: ${refusal.reason}`,
        pinned: `${key}: ${String(value)}`,
      };
    }
    return { kind: row.enforcedBy === "config" ? "changed" : "construction" };
  }
  const segs = key.split(".");
  const reasons = Object.entries(CF_WORKER_REFUSAL_REASONS)
    .filter(([path]) => {
      const p = path.split(".");
      return p.length <= segs.length && p.every((seg, i) => seg === segs[i]);
    })
    .sort((a, b) => b[0].split(".").length - a[0].split(".").length);
  const [path, reason] = reasons[0] ?? [key, "the cf-worker edge does not enforce it"];
  return { kind: "refused", line: `  ${concrete(path)}: ${reason}`, pinned: path };
}

describe("cf-worker edge: every gated setting changes the worker, is enforced by construction, or is refused", () => {
  const derived = schemaKeys();

  test("the probe table names exactly the keys the schema has, and every enum option", () => {
    expect([...derived.keys()].sort()).toEqual([...CF_WORKER_EMIT_TARGETS].sort());
    for (const shape of CF_WORKER_EMIT_TARGETS) {
      const { keys, enums } = derived.get(shape) ?? { keys: new Set(), enums: new Map() };
      const probed = Object.keys(PROBES[shape]);
      const missing = [...keys]
        .filter((k) => !probed.includes(k))
        .map((k) => `add a probe for ${k}`);
      const extra = probed.filter((k) => !keys.has(k)).map((k) => `no schema leaf for ${k}`);
      expect([...missing, ...extra]).toEqual([]);
      // The walker sees the delegation ceiling, so its row and probes cannot pass vacuously.
      expect(keys.has("permissions.delegation.max_days")).toBe(true);
      // The counts this table was written against: a collapse means the walker stopped descending.
      expect(keys.size).toBeGreaterThanOrEqual(shape === "cli" ? 23 : 19);
      // Every option of every enum leaf under a gated root is in some probe. A
      // pool's leaves are left out: the pool is one probe key, refused
      // whatever it holds.
      const seen = new Map<string, Set<string>>();
      for (const probes of Object.values(PROBES[shape])) {
        for (const probe of probes) {
          for (const [path, value] of probeLeaves(probe)) {
            const options = seen.get(path) ?? new Set<string>();
            options.add(String(value));
            seen.set(path, options);
          }
        }
      }
      const unprobed: string[] = [];
      for (const [leaf, options] of enums) {
        if (probeKeyOf(leaf.split("."))?.endsWith("model_pool") === true) continue;
        const probedLeaf = seen.get(leaf);
        for (const option of options) {
          if (!probedLeaf?.has(option)) unprobed.push(`${leaf}=${option}`);
        }
      }
      expect(unprobed).toEqual([]);
      expect(enums.size).toBeGreaterThan(5);
    }
  });

  test("both entry points build the base worker, and agree on it", async () => {
    for (const shape of CF_WORKER_EMIT_TARGETS) {
      const yaml = JSON.stringify(BASES[shape]);
      const cli = viaCli(yaml);
      const hosted = await viaHosted(yaml);
      expect("worker" in cli && cli.worker.length > 0).toBe(true);
      expect(hosted).toEqual(cli);
    }
  });

  test("each probe does what the gate's tables say, the same way through both entry points", async () => {
    const refusedPins = new Set<string>();
    const constructionKeys = new Set<string>();
    const enforcedHit = new Set<string>();
    const reasonHit = new Set<string>();
    const wrong: string[] = [];
    let probes = 0;
    for (const shape of CF_WORKER_EMIT_TARGETS) {
      const base = viaCli(JSON.stringify(BASES[shape]));
      if (!("worker" in base)) throw new Error(`${shape}: the base spec was refused`);
      for (const [key, values] of Object.entries(PROBES[shape])) {
        for (const probe of values) {
          probes += 1;
          const yaml = JSON.stringify(overlay(BASES[shape], probe));
          const cli = viaCli(yaml);
          const hosted = await viaHosted(yaml);
          const label = `${shape} ${key} ${JSON.stringify(probe)}`;
          if (JSON.stringify(hosted) !== JSON.stringify(cli))
            wrong.push(`${label}: the paths disagree`);
          const want = expected(key, probe);
          if (CF_WORKER_ENFORCED_KEYS.some((r) => r.path === key)) enforcedHit.add(key);
          if (want.kind === "refused") {
            if (!("refused" in cli)) wrong.push(`${label}: built, should be refused`);
            else if (!cli.refused.split("\n").includes(want.line)) {
              wrong.push(`${label}: refused without the line ${JSON.stringify(want.line)}`);
            }
            refusedPins.add(want.pinned);
            if (want.pinned in CF_WORKER_REFUSAL_REASONS) reasonHit.add(want.pinned);
            continue;
          }
          if (!("worker" in cli)) {
            wrong.push(`${label}: refused (${cli.refused}), should build`);
            continue;
          }
          const changed = cli.worker !== base.worker;
          if (want.kind === "changed" && !changed)
            wrong.push(`${label}: a config row left worker.js the same`);
          if (want.kind === "construction") {
            constructionKeys.add(key);
            if (changed) wrong.push(`${label}: a construction row changed worker.js`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(probes).toBeGreaterThan(80);
    // The decisions, pinned: what is refused, and what is enforced by construction.
    expect([...refusedPins].sort()).toEqual(
      [
        "agent.model_pool",
        "agent.rate_limits",
        "budget",
        "hooks",
        "limits.loop_detection.escalation: justify",
        "limits.model_call_timeout_ms",
        "limits.turn_timeout_ms",
        "nodes.*.model_pool",
        "security.egressMatcher",
        "security.justification",
        "steps.*.model_pool",
      ].sort(),
    );
    expect([...constructionKeys].sort()).toEqual([
      "limits.max_concurrent_tools",
      "permissions.ask_mode",
      "permissions.delegation.max_days",
    ]);
    // No dead rows: each allow-list row and each reason row was reached on some shape.
    expect(CF_WORKER_ENFORCED_KEYS.map((r) => r.path).filter((p) => !enforcedHit.has(p))).toEqual(
      [],
    );
    expect(Object.keys(CF_WORKER_REFUSAL_REASONS).filter((p) => !reasonHit.has(p))).toEqual([]);
  }, 30_000); // about ninety probes, each compiled twice; slow on a loaded CI runner

  test("one refusal names every refused path on its own line, in walk order, and the remedy", async () => {
    const yaml = JSON.stringify(
      overlay(BASES.cli, {
        hooks: [{ event: "pre-tool", command: "exit 2" }],
        budget: { usd: 1 },
        limits: { turn_timeout_ms: 1000 },
      }),
    );
    const message = [
      "cf-worker target cannot enforce 3 safety setting(s) this spec declares:",
      `  hooks: ${CF_WORKER_REFUSAL_REASONS["hooks"]}`,
      `  limits.turn_timeout_ms: ${CF_WORKER_REFUSAL_REASONS["limits.turn_timeout_ms"]}`,
      `  budget: ${CF_WORKER_REFUSAL_REASONS["budget"]}`,
      "Remove them, or keep them in a spec you compile without --emit-as cf-worker.",
    ].join("\n");
    expect(viaCli(yaml)).toEqual({ refused: message });
    expect(await viaHosted(yaml)).toEqual({ refused: message });
  });
});

describe("cf-worker edge: the hosted compile returns the permission-rule findings the CLI prints", () => {
  type Warning = { code: string; path: string; message: string };

  /** The `permission-rule*` warnings of a hosted edge compile. */
  async function hostedRuleFindings(yaml: string): Promise<Warning[]> {
    const res = await compilerWorker.fetch(
      new Request("https://cw.test/compile", {
        method: "POST",
        body: JSON.stringify({ yaml, emitAs: "cf-worker" }),
      }),
      { ALLOWED_ORIGINS: "http://localhost:4322" },
    );
    const body = (await res.json()) as { bundle?: { warnings?: Warning[] }; error?: unknown };
    expect(`${res.status} ${JSON.stringify(body.error ?? null)}`).toBe("200 null");
    return (body.bundle?.warnings ?? []).filter((w) => w.code.startsWith("permission-rule"));
  }

  const BASE = `name: parity
target: cli
agent:
  model: claude-haiku-4-5
  instructions: Answer briefly.
tools: [webFetch, webSearch]
`;
  /** The base spec with `rules` as its permissions.rules, and `agent` lines added under agent:. */
  const spec = (rules: ReadonlyArray<string>, agent = "") =>
    `${BASE.replace("  instructions: Answer briefly.\n", `  instructions: Answer briefly.\n${agent}`)}permissions:\n  rules:\n${rules.map((r) => `    - ${r}\n`).join("")}`;
  const ALLOW_ALL = '{ type: alwaysAllow, pattern: "*" }';
  const SUB_AGENT = `  sub_agents:
    helper:
      description: d
      instructions: help
      tools: [WebFetch]
      permissions:
        allow: [WebFetch]
        deny: ['WebFetch(https://evil.example/**)']
`;

  const LISTS: ReadonlyArray<{
    readonly label: string;
    readonly yaml: string;
    readonly clean?: true;
  }> = [
    {
      label: "a spec key where the name belongs",
      yaml: spec([ALLOW_ALL, "{ type: alwaysDeny, pattern: webFetch }"]),
    },
    {
      label: "a near-miss tool name",
      yaml: spec([ALLOW_ALL, "{ type: alwaysDeny, pattern: WebFech }"]),
    },
    {
      label: "an MCP server the spec does not declare",
      yaml: spec([ALLOW_ALL, '{ type: alwaysDeny, pattern: "mcp__github__*" }']),
    },
    {
      label: "a deny below an allow in a sub-agent's list",
      yaml: spec(
        ["{ type: alwaysAllow, pattern: WebFetch }", "{ type: alwaysAllow, pattern: WebSearch }"],
        SUB_AGENT,
      ),
    },
    {
      label: "a clean list",
      yaml: spec([
        "{ type: alwaysAllow, pattern: WebFetch }",
        '{ type: alwaysDeny, pattern: "WebFetch(https://evil.example/**)" }',
        "{ type: alwaysAllow, pattern: WebSearch }",
      ]),
      clean: true,
    },
  ];

  test("over five rule lists the hosted findings equal the CLI's edge reading with its live tools", async () => {
    let compared = 0;
    for (const { label, yaml, clean } of LISTS) {
      const hosted = await hostedRuleFindings(yaml);
      const cli = await permissionRuleWarnings(
        yaml,
        () => loadBuiltinTools(CLI_RUNTIME_TOOL_KEYS),
        { edge: true },
      );
      expect(`${label}: ${JSON.stringify(hosted)}`).toBe(`${label}: ${JSON.stringify(cli)}`);
      // Not vacuous: the clean list says nothing, and every other list says something.
      if (clean === true) expect(`${label}: ${cli.length}`).toBe(`${label}: 0`);
      else expect(cli.length).toBeGreaterThan(0);
      compared += 1;
    }
    expect(compared).toBe(5);
  }, 20_000); // the CLI's loader imports every builtin tool package the cli shape carries
});

// The edge gate reads `alwaysDeny T(**)` and `alwaysAsk T(**)` as covering
// every call of an edge tool that declares operative fields. That holds while
// each such tool requires every operative field, refuses an empty one, and is
// never allowed under a `T(**)` deny or ask, whatever value a call carries.
describe("every edge tool with operative fields carries a value on every call", () => {
  /** A valid input for each edge tool that declares operative fields. */
  const SAMPLES: Readonly<Record<string, Record<string, unknown>>> = {
    fetch: { url: "https://example.com/a" },
    webFetch: { url: "https://example.com/a" },
    webSearch: { query: "q" },
  };
  /** Values each operative field is probed with, beside the sample's own. */
  const PROBES = [" ", "*", "/", "x".repeat(5000), "https://evil.example.net/x?y=1#z"];

  /** The refusal's reason, read after its `ok: false` is asserted. */
  const refusalOf = (subject: ReturnType<typeof preparePermissionSubject>): string =>
    subject.ok ? "" : subject.reason;

  test("each operative field is required and non-empty, and a T(**) deny or ask decides every call", async () => {
    const live = await loadBuiltinTools(CLI_RUNTIME_TOOL_KEYS);
    let checked = 0;
    let reasons = 0;
    for (const key of [...EDGE_SAFE_TOOLS].sort()) {
      const manifest = TOOL_FLAGS[key];
      expect(manifest, key).toBeDefined();
      const declared = (manifest?.operativeArgs ?? []).map((a) => a.field);
      if (declared.length === 0) continue;
      const tool = live[key];
      if (tool === undefined) throw new Error(`no live tool for the edge tool ${key}`);
      expect(
        (tool.operativeArgs ?? []).map((a) => a.field),
        key,
      ).toEqual(declared);
      const sample = SAMPLES[key];
      if (sample === undefined) throw new Error(`no valid sample input for the edge tool ${key}`);
      expect(preparePermissionSubject(tool, sample).ok, key).toBe(true);
      const accepted: unknown[] = [sample];
      // The tool's own input check refuses, naming the tool and the rule broken:
      // a refusal for any other reason (a timeout, a crash) is not this guarantee.
      const clause = `invalid input for tool "${tool.name}"`;
      for (const field of declared) {
        const { [field]: _dropped, ...without } = sample;
        const missing = preparePermissionSubject(tool, without);
        expect(missing.ok, `${key} without ${field}`).toBe(false);
        expect(refusalOf(missing), `${key} without ${field}`).toContain(clause);
        expect(refusalOf(missing), `${key} without ${field}`).toContain("Required");
        reasons += 1;
        const empty = preparePermissionSubject(tool, { ...sample, [field]: "" });
        expect(empty.ok, `${key} ${field}: ""`).toBe(false);
        expect(refusalOf(empty), `${key} ${field}: ""`).toContain(clause);
        expect(refusalOf(empty), `${key} ${field}: ""`).toContain("at least 1 character");
        reasons += 1;
        for (const value of PROBES) {
          const input = { ...sample, [field]: value };
          if (preparePermissionSubject(tool, input).ok) accepted.push(input);
        }
      }
      for (const guard of ["alwaysDeny", "alwaysAsk"] as const) {
        const permissions = {
          rules: [
            { type: "alwaysAllow" as const, pattern: tool.name },
            { type: guard, pattern: `${tool.name}(**)` },
          ],
        };
        for (const input of accepted) {
          const subject = preparePermissionSubject(tool, input);
          if (!subject.ok) throw new Error(`${key}: an accepted probe was refused`);
          const verdict = decideWorkerToolCall(
            {
              toolName: tool.name,
              input: subject.input,
              ...(subject.operativeValues !== undefined
                ? { operativeValues: subject.operativeValues }
                : {}),
              readOnly: tool.readOnly ?? false,
              requiresSandbox: tool.requiresSandbox ?? false,
              requireJustification: tool.requireJustification ?? false,
            },
            permissions,
          );
          expect(
            `${key} ${guard} ${JSON.stringify(input).slice(0, 80)}: ${verdict.decision}`,
          ).not.toEndWith(": allow");
        }
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    // fetch, webFetch and webSearch: one operative field each, two refusals each.
    expect(reasons).toBe(6);
  }, 20_000); // the CLI's loader imports every builtin tool package the cli shape carries
});
