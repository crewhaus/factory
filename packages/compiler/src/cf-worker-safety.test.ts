/**
 * The cf-worker edge gate's own rules: what it refuses and why, what it lets
 * through, the notices it returns, and that `cf_worker:` leaves every local
 * build as it was.
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import { Spec, parseSpec } from "@crewhaus/spec";
import { checkBuiltinTool, registeredToolName } from "@crewhaus/tool-categories";
import { TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";
import { decideWorkerToolCall } from "@crewhaus/worker-runtime/permissions";
import { EDGE_SAFE_TOOLS } from "@crewhaus/worker-runtime/tool-policy";
import type { ZodTypeAny } from "zod";
import {
  CF_WORKER_DEFAULT_REFUSAL,
  CF_WORKER_ENFORCED_KEYS,
  CF_WORKER_GATED_ROOTS,
  CF_WORKER_REFUSAL_REASONS,
  type CompileWarning,
  assertCfWorkerSafetyEnforced,
  compile,
  lower,
} from "./index";

const CLI = "name: c\ntarget: cli\nagent: { model: claude-haiku-4-5, instructions: i }\n";
const WORKFLOW =
  "name: w\ntarget: workflow\nmodel: claude-haiku-4-5\nsteps:\n  - { name: one, instructions: go }\n  - { name: two, instructions: on }\n";
const GRAPH =
  "name: g\ntarget: graph\nmodel: claude-haiku-4-5\nentry: a\nnodes:\n  a: { instructions: x }\n  b: { instructions: y }\nedges:\n  - { from: a, to: b }\n";

/** Run the gate over a spec text: the warnings it returns, or the message it throws. */
function gate(yaml: string): {
  readonly warnings?: ReadonlyArray<CompileWarning>;
  readonly refused?: string;
} {
  const spec = parseSpec(yaml);
  return gateSpec(spec, lower(spec));
}

function gateSpec(
  spec: Spec,
  ir: ReturnType<typeof lower>,
): { readonly warnings?: ReadonlyArray<CompileWarning>; readonly refused?: string } {
  try {
    return { warnings: assertCfWorkerSafetyEnforced(spec, ir) };
  } catch (err) {
    expect(err).toBeInstanceOf(CompilerError);
    return { refused: (err as Error).message };
  }
}

const codes = (yaml: string): string[] => (gate(yaml).warnings ?? []).map((w) => w.code);

