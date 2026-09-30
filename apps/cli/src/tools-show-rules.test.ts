/**
 * 0.7.1 — `crewhaus tools show <tool>` says which argument(s) a scoped
 * permission rule is checked against, in words, with one example rule.
 *
 * The example is only worth printing if it is a rule that works, so the
 * representative examples below are run through the real matcher: the call
 * a tool actually receives is parsed by its schema, its operative values are
 * read the way the runtime reads them, and the example rule is matched with
 * the polarity it has. A call outside the example is checked too, so a rule
 * that matched everything would fail here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { BUILTIN_TOOLS } from "@crewhaus/tool-categories";
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";
import { TOOL_REGISTRY } from "@crewhaus/tool-registry-manifest";
import { NON_CLI_TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";
import { importToolPackage } from "./tool-packages";
import {
  type OperativeArgLike,
  formatRuleScopeLines,
  operativeArgWords,
  ruleScopeFor,
} from "./tools-cli";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("operativeArgWords — a declaration in words", () => {
  test("the kind, what qualifies it, and what a left-out value stands for", () => {
    const cases: ReadonlyArray<[OperativeArgLike, string]> = [
      [{ field: "url", kind: "url" }, "a URL"],
      [{ field: "repo", kind: "recipient", within: "owner" }, "a recipient; matched as owner/repo"],
      [
        { field: "paths", kind: "path", within: "cwd", default: ".", beneath: "all" },
        "a path; read from the directory in cwd; a directory stands for everything beneath it; left out, the directory in cwd",
      ],
      [
        {
          field: "paths",
          kind: "path",
          within: "cwd",
          default: ".",
          beneath: "all",
          defaultAtRoot: true,
        },
        "a path; read from the directory in cwd; a directory stands for everything beneath it; left out, the whole workspace",
      ],
      [
        { field: "prefix", kind: "id", within: "namespace", default: "*", prefix: true },
        "an id prefix, which stands for every value that starts with it; matched as namespace/prefix; left out, it stands for every value",
      ],
      [
        { field: "stateDir", kind: "path", default: ".crewhaus/state", relocates: true },
        'a path; left out, ".crewhaus/state"; it only moves the tool off its usual place, so an allow need not match it when the call leaves it out',
      ],
      [
        { field: "argv", kind: "command", within: "cwd", env: "envSet" },
        "a command; run in the directory in cwd; a scoped allow covers it only in the workspace root; a call that sets envSet is covered only by an allow on every command (**)",
      ],
      [
        { field: "pattern", kind: "path", glob: true },
        "a path pattern, which stands for every path it can list",
      ],
      [
        { field: "path", kind: "path", default: ".", beneath: "visible" },
        "a path; a directory stands for everything beneath it except hidden names; left out, the workspace root",
      ],
    ];
    for (const [arg, words] of cases) expect(operativeArgWords(arg)).toBe(words);
  });

  test("a shell line says an allow reads each command, and which lines only a bare allow grants", async () => {
    // Bash's own declaration, from the tool the runtime loads.
    const bash = await builtin("bash");
    expect(bash.operativeArgs).toEqual([{ field: "command", kind: "command", shell: true }]);
    const lines = formatRuleScopeLines(ruleScopeFor(bash.name, bash.operativeArgs)).join(" ");
    const text = lines.replace(/\s+/g, " ");
    expect(text).toContain(
      "a shell line: an allow must match each command it runs (joined by &&, ||, ;, |, & or a newline), or be written as the same chain (cd ** && make *), and a deny or ask fires on any of them",
    );
    expect(text).toContain(
      "a line with $(…), backticks or a here-document is allowed only by the bare tool, (*) or (**)",
    );
    // A command that is not a shell line says none of it.
    expect(operativeArgWords({ field: "argv", kind: "command" })).toBe("a command");
  });
});

describe("ruleScopeFor — the three answers", () => {
  test("no declaration, and a declared empty list, are named apart and both say to name the tool bare", () => {
    expect(ruleScopeFor("JsonQuery", undefined)).toEqual({
      kind: "undeclared",
      example: { type: "alwaysAllow", pattern: "JsonQuery" },
    });
    expect(ruleScopeFor("ClipboardWrite", [])).toEqual({
      kind: "unscoped",
      example: { type: "alwaysAllow", pattern: "ClipboardWrite" },
    });
    const lines = formatRuleScopeLines(ruleScopeFor("ClipboardWrite", [])).join("\n");
    expect(lines).toContain("the tool says none decides where it acts");
    expect(lines).toContain('- { type: alwaysAllow, pattern: "ClipboardWrite" }');
  });

  test("arguments of different kinds get a deny example on the place, with the reason", () => {
    const scope = ruleScopeFor("Grep", [
      { field: "pattern", kind: "text" },
      { field: "path", kind: "path", default: ".", beneath: "visible" },
    ]);
    expect(scope.example).toEqual({ type: "alwaysDeny", pattern: "Grep(secrets/**)" });
    const lines = formatRuleScopeLines(scope).join("\n");
    expect(lines).toContain("rule checks pattern: text");
    expect(lines).toContain(
      "an allow must match every one of these; a deny or ask fires on any one",
    );
    expect(lines).toContain("these are of different kinds");
  });

  test("an allow skips a relocating field the call leaves out, so the example is about the others", () => {
    const scope = ruleScopeFor("KvList", [
      { field: "stateDir", kind: "path", default: ".crewhaus/state", relocates: true },
      { field: "prefix", kind: "id", within: "namespace", default: "*", prefix: true },
    ]);
    expect(scope.example).toEqual({ type: "alwaysAllow", pattern: "KvList(scratch/**)" });
  });
});

type ManifestRow = {
  readonly name: string;
  readonly operativeArgs?: ReadonlyArray<OperativeArgLike>;
};

describe("every builtin gets an answer whose example is a rule the engine accepts", () => {
  test("the example compiles, names the tool, and says what the declaration says", () => {
    const rows: ManifestRow[] = [
      ...Object.values(TOOL_REGISTRY as Readonly<Record<string, ManifestRow>>),
      ...Object.values(NON_CLI_TOOL_FLAGS as Readonly<Record<string, ManifestRow>>),
    ];
    const counts = { args: 0, unscoped: 0, undeclared: 0 };
    for (const row of rows) {
      const scope = ruleScopeFor(row.name, row.operativeArgs);
      counts[scope.kind] += 1;
      const compiled = compilePattern(scope.example.pattern);
      expect(compiled.toolGlob).toBe(row.name);
      if (scope.kind === "args") {
        expect(scope.args.map((a) => a.field)).toEqual(
          (row.operativeArgs ?? []).map((a) => a.field),
        );
        expect(compiled.argGlob).not.toBeNull();
      } else {
        expect(compiled.argGlob).toBeNull();
        expect(scope.kind).toBe(row.operativeArgs === undefined ? "undeclared" : "unscoped");
      }
    }
    expect(counts.args + counts.unscoped + counts.undeclared).toBe(rows.length);
    expect(rows.length).toBe(Object.keys(BUILTIN_TOOLS).length);
    expect(counts.args).toBeGreaterThan(200);
    expect(counts.unscoped).toBeGreaterThan(10);
  });
});

/**
 * A builtin's registered tool, loaded the way `crewhaus run` loads it — or,
 * for one only another shape carries (SendMessage), from its package source.
 */
