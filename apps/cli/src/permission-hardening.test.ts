/**
 * 0.7.1 — the audit's permission bypasses, replayed against the REAL builtin
 * tools through the real run loop.
 *
 * runtime-core's own end-to-end test (`permission-subject.test.ts`) proves the
 * gate with tools shaped like these. This one proves it with the shipped
 * tools themselves — their actual schemas and declarations — using the exact
 * calls from the audit's reproduction scripts, and checks the side effect the
 * audit observed (a rewritten `.env`, a deleted file) did not happen.
 *
 * It also holds the guard for the name table: `OPERATIVE_ARG_FIELDS` is now
 * only a fallback for tools that declare nothing, so every builtin that
 * carries one of its names must declare `operativeArgs` itself.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import {
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createPendingApprovalStore, hashApprovalInput } from "@crewhaus/session-store";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { createNavigateTool } from "@crewhaus/tool-navigate";
import { OPERATIVE_ARG_FIELDS } from "@crewhaus/tool-permission-matcher";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { formatApprovalDetail } from "./approvals-cli";

let builtins: ReadonlyMap<string, RegisteredTool>;
beforeAll(async () => {
  const byName = new Map<string, RegisteredTool>();
  for (const entry of Object.values(BUILTIN_TOOL_MAP)) {
    const mod = (await import(entry.package)) as Record<string, unknown>;
    const tool = mod[entry.export] as RegisteredTool | undefined;
    if (tool !== undefined) byName.set(tool.name, tool);
  }
  builtins = byName;
}, 60_000);

function builtin(name: string): RegisteredTool {
  const tool = builtins.get(name);
  if (tool === undefined) throw new Error(`no builtin named ${name}`);
  return tool;
}

describe("the name table is a fallback: every builtin it names declares its own fields", () => {
  test("each builtin whose name is in OPERATIVE_ARG_FIELDS declares operativeArgs", () => {
    const named = [...builtins.values()].filter((t) => Object.hasOwn(OPERATIVE_ARG_FIELDS, t.name));
    // The sweep's own hit count: the table names ten tools, nine of them are
    // compiled-in builtins (Navigate is built per browser session, below).
    expect(named.length).toBe(Object.keys(OPERATIVE_ARG_FIELDS).length - 1);
    expect(named.filter((t) => t.operativeArgs === undefined).map((t) => t.name)).toEqual([]);
  });

  test("Navigate, built per session, declares its url", () => {
    const navigate = createNavigateTool({
      driver: {} as Parameters<typeof createNavigateTool>[0]["driver"],
    });
    expect(navigate.operativeArgs).toEqual([{ field: "url", kind: "url" }]);
  });

  test("every declaration on a builtin passed buildTool's schema check", () => {
    // buildTool throws on a field the schema lacks, so reaching here with the
    // tools loaded is the check; this pins that the loaded set is the real one.
    const declared = [...builtins.values()].filter((t) => t.operativeArgs !== undefined);
    expect(declared.length).toBeGreaterThanOrEqual(11);
    expect(builtins.size).toBeGreaterThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// The audit's reproductions
// ---------------------------------------------------------------------------

function adapterFor(name: string, input: unknown): ProviderAdapter {
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
    stream: (req) => {
      const first = i === 0;
      i++;
      // What the tool handed back to the model, for a test that checks what
      // an allowed call revealed.
      if (!first) lastResult = toolResultText(req.messages);
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: first
            ? { type: "tool_use", id: "tu_1", name, input: {} }
            : { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: first
            ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
            : { type: "text_delta", text: "done" },
        } as const;
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

const rules = (...list: Array<[PermissionRule["type"], string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
});

let ws: string;
let state: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  ws = realpathSync(mkdtempSync(join(tmpdir(), "perm-real-ws-")));
  state = mkdtempSync(join(tmpdir(), "perm-real-state-"));
  mkdirSync(join(ws, "src"));
  mkdirSync(join(ws, "build"));
  mkdirSync(join(ws, ".crewhaus"));
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(join(ws, "src", "app.ts"), "original");
  writeFileSync(join(ws, ".env"), "API_KEY=original\n");
  writeFileSync(join(ws, ".git", "hooks", "pre-commit"), "hook");
  symlinkSync("../src", join(ws, "build", "link"));
  process.chdir(ws);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(ws, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

/** The gate's first decision on the call. */
async function gate(
  name: string,
  input: unknown,
  ruleSet: RuleSet,
  mode: PermissionMode = "default",
): Promise<string | undefined> {
  // The tools resolve a relative path against process.cwd(). A test that
  // outlives its timeout keeps running after afterEach has put the cwd back
  // (to apps/cli) and removed the workspace, so its next call would write
  // `src/new.ts` or `build/link/app.ts` into the checkout itself. Refuse.
  // A test may move into a directory of its own workspace (one whose path
  // holds `prod`, say); anywhere outside it is refused.
  const where = relative(ws, process.cwd());
  if (where.startsWith("..") || isAbsolute(where) || !existsSync(ws)) {
    throw new Error(
      `gate(${name}) outlived its test's workspace; refusing to run tools against ${process.cwd()}`,
    );
  }
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  lastResult = undefined;
  await runChatLoop({
    model: "test-model",
    instructions: "permission hardening",
    runContext,
    sessionRootDir: mkdtempSync(join(state, "sess-")),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: mode,
    permissionRules: ruleSet,
    tools: [builtin(name)],
    _adapter: adapterFor(name, input),
  });
  const first = events.find((e) => e.kind === "permission_decision");
  lastReason = first?.kind === "permission_decision" ? first.reason : undefined;
  return first?.kind === "permission_decision" ? first.decision : undefined;
}

/** The tool result the model was handed on the last {@link gate} call, if the call ran. */
let lastResult: string | undefined;

function toolResultText(
  messages: ReadonlyArray<{ readonly content: unknown }>,
): string | undefined {
  let found: string | undefined;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type?: string; content?: unknown }>) {
      if (block.type !== "tool_result") continue;
      found = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    }
  }
  return found;
}

/**
 * The reason on the last {@link gate}'s decision, where the engine words one
 * (plan mode names the rule). A test that expects a deny from a RULE must
 * show it was the rule: an input the tool's schema rejects never reaches one.
 */
let lastReason: string | undefined;

describe("a gate call that outlives its test never runs a tool in the checkout", () => {
  test("after teardown has restored the cwd, gate() refuses instead of resolving against it", async () => {
    // What afterEach does to a test that timed out while its body runs on.
    process.chdir(cwd);
    let refused: unknown;
    try {
      await gate("Read", { path: "package.json" }, rules(["alwaysAllow", "Read"]));
    } catch (err) {
      refused = err;
    }
    expect(String(refused)).toContain("outlived its test's workspace");
  });
});

describe("p1 — a scoped deny/ask with a bare allow behind it (permission-integration#0)", () => {
  const rs = rules(
    ["alwaysDeny", "HttpRequest(http://169.254.169.254/**)"],
    ["alwaysDeny", "RemovePath(.git/**)"],
    ["alwaysAsk", "GitBranchDelete(main)"],
    ["alwaysAllow", "HttpRequest"],
    ["alwaysAllow", "RemovePath"],
    ["alwaysAllow", "GitBranchDelete"],
  );
  const metadata = "http://169.254.169.254/latest/meta-data/iam";
  const cases: Array<[string, unknown, string]> = [
    ["HttpRequest", { url: metadata }, "deny"],
    ["HttpRequest", { url: metadata, method: "GET" }, "deny"],
    ["HttpRequest", { url: metadata, note: "x" }, "deny"],
    ["RemovePath", { path: ".git/hooks", recursive: true }, "deny"],
    ["RemovePath", { path: ".git/hooks", recursive: true, reason: "cleanup" }, "deny"],
    ["GitBranchDelete", { name: "main", force: true }, "ask"],
    ["GitBranchDelete", { name: "main", force: true, cwd: "." }, "ask"],
  ];
  test("every variant is gated in default, auto and plan mode; .git/hooks survives", async () => {
    for (const [name, input, want] of cases) {
      for (const mode of ["default", "auto", "plan"] as const) {
        const got = await gate(name, input, rs, mode);
        expect({ name, input, mode, got }).toEqual({
          name,
          input,
          mode,
          got: mode === "plan" ? "deny" : want,
        });
      }
    }
    expect(existsSync(join(ws, ".git", "hooks", "pre-commit"))).toBe(true);
  }, 60_000);
});

describe("p14 — leaving out a field the tool fills with a default (permission-integration#0)", () => {
  test("EnvFileUpsert without `path` still meets alwaysDeny EnvFileUpsert(.env); .env is untouched", async () => {
    const rs = rules(["alwaysDeny", "EnvFileUpsert(.env)"], ["alwaysAllow", "EnvFileUpsert"]);
    const omitted = { entries: [{ key: "API_KEY", value: "attacker" }] };
    for (const mode of ["default", "auto", "plan"] as const) {
      expect(await gate("EnvFileUpsert", omitted, rs, mode)).toBe("deny");
    }
    expect(readFileSync(join(ws, ".env"), "utf8")).toBe("API_KEY=original\n");
  });
});

describe("C004 — a store the call leaves out, and a call that names no operative field", () => {
  test("KvDelete without stateDir meets alwaysDeny KvDelete(.crewhaus/state/**); the key survives", async () => {
    const kvSet = builtin("KvSet");
    await kvSet.execute({ namespace: "ns", key: "k", value: "v" });
    const rs = rules(["alwaysDeny", "KvDelete(.crewhaus/state/**)"], ["alwaysAllow", "KvDelete"]);
    for (const mode of ["default", "auto", "plan"] as const) {
      expect({
        mode,
        got: await gate("KvDelete", { namespace: "ns", key: "k" }, rs, mode),
      }).toEqual({ mode, got: "deny" });
    }
    const after = String(await builtin("KvGet").execute({ namespace: "ns", key: "k" }));
    expect(after).toContain('"found":true');
  });

  test("every tool-state writer's default store is read by a deny", async () => {
    const calls: Array<[string, unknown]> = [
      ["KvSet", { namespace: "ns", key: "k", value: 1 }],
      ["NoteWrite", { id: "n1", text: "x" }],
      ["CounterIncrement", { name: "c" }],
      ["BlackboardPost", { topic: "t", author: "a", text: "x" }],
      ["JournalAppend", { stream: "s", entry: {} }],
      ["CheckpointSave", { name: "cp", data: {} }],
      ["DedupeMark", { scope: "s", id: "i" }],
      ["IndexBuild", { name: "ix", paths: ["src/app.ts"] }],
    ];
    for (const [name, input] of calls) {
      const rs = rules(["alwaysDeny", `${name}(.crewhaus/state/**)`], ["alwaysAllow", name]);
      expect({ name, got: await gate(name, input, rs) }).toEqual({ name, got: "deny" });
    }
    expect(existsSync(join(ws, ".crewhaus", "state"))).toBe(false);
  });

  test("an allow on the record still covers the ordinary call, and only that call", async () => {
    const allow = rules(["alwaysAllow", "KvSet(scratch/*)"]);
    // The store is left out: the grant is about the key, and it holds.
    expect(await gate("KvSet", { namespace: "scratch", key: "a", value: 1 }, allow)).toBe("allow");
    // Another namespace, or a store the call points somewhere else, asks.
    expect(await gate("KvSet", { namespace: "prod", key: "a", value: 1 }, allow)).toBe("ask");
    expect(
      await gate(
        "KvSet",
        { namespace: "scratch", key: "a", value: 1, stateDir: "elsewhere" },
        allow,
      ),
    ).toBe("ask");
    // A deny on the key is unaffected by the default beside it.
    const deny = rules(["alwaysDeny", "KvSet(scratch/*)"], ["alwaysAllow", "KvSet"]);
    expect(await gate("KvSet", { namespace: "scratch", key: "a", value: 1 }, deny)).toBe("deny");
  });

  test("a registry, sessions or evals directory left out is read by a deny", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["DeployRollback", ".crewhaus/specs/**", { name: "s", env: "prod", toVersion: "v1" }],
      ["SpecPin", ".crewhaus/specs/**", { name: "s", specFile: "crewhaus.yaml", env: "prod" }],
      ["DatasetPut", ".crewhaus/datasets/**", { name: "golden", samples: [] }],
      ["EvalBaselinePin", ".crewhaus/evals/**", { action: "show", spec: "s", dataset: "d" }],
      ["EmitTraceEvent", ".crewhaus/sessions/**", { name: "deploy_started", sessionId: "s1" }],
      ["ExperimentLedger", ".crewhaus/experiments/**", { action: "tally", name: "e" }],
      ["KnowledgeSync", ".crewhaus-shared/**", { direction: "push" }],
    ];
    for (const [name, glob, input] of cases) {
      const rs = rules(["alwaysDeny", `${name}(${glob})`], ["alwaysAllow", name]);
      const got = await gate(name, input, rs);
      expect({ name, got, reason: lastReason }).toMatchObject({ name, got: "deny" });
    }
  });

  test("a deny on every call is not dodged by leaving every operative field out", async () => {
    const cases: Array<[string, unknown]> = [
      // dir and sessionId omitted: the session log under the default directory
      ["EmitTraceEvent", { name: "deploy_started" }],
      // the destination named through an operator-listed environment variable
      ["WebhookPost", { urlEnv: "HOOK_URL", payload: { a: 1 } }],
      // a listing names no directory, id or source
      ["HarnessRegister", { action: "list" }],
    ];
    for (const [name, input] of cases) {
      const rs = rules(["alwaysDeny", `${name}(**)`], ["alwaysAllow", name]);
      expect({ name, got: await gate(name, input, rs) }).toEqual({ name, got: "deny" });
    }
    // A scoped deny that names a place the call does not reach still does not fire.
    const narrow = rules(
      ["alwaysDeny", "WebhookPost(https://evil.example/**)"],
      ["alwaysAllow", "WebhookPost"],
    );
    expect(await gate("WebhookPost", { urlEnv: "HOOK_URL", payload: { a: 1 } }, narrow)).toBe(
      "allow",
    );
    // Nor is a destination deny set off by a link in the payload: every
    // string must match, as in 0.7.0, not any one.
    const http = rules(["alwaysDeny", "WebhookPost(http://**)"], ["alwaysAllow", "WebhookPost"]);
    const alert = {
      urlEnv: "HOOK_URL",
      payload: { text: "Deploy failed", link: "http://status.internal/incident/42" },
    };
    expect(await gate("WebhookPost", alert, http)).toBe("allow");
  });
});

describe("C004 — the readers beside the store writers read their default store too", () => {
  test("KvGet and EventQuery without a directory meet a deny on the default one", async () => {
    await builtin("KvSet").execute({ namespace: "ns", key: "k", value: "SECRET-IN-STATE" });
    const cases: Array<[string, string, unknown]> = [
      ["KvGet", "*(.crewhaus/state/**)", { namespace: "ns", key: "k" }],
      ["KvGet", "KvGet(.crewhaus/state/**)", { namespace: "ns", key: "k" }],
      ["KvList", "*(.crewhaus/state/**)", { namespace: "ns", includeValues: true }],
      ["StateExport", "*(.crewhaus/state/**)", {}],
      ["EventQuery", "*(.crewhaus/sessions/**)", {}],
      ["TraceQuery", "*(.crewhaus/sessions/**)", {}],
      ["AuditVerify", "*(.crewhaus/audit/**)", {}],
    ];
    for (const [name, deny, input] of cases) {
      for (const mode of ["auto", "plan"] as const) {
        const got = await gate(name, input, rules(["alwaysDeny", deny]), mode);
        expect({ name, deny, mode, got }).toEqual({ name, deny, mode, got: "deny" });
      }
      // In default mode an allow behind the deny does not carry the call past it.
      const withAllow = rules(["alwaysDeny", deny], ["alwaysAllow", name]);
      const got = await gate(name, input, withAllow, "default");
      expect({ name, deny, got }).toEqual({ name, deny, got: "deny" });
    }
  });

  test("an allow on the record still covers the ordinary read, and a listing stands for every record", async () => {
    expect(
      await gate(
        "KvGet",
        { namespace: "scratch", key: "a" },
        rules(["alwaysAllow", "KvGet(scratch/*)"]),
      ),
    ).toBe("allow");
    expect(
      await gate(
        "KvGet",
        { namespace: "prod", key: "a" },
        rules(["alwaysAllow", "KvGet(scratch/*)"]),
      ),
    ).toBe("ask");
    // A listing with no prefix reads every key of the namespace.
    const denyKey = rules(
      ["alwaysDeny", "KvList(prod/api-credentials)"],
      ["alwaysAllow", "KvList"],
    );
    expect(await gate("KvList", { namespace: "prod", includeValues: true }, denyKey)).toBe("deny");
    expect(await gate("KvList", { namespace: "scratch" }, denyKey)).toBe("allow");
  });
});