describe("assertCfWorkerSafetyEnforced — what it refuses", () => {
  test("a key under a gated root that no row admits is refused at the leaf, with the default reason", () => {
    // Keys the schema may gain later: built by hand, since parseSpec refuses them today.
    const parsed = parseSpec(CLI);
    for (const [block, key] of [
      ["limits", { future_ceiling: 3 }],
      ["security", { third_check: { level: "high" } }],
      ["permissions", { delegation: { inherit: true } }],
    ] as const) {
      const spec = { ...parsed, [block]: key } as unknown as Spec;
      const { refused } = gateSpec(spec, lower(parsed));
      const leaf =
        block === "limits"
          ? "limits.future_ceiling"
          : block === "security"
            ? "security.third_check.level"
            : "permissions.delegation.inherit";
      expect(refused).toContain(`  ${leaf}: ${CF_WORKER_DEFAULT_REFUSAL}`);
    }
  });

  test("the message names every refused path once, in walk order, then the remedy", () => {
    const { refused } = gate(
      `${CLI}hooks:\n  - { event: pre-tool, command: "exit 2" }\nbudget: { usd: 1, scope: run }\nlimits: { turn_timeout_ms: 1000, max_tool_iterations: 4 }\n`,
    );
    expect(refused).toBe(
      [
        "cf-worker target cannot enforce 3 safety setting(s) this spec declares:",
        `  hooks: ${CF_WORKER_REFUSAL_REASONS["hooks"]}`,
        `  limits.turn_timeout_ms: ${CF_WORKER_REFUSAL_REASONS["limits.turn_timeout_ms"]}`,
        `  budget: ${CF_WORKER_REFUSAL_REASONS["budget"]}`,
        "Remove them, or keep them in a spec you compile without --emit-as cf-worker.",
      ].join("\n"),
    );
  });

  test("a pool is refused at the agent, step or node that declares it", () => {
    const pool =
      "{ policy: static, candidates: [{ model: claude-haiku-4-5 }, { model: claude-sonnet-4-6 }] }";
    expect(
      gate(`${CLI.replace("instructions: i }", `instructions: i, model_pool: ${pool} }`)}`).refused,
    ).toContain(`  agent.model_pool: ${CF_WORKER_REFUSAL_REASONS["agent.model_pool"]}`);
    const wf = WORKFLOW.replace(
      "{ name: two, instructions: on }",
      `{ name: two, instructions: on, model_pool: ${pool} }`,
    );
    expect(gate(wf).refused).toContain("  steps[1].model_pool: ");
    const gr = GRAPH.replace(
      "b: { instructions: y }",
      `b: { instructions: y, model_pool: ${pool} }`,
    );
    expect(gate(gr).refused).toContain("  nodes.b.model_pool: ");
  });

  test("empty blocks declare nothing and are not refused", () => {
    expect(gate(`${CLI}hooks: []\nlimits: {}\nsecurity: {}\npermissions: { rules: [] }\n`)).toEqual(
      {
        warnings: [],
      },
    );
    expect(
      gate(`${CLI.replace("instructions: i }", "instructions: i, rate_limits: {} }")}`),
    ).toEqual({
      warnings: [],
    });
  });

  test("justify is refused; warn and abort pass", () => {
    expect(gate(`${CLI}limits: { loop_detection: { escalation: justify } }\n`).refused).toContain(
      "  limits.loop_detection.escalation: justify needs the intent gate, which a worker does not run — use warn or abort",
    );
    for (const escalation of ["warn", "abort"]) {
      expect(
        gate(
          `${CLI}limits: { loop_detection: { window: 6, threshold: 3, escalation: ${escalation} } }\n`,
        ),
      ).toEqual({ warnings: [] });
    }
  });

  test("permissions rules of every type, every mode and every ask_mode pass", () => {
    const rules =
      "[{ type: alwaysAllow, pattern: WebFetch }, { type: alwaysDeny, pattern: Fetch }, { type: alwaysAsk, pattern: TodoWrite }]";
    for (const mode of ["default", "plan", "auto"]) {
      for (const askMode of ["pause", "deny"]) {
        const r = gate(
          `${CLI}permissions: { mode: ${mode}, ask_mode: ${askMode}, rules: ${rules} }\n`,
        );
        expect(r.refused).toBeUndefined();
      }
    }
  });
});

