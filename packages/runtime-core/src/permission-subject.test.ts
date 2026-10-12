/**
 * 0.7.1 — every bypass the audit found, end to end through runChatLoop.
 *
 * Each case runs the model's call through the real permission gate in
 * default, auto and plan mode and asserts what matters: did the tool RUN, and
 * what did the gate say. The tools are built the way the real ones are (same
 * schema shapes; `Write` declares its `path` like tool-fs does, `RemovePath`
 * and `GitBranchDelete` declare nothing, like the 0.7.0 builtins), so the test
 * exercises both the declared path and the fallback.
 *
 *  - decoy `file_path` next to the `path` the tool reads   (security-1#0, flag-truth-1#0)
 *  - an extra string argument in front of a scoped deny/ask  (permission-integration#0, flag-truth-4#0, security-8#0)
 *  - a left-out field the tool fills with a default          (permission-integration#0)
 *  - `..` traversal and a symlinked directory                (permission-integration#1)
 *  - `..` in a path read from a symlinked working directory   (critic7, 0.7.1)
 *  - a deny on a read-only tool in plan mode                 (permission-integration#6)
 *  - an input the schema rejects                             (parse-then-act)
 *  - approval replay re-checked on the canonical call
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import {
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import {
  type PendingApproval,
  createPendingApprovalStore,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { REPLAYABLE_GRANT_MAX_AGE_MS, runChatLoop } from "./index";

type Call = { readonly name: string; readonly input: unknown };

/** Every request the last adapter saw, so a test can read the tool_result it sent back. */
let requests: ProviderRequest[] = [];