describe("final review — KvList's prefix stands for every key that starts with it", () => {
  const SECRET = "sk-live-NOT-FOR-THE-MODEL";
  beforeEach(async () => {
    const out = await builtin("KvSet").execute({
      namespace: "secrets",
      key: "apikey",
      value: SECRET,
    });
    expect(String(out)).toContain('"key":"apikey"');
  });

  test("a deny on one key fires on every listing that can return it, in every mode", async () => {
    // The prefix used to be read as one more key: `prefix: ""` (the same
    // unfiltered listing as leaving it out) and `prefix: "api"` met no deny
    // on secrets/apikey, and the listing returned its value.
    for (const mode of ["default", "auto", "plan"] as const) {
      const rs =
        mode === "default"
          ? rules(["alwaysDeny", "Kv*(secrets/apikey)"], ["alwaysAllow", "Kv*"])
          : rules(["alwaysDeny", "Kv*(secrets/apikey)"]);
      for (const prefix of [undefined, "", "a", "api", "apikey"]) {
        const input = {
          namespace: "secrets",
          includeValues: true,
          ...(prefix !== undefined ? { prefix } : {}),
        };
        const got = await gate("KvList", input, rs, mode);
        expect({ mode, prefix, got, leaked: (lastResult ?? "").includes(SECRET) }).toEqual({
          mode,
          prefix,
          got: "deny",
          leaked: false,
        });
      }
      // A listing that cannot return the key is not this rule's business.
      const other = { namespace: "secrets", prefix: "b", includeValues: true };
      expect({ mode, got: await gate("KvList", other, rs, mode) }).toEqual({ mode, got: "allow" });
    }
  }, 60_000);

  test("an allow grants a prefix only when it covers every key the listing can return", async () => {
    const input = { namespace: "secrets", prefix: "api" };
    for (const [pattern, want] of [
      ["KvList(secrets/**)", "allow"],
      ["KvList(secrets/api**)", "allow"],
      // A key may hold `/`, so `*` does not cover every key under a prefix.
      ["KvList(secrets/*)", "ask"],
      // One key is not every key that starts with it.
      ["KvList(secrets/api)", "ask"],
      ["KvList(secrets/apikey)", "ask"],
    ] as const) {
      const got = await gate("KvList", input, rules(["alwaysAllow", pattern]));
      expect({ pattern, got }).toEqual({ pattern, got: want });
    }
  }, 30_000);
});