async function builtin(key: string): Promise<RegisteredTool> {
  const entry = BUILTIN_TOOLS[key];
  if (entry === undefined) throw new Error(`no builtin ${key}`);
  const mod =
    entry.shapes === undefined
      ? await importToolPackage(entry.package)
      : ((await import(
          join(repoRoot, "packages", entry.package.replace("@crewhaus/", ""), "src", "index.ts")
        )) as Record<string, unknown>);
  return mod[entry.export] as RegisteredTool;
}

type Subject = (
  tool: RegisteredTool,
  input: unknown,
) =>
  | { ok: true; input: unknown; operativeValues?: ReadonlyArray<unknown> }
  | { ok: false; reason: string };

/** Does the example rule `tools show` prints for `key` match this call? */
async function exampleMatches(key: string, input: unknown): Promise<boolean> {
  const { preparePermissionSubject } = (await import(
    join(repoRoot, "packages", "tool-executor", "src", "index.ts")
  )) as { preparePermissionSubject: Subject };
  const tool = await builtin(key);
  const scope = ruleScopeFor(tool.name, tool.operativeArgs);
  const subject = preparePermissionSubject(tool, input);
  if (!subject.ok) throw new Error(`${key}: ${subject.reason}`);
  return matchesPattern(compilePattern(scope.example.pattern), tool.name, subject.input, {
    polarity: scope.example.type === "alwaysAllow" ? "allow" : "restrict",
    ...(subject.operativeValues !== undefined
      ? { operativeValues: subject.operativeValues as never }
      : {}),
  });
}

describe("the printed example works, through the real matcher", () => {
  // [key, a call the example covers, a call it does not]
  const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["write", { path: "src/a.ts", content: "x" }, { path: "etc/a.ts", content: "x" }],
    [
      "httpRequest",
      { url: "https://api.example.com/v1/status", method: "GET" },
      { url: "https://elsewhere.example.org/", method: "GET" },
    ],
    ["runCommand", { argv: ["git", "status"] }, { argv: ["git", "push"] }],
    [
      "issueCreate",
      { owner: "acme", repo: "app", title: "t" },
      { owner: "other", repo: "app", title: "t" },
    ],
    ["kvList", { namespace: "scratch", prefix: "a" }, { namespace: "prod", prefix: "a" }],
    [
      "chatDelete",
      { platform: "slack", channel: "C0123", messageId: "1700000000.1" },
      { platform: "slack", channel: "C9999", messageId: "1700000000.1" },
    ],
    ["dnsLookup", { name: "api.example.com" }, { name: "example.org" }],
    ["gitAdd", { paths: ["src/a.ts"] }, { paths: ["docs/a.md"] }],
    ["glob", { pattern: "src/**/*.ts" }, { pattern: "**/*.ts" }],
    [
      "sendMessage",
      { channel: "slack:T0123:C0123:1700000000.1", text: "hi" },
      { channel: "slack:T0123:C9999", text: "hi" },
    ],
    // Deny examples: they fire on the call named, and not on another.
    ["grep", { pattern: "key", path: "secrets/prod" }, { pattern: "key", path: "src" }],
    ["python", { code: "import subprocess" }, { code: "print(1)" }],
    ["webSearch", { query: "admin password reset" }, { query: "weather" }],
  ];
  for (const [key, covered, outside] of cases) {
    test(`${key}: the example matches the call it is about, and not another`, async () => {
      expect(await exampleMatches(key, covered)).toBe(true);
      expect(await exampleMatches(key, outside)).toBe(false);
    });
  }
});