/** One tool_use, then "done". */
function adapterFor(call: Call): ProviderAdapter {
  let i = 0;
  requests = [];
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req: ProviderRequest) => {
      requests.push(req);
      const first = i === 0;
      i++;
      return (async function* () {
        yield { kind: "message_start" } as const;
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: call.name, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
        }
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: first ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

// Tools shaped like the real ones. `ran` records what each execute received.
let ran: Array<{ tool: string; input: unknown }> = [];
const record = (tool: string) => async (input: unknown) => {
  ran.push({ tool, input });
  return "ok";
};

const writeTool = buildTool({
  name: "Write",
  description: "tool-fs Write's shape",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  destructive: true,
  operativeArgs: [{ field: "path", kind: "path" }],
  execute: record("Write"),
});
const removePath = buildTool({
  name: "RemovePath",
  description: "an undeclared 0.7.0 builtin's shape",
  inputSchema: z.object({ path: z.string(), recursive: z.boolean().optional() }),
  destructive: true,
  execute: record("RemovePath"),
});
const gitBranchDelete = buildTool({
  name: "GitBranchDelete",
  description: "an undeclared 0.7.0 builtin's shape",
  inputSchema: z.object({
    name: z.string(),
    force: z.boolean().optional(),
    cwd: z.string().optional(),
  }),
  destructive: true,
  execute: record("GitBranchDelete"),
});
const envUpsert = buildTool({
  name: "EnvUpsert",
  description: "fills `path` with .env in execute, like EnvFileUpsert",
  inputSchema: z.object({
    path: z.string().optional(),
    entries: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  destructive: true,
  operativeArgs: [{ field: "path", kind: "path", default: ".env" }],
  execute: record("EnvUpsert"),
});
const paginate = buildTool({
  name: "HttpPaginate",
  description: "a read-only egress tool",
  inputSchema: z.object({ url: z.string(), style: z.string().optional() }),
  readOnly: true,
  scope: "external",
  execute: record("HttpPaginate"),
});
/**
 * tool-code Format's shape: `paths` declared `within` its `cwd`, each handed
 * AS WRITTEN to a program run in the real directory. The program here is the
 * kernel itself: the path is appended to by string, never `path.join`ed, so
 * a link on the way is followed before the `..` after it, as a formatter's
 * own open() does. `touched` is what the call really changed.
 */
const formatLike = buildTool({
  name: "Format",
  description: "tool-code Format's shape",
  inputSchema: z.object({ cwd: z.string().optional(), paths: z.array(z.string()).optional() }),
  destructive: true,
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: ".", beneath: "all" }],
  execute: async (input: { cwd?: string; paths?: string[] }) => {
    ran.push({ tool: "Format", input });
    const dir = realpathSync(input.cwd ?? ".");
    for (const p of input.paths ?? []) appendFileSync(isAbsolute(p) ? p : `${dir}/${p}`, "//\n");
    return "ok";
  },
});
const TOOLS: RegisteredTool[] = [
  writeTool,
  removePath,
  gitBranchDelete,
  envUpsert,
  paginate,
  formatLike,
];

const rules = (...list: Array<[PermissionRule["type"], string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
});

let ws: string;
let cwd: string;
let root: string;
beforeEach(() => {
  ran = [];
  cwd = process.cwd();
  ws = realpathSync(mkdtempSync(join(tmpdir(), "perm-e2e-ws-")));
  root = mkdtempSync(join(tmpdir(), "perm-e2e-state-"));
  mkdirSync(join(ws, "src"));
  mkdirSync(join(ws, "build"));
  mkdirSync(join(ws, ".crewhaus"));
  symlinkSync("../src", join(ws, "build", "link"));
  process.chdir(ws);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(ws, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function run(
  call: Call,
  ruleSet: RuleSet,
  mode: PermissionMode,
): Promise<{ ran: boolean; decision: string | undefined; reason: string | undefined }> {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  await runChatLoop({
    model: "test-model",
    instructions: "permission e2e",
    runContext,
    sessionRootDir: mkdtempSync(join(root, "sess-")),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: mode,
    permissionRules: ruleSet,
    tools: TOOLS,
    _adapter: adapterFor(call),
  });
  const first = events.find((e) => e.kind === "permission_decision" && e.toolName === call.name);
  const decision = first?.kind === "permission_decision" ? first.decision : undefined;
  const reason = first?.kind === "permission_decision" ? first.reason : undefined;
  return { ran: ran.length > 0, decision, reason };
}

const MODES: readonly PermissionMode[] = ["default", "auto", "plan"];

/** For each mode, the call must NOT run, and the gate's first word must be one of `want`. */
async function expectBlocked(call: Call, ruleSet: RuleSet, want: Record<PermissionMode, string>) {
  for (const mode of MODES) {
    ran = [];
    const r = await run(call, ruleSet, mode);
    expect({ mode, ran: r.ran, decision: r.decision }).toEqual({
      mode,
      ran: false,
      decision: want[mode],
    });
  }
}

async function expectRuns(call: Call, ruleSet: RuleSet, modes: readonly PermissionMode[]) {
  for (const mode of modes) {
    ran = [];
    const r = await run(call, ruleSet, mode);
    expect({ mode, ran: r.ran, decision: r.decision }).toEqual({
      mode,
      ran: true,
      decision: "allow",
    });
  }
}

describe("decoy file_path next to the path the tool reads (security-1#0, flag-truth-1#0)", () => {
  const allowSrc = rules(["alwaysAllow", "Write(src/**)"]);
  test("allow: the decoy does not authorise the real path", async () => {
    await expectBlocked(
      {
        name: "Write",
        input: { file_path: "src/ok.ts", path: ".crewhaus/settings.json", content: "{}" },
      },
      allowSrc,
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
  test("control: the in-scope call runs, and the tool never sees the decoy key", async () => {
    await expectRuns(
      { name: "Write", input: { path: "src/ok.ts", content: "x", file_path: "x" } },
      allowSrc,
      ["default", "auto"],
    );
    expect(ran[0]?.input).toEqual({ path: "src/ok.ts", content: "x" });
  });
  test("deny: a guard on the real path fires whatever the decoy says", async () => {
    await expectBlocked(
      {
        name: "Write",
        input: { file_path: "src/ok.ts", path: ".crewhaus/settings.json", content: "{}" },
      },
      rules(["alwaysDeny", "Write(.crewhaus/**)"], ["alwaysAllow", "Write"]),
      { default: "deny", auto: "deny", plan: "deny" },
    );
  });
});

describe("an extra argument in front of a scoped deny/ask (permission-integration#0, flag-truth-4#0, security-8#0)", () => {
  test("deny: an extra string the schema strips does not dodge it", async () => {
    await expectBlocked(
      { name: "RemovePath", input: { path: ".git/hooks", recursive: true, reason: "cleanup" } },
      rules(["alwaysDeny", "RemovePath(.git/**)"], ["alwaysAllow", "RemovePath"]),
      { default: "deny", auto: "deny", plan: "deny" },
    );
  });
  test("ask: an extra declared string does not dodge it", async () => {
    await expectBlocked(
      { name: "GitBranchDelete", input: { name: "main", force: true, cwd: "." } },
      rules(["alwaysAsk", "GitBranchDelete(main)"], ["alwaysAllow", "GitBranchDelete"]),
      // No approvals store and no REPL: an ask on this surface is a denial,
      // but the gate's own answer is `ask`.
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
  test("control: the bare allow still grants an unguarded call", async () => {
    await expectRuns(
      { name: "RemovePath", input: { path: "build/out", reason: "tidy" } },
      rules(["alwaysDeny", "RemovePath(.git/**)"], ["alwaysAllow", "RemovePath"]),
      ["default", "auto"],
    );
  });
});

describe("a left-out field the tool fills with a default (permission-integration#0)", () => {
  const denyEnv = rules(["alwaysDeny", "EnvUpsert(.env)"], ["alwaysAllow", "EnvUpsert"]);
  test("deny: omitting the path does not dodge a deny on the default", async () => {
    await expectBlocked(
      { name: "EnvUpsert", input: { entries: [{ key: "API_KEY", value: "attacker" }] } },
      denyEnv,
      { default: "deny", auto: "deny", plan: "deny" },
    );
  });
  test("allow: a scoped allow does not cover the default either", async () => {
    await expectBlocked(
      { name: "EnvUpsert", input: { entries: [{ key: "K", value: "v" }] } },
      rules(["alwaysAllow", "EnvUpsert(config/**)"]),
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
  test("control: an explicit, in-scope path runs", async () => {
    await expectRuns(
      { name: "EnvUpsert", input: { path: "config/app.env", entries: [{ key: "K", value: "v" }] } },
      denyEnv,
      ["default", "auto"],
    );
  });
});

describe("`..` traversal and symlinked directories (permission-integration#1)", () => {
  test("allow: src/../ does not stay inside src/**", async () => {
    await expectBlocked(
      { name: "Write", input: { path: "src/../.crewhaus/settings.json", content: "{}" } },
      rules(["alwaysAllow", "Write(src/**)"]),
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
  test("deny: src/../.crewhaus is still .crewhaus", async () => {
    await expectBlocked(
      { name: "Write", input: { path: "src/../.crewhaus/settings.json", content: "{}" } },
      rules(["alwaysDeny", "Write(.crewhaus/**)"], ["alwaysAllow", "Write"]),
      { default: "deny", auto: "deny", plan: "deny" },
    );
  });
  test("allow: build/link/ lands in src/, which build/** does not cover", async () => {
    await expectBlocked(
      { name: "Write", input: { path: "build/link/app.ts", content: "x" } },
      rules(["alwaysAllow", "Write(build/**)"]),
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
  test("deny: a guard on src/** catches a write through the link", async () => {
    await expectBlocked(
      { name: "Write", input: { path: "build/link/app.ts", content: "x" } },
      rules(["alwaysDeny", "Write(src/**)"], ["alwaysAllow", "Write"]),
      { default: "deny", auto: "deny", plan: "deny" },
    );
  });
  test("ask: a path out of the workspace always meets a scoped ask", async () => {
    await expectBlocked(
      { name: "Write", input: { path: "../outside.txt", content: "x" } },
      rules(["alwaysAsk", "Write(.git/**)"], ["alwaysAllow", "Write"]),
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
  test("undeclared tool: an allow never matches a `..` segment", async () => {
    await expectBlocked(
      { name: "RemovePath", input: { path: "build/../src", recursive: true } },
      rules(["alwaysAllow", "RemovePath(build/**)"]),
      { default: "ask", auto: "ask", plan: "deny" },
    );
  });
});

describe("`..` in a path read from a symlinked working directory (critic7)", () => {
  // `link -> secrets/deep`, an ordinary workspace link
  // `node_modules/@acme/pkg -> ../../packages/pkg`, and `src/lnk ->
  // ../secrets/deep`. The gate collapsed `..` before following a link; the
  // program the tool runs follows the link first. So `../x.ts` in `link` was
  // `x.ts` to every rule and `secrets/x.ts` on disk.
  const SECRET = "export const key = 1;\n";
  beforeEach(() => {
    mkdirSync(join(ws, "secrets", "deep"), { recursive: true });
    mkdirSync(join(ws, "packages", "pkg"), { recursive: true });
    mkdirSync(join(ws, "node_modules", "@acme"), { recursive: true });
    writeFileSync(join(ws, "secrets", "x.ts"), SECRET);
    writeFileSync(join(ws, "x.ts"), "export const harmless = 1;\n");
    writeFileSync(join(ws, "src", "x.ts"), "export const app = 1;\n");
    symlinkSync("secrets/deep", join(ws, "link"));
    symlinkSync("../../packages/pkg", join(ws, "node_modules", "@acme", "pkg"));
    symlinkSync("../secrets/deep", join(ws, "src", "lnk"));
  });
  const secretUntouched = () => readFileSync(join(ws, "secrets", "x.ts"), "utf8") === SECRET;
  const denySecrets = rules(["alwaysDeny", "Format(secrets/**)"], ["alwaysAllow", "Format"]);

  test("deny: a guard on the real place fires, and the program never runs", async () => {
    for (const input of [
      { cwd: "link", paths: ["../x.ts"] },
      { cwd: "node_modules/@acme/pkg", paths: ["../../secrets/x.ts"] },
      { paths: ["link/../x.ts"] },
      { cwd: "src", paths: ["lnk/../x.ts"] },
    ]) {
      await expectBlocked({ name: "Format", input }, denySecrets, {
        default: "deny",
        auto: "deny",
        plan: "deny",
      });
      expect({ input, secretUntouched: secretUntouched() }).toEqual({
        input,
        secretUntouched: true,
      });
    }
  }, 30_000);

  test("allow: a rule about another place does not grant it", async () => {
    for (const [input, allow] of [
      [{ cwd: "link", paths: ["../x.ts"] }, "Format(x.ts)"],
      [{ cwd: "node_modules/@acme/pkg", paths: ["../../secrets/x.ts"] }, "Format(node_modules/**)"],
      [{ cwd: "src", paths: ["lnk/../x.ts"] }, "Format(src/**)"],
    ] as const) {
      await expectBlocked({ name: "Format", input }, rules(["alwaysAllow", allow]), {
        default: "ask",
        auto: "ask",
        plan: "deny",
      });
      expect({ input, secretUntouched: secretUntouched() }).toEqual({
        input,
        secretUntouched: true,
      });
    }
  }, 30_000);

  test("an absolute path is decided as outside, whatever directory it is given with", async () => {
    await expectBlocked(
      { name: "Format", input: { cwd: "src", paths: [join(ws, "secrets", "x.ts")] } },
      rules(["alwaysAllow", "Format(src/**)"], ["alwaysAllow", "Format(secrets/**)"]),
      { default: "ask", auto: "ask", plan: "deny" },
    );
    expect(secretUntouched()).toBe(true);
  }, 30_000);

  test("control: an ordinary path, through the link or not, is decided where it lands and runs", async () => {
    // Through the link, x.ts IS secrets/deep/x.ts: a deny there fires...
    await expectBlocked({ name: "Format", input: { cwd: "link", paths: ["x.ts"] } }, denySecrets, {
      default: "deny",
      auto: "deny",
      plan: "deny",
    });
    // ...and a scoped allow grants the call it names, which then runs.
    await expectRuns(
      { name: "Format", input: { cwd: "src", paths: ["x.ts"] } },
      rules(["alwaysAllow", "Format(src/**)"]),
      ["default", "auto"],
    );
    expect(readFileSync(join(ws, "src", "x.ts"), "utf8")).toBe("export const app = 1;\n//\n//\n");
    expect(secretUntouched()).toBe(true);
  }, 30_000);
});

describe("plan mode honours a deny on a read-only tool (permission-integration#6)", () => {
  test("the deny wins where plan mode used to allow", async () => {
    const r = await run(
      { name: "HttpPaginate", input: { url: "https://internal.corp/x", style: "page" } },
      rules(["alwaysDeny", "HttpPaginate(https://internal.corp/**)"]),
      "plan",
    );
    expect({ ran: r.ran, decision: r.decision }).toEqual({ ran: false, decision: "deny" });
    expect(r.reason).toBe(
      "plan mode: the rule alwaysDeny HttpPaginate(https://internal.corp/**) (yaml) denies `HttpPaginate`",
    );
  });
  test("control: with no guard, plan mode still allows a read-only tool", async () => {
    await expectRuns(
      { name: "HttpPaginate", input: { url: "https://ok.example/" } },
      emptyRuleSet,
      ["plan"],
    );
  });
});

describe("an input the schema rejects is refused before any rule or approval", () => {
  test("refused with the schema's message, in every mode, and not counted as a denial", async () => {
    for (const mode of [...MODES, "bypass" as const]) {
      ran = [];
      const runContext = createRunContext();
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((e) => events.push(e));
      await runChatLoop({
        model: "test-model",
        instructions: "permission e2e",
        runContext,
        sessionRootDir: mkdtempSync(join(root, "sess-")),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: mode,
        permissionRules: rules(["alwaysAllow", "Write"]),
        tools: TOOLS,
        _adapter: adapterFor({ name: "Write", input: { path: 5, content: "x" } }),
      });
      expect({ mode, ran: ran.length > 0 }).toEqual({ mode, ran: false });
      // No rule was consulted, so there is no permission_decision to count as
      // a deny (eval safety_violations, deny alerts); tool_call_end says it
      // failed, as a malformed call always did.
      expect(events.filter((e) => e.kind === "permission_decision")).toEqual([]);
      const end = events.find((e) => e.kind === "tool_call_end");
      expect(end?.kind === "tool_call_end" ? end.isError : undefined).toBe(true);
      // The model is told why, in the schema's words.
      const sent = JSON.stringify(requests[1]?.messages ?? []);
      expect(sent).toContain(
        'invalid input for tool \\"Write\\": Expected string, received number',
      );
    }
  });
});

describe("approval replay re-checks the CANONICAL approved call", () => {
  test("a grant for build/link/app.ts does not run once src/** is denied", async () => {
    const store = createPendingApprovalStore({ rootDir: join(root, "approvals") });
    const sessionId = "sess_0123456789abcdef";
    const approved = { path: "build/link/app.ts", content: "x" };
    // Park it.
    const park = createRunContext({ sessionId });
    const events: TraceEvent[] = [];
    park.eventBus.subscribe((e) => events.push(e));
    await runChatLoop({
      model: "test-model",
      instructions: "replay",
      runContext: park,
      sessionRootDir: mkdtempSync(join(root, "sess-")),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "default",
      permissionRules: emptyRuleSet,
      tools: TOOLS,
      approvals: { store },
      _adapter: adapterFor({ name: "Write", input: approved }),
    }).catch(() => undefined);
    const parked = await store.get("Write", hashApprovalInput("Write", approved));
    if (parked === null) throw new Error("expected a parked approval");
    await store.resolve(parked.id, "grant", "tester");

    // The operator then denies src/**. The model re-words the call; the
    // replay would run the APPROVED input — which lands in src/.
    const resume = createRunContext({ sessionId });
    const resumeDir = mkdtempSync(join(root, "sess-"));
    let caught: unknown;
    await runChatLoop({
      model: "test-model",
      instructions: "replay",
      runContext: resume,
      sessionRootDir: resumeDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "default",
      permissionRules: rules(["alwaysDeny", "Write(src/**)"]),
      tools: TOOLS,
      approvals: { store },
      _adapter: adapterFor({ name: "Write", input: { path: "notes/new.md", content: "y" } }),
    }).catch((err) => {
      caught = err;
    });
    // It did not park again: the replay found the grant, re-checked the
    // approved input where it lands, and the new deny won.
    expect(caught).toBeUndefined();
    expect(ran).toEqual([]);
    const results = readdirSync(resumeDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(resumeDir, f), "utf-8").split("\n"))
      .filter((line) => line.includes('"tool_result"'));
    expect(results.join("\n")).toContain(
      `approval ${parked.id} was granted, but \`Write\` is now denied by permission policy`,
    );
    // …and the grant is left unspent.
    expect(
      (await store.get("Write", hashApprovalInput("Write", approved)))?.consumedAt,
    ).toBeUndefined();
  });
});

describe("0.7.1 — a headless approval covers the place it was asked for", () => {
  // critic7: a grant was keyed on the input alone. Retarget a symlinked
  // directory between park and resume and the operator's grant wrote
  // wherever the link pointed now — here `secrets/`, which an alwaysAsk rule
  // names. `landed` records where each write PHYSICALLY went.
  let landed: string[] = [];
  const writeWhere = buildTool({
    name: "Write",
    description: "tool-fs Write's shape; records where the parent directory really is",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    destructive: true,
    operativeArgs: [{ field: "path", kind: "path" }],
    execute: async (input: { path: string }) => {
      const dir = realpathSync(join(process.cwd(), input.path, ".."));
      landed.push(`${dir.slice(ws.length + 1)}/${input.path.split("/").pop()}`);
      return "ok";
    },
  });
  const askSecrets = rules(["alwaysAsk", "Write(secrets/**)"]);
  const sessionId = "sess_0123456789abcdef";
  const call = { path: "pub/link/x.md", content: "x" };
  let store: ReturnType<typeof createPendingApprovalStore>;

  beforeEach(() => {
    landed = [];
    mkdirSync(join(ws, "pub"));
    mkdirSync(join(ws, "public"));
    mkdirSync(join(ws, "secrets"));
    symlinkSync("../public", join(ws, "pub", "link"));
    store = createPendingApprovalStore({ rootDir: join(root, "approvals") });
  });
  const retarget = (to: string) => {
    rmSync(join(ws, "pub", "link"));
    symlinkSync(to, join(ws, "pub", "link"));
  };

  /** One headless turn of `input`; what it threw (a park), if anything. */
  async function turn(input: unknown, ruleSet: RuleSet = askSecrets): Promise<RunFailedLike> {
    let caught: RunFailedLike;
    await runChatLoop({
      model: "test-model",
      instructions: "approval places",
      runContext: createRunContext({ sessionId }),
      sessionRootDir: mkdtempSync(join(root, "sess-")),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "default",
      permissionRules: ruleSet,
      tools: [writeWhere],
      approvals: { store },
      _adapter: adapterFor({ name: "Write", input }),
    }).catch((err: RunFailedLike) => {
      caught = err;
    });
    return caught;
  }
  type RunFailedLike = { report?: { class?: string; detail?: string } } | undefined;
  const parkedId = (err: RunFailedLike) =>
    /parked as approval (appr_[0-9a-f]{16})/.exec(err?.report?.detail ?? "")?.[1];

  async function parkAndGrant(input: unknown = call): Promise<string> {
    const park = await turn(input);
    const id = parkedId(park);
    if (id === undefined) throw new Error(`expected a park, got ${JSON.stringify(park)}`);
    await store.resolve(id, "grant", "operator");
    return id;
  }

  test("control: resumed where it was approved, the grant runs the call once", async () => {
    const id = await parkAndGrant();
    const record = (await store.list()).find((a) => a.id === id);
    // The park records where the call lands, for the operator and the resume.
    expect(record?.places).toEqual([{ path: "pub/link/x.md", at: [`${ws}/public/x.md`] }]);
    expect(await turn(call)).toBeUndefined();
    expect(landed).toEqual(["public/x.md"]);
    expect((await store.list()).find((a) => a.id === id)?.consumedAt).toBeDefined();
  });

  test("retargeted between park and resume, the grant is not spent: the call is asked again", async () => {
    const granted = await parkAndGrant();
    retarget("../secrets");
    const again = await turn(call);
    expect(landed).toEqual([]);
    expect(again?.report?.class).toBe("approval_pending");
    const reparked = parkedId(again);
    expect(reparked).toBeDefined();
    expect(reparked).not.toBe(granted);
    // The operator is told where it was approved and where it lands now.
    expect(again?.report?.detail).toContain(
      `approval ${granted} was granted for pub/link/x.md -> ${ws}/public/x.md, and the call now lands at pub/link/x.md -> ${ws}/secrets/x.md, so it is asked again`,
    );
    const all = await store.list();
    expect(all.find((a) => a.id === granted)?.consumedAt).toBeUndefined();
    expect(all.find((a) => a.id === reparked)?.places).toEqual([
      { path: "pub/link/x.md", at: [`${ws}/secrets/x.md`] },
    ]);
    // Granted for the new place, it runs there — once.
    await store.resolve(reparked as string, "grant", "operator");
    expect(await turn(call)).toBeUndefined();
    expect(landed).toEqual(["secrets/x.md"]);
  });

  test("a deny still wins over a moved grant, as before", async () => {
    await parkAndGrant();
    retarget("../secrets");
    expect(await turn(call, rules(["alwaysDeny", "Write(secrets/**)"]))).toBeUndefined();
    expect(landed).toEqual([]);
  });

  test("moved away and back, the original grant is the one spent", async () => {
    const granted = parkedId(await turn(call)) as string;
    // Decided longer ago than #400's replay window reaches, so only the
    // lookup by place can find it once a newer record stands in front.
    const earlier = createPendingApprovalStore({
      rootDir: join(root, "approvals"),
      now: () => new Date(Date.now() - 2 * REPLAYABLE_GRANT_MAX_AGE_MS),
    });
    await earlier.resolve(granted, "grant", "operator");
    retarget("../secrets");
    const away = parkedId(await turn(call));
    expect(away).not.toBe(granted);
    retarget("../public");
    // The newest record (the park for secrets/) is not this place's; the
    // grant made for public/ is.
    expect(await turn(call)).toBeUndefined();
    expect(landed).toEqual(["public/x.md"]);
    const all = await store.list();
    expect(all.find((a) => a.id === granted)?.consumedAt).toBeDefined();
    expect(all.find((a) => a.id === away)?.decision).toBeUndefined();
  });

  test("a park still waiting is re-used only where it was made", async () => {
    const first = parkedId(await turn(call));
    retarget("../secrets");
    const second = parkedId(await turn(call));
    expect(second).not.toBe(first);
    // Still in secrets/: the same park, not a third one.
    expect(parkedId(await turn(call))).toBe(second);
    // Back in public/: the first park again, though the second is newer.
    retarget("../public");
    expect(parkedId(await turn(call))).toBe(first);
    expect((await store.list()).length).toBe(2);
  });

  test("a deny made for another place is not applied: the call is asked again", async () => {
    const first = parkedId(await turn(call));
    await store.resolve(first as string, "deny", "operator");
    retarget("../secrets");
    const again = await turn(call);
    expect(again?.report?.detail).toContain(`approval ${first} was denied for pub/link/x.md`);
    expect(landed).toEqual([]);
  });

  test("a regenerated call does not replay a grant whose input has since moved (#400)", async () => {
    const granted = await parkAndGrant();
    retarget("../secrets");
    // The model re-words the call; the replay would run the APPROVED input,
    // which now lands in secrets/.
    const again = await turn({ path: "pub/link/x.md", content: "reworded" });
    expect(landed).toEqual([]);
    expect(again?.report?.detail).toContain(`approval ${granted} was granted for pub/link/x.md`);
    expect((await store.list()).find((a) => a.id === granted)?.consumedAt).toBeUndefined();
  });

  test("control: a regenerated call still replays a grant that has not moved (#400)", async () => {
    await parkAndGrant();
    expect(await turn({ path: "pub/link/x.md", content: "reworded" })).toBeUndefined();
    expect(landed).toEqual(["public/x.md"]);
  });

  describe("a grant written before approvals were bound (no places)", () => {
    /** Park, grant, then re-write the record the way 0.7.0 did: without places. */
    async function legacyGrant(input: unknown): Promise<string> {
      const id = await parkAndGrant(input);
      const record = (await store.list()).find((a) => a.id === id);
      if (record === undefined) throw new Error("no record");
      const { places: _dropped, ...legacy } = record;
      await store.persist(legacy);
      expect((await store.list()).find((a) => a.id === id)?.places).toBeUndefined();
      return id;
    }

    test("honoured where the input lands as written: no link on the way", async () => {
      await legacyGrant({ path: "public/x.md", content: "x" });
      expect(await turn({ path: "public/x.md", content: "x" })).toBeUndefined();
      expect(landed).toEqual(["public/x.md"]);
    });

    test("asked again when it goes through a link: where it landed was never recorded", async () => {
      const id = await legacyGrant(call);
      const again = await turn(call);
      expect(landed).toEqual([]);
      expect(again?.report?.detail).toContain(
        `approval ${id} was granted for the input as written, and the call now lands at pub/link/x.md -> ${ws}/public/x.md`,
      );
      // Granted again, the new record is bound and runs.
      await store.resolve(parkedId(again) as string, "grant", "operator");
      expect(await turn(call)).toBeUndefined();
      expect(landed).toEqual(["public/x.md"]);
    });
  });

  test("a record whose places are not the shape written covers nothing", async () => {
    const id = await parkAndGrant();
    const record = (await store.list()).find((a) => a.id === id);
    await store.persist({ ...record, places: "public/x.md" } as unknown as PendingApproval);
    const again = await turn(call);
    expect(landed).toEqual([]);
    expect(again?.report?.class).toBe("approval_pending");
  });
});
