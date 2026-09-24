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
 *  - a deny on a read-only tool in plan mode                 (permission-integration#6)
 *  - an input the schema rejects                             (parse-then-act)
 *  - approval replay re-checked on the canonical call
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import {
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { createPendingApprovalStore, hashApprovalInput } from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop } from "./index";

type Call = { readonly name: string; readonly input: unknown };

/** One tool_use, then "done". */
function adapterFor(call: Call): ProviderAdapter {
  let i = 0;
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
    stream: (_req: ProviderRequest) => {
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
const TOOLS: RegisteredTool[] = [writeTool, removePath, gitBranchDelete, envUpsert, paginate];

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

describe("an input the schema rejects is denied before any rule or approval", () => {
  test("denied with the schema's message, in every mode", async () => {
    for (const mode of [...MODES, "bypass" as const]) {
      ran = [];
      const r = await run(
        { name: "Write", input: { path: 5, content: "x" } },
        rules(["alwaysAllow", "Write"]),
        mode,
      );
      expect({ mode, ran: r.ran, decision: r.decision }).toEqual({
        mode,
        ran: false,
        decision: "deny",
      });
      expect(r.reason).toMatch(/^invalid input for tool "Write": Expected string, received number/);
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