describe("final review — a directory the tool walks is read with everything beneath it", () => {
  const SECRET = "sk-live-NOT-FOR-THE-MODEL";

  test("Grep: a deny on a directory fires on a search of the whole workspace, in every mode", async () => {
    // The CHANGELOG's advice: keep the bare Grep allow and deny what must
    // stay out. A search with no path, or `.`, walked into secrets/ while
    // the deny read only `.`.
    mkdirSync(join(ws, "secrets"));
    writeFileSync(join(ws, "secrets", "prod.yml"), `api_key: ${SECRET}\n`);
    for (const mode of ["default", "auto", "plan"] as const) {
      const rs =
        mode === "default"
          ? rules(["alwaysDeny", "Grep(secrets/**)"], ["alwaysAllow", "Grep"])
          : rules(["alwaysDeny", "Grep(secrets/**)"]);
      for (const input of [
        { pattern: "api_key" },
        { pattern: "api_key", path: "." },
        { pattern: "api_key", path: "secrets" },
      ]) {
        const got = await gate("Grep", input, rs, mode);
        expect({ mode, input, got, leaked: (lastResult ?? "").includes(SECRET) }).toEqual({
          mode,
          input,
          got: "deny",
          leaked: false,
        });
      }
      // A search that cannot reach secrets/ is not the rule's business.
      const beside = await gate("Grep", { pattern: "api_key", path: "src" }, rs, mode);
      expect({ mode, beside }).toEqual({ mode, beside: "allow" });
    }
  }, 60_000);

  test("Grep: a deny on a hidden file does not stop a search that never opens it", async () => {
    // Grep's walk skips names starting with `.`, so the CHANGELOG's own
    // example, `alwaysDeny Grep(.env)`, leaves the everyday search allowed.
    const rs = rules(["alwaysDeny", "Grep(.env)"], ["alwaysAllow", "Grep"]);
    for (const input of [{ pattern: "API_KEY" }, { pattern: "API_KEY", path: "." }]) {
      expect(await gate("Grep", input, rs)).toBe("allow");
      expect(lastResult ?? "").not.toContain("API_KEY=original");
    }
    expect(await gate("Grep", { pattern: "API_KEY", path: ".env" }, rs)).toBe("deny");
  }, 30_000);

  test("RemovePath: a deny beneath a directory stops removing the directory; a sibling is removed", async () => {
    mkdirSync(join(ws, "src", "prod"));
    mkdirSync(join(ws, "src", "other"));
    writeFileSync(join(ws, "src", "prod", "keep.ts"), "prod");
    writeFileSync(join(ws, "src", "other", "x.ts"), "x");
    for (const mode of ["default", "auto", "plan"] as const) {
      const rs =
        mode === "default"
          ? rules(["alwaysDeny", "RemovePath(src/prod/**)"], ["alwaysAllow", "RemovePath"])
          : rules(["alwaysDeny", "RemovePath(src/prod/**)"]);
      const got = await gate("RemovePath", { path: "src", recursive: true }, rs, mode);
      expect({ mode, got }).toEqual({ mode, got: "deny" });
      expect(existsSync(join(ws, "src", "prod", "keep.ts"))).toBe(true);
    }
    const rs = rules(["alwaysDeny", "RemovePath(src/prod/**)"], ["alwaysAllow", "RemovePath"]);
    expect(await gate("RemovePath", { path: "src/other", recursive: true }, rs)).toBe("allow");
    expect(existsSync(join(ws, "src", "other"))).toBe(false);
    expect(existsSync(join(ws, "src", "prod", "keep.ts"))).toBe(true);
  }, 60_000);

  test("RemovePath: a file has nothing beneath it, so a deny about subtrees leaves it alone", async () => {
    const rs = rules(["alwaysDeny", "RemovePath(**/.git/**)"], ["alwaysAllow", "RemovePath"]);
    expect(await gate("RemovePath", { path: "src/app.ts" }, rs)).toBe("allow");
    expect(existsSync(join(ws, "src", "app.ts"))).toBe(false);
    // A directory may hold a .git of its own, and the gate cannot see inside.
    mkdirSync(join(ws, "vendor"));
    expect(await gate("RemovePath", { path: "vendor", recursive: true }, rs)).toBe("deny");
    expect(existsSync(join(ws, "vendor"))).toBe(true);
  }, 30_000);

  test("Glob: a pattern stands for every path it can list", async () => {
    // `**/*` lists everything under secrets/, and was read as the text
    // `**/*`, which `alwaysDeny Glob(secrets/**)` never matched.
    mkdirSync(join(ws, "secrets"));
    writeFileSync(join(ws, "secrets", "prod.yml"), "x\n");
    for (const mode of ["default", "auto", "plan"] as const) {
      const rs =
        mode === "default"
          ? rules(["alwaysDeny", "Glob(secrets/**)"], ["alwaysAllow", "Glob"])
          : rules(["alwaysDeny", "Glob(secrets/**)"]);
      for (const pattern of ["**/*", "*/prod.yml", "secret*/**", "{secrets,x}/*"]) {
        const got = await gate("Glob", { pattern }, rs, mode);
        expect({ mode, pattern, got, listed: (lastResult ?? "").includes("prod.yml") }).toEqual({
          mode,
          pattern,
          got: "deny",
          listed: false,
        });
      }
      expect({ mode, got: await gate("Glob", { pattern: "src/**/*.ts" }, rs, mode) }).toEqual({
        mode,
        got: "allow",
      });
    }
    // The tool's wildcards never list a hidden name, so a deny on one leaves
    // `**/*` alone. (A hidden name the pattern writes is listed: see below.)
    const env = rules(["alwaysDeny", "Glob(.env)"], ["alwaysAllow", "Glob"]);
    expect(await gate("Glob", { pattern: "**/*" }, env)).toBe("allow");
    // An allow must name every path the pattern can list.
    const src = rules(["alwaysAllow", "Glob(src/*)"]);
    expect(await gate("Glob", { pattern: "src/*.ts" }, src)).toBe("allow");
    expect(await gate("Glob", { pattern: "src/**" }, src)).toBe("ask");
  }, 60_000);

  test("Glob: a hidden name the pattern writes is listed, so a rule reads it", async () => {
    // Closeout review: Bun.Glob lists a literal hidden name in the last
    // segment (`.env`, `*` + `/.deploy-key`), but the matcher read every
    // hidden name as never listed. A subtree deny or ask did not fire on
    // those patterns, a deny on the name itself did not either, and a
    // scoped allow granted them vacuously.
    mkdirSync(join(ws, "secrets"));
    writeFileSync(join(ws, "secrets", "prod.yml"), "x\n");
    writeFileSync(join(ws, "secrets", ".deploy-key"), "x\n");
    const leaks = () => (lastResult ?? "").includes(".deploy-key");
    const patterns = [
      "secrets/.deploy-key",
      "*/.deploy-key",
      "se*/.deploy-key",
      // Other spellings of the same listing.
      "./secrets/.deploy-key",
      "secrets//.deploy-key",
      "*/./.deploy-key",
      "secrets/.deploy-key/",
    ];
    let listedUnruled = 0;
    for (const pattern of patterns) {
      // Control: with no rule in the way the tool does list it.
      await gate("Glob", { pattern }, rules(["alwaysAllow", "Glob"]));
      if (leaks()) listedUnruled++;
    }
    expect(listedUnruled).toBe(patterns.length);
    for (const mode of ["default", "auto", "plan"] as const) {
      const rs =
        mode === "default"
          ? rules(["alwaysDeny", "Glob(secrets/**)"], ["alwaysAllow", "Glob"])
          : rules(["alwaysDeny", "Glob(secrets/**)"]);
      for (const pattern of patterns) {
        const got = await gate("Glob", { pattern }, rs, mode);
        expect({ mode, pattern, got, listed: leaks() }).toEqual({
          mode,
          pattern,
          got: "deny",
          listed: false,
        });
      }
    }
    const ask = rules(["alwaysAsk", "Glob(secrets/**)"], ["alwaysAllow", "Glob"]);
    for (const pattern of ["*/.deploy-key", "*/prod.yml"]) {
      expect({ pattern, got: await gate("Glob", { pattern }, ask) }).toEqual({
        pattern,
        got: "ask",
      });
    }
    // A deny that names the hidden file itself. (Control: the tool lists it.)
    await gate("Glob", { pattern: ".env" }, rules(["alwaysAllow", "Glob"]));
    expect(lastResult).toBe(".env");
    for (const deny of ["Glob(.env)", "Glob(**/.env)", "*(.env)"]) {
      for (const pattern of [".env", "./.env", ".env/"]) {
        const got = await gate(
          "Glob",
          { pattern },
          rules(["alwaysDeny", deny], ["alwaysAllow", "Glob"]),
        );
        const listed = (lastResult ?? "").split("\n").includes(".env");
        expect({ deny, pattern, got, listed }).toEqual({
          deny,
          pattern,
          got: "deny",
          listed: false,
        });
      }
    }
    // A deny on the hidden name, whatever directory it sits in: a brace list
    // or class spelling it lists it too.
    const key = rules(["alwaysDeny", "Glob(**/.deploy-key)"], ["alwaysAllow", "Glob"]);
    for (const pattern of ["*/.deploy-key", "{secrets,x}/.deploy-key", "[s]ecrets/.deploy-key"]) {
      await gate("Glob", { pattern }, rules(["alwaysAllow", "Glob"]));
      const listedUnruledHere = leaks();
      const got = await gate("Glob", { pattern }, key);
      expect({ pattern, listedUnruledHere, got, listed: leaks() }).toEqual({
        pattern,
        listedUnruledHere: true,
        got: "deny",
        listed: false,
      });
    }
    // A scoped allow names none of these, so it grants none of them.
    const src = rules(["alwaysAllow", "Glob(src/*)"]);
    for (const pattern of [".env", "secrets/.deploy-key", "*/.deploy-key", "secrets/*"]) {
      expect({ pattern, got: await gate("Glob", { pattern }, src) }).toEqual({
        pattern,
        got: "ask",
      });
    }
    expect(await gate("Glob", { pattern: "src/*.ts" }, src)).toBe("allow");
  }, 60_000);

  test("a git command given no path is read as the whole repository, wherever it runs", async () => {
    // GitDiff with `cwd: "src"` and no paths diffs the whole repository,
    // secrets/ included; its left-out paths used to be read as `src`.
    const repo = join(ws, "repo");
    const sh = (...argv: string[]) => {
      const run = Bun.spawnSync(["git", ...argv], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${run.stderr.toString()}`);
      return run.stdout.toString();
    };
    mkdirSync(join(repo, "secrets"), { recursive: true });
    mkdirSync(join(repo, "src"));
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "a@b.c");
    sh("config", "user.name", "t");
    sh("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "secrets", "key.txt"), "old\n");
    writeFileSync(join(repo, "src", "a.ts"), "a\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "secrets", "key.txt"), `${SECRET}\n`);
    for (const mode of ["default", "auto", "plan"] as const) {
      const deny: Array<[PermissionRule["type"], string]> = [
        ["alwaysDeny", "GitDiff(repo/secrets/**)"],
      ];
      const rs = rules(
        ...deny,
        ...(mode === "default" ? [["alwaysAllow", "GitDiff"] as const] : []),
      );
      for (const input of [
        { cwd: "repo/src", mode: "patch" },
        { cwd: "repo", mode: "patch" },
        { mode: "patch", paths: ["repo"] },
      ]) {
        const got = await gate("GitDiff", input, rs, mode);
        expect({ mode, input, got, leaked: (lastResult ?? "").includes(SECRET) }).toEqual({
          mode,
          input,
          got: "deny",
          leaked: false,
        });
      }
      const beside = await gate(
        "GitDiff",
        { cwd: "repo", mode: "patch", paths: ["src"] },
        rs,
        mode,
      );
      expect({ mode, beside }).toEqual({ mode, beside: "allow" });
    }
    // A write the same way: GitCommit with no paths commits the whole index.
    const commit = rules(
      ["alwaysDeny", "GitCommit(repo/secrets/**)"],
      ["alwaysAllow", "GitCommit"],
    );
    sh("add", "secrets/key.txt");
    const head = sh("rev-parse", "HEAD");
    expect(await gate("GitCommit", { cwd: "repo/src", message: "x" }, commit)).toBe("deny");
    expect(sh("rev-parse", "HEAD")).toBe(head);
  }, 60_000);
});

describe("C004 — a fixed service the call leaves out is read by a deny, not asked of an allow", () => {
  test("DependencyAudit: an allow on the project still covers the ordinary call", async () => {
    // 0.7.0 and the 0.7.1 base allowed these; declaring the OSV endpoint as
    // a plain default made every allow also have to match https://api.osv.dev.
    for (const pattern of ["DependencyAudit(.)", "DependencyAudit(./**)", "DependencyAudit(*)"]) {
      const rs = rules(["alwaysAllow", pattern]);
      for (const input of [{ cwd: "." }, { cwd: ".", ecosystems: ["npm"] }]) {
        const got = await gate("DependencyAudit", input, rs);
        expect({ pattern, input, got }).toEqual({ pattern, input, got: "allow" });
      }
    }
    // An endpoint the call names must still be covered by the allow.
    const named = { cwd: ".", endpoint: "https://osv.internal.example" };
    expect(await gate("DependencyAudit", named, rules(["alwaysAllow", "DependencyAudit(.)"]))).toBe(
      "ask",
    );
    // A deny on the public database still fires when the call leaves it out.
    const deny = rules(
      ["alwaysDeny", "DependencyAudit(https://api.osv.dev/**)"],
      ["alwaysAllow", "DependencyAudit"],
    );
    for (const mode of ["default", "auto", "plan"] as const) {
      const got = await gate("DependencyAudit", { cwd: "." }, deny, mode);
      expect({ mode, got }).toEqual({ mode, got: "deny" });
    }
  });
});

describe("C004 — a search that reaches a denied repository", () => {
  test("a search that reaches a denied repository meets the deny (SearchCode, SearchIssues)", async () => {
    for (const name of ["SearchCode", "SearchIssues"]) {
      const rs = rules(["alwaysDeny", `${name}(acme/secret)`], ["alwaysAllow", name]);
      // The repository named outright, and the whole owner it belongs to.
      const named = { owner: "acme", repo: "secret", query: "password" };
      const ownerWide = { owner: "acme", query: "password org:acme" };
      expect({ name, got: await gate(name, named, rs) }).toEqual({ name, got: "deny" });
      expect({ name, got: await gate(name, ownerWide, rs) }).toEqual({ name, got: "deny" });
      // Another owner's search is not this rule's business.
      const other = { owner: "other", query: "password org:other" };
      expect({ name, got: await gate(name, other, rs) }).toEqual({ name, got: "allow" });
    }
  });

  test("the owner written in another letter case, or left out, still meets the deny", async () => {
    // GitHub logins are case-insensitive, so org:ACME searches acme/secret;
    // and a search that names no owner covers every repository the token
    // can read, acme/secret among them.
    for (const name of ["SearchCode", "SearchIssues"]) {
      const rs = rules(["alwaysDeny", `${name}(acme/secret)`], ["alwaysAllow", name]);
      for (const [mode, input] of [
        ["default", { owner: "ACME", query: "password org:ACME" }],
        ["default", { owner: "Acme", query: "password user:Acme" }],
        ["default", { query: "password" }],
        ["auto", { query: "password" }],
        ["plan", { owner: "ACME", query: "password org:ACME" }],
      ] as const) {
        const got = await gate(name, input, rs, mode);
        expect({ name, mode, input, got }).toEqual({ name, mode, input, got: "deny" });
      }
    }
  });
});

describe("final review — an allow of `*` does not grant the read of every qualifier", () => {
  test("SearchIssues, SearchCode and DeployInspect: `*` asks for the unscoped read, `**` grants it", async () => {
    // Leaving owner and repo out searches every repository; leaving the spec
    // and the environment out inspects every spec in every environment. The
    // deny side has read that call as covering acme/app since 0.7.1; an allow
    // of `*` (one segment) covers no acme/app, so it no longer grants the
    // wider call while the narrower one asks.
    const cases: Array<[string, unknown, unknown]> = [
      ["SearchIssues", { query: "password" }, { query: "password", owner: "acme", repo: "app" }],
      ["SearchCode", { query: "password" }, { query: "password", owner: "acme", repo: "app" }],
      ["DeployInspect", {}, { name: "prod-agent", env: "production" }],
    ];
    for (const [name, broad, narrow] of cases) {
      const star = rules(["alwaysAllow", `${name}(*)`]);
      expect({ name, broad: await gate(name, broad, star) }).toEqual({ name, broad: "ask" });
      expect({ name, narrow: await gate(name, narrow, star) }).toEqual({ name, narrow: "ask" });
      for (const wide of [`${name}(**)`, `${name}(*/**)`]) {
        const rs = rules(["alwaysAllow", wide]);
        expect({ wide, broad: await gate(name, broad, rs) }).toEqual({ wide, broad: "allow" });
        expect({ wide, narrow: await gate(name, narrow, rs) }).toEqual({ wide, narrow: "allow" });
      }
    }
  }, 30_000);
});

describe("p2/p15 — decoys, `..` and symlinked directories on the file tools (permission-integration#1, #2)", () => {
  test("Write(src/**) does not reach .crewhaus/settings.json by a decoy or by `..`", async () => {
    const rs = rules(["alwaysAllow", "Write(src/**)"]);
    const settings = '{"permissions":{"rules":[{"type":"alwaysAllow","pattern":"Bash"}]}}';
    expect(
      await gate(
        "Write",
        { file_path: "src/ok.ts", path: ".crewhaus/settings.json", content: settings },
        rs,
      ),
    ).toBe("ask");
    expect(
      await gate("Write", { path: "src/../.crewhaus/settings.json", content: settings }, rs),
    ).toBe("ask");
    expect(existsSync(join(ws, ".crewhaus", "settings.json"))).toBe(false);
    // The honest in-scope write still runs.
    expect(await gate("Write", { path: "src/new.ts", content: "ok" }, rs)).toBe("allow");
    expect(readFileSync(join(ws, "src", "new.ts"), "utf8")).toBe("ok");
  });

  test("Write(build/**) and RemovePath(build/**) do not reach src/ through build/link", async () => {
    expect(
      await gate(
        "Write",
        { path: "build/link/app.ts", content: "overwritten via build/**" },
        rules(["alwaysAllow", "Write(build/**)"]),
      ),
    ).toBe("ask");
    expect(
      await gate(
        "RemovePath",
        { path: "build/link/app.ts" },
        rules(["alwaysAllow", "RemovePath(build/**)"]),
      ),
    ).toBe("ask");
    expect(
      await gate(
        "RemovePath",
        { path: "build/../src", recursive: true },
        rules(["alwaysAllow", "RemovePath(build/**)"]),
      ),
    ).toBe("ask");
    expect(readFileSync(join(ws, "src", "app.ts"), "utf8")).toBe("original");
  });

  test("a path deny fires on every spelling of the file it names (permission-integration#1, deny side)", async () => {
    // The audit's deny-side escapes: `./`, `src/../`, a trailing `/.` and the
    // absolute in-workspace path all reach the file a relative deny names.
    const readRules = rules(["alwaysDeny", "Read(.env)"], ["alwaysAllow", "Read"]);
    const envSpellings = ["./.env", "src/../.env", ".env/.", join(ws, ".env")];
    for (const path of envSpellings) {
      expect({ path, decision: await gate("Read", { path }, readRules) }).toEqual({
        path,
        decision: "deny",
      });
    }
    const writeRules = rules(["alwaysDeny", "Write(.crewhaus/**)"], ["alwaysAllow", "Write"]);
    const settingsSpellings = [
      "./.crewhaus/settings.json",
      "src/../.crewhaus/settings.json",
      ".crewhaus//settings.json",
      join(ws, ".crewhaus", "settings.json"),
    ];
    for (const path of settingsSpellings) {
      expect({ path, decision: await gate("Write", { path, content: "{}" }, writeRules) }).toEqual({
        path,
        decision: "deny",
      });
    }
    expect(existsSync(join(ws, ".crewhaus", "settings.json"))).toBe(false);
    // Control: the bare allow still grants a file the deny does not name.
    expect(await gate("Read", { path: "./src/app.ts" }, readRules)).toBe("allow");
  }, 30_000);

  test("a URL or recipient deny fires on every spelling of its destination (C004)", async () => {
    // WebFetch is read-only, so auto mode runs it unasked: only the rule stands
    // between the model and the host. Every spelling below is fetched from
    // evil.example (or api.example/admin) by the tool.
    const hostDeny = rules(["alwaysDeny", "WebFetch(https://evil.example/**)"]);
    for (const url of [
      "https://evil.example/exfil",
      "https://x@evil.example/exfil",
      "https://evil.example./exfil",
      "http://evil.example:8080/exfil",
    ]) {
      expect({ url, decision: await gate("WebFetch", { url }, hostDeny, "auto") }).toEqual({
        url,
        decision: "deny",
      });
    }
    const pathDeny = rules(["alwaysDeny", "WebFetch(https://api.example/admin/**)"]);
    for (const url of ["https://api.example/%61dmin/users", "https://api.example//admin/users"]) {
      expect({ url, decision: await gate("WebFetch", { url }, pathDeny, "auto") }).toEqual({
        url,
        decision: "deny",
      });
    }
    const mailDeny = rules(["alwaysDeny", "EmailSend(ceo@corp.example)"]);
    const mail = {
      from: { address: "bot@corp.example" },
      host: "smtp.corp.example",
      subject: "s",
      text: "t",
      date: "2026-09-24T09:00:00Z",
    };
    for (const address of ["CEO@corp.example", "ceo@CORP.EXAMPLE", "ceo@corp.example."]) {
      const input = { ...mail, to: [{ address }] };
      expect({ address, decision: await gate("EmailSend", input, mailDeny) }).toEqual({
        address,
        decision: "deny",
      });
    }
    // Control: a recipient the rule does not name is asked, not denied.
    expect(
      await gate("EmailSend", { ...mail, to: [{ address: "cfo@corp.example" }] }, mailDeny),
    ).toBe("ask");
  }, 30_000);

  // The folding above must not widen a rule that names a scheme or a port
  // rather than a host: on the real tools and loop, in auto mode (WebFetch is
  // read-only and runs unasked) and behind a bare allow.
  test("a URL rule that names a scheme or a port keeps to it", async () => {
    const https = "https://api.github.com/repos/crewhaus/factory";
    for (const type of ["alwaysDeny", "alwaysAsk"] as const) {
      const noPlainHttp = rules([type, "WebFetch(http://**)"]);
      expect({
        type,
        decision: await gate("WebFetch", { url: https }, noPlainHttp, "auto"),
      }).toEqual({ type, decision: "allow" });
      expect(await gate("WebFetch", { url: "http://api.github.com/x" }, noPlainHttp, "auto")).toBe(
        type === "alwaysDeny" ? "deny" : "ask",
      );
    }
    const noDb = rules(
      ["alwaysDeny", "HttpRequest(http://localhost:5432/**)"],
      ["alwaysAllow", "HttpRequest"],
    );
    expect(
      await gate("HttpRequest", { method: "GET", url: "http://localhost:3000/health" }, noDb),
    ).toBe("allow");
    expect(await gate("HttpRequest", { method: "GET", url: "http://localhost:5432/q" }, noDb)).toBe(
      "deny",
    );
  }, 30_000);

  test("Grep(src/**) is not satisfied by a regex that names src/", async () => {
    expect(
      await gate(
        "Grep",
        { pattern: "src/x|password", path: "." },
        rules(["alwaysAllow", "Grep(src/**)"]),
      ),
    ).toBe("ask");
    // Leaving `path` out searches the whole workspace, so it is read as ".".
    expect(
      await gate("Grep", { pattern: "src/x|password" }, rules(["alwaysAllow", "Grep(src/**)"])),
    ).toBe("ask");
    // Control: a search that really is under src/ is allowed.
    expect(
      await gate("Grep", { pattern: "src/x", path: "src" }, rules(["alwaysAllow", "Grep(src/**)"])),
    ).toBe("allow");
  });
});

// critic7 (0.7.1): Lint and Format hand each `paths` entry, as written, to
// the project's formatter run in the REAL `cwd`. The gate collapsed `..`
// before following a link; the formatter's open() follows the link first. So
// with `link -> secrets/deep`, `{cwd: "link", paths: ["../x.ts"]}` was x.ts
// to every rule and secrets/x.ts on disk — and an ordinary workspace link
// (`node_modules/@acme/pkg`) was enough. An absolute entry was checked as
// `<cwd>/<abs>` and handed to the formatter as `<abs>`. The stub formatter
// and test runner record their physical cwd and the physical place of each
// path, and append a line to it, as `biome format --write` would.
describe("critic7 — `..` and absolute entries in Lint, Format and RunTests paths", () => {
  const SECRET = "export const key = 1;\n";
  let outsideDir: string;
  let stubLog: string;
  beforeEach(() => {
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "perm-real-outside-")));
    writeFileSync(join(outsideDir, "victim.ts"), SECRET);
    stubLog = join(state, "stub.log");
    writeFileSync(stubLog, "");
    for (const d of ["secrets/deep", "packages/pkg", "node_modules/@acme", "node_modules/.bin"]) {
      mkdirSync(join(ws, d), { recursive: true });
    }
    writeFileSync(join(ws, "secrets", "x.ts"), SECRET);
    writeFileSync(join(ws, "x.ts"), "export const harmless = 1;\n");
    writeFileSync(join(ws, "src", "x.ts"), "export const app = 1;\n");
    writeFileSync(join(ws, "src", "x.test.ts"), "export {};\n");
    // Every directory a call below runs in is a biome and vitest project.
    for (const d of [".", "src", "secrets/deep", "packages/pkg"]) {
      writeFileSync(join(ws, d, "biome.json"), "{}\n");
      writeFileSync(join(ws, d, "vitest.config.ts"), "export default {};\n");
    }
    symlinkSync("secrets/deep", join(ws, "link"));
    symlinkSync("../../packages/pkg", join(ws, "node_modules", "@acme", "pkg"));
    symlinkSync("../secrets/deep", join(ws, "src", "lnk"));
    // The in-workspace mirror the old check looked at for an absolute path.
    mkdirSync(join(ws, "src", outsideDir), { recursive: true });
    writeFileSync(join(ws, "src", outsideDir, "victim.ts"), "mirror\n");
    const stub = [
      "#!/bin/sh",
      `echo "cwd=$(pwd -P)" >> "${stubLog}"`,
      "seen=0",
      'for a in "$@"; do',
      '  if [ "$seen" = 1 ]; then',
      `    echo "  $a -> $(cd -P "$(dirname "$a")" && pwd -P)/$(basename "$a")" >> "${stubLog}"`,
      '    echo "// touched" >> "$a"',
      "  fi",
      '  [ "$a" = "--" ] && seen=1',
      "done",
      "exit 0",
      "",
    ].join("\n");
    for (const bin of ["biome", "vitest"]) {
      writeFileSync(join(ws, "node_modules", ".bin", bin), stub, { mode: 0o755 });
    }
  });
  afterEach(() => {
    rmSync(outsideDir, { recursive: true, force: true });
  });
  const stubRan = () => readFileSync(stubLog, "utf8").replaceAll(ws, "<ws>");
  const untouched = () => ({
    secret: readFileSync(join(ws, "secrets", "x.ts"), "utf8") === SECRET,
    outside: readFileSync(join(outsideDir, "victim.ts"), "utf8") === SECRET,
  });
  // Each reaches secrets/x.ts on disk, and none says so in its own words.
  const CLIMBS: ReadonlyArray<Record<string, unknown>> = [
    { cwd: "link", paths: ["../x.ts"] },
    { cwd: "node_modules/@acme/pkg", paths: ["../../secrets/x.ts"] },
    { paths: ["link/../x.ts"] },
    { cwd: "src", paths: ["lnk/../x.ts"] },
  ];

  test("a deny on the real place fires, in every mode, and the formatter never runs", async () => {
    for (const tool of ["Format", "Lint"]) {
      const rs = rules(["alwaysDeny", `${tool}(secrets/**)`], ["alwaysAllow", tool]);
      for (const mode of ["default", "auto", "plan"] as const) {
        for (const input of CLIMBS) {
          const got = await gate(tool, input, rs, mode);
          expect({ tool, mode, input, got, ran: stubRan(), ...untouched() }).toEqual({
            tool,
            mode,
            input,
            got: "deny",
            ran: "",
            secret: true,
            outside: true,
          });
        }
      }
    }
  }, 60_000);

  test("an allow about another place does not grant it", async () => {
    for (const [input, allow] of [
      [{ cwd: "link", paths: ["../x.ts"] }, "Format(x.ts)"],
      [{ cwd: "node_modules/@acme/pkg", paths: ["../../secrets/x.ts"] }, "Format(node_modules/**)"],
      [{ paths: ["link/../x.ts"] }, "Format(x.ts)"],
      [{ cwd: "src", paths: ["lnk/../x.ts"] }, "Format(src/**)"],
    ] as const) {
      const got = await gate("Format", input, rules(["alwaysAllow", allow]));
      expect({ input, allow, got, ran: stubRan(), ...untouched() }).toEqual({
        input,
        allow,
        got: "ask",
        ran: "",
        secret: true,
        outside: true,
      });
    }
  }, 60_000);

  test("where a bare allow, auto or bypass lets the call through, the tool refuses the entry by name", async () => {
    const absolute = join(outsideDir, "victim.ts");
    for (const tool of ["Format", "Lint", "RunTests"]) {
      for (const [mode, rs] of [
        ["default", rules(["alwaysAllow", tool])],
        ["auto", rules(["alwaysAllow", tool])],
        ["bypass", rules()],
      ] as const) {
        for (const input of [...CLIMBS, { cwd: "src", paths: [absolute] }]) {
          const got = await gate(tool, input, rs, mode);
          const entry = (input["paths"] as string[])[0] as string;
          const why = entry === absolute ? "it is absolute" : 'it has a ".." segment';
          expect({ tool, mode, input, got, ran: stubRan(), ...untouched() }).toEqual({
            tool,
            mode,
            input,
            got: "allow",
            ran: "",
            secret: true,
            outside: true,
          });
          expect(lastResult).toContain(`${tool} refused the path "${entry.slice(0, 80)}`);
          expect(lastResult).toContain(why);
        }
      }
    }
  }, 120_000);

  test("control: an ordinary relative path is decided where it lands, and runs unchanged", async () => {
    const allowSrc = (tool: string) => rules(["alwaysAllow", `${tool}(src/**)`]);
    for (const tool of ["Format", "Lint"]) {
      writeFileSync(stubLog, "");
      expect(await gate(tool, { cwd: "src", paths: ["x.ts"] }, allowSrc(tool))).toBe("allow");
      expect({ tool, ran: stubRan() }).toEqual({
        tool,
        ran: "cwd=<ws>/src\n  x.ts -> <ws>/src/x.ts\n",
      });
    }
    // Through the link, x.ts IS secrets/deep/x.ts, and a deny there fires.
    writeFileSync(stubLog, "");
    expect(
      await gate(
        "Format",
        { cwd: "link", paths: ["x.ts"] },
        rules(["alwaysDeny", "Format(secrets/**)"], ["alwaysAllow", "Format"]),
      ),
    ).toBe("deny");
    expect(stubRan()).toBe("");
    // RunTests' paths are filters the runner reads from `cwd`.
    expect(
      await gate(
        "RunTests",
        { cwd: "src", paths: ["x.test.ts"] },
        rules(["alwaysAllow", "RunTests"]),
      ),
    ).toBe("allow");
    expect(stubRan()).toBe("cwd=<ws>/src\n  x.test.ts -> <ws>/src/x.test.ts\n");
    expect(untouched()).toEqual({ secret: true, outside: true });
  }, 120_000);
});

// critic8 (0.7.1): the gate reads tool-deploy's `env` within `name` as
// `<name>/<env>`, as the call wrote it, while the registry stores a spec under
// spec-changelog's registrySpecName. `.billing` is `billing` on disk, so
// `alwaysDeny DeployInspect(billing/**)` did not fire on `{name: ".billing"}`
// and the call read billing's versions and pins. DeployInspect has no
// justification judge behind the gate.
describe("critic8 — a spec name the registry stores under another spelling", () => {
  beforeEach(async () => {
    const registry = createFileBackedRegistry({ rootDir: join(ws, ".crewhaus", "specs") });
    for (const name of ["billing", "docs"]) {
      await registry.put(name, "v1", `name: ${name}\n`);
      await registry.pin(name, "prod", "v1");
    }
  });
  const pinsShown = () => (lastResult ?? "").includes('"pins"');

  test("is refused by DeployInspect where the gate lets it through, naming the stored name", async () => {
    const rs = rules(["alwaysDeny", "DeployInspect(billing/**)"], ["alwaysAllow", "DeployInspect"]);
    expect(await gate("DeployInspect", { name: "billing", env: "prod" }, rs)).toBe("deny");
    for (const [name, stored] of [
      [".billing", "billing"],
      ["..billing", "billing"],
      ["...billing", "billing"],
      ["bill ing", "bill-ing"],
    ] as const) {
      const got = await gate("DeployInspect", { name, env: "prod" }, rs);
      const result = JSON.parse(lastResult ?? "{}") as Record<string, unknown>;
      expect({ name, got, status: result["status"], pins: pinsShown() }).toEqual({
        name,
        got: "allow",
        status: "refused",
        pins: false,
      });
      expect(String(result["reason"])).toContain(
        `spec name "${name}" is stored by the registry as "${stored}". Name it "${stored}"`,
      );
    }
    // Control: a name the registry stores as written runs, and shows its pins.
    expect(await gate("DeployInspect", { name: "docs", env: "prod" }, rs)).toBe("allow");
    expect(pinsShown()).toBe(true);
  }, 30_000);
});

describe("p12/security-8#0 — argv and extra fields in front of a deny", () => {
  test("RunCommand(rm) fires on an argv that starts with rm, with or without cwd", async () => {
    const rs = rules(["alwaysDeny", "RunCommand(rm)"], ["alwaysAllow", "RunCommand"]);
    expect(await gate("RunCommand", { argv: ["rm", "-rf", "src"] }, rs)).toBe("deny");
    expect(await gate("RunCommand", { argv: ["rm"], cwd: "src" }, rs)).toBe("deny");
    expect(existsSync(join(ws, "src", "app.ts"))).toBe(true);
  });

  test("DownloadFile(**.sh) fires on the destination path", async () => {
    const rs = rules(["alwaysDeny", "DownloadFile(**.sh)"], ["alwaysAllow", "DownloadFile"]);
    expect(
      await gate("DownloadFile", { url: "https://ok.example/a", path: "install.sh" }, rs),
    ).toBe("deny");
  });
});

describe("flag-truth-4#0 / permission-integration#6 — read-only egress tools", () => {
  // The inputs carry every field the tools require. Before 0.7.1 stopped
  // counting a schema rejection as a permission decision, these asserted
  // "deny" on inputs missing `maxPages` / `timeoutMs` and passed without the
  // rule ever being read.
  test("a scoped deny on HttpPaginate holds in default, auto and plan", async () => {
    const rs = rules(["alwaysDeny", "HttpPaginate(https://internal.corp/**)"]);
    const input = {
      url: "https://internal.corp/items",
      style: "page",
      pageParam: "page",
      maxPages: 2,
      timeoutMs: 1000,
    };
    for (const mode of ["default", "auto", "plan"] as const) {
      expect({ mode, decision: await gate("HttpPaginate", input, rs, mode) }).toEqual({
        mode,
        decision: "deny",
      });
      // Plan mode names the rule; default and auto do not word a rule deny.
      if (mode === "plan")
        expect(lastReason ?? "").toContain("HttpPaginate(https://internal.corp/**)");
    }
    // Control: the same input with a URL the rule does not cover is allowed,
    // so the input is one the tool accepts and the deny above is the rule's.
    const other = { ...input, url: "https://ok.example/items" };
    expect(await gate("HttpPaginate", other, rs, "auto")).toBe("allow");
  });

  test("plan mode no longer runs a read-only tool the operator denied", async () => {
    const input = { url: "https://x.example/stream", timeoutMs: 1000 };
    expect(await gate("SseRead", input, rules(["alwaysDeny", "SseRead(**)"]), "plan")).toBe("deny");
    expect(lastReason ?? "").toContain("SseRead(**)");
    // Control: without the rule, plan mode runs a read-only tool.
    expect(await gate("SseRead", input, rules(), "plan")).toBe("allow");
  });
});

describe("F3b — every builtin's declaration is what a rule reads (permission-integration#8)", () => {
  test("a path in a git tool is read from its cwd, so a deny on the real file fires", async () => {
    const rs = rules(["alwaysDeny", "GitAdd(pkg/.env)"], ["alwaysAllow", "GitAdd"]);
    // `.env` relative to cwd `pkg` is pkg/.env, not the workspace's .env.
    expect(await gate("GitAdd", { cwd: "pkg", paths: [".env"] }, rs)).toBe("deny");
    expect(await gate("GitAdd", { paths: ["pkg/.env"] }, rs)).toBe("deny");
    expect(await gate("GitAdd", { cwd: "pkg", paths: ["src/a.ts"] }, rs)).toBe("allow");
  });

  test("a git path is literal to git as it is to the rule: `secret*` reaches nothing under secrets/", async () => {
    // Final review (0.7.1): git read `secret*` as a glob, the rule as the
    // file `secret*`, so a deny on secrets/** allowed a diff of everything
    // under it and staged every file there.
    const SECRET = "sk-live-NOT-FOR-THE-MODEL";
    const repo = join(ws, "repo");
    const sh = (...argv: string[]) => {
      const run = Bun.spawnSync(["git", ...argv], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${run.stderr.toString()}`);
      return run.stdout.toString();
    };
    mkdirSync(join(repo, "secrets"), { recursive: true });
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "a@b.c");
    sh("config", "user.name", "t");
    sh("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "secrets", "key.txt"), "old\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "secrets", "key.txt"), `${SECRET}\n`);
    writeFileSync(join(repo, "secrets", "new.txt"), "untracked\n");
    for (const mode of ["default", "auto", "plan"] as const) {
      const deny: Array<[PermissionRule["type"], string]> = [
        ["alwaysDeny", "GitDiff(repo/secrets/**)"],
      ];
      const rs = rules(
        ...deny,
        ...(mode === "default" ? [["alwaysAllow", "GitDiff"] as const] : []),
      );
      expect(
        await gate("GitDiff", { cwd: "repo", mode: "patch", paths: ["secrets"] }, rs, mode),
      ).toBe("deny");
      for (const glob of ["secret*", "secret?/*", "[s]ecrets"]) {
        const got = await gate("GitDiff", { cwd: "repo", mode: "patch", paths: [glob] }, rs, mode);
        expect({ mode, glob, got, leaked: (lastResult ?? "").includes(SECRET) }).toEqual({
          mode,
          glob,
          got: "allow",
          leaked: false,
        });
      }
    }
    const add = rules(["alwaysDeny", "GitAdd(repo/secrets/**)"], ["alwaysAllow", "GitAdd"]);
    expect(await gate("GitAdd", { cwd: "repo", paths: ["secrets/new.txt"] }, add)).toBe("deny");
    for (const glob of ["secret*", "*", "[s]ecrets"]) {
      expect(await gate("GitAdd", { cwd: "repo", paths: [glob] }, add)).toBe("allow");
      expect({ glob, staged: sh("diff", "--cached", "--name-only") }).toEqual({ glob, staged: "" });
    }
  }, 60_000);

  test("a scoped allow on a repository covers that owner's repos and nothing else", async () => {
    const rs = rules(["alwaysAllow", "IssueCreate(crewhaus/*)"]);
    const issue = { owner: "crewhaus", repo: "factory", title: "t", justification: "x" };
    expect(await gate("IssueCreate", issue, rs, "default")).toBe("allow");
    expect(await gate("IssueCreate", { ...issue, owner: "attacker" }, rs, "default")).toBe("ask");
  });

  test("an allow on a recipient domain holds only when every recipient is in it", async () => {
    const rs = rules(["alwaysAllow", "EmailSend(*@example.com)"]);
    const mail = {
      from: { address: "bot@example.com" },
      to: [{ address: "ops@example.com" }],
      subject: "s",
      text: "t",
      date: "2026-09-24T09:00:00Z",
      host: "smtp.example.com",
    };
    expect(await gate("EmailSend", mail, rs)).toBe("allow");
    expect(
      await gate("EmailSend", { ...mail, bcc: [{ address: "leak@elsewhere.example" }] }, rs),
    ).toBe("ask");
  });

  test("a URL rule on HttpBatch reads every request's url", async () => {
    const rs = rules(["alwaysAllow", "HttpBatch(https://api.example.com/**)"]);
    const ok = { requests: [{ url: "https://api.example.com/a" }] };
    expect(await gate("HttpBatch", ok, rs)).toBe("allow");
    expect(
      await gate(
        "HttpBatch",
        { requests: [...ok.requests, { url: "https://evil.example/x" }] },
        rs,
      ),
    ).toBe("ask");
  });
});

// C033 (permission-integration#3, #4). On 0.7.0 a scoped allow on a tool
// outside the ten-name table had to match EVERY string in the call, so
// `RunCommand(git status*)` and `HttpRequest(https://api.example.com/**)`
// never fired and operators granted the bare name. Every acting builtin now
// declares its operative field, and an allow is read against that field
// alone. A boolean switch is still not operative (the documented 0.8 key
// work): the last test pins that, so a change to it is deliberate.
describe("C033 — a scoped allow on a multi-field builtin is usable", () => {
  test("RunCommand(git status*) allows `git status` and nothing else", async () => {
    const rs = rules(["alwaysAllow", "RunCommand(git status*)"]);
    expect(await gate("RunCommand", { argv: ["git", "status"] }, rs)).toBe("allow");
    expect(await gate("RunCommand", { argv: ["git", "status", "--short"] }, rs)).toBe("allow");
    expect(await gate("RunCommand", { argv: ["rm", "-rf", "src"] }, rs)).toBe("ask");
  });

  test("HttpRequest(https://api.example.com/**) allows a call with a method and headers", async () => {
    const rs = rules(["alwaysAllow", "HttpRequest(https://api.example.com/**)"]);
    const call = {
      url: "https://api.example.com/v1/items",
      method: "GET",
      headers: { accept: "application/json" },
    };
    expect(await gate("HttpRequest", call, rs)).toBe("allow");
    expect(await gate("HttpRequest", { ...call, url: "https://evil.example/v1" }, rs)).toBe("ask");
  });

  // The same argv is another program in another directory: `./build.sh` in
  // src/ runs src/build.sh, a file a scoped `Write(src/**)` lets the model
  // write. The working directory was invisible to every rule, so this allow
  // ran it.
  test("a scoped command allow covers the workspace root, not another directory", async () => {
    const rs = rules(
      ["alwaysAllow", "RunCommand(./build.sh)"],
      ["alwaysAllow", "ProcessStart(./build.sh)"],
      ["alwaysAllow", "Retry(./build.sh)"],
      ["alwaysAllow", "RunPipeline(./build.sh)"],
    );
    const argv = ["./build.sh"];
    const extra: Record<string, object> = {
      RunCommand: {},
      ProcessStart: {},
      Retry: { maxAttempts: 2, backoff: { kind: "fixed", delayMs: 0 } },
    };
    for (const [tool, more] of Object.entries(extra)) {
      const at = async (cwd?: string) =>
        gate(tool, cwd === undefined ? { argv, ...more } : { argv, cwd, ...more }, rs);
      expect({ tool, root: await at(), dot: await at("."), src: await at("src") }).toEqual({
        tool,
        root: "allow",
        dot: "allow",
        src: "ask",
      });
    }
    const pipe = async (input: unknown) => gate("RunPipeline", input, rs);
    expect(await pipe({ steps: [{ argv }] })).toBe("allow");
    expect(await pipe({ steps: [{ argv }], cwd: "src" })).toBe("ask");
    expect(await pipe({ steps: [{ argv }, { argv, cwd: "src" }] })).toBe("ask");
    // A deny still reads the command wherever it runs.
    const deny = rules(["alwaysDeny", "RunCommand(rm*)"], ["alwaysAllow", "RunCommand"]);
    expect(await gate("RunCommand", { argv: ["rm", "-rf", "x"], cwd: "src" }, deny)).toBe("deny");
    expect(await gate("RunCommand", { argv: ["ls"], cwd: "src" }, deny)).toBe("allow");
  }, 30_000);

  // RunBuild and RunTests declare `cwd` beside the command. As a plain
  // default, the root "." was one more value every allow had to match, so
  // `alwaysAllow RunBuild(npm run build)` — which 0.7.0 honoured — no longer
  // fired on the ordinary call, and a headless run stopped at an approval.
  // `cwd` only moves the run, as it does for RunCommand: an allow scoped to
  // the command covers the workspace root, a call in another directory must
  // be covered there too, and a deny on a directory still reads the root
  // when the call leaves `cwd` out.
  test("RunBuild and RunTests: an allow on the command covers the ordinary call, not another directory", async () => {
    for (const [tool, script] of [
      ["RunBuild", "./build.sh"],
      ["RunTests", "./test.sh"],
    ] as const) {
      const command = [script];
      const allow = rules(["alwaysAllow", `${tool}(${script})`]);
      expect({
        tool,
        root: await gate(tool, { command }, allow),
        src: await gate(tool, { command, cwd: "src" }, allow),
      }).toEqual({ tool, root: "allow", src: "ask" });
      const denySrc = rules(["alwaysDeny", `${tool}(src)`], ["alwaysAllow", tool]);
      expect({
        tool,
        src: await gate(tool, { command, cwd: "src" }, denySrc),
        root: await gate(tool, { command }, denySrc),
      }).toEqual({ tool, src: "deny", root: "allow" });
      const denyRoot = rules(["alwaysDeny", `${tool}(.)`], ["alwaysAllow", tool]);
      expect({ tool, root: await gate(tool, { command }, denyRoot) }).toEqual({
        tool,
        root: "deny",
      });
    }
  }, 30_000);

  // merge-seams (wave III): the deny that refused `[sh, scripts/release.sh]`
  // allowed `[sh, release.sh]` with `cwd: scripts`, and the script ran.
  test("a deny naming a script by its workspace path holds when the call runs it from its directory", async () => {
    mkdirSync(join(ws, "scripts"));
    writeFileSync(join(ws, "scripts", "release.sh"), 'echo released > "$PWD/../RELEASED"\n');
    mkdirSync(join(ws, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(ws, "node_modules", ".bin", "eslint"), "#!/bin/sh\necho linted > RAN\n", {
      mode: 0o755,
    });
    const retry = { maxAttempts: 1, backoff: { kind: "fixed", delayMs: 0 } };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["RunCommand", { argv: ["sh", "release.sh"], cwd: "scripts" }],
      ["RunCommand", { argv: ["sh", "./release.sh"], cwd: "./scripts/" }],
      ["ProcessStart", { argv: ["sh", "release.sh"], cwd: "scripts" }],
      ["Retry", { argv: ["sh", "release.sh"], cwd: "scripts", ...retry }],
      ["RunPipeline", { steps: [{ argv: ["sh", "release.sh"], cwd: "scripts" }] }],
      ["RunPipeline", { cwd: "scripts", steps: [{ argv: ["sh", "release.sh"] }] }],
    ];
    const decisions: string[] = [];
    for (const [tool, input] of calls) {
      const rs = rules(["alwaysDeny", `${tool}(*scripts/release.sh*)`], ["alwaysAllow", tool]);
      decisions.push(`${tool} ${JSON.stringify(input)}: ${await gate(tool, input, rs)}`);
    }
    expect(decisions.filter((d) => !d.endsWith(": deny"))).toEqual([]);
    expect(existsSync(join(ws, "RELEASED"))).toBe(false);
    // A deny on a directory of programs, and the binary run from inside it.
    const bin = rules(
      ["alwaysDeny", "RunCommand(**node_modules/.bin/**)"],
      ["alwaysAllow", "RunCommand"],
    );
    expect(await gate("RunCommand", { argv: ["./eslint"], cwd: "node_modules/.bin" }, bin)).toBe(
      "deny",
    );
    expect(existsSync(join(ws, "node_modules", ".bin", "RAN"))).toBe(false);
    // The same words in another directory are another program, and run.
    expect(
      await gate(
        "RunCommand",
        { argv: ["sh", "-c", "true"], cwd: "src" },
        rules(["alwaysDeny", "RunCommand(*scripts/release.sh*)"], ["alwaysAllow", "RunCommand"]),
      ),
    ).toBe("allow");
  }, 30_000);

  // wave III review: the same seam on the tool-code runners (their command
  // ran in `cwd` but was not declared within it), and the child's
  // environment — `envSet` wins over the pinned PATH, and `BASH_ENV` runs a
  // file before any `bash -c`. The script ran each time.
  test("a deny naming a script holds when the call reaches it through cwd on the code runners, or through the environment", async () => {
    mkdirSync(join(ws, "scripts"));
    const marker = join(ws, "RELEASED");
    writeFileSync(join(ws, "scripts", "release.sh"), `#!/bin/sh\necho released > "${marker}"\n`, {
      mode: 0o755,
    });
    const retry = { maxAttempts: 1, backoff: { kind: "fixed", delayMs: 0 } };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["RunBuild", { command: ["sh", "release.sh"], cwd: "scripts" }],
      ["RunTests", { command: ["sh", "release.sh"], cwd: "scripts" }],
      ["Format", { command: ["sh", "release.sh"], cwd: "scripts" }],
      ["RunCommand", { argv: ["release.sh"], envSet: { PATH: "scripts" } }],
      ["RunCommand", { argv: ["release.sh"], envSet: { PATH: `${ws}/scripts:/usr/bin:/bin` } }],
      ["RunCommand", { argv: ["bash", "-c", "true"], envSet: { BASH_ENV: "scripts/release.sh" } }],
      ["Retry", { argv: ["release.sh"], envSet: { PATH: "scripts" }, ...retry }],
      ["ProcessStart", { argv: ["release.sh"], envSet: { PATH: "scripts" } }],
      ["RunPipeline", { steps: [{ argv: ["release.sh"] }], envSet: { PATH: "scripts" } }],
    ];
    const decisions: string[] = [];
    for (const [tool, input] of calls) {
      const rs = rules(["alwaysDeny", `${tool}(*scripts/release.sh*)`], ["alwaysAllow", tool]);
      decisions.push(`${tool} ${JSON.stringify(input)}: ${await gate(tool, input, rs)}`);
    }
    expect(decisions.filter((d) => !d.endsWith(": deny"))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    // The same calls with the directory or the environment left out are
    // another program, and a scoped allow still covers a code runner at the
    // root.
    const rs = rules(["alwaysDeny", "RunBuild(*scripts/release.sh*)"], ["alwaysAllow", "RunBuild"]);
    expect(await gate("RunBuild", { command: ["sh", "-c", "true"], cwd: "src" }, rs)).toBe("allow");
    expect(
      await gate(
        "RunCommand",
        { argv: ["sh", "-c", "true"], envSet: { CI: "1" } },
        rules(["alwaysDeny", "RunCommand(*scripts/release.sh*)"], ["alwaysAllow", "RunCommand"]),
      ),
    ).toBe("allow");
    // A scoped allow names the command; the environment may change what it
    // runs, so a call that sets one asks.
    const scoped = rules(["alwaysAllow", "RunCommand(sh -c true)"]);
    expect(await gate("RunCommand", { argv: ["sh", "-c", "true"] }, scoped)).toBe("allow");
    expect(
      await gate("RunCommand", { argv: ["sh", "-c", "true"], envSet: { BASH_ENV: "x" } }, scoped),
    ).toBe("ask");
    // One that names every command covers it wherever and however it runs,
    // as 0.7.0's did.
    const every = rules(["alwaysAllow", "RunCommand(**)"]);
    expect({
      env: await gate("RunCommand", { argv: ["sh", "-c", "true"], envSet: { CI: "1" } }, every),
      cwd: await gate("RunCommand", { argv: ["sh", "-c", "true"], cwd: "src" }, every),
      build: await gate(
        "RunBuild",
        { command: ["sh", "-c", "true"], cwd: "src" },
        rules(["alwaysAllow", "RunBuild(**)"]),
      ),
    }).toEqual({ env: "allow", cwd: "allow", build: "allow" });
  }, 60_000);

  // wave III review: the joined spellings included the workspace's own
  // absolute path and a `./sub` form the call never wrote, and the bare
  // program, so a deny or ask stopped ordinary commands run in a
  // subdirectory — through the real canonicaliser, which the unit tests did
  // not use.
  test("a deny or ask does not fire on an ordinary command because it runs in a subdirectory", async () => {
    const root = join(ws, "prod-agent");
    mkdirSync(join(root, "packages", "api"), { recursive: true });
    process.chdir(root);
    const allowAll = (type: PermissionRule["type"], pattern: string) =>
      rules([type, pattern], ["alwaysAllow", "RunCommand"]);
    const sub = { argv: ["git", "status"], cwd: "packages/api" };
    const touch = { argv: ["touch", "ran-sub"], cwd: "packages/api" };
    const got = {
      denyDotStar: await gate("RunCommand", sub, allowAll("alwaysDeny", "RunCommand(./**)")),
      askDotStar: await gate("RunCommand", sub, allowAll("alwaysAsk", "RunCommand(./**)")),
      denyProd: await gate("RunCommand", touch, allowAll("alwaysDeny", "RunCommand(**prod**)")),
      denyAbove: await gate(
        "RunCommand",
        touch,
        allowAll("alwaysDeny", `RunCommand(${ws.split("/").slice(0, 3).join("/")}/**)`),
      ),
    };
    expect(got).toEqual({
      denyDotStar: "allow",
      askDotStar: "allow",
      denyProd: "allow",
      denyAbove: "allow",
    });
    expect(existsSync(join(root, "packages", "api", "ran-sub"))).toBe(true);
    // What the call named is still read.
    expect(
      await gate(
        "RunCommand",
        { argv: ["sh", "./x.sh"], cwd: "packages/api" },
        allowAll("alwaysDeny", "RunCommand(./**)"),
      ),
    ).toBe("deny");
    expect(
      await gate("RunCommand", touch, allowAll("alwaysDeny", "RunCommand(packages/api/ran-sub)")),
    ).toBe("deny");
  }, 60_000);

  test("a boolean switch is not part of what a rule sees (documented; 0.8)", async () => {
    const rs = rules(["alwaysAllow", "RemovePath(build/**)"]);
    const call = { path: "build/nothing-here", recursive: true, dryRun: false };
    expect(await gate("RemovePath", call, rs)).toBe("allow");
    expect(await gate("RemovePath", { ...call, path: "src/app.ts" }, rs)).toBe("ask");
  });
});

describe("EVM ids: rules read <chainId>/<address>, and case cannot dodge a deny", () => {
  // ContractInspect, like every chain tool, scopes by `<chainId>/<address>`.
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const inspect = (address: string) => ({ chainId: "1", address });

  test("a deny written from a block explorer fires on the address in any letter case", async () => {
    const checksummed = rules(["alwaysDeny", `ContractInspect(*/${USDT})`]);
    for (const mode of ["default", "auto", "plan"] as const) {
      for (const address of [USDT, USDT.toLowerCase()]) {
        expect({
          mode,
          address,
          d: await gate("ContractInspect", inspect(address), checksummed, mode),
        }).toEqual({ mode, address, d: "deny" });
      }
    }
    const lower = rules(["alwaysDeny", `ContractInspect(1/${USDT.toLowerCase()})`]);
    expect(await gate("ContractInspect", inspect(USDT), lower, "auto")).toBe("deny");
    // Another address is not caught.
    const other = `${USDT.slice(0, -1)}8`;
    expect(await gate("ContractInspect", inspect(other), checksummed, "auto")).toBe("allow");
  });

  test("a deny written the 0.7.0 way — a bare address, or * — still denies in every mode", async () => {
    // The value is `<chainId>/<address>` and `*` does not cross the `/`, so
    // these rules had become silent no-ops; they match the address alone.
    for (const pattern of [`ContractInspect(${USDT})`, "ContractInspect(*)"]) {
      const deny = rules(["alwaysDeny", pattern]);
      for (const mode of ["default", "auto", "plan"] as const) {
        expect({
          pattern,
          mode,
          d: await gate("ContractInspect", inspect(USDT), deny, mode),
        }).toEqual({ pattern, mode, d: "deny" });
      }
    }
    // An allow must name the chain: a bare `*` grants nothing, so default
    // mode asks (fails closed) rather than granting every chain.
    expect(
      await gate(
        "ContractInspect",
        inspect(USDT),
        rules(["alwaysAllow", "ContractInspect(*)"]),
        "default",
      ),
    ).toBe("ask");
    expect(
      await gate(
        "ContractInspect",
        inspect(USDT),
        rules(["alwaysAllow", "ContractInspect(1/*)"]),
        "default",
      ),
    ).toBe("allow");
  });
});

describe("0.7.1 — a Bash line is read as the commands it runs", () => {
  test("a scoped allow covers every command in the line, or the call asks; build/ survives", async () => {
    const rs = rules(["alwaysAllow", "Bash(echo *)"]);
    for (const command of [
      "echo ok && rm -rf build",
      "echo ok; rm -rf build",
      "echo ok | rm -rf build",
      "echo ok\nrm -rf build",
      "echo $(rm -rf build)",
      "echo `rm -rf build`",
    ]) {
      for (const mode of ["default", "auto"] as const) {
        expect({ command, mode, got: await gate("Bash", { command }, rs, mode) }).toEqual({
          command,
          mode,
          got: "ask",
        });
      }
    }
    expect(existsSync(join(ws, "build"))).toBe(true);
    // Every command matches: allowed, and only echo ran.
    expect(await gate("Bash", { command: "echo ok; echo two" }, rs, "default")).toBe("allow");
  }, 60_000);

  test("a deny fires on any command in the line, in every mode; build/ survives", async () => {
    const rs = rules(["alwaysDeny", "Bash(rm -rf **)"], ["alwaysAllow", "Bash"]);
    for (const command of [
      "echo ok && rm -rf build",
      "echo ok; FOO=1 rm -rf build",
      'echo ok; "r"m -rf build',
      "x=rm; $x -rf build",
      "sh -c 'echo ok; rm -rf build'",
      "read x <<< rm; $x -rf build",
    ]) {
      for (const mode of ["default", "auto", "plan"] as const) {
        expect({ command, mode, got: await gate("Bash", { command }, rs, mode) }).toEqual({
          command,
          mode,
          got: "deny",
        });
      }
    }
    expect(existsSync(join(ws, "build"))).toBe(true);
  }, 60_000);

  test("a `[[ … ]]` test reaches the rule it did on 0.7.0: an unrelated deny stays quiet", async () => {
    // Deny-first with a catch-all ask, as the procode starter writes it.
    const asks = rules(["alwaysDeny", "Bash(**rm -rf **)"], ["alwaysAsk", "Bash"]);
    // Deny-first above a bare allow.
    const allows = rules(["alwaysDeny", "Bash(**sudo **)"], ["alwaysAllow", "Bash"]);
    for (const command of [
      "[[ -f x ]]",
      "[[ -d build ]] || echo missing",
      "if [[ -f crewhaus.yaml ]]; then echo found; fi",
    ]) {
      for (const mode of ["default", "auto"] as const) {
        expect({ command, mode, got: await gate("Bash", { command }, asks, mode) }).toEqual({
          command,
          mode,
          got: "ask",
        });
        expect({ command, mode, got: await gate("Bash", { command }, allows, mode) }).toEqual({
          command,
          mode,
          got: "allow",
        });
      }
    }
  }, 60_000);

  test("an allow written as a chain grants the same chain, piece by piece; build/ survives", async () => {
    const rs = rules(["alwaysAllow", "Bash(cd ** && echo *)"], ["alwaysAsk", "Bash"]);
    for (const mode of ["default", "auto"] as const) {
      expect(await gate("Bash", { command: "cd src && echo ok" }, rs, mode)).toBe("allow");
      for (const command of [
        "cd src && rm -rf ../build",
        "cd src && echo ok && rm -rf ../build",
        "cd src; echo ok",
      ]) {
        expect({ command, mode, got: await gate("Bash", { command }, rs, mode) }).toEqual({
          command,
          mode,
          got: "ask",
        });
      }
    }
    expect(existsSync(join(ws, "build"))).toBe(true);
  }, 60_000);

  test("RunCommand: a deny reads the line an argv hands to sh -c; build/ survives", async () => {
    const rs = rules(["alwaysDeny", "RunCommand(rm -rf **)"], ["alwaysAllow", "RunCommand"]);
    const argv = ["sh", "-c", "echo ok && rm -rf build"];
    for (const mode of ["default", "auto", "plan"] as const) {
      expect(await gate("RunCommand", { argv }, rs, mode)).toBe("deny");
    }
    expect(existsSync(join(ws, "build"))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// A path longer than any path can be
// ---------------------------------------------------------------------------

/**
 * 0.7.1 review — a path past MAX_PATH_CHARS is never walked: the gate reads
 * it as outside the workspace (every deny and ask fires, no allow grants it),
 * and the tool refuses it, naming the path and the limit.
 *
 * The walk to a path's deepest existing name used to read the rest of the
 * path once per missing name, the square of a count the model picks, on the
 * runtime's thread before any rule was read. MAX_PATH_CHARS is twice the
 * longest path any platform opens (every resolver copy declares the same
 * value; tool-registry.test.ts holds them together), so nothing refused here
 * could have been opened or created.
 */
describe("a path longer than any path can be is outside to the gate and refused by the tool", () => {
  const MAX =
    2 * (process.platform === "darwin" ? 1_024 : process.platform === "win32" ? 32_767 : 4_096);
  /** A path below `secrets/prod.db` whose absolute form is exactly `abs` characters. */
  const deepTo = (abs: number): string => {
    const prefix = "secrets/prod.db/";
    const tail = abs - (ws.length + 1 + prefix.length);
    const pairs = Math.floor((tail - 1) / 2);
    return `${prefix}${"a/".repeat(pairs)}${"b".repeat(tail - 2 * pairs)}`;
  };
  const why = (abs: number) =>
    `${abs} characters once resolved, over the ${MAX}-character limit: no path that long can be opened or created`;
  const seedProd = () => {
    mkdirSync(join(ws, "secrets"));
    writeFileSync(join(ws, "secrets", "prod.db"), "precious");
  };

  test("DatabaseBackup: at the limit a scoped allow grants it and the tool resolves it; one past it is outside", async () => {
    seedProd();
    const at = deepTo(MAX);
    const over = `${at}b`;
    const call = (out: string) => ({ database: "secrets/app.db", out });
    // At the limit: walked, named whole, and inside secrets/.
    expect(
      await gate("DatabaseBackup", call(at), rules(["alwaysAllow", "DatabaseBackup(secrets/**)"])),
    ).toBe("allow");
    // The tool resolved it too (and then found no directory to write into).
    expect(lastResult).toStartWith('DatabaseBackup found no directory "secrets/prod.db/a/a/');
    // One past it: no allow grants it, and any deny fires.
    expect(
      await gate(
        "DatabaseBackup",
        call(over),
        rules(["alwaysAllow", "DatabaseBackup(secrets/**)"]),
      ),
    ).toBe("ask");
    expect(
      await gate(
        "DatabaseBackup",
        call(over),
        rules(["alwaysDeny", "DatabaseBackup(elsewhere/**)"], ["alwaysAllow", "DatabaseBackup"]),
      ),
    ).toBe("deny");
    // A bare allow still lets it through (as it lets every call): the tool
    // itself refuses, before any walk, and says why.
    expect(await gate("DatabaseBackup", call(over), rules(["alwaysAllow", "DatabaseBackup"]))).toBe(
      "allow",
    );
    expect(lastResult).toBe(`tool "DatabaseBackup" rejected path "${over}": it is ${why(MAX + 1)}`);
    expect(readFileSync(join(ws, "secrets", "prod.db"), "utf8")).toBe("precious");
  }, 60_000);

  test("every tool that rewords a refusal says this one for what it is", async () => {
    seedProd();
    const long = `secrets/${"a/".repeat(MAX / 2)}x`;
    const abs = ws.length + 1 + long.length;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["DatabaseBackup", { database: "app.db", out: long }],
      ["SqlQuery", { database: long, sql: "select 1" }],
      ["CiWorkflowAudit", { path: long }],
      ["Typecheck", { cwd: long }],
      ["Lint", { paths: [long] }],
      ["SymbolOutline", { file: long }],
      ["DocsSymbolCheck", { source: long, docsText: "`x`" }],
      ["DocsSymbolCheck", { docs: [long] }],
      ["DiffLint", { cwd: long }],
      ["DiffLint", { paths: [long] }],
      ["SystemInfo", { diskPath: long }],
      ["IndexBuild", { name: "i", paths: [long] }],
      [
        "RouteControl",
        { action: "status", dir: long, justification: "permission hardening: a refused path" },
      ],
      [
        "SpecPin",
        { name: "x", specFile: long, justification: "permission hardening: a refused path" },
      ],
      ["MarketplaceSearch", { registryDir: long }],
      ["HarnessJobStatus", { dir: long }],
      ["StoreMigrate", { to: long, justification: "permission hardening: a refused path" }],
      ["AcceptanceCheck", { checks: [{ kind: "fileExists", path: long }] }],
      ["SeoLint", { html: "<html><head><title>t</title></head></html>", corpus: long }],
    ];
    const wrong: Array<{ tool: string; input: string; decision?: string; said: string }> = [];
    // Rows whose own schema stops the value first. The limit is the
    // platform's, a schema's cap is not: SystemInfo's diskPath stops at 4,096
    // characters, above the limit on macOS (2,048) and below it on Linux
    // (8,192), where its path code is never reached. Such a call is refused
    // before any rule is read (no decision), in the schema's words, which
    // name a length too. Those rows are listed below, so a cap that starts
    // hiding a row on this platform is a failure here.
    const capped: string[] = [];
    for (const [tool, input] of cases) {
      const parsed = builtin(tool).inputSchema.safeParse(input);
      const caps = parsed.success
        ? []
        : parsed.error.issues.map((i) =>
            i.code === "too_big" && i.type === "string" && Number(i.maximum) < long.length
              ? Number(i.maximum)
              : undefined,
          );
      const decision = await gate(tool, input, rules(), "bypass");
      const said = lastResult ?? "";
      const named =
        caps.length === 0
          ? said.includes(why(abs))
          : caps.every((max) => max !== undefined && said.includes(`at most ${max} character`));
      const decided = caps.length === 0 ? decision === "allow" : decision === undefined;
      if (!decided || !named || /outside the|escapes the/.test(said)) {
        const keys = Object.keys(input).join(",");
        wrong.push({
          tool,
          input: keys,
          ...(decision ? { decision } : {}),
          said: said.slice(0, 160),
        });
      }
      if (caps.length > 0) capped.push(tool);
    }
    expect(wrong).toEqual([]);
    expect(capped).toEqual(long.length > 4_096 ? ["SystemInfo"] : []);
  }, 120_000);
});

/** One response per step: each tool_use in turn, then "done". */
function scripted(steps: ReadonlyArray<{ name: string; input: unknown }>): ProviderAdapter {
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
    stream: () => {
      const step = steps[i];
      i++;
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block:
            step !== undefined
              ? { type: "tool_use", id: `tu_${i}`, name: step.name, input: {} }
              : { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta:
            step !== undefined
              ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) }
              : { type: "text_delta", text: "done" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: step !== undefined ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

describe("critic7 — a headless grant covers the place it was asked for, not where a link points later", () => {
  // The operator grants a Write to `pub/link/x.md` while `pub/link` points
  // at `public/`. In the resumed turn an ALLOWED call (here `ln -sfn`, through
  // the real RunCommand) retargets the link at `secrets/`, which an alwaysAsk
  // rule names; then the model re-issues the identical Write. 0.7.1 before
  // this fix spent the grant and the real Write rewrote `secrets/x.md`.
  const sessionId = "sess_0123456789abcdef";
  const write = { path: "pub/link/x.md", content: "approved for public/" };
  const rs = rules(["alwaysAsk", "Write(secrets/**)"], ["alwaysAllow", "RunCommand(ln **)"]);

  let store: ReturnType<typeof createPendingApprovalStore>;
  beforeEach(() => {
    mkdirSync(join(ws, "pub"));
    mkdirSync(join(ws, "public"));
    mkdirSync(join(ws, "secrets"));
    symlinkSync("../public", join(ws, "pub", "link"));
    store = createPendingApprovalStore({ rootDir: join(state, "approvals") });
  });

  /** A headless turn of the real builtins; the park's detail, if it parked. */
  async function turn(steps: ReadonlyArray<{ name: string; input: unknown }>) {
    const where = relative(ws, process.cwd());
    if (where.startsWith("..") || isAbsolute(where) || !existsSync(ws)) {
      throw new Error(`turn outlived its test's workspace; refusing to run in ${process.cwd()}`);
    }
    let parked: string | undefined;
    await runChatLoop({
      model: "test-model",
      instructions: "approval places",
      runContext: createRunContext({ sessionId }),
      sessionRootDir: mkdtempSync(join(state, "sess-")),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "default",
      permissionRules: rs,
      tools: [builtin("Write"), builtin("RunCommand")],
      approvals: { store },
      _adapter: scripted(steps),
    }).catch((err: { report?: { class?: string; detail?: string } }) => {
      if (err.report?.class !== "approval_pending") throw err;
      parked = err.report.detail;
    });
    return parked;
  }
  const idIn = (detail: string | undefined) =>
    /parked as approval (appr_[0-9a-f]{16})/.exec(detail ?? "")?.[1];

  async function park(input: unknown = write): Promise<string> {
    const id = idIn(await turn([{ name: "Write", input }]));
    if (id === undefined) throw new Error("the Write did not park");
    expect(existsSync(join(ws, "public", "x.md"))).toBe(false);
    return id;
  }
  async function parkAndGrant(input: unknown = write): Promise<string> {
    const id = await park(input);
    await store.resolve(id, "grant", "operator");
    return id;
  }
  const record = async (id: string | undefined) => (await store.list()).find((a) => a.id === id);

  test("retargeted by an allowed call in the resumed turn: the grant is not spent, secrets/ is untouched", async () => {
    const granted = await parkAndGrant();
    const detail = await turn([
      { name: "RunCommand", input: { argv: ["ln", "-sfn", "../secrets", "pub/link"] } },
      { name: "Write", input: write },
    ]);
    // The allowed call ran: the link now points at secrets/.
    expect(realpathSync(join(ws, "pub", "link"))).toBe(join(ws, "secrets"));
    // The Write did not: asked again, naming where it was approved and where it lands now.
    expect(existsSync(join(ws, "secrets", "x.md"))).toBe(false);
    expect(existsSync(join(ws, "public", "x.md"))).toBe(false);
    expect(detail).toContain(
      `approval ${granted} was granted for pub/link/x.md -> ${ws}/public/x.md, and the call now lands at pub/link/x.md -> ${ws}/secrets/x.md, so it is asked again`,
    );
    expect((await record(granted))?.consumedAt).toBeUndefined();
    // critic8: the new park carries the one it stands in for, so a card can
    // tell it from the card the operator already granted.
    const reparked = await record(idIn(detail));
    expect(reparked?.places).toEqual([{ path: "pub/link/x.md", at: [`${ws}/secrets/x.md`] }]);
    expect(reparked?.supersedes).toEqual({
      id: granted,
      decision: "grant",
      places: [{ path: "pub/link/x.md", at: [`${ws}/public/x.md`] }],
    });
    expect(formatApprovalDetail(reparked as NonNullable<typeof reparked>)).toContain(
      `lands at:\n  pub/link/x.md -> ${ws}/secrets/x.md\nasked again: approval ${granted} was granted where the call landed at:\n  pub/link/x.md -> ${ws}/public/x.md\n`,
    );
  }, 60_000);

  test("control: the link left where it was, the same resumed turn spends the grant and writes public/x.md", async () => {
    const granted = await parkAndGrant();
    const detail = await turn([
      { name: "RunCommand", input: { argv: ["ln", "-sfn", "../public", "pub/link"] } },
      { name: "Write", input: write },
    ]);
    expect(detail).toBeUndefined();
    expect(readFileSync(join(ws, "public", "x.md"), "utf8")).toBe(write.content);
    expect(existsSync(join(ws, "secrets", "x.md"))).toBe(false);
    expect((await store.list()).find((a) => a.id === granted)?.consumedAt).toBeDefined();
  }, 60_000);

  // critic8: binding keeps a call from RUNNING somewhere unapproved. A deny
  // runs nothing wherever the call lands, so it is honoured as 0.7.0 did;
  // asking again would only add a prompt, and a chance of a mistaken grant.
  test("a refusal still refuses once an allowed call moves the link: denied, not asked again", async () => {
    const denied = await park();
    await store.resolve(denied, "deny", "operator");
    const detail = await turn([
      { name: "RunCommand", input: { argv: ["ln", "-sfn", "../secrets", "pub/link"] } },
      { name: "Write", input: write },
    ]);
    expect(realpathSync(join(ws, "pub", "link"))).toBe(join(ws, "secrets"));
    expect(detail).toBeUndefined();
    expect(existsSync(join(ws, "secrets", "x.md"))).toBe(false);
    expect(existsSync(join(ws, "public", "x.md"))).toBe(false);
    expect((await store.list()).map((a) => a.id)).toEqual([denied]);
  }, 60_000);

  test("a refusal made before approvals were bound refuses a call through a link", async () => {
    // As 0.7.0 wrote it: no `places`.
    const legacy = "appr_00000000000000bb";
    await store.persist({
      id: legacy,
      toolName: "Write",
      inputHash: hashApprovalInput("Write", write),
      input: write,
      runId: "run_old",
      sessionId,
      surface: "single-turn",
      createdAt: new Date().toISOString(),
    });
    await store.resolve(legacy, "deny", "operator");
    expect(await turn([{ name: "Write", input: write }])).toBeUndefined();
    expect(existsSync(join(ws, "public", "x.md"))).toBe(false);
    expect((await store.list()).map((a) => a.id)).toEqual([legacy]);
  }, 60_000);

  describe("in a directory that can be searched but not read (mode 0300)", () => {
    // critic8: `realpath` fails in `d` on macOS and listing it fails
    // everywhere; the file tools need neither, only search permission to
    // open a name. The place recorded for `d/x.md` read the same wherever the
    // link there pointed, so the grant for public/ was spent after an
    // allowed `ln` pointed it at secrets/ — and a grant for a new file was
    // spent on a link made there afterwards.
    const dx = { path: "d/x.md", content: "approved for d/x.md" };
    beforeEach(() => mkdirSync(join(ws, "d")));
    // Before the workspace is removed: removing it lists `d`.
    afterEach(() => chmodSync(join(ws, "d"), 0o755));

    test("a leaf link retargeted by an allowed call: asked again, secrets/ untouched", async () => {
      symlinkSync("../public/x.md", join(ws, "d", "x.md"));
      chmodSync(join(ws, "d"), 0o300);
      const granted = await parkAndGrant(dx);
      expect((await record(granted))?.places).toEqual([
        { path: "d/x.md", at: [`${ws}/d/x.md`, `${ws}/public/x.md`] },
      ]);
      const detail = await turn([
        { name: "RunCommand", input: { argv: ["ln", "-sfn", "../secrets/x.md", "d/x.md"] } },
        { name: "Write", input: dx },
      ]);
      expect(readlinkSync(join(ws, "d", "x.md"))).toBe("../secrets/x.md");
      expect(existsSync(join(ws, "secrets", "x.md"))).toBe(false);
      expect(existsSync(join(ws, "public", "x.md"))).toBe(false);
      expect(detail).toContain(
        `approval ${granted} was granted for d/x.md -> ${ws}/d/x.md and ${ws}/public/x.md, and the call now lands at d/x.md -> ${ws}/d/x.md and ${ws}/secrets/x.md, so it is asked again`,
      );
      expect((await record(granted))?.consumedAt).toBeUndefined();
    }, 60_000);

    test("a grant for a new file there is not spent on a link an allowed call makes there", async () => {
      writeFileSync(join(ws, "secrets", "x.md"), "SECRET ORIGINAL\n");
      chmodSync(join(ws, "d"), 0o300);
      const granted = await parkAndGrant(dx);
      const detail = await turn([
        { name: "RunCommand", input: { argv: ["ln", "-s", "../secrets/x.md", "d/x.md"] } },
        { name: "Write", input: dx },
      ]);
      expect(readlinkSync(join(ws, "d", "x.md"))).toBe("../secrets/x.md");
      expect(readFileSync(join(ws, "secrets", "x.md"), "utf8")).toBe("SECRET ORIGINAL\n");
      expect(detail).toContain(`approval ${granted} was granted for d/x.md -> ${ws}/d/x.md,`);
      expect((await record(granted))?.consumedAt).toBeUndefined();
    }, 60_000);

    test("control: the link left where it was, the grant runs once and writes public/x.md", async () => {
      symlinkSync("../public/x.md", join(ws, "d", "x.md"));
      chmodSync(join(ws, "d"), 0o300);
      const granted = await parkAndGrant(dx);
      expect(await turn([{ name: "Write", input: dx }])).toBeUndefined();
      expect(readFileSync(join(ws, "public", "x.md"), "utf8")).toBe(dx.content);
      expect(existsSync(join(ws, "secrets", "x.md"))).toBe(false);
      expect((await record(granted))?.consumedAt).toBeDefined();
      // Spent: the same call is asked again.
      expect(idIn(await turn([{ name: "Write", input: dx }]))).toBeDefined();
    }, 60_000);
  });
});

// critic8 (0.7.1): a command word naming a file was read as text, its `..`
// collapsed before any link was followed. The kernel follows each link
// first, so `link/../run.sh` with `link → secrets/deep` runs
// `secrets/run.sh`, and `./scripts/../evil.sh` runs `./evil.sh`, which
// `RunCommand(./scripts/**)` granted. Every script below appends its name
// to a marker outside the workspace, so what ran is read from disk.
describe("critic8 — a program path read where the kernel finds it", () => {
  let marker: string;
  let outside: string;
  beforeEach(() => {
    marker = join(state, "ran.log");
    writeFileSync(marker, "");
    outside = realpathSync(mkdtempSync(join(tmpdir(), "perm-real-outside-")));
    for (const d of ["scripts", "secrets/deep", "safe", "evil", "node_modules/.bin"]) {
      mkdirSync(join(ws, d), { recursive: true });
    }
    mkdirSync(join(outside, "real"));
    symlinkSync("secrets/deep", join(ws, "link"));
    symlinkSync("safe", join(ws, "tools"));
    symlinkSync("evil", join(ws, "ev"));
    symlinkSync("../evil", join(ws, "scripts", "lnk"));
    symlinkSync("../../scripts/ok.sh", join(ws, "node_modules", ".bin", "tool"));
    symlinkSync("real", join(outside, "lnk"));
    const script = (at: string, name: string) =>
      writeFileSync(at, `#!/bin/sh\necho ${name} >> "${marker}"\n`, { mode: 0o755 });
    for (const p of [
      "deploy-prod.sh",
      "evil.sh",
      "build.sh",
      "run.sh",
      "scripts/ok.sh",
      "secrets/run.sh",
      "safe/run.sh",
      "evil/run.sh",
    ]) {
      script(join(ws, p), p);
    }
    script(join(outside, "real", "run.sh"), "outside/real/run.sh");
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });
  const ran = () => readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).join(",");
  const retry = { maxAttempts: 1, backoff: { kind: "fixed", delayMs: 0 } };
  /** The same argv on each tool that runs one, run from the workspace root. */
  const onEvery = (argv: string[]): Array<[string, Record<string, unknown>]> => [
    ["RunCommand", { argv }],
    ["ProcessStart", { argv }],
    ["Retry", { argv, ...retry }],
    ["RunPipeline", { steps: [{ argv }] }],
    ["Bash", { command: argv.join(" ") }],
  ];
  /** Each call's first decision and what ran, one row per call. */
  async function decide(
    calls: ReadonlyArray<[string, Record<string, unknown>]>,
    ruleSet: (tool: string) => RuleSet,
  ) {
    const rows: Array<{ tool: string; input: Record<string, unknown>; got?: string; ran: string }> =
      [];
    for (const [tool, input] of calls) {
      writeFileSync(marker, "");
      const got = await gate(tool, input, ruleSet(tool));
      rows.push({ tool, input, ...(got !== undefined ? { got } : {}), ran: ran() });
    }
    return rows;
  }
  const expectAll = (
    rows: Awaited<ReturnType<typeof decide>>,
    got: string,
    ranWhat: (tool: string) => string = () => "",
  ) => expect(rows).toEqual(rows.map((r) => ({ ...r, got, ran: ranWhat(r.tool) })));

  test("a deny naming the program fires on a `..` spelling of it, and nothing runs", async () => {
    const calls = [
      ...onEvery(["./scripts/../deploy-prod.sh"]),
      ...onEvery(["scripts/../deploy-prod.sh"]),
      ...onEvery(["./scripts/./../deploy-prod.sh", "--force"]),
    ];
    const rows = await decide(calls, (tool) =>
      rules(["alwaysDeny", `${tool}(./deploy-prod.sh*)`], ["alwaysAllow", tool]),
    );
    expectAll(rows, "deny");
  }, 60_000);

  test("a symlinked directory is followed before the `..` after it, as the kernel does", async () => {
    // Each runs secrets/run.sh: through `link`, then `..` out of its target.
    const calls: Array<[string, Record<string, unknown>]> = [
      ...onEvery(["link/../run.sh"]),
      ...onEvery(["./link/../run.sh"]),
      ...onEvery(["sh", "link/../run.sh"]),
      ...onEvery(["env", "FOO=1", "link/../run.sh"]),
      ["RunCommand", { argv: ["../link/../run.sh"], cwd: "scripts" }],
      ["RunCommand", { argv: ["bash", "../link/../run.sh"], cwd: "scripts" }],
      ["RunCommand", { argv: ["sh", "-c", "link/../run.sh"] }],
      ["RunPipeline", { steps: [{ argv: ["../link/../run.sh"], cwd: "scripts" }] }],
      ["RunPipeline", { cwd: "scripts", steps: [{ argv: ["sh", "../link/../run.sh"] }] }],
      ["Bash", { command: "true && sh link/../run.sh" }],
      // Read from where the line moved: scripts/.., then through link.
      ["Bash", { command: "cd scripts && ../link/../run.sh" }],
    ];
    const rows = await decide(calls, (tool) =>
      rules(["alwaysDeny", `${tool}(secrets/**)`], ["alwaysAllow", tool]),
    );
    expectAll(rows, "deny");
    // With no `..` at all: `ev` is evil/, and a deny or ask there reads it.
    for (const type of ["alwaysDeny", "alwaysAsk"] as const) {
      const through = await decide(onEvery(["./ev/run.sh"]), (tool) =>
        rules([type, `${tool}(evil/**)`], ["alwaysAllow", tool]),
      );
      expectAll(through, type === "alwaysDeny" ? "deny" : "ask");
    }
  }, 120_000);

  test("an allow scoped to a directory does not grant a program `..` or a link takes out of it", async () => {
    const calls = [
      ...onEvery(["./scripts/../evil.sh"]),
      ...onEvery(["./scripts/lnk/run.sh"]),
      ...onEvery(["./scripts/lnk/../../evil.sh"]),
    ];
    const rows = await decide(calls, (tool) => rules(["alwaysAllow", `${tool}(./scripts/**)`]));
    expectAll(rows, "ask");
    // Handed to an interpreter, the script is read the same way.
    const handed = await decide(
      [
        ["RunCommand", { argv: ["sh", "./scripts/../evil.sh"] }],
        ["RunCommand", { argv: ["sh", "scripts/lnk/run.sh"] }],
        ["Bash", { command: "sh ./scripts/../evil.sh" }],
      ],
      (tool) =>
        rules(
          ["alwaysAllow", `${tool}(sh ./scripts/**)`],
          ["alwaysAllow", `${tool}(sh scripts/**)`],
        ),
    );
    expectAll(handed, "ask");
  }, 60_000);

  test("the code runners and the hook manager read their command the same way", async () => {
    const hook = { action: "set", hook: "postCompile" };
    const denied = await decide(
      [
        ["RunBuild", { command: ["link/../run.sh"] }],
        ["RunTests", { command: ["sh", "link/../run.sh"] }],
        ["Format", { command: ["./link/../run.sh"] }],
        ["HooksManage", { ...hook, command: "link/../run.sh" }],
        ["HooksManage", { ...hook, command: ["bash", "link/../run.sh"] }],
      ],
      (tool) => rules(["alwaysDeny", `${tool}(secrets/**)`], ["alwaysAllow", tool]),
    );
    expectAll(denied, "deny");
    const asked = await decide(
      [
        ["RunBuild", { command: ["./scripts/../evil.sh"] }],
        ["RunTests", { command: ["./scripts/lnk/run.sh"] }],
        ["Format", { command: ["./scripts/../evil.sh"] }],
        ["HooksManage", { ...hook, command: "./scripts/../evil.sh" }],
      ],
      (tool) => rules(["alwaysAllow", `${tool}(./scripts/**)`]),
    );
    expectAll(asked, "ask");
    expect(existsSync(join(ws, ".crewhaus", "settings.json"))).toBe(false);
  }, 60_000);

  test("an allow reads the place the program lands, and a call it names there runs", async () => {
    const rows = await decide(
      [
        ["RunCommand", { argv: ["./scripts/../deploy-prod.sh"] }],
        ["RunPipeline", { steps: [{ argv: ["./tools/run.sh"] }] }],
        ["Retry", { argv: ["sh", "tools/run.sh"], ...retry }],
      ],
      (tool) =>
        rules(
          ["alwaysAllow", `${tool}(./deploy-prod.sh)`],
          ["alwaysAllow", `${tool}(./safe/run.sh)`],
          ["alwaysAllow", `${tool}(sh safe/run.sh)`],
        ),
    );
    expect(rows.map((r) => [r.got, r.ran])).toEqual([
      ["allow", "deploy-prod.sh"],
      ["allow", "safe/run.sh"],
      ["allow", "safe/run.sh"],
    ]);
    // Named through the link it does not land under, it asks.
    expect(
      await gate(
        "RunCommand",
        { argv: ["./tools/run.sh"] },
        rules(["alwaysAllow", "RunCommand(./tools/**)"]),
      ),
    ).toBe("ask");
    // A Bash line cannot have its words put in their place: an allow must
    // name the line as written, and the command with the program where it
    // lands.
    writeFileSync(marker, "");
    const bash = { command: "./scripts/../deploy-prod.sh" };
    expect(await gate("Bash", bash, rules(["alwaysAllow", "Bash(./deploy-prod.sh)"]))).toBe("ask");
    expect(ran()).toBe("");
    expect(await gate("Bash", bash, rules(["alwaysAllow", "Bash(**)"]))).toBe("allow");
    expect(ran()).toBe("deploy-prod.sh");
  }, 120_000);

  /** Denies about other places, and an allow of everything else. */
  const unrelated = (tool: string) =>
    rules(
      ["alwaysDeny", `${tool}(./deploy-prod.sh)`],
      ["alwaysDeny", `${tool}(secrets/**)`],
      ["alwaysAllow", tool],
    );

  test("control: ordinary programs, bare names and arguments with `..` run as before", async () => {
    const tools = ["RunCommand", "Retry", "RunPipeline", "Bash"];
    const build = await decide(
      onEvery(["./build.sh"]).filter(([t]) => tools.includes(t)),
      (tool) => rules(["alwaysAllow", `${tool}(./build.sh)`]),
    );
    expectAll(build, "allow", () => "build.sh");
    // A deny elsewhere does not fire on them.
    const ordinary = await decide(
      [
        ["RunCommand", { argv: ["true"] }],
        ["RunCommand", { argv: ["sh", "scripts/ok.sh"] }],
        ["RunCommand", { argv: ["echo", "scripts/../run.sh"] }],
        ["RunCommand", { argv: ["sh", "-c", "echo link/../run.sh"] }],
        ["Bash", { command: "echo link/../run.sh" }],
        ["RunPipeline", { steps: [{ argv: ["git", "--version"], cwd: "scripts" }] }],
      ],
      unrelated,
    );
    expect(ordinary.map((r) => [r.input, r.got, r.ran])).toEqual(
      ordinary.map((r) => [
        r.input,
        "allow",
        r.input["argv"]?.toString() === "sh,scripts/ok.sh" ? "scripts/ok.sh" : "",
      ]),
    );
    // A scoped allow on the argument still grants it: it is not a program.
    expect(
      await gate(
        "RunCommand",
        { argv: ["echo", "a/../b"] },
        rules(["alwaysAllow", "RunCommand(echo a/../b)"]),
      ),
    ).toBe("allow");
  }, 120_000);

  test("control: a program reached through a link to it, and one outside the workspace, keep their names", async () => {
    // A program reached through a link to it is named by the link; a deny on
    // where the link leads still fires.
    const bin = { argv: ["./node_modules/.bin/tool"] };
    expect(
      await gate("RunCommand", bin, rules(["alwaysAllow", "RunCommand(./node_modules/.bin/*)"])),
    ).toBe("allow");
    expect(ran()).toBe("scripts/ok.sh");
    writeFileSync(marker, "");
    expect(await gate("RunCommand", bin, unrelated("RunCommand"))).toBe("allow");
    expect(
      await gate(
        "RunCommand",
        bin,
        rules(["alwaysDeny", "RunCommand(scripts/**)"], ["alwaysAllow", "RunCommand"]),
      ),
    ).toBe("deny");
    expect(ran()).toBe("scripts/ok.sh");
    // Outside the workspace, an absolute program keeps the name it was
    // given (the system's own links are not the call's to move), and a deny
    // on where it lands still fires.
    writeFileSync(marker, "");
    const sys = { argv: [join(outside, "lnk", "run.sh")] };
    expect(
      await gate("RunCommand", sys, rules(["alwaysAllow", `RunCommand(${outside}/lnk/run.sh)`])),
    ).toBe("allow");
    expect(ran()).toBe("outside/real/run.sh");
    expect(
      await gate(
        "RunCommand",
        sys,
        rules(["alwaysDeny", `RunCommand(${outside}/real/**)`], ["alwaysAllow", "RunCommand"]),
      ),
    ).toBe("deny");
  }, 120_000);
});

// critic8 (0.7.1): a headless grant was bound to the paths a call names, and
// a command's program was not one of them: RunCommand ["./tools/run.sh"]
// with tools → safe parked with no places, and once an allowed call in the
// resumed turn pointed tools at evil/, the same call spent the grant and ran
// evil/run.sh.
describe("critic8 — a headless grant for a command covers the program it was asked for", () => {
  const sessionId = "sess_0123456789abcdef";
  const call = { argv: ["./tools/run.sh"] };
  const rs = rules(["alwaysAllow", "RunCommand(ln **)"]);
  let marker: string;
  let store: ReturnType<typeof createPendingApprovalStore>;
  beforeEach(() => {
    marker = join(state, "ran.log");
    writeFileSync(marker, "");
    for (const d of ["safe", "evil"]) {
      mkdirSync(join(ws, d));
      writeFileSync(join(ws, d, "run.sh"), `#!/bin/sh\necho ${d}/run.sh >> "${marker}"\n`, {
        mode: 0o755,
      });
    }
    symlinkSync("safe", join(ws, "tools"));
    store = createPendingApprovalStore({ rootDir: join(state, "approvals") });
  });
  const ran = () => readFileSync(marker, "utf8").trim();

  async function turn(steps: ReadonlyArray<{ name: string; input: unknown }>) {
    const where = relative(ws, process.cwd());
    if (where.startsWith("..") || isAbsolute(where) || !existsSync(ws)) {
      throw new Error(`turn outlived its test's workspace; refusing to run in ${process.cwd()}`);
    }
    let parked: string | undefined;
    await runChatLoop({
      model: "test-model",
      instructions: "approval places",
      runContext: createRunContext({ sessionId }),
      sessionRootDir: mkdtempSync(join(state, "sess-")),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "default",
      permissionRules: rs,
      tools: [builtin("RunCommand")],
      approvals: { store },
      _adapter: scripted(steps),
    }).catch((err: { report?: { class?: string; detail?: string } }) => {
      if (err.report?.class !== "approval_pending") throw err;
      parked = err.report.detail;
    });
    return parked;
  }
  const idIn = (detail: string | undefined) =>
    /parked as approval (appr_[0-9a-f]{16})/.exec(detail ?? "")?.[1];
  const record = async (id: string | undefined) => (await store.list()).find((a) => a.id === id);
  async function parkAndGrant(): Promise<string> {
    const id = idIn(await turn([{ name: "RunCommand", input: call }]));
    if (id === undefined) throw new Error("the RunCommand did not park");
    expect(ran()).toBe("");
    expect((await record(id))?.places).toEqual([
      { path: "./tools/run.sh", at: [`${ws}/safe/run.sh`] },
    ]);
    await store.resolve(id, "grant", "operator");
    return id;
  }

  test("retargeted by an allowed call in the resumed turn: asked again, evil/run.sh never runs", async () => {
    const granted = await parkAndGrant();
    const detail = await turn([
      { name: "RunCommand", input: { argv: ["ln", "-sfn", "evil", "tools"] } },
      { name: "RunCommand", input: call },
    ]);
    expect(realpathSync(join(ws, "tools"))).toBe(join(ws, "evil"));
    expect(ran()).toBe("");
    expect(detail).toContain(
      `approval ${granted} was granted for ./tools/run.sh -> ${ws}/safe/run.sh, and the call now lands at ./tools/run.sh -> ${ws}/evil/run.sh, so it is asked again`,
    );
    expect((await record(granted))?.consumedAt).toBeUndefined();
  }, 60_000);

  test("control: the link left where it was, the grant runs safe/run.sh once", async () => {
    const granted = await parkAndGrant();
    const detail = await turn([
      { name: "RunCommand", input: { argv: ["ln", "-sfn", "safe", "tools"] } },
      { name: "RunCommand", input: call },
    ]);
    expect(detail).toBeUndefined();
    expect(ran()).toBe("safe/run.sh");
    expect((await record(granted))?.consumedAt).toBeDefined();
  }, 60_000);

  test("a grant made before approvals were bound covers a program only where it reads", async () => {
    // As 0.7.0 wrote it: no `places`. Through `tools`, the program is not
    // where the call names it, so the call is asked again.
    for (const [argv, runs] of [
      [["./tools/run.sh"], ""],
      [["./safe/run.sh"], "safe/run.sh"],
    ] as const) {
      writeFileSync(marker, "");
      const input = { argv: [...argv] };
      const legacy = `appr_00000000000000${argv[0] === "./safe/run.sh" ? "cd" : "ab"}`;
      await store.persist({
        id: legacy,
        toolName: "RunCommand",
        inputHash: hashApprovalInput("RunCommand", input),
        input,
        runId: "run_old",
        sessionId,
        surface: "single-turn",
        createdAt: new Date().toISOString(),
      });
      await store.resolve(legacy, "grant", "operator");
      const detail = await turn([{ name: "RunCommand", input }]);
      expect({ argv, parked: idIn(detail) !== undefined, ran: ran() }).toEqual({
        argv,
        parked: runs === "",
        ran: runs,
      });
    }
  }, 60_000);
});

// command-dotdot review (0.7.1): the program-path reading above covered a
// program written at the root with a relative `..`, and left out the other
// places a command's program is spelled. Each case below ran its script past
// the rule before; every script appends its name to a marker outside the
// workspace, so what ran is read from disk.
describe("command-dotdot review — a program read where it lands, however the call spells it", () => {
  let marker: string;
  let outside: string;
  beforeEach(() => {
    marker = join(state, "ran.log");
    writeFileSync(marker, "");
    outside = realpathSync(mkdtempSync(join(tmpdir(), "perm-cdd-outside-")));
    for (const d of [
      "scripts",
      "secrets/deep",
      "safe",
      "evil",
      "lib",
      "packages/app",
      "node_modules/.bin",
      "node_modules/.pnpm/tool@1.0.0/node_modules/tool/bin",
    ]) {
      mkdirSync(join(ws, d), { recursive: true });
    }
    symlinkSync("secrets/deep", join(ws, "link"));
    symlinkSync("safe", join(ws, "tools"));
    symlinkSync(".pnpm/tool@1.0.0/node_modules/tool", join(ws, "node_modules", "tool"));
    mkdirSync(join(outside, "tools"));
    mkdirSync(join(outside, "real", "sub"), { recursive: true });
    symlinkSync(join(outside, "real", "sub"), join(outside, "tools", "lnk"));
    const script = (at: string, name: string) =>
      writeFileSync(at, `#!/bin/sh\necho ${name} >> "${marker}"\n`, { mode: 0o755 });
    for (const p of [
      "run.sh",
      "gen.sh",
      "scripts/ok.sh",
      "secrets/run.sh",
      "secrets/deep/d.sh",
      "safe/run.sh",
      "evil/run.sh",
      "node_modules/.bin/vt",
      "node_modules/.pnpm/tool@1.0.0/node_modules/tool/bin/cli.sh",
    ]) {
      script(join(ws, p), p);
    }
    script(join(outside, "tools", "ok.sh"), "out/tools/ok.sh");
    script(join(outside, "evil.sh"), "out/evil.sh");
    script(join(outside, "real", "evil2.sh"), "out/real/evil2.sh");
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });
  const ran = () => readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).join(",");
  /** Each call's first decision and what ran, one row per call. */
  async function decide(
    calls: ReadonlyArray<[string, Record<string, unknown>]>,
    ruleSet: (tool: string) => RuleSet,
  ) {
    const rows: Array<{ tool: string; input: Record<string, unknown>; got?: string; ran: string }> =
      [];
    for (const [tool, input] of calls) {
      writeFileSync(marker, "");
      const got = await gate(tool, input, ruleSet(tool));
      rows.push({ tool, input, ...(got !== undefined ? { got } : {}), ran: ran() });
    }
    return rows;
  }
  const expectAll = (rows: Awaited<ReturnType<typeof decide>>, got: string, ranWhat = "") =>
    expect(rows).toEqual(rows.map((r) => ({ ...r, got, ran: ranWhat })));
  /** A deny on one place and an allow of everything else. */
  const denyOnly = (place: string) => (tool: string) =>
    rules(["alwaysDeny", `${tool}(${place})`], ["alwaysAllow", tool]);

  test("an absolute program outside the workspace is read where a `..` after a name takes it", async () => {
    const out = outside;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["RunCommand", { argv: [`${out}/tools/../evil.sh`] }],
      ["RunCommand", { argv: [`${out}/tools/lnk/../evil2.sh`] }],
      ["Bash", { command: `${out}/tools/../evil.sh` }],
      ["Bash", { command: `${out}/tools/lnk/../evil2.sh` }],
    ];
    expectAll(
      await decide(calls, (tool) => rules(["alwaysAllow", `${tool}(${out}/tools/**)`])),
      "ask",
    );
    const handed = await decide(
      [
        ["RunCommand", { argv: ["sh", `${out}/tools/../evil.sh`] }],
        ["Bash", { command: `sh ${out}/tools/../evil.sh` }],
      ],
      (tool) => rules(["alwaysAllow", `${tool}(sh ${out}/tools/**)`]),
    );
    expectAll(handed, "ask");
    // Control: the program it names on its face runs.
    const ok = await decide(
      [
        ["RunCommand", { argv: [`${out}/tools/ok.sh`] }],
        ["Bash", { command: `${out}/tools/ok.sh` }],
      ],
      (tool) => rules(["alwaysAllow", `${tool}(${out}/tools/**)`]),
    );
    expectAll(ok, "allow", "out/tools/ok.sh");
  }, 120_000);

  test("a program after a `cd` or a wrapper's directory is read from there", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["Bash", { command: "cd secrets && ./run.sh" }],
      ["Bash", { command: "cd link && ./d.sh" }],
      ["Bash", { command: "cd link && sh ../run.sh" }],
      ["Bash", { command: "cd -P link/.. && ./run.sh" }],
      ["Bash", { command: "cd scripts; cd ../secrets && ./run.sh" }],
      ["Bash", { command: "env -C link ./d.sh" }],
      ["RunCommand", { argv: ["env", "-C", "link", "./d.sh"] }],
      ["RunCommand", { argv: ["env", "--chdir=secrets", "sh", "run.sh"] }],
      ["RunCommand", { argv: ["env", "-C", "link", "sh", "-c", "cd .. && ./run.sh"] }],
    ];
    expectAll(await decide(calls, denyOnly("secrets/**")), "deny");
  }, 120_000);

  test("control: a monorepo line that moves and climbs back runs under a deny about something else", async () => {
    // An operator who allows everything except one thing: these ran before,
    // and run now.
    const lines = [
      ["cd packages/app && ../../node_modules/.bin/vt", "node_modules/.bin/vt"],
      ["cd packages/app && sh ../../gen.sh", "gen.sh"],
      ["cd packages/app && cd ../.. && ./scripts/ok.sh", "scripts/ok.sh"],
    ] as const;
    for (const deny of ["Bash(rm -rf *)", "Bash(secrets/**)", "Bash(./run.sh)"]) {
      const rows = await decide(
        lines.map(([command]) => ["Bash", { command }]),
        () => rules(["alwaysDeny", deny], ["alwaysAllow", "Bash"]),
      );
      expect({ deny, rows: rows.map((r) => [r.got, r.ran]) }).toEqual({
        deny,
        rows: lines.map(([, runs]) => ["allow", runs]),
      });
    }
    // An ask about something else does not ask.
    expect(
      await gate(
        "Bash",
        { command: "cd packages/app && sh ../../gen.sh" },
        rules(["alwaysAsk", "Bash(git push*)"], ["alwaysAllow", "Bash"]),
      ),
    ).toBe("allow");
    // An allow scoped to the chain still grants it: nothing moved.
    writeFileSync(marker, "");
    expect(
      await gate(
        "Bash",
        { command: "cd packages/app && ../../node_modules/.bin/vt" },
        rules(["alwaysAllow", "Bash(cd packages/app && ../../node_modules/.bin/*)"]),
      ),
    ).toBe("allow");
    expect(ran()).toBe("node_modules/.bin/vt");
  }, 120_000);

  test("$PWD is where the command runs; a word from a place the gate cannot tell is read as written", async () => {
    const pwd = await decide(
      [
        ["Bash", { command: "$PWD/link/../run.sh" }],
        ["Bash", { command: '"$PWD"/link/../run.sh' }],
        ["Bash", { command: "sh ${PWD}/link/../run.sh" }],
        ["Bash", { command: "$PWD/secrets/run.sh" }],
        ["Bash", { command: "cd scripts && $PWD/../secrets/run.sh" }],
      ],
      denyOnly("secrets/**"),
    );
    expectAll(pwd, "deny");
    // Where `$CDD_UNSET` points is the harness's to say: a `..` after a name
    // there cannot be placed, so every deny fires; without one it is read
    // as written, and a deny about something else lets it run.
    expectAll(
      await decide(
        [
          ["Bash", { command: "$CDD_UNSET/link/../run.sh" }],
          ["Bash", { command: 'cd "$CDD_UNSET" && ./link/../run.sh' }],
        ],
        denyOnly("rm *"),
      ),
      "deny",
    );
    const asWritten = await decide(
      [["Bash", { command: 'cd "$CDD_UNSET" && ./run.sh' }]],
      denyOnly("rm *"),
    );
    expect(asWritten.map((r) => r.got)).toEqual(["allow"]);
  }, 120_000);

  test("a program another program runs from its arguments is read where it lands, on an argv", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["RunCommand", { argv: ["caffeinate", "link/../run.sh"] }],
      ["RunCommand", { argv: ["caffeinate", "-i", "link/d.sh"] }],
      ["RunCommand", { argv: ["find", ".", "-maxdepth", "0", "-exec", "link/../run.sh", ";"] }],
      ["RunCommand", { argv: ["find", ".", "-maxdepth", "0", "-exec", "link/d.sh", ";"] }],
      ["Bash", { command: "caffeinate link/../run.sh" }],
    ];
    expectAll(await decide(calls, denyOnly("secrets/**")), "deny");
    // Control: one it names on its face runs.
    const ok = await decide(
      [["RunCommand", { argv: ["find", ".", "-maxdepth", "0", "-exec", "./scripts/ok.sh", ";"] }]],
      denyOnly("secrets/**"),
    );
    expectAll(ok, "allow", "scripts/ok.sh");
  }, 120_000);

  test("an allow on a Bash line reads the command with its words put in, as well as the line", async () => {
    // A script reached through a linked package directory (pnpm), and a
    // data operand with a `..`: an allow that covers where they land grants
    // them.
    const rows = await decide(
      [
        ["Bash", { command: "sh node_modules/tool/bin/cli.sh" }],
        ["Bash", { command: "sh gen.sh src/../lib" }],
      ],
      () => rules(["alwaysAllow", "Bash(sh **)"]),
    );
    expect(rows.map((r) => [r.got, r.ran])).toEqual([
      ["allow", "node_modules/.pnpm/tool@1.0.0/node_modules/tool/bin/cli.sh"],
      ["allow", "gen.sh"],
    ]);
    // One that covers only how it is written does not.
    const scoped = await decide(
      [
        ["Bash", { command: "sh node_modules/tool/bin/cli.sh" }],
        ["Bash", { command: "sh gen.sh src/../lib" }],
        ["Bash", { command: "cd tools && ./run.sh" }],
      ],
      () =>
        rules(
          ["alwaysAllow", "Bash(sh node_modules/tool/**)"],
          ["alwaysAllow", "Bash(sh gen.sh src/**)"],
          ["alwaysAllow", "Bash(cd tools && ./run.sh)"],
        ),
    );
    expectAll(scoped, "ask");
  }, 120_000);

  test("a script on a shell's input, one it expands as a pattern, and a program on a PATH the call sets", async () => {
    const bash = await decide(
      [
        ["Bash", { command: "sh < link/../run.sh" }],
        ["Bash", { command: "sh < secrets/run.sh" }],
        ["Bash", { command: "sh secre?s/run.sh" }],
        ["Bash", { command: "sh l*/../run.sh" }],
        ["Bash", { command: "sh secrets/r*.sh" }],
        ["Bash", { command: "PATH=secrets run.sh" }],
        ["Bash", { command: "PATH=link/.. run.sh" }],
        ["Bash", { command: "export PATH=link/..; run.sh" }],
        ["Bash", { command: "env PATH=secrets run.sh" }],
        ["RunCommand", { argv: ["env", "PATH=secrets", "run.sh"] }],
        ["RunCommand", { argv: ["env", "PATH=link/..", "run.sh"] }],
        ["RunCommand", { argv: ["sh", "-c", "PATH=link/.. run.sh"] }],
      ],
      denyOnly("secrets/**"),
    );
    expectAll(bash, "deny");
    // Control: the same spellings of a place the deny is not about.
    const ok = await decide(
      [
        ["Bash", { command: "sh < scripts/ok.sh" }],
        ["Bash", { command: "sh scripts/o*.sh" }],
        ["Bash", { command: "PATH=scripts ok.sh" }],
        ["RunCommand", { argv: ["env", "PATH=scripts", "ok.sh"] }],
      ],
      denyOnly("secrets/**"),
    );
    expectAll(ok, "allow", "scripts/ok.sh");
  }, 120_000);

  test("a shell reading the commands it runs from a pipe: every deny fires", async () => {
    writeFileSync(join(ws, "victim.txt"), "x");
    const rows = await decide(
      [
        ["Bash", { command: "echo rm -f victim.txt | sh" }],
        ["Bash", { command: "echo ./secrets/run.sh | bash -s" }],
      ],
      denyOnly("rm *"),
    );
    expectAll(rows, "deny");
    expect(existsSync(join(ws, "victim.txt"))).toBe(true);
    // A here-string is the line it runs, and a deny reads it.
    expect(
      await gate("Bash", { command: "sh <<< 'rm -f victim.txt'" }, denyOnly("rm *")("Bash")),
    ).toBe("deny");
    expect(existsSync(join(ws, "victim.txt"))).toBe(true);
    // Control: a shell handed a script of its own reads data on the pipe.
    expect(
      await gate("Bash", { command: "echo y | sh scripts/ok.sh" }, denyOnly("rm *")("Bash")),
    ).toBe("allow");
    expect(ran()).toBe("scripts/ok.sh");
  }, 120_000);

  describe("a headless grant is bound to where the program lands, however it is spelled", () => {
    const sessionId = "sess_0123456789abcdef";
    // One store per call: an unspent grant for another call of the same
    // tool in the same session is replayed (#400), which is not under test.
    let store: ReturnType<typeof createPendingApprovalStore>;
    async function turn(tool: string, input: unknown) {
      const where = relative(ws, process.cwd());
      if (where.startsWith("..") || isAbsolute(where) || !existsSync(ws)) {
        throw new Error(`turn outlived its test's workspace; refusing to run in ${process.cwd()}`);
      }
      let parked: string | undefined;
      await runChatLoop({
        model: "test-model",
        instructions: "approval places",
        runContext: createRunContext({ sessionId }),
        sessionRootDir: mkdtempSync(join(state, "sess-")),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "default",
        permissionRules: rules(),
        tools: [builtin(tool)],
        approvals: { store },
        _adapter: scripted([{ name: tool, input }]),
      }).catch((err: { report?: { class?: string; detail?: string } }) => {
        if (err.report?.class !== "approval_pending") throw err;
        parked = err.report.detail;
      });
      return /parked as approval (appr_[0-9a-f]{16})/.exec(parked ?? "")?.[1];
    }
    /** Park the call, grant it, point `tools` at `to`, and resume the same call. */
    async function grantThenRetarget(tool: string, input: unknown, to: string) {
      store = createPendingApprovalStore({ rootDir: mkdtempSync(join(state, "approvals-")) });
      rmSync(join(ws, "tools"));
      symlinkSync("safe", join(ws, "tools"));
      writeFileSync(marker, "");
      const id = await turn(tool, input);
      if (id === undefined) throw new Error(`${tool} ${JSON.stringify(input)} did not park`);
      const places = (await store.list()).find((a) => a.id === id)?.places;
      await store.resolve(id, "grant", "operator");
      rmSync(join(ws, "tools"));
      symlinkSync(to, join(ws, "tools"));
      const again = await turn(tool, input);
      const consumed = (await store.list()).find((a) => a.id === id)?.consumedAt !== undefined;
      return { places, parkedAgain: again !== undefined, consumed, ran: ran() };
    }
    const calls: Array<[string, Record<string, unknown>]> = [
      ["Bash", { command: "cd tools && ./run.sh" }],
      ["RunCommand", { argv: ["env", "-C", "tools", "./run.sh"] }],
      ["Bash", { command: "$PWD/tools/run.sh" }],
      ["RunCommand", { argv: ["find", ".", "-maxdepth", "0", "-exec", "./tools/run.sh", ";"] }],
      ["Bash", { command: "PATH=tools run.sh" }],
      ["RunCommand", { argv: ["env", "PATH=tools", "run.sh"] }],
      ["Bash", { command: "sh < tools/run.sh" }],
    ];

    test("retargeted between park and resume: asked again, and evil/run.sh never runs", async () => {
      for (const [tool, input] of calls) {
        const got = await grantThenRetarget(tool, input, "evil");
        expect({ tool, input, ...got, places: got.places?.length }).toEqual({
          tool,
          input,
          places: 1,
          parkedAgain: true,
          consumed: false,
          ran: "",
        });
      }
    }, 120_000);

    test("control: left where it was, the grant runs safe/run.sh once", async () => {
      for (const [tool, input] of calls) {
        const got = await grantThenRetarget(tool, input, "safe");
        expect({
          tool,
          input,
          parkedAgain: got.parkedAgain,
          consumed: got.consumed,
          ran: got.ran,
        }).toEqual({
          tool,
          input,
          parkedAgain: false,
          consumed: true,
          ran: "safe/run.sh",
        });
      }
    }, 120_000);
  });
});