describe("assertCfWorkerSafetyEnforced — the notices it returns", () => {
  const withTools = (tools: string, rules = "[]") =>
    `${CLI}tools: ${tools}\npermissions: { rules: ${rules} }\n`;

  const NEEDS_ALLOW =
    "`WebFetch` runs on a Cloudflare Worker only when an alwaysAllow rule covers the call, and none does: every call to it is refused. Add { type: alwaysAllow, pattern: WebFetch } to permissions.rules, or remove the tool";
  /** The notice for a tool every call of which is refused whatever allows it, with the worker's reason. */
  const refusedWhatever = (tool: string, reason: string) =>
    `every call to \`${tool}\` on a Cloudflare Worker is refused, whatever alwaysAllow rule covers it: ${reason}. Remove the tool, or change the setting that refuses it`;
  const DENIES = "an alwaysDeny rule in this worker's permissions denies `WebFetch`";
  const ASKS =
    "an alwaysAsk rule needs a person to approve `WebFetch`, and this worker has nobody to give that approval";

  test("edge-tool-needs-allow is said for a wired tool no alwaysAllow rule's tool half matches", () => {
    for (const rules of [
      "[{ type: alwaysAllow, pattern: WebFetch }]",
      '[{ type: alwaysAllow, pattern: "*" }]',
      '[{ type: alwaysAllow, pattern: "WebFetch(https://a.example/**)" }]',
    ]) {
      expect(codes(withTools("[webFetch]", rules))).toEqual([]);
    }
    for (const rules of ['[{ type: alwaysAllow, pattern: "WebFetch(" }]', "[]"]) {
      const { warnings } = gate(withTools("[webFetch]", rules));
      expect(warnings?.map((w) => [w.code, w.path])).toEqual([["edge-tool-needs-allow", "tools"]]);
      expect(warnings?.[0]?.message).toBe(NEEDS_ALLOW);
    }
  });

  test("edge-tool-needs-allow says every call is refused when a deny or ask with no argument glob covers the tool, in either order", () => {
    for (const [rules, reason] of [
      [
        "[{ type: alwaysAllow, pattern: WebFetch }, { type: alwaysDeny, pattern: WebFetch }]",
        DENIES,
      ],
      [
        "[{ type: alwaysDeny, pattern: WebFetch }, { type: alwaysAllow, pattern: WebFetch }]",
        DENIES,
      ],
      ["[{ type: alwaysDeny, pattern: WebFetch }]", DENIES],
      ['[{ type: alwaysAllow, pattern: "*" }, { type: alwaysDeny, pattern: "Web*" }]', DENIES],
      // A deny whose pattern does not compile reaches every call, on the worker as here.
      [
        '[{ type: alwaysAllow, pattern: WebFetch }, { type: alwaysDeny, pattern: "WebFetch(" }]',
        DENIES,
      ],
      ["[{ type: alwaysAllow, pattern: WebFetch }, { type: alwaysAsk, pattern: WebFetch }]", ASKS],
      ["[{ type: alwaysAsk, pattern: WebFetch }, { type: alwaysAllow, pattern: WebFetch }]", ASKS],
      ["[{ type: alwaysAsk, pattern: WebFetch }]", ASKS],
    ] as const) {
      expect(gate(withTools("[webFetch]", rules))).toEqual({
        warnings: [
          {
            code: "edge-tool-needs-allow",
            path: "tools",
            message: refusedWhatever("WebFetch", reason),
          },
        ],
      });
    }
    // The deny reaches only the tools its pattern names.
    const { warnings } = gate(
      withTools(
        "[webFetch, webSearch, todoWrite]",
        '[{ type: alwaysAllow, pattern: "*" }, { type: alwaysDeny, pattern: "Web*" }]',
      ),
    );
    expect(warnings?.map((w) => w.message.slice(0, w.message.indexOf(" on a")))).toEqual([
      "every call to `WebFetch`",
      "every call to `WebSearch`",
    ]);
  });

  test("a deny or ask with an argument glob reaches only some calls, so the tool is not said to be refused", () => {
    for (const rules of [
      '[{ type: alwaysAllow, pattern: WebFetch }, { type: alwaysDeny, pattern: "WebFetch(https://evil.example/**)" }]',
      '[{ type: alwaysAsk, pattern: "WebFetch(https://evil.example/**)" }, { type: alwaysAllow, pattern: WebFetch }]',
    ]) {
      expect(codes(withTools("[webFetch]", rules))).toEqual([]);
    }
  });

  test("in plan mode a tool that is not read-only is refused on every call, whatever allows it", () => {
    const plan = (tools: string, rules: string) =>
      `${CLI}tools: ${tools}\npermissions: { mode: plan, rules: ${rules} }\n`;
    const NOT_READ_ONLY = "plan mode runs only read-only tools, and `TodoWrite` is not read-only";
    for (const rules of ["[{ type: alwaysAllow, pattern: TodoWrite }]", "[]"]) {
      expect(gate(plan("[todoWrite]", rules))).toEqual({
        warnings: [
          {
            code: "edge-tool-needs-allow",
            path: "tools",
            message: refusedWhatever("TodoWrite", NOT_READ_ONLY),
          },
        ],
      });
    }
    // A read-only tool runs in plan mode when an allow covers it, and needs one.
    expect(codes(plan("[webFetch]", "[{ type: alwaysAllow, pattern: WebFetch }]"))).toEqual([]);
    expect(gate(plan("[webFetch]", "[]")).warnings?.map((w) => w.message)).toEqual([NEEDS_ALLOW]);
  });

  test("a notice that every call is refused holds for every call the worker decides", () => {
    // The worker's own decision, for WebFetch calls to several sites.
    const urls = ["https://a.example/page", "https://evil.example/x", "http://other.example/"];
    const refusesEvery = (
      mode: "default" | "plan" | "auto" | undefined,
      rules: ReadonlyArray<{ type: "alwaysAllow" | "alwaysDeny" | "alwaysAsk"; pattern: string }>,
    ) =>
      urls.every(
        (url) =>
          decideWorkerToolCall(
            {
              toolName: "WebFetch",
              input: { url },
              operativeValues: [{ kind: "url", canonical: [url] }],
              readOnly: true,
              requiresSandbox: false,
              requireJustification: false,
            },
            { ...(mode !== undefined ? { mode } : {}), rules },
          ).decision !== "allow",
      );
    const ruleLists = [
      [],
      [{ type: "alwaysAllow", pattern: "WebFetch" }],
      [{ type: "alwaysAllow", pattern: "WebFetch(https://a.example/**)" }],
      [{ type: "alwaysAllow", pattern: "WebFetch(" }],
      [
        { type: "alwaysAllow", pattern: "WebFetch" },
        { type: "alwaysDeny", pattern: "WebFetch" },
      ],
      [
        { type: "alwaysAllow", pattern: "WebFetch" },
        { type: "alwaysDeny", pattern: "WebFetch(https://evil.example/**)" },
      ],
      [
        { type: "alwaysAsk", pattern: "WebFetch" },
        { type: "alwaysAllow", pattern: "*" },
      ],
      [
        { type: "alwaysAllow", pattern: "*" },
        { type: "alwaysDeny", pattern: "WebFetch(" },
      ],
    ] as const;
    let said = 0;
    let unsaid = 0;
    for (const mode of [undefined, "plan", "auto"] as const) {
      for (const rules of ruleLists) {
        const yaml = `${CLI}tools: [webFetch]\npermissions: ${JSON.stringify({
          ...(mode !== undefined ? { mode } : {}),
          rules,
        })}\n`;
        const noticed = codes(yaml).includes("edge-tool-needs-allow");
        // Said only where the worker refuses every call, and, for these rules, wherever it does.
        expect(`${mode}:${JSON.stringify(rules)}:${noticed}`).toBe(
          `${mode}:${JSON.stringify(rules)}:${refusesEvery(mode, rules)}`,
        );
        if (noticed) said += 1;
        else unsaid += 1;
      }
    }
    expect(said).toBeGreaterThan(0);
    expect(unsaid).toBeGreaterThan(0);
  });

  test("every builtin the worker wires has manifest flags under its registered name", () => {
    let checked = 0;
    for (const key of EDGE_SAFE_TOOLS) {
      if (checkBuiltinTool(key, "cf-worker").kind !== "ok") continue;
      expect(TOOL_FLAGS[key]?.name).toBe(registeredToolName(key) as string);
      checked += 1;
    }
    expect(checked).toBe(EDGE_SAFE_TOOLS.size);
  });

  test("edge-tool-needs-allow is never said for a tool the worker does not wire", () => {
    // gitStatus is a builtin the edge leaves out; the others are not builtins.
    expect(codes(withTools("[gitStatus, myCustomThing, mcp__srv__do]"))).toEqual([]);
  });

  test("edge-tool-needs-allow is said at each step and node that lists the tool", () => {
    const wf = WORKFLOW.replace(
      "{ name: two, instructions: on }",
      "{ name: two, instructions: on, tools: [webFetch] }",
    );
    expect(gate(wf).warnings?.map((w) => w.path)).toEqual(["steps[1].tools"]);
    const gr = GRAPH.replace(
      "a: { instructions: x }",
      "a: { instructions: x, tools: [todoWrite] }",
    );
    expect(gate(gr).warnings?.map((w) => [w.code, w.path])).toEqual([
      ["edge-tool-needs-allow", "nodes.a.tools"],
    ]);
  });

  test("edge-permission-mode is said for mode auto, and only for it", () => {
    expect(codes(`${CLI}permissions: { mode: auto, rules: [] }\n`)).toEqual([
      "edge-permission-mode",
    ]);
    expect(gate(`${CLI}permissions: { mode: auto }\n`).warnings?.[0]).toEqual({
      code: "edge-permission-mode",
      path: "permissions.mode",
      message:
        "a Cloudflare Worker has nobody to ask, so it reads mode auto as default: a tool runs there only when an alwaysAllow rule covers the call",
    });
    for (const mode of ["default", "plan"]) {
      expect(codes(`${CLI}permissions: { mode: ${mode} }\n`)).toEqual([]);
    }
  });

  test("edge-public-chat is said for cf_worker.public_chat: true, and only for it", () => {
    for (const [shape, head] of [
      ["cli", CLI],
      ["workflow", WORKFLOW],
      ["graph", GRAPH],
    ] as const) {
      const { warnings } = gate(`${head}cf_worker: { public_chat: true }\n`);
      expect(`${shape}:${warnings?.map((w) => `${w.code}@${w.path}`).join(",")}`).toBe(
        `${shape}:edge-public-chat@cf_worker.public_chat`,
      );
      expect(codes(`${head}cf_worker: { public_chat: false }\n`)).toEqual([]);
      expect(codes(`${head}cf_worker: {}\n`)).toEqual([]);
    }
  });
});

