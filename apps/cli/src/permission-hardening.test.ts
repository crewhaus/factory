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
import { join } from "node:path";
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
    stream: () => {
      const first = i === 0;
      i++;
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
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
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

/**
 * The reason on the last {@link gate}'s decision, where the engine words one
 * (plan mode names the rule). A test that expects a deny from a RULE must
 * show it was the rule: an input the tool's schema rejects never reaches one.
 */
let lastReason: string | undefined;

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
