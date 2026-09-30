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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { createNavigateTool } from "@crewhaus/tool-navigate";
import { OPERATIVE_ARG_FIELDS } from "@crewhaus/tool-permission-matcher";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

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
