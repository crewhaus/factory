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
  return first?.kind === "permission_decision" ? first.decision : undefined;
}

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
  test("a scoped deny on HttpPaginate holds in default, auto and plan", async () => {
    const rs = rules(["alwaysDeny", "HttpPaginate(https://internal.corp/**)"]);
    const input = { url: "https://internal.corp/items", style: "page", pageParam: "page" };
    for (const mode of ["default", "auto", "plan"] as const) {
      expect(await gate("HttpPaginate", input, rs, mode)).toBe("deny");
    }
  });

  test("plan mode no longer runs a read-only tool the operator denied", async () => {
    expect(
      await gate(
        "SseRead",
        { url: "https://x.example/stream" },
        rules(["alwaysDeny", "SseRead(**)"]),
        "plan",
      ),
    ).toBe("deny");
  });
});