/** Unwrap the zod wrappers that carry no path segment of their own. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let cur: ZodTypeAny = schema;
  for (;;) {
    const def = cur._def as {
      typeName?: string;
      innerType?: ZodTypeAny;
      schema?: ZodTypeAny;
      type?: ZodTypeAny;
      getter?: () => ZodTypeAny;
      in?: ZodTypeAny;
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
        cur = (def.getter as () => ZodTypeAny)();
        continue;
      case "ZodPipeline":
        cur = def.in as ZodTypeAny;
        continue;
      default:
        return cur;
    }
  }
}

/** Every leaf path of a schema, `*` standing for an array index or a record key. */
function leaves(schema: ZodTypeAny, prefix: string[], out: Set<string>): void {
  const s = unwrap(schema);
  const def = s._def as {
    typeName: string;
    shape?: () => Record<string, ZodTypeAny>;
    type?: ZodTypeAny;
    valueType?: ZodTypeAny;
    options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
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
      leaves(def.type as ZodTypeAny, [...prefix, "*"], out);
      out.add(prefix.join("."));
      return;
    case "ZodRecord":
      leaves(def.valueType as ZodTypeAny, [...prefix, "*"], out);
      return;
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options instanceof Map ? [...def.options.values()] : (def.options ?? []);
      for (const option of options) leaves(option, prefix, out);
      return;
    }
    default:
      if (prefix.length > 0) out.add(prefix.join("."));
  }
}

describe("the gate's tables", () => {
  test("every allow-list row is a leaf of some cf-worker shape's schema", () => {
    const all = new Set<string>();
    for (const shape of Spec.options as ReadonlyArray<ZodTypeAny>) {
      const target = (unwrap(shape)._def as { shape: () => Record<string, ZodTypeAny> }).shape()[
        "target"
      ];
      const literal = (unwrap(target as ZodTypeAny)._def as { value: string }).value;
      if (["cli", "workflow", "graph"].includes(literal)) leaves(shape, [], all);
    }
    expect(all.size).toBeGreaterThan(100);
    const missing = CF_WORKER_ENFORCED_KEYS.map((row) => row.path).filter((path) => !all.has(path));
    expect(missing).toEqual([]);
    // Every row sits under a gated root, so the gate can reach it.
    const outside = CF_WORKER_ENFORCED_KEYS.filter(
      (row) => !CF_WORKER_GATED_ROOTS.some((root) => row.path.startsWith(`${root}.`)),
    );
    expect(outside).toEqual([]);
  });
});

describe("cf_worker: leaves a local build as it was", () => {
  test("compile() of a cli, workflow and graph spec gives the same files with and without the block", () => {
    for (const head of [CLI, WORKFLOW, GRAPH]) {
      const plain = compile(head).files;
      for (const block of [
        "cf_worker: { public_chat: true }\n",
        "cf_worker: { public_chat: false }\n",
      ]) {
        expect(compile(`${head}${block}`).files).toEqual(plain);
      }
    }
    // The block reaches the IR only as `public_chat: true` says it.
    expect(
      (lower(parseSpec(`${CLI}cf_worker: { public_chat: true }\n`)) as { cfWorker?: unknown })
        .cfWorker,
    ).toEqual({
      publicChat: true,
    });
    expect("cfWorker" in lower(parseSpec(`${CLI}cf_worker: { public_chat: false }\n`))).toBe(false);
  }, 20_000); // three local compiles per shape; slow on a loaded CI runner
});
