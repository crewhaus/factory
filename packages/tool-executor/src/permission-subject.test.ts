/**
 * 0.7.1 — a permission rule is checked against the call the tool will run,
 * not the call the model wrote. See `permission-subject.ts`.
 *
 * Everything here is filesystem-free, as the edge worker needs it to be. The
 * canonicaliser that follows symlinks lives in runtime-core and is tested
 * there (`path-canonical.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { buildTool } from "@crewhaus/tool-builder";
import type { OperativeArg } from "@crewhaus/tool-catalog";
import {
  compilePattern,
  matchesPattern,
  normalizePathLexically,
} from "@crewhaus/tool-permission-matcher";
import { z } from "zod";
import {
  type PathCanonicalizer,
  type ProgramPathReader,
  type ProgramPathReading,
  executeTool,
  lexicalPathValues,
  operativeValuesFor,
  operativeValuesOf,
  preparePermissionSubject,
  readOperativeField,
} from "./index";
import { foldedAsText } from "./permission-subject";

const writeLike = () =>
  buildTool({
    name: "WriteLike",
    description: "write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    destructive: true,
    operativeArgs: [{ field: "path", kind: "path" }],
    execute: async (i) => `wrote ${i.path}`,
  });

describe("preparePermissionSubject", () => {
  test("parses with the tool's schema: an unknown key is gone from what rules see", () => {
    const s = preparePermissionSubject(writeLike(), {
      path: "src/a.ts",
      file_path: "docs/ok.md",
      content: "x",
    });
    if (!s.ok) throw new Error(s.reason);
    expect(s.input).toEqual({ path: "src/a.ts", content: "x" });
    expect(s.operativeValues?.map((v) => v.canonical[0])).toEqual(["src/a.ts"]);
  });

  test("an input the schema rejects is refused with the schema's message", () => {
    const s = preparePermissionSubject(writeLike(), { path: 7, content: "x" });
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.reason).toMatch(
      /^invalid input for tool "WriteLike": Expected string, received number/,
    );
  });

  test("a tool with no operativeArgs gets the parsed input and no values", () => {
    const tool = buildTool({
      name: "Plain",
      description: "d",
      inputSchema: z.object({ a: z.string() }),
      execute: async () => "ok",
    });
    const s = preparePermissionSubject(tool, { a: "x", extra: "y" });
    expect(s).toEqual({ ok: true, input: { a: "x" } });
  });
});

describe("path values without a filesystem (permission-integration#1)", () => {
  const values = (p: string) => operativeValuesFor(writeLike(), { path: p, content: "" }) ?? [];

  test("`..` is collapsed before a rule sees the path", () => {
    const [v] = values("build/../src/app.ts");
    expect(v?.canonical).toEqual(["src/app.ts", "./src/app.ts"]);
    expect(v?.spellings).toEqual(["build/../src/app.ts"]);
    expect(v?.outsideWorkspace).toBeUndefined();
  });

  test("a relative path that climbs above its start is flagged, with nothing to grant", () => {
    const [v] = values("src/../../elsewhere");
    expect(v).toEqual({
      kind: "path",
      canonical: [],
      spellings: ["src/../../elsewhere", "elsewhere"],
      outsideWorkspace: true,
    });
  });

  test("the start itself is `.`; an absolute path stays absolute", () => {
    expect(values(".")[0]?.canonical).toEqual(["."]);
    expect(values("")[0]?.canonical).toEqual(["."]);
    expect(values("/etc/../etc/passwd")[0]?.canonical).toEqual(["/etc/passwd"]);
  });

  test("the default is lexicalPathValues; a caller's canonicaliser replaces it", () => {
    expect(values("a/./b/../c")).toEqual(lexicalPathValues("a/./b/../c"));
    const seen: string[] = [];
    const fake: PathCanonicalizer = (raw) => {
      seen.push(raw);
      return [{ kind: "path", canonical: ["elsewhere/x"] }];
    };
    const vs = operativeValuesFor(
      writeLike(),
      { path: "src/a", content: "" },
      { canonicalizePath: fake },
    );
    expect(seen).toEqual(["src/a"]);
    expect(vs).toEqual([{ kind: "path", canonical: ["elsewhere/x"] }]);
  });
});

describe("url, command and id values", () => {
  test("a url is matched as its parsed href; a bare origin also as written", () => {
    const tool = buildTool({
      name: "Get",
      description: "d",
      inputSchema: z.object({ url: z.string(), method: z.string().optional() }),
      operativeArgs: [{ field: "url", kind: "url" }],
      execute: async () => "ok",
    });
    const [v] = operativeValuesFor(tool, { url: "HTTP://Example.COM" }) ?? [];
    expect(v?.canonical).toEqual(["http://example.com/", "http://example.com"]);
    const [odd] = operativeValuesFor(tool, { url: "http://0xa9fea9fe/latest" }) ?? [];
    // The spelling a parser differential would hide behind is normalised.
    expect(odd?.canonical).toEqual(["http://169.254.169.254/latest"]);
    const [bad] = operativeValuesFor(tool, { url: "not a url" }) ?? [];
    expect(bad).toEqual({ kind: "url", canonical: [], spellings: ["not a url"] });
  });

  test("an argv is one command line; ids may be numbers", () => {
    const argv = { field: "argv", kind: "command" } as const;
    expect(readOperativeField({ argv: ["git", "status"] }, argv)).toEqual(["git status"]);
    expect(readOperativeField({ argv: "git status" }, argv)).toEqual(["git status"]);
    const id = { field: "issue", kind: "id" } as const;
    expect(readOperativeField({ issue: 12 }, id)).toEqual(["12"]);
    expect(readOperativeField({ issue: 12 }, { field: "issue", kind: "text" })).toEqual([]);
  });

  test("a deny naming one word of an argv fires; an allow needs the whole command", () => {
    const tool = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()), cwd: z.string().optional() }),
      operativeArgs: [{ field: "argv", kind: "command" }],
      execute: async () => "ok",
    });
    const values = operativeValuesFor(tool, { argv: ["rm", "-rf", "src"] });
    expect(values).toEqual([
      { kind: "command", canonical: ["rm -rf src"], spellings: ["rm", "-rf", "src"] },
    ]);
    const match = (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(
        compilePattern(pattern),
        "Run",
        {},
        { polarity, operativeValues: values ?? [] },
      );
    expect(match("Run(rm)", "restrict")).toBe(true);
    expect(match("Run(rm)", "allow")).toBe(false);
    expect(match("Run(rm -rf src)", "allow")).toBe(true);
  });

  test("a command a shell parses is marked shell: an allow covers each command, a deny any", () => {
    // The Bash tool's declaration (tool-bash): `sh -c` parses `command`.
    const bashLike = buildTool({
      name: "Bash",
      description: "d",
      inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
      destructive: true,
      operativeArgs: [{ field: "command", kind: "command", shell: true }],
      execute: async () => "ok",
    });
    const subject = preparePermissionSubject(bashLike, { command: "git status && rm -rf build" });
    if (!subject.ok) throw new Error(subject.reason);
    expect(subject.operativeValues).toEqual([
      { kind: "command", canonical: ["git status && rm -rf build"], shell: true },
    ]);
    const match = (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Bash", subject.input, {
        polarity,
        operativeValues: subject.operativeValues ?? [],
      });
    expect(match("Bash(git *)", "allow")).toBe(false);
    expect(match("Bash(rm -rf **)", "restrict")).toBe(true);
    expect(match("Bash", "allow")).toBe(true);
    // Without the declaration the same field is one command, as for any tool.
    const plain = buildTool({
      name: "Plain",
      description: "d",
      inputSchema: z.object({ command: z.string() }),
      destructive: true,
      operativeArgs: [{ field: "command", kind: "command" }],
      execute: async () => "ok",
    });
    expect(operativeValuesFor(plain, { command: "a && b" })).toEqual([
      { kind: "command", canonical: ["a && b"] },
    ]);
  });

  test("an argv that hands a line to a shell is read by a deny, never by an allow", () => {
    const run = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()) }),
      destructive: true,
      operativeArgs: [{ field: "argv", kind: "command" }],
      execute: async () => "ok",
    });
    const argv = ["env", "A=1", "sh", "-c", "git status && rm -rf build"];
    const values = operativeValuesFor(run, { argv }) ?? [];
    expect(values[1]).toEqual({
      kind: "command",
      canonical: [],
      spellings: ["git status && rm -rf build"],
      shell: true,
      restrictOnly: true,
    });
    const match = (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Run", {}, { polarity, operativeValues: values });
    expect(match("Run(rm -rf **)", "restrict")).toBe(true);
    // The argv is not split: an allow reads it as written, as before.
    expect(match("Run(env A=1 sh -c *)", "allow")).toBe(true);
    expect(match("Run(git *)", "allow")).toBe(false);
    // An argv that runs no shell carries nothing more.
    expect(operativeValuesFor(run, { argv: ["git", "status"] })).toHaveLength(1);
  });

  test("a field declared within another is matched as qualifier/value", () => {
    const repo = { field: "repo", kind: "recipient", within: "owner" } as const;
    expect(readOperativeField({ owner: "crewhaus", repo: "factory" }, repo)).toEqual([
      "crewhaus/factory",
    ]);
    // A group path keeps its own slashes; a numeric qualifier is its decimal.
    expect(readOperativeField({ owner: "g/sub", repo: "p" }, repo)).toEqual(["g/sub/p"]);
    expect(
      readOperativeField(
        { chainId: 1, address: "0xab" },
        { field: "address", kind: "id", within: "chainId" },
      ),
    ).toEqual(["1/0xab"]);
    // Left out, the value is matched on its own.
    expect(readOperativeField({ repo: "factory" }, repo)).toEqual(["factory"]);
  });

  test("a 0x hex id is marked case-insensitive; other ids and commands are not", () => {
    const tool = buildTool({
      name: "Read0x",
      description: "d",
      inputSchema: z.object({
        chainId: z.string(),
        to: z.string(),
        label: z.string(),
        argv: z.array(z.string()),
      }),
      operativeArgs: [
        { field: "to", kind: "id", within: "chainId" },
        { field: "label", kind: "recipient" },
        { field: "argv", kind: "command" },
      ],
      readOnly: true,
      execute: async () => "ok",
    });
    const hex = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const values = operativeValuesFor(tool, { chainId: "1", to: hex, label: hex, argv: [hex] });
    expect(values?.map((v) => [v.kind, v.caseInsensitive === true])).toEqual([
      ["id", true],
      ["recipient", true],
      ["command", false],
    ]);
    const words = operativeValuesFor(tool, {
      chainId: "1",
      to: "USDC",
      label: "0xnothex",
      argv: [],
    });
    expect(words?.map((v) => v.caseInsensitive === true)).toEqual([false, false]);
    // A `0X` prefix is the same hex to a node (geth decodes it), so it is
    // folded too.
    const upper = operativeValuesFor(tool, {
      chainId: "1",
      to: `0X${hex.slice(2)}`,
      label: `0X${hex.slice(2)}`,
      argv: [],
    });
    expect(upper?.map((v) => v.caseInsensitive === true)).toEqual([true, true]);
  });

  test("a within value keeps its parts as deny-only spellings, and an allow must name both", () => {
    // 0.7.0 matched a rule against every string in the call, so a deny
    // written `EvmCall(0x…)` or `EvmCall(*)` fired. The qualified value made
    // both no-ops, silently.
    const tool = buildTool({
      name: "Call",
      description: "d",
      inputSchema: z.object({ chainId: z.string(), to: z.string() }),
      operativeArgs: [{ field: "to", kind: "id", within: "chainId" }],
      readOnly: true,
      execute: async () => "ok",
    });
    const values = operativeValuesFor(tool, { chainId: "mainnet", to: "0xab" });
    expect(values).toEqual([
      {
        kind: "id",
        canonical: ["mainnet/0xab"],
        spellings: ["0xab", "mainnet"],
        caseInsensitive: true,
      },
    ]);
    const match = (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(
        compilePattern(pattern),
        "Call",
        {},
        {
          polarity,
          operativeValues: values ?? [],
        },
      );
    for (const pattern of ["Call(*)", "Call(0xab)", "Call(0xAB)", "Call(mainnet)"]) {
      expect({ pattern, deny: match(pattern, "restrict"), allow: match(pattern, "allow") }).toEqual(
        { pattern, deny: true, allow: false },
      );
    }
    expect(match("Call(mainnet/0xab)", "allow")).toBe(true);
    expect(match("Call(other/0xab)", "restrict")).toBe(false);
    // A path within a directory keeps its one resolved spelling.
    const stage = buildTool({
      name: "Stage",
      description: "d",
      inputSchema: z.object({ cwd: z.string(), paths: z.array(z.string()) }),
      operativeArgs: [{ field: "paths", kind: "path", within: "cwd" }],
      execute: async () => "ok",
    });
    expect(
      operativeValuesFor(stage, { cwd: "pkg", paths: ["a.ts"] })?.flatMap((v) => v.spellings ?? []),
    ).toEqual(["pkg/a.ts"]);
  });

  test("a left-out field whose default is * stands for every value", () => {
    const tool = buildTool({
      name: "Logs",
      description: "d",
      inputSchema: z.object({ chainId: z.string(), address: z.string().optional() }),
      operativeArgs: [{ field: "address", kind: "id", within: "chainId", default: "*" }],
      readOnly: true,
      execute: async () => "ok",
    });
    expect(operativeValuesFor(tool, { chainId: "1" })).toEqual([
      { kind: "id", canonical: ["1/*"], spellings: ["*", "1"], standsForAny: ["1/", ""] },
    ]);
    // A value the call gives is only itself.
    expect(operativeValuesFor(tool, { chainId: "1", address: "0xab" })?.[0]?.standsForAny).toBe(
      undefined,
    );
    // Its qualifier left out as well, it stands for every <qualifier>/<value>
    // — a code search naming no owner reaches every repository (C004).
    const search = buildTool({
      name: "Search",
      description: "d",
      inputSchema: z.object({ owner: z.string().optional(), repo: z.string().optional() }),
      operativeArgs: [{ field: "repo", kind: "id", within: "owner", default: "*" }],
      readOnly: true,
      execute: async () => "ok",
    });
    const unscoped = operativeValuesFor(search, {});
    expect(unscoped).toEqual([
      { kind: "id", canonical: ["*"], standsForAny: [""], anyQualifier: true },
    ]);
    expect(operativeValuesFor(search, { owner: "acme" })?.[0]?.anyQualifier).toBe(undefined);
    const deny = compilePattern("Search(acme/secret)");
    expect(
      matchesPattern(deny, "Search", {}, { polarity: "restrict", operativeValues: unscoped }),
    ).toBe(true);
    // Any other default is a value, not "every value".
    const dot = buildTool({
      name: "Dot",
      description: "d",
      inputSchema: z.object({ key: z.string().optional() }),
      operativeArgs: [{ field: "key", kind: "id", default: "main" }],
      readOnly: true,
      execute: async () => "ok",
    });
    expect(operativeValuesFor(dot, {})).toEqual([{ kind: "id", canonical: ["main"] }]);
  });

  test("a field declared `prefix` stands for every value that starts with it (final review)", () => {
    // KvList's `prefix` lists every key that begins with it. Read as one key,
    // `prefix: ""` (the same unfiltered listing as leaving it out) and
    // `prefix: "api"` dodged `alwaysDeny KvGet(secrets/apikey)` and returned
    // the value.
    const list = buildTool({
      name: "List",
      description: "d",
      inputSchema: z.object({ namespace: z.string(), prefix: z.string().optional() }),
      operativeArgs: [
        { field: "prefix", kind: "id", within: "namespace", default: "*", prefix: true },
      ],
      readOnly: true,
      execute: async () => "ok",
    });
    expect(list.operativeArgs?.[0]?.prefix).toBe(true);
    expect(operativeValuesFor(list, { namespace: "secrets", prefix: "api" })).toEqual([
      {
        kind: "id",
        canonical: ["secrets/api*"],
        spellings: ["api*", "secrets"],
        standsForAny: ["secrets/api"],
        standsForAnyRun: true,
      },
      { kind: "id", canonical: [], standsForAny: ["api"], restrictOnly: true },
    ]);
    // Left out, or empty, it is the empty prefix: every key.
    const omitted = operativeValuesFor(list, { namespace: "secrets" });
    expect(operativeValuesFor(list, { namespace: "secrets", prefix: "" })).toEqual(omitted);
    expect(omitted?.[0]?.standsForAny).toEqual(["secrets/"]);
    const on =
      (polarity: "allow" | "restrict", input: Record<string, unknown>) => (pattern: string) =>
        matchesPattern(compilePattern(pattern), "List", input, {
          polarity,
          operativeValues: operativeValuesFor(list, input) ?? [],
        });
    const keyDeny = "List(secrets/apikey)";
    for (const prefix of [undefined, "", "a", "api", "apikey"]) {
      const input = { namespace: "secrets", ...(prefix !== undefined ? { prefix } : {}) };
      expect({ prefix, fires: on("restrict", input)(keyDeny) }).toEqual({ prefix, fires: true });
    }
    expect(on("restrict", { namespace: "secrets", prefix: "b" })(keyDeny)).toBe(false);
    expect(on("restrict", { namespace: "public" })(keyDeny)).toBe(false);
    // A key may hold `/`, and a listing reaches it.
    expect(
      on("restrict", { namespace: "cache", prefix: "https:" })("List(cache/https://x/**)"),
    ).toBe(true);
    // A deny written without the namespace fires on the key in any listing,
    // and one naming another namespace's key does not fire on an unrelated one.
    expect(on("restrict", { namespace: "public" })("List(apikey)")).toBe(true);
    expect(on("restrict", { namespace: "public", prefix: "b" })("List(apikey)")).toBe(false);
    // An allow must cover every key the listing can return.
    const grants = on("allow", { namespace: "secrets", prefix: "api" });
    expect(["List(secrets/**)", "List(secrets/api**)", "List(**)"].filter(grants)).toHaveLength(3);
    expect(
      ["List(secrets/api)", "List(secrets/*)", "List(secrets/api*)", "List(secrets/apikey)"].filter(
        grants,
      ),
    ).toEqual([]);
    // With its qualifier left out, it stands for every value there is.
    const loose = buildTool({
      name: "Loose",
      description: "d",
      inputSchema: z.object({ namespace: z.string().optional(), prefix: z.string().optional() }),
      operativeArgs: [
        { field: "prefix", kind: "id", within: "namespace", default: "*", prefix: true },
      ],
      readOnly: true,
      execute: async () => "ok",
    });
    expect(operativeValuesFor(loose, { prefix: "api" })).toEqual([
      { kind: "id", canonical: ["*"], standsForAny: [""], standsForAnyRun: true },
    ]);
  });

  test("buildTool refuses a prefix on a kind read whole, or without a `*` default", () => {
    const make = (arg: Record<string, unknown>) => () =>
      buildTool({
        name: "Bad",
        description: "d",
        inputSchema: z.object({ p: z.string().optional() }),
        operativeArgs: [{ field: "p", ...arg } as never],
        readOnly: true,
        execute: async () => "ok",
      });
    expect(make({ kind: "path", default: "*", prefix: true })).toThrow(/prefix/);
    expect(make({ kind: "id", prefix: true })).toThrow(/default "\*"/);
    expect(make({ kind: "id", default: "*", prefix: false })).toThrow(/prefix/);
    expect(make({ kind: "id", default: "*", prefix: true })).not.toThrow();
  });

  test("a path declared `beneath` carries its prefixes, unless it names a file (final review)", () => {
    const remove = buildTool({
      name: "Remove",
      description: "d",
      inputSchema: z.object({ path: z.string() }),
      operativeArgs: [{ field: "path", kind: "path", beneath: "all" }],
      destructive: true,
      execute: async () => "ok",
    });
    // No filesystem to ask: whatever it names may be a directory.
    expect(operativeValuesFor(remove, { path: "src" })).toEqual([
      {
        kind: "path",
        canonical: ["src", "./src"],
        spellings: ["src"],
        beneath: ["src/", "./src/"],
      },
    ]);
    const fires = (pattern: string, value: unknown) =>
      matchesPattern(compilePattern(pattern), "Remove", value, {
        polarity: "restrict",
        operativeValues: operativeValuesFor(remove, value) ?? [],
      });
    expect(fires("Remove(src/prod/**)", { path: "src" })).toBe(true);
    expect(fires("Remove(src/prod/**)", { path: "src/other" })).toBe(false);
    // A canonicaliser that knows it is a file: nothing beneath it.
    const file: PathCanonicalizer = (raw) => [
      { kind: "path", canonical: [raw], notDirectory: true },
    ];
    expect(operativeValuesFor(remove, { path: "src/a.ts" }, { canonicalizePath: file })).toEqual([
      { kind: "path", canonical: ["src/a.ts"], notDirectory: true },
    ]);
    // The workspace root is the empty prefix, and `visible` skips hidden names.
    const grep = buildTool({
      name: "Search",
      description: "d",
      inputSchema: z.object({ path: z.string().optional() }),
      operativeArgs: [{ field: "path", kind: "path", default: ".", beneath: "visible" }],
      readOnly: true,
      execute: async () => "ok",
    });
    // The root is also `./`, as a direct path is also `./secrets/x`: a deny
    // written `./secrets/**` names what a walk of `.` reaches.
    expect(operativeValuesFor(grep, {})).toEqual([
      {
        kind: "path",
        canonical: ["."],
        spellings: ["."],
        beneath: ["", "./"],
        beneathSkipsHidden: true,
      },
    ]);
    // Outside the workspace it already fires every deny; no prefix is added.
    expect(operativeValuesFor(grep, { path: "../x" })?.[0]?.beneath).toBe(undefined);
    // An empty path is the root: the empty prefix, never `/`, which an
    // absolute deny (`Search(/etc/**)`) would read as the filesystem root.
    expect(operativeValuesFor(grep, { path: "" })?.[0]?.beneath).toEqual(["", "./"]);
    // A directory below the root carries both spellings already.
    expect(operativeValuesFor(grep, { path: "src" })?.[0]?.beneath).toEqual(["src/", "./src/"]);
    expect(
      matchesPattern(
        compilePattern("Search(/etc/**)"),
        "Search",
        { path: "" },
        {
          polarity: "restrict",
          operativeValues: operativeValuesFor(grep, { path: "" }) ?? [],
        },
      ),
    ).toBe(false);
  });

  test("a default declared `defaultAtRoot` is the workspace root, wherever the call runs", () => {
    // A git command given no path acts on the whole repository: GitDiff with
    // cwd `src` and no paths diffs secrets/ too.
    const diff = buildTool({
      name: "Diff",
      description: "d",
      inputSchema: z.object({ cwd: z.string().optional(), paths: z.array(z.string()).optional() }),
      operativeArgs: [
        {
          field: "paths",
          kind: "path",
          within: "cwd",
          default: ".",
          beneath: "all",
          defaultAtRoot: true,
        },
      ],
      readOnly: true,
      execute: async () => "ok",
    });
    expect(operativeValuesFor(diff, { cwd: "src" })?.[0]?.canonical).toEqual(["."]);
    // A path the call names is still read from its directory.
    expect(operativeValuesFor(diff, { cwd: "src", paths: ["a"] })?.[0]?.canonical).toEqual([
      "src/a",
      "./src/a",
    ]);
    const fires = (value: unknown) =>
      matchesPattern(compilePattern("Diff(secrets/**)"), "Diff", value, {
        polarity: "restrict",
        operativeValues: operativeValuesFor(diff, value) ?? [],
      });
    expect(fires({ cwd: "src" })).toBe(true);
    expect(fires({ cwd: "src", paths: ["a"] })).toBe(false);
  });

  test("a path within a left-out directory is read from its withinDefault, and beneath only when switched on (critic11)", () => {
    // TempDir makes `base/name` (base `.tmp` when left out), and with
    // `clear` deletes what is in it first.
    const make = buildTool({
      name: "Make",
      description: "d",
      inputSchema: z.object({
        name: z.string(),
        base: z.string().optional(),
        clear: z.boolean().optional(),
      }),
      operativeArgs: [
        {
          field: "name",
          kind: "path",
          within: "base",
          withinDefault: ".tmp",
          beneath: "all",
          beneathWhen: "clear",
        },
      ],
      execute: async () => "ok",
    });
    expect(operativeValuesFor(make, { name: "work" })).toEqual([
      { kind: "path", canonical: [".tmp/work", "./.tmp/work"], spellings: [".tmp/work"] },
    ]);
    expect(operativeValuesFor(make, { base: "src", name: "keep", clear: true })).toEqual([
      {
        kind: "path",
        canonical: ["src/keep", "./src/keep"],
        spellings: ["src/keep"],
        beneath: ["src/keep/", "./src/keep/"],
      },
    ]);
    // `clear: false` is no switch.
    expect(operativeValuesFor(make, { name: "w", clear: false })?.[0]?.beneath).toBe(undefined);
    expect(readOperativeField({ name: "work" }, make.operativeArgs?.[0] as OperativeArg)).toEqual([
      ".tmp/work",
    ]);
    const fires = (rule: string, value: unknown) =>
      matchesPattern(compilePattern(rule), "Make", value, {
        polarity: "restrict",
        operativeValues: operativeValuesFor(make, value) ?? [],
      });
    expect(fires("Make(.tmp/work/.env)", { name: "work", clear: true })).toBe(true);
    expect(fires("Make(.tmp/work/.env)", { name: "work" })).toBe(false);
    expect(fires("Make(secrets/**)", { base: ".", name: "secrets" })).toBe(true);
    expect(fires("Make(secrets/**)", { base: ".", name: "scratch", clear: true })).toBe(false);
  });

  test("a path declared `glob` is a pattern that stands for every path it lists (final review)", () => {
    const list = buildTool({
      name: "List",
      description: "d",
      inputSchema: z.object({ pattern: z.string() }),
      operativeArgs: [{ field: "pattern", kind: "path", glob: true }],
      readOnly: true,
      execute: async () => "ok",
    });
    expect(operativeValuesFor(list, { pattern: "src/../**/*" })).toEqual([
      {
        kind: "path",
        canonical: ["**/*", "./**/*"],
        spellings: ["src/../**/*"],
        globPattern: true,
      },
    ]);
    const on = (polarity: "allow" | "restrict", pattern: string) => (rule: string) =>
      matchesPattern(
        compilePattern(rule),
        "List",
        { pattern },
        {
          polarity,
          operativeValues: operativeValuesFor(list, { pattern }) ?? [],
        },
      );
    expect(on("restrict", "**/*")("List(secrets/**)")).toBe(true);
    expect(on("restrict", "src/**/*.ts")("List(secrets/**)")).toBe(false);
    expect(on("allow", "src/**/*.ts")("List(src/**)")).toBe(true);
    expect(on("allow", "src/**")("List(src/*)")).toBe(false);
    // A pattern that climbs out stays outside: every deny, no allow.
    expect(operativeValuesFor(list, { pattern: "../*" })?.[0]?.globPattern).toBe(undefined);
    expect(on("allow", "../*")("List(**)")).toBe(false);
  });

  test("buildTool refuses beneath or defaultAtRoot where they mean nothing", () => {
    const make = (arg: Record<string, unknown>) => () =>
      buildTool({
        name: "Bad",
        description: "d",
        inputSchema: z.object({ p: z.string().optional(), cwd: z.string().optional() }),
        operativeArgs: [{ field: "p", ...arg } as never],
        readOnly: true,
        execute: async () => "ok",
      });
    expect(make({ kind: "url", beneath: "all" })).toThrow(/beneath/);
    expect(make({ kind: "path", beneath: "some" })).toThrow(/beneath/);
    // Alone, a relocating field is the tool's only place: refused as such.
    expect(make({ kind: "path", default: ".", relocates: true, beneath: "all" })).toThrow(
      /"p" is the only place this tool names/,
    );
    expect(make({ kind: "path", defaultAtRoot: true })).toThrow(/defaultAtRoot/);
    expect(make({ kind: "path", within: "cwd", defaultAtRoot: true })).toThrow(/defaultAtRoot/);
    expect(
      make({ kind: "path", within: "cwd", default: ".", defaultAtRoot: true, beneath: "all" }),
    ).not.toThrow();
    expect(make({ kind: "id", glob: true })).toThrow(/glob/);
    expect(make({ kind: "path", glob: true, beneath: "all" })).toThrow(/glob/);
    expect(make({ kind: "path", glob: true, within: "cwd" })).toThrow(/glob/);
    expect(make({ kind: "path", glob: true })).not.toThrow();
  });

  test("a path within a directory field is resolved from that directory", () => {
    const tool = buildTool({
      name: "Stage",
      description: "d",
      inputSchema: z.object({ cwd: z.string().optional(), paths: z.array(z.string()).optional() }),
      operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
      execute: async () => "ok",
    });
    const canonical = (input: unknown) =>
      (operativeValuesFor(tool, input) ?? []).map((v) => v.canonical[0]);
    expect(canonical({ cwd: "pkg", paths: ["src/a.ts"] })).toEqual(["pkg/src/a.ts"]);
    expect(canonical({ paths: ["src/a.ts"] })).toEqual(["src/a.ts"]);
    // Left out, the paths default to the directory itself.
    expect(canonical({ cwd: "pkg" })).toEqual(["pkg"]);
    expect(canonical({})).toEqual(["."]);
    // `..` in the directory is collapsed with the rest: the tools resolve the
    // directory itself that way (resolveSafe), before they run anything in it.
    expect(canonical({ cwd: "pkg/..", paths: [".env"] })).toEqual([".env"]);
  });

  // critic7 (0.7.1): the tool hands each path, as written, to a program it
  // runs in the directory, and the OS follows a symlink BEFORE the `..` after
  // it. With `link -> secrets/deep`, `../x.ts` run in `link` is
  // secrets/x.ts; collapsed first, it read as x.ts, so `alwaysDeny
  // Format(secrets/**)` did not fire and `alwaysAllow Format(x.ts)` granted it.
  test("a path that leaves its directory — `..` or absolute — is outside: no allow, every deny", () => {
    const tool = buildTool({
      name: "Probe",
      description: "d",
      inputSchema: z.object({ cwd: z.string().optional(), paths: z.array(z.string()).optional() }),
      operativeArgs: [
        { field: "paths", kind: "path", within: "cwd", default: ".", beneath: "all" },
      ],
      execute: async () => "ok",
    });
    const vals = (input: unknown) => operativeValuesFor(tool, input) ?? [];
    const on = (polarity: "allow" | "restrict", input: unknown) => (pattern: string) =>
      matchesPattern(compilePattern(pattern), "Probe", input, {
        polarity,
        operativeValues: vals(input),
      });
    for (const input of [
      { cwd: "link", paths: ["../x.ts"] },
      { cwd: "node_modules/@acme/pkg", paths: ["../../secrets/x.ts"] },
      // No directory: the root, and the value is still handed on as written.
      { paths: ["link/../x.ts"] },
      // A link inside the value itself: no join to the directory sees it.
      { cwd: "src", paths: ["lnk/../x.ts"] },
      { cwd: "src", paths: ["a/b/.."] },
      { cwd: "src", paths: [".."] },
      { cwd: "src", paths: ["a\\..\\x.ts"] },
      // Absolute: a program ignores the directory, `path.join` does not.
      { cwd: "src", paths: ["/etc/passwd"] },
      { paths: ["/ws/x.ts"] },
    ]) {
      const read = vals(input);
      expect({ input, read: read.map((v) => [v.canonical, v.outsideWorkspace]) }).toEqual({
        input,
        read: [[[], true]],
      });
      // Every deny fires — the one that names the real place among them —
      // and no allow does, however wide short of a bare tool name.
      expect({
        input,
        denies: ["Probe(secrets/**)", "Probe(x.ts)", "Probe(nothing-like-it)"].map(
          on("restrict", input),
        ),
        allows: ["Probe(x.ts)", "Probe(**)", "Probe(node_modules/**)", "Probe(/**)"].map(
          on("allow", input),
        ),
      }).toEqual({ input, denies: [true, true, true], allows: [false, false, false, false] });
    }
    // The flagged value keeps what the call wrote, alone and joined.
    expect(vals({ cwd: "link", paths: ["../x.ts"] })).toEqual([
      {
        kind: "path",
        canonical: [],
        spellings: ["../x.ts", "link/../x.ts"],
        outsideWorkspace: true,
      },
    ]);
    // Shown (an approval row, a card) joined to its directory all the same,
    // so an approver sees what the `..` climbs from; an absolute path as is.
    const paths = { field: "paths", kind: "path", within: "cwd" } as const;
    expect(readOperativeField({ cwd: "link", paths: ["../x.ts"] }, paths)).toEqual([
      "link/../x.ts",
    ]);
    expect(readOperativeField({ cwd: "src", paths: ["/etc/passwd"] }, paths)).toEqual([
      "/etc/passwd",
    ]);
    expect(readOperativeField({ paths: ["link/../x.ts"] }, paths)).toEqual(["link/../x.ts"]);
    // One such entry flags only itself: its neighbour is read as before.
    expect(vals({ cwd: "src", paths: ["a.ts", "../b.ts"] }).map((v) => v.canonical[0])).toEqual([
      "src/a.ts",
      undefined,
    ]);
    // Ordinary paths are unchanged: below the directory, a `..` only in the
    // directory, a dot-name that is not `..`, and the left-out default.
    const canonical = (input: unknown) => vals(input).map((v) => v.canonical[0]);
    expect(canonical({ cwd: "src", paths: ["a/b.ts", "./c.ts", "..d", "e..", ".../f"] })).toEqual([
      "src/a/b.ts",
      "src/c.ts",
      "src/..d",
      "src/e..",
      "src/.../f",
    ]);
    expect(canonical({ cwd: "pkg/..", paths: ["x.ts"] })).toEqual(["x.ts"]);
    expect(canonical({ cwd: "src" })).toEqual(["src"]);
    expect(on("allow", { cwd: "src", paths: ["a.ts"] })("Probe(src/**)")).toBe(true);
    // A path NOT declared `within` a directory is read as before, `..`
    // collapsed: its tools resolve it themselves, the same way.
    expect(
      operativeValuesFor(writeLike(), { path: "build/../src/app.ts", content: "" })?.[0]?.canonical,
    ).toEqual(["src/app.ts", "./src/app.ts"]);
  });

  // C033 — the same argv is another program in another directory
  // (`./build.sh` in `src/` runs `src/build.sh`), and the directory was
  // invisible to every rule: `RunCommand(./build.sh)` granted it.
  test("a command within its working directory: an allow covers it only at the workspace root", () => {
    const tool = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()), cwd: z.string().optional() }),
      operativeArgs: [{ field: "argv", kind: "command", within: "cwd" }],
      execute: async () => "ok",
    });
    const values = (input: unknown) => operativeValuesFor(tool, input) ?? [];
    const match = (pattern: string, polarity: "allow" | "restrict", input: unknown) =>
      matchesPattern(compilePattern(pattern), "Run", input, {
        polarity,
        operativeValues: values(input),
      });
    const build = ["./build.sh"];
    for (const cwd of [undefined, ".", "", "src/..", "./"]) {
      const input = cwd === undefined ? { argv: build } : { argv: build, cwd };
      expect({ cwd, allowed: match("Run(./build.sh)", "allow", input) }).toEqual({
        cwd,
        allowed: true,
      });
    }
    for (const cwd of ["src", "src/../src", "../elsewhere"]) {
      expect({ cwd, allowed: match("Run(./build.sh)", "allow", { argv: build, cwd }) }).toEqual({
        cwd,
        allowed: false,
      });
    }
    // A deny or ask still reads the command, wherever it runs.
    const rm = { argv: ["rm", "-rf", "x"], cwd: "src" };
    expect(match("Run(rm)", "restrict", rm)).toBe(true);
    expect(match("Run(rm -rf *)", "restrict", rm)).toBe(true);
    // As written, then each word that may name a file as that file from the
    // root, alone and in the command line. Not the program: PATH finds a
    // bare `rm`, not the directory. And no `./src/…` spelling the call did
    // not write.
    expect(values(rm)).toEqual([
      {
        kind: "command",
        canonical: [],
        spellings: ["rm -rf x", "rm", "-rf", "x", "src/x", "rm -rf src/x"],
      },
    ]);
    // The command is not written with its directory in front.
    expect(readOperativeField(rm, { field: "argv", kind: "command", within: "cwd" })).toEqual([
      "rm -rf x",
    ]);
  });

  test("a pipeline step runs in its own directory, else the top-level one", () => {
    const tool = buildTool({
      name: "Pipe",
      description: "d",
      inputSchema: z.object({
        steps: z.array(z.object({ argv: z.array(z.string()), cwd: z.string().optional() })),
        cwd: z.string().optional(),
      }),
      operativeArgs: [{ field: "steps.argv", kind: "command", within: "cwd" }],
      execute: async () => "ok",
    });
    const grantable = (input: unknown) =>
      (operativeValuesFor(tool, input) ?? []).map((v) => v.canonical.length > 0);
    expect(grantable({ steps: [{ argv: ["make"] }, { argv: ["make"], cwd: "sub" }] })).toEqual([
      true,
      false,
    ]);
    expect(
      grantable({ cwd: "sub", steps: [{ argv: ["make"] }, { argv: ["make"], cwd: "." }] }),
    ).toEqual([false, true]);
  });

  // merge-seams (wave III): `alwaysDeny RunCommand(*scripts/release.sh*)`
  // refused `[sh, scripts/release.sh]` and allowed `[sh, release.sh]` with
  // `cwd: scripts` — the same script. Nothing a deny read joined the working
  // directory with the words.
  test("a deny naming a program by its workspace path fires when the call runs it from its directory", () => {
    const run = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()), cwd: z.string().optional() }),
      operativeArgs: [{ field: "argv", kind: "command", within: "cwd" }],
      execute: async () => "ok",
    });
    const pipe = buildTool({
      name: "Pipe",
      description: "d",
      inputSchema: z.object({
        steps: z.array(z.object({ argv: z.array(z.string()), cwd: z.string().optional() })),
        cwd: z.string().optional(),
      }),
      operativeArgs: [{ field: "steps.argv", kind: "command", within: "cwd" }],
      execute: async () => "ok",
    });
    const on =
      (polarity: "allow" | "restrict", canonicalizePath?: PathCanonicalizer) =>
      (tool: typeof run, pattern: string, input: unknown) =>
        matchesPattern(compilePattern(pattern), tool.name, input, {
          polarity,
          operativeValues:
            operativeValuesFor(
              tool,
              input,
              canonicalizePath !== undefined ? { canonicalizePath } : {},
            ) ?? [],
        });
    const fires = on("restrict");
    const release = "Run(*scripts/release.sh*)";
    const cases: Array<[typeof run, string, unknown]> = [
      [run, release, { argv: ["sh", "release.sh"], cwd: "scripts" }],
      [run, release, { argv: ["sh", "./release.sh"], cwd: "scripts/" }],
      [run, release, { argv: ["sh", "release.sh"], cwd: "./scripts" }],
      [run, release, { argv: ["sh", "release.sh"], cwd: "other/../scripts" }],
      [run, "Run(scripts/release.sh)", { argv: ["sh", "release.sh"], cwd: "scripts" }],
      [run, "Run(sh scripts/release.sh)", { argv: ["sh", "release.sh"], cwd: "scripts" }],
      [run, "Run(**node_modules/.bin/**)", { argv: ["./eslint", "src"], cwd: "node_modules/.bin" }],
      [run, "Run(**/node_modules/.bin/eslint)", { argv: ["./eslint"], cwd: "node_modules/.bin" }],
      [
        pipe,
        "Pipe(*scripts/release.sh*)",
        { steps: [{ argv: ["sh", "release.sh"], cwd: "scripts" }] },
      ],
      [
        pipe,
        "Pipe(*scripts/release.sh*)",
        { cwd: "scripts", steps: [{ argv: ["sh", "release.sh"] }] },
      ],
    ];
    expect(
      cases
        .filter(([tool, p, input]) => !fires(tool, p, input))
        .map(([, p, input]) => `${p} ${JSON.stringify(input)}`),
    ).toEqual([]);
    // The same words run from the root, or from another directory, are not
    // that script.
    expect(fires(run, release, { argv: ["sh", "release.sh"] })).toBe(false);
    // A bare program is found on PATH, not in the directory: Bun's spawn
    // reports `Executable not found in $PATH` for `[eslint]` run in
    // `node_modules/.bin/` (probed on 1.3.14), so that call is not that
    // binary and a deny naming the binary does not read it as one.
    expect(
      fires(run, "Run(**/node_modules/.bin/eslint)", {
        argv: ["eslint"],
        cwd: "node_modules/.bin",
      }),
    ).toBe(false);
    expect(fires(run, release, { argv: ["sh", "release.sh"], cwd: "other" })).toBe(false);
    // A flag or a URL is not a file in the directory.
    expect(fires(run, "Run(scripts/-v)", { argv: ["sh", "-v"], cwd: "scripts" })).toBe(false);
    // A deny on the directory's files fires on a command that names one of
    // them there — an argument, or a program run by its path — but not on a
    // PATH program that names none (`ls` alone lists `scripts/`; it runs
    // nothing in it). One on a program name does not fire because the
    // directory's name starts alike.
    expect(fires(run, "Run(scripts/**)", { argv: ["ls", "x"], cwd: "scripts" })).toBe(true);
    expect(fires(run, "Run(scripts/**)", { argv: ["./x"], cwd: "scripts" })).toBe(true);
    expect(fires(run, "Run(scripts/**)", { argv: ["ls"], cwd: "scripts" })).toBe(false);
    expect(fires(run, "Run(rm*)", { argv: ["ls"], cwd: "rmtemp" })).toBe(false);
    expect(fires(run, "Run(rm*)", { argv: ["rm", "x"], cwd: "rmtemp" })).toBe(true);
    // A directory the runtime resolves through a symlink is read where it
    // leads, too.
    const linked: PathCanonicalizer = (raw) =>
      raw === "bin"
        ? [{ kind: "path", canonical: ["tools/bin", "./tools/bin"], spellings: ["bin"] }]
        : lexicalPathValues(raw);
    expect(
      on("restrict", linked)(run, "Run(tools/bin/deploy*)", { argv: ["./deploy"], cwd: "bin" }),
    ).toBe(true);
    // And an allow still does not follow the call into the directory.
    expect(
      on("allow")(run, "Run(sh scripts/release.sh)", {
        argv: ["sh", "release.sh"],
        cwd: "scripts",
      }),
    ).toBe(false);
  });

  // wave III review: the join above also joined every spelling the runtime's
  // canonicaliser gives the directory — its absolute paths under each alias
  // of the workspace root, and a `./sub` form — and the bare program. So
  // `alwaysDeny RunCommand(./**)` denied `git status` run in `packages/api`,
  // and `RunCommand(**prod**)` every command run in a subdirectory of a
  // workspace at `…/prod-agent`, while the same commands run from the root
  // were allowed.
  test("a command run in a subdirectory is read with what the call named, not the workspace's own path", () => {
    const run = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()), cwd: z.string().optional() }),
      operativeArgs: [{ field: "argv", kind: "command", within: "cwd" }],
      execute: async () => "ok",
    });
    // What runtime-core's canonicaliser gives a directory in a workspace at
    // /private/var/tmp/prod-agent (reached through /var as well).
    const root = "/private/var/tmp/prod-agent";
    const realLike: PathCanonicalizer = (raw) => {
      const rel = raw.startsWith(`${root}/`) ? raw.slice(root.length + 1) : raw;
      const p = rel.replace(/\/+$/, "").replace(/^\.\//, "");
      if (p === "" || p === ".") return [{ kind: "path", canonical: [".", root] }];
      return [
        {
          kind: "path",
          canonical: [p, `./${p}`, `${root}/${p}`],
          spellings: [raw, p, `${root}/${p}`, `/var/tmp/prod-agent/${p}`],
          caseInsensitive: true,
        },
      ];
    };
    const fires = (pattern: string, input: unknown) =>
      matchesPattern(compilePattern(pattern), "Run", input, {
        polarity: "restrict",
        operativeValues: operativeValuesFor(run, input, { canonicalizePath: realLike }) ?? [],
      });
    const sub = { argv: ["git", "status"], cwd: "packages/api" };
    const touch = { argv: ["touch", "ran-sub"], cwd: "packages/api" };
    expect({
      dotStar: fires("Run(./**)", sub),
      prod: fires("Run(**prod**)", touch),
      absolute: fires("Run(/private/var/**)", touch),
      viaAlias: fires("Run(/var/tmp/**)", touch),
      program: fires("Run(packages/api/git*)", sub),
    }).toEqual({ dotStar: false, prod: false, absolute: false, viaAlias: false, program: false });
    // The same rules on the same commands run from the root, for comparison.
    expect(fires("Run(./**)", { argv: ["git", "status"] })).toBe(false);
    expect(fires("Run(**prod**)", { argv: ["touch", "ran-root"] })).toBe(false);
    // What the call did name is still read: a word it wrote with `./`, a
    // file argument, a program run by its path, and a directory it wrote
    // absolute — the call named that path itself.
    expect(fires("Run(./**)", { argv: ["sh", "./x.sh"], cwd: "packages/api" })).toBe(true);
    expect(fires("Run(packages/api/ran-sub)", touch)).toBe(true);
    expect(fires("Run(packages/api/build.sh)", { argv: ["./build.sh"], cwd: "packages/api" })).toBe(
      true,
    );
    expect(fires("Run(**prod**)", { argv: ["touch", "x"], cwd: `${root}/packages/api` })).toBe(
      true,
    );
    // An argument word may name a file there, so a rule about the directory
    // reads it — `status` is a subcommand, but nothing in the call says so.
    expect(fires("Run(**/api/**)", sub)).toBe(true);
  });

  // wave III review: a maximal RunPipeline took 1.2–2 s per call to check,
  // synchronously in the gate, because every directory spelling × 2 joins
  // added 2 whole command lines of up to 128 words each.
  test("a maximal pipeline run in a subdirectory is read with a bounded number of spellings", () => {
    const pipe = buildTool({
      name: "Pipe",
      description: "d",
      inputSchema: z.object({
        steps: z.array(z.object({ argv: z.array(z.string()), cwd: z.string().optional() })),
        cwd: z.string().optional(),
      }),
      operativeArgs: [{ field: "steps.argv", kind: "command", within: "cwd" }],
      execute: async () => "ok",
    });
    const root = "/private/var/tmp/ws";
    const realLike: PathCanonicalizer = (raw) => [
      {
        kind: "path",
        canonical: [raw, `./${raw}`, `${root}/${raw}`],
        spellings: [raw, `${root}/${raw}`, `/var/tmp/ws/${raw}`, `/tmp/ws/${raw}`],
      },
    ];
    const argv = ["tool", ...Array.from({ length: 127 }, (_, i) => `arg${i}`)];
    const steps = Array.from({ length: 20 }, () => ({ argv }));
    const values =
      operativeValuesFor(pipe, { cwd: "packages/api", steps }, { canonicalizePath: realLike }) ??
      [];
    expect(values).toHaveLength(20);
    const per = values.map((v) => ({
      spellings: v.spellings?.length ?? 0,
      // A whole command line is the costly kind to match.
      lines: (v.spellings ?? []).filter((s) => s.includes(" ")).length,
    }));
    // The argv as written (128 words + the line), each argument joined to
    // the one directory (127), and the joined line: 257. Before: 649 and 21.
    expect(per.every((p) => p.spellings <= 2 * argv.length + 4 && p.lines <= 2)).toBe(true);
    expect(per[0]).toEqual({ spellings: 257, lines: 2 });
  });

  // wave III review: `envSet` wins over the pinned PATH, and a relative PATH
  // entry is looked up from the workspace root, so `[release.sh]` with
  // `PATH: scripts` ran scripts/release.sh; `BASH_ENV` ran it before any
  // `bash -c`. No rule saw the environment, so a deny naming the script
  // allowed both.
  test("a deny reads a command's environment: PATH lookups and every value the call sets", () => {
    const run = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({
        argv: z.array(z.string()),
        cwd: z.string().optional(),
        envSet: z.record(z.string()).optional(),
      }),
      operativeArgs: [{ field: "argv", kind: "command", within: "cwd", env: "envSet" }],
      execute: async () => "ok",
    });
    const ws = "/w/ws";
    const rooted: PathCanonicalizer = (raw) =>
      raw.startsWith(`${ws}/`)
        ? [{ kind: "path", canonical: [raw.slice(ws.length + 1), raw] }]
        : raw.startsWith("/")
          ? [{ kind: "path", canonical: [], spellings: [raw], outsideWorkspace: true }]
          : lexicalPathValues(raw);
    const at = (polarity: "allow" | "restrict", pattern: string, input: unknown) =>
      matchesPattern(compilePattern(pattern), "Run", input, {
        polarity,
        operativeValues: operativeValuesFor(run, input, { canonicalizePath: rooted }) ?? [],
      });
    const release = "Run(*scripts/release.sh*)";
    const exact = "Run(scripts/release.sh)";
    const cases: Array<[string, Record<string, unknown>]> = [
      [release, { argv: ["release.sh"], envSet: { PATH: "scripts" } }],
      [exact, { argv: ["release.sh"], envSet: { PATH: "scripts:/usr/bin" } }],
      [exact, { argv: ["release.sh"], envSet: { PATH: "/usr/bin:./scripts/" } }],
      [exact, { argv: ["release.sh"], envSet: { PATH: `${ws}/scripts` } }],
      [exact, { argv: ["release.sh", "--now"], envSet: { Path: "scripts" } }],
      [release, { argv: ["bash", "-c", "true"], envSet: { BASH_ENV: "scripts/release.sh" } }],
      [exact, { argv: ["bash", "-c", "true"], envSet: { BASH_ENV: "release.sh" }, cwd: "scripts" }],
      [
        exact,
        { argv: ["node", "x.js"], envSet: { NODE_OPTIONS: "--require=./scripts/release.sh" } },
      ],
      [exact, { argv: ["sh", "x"], envSet: { LD_PRELOAD: "lib/a.so scripts/./release.sh" } }],
      // A relative PATH entry is looked up from the root and run from the
      // child's directory (Bun's spawn): both are read.
      [exact, { argv: ["release.sh"], envSet: { PATH: "." }, cwd: "scripts" }],
      ["Run(sub/bin/tool)", { argv: ["tool"], envSet: { PATH: "bin" }, cwd: "sub" }],
      ["Run(bin/tool)", { argv: ["tool"], envSet: { PATH: "bin" }, cwd: "sub" }],
      [
        "Run(scripts/release.sh --now)",
        { argv: ["release.sh", "--now"], envSet: { PATH: "scripts" } },
      ],
    ];
    expect(
      cases
        .filter(([p, input]) => !at("restrict", p, input))
        .map(([p, input]) => `${p} ${JSON.stringify(input)}`),
    ).toEqual([]);
    // An absolute entry outside the workspace is read as written only.
    expect(at("restrict", exact, { argv: ["release.sh"], envSet: { PATH: "/opt/scripts" } })).toBe(
      false,
    );
    expect(
      at("restrict", "Run(/opt/scripts/release.sh)", {
        argv: ["release.sh"],
        envSet: { PATH: "/opt/scripts" },
      }),
    ).toBe(true);
    // A program run by its path is not looked up on PATH.
    expect(at("restrict", "Run(bin/x)", { argv: ["./x"], envSet: { PATH: "bin" } })).toBe(false);
    // An environment unrelated to what a deny names leaves it alone.
    expect(at("restrict", release, { argv: ["git", "status"], envSet: { CI: "1" } })).toBe(false);
    // An allow names the command, and the environment may change what that
    // command runs: a call that sets any variable asks under a scoped allow.
    expect(at("allow", "Run(git status)", { argv: ["git", "status"] })).toBe(true);
    expect(at("allow", "Run(git status)", { argv: ["git", "status"], envSet: {} })).toBe(true);
    expect(at("allow", "Run(git status)", { argv: ["git", "status"], envSet: { CI: "1" } })).toBe(
      false,
    );
    expect(at("allow", "Run(git*)", { argv: ["git"], envSet: { PATH: "scripts" } })).toBe(false);
    expect(at("allow", "Run(*)", { argv: ["git"], envSet: { PATH: "scripts" } })).toBe(false);
    // An allow that names every command still covers it, whichever program
    // it turns out to be — as 0.7.0's `Run(**)` did.
    expect(at("allow", "Run(**)", { argv: ["git"], envSet: { PATH: "scripts" } })).toBe(true);
    // Too large to read one by one: every deny or ask fires, and says why
    // through outsideWorkspace (which program runs could not be worked out).
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, "x"]));
    const long = { V: "a".repeat(8193) };
    const words = { V: Array.from({ length: 65 }, (_, i) => `w${i}`).join(" ") };
    for (const envSet of [many, long, words]) {
      expect(at("restrict", "Run(nothing-like-it)", { argv: ["git"], envSet })).toBe(true);
      // An allow naming a command still asks; one naming every command still
      // covers it, as 0.7.0's `Run(**)` did — which program runs is all the
      // environment decides (a >8 KiB JSON config in one variable asked).
      expect(at("allow", "Run(git*)", { argv: ["git"], envSet })).toBe(false);
      expect(at("allow", "Run(**)", { argv: ["git"], envSet })).toBe(true);
    }
    const within = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`V${i}`, "x"]));
    expect(at("restrict", "Run(nothing-like-it)", { argv: ["git"], envSet: within })).toBe(false);
    // A tool that does not declare its environment keeps reading argv alone.
    const blind = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()), envSet: z.record(z.string()).optional() }),
      operativeArgs: [{ field: "argv", kind: "command" }],
      execute: async () => "ok",
    });
    const input = { argv: ["release.sh"], envSet: { PATH: "scripts" } };
    expect(
      matchesPattern(compilePattern(exact), "Run", input, {
        polarity: "restrict",
        operativeValues: operativeValuesFor(blind, input) ?? [],
      }),
    ).toBe(false);
  });

  // The attack round's root-cwd spellings: a deny naming the script fired on
  // `[sh, scripts/release.sh]` and not on the same path written with a
  // doubled or `./` segment.
  test("a word naming a file through `.` or `//` is also read collapsed", () => {
    const run = buildTool({
      name: "Run",
      description: "d",
      inputSchema: z.object({ argv: z.array(z.string()) }),
      operativeArgs: [{ field: "argv", kind: "command" }],
      execute: async () => "ok",
    });
    const fires = (pattern: string, argv: string[]) =>
      matchesPattern(
        compilePattern(pattern),
        "Run",
        { argv },
        {
          polarity: "restrict",
          operativeValues: operativeValuesFor(run, { argv }) ?? [],
        },
      );
    const exact = "Run(scripts/release.sh)";
    expect(
      [
        ["sh", "scripts//release.sh"],
        ["sh", "scripts/./release.sh"],
        ["sh", "./scripts/release.sh"],
        ["sh", "other/../scripts/release.sh"],
        ["./scripts/release.sh"],
      ].filter((argv) => !fires(exact, argv)),
    ).toEqual([]);
    expect(fires("Run(sh scripts/release.sh)", ["sh", "./scripts//release.sh"])).toBe(true);
    // A path that climbs out is not collapsed into one inside.
    expect(fires(exact, ["sh", "../scripts/release.sh"])).toBe(false);
    // An allow still reads only what was written.
    expect(
      matchesPattern(
        compilePattern("Run(sh scripts/release.sh)"),
        "Run",
        { argv: ["sh", "scripts//release.sh"] },
        {
          polarity: "allow",
          operativeValues: operativeValuesFor(run, { argv: ["sh", "scripts//release.sh"] }) ?? [],
        },
      ),
    ).toBe(false);
  });

  // merge-seams (wave III): the documented `default: "*"` — "a deny or ask
  // naming any one value there fires" — held for ids only. A path, a URL, or
  // a command run outside the root came back as the literal `*`, which no
  // deny naming a real place matched.
  test("a left-out path, URL or command whose default is * stands for every value", () => {
    const probe = (operativeArgs: Parameters<typeof buildTool>[0]["operativeArgs"]) =>
      buildTool({
        name: "Probe",
        description: "d",
        inputSchema: z.object({
          path: z.string().optional(),
          url: z.string().optional(),
          argv: z.array(z.string()).optional(),
          cwd: z.string().optional(),
        }),
        operativeArgs,
        execute: async () => "ok",
      });
    const on =
      (polarity: "allow" | "restrict") =>
      (tool: ReturnType<typeof probe>, input: unknown, canonicalizePath?: PathCanonicalizer) =>
      (pattern: string) =>
        matchesPattern(compilePattern(pattern), "Probe", input, {
          polarity,
          operativeValues:
            operativeValuesFor(
              tool,
              input,
              canonicalizePath !== undefined ? { canonicalizePath } : {},
            ) ?? [],
        });
    const fires = on("restrict");
    const grants = on("allow");

    const path = probe([{ field: "path", kind: "path", default: "*" }]);
    expect(["Probe(secret/**)", "Probe(**/.env)"].filter(fires(path, {}))).toHaveLength(2);
    expect(fires(path, {})("Probe(/etc/**)")).toBe(false);
    expect(grants(path, {})("Probe(**)")).toBe(true);
    expect(["Probe(*)", "Probe(?)", "Probe(src/**)"].filter(grants(path, {}))).toEqual([]);
    // With the runtime's absolute spelling of the root, an absolute deny too.
    const rooted: PathCanonicalizer = (raw) =>
      raw === "." ? [{ kind: "path", canonical: [".", "/ws"] }] : lexicalPathValues(raw);
    expect(fires(path, {}, rooted)("Probe(/ws/secret/**)")).toBe(true);
    expect(fires(path, {}, rooted)("Probe(/etc/**)")).toBe(false);

    const scoped = probe([{ field: "path", kind: "path", within: "cwd", default: "*" }]);
    expect(fires(scoped, { cwd: "pkg" })("Probe(pkg/secret/**)")).toBe(true);
    expect(fires(scoped, { cwd: "pkg" })("Probe(other/**)")).toBe(false);
    expect(grants(scoped, { cwd: "pkg" })("Probe(pkg/**)")).toBe(true);
    expect(grants(scoped, { cwd: "pkg" })("Probe(pkg/*)")).toBe(false);
    // A directory outside the workspace: every deny fires, no allow grants.
    expect(fires(scoped, { cwd: "../x" })("Probe(nothing-like-it)")).toBe(true);
    expect(grants(scoped, { cwd: "../x" })("Probe(**)")).toBe(false);

    const url = probe([{ field: "url", kind: "url", default: "*" }]);
    expect(fires(url, {})("Probe(https://evil.example/**)")).toBe(true);
    expect(grants(url, {})("Probe(**)")).toBe(true);
    expect(grants(url, {})("Probe(https://**)")).toBe(false);

    const cmd = probe([{ field: "argv", kind: "command", within: "cwd", default: "*" }]);
    for (const input of [{}, { cwd: "." }, { cwd: "sub" }]) {
      expect({ input, fires: fires(cmd, input)("Probe(rm*)") }).toEqual({ input, fires: true });
      expect({ input, fires: fires(cmd, input)("Probe(*/deploy.sh)") }).toEqual({
        input,
        fires: true,
      });
    }
    expect(grants(cmd, {})("Probe(**)")).toBe(true);
    expect(grants(cmd, {})("Probe(*)")).toBe(false);
    // Run elsewhere, it is still any command, which `**` names; `*` does not.
    expect(grants(cmd, { cwd: "sub" })("Probe(**)")).toBe(true);
    expect(grants(cmd, { cwd: "sub" })("Probe(*)")).toBe(false);
  });

  test("an EvmGetLogs-shaped every-contract query: a deny in another case fires, `?` grants nothing", () => {
    const logs = buildTool({
      name: "Logs",
      description: "d",
      inputSchema: z.object({ chainId: z.string(), address: z.string().optional() }),
      operativeArgs: [{ field: "address", kind: "id", within: "chainId", default: "*" }],
      readOnly: true,
      execute: async () => "ok",
    });
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const at = (polarity: "allow" | "restrict", pattern: string, input: unknown) =>
      matchesPattern(compilePattern(pattern), "Logs", input, {
        polarity,
        operativeValues: operativeValuesFor(logs, input) ?? [],
      });
    const every = { chainId: "base" };
    const one = { chainId: "base", address: USDT };
    // The narrower query and the broader one are caught alike.
    for (const deny of [`Logs(Base/${USDT})`, `Logs(BASE/${USDT.toLowerCase()})`]) {
      expect({ deny, one: at("restrict", deny, one), every: at("restrict", deny, every) }).toEqual({
        deny,
        one: true,
        every: true,
      });
    }
    expect(at("restrict", `Logs(137/${USDT})`, every)).toBe(false);
    expect(at("allow", "Logs(base/?)", every)).toBe(false);
    expect(at("allow", "Logs(base/*)", every)).toBe(true);
  });

  test("an empty declaration is matched like no declaration: on the string values", () => {
    const tool = buildTool({
      name: "Clip",
      description: "d",
      inputSchema: z.object({ text: z.string() }),
      operativeArgs: [],
      execute: async () => "ok",
    });
    expect(operativeValuesFor(tool, { text: "secret" })).toBeUndefined();
    const subject = preparePermissionSubject(tool, { text: "secret" });
    expect(subject.ok && subject.operativeValues).toBe(undefined);
    // So a deny on the content still fires, as it did in 0.7.0.
    expect(
      matchesPattern(
        compilePattern("Clip(*secret*)"),
        "Clip",
        { text: "a secret" },
        {
          polarity: "restrict",
        },
      ),
    ).toBe(true);
  });

  test("dotted fields walk objects and every array element", () => {
    const arg = { field: "requests.url", kind: "url" } as const;
    expect(
      readOperativeField({ requests: [{ url: "https://a/" }, { url: "https://b/" }, {}] }, arg),
    ).toEqual(["https://a/", "https://b/"]);
    // Only own keys: a prototype name is not a field.
    expect(readOperativeField({}, { field: "constructor", kind: "text" })).toEqual([]);
  });

  test("a declared default stands in for an omitted field (permission-integration#0)", () => {
    const arg = { field: "path", kind: "path", default: ".env" } as const;
    expect(readOperativeField({ entries: [] }, arg)).toEqual([".env"]);
    expect(readOperativeField({ path: "config/.env" }, arg)).toEqual(["config/.env"]);
  });
});

describe("a secret reference (critic8)", () => {
  const lookup = () =>
    buildTool({
      name: "LookupLike",
      description: "check references",
      inputSchema: z.object({ refs: z.array(z.string()) }),
      readOnly: true,
      operativeArgs: [{ field: "refs", kind: "id", secretRef: true }],
      execute: async () => "ok",
    });
  const on = (ref: string, pattern: string, polarity: "allow" | "restrict") =>
    matchesPattern(
      compilePattern(pattern),
      "LookupLike",
      {},
      { polarity, operativeValues: operativeValuesFor(lookup(), { refs: [ref] }) ?? [] },
    );

  test("a file: reference is matched with its file collapsed, and trimmed as the tool trims it", () => {
    for (const ref of [
      "file:secrets/token",
      "file:./secrets/token",
      "file:secrets//token",
      "file:pub/../secrets/token",
      " file:secrets/token",
      "\tfile:./secrets/token\u00a0",
    ]) {
      expect({ ref, deny: on(ref, "LookupLike(file:secrets/**)", "restrict") }).toEqual({
        ref,
        deny: true,
      });
      // The file itself, for a deny written as a path.
      expect({ ref, deny: on(ref, "LookupLike(secrets/**)", "restrict") }).toEqual({
        ref,
        deny: true,
      });
      // An allow names where it lands.
      expect({ ref, allow: on(ref, "LookupLike(file:secrets/token)", "allow") }).toEqual({
        ref,
        allow: true,
      });
      expect({ ref, allow: on(ref, "LookupLike(file:pub/**)", "allow") }).toEqual({
        ref,
        allow: false,
      });
    }
    // A path value is never granted by an allow written as a path.
    expect(on("file:pub/token", "LookupLike(pub/**)", "allow")).toBe(false);
  });

  test("an envfile: reference names the file before its last #", () => {
    const values = operativeValuesFor(lookup(), { refs: ["envfile:./a#b/.env#KEY"] }) ?? [];
    expect(values.map((v) => [v.kind, v.canonical[0], v.restrictOnly === true])).toEqual([
      ["id", "envfile:a#b/.env#KEY", false],
      ["path", "a#b/.env", true],
    ]);
  });

  test("a file outside the workspace is outside: every deny fires, no allow grants it", () => {
    expect(on("file:../outside", "LookupLike(env:NEVER)", "restrict")).toBe(true);
    expect(on("file:../outside", "LookupLike(**)", "allow")).toBe(false);
    expect(on("file:../outside", "LookupLike(file:**)", "allow")).toBe(false);
    // The reference itself is flagged outside, not only the file beside it:
    // an allow is never shown a place to name.
    const values = operativeValuesFor(lookup(), { refs: ["file:../outside"] }) ?? [];
    expect(values.map((v) => [v.kind, v.canonical, v.outsideWorkspace === true])).toEqual([
      ["id", [], true],
      ["path", [], true],
    ]);
  });

  test("an env: reference is granted by name, and a deny on an env file it is loaded from fires", () => {
    // The environment `env:NAME` reads holds `.env.local` and `.env` in every
    // harness (the supervisor merges them in; Bun loads them on start), so
    // a deny or ask reads those two as for a bare NAME — not the secrets
    // directory, which only the bare NAME's chain looks in.
    const values = operativeValuesFor(lookup(), { refs: [" env:API_KEY"] }) ?? [];
    expect(values.filter((v) => v.restrictOnly !== true).map((v) => v.canonical)).toEqual([
      ["env:API_KEY"],
    ]);
    expect(values.filter((v) => v.restrictOnly === true).map((v) => v.canonical[0])).toEqual([
      "envfile:.env.local#API_KEY",
      ".env.local",
      "envfile:.env#API_KEY",
      ".env",
    ]);
    expect(on("env:API_KEY", "LookupLike(env:API_KEY)", "allow")).toBe(true);
    for (const deny of [
      "LookupLike(.env)",
      "LookupLike(.env.local)",
      "LookupLike(envfile:.env#**)",
    ]) {
      expect({ deny, fires: on("env:API_KEY", deny, "restrict") }).toEqual({ deny, fires: true });
    }
    // Control: a deny about the secrets directory, or another variable's
    // envfile reference, stays quiet; so does a name the tool refuses.
    for (const deny of ["LookupLike(.crewhaus/secrets/**)", "LookupLike(envfile:.env#OTHER)"]) {
      expect({ deny, fires: on("env:API_KEY", deny, "restrict") }).toEqual({ deny, fires: false });
    }
    expect(on("env:9_LIVES", "LookupLike(.env)", "restrict")).toBe(false);
  });

  test("every other form is an id, trimmed; one the tool refuses names no file", () => {
    for (const [ref, id] of [
      ["env:HOME", "env:HOME"],
      [" env:HOME ", "env:HOME"],
      ["keychain:acme#deploy", "keychain:acme#deploy"],
      ["op://vault/item/field", "op://vault/item/field"],
      ["File:secrets/token", "File:secrets/token"],
      ["file:", "file:"],
      ["envfile:secrets/.env", "envfile:secrets/.env"],
      ["envfile:#KEY", "envfile:#KEY"],
      ["file:secrets/token\nx", "file:secrets/token\nx"],
    ] as const) {
      // What an allow reads; an env: one's env files are read by a deny alone.
      const values = (operativeValuesFor(lookup(), { refs: [ref] }) ?? []).filter(
        (v) => v.restrictOnly !== true,
      );
      expect({ ref, values: values.map((v) => [v.kind, v.canonical]) }).toEqual({
        ref,
        values: [["id", [id]]],
      });
    }
    expect(on(" env:HOME", "LookupLike(env:HOME)", "allow")).toBe(true);
  });

  test("a bare NAME is granted by name, and a deny on a file its chain reads fires on it", () => {
    const values = operativeValuesFor(lookup(), { refs: [" SLACK_TOKEN"] }) ?? [];
    // What an allow reads: the name, trimmed.
    expect(values.filter((v) => v.restrictOnly !== true).map((v) => v.canonical)).toEqual([
      ["SLACK_TOKEN"],
    ]);
    expect(on("SLACK_TOKEN", "LookupLike(SLACK_TOKEN)", "allow")).toBe(true);
    for (const deny of [
      "LookupLike(.env)",
      "LookupLike(.env.local)",
      "LookupLike(.crewhaus/secrets/**)",
      "LookupLike(envfile:.env#SLACK_TOKEN)",
      "LookupLike(file:.crewhaus/secrets/*)",
    ]) {
      expect({ deny, fires: on("SLACK_TOKEN", deny, "restrict") }).toEqual({ deny, fires: true });
    }
    // Control: a name the tool refuses is looked up nowhere.
    expect(on("9_LIVES", "LookupLike(.env)", "restrict")).toBe(false);
    expect(on("SLACK_TOKEN", "LookupLike(secrets/**)", "restrict")).toBe(false);
  });

  test("a source field is read by a deny or ask only", () => {
    const upsert = buildTool({
      name: "UpsertLike",
      description: "copy a secret into a file",
      inputSchema: z.object({
        path: z.string().optional(),
        entries: z.array(z.object({ key: z.string(), valueFrom: z.string().optional() })),
      }),
      destructive: true,
      operativeArgs: [
        { field: "path", kind: "path", default: ".env" },
        { field: "entries.valueFrom", kind: "id", secretRef: true, source: true },
      ],
      execute: async () => "ok",
    });
    const values =
      operativeValuesFor(upsert, { entries: [{ key: "A", valueFrom: "file:pub/../secrets/t" }] }) ??
      [];
    expect(values.map((v) => [v.kind, v.canonical[0], v.restrictOnly === true])).toEqual([
      ["path", ".env", false],
      ["id", "file:secrets/t", true],
      ["path", "secrets/t", true],
    ]);
    const match = (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(
        compilePattern(pattern),
        "UpsertLike",
        {},
        { polarity, operativeValues: values },
      );
    expect(match("UpsertLike(file:secrets/**)", "restrict")).toBe(true);
    expect(match("UpsertLike(secrets/**)", "restrict")).toBe(true);
    expect(match("UpsertLike(.env)", "allow")).toBe(true);
  });
});

describe("a relocating field's default (C004)", () => {
  // The tool-state shape: a store directory the tool defaults in execute, and
  // the record inside it that the call names.
  const kvLike = () =>
    buildTool({
      name: "KvLike",
      description: "store a value",
      inputSchema: z.object({
        namespace: z.string().optional(),
        key: z.string().optional(),
        stateDir: z.string().optional(),
      }),
      destructive: true,
      operativeArgs: [
        { field: "stateDir", kind: "path", default: ".crewhaus/state", relocates: true },
        { field: "key", kind: "id", within: "namespace" },
      ],
      execute: async () => "ok",
    });

  test("left out beside a record, it is read by a deny or ask only", () => {
    const values = operativeValuesFor(kvLike(), { namespace: "ns", key: "k" }) ?? [];
    expect(values.map((v) => [v.kind, v.canonical[0], v.restrictOnly === true])).toEqual([
      ["id", "ns/k", false],
      ["path", ".crewhaus/state", true],
    ]);
    const deny = compilePattern("KvLike(.crewhaus/state/**)");
    const allowKey = compilePattern("KvLike(ns/*)");
    expect(
      matchesPattern(deny, "KvLike", {}, { polarity: "restrict", operativeValues: values }),
    ).toBe(true);
    expect(
      matchesPattern(allowKey, "KvLike", {}, { polarity: "allow", operativeValues: values }),
    ).toBe(true);
  });

  test("named by the call, it is a value like any other: an allow must cover it too", () => {
    const values =
      operativeValuesFor(kvLike(), { namespace: "ns", key: "k", stateDir: ".crewhaus/state" }) ??
      [];
    expect(values.some((v) => v.restrictOnly === true)).toBe(false);
    const allowKey = compilePattern("KvLike(ns/*)");
    expect(
      matchesPattern(allowKey, "KvLike", {}, { polarity: "allow", operativeValues: values }),
    ).toBe(false);
  });

  test("with nothing else to read, the default is the call's place, for every rule", () => {
    const values = operativeValuesFor(kvLike(), {}) ?? [];
    expect(values.map((v) => [v.canonical[0], v.restrictOnly === true])).toEqual([
      [".crewhaus/state", false],
    ]);
    const allowStore = compilePattern("KvLike(.crewhaus/state)");
    expect(
      matchesPattern(allowStore, "KvLike", {}, { polarity: "allow", operativeValues: values }),
    ).toBe(true);
  });

  test("a store read whole beside a record is read with what is beneath it, on its default too", () => {
    // DatasetMine: every session log in `sessionsDir`, whatever dataset the
    // call names to dedupe against.
    const mine = buildTool({
      name: "MineLike",
      description: "mine",
      inputSchema: z.object({
        sessionsDir: z.string().optional(),
        dedupeAgainst: z.string().optional(),
      }),
      readOnly: true,
      operativeArgs: [
        {
          field: "sessionsDir",
          kind: "path",
          default: ".crewhaus/sessions",
          relocates: true,
          beneath: "all",
        },
        { field: "dedupeAgainst", kind: "id" },
      ],
      execute: async () => "ok",
    });
    const on = (input: unknown, pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(
        compilePattern(pattern),
        "MineLike",
        {},
        { polarity, operativeValues: operativeValuesFor(mine, input) ?? [] },
      );
    const oneLog = "MineLike(.crewhaus/sessions/sess_private.jsonl)";
    // Left out beside a record: a deny on one log fires, an allow on the
    // record still covers the ordinary call.
    expect(on({ dedupeAgainst: "golden" }, oneLog, "restrict")).toBe(true);
    expect(on({ dedupeAgainst: "golden" }, "MineLike(golden)", "allow")).toBe(true);
    // Named, and left out with nothing beside it: the same deny fires.
    expect(on({ sessionsDir: ".crewhaus/sessions" }, oneLog, "restrict")).toBe(true);
    expect(on({}, oneLog, "restrict")).toBe(true);
    expect(on({ sessionsDir: "." }, "MineLike(secrets/**)", "restrict")).toBe(true);
    // Control: a deny about another place stays quiet.
    expect(on({ dedupeAgainst: "golden" }, "MineLike(secrets/**)", "restrict")).toBe(false);
  });

  test("a url default that only moves the tool off its fixed service reads as a url", () => {
    // DependencyAudit: the lockfile's versions go to the public OSV
    // database unless the call names another endpoint.
    const audit = buildTool({
      name: "AuditLike",
      description: "audit",
      inputSchema: z.object({ cwd: z.string().optional(), endpoint: z.string().optional() }),
      readOnly: true,
      operativeArgs: [
        { field: "cwd", kind: "path", default: "." },
        { field: "endpoint", kind: "url", default: "https://api.osv.dev", relocates: true },
      ],
      execute: async () => "ok",
    });
    const values = operativeValuesFor(audit, { cwd: "." }) ?? [];
    expect(values.map((v) => [v.kind, v.canonical, v.restrictOnly === true])).toEqual([
      ["path", ["."], false],
      ["url", ["https://api.osv.dev/", "https://api.osv.dev"], true],
    ]);
    const on = (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(
        compilePattern(pattern),
        "AuditLike",
        {},
        { polarity, operativeValues: values },
      );
    expect(on("AuditLike(.)", "allow")).toBe(true);
    expect(on("AuditLike(https://api.osv.dev/**)", "restrict")).toBe(true);
  });

  test("a default without relocates is one more value every rule reads", () => {
    const plain = buildTool({
      name: "PlainLike",
      description: "store a value",
      inputSchema: z.object({ key: z.string(), dir: z.string().optional() }),
      destructive: true,
      operativeArgs: [
        { field: "dir", kind: "path", default: "." },
        { field: "key", kind: "id" },
      ],
      execute: async () => "ok",
    });
    const values = operativeValuesFor(plain, { key: "k" }) ?? [];
    expect(values.some((v) => v.restrictOnly === true)).toBe(false);
    expect(
      matchesPattern(
        compilePattern("PlainLike(k)"),
        "PlainLike",
        {},
        {
          polarity: "allow",
          operativeValues: values,
        },
      ),
    ).toBe(false);
  });
});

describe("executeTool allowedPatterns match the parsed, canonical call (security-1#0)", () => {
  test("a decoy key the schema strips does not satisfy an allow", async () => {
    const r = await executeTool(
      writeLike(),
      { file_path: "src/ok.ts", path: ".git/hooks/pre-commit", content: "x" },
      { toolUseId: "t1", allowedPatterns: ["WriteLike(src/**)"] },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toBe('tool "WriteLike" is not permitted by the current permission set');
  });

  test("`..` is matched where it lands", async () => {
    const out = await executeTool(
      writeLike(),
      { path: "src/../.git/hooks/pre-commit", content: "x" },
      { toolUseId: "t2", allowedPatterns: ["WriteLike(src/**)"] },
    );
    expect(out.isError).toBe(true);
    const ok = await executeTool(
      writeLike(),
      { path: "build/../src/app.ts", content: "x" },
      { toolUseId: "t3", allowedPatterns: ["WriteLike(src/**)"] },
    );
    expect(ok).toEqual({ toolUseId: "t3", content: "wrote build/../src/app.ts", isError: false });
  });

  test("a caller's canonicaliser decides where a path lands", async () => {
    // What a Node caller with a workspace does: `build/link` is a symlink to
    // src/, so a write through it is a write to src/.
    const followLink: PathCanonicalizer = (raw) => [
      { kind: "path", canonical: [raw.replace(/^build\/link\//, "src/")], spellings: [raw] },
    ];
    const refused = await executeTool(
      writeLike(),
      { path: "build/link/app.ts", content: "x" },
      { toolUseId: "t4", allowedPatterns: ["WriteLike(build/**)"], canonicalizePath: followLink },
    );
    expect(refused.isError).toBe(true);
    const ok = await executeTool(
      writeLike(),
      { path: "build/link/app.ts", content: "x" },
      { toolUseId: "t5", allowedPatterns: ["WriteLike(src/**)"], canonicalizePath: followLink },
    );
    expect(ok).toEqual({ toolUseId: "t5", content: "wrote build/link/app.ts", isError: false });
  });

  test("the matcher is handed exactly these values", () => {
    const tool = writeLike();
    const values = operativeValuesFor(tool, { path: "build/../src/a", content: "" });
    const p = compilePattern("WriteLike(src/**)");
    expect(
      matchesPattern(
        p,
        tool.name,
        {},
        { polarity: "allow", ...(values ? { operativeValues: values } : {}) },
      ),
    ).toBe(true);
  });
});

// critic8 (0.7.1): a command word naming a file was read as text, its `..`
// collapsed before any link was followed, so `./scripts/../evil.sh` was
// granted by `Run(./scripts/**)` and `link/../run.sh` missed a deny on the
// `secrets/run.sh` the kernel runs. Here, without a filesystem: the reading
// with no reader, and the rewrite with a scripted one. The kernel's own
// reading, through the real tools, is in apps/cli's permission-hardening.
describe("a command word that names a file is read where the kernel finds it", () => {
  const run = buildTool({
    name: "Run",
    description: "d",
    inputSchema: z.object({
      argv: z.array(z.string()),
      cwd: z.string().optional(),
      envSet: z.record(z.string()).optional(),
    }),
    operativeArgs: [{ field: "argv", kind: "command", within: "cwd", env: "envSet" }],
    execute: async () => "ok",
  });
  const sh = buildTool({
    name: "Sh",
    description: "d",
    inputSchema: z.object({ command: z.string() }),
    operativeArgs: [{ field: "command", kind: "command", shell: true }],
    execute: async () => "ok",
  });
  const decide =
    (readProgramPath?: ProgramPathReader) =>
    (polarity: "allow" | "restrict", pattern: string, input: Record<string, unknown>) => {
      const tool = "argv" in input ? run : sh;
      return matchesPattern(compilePattern(pattern), tool.name, input, {
        polarity,
        operativeValues:
          operativeValuesFor(
            tool,
            input,
            readProgramPath !== undefined ? { readProgramPath } : {},
          ) ?? [],
      });
    };

  test("with no reader, a program word with a `..` after a name is placed nowhere", () => {
    const at = decide();
    for (const input of [
      { argv: ["./scripts/../evil.sh"] },
      { argv: ["sh", "scripts/../evil.sh"] },
      { argv: ["env", "A=1", "./scripts/../evil.sh"] },
      { argv: ["sh", "-c", "./scripts/../evil.sh"] },
      { command: "true && ./scripts/../evil.sh" },
    ]) {
      const head = "argv" in input ? "Run" : "Sh";
      expect({
        input,
        scoped: at("allow", `${head}(./scripts/**)`, input),
        every: at("allow", `${head}(**)`, input),
        unrelated: at("restrict", `${head}(nothing-like-it)`, input),
      }).toEqual({ input, scoped: false, every: true, unrelated: true });
    }
    // Nor, in a command that changed directory first, one with any `..`.
    expect(at("restrict", "Run(nothing-like-it)", { argv: ["env", "-C", "sub", "../x.sh"] })).toBe(
      true,
    );
    expect(at("restrict", "Sh(nothing-like-it)", { command: "cd sub; ../x.sh" })).toBe(true);
  });

  test("control: with no reader, ordinary words and arguments read as before", () => {
    const at = decide();
    for (const [pattern, input] of [
      ["Run(./build.sh)", { argv: ["./build.sh"] }],
      ["Run(sh scripts/x.sh)", { argv: ["sh", "scripts/x.sh"] }],
      ["Run(../tools/x.sh)", { argv: ["../tools/x.sh"] }],
      ["Run(git diff a/../b)", { argv: ["git", "diff", "a/../b"] }],
      ["Sh(echo a/../b)", { command: "echo a/../b" }],
      ["Sh(cd sub && ./x.sh)", { command: "cd sub && ./x.sh" }],
    ] as const) {
      expect({ pattern, allow: at("allow", pattern, input) }).toEqual({ pattern, allow: true });
      expect({ pattern, unrelated: at("restrict", "Run(nothing-like-it)", input) }).toEqual({
        pattern,
        unrelated: false,
      });
    }
    // The `./` the call wrote is kept in the collapsed spelling a deny reads.
    expect(at("restrict", "Run(cat ./b)", { argv: ["cat", "./a/../b"] })).toBe(true);
    expect(at("restrict", "Run(./b)", { argv: ["cat", "./a/../b"] })).toBe(true);
  });

  /** A reader answering from a table: word (joined to its directory) → reading. */
  const table =
    (
      ws: string,
      entries: Record<string, Omit<ProgramPathReading, "asWritten" | "writtenInWorkspace">>,
    ) =>
    (
      word: string,
      runsIn: string | undefined,
      opts?: { readonly prefix?: string },
    ): ProgramPathReading | undefined => {
      const key = [runsIn, opts?.prefix, word].filter((p) => p !== undefined).join("/");
      const got = entries[key];
      if (got === undefined) return undefined;
      const lexical = key.startsWith("/") ? key : `${ws}/${key.replace(/^\.\//, "")}`;
      const asWritten = normalizePathLexically(lexical).path;
      return { ...got, asWritten, writtenInWorkspace: asWritten.startsWith(`${ws}/`) };
    };

  test("a word that lands elsewhere than it reads is put in its place for an allow", () => {
    const ws = "/ws";
    const at = decide(
      table(ws, {
        "./scripts/../evil.sh": { at: "/ws/evil.sh", inWorkspace: "evil.sh" },
        "./scripts/../deploy.sh": { at: "/ws/deploy.sh", inWorkspace: "deploy.sh" },
        "link/../run.sh": { at: "/ws/secrets/run.sh", inWorkspace: "secrets/run.sh" },
        "./tools/run.sh": { at: "/ws/safe/run.sh", inWorkspace: "safe/run.sh" },
        "./build.sh": { at: "/ws/build.sh", inWorkspace: "build.sh" },
        "./bin/tool": {
          at: "/ws/bin/tool",
          inWorkspace: "bin/tool",
          target: { at: "/ws/scripts/ok.sh", inWorkspace: "scripts/ok.sh" },
        },
        "/sys/bin/sh": { at: "/sys/usr/bin/sh" },
        "/sys/bin/../../ws/evil.sh": { at: "/ws/evil.sh", inWorkspace: "evil.sh" },
        // The same words with their `..` folded as text (node reads them so).
        "./evil.sh": { at: "/ws/evil.sh", inWorkspace: "evil.sh" },
        "./deploy.sh": { at: "/ws/deploy.sh", inWorkspace: "deploy.sh" },
        "./run.sh": { at: "/ws/run.sh", inWorkspace: "run.sh" },
        "/ws/evil.sh": { at: "/ws/evil.sh", inWorkspace: "evil.sh" },
      }),
    );
    const argv = (...a: string[]) => ({ argv: a });
    expect(at("allow", "Run(./scripts/**)", argv("./scripts/../evil.sh"))).toBe(false);
    expect(at("allow", "Run(./evil.sh)", argv("./scripts/../evil.sh"))).toBe(true);
    expect(
      at("restrict", "Run(./deploy.sh --force)", argv("./scripts/../deploy.sh", "--force")),
    ).toBe(true);
    expect(at("restrict", "Run(secrets/**)", argv("link/../run.sh"))).toBe(true);
    expect(at("restrict", "Run(nothing-like-it)", argv("link/../run.sh"))).toBe(false);
    expect(at("allow", "Run(./tools/**)", argv("./tools/run.sh"))).toBe(false);
    expect(at("allow", "Run(./safe/run.sh)", argv("./tools/run.sh"))).toBe(true);
    expect(at("restrict", "Run(./tools/run.sh)", argv("./tools/run.sh"))).toBe(true);
    // Unmoved, a word is read as written; the workspace's own absolute path
    // is not a spelling the call named.
    expect(at("allow", "Run(./build.sh)", argv("./build.sh"))).toBe(true);
    expect(at("restrict", "Run(/ws/**)", argv("./build.sh"))).toBe(false);
    // A program reached through a link to it is named by the link; a deny on
    // where the link leads fires.
    expect(at("allow", "Run(./bin/*)", argv("./bin/tool"))).toBe(true);
    expect(at("restrict", "Run(scripts/ok.sh)", argv("./bin/tool"))).toBe(true);
    // Outside the workspace an absolute program keeps its name, unless a
    // `..` after a name takes it elsewhere.
    expect(at("allow", "Run(/sys/bin/sh -c x)", argv("/sys/bin/sh", "-c", "x"))).toBe(true);
    expect(at("restrict", "Run(/sys/usr/bin/sh*)", argv("/sys/bin/sh", "-c", "x"))).toBe(true);
    expect(at("allow", "Run(/sys/bin/**)", argv("/sys/bin/../../ws/evil.sh"))).toBe(false);
    expect(at("allow", "Run(/ws/evil.sh)", argv("/sys/bin/../../ws/evil.sh"))).toBe(true);
    // A word the reader cannot place: every deny fires, no scoped allow.
    expect(at("restrict", "Run(nothing-like-it)", argv("./loop/x"))).toBe(true);
    expect(at("allow", "Run(./loop/**)", argv("./loop/x"))).toBe(false);
    // A shell line cannot have a word put in its place: only an allow naming
    // every command grants one whose program moved.
    const line = { command: "./scripts/../deploy.sh" };
    expect(at("allow", "Sh(./deploy.sh)", line)).toBe(false);
    expect(at("allow", "Sh(**)", line)).toBe(true);
    expect(at("restrict", "Sh(./deploy.sh)", line)).toBe(true);
    expect(at("allow", "Sh(./build.sh)", { command: "./build.sh" })).toBe(true);
  });

  // command-dotdot review (0.7.1): the cases its reading missed.
  const ws = "/ws";
  const at = decide(
    table(ws, {
      // Outside the workspace, a `..` after a name moves an absolute program.
      "/out/tools/../evil.sh": { at: "/out/evil.sh" },
      "/out/tools/ok.sh": { at: "/out/tools/ok.sh" },
      "/out/evil.sh": { at: "/out/evil.sh" },
      // A command after `cd`: read from where it moved (sub → secrets/).
      "sub/./run.sh": { at: "/ws/secrets/run.sh", inWorkspace: "secrets/run.sh" },
      "pkg/app/../../tool": { at: "/ws/tool", inWorkspace: "tool" },
      // From a wrapper's directory, walked: env -C sub ./run.sh.
      "sub/./d.sh": { at: "/ws/secrets/d.sh", inWorkspace: "secrets/d.sh" },
      // $PWD is the directory the command runs in.
      "./link/../run.sh": { at: "/ws/secrets/run.sh", inWorkspace: "secrets/run.sh" },
      // A bare program on a PATH the line or a wrapper sets.
      "link/../run.sh": { at: "/ws/secrets/run.sh", inWorkspace: "secrets/run.sh" },
      "bin/tool": { at: "/ws/bin/tool", inWorkspace: "bin/tool" },
      // A data operand with a `..` after a name.
      "gen.sh": { at: "/ws/gen.sh", inWorkspace: "gen.sh" },
      "src/../lib": { at: "/ws/lib", inWorkspace: "lib" },
      // Words with a `..` after a name, folded as text (node reads them so).
      "./run.sh": { at: "/ws/run.sh", inWorkspace: "run.sh" },
      "./lib": { at: "/ws/lib", inWorkspace: "lib" },
      "./node_modules/tool/cli.sh": {
        at: "/ws/node_modules/.pnpm/tool/cli.sh",
        inWorkspace: "node_modules/.pnpm/tool/cli.sh",
      },
      "scripts/o*.sh": { at: "/ws/scripts/o*.sh", inWorkspace: "scripts/o*.sh" },
    }),
  );
  const argv = (...a: string[]) => ({ argv: a });
  const line = (command: string) => ({ command });

  test("an absolute program outside the workspace is put where a `..` after a name takes it", () => {
    expect(at("allow", "Run(/out/tools/**)", argv("/out/tools/../evil.sh"))).toBe(false);
    expect(at("allow", "Run(/out/evil.sh)", argv("/out/tools/../evil.sh"))).toBe(true);
    expect(at("allow", "Sh(/out/tools/**)", line("/out/tools/../evil.sh"))).toBe(false);
    // Control: one it does not move keeps its name.
    expect(at("allow", "Run(/out/tools/**)", argv("/out/tools/ok.sh"))).toBe(true);
  });

  test("a line's command runs where the cd before it moved, and a word is read from there", () => {
    expect(at("restrict", "Sh(secrets/**)", line("cd sub && ./run.sh"))).toBe(true);
    expect(at("restrict", "Sh(nothing-like-it)", line("cd sub && ./run.sh"))).toBe(false);
    // It moved through a link: an allow must name where it lands as well.
    expect(at("allow", "Sh(cd sub && ./run.sh)", line("cd sub && ./run.sh"))).toBe(false);
    expect(at("allow", "Sh(**)", line("cd sub && ./run.sh"))).toBe(true);
    // A `..` back up from a directory that is no link is where it reads.
    const up = line("cd pkg/app && ../../tool");
    expect(at("restrict", "Sh(nothing-like-it)", up)).toBe(false);
    expect(at("allow", "Sh(cd pkg/app && ../../tool)", up)).toBe(true);
    // A wrapper's directory, walked.
    expect(at("restrict", "Run(secrets/**)", argv("env", "-C", "sub", "./d.sh"))).toBe(true);
    expect(at("allow", "Run(env -C sub ./d.sh)", argv("env", "-C", "sub", "./d.sh"))).toBe(false);
  });

  test("a directory that cannot be told: a word is read as written, and one with a `..` after a name is placed nowhere", () => {
    expect(at("restrict", "Sh(nothing-like-it)", line('cd "$X" && ./run.sh'))).toBe(false);
    expect(at("allow", 'Sh(cd "$X" && ./run.sh)', line('cd "$X" && ./run.sh'))).toBe(true);
    expect(at("restrict", "Sh(nothing-like-it)", line('cd "$X" && ./a/../run.sh'))).toBe(true);
    // So is a word a variable the line does not set starts, or `~`.
    expect(at("restrict", "Sh(nothing-like-it)", line("$HOME/bin/x"))).toBe(false);
    expect(at("restrict", "Sh(nothing-like-it)", line("~/a/../x"))).toBe(true);
  });

  test("$PWD is the directory the command runs in", () => {
    expect(at("restrict", "Sh(secrets/**)", line("$PWD/link/../run.sh"))).toBe(true);
    expect(at("restrict", "Sh(secrets/**)", line('"$PWD"/link/../run.sh'))).toBe(true);
    expect(at("restrict", "Sh(secrets/**)", line("sh ${PWD}/link/../run.sh"))).toBe(true);
  });

  test("a bare program is read on a PATH the line or a wrapper sets", () => {
    expect(at("restrict", "Sh(secrets/**)", line("PATH=link/.. run.sh"))).toBe(true);
    expect(at("restrict", "Sh(secrets/**)", line("export PATH=link/..; run.sh"))).toBe(true);
    expect(at("restrict", "Run(secrets/**)", argv("env", "PATH=link/..", "run.sh"))).toBe(true);
    expect(at("restrict", "Run(secrets/**)", argv("env", "-P", "link/..", "run.sh"))).toBe(true);
    // One found where it moved is in no scoped allow; one that did not move is.
    expect(at("allow", "Run(env PATH=link/.. run.sh)", argv("env", "PATH=link/..", "run.sh"))).toBe(
      false,
    );
    expect(at("allow", "Run(env PATH=bin tool)", argv("env", "PATH=bin", "tool"))).toBe(true);
    expect(at("allow", "Sh(PATH=bin tool)", line("PATH=bin tool"))).toBe(true);
    // The harness's own PATH is looked up as before.
    expect(at("restrict", "Sh(nothing-like-it)", line('PATH="$PATH" tool'))).toBe(false);
  });

  test("an allow on a line reads each moved command with its words put in, as well as the line", () => {
    const data = line("sh gen.sh src/../lib");
    expect(at("allow", "Sh(sh gen.sh **)", data)).toBe(true);
    expect(at("allow", "Sh(sh gen.sh src/**)", data)).toBe(false);
    const linked = line("sh ./node_modules/tool/cli.sh");
    expect(at("allow", "Sh(sh **)", linked)).toBe(true);
    expect(at("allow", "Sh(sh ./node_modules/tool/**)", linked)).toBe(false);
  });

  test("an argv's other words with a `/` are read where they land, for a deny only", () => {
    const run = argv("arch", "-arm64", "link/../run.sh");
    expect(at("restrict", "Run(secrets/**)", run)).toBe(true);
    expect(at("restrict", "Run(nothing-like-it)", run)).toBe(false);
    expect(at("allow", "Run(arch -arm64 link/../run.sh)", run)).toBe(true);
    const find = argv("find", ".", "-exec", "link/../run.sh", ";");
    expect(at("restrict", "Run(secrets/**)", find)).toBe(true);
    // A shell line's arguments are its programs' to read: `caffeinate` is a
    // wrapper there; `echo` is not.
    expect(at("restrict", "Sh(secrets/**)", line("caffeinate link/../run.sh"))).toBe(true);
    expect(at("restrict", "Sh(secrets/**)", line("echo link/../run.sh"))).toBe(false);
  });

  test("a script on a shell's input, and one the shell expands as a pattern", () => {
    expect(at("restrict", "Sh(secrets/**)", line("sh < link/../run.sh"))).toBe(true);
    // A wildcard before the last name may match a link: placed nowhere.
    expect(at("restrict", "Sh(nothing-like-it)", line("sh secre?s/run.sh"))).toBe(true);
    // One in the last name stands for every file it can list there.
    expect(at("restrict", "Sh(scripts/ok.sh)", line("sh scripts/o*.sh"))).toBe(true);
    expect(at("restrict", "Sh(scripts/x.sh)", line("sh scripts/o*.sh"))).toBe(false);
    expect(at("restrict", "Sh(nothing-like-it)", line("sh scripts/o*.sh"))).toBe(false);
  });

  test("a shell reading the commands it runs from a pipe: every deny fires", () => {
    expect(at("restrict", "Sh(nothing-like-it)", line("echo rm -f x | sh"))).toBe(true);
    expect(at("allow", "Sh(echo ** | sh)", line("echo rm -f x | sh"))).toBe(false);
    expect(at("restrict", "Sh(nothing-like-it)", line("echo y | sh gen.sh"))).toBe(false);
  });

  // critic9 (0.7.1): node, `bun run` and a `#!/usr/bin/env node` script fold
  // a `..` as text before they open their script (`path.resolve`, then its
  // links followed), so `node lnk/../evil.mjs` with lnk → safe/sub runs
  // ./evil.mjs while the kernel walks to safe/evil.mjs. A reader answers for
  // both spellings of each word here: as written, and folded as text.
  describe("a word with a `..` after a name is also read with it folded as text", () => {
    const at = decide(
      table(ws, {
        "lnk/../evil.mjs": { at: "/ws/safe/evil.mjs", inWorkspace: "safe/evil.mjs" },
        "safe/x/../../evil.mjs": { at: "/ws/safe/evil.mjs", inWorkspace: "safe/evil.mjs" },
        "./evil.mjs": { at: "/ws/evil.mjs", inWorkspace: "evil.mjs" },
        "node_modules/pkg/../dep/cli.mjs": {
          at: "/ws/packages/dep/cli.mjs",
          inWorkspace: "packages/dep/cli.mjs",
        },
        "node_modules/dep/cli.mjs": {
          at: "/ws/node_modules/dep/cli.mjs",
          inWorkspace: "node_modules/dep/cli.mjs",
        },
        "./lnk/../nb.mjs": { at: "/ws/safe/nb.mjs", inWorkspace: "safe/nb.mjs" },
        "lnk/../nb.mjs": { at: "/ws/safe/nb.mjs", inWorkspace: "safe/nb.mjs" },
        "./nb.mjs": { at: "/ws/nb.mjs", inWorkspace: "nb.mjs" },
        "./lnk/../h.mjs": { at: "/ws/safe/h.mjs", inWorkspace: "safe/h.mjs" },
        "./h.mjs": { at: "/ws/h.mjs", inWorkspace: "h.mjs" },
        // Folded, it goes through another link: dl → secrets.
        "lnk/../dl/x.mjs": { at: "/ws/safe/dl/x.mjs", inWorkspace: "safe/dl/x.mjs" },
        "dl/x.mjs": { at: "/ws/secrets/x.mjs", inWorkspace: "secrets/x.mjs" },
        "lnk/../dl/x.sh": { at: "/ws/safe/dl/x.sh", inWorkspace: "safe/dl/x.sh" },
        "dl/x.sh": { at: "/ws/secrets/x.sh", inWorkspace: "secrets/x.sh" },
        "lnk/../dl/nb.mjs": { at: "/ws/safe/dl/nb.mjs", inWorkspace: "safe/dl/nb.mjs" },
        "dl/nb.mjs": { at: "/ws/secrets/nb.mjs", inWorkspace: "secrets/nb.mjs" },
        // Kernel-opened scripts.
        "lnk/../evil.sh": { at: "/ws/safe/evil.sh", inWorkspace: "safe/evil.sh" },
        "safe/x/../../evil.sh": { at: "/ws/safe/evil.sh", inWorkspace: "safe/evil.sh" },
        "./evil.sh": { at: "/ws/evil.sh", inWorkspace: "evil.sh" },
        "lnk/../evil.py": { at: "/ws/safe/evil.py", inWorkspace: "safe/evil.py" },
        "./evil.py": { at: "/ws/evil.py", inWorkspace: "evil.py" },
        // No link before the `..`: both readings land in one place.
        "safe/a/../ok.mjs": { at: "/ws/safe/ok.mjs", inWorkspace: "safe/ok.mjs" },
        "safe/ok.mjs": { at: "/ws/safe/ok.mjs", inWorkspace: "safe/ok.mjs" },
        // Walked, but not once folded (a loop of links there).
        "lnk/../loop.mjs": { at: "/ws/safe/loop.mjs", inWorkspace: "safe/loop.mjs" },
        // `bun run`'s subcommand is an operand too, read where it would be a file.
        run: { at: "/ws/run", inWorkspace: "run" },
      }),
    );

    test("folded as text the way path.resolve folds it", () => {
      for (const [word, folded] of [
        ["lnk/../evil.mjs", "./evil.mjs"],
        ["./lnk/../evil.mjs", "./evil.mjs"],
        ["a/b/../c/x", "a/c/x"],
        ["a//b/./../c", "a/c"],
        ["a/../../x", "../x"],
        ["../a/b/../x", "../a/x"],
        ["a/../..", ".."],
        ["a/..", "."],
        ["/out/tools/../evil.sh", "/out/evil.sh"],
        ["/../x", "/x"],
        ["C:\\a\\..\\b", "C:/b"],
      ] as const) {
        expect({ word, folded: foldedAsText(word) }).toEqual({ word, folded });
      }
    });

    test("an allow on where the kernel lands does not grant what node opens", () => {
      for (const input of [
        argv("node", "lnk/../evil.mjs"),
        argv("node", "safe/x/../../evil.mjs"),
        argv("env", "node", "lnk/../evil.mjs"),
        argv("bun", "run", "lnk/../evil.mjs"),
        line("node safe/x/../../evil.mjs"),
      ]) {
        const head = "argv" in input ? "Run" : "Sh";
        const prefix = (input.argv?.slice(0, -1) ?? ["node"]).join(" ");
        expect({
          input,
          physical: at("allow", `${head}(${prefix} safe/**)`, input),
          both: at("allow", `${head}(${prefix} **evil.mjs)`, input),
          every: at("allow", `${head}(**)`, input),
        }).toEqual({ input, physical: false, both: true, every: true });
      }
      // The monorepo layout: a dependency's script, through a linked package.
      const dep = argv("node", "node_modules/pkg/../dep/cli.mjs");
      expect(at("allow", "Run(node packages/**)", dep)).toBe(false);
      expect(at("allow", "Run(node node_modules/**)", dep)).toBe(false);
      expect(at("allow", "Run(node **/dep/cli.mjs)", dep)).toBe(true);
      // A program run by its path: its `#!` line may name node.
      const nb = argv("./lnk/../nb.mjs");
      expect(at("allow", "Run(./safe/**)", nb)).toBe(false);
      expect(at("allow", "Run(./*nb.mjs)", nb)).toBe(false);
      expect(at("allow", "Run(./**)", nb)).toBe(true);
      expect(at("allow", "Sh(./**)", line("./lnk/../nb.mjs"))).toBe(true);
    });

    test("a deny or ask reads both places, whichever program opens the word", () => {
      const node = argv("node", "lnk/../evil.mjs");
      expect(at("restrict", "Run(node evil.mjs)", node)).toBe(true);
      expect(at("restrict", "Run(node ./evil.mjs)", node)).toBe(false);
      expect(at("restrict", "Run(node safe/evil.mjs)", node)).toBe(true);
      // Folded, it lands through another link: a deny on where that leads fires.
      for (const input of [
        argv("node", "lnk/../dl/x.mjs"),
        argv("sh", "lnk/../dl/x.sh"),
        line("node lnk/../dl/x.mjs"),
        line("sh lnk/../dl/x.sh"),
        // An argument another program may run is read the same way.
        argv("find", ".", "-exec", "lnk/../dl/x.mjs", ";"),
        line("PATH=lnk/../dl nb.mjs"),
        argv("env", "PATH=lnk/../dl", "nb.mjs"),
        { argv: ["nb.mjs"], envSet: { PATH: "lnk/../dl" } },
      ]) {
        const head = "argv" in input ? "Run" : "Sh";
        expect({ input, denied: at("restrict", `${head}(**secrets/**)`, input) }).toEqual({
          input,
          denied: true,
        });
        expect({ input, unrelated: at("restrict", `${head}(nothing-like-it)`, input) }).toEqual({
          input,
          unrelated: false,
        });
      }
    });

    test("a script a shell, Python 3, Perl or Ruby opens is read where the kernel lands", () => {
      expect(at("allow", "Run(sh safe/**)", argv("sh", "lnk/../evil.sh"))).toBe(true);
      expect(at("allow", "Run(python3 safe/**)", argv("python3", "lnk/../evil.py"))).toBe(true);
      expect(at("allow", "Sh(sh safe/**)", line("sh safe/x/../../evil.sh"))).toBe(true);
      // So is a script on an interpreter's input: the shell running the line opens it.
      expect(at("allow", "Sh(node < safe/**)", line("node < safe/x/../../evil.mjs"))).toBe(true);
      // An operand after the script is the script's to read: both places.
      expect(
        at("allow", "Run(sh safe/** safe/**)", argv("sh", "lnk/../evil.sh", "lnk/../evil.mjs")),
      ).toBe(false);
      // A deny still reads where the text folds to.
      expect(at("restrict", "Run(sh evil.sh)", argv("sh", "lnk/../evil.sh"))).toBe(true);
    });

    test("control: a `..` with no link before it is one place, and an allow on it grants", () => {
      expect(at("allow", "Run(node safe/**)", argv("node", "safe/a/../ok.mjs"))).toBe(true);
      expect(at("allow", "Sh(node safe/**)", line("node safe/a/../ok.mjs"))).toBe(true);
      expect(at("restrict", "Run(nothing-like-it)", argv("node", "safe/a/../ok.mjs"))).toBe(false);
    });

    test("two words read apart, or one that cannot be walked folded: no scoped allow", () => {
      const two = argv("node", "-r", "./lnk/../h.mjs", "lnk/../evil.mjs");
      expect(at("allow", "Run(node -r ** **)", two)).toBe(false);
      expect(at("allow", "Run(**)", two)).toBe(true);
      expect(at("allow", "Sh(node -r ** **)", line("node -r ./lnk/../h.mjs lnk/../evil.mjs"))).toBe(
        false,
      );
      const loop = argv("node", "lnk/../loop.mjs");
      expect(at("allow", "Run(node **)", loop)).toBe(false);
      expect(at("restrict", "Run(nothing-like-it)", loop)).toBe(true);
    });

    test("`$PWD` is the text of where the shell runs, a link's name and all", () => {
      const pwd = decide(
        table(ws, {
          // After `cd lnk` (lnk → safe/sub) the kernel walks out of the target…
          "lnk/./../dl/x.mjs": { at: "/ws/safe/dl/x.mjs", inWorkspace: "safe/dl/x.mjs" },
          "lnk/./../evil.mjs": { at: "/ws/safe/evil.mjs", inWorkspace: "safe/evil.mjs" },
          "lnk/./x.mjs": { at: "/ws/safe/sub/x.mjs", inWorkspace: "safe/sub/x.mjs" },
          "lnk/./../x.mjs": { at: "/ws/safe/x.mjs", inWorkspace: "safe/x.mjs" },
          // …node folds `$PWD/..` back to the root.
          "dl/x.mjs": { at: "/ws/secrets/x.mjs", inWorkspace: "secrets/x.mjs" },
          "./evil.mjs": { at: "/ws/evil.mjs", inWorkspace: "evil.mjs" },
          "./x.mjs": { at: "/ws/x.mjs", inWorkspace: "x.mjs" },
          // Folded from the root, as if `$PWD` were still the root's text,
          // or from where the wrapper or the `cd -P` moved.
          "../x.mjs": { at: "/x.mjs" },
          "lnk/../x.mjs": { at: "/ws/safe/x.mjs", inWorkspace: "safe/x.mjs" },
        }),
      );
      for (const command of [
        "cd lnk && node $PWD/../dl/x.mjs",
        'cd lnk && node "${PWD}"/../dl/x.mjs',
      ]) {
        expect({ command, denied: pwd("restrict", "Sh(**secrets/**)", line(command)) }).toEqual({
          command,
          denied: true,
        });
      }
      expect(pwd("restrict", "Sh(node ./evil.mjs)", line("cd lnk && node $PWD/../evil.mjs"))).toBe(
        true,
      );
      // Not climbing out of `$PWD`, the text and the walk agree.
      const inside = line("cd lnk && node $PWD/x.mjs");
      expect(pwd("restrict", "Sh(nothing-like-it)", inside)).toBe(false);
      expect(pwd("restrict", "Sh(**secrets/**)", inside)).toBe(false);
      // Where the text of `$PWD` cannot be told — a wrapper moved the command
      // but not the shell's PWD, or a `cd -P` came first — it cannot be placed.
      for (const command of ["env -C lnk node $PWD/../x.mjs", "cd -P lnk && node $PWD/../x.mjs"]) {
        expect({ command, every: pwd("restrict", "Sh(nothing-like-it)", line(command)) }).toEqual({
          command,
          every: true,
        });
      }
    });

    // interp review (0.7.1): only a plain `$PWD` or `${PWD}` that starts a word
    // is put in. After `cd lnk`, `${PWD%/*}` is the root's text, `$OLDPWD`
    // the root itself; through dl → secrets, each runs secrets/x.mjs.
    test("the shell's own directory spelled any other way cannot be placed", () => {
      for (const command of [
        "cd lnk && node ${PWD%/*}/dl/x.mjs",
        "cd lnk && sh ${PWD%/*}/dl/x.sh",
        "cd lnk && node ${PWD:-.}/x.mjs",
        "cd lnk && node $OLDPWD/dl/x.mjs",
        "cd lnk && node ${OLDPWD}/dl/x.mjs",
        'cd lnk && node "$(dirname "$PWD")"/dl/x.mjs',
      ]) {
        expect({ command, every: at("restrict", "Sh(nothing-like-it)", line(command)) }).toEqual({
          command,
          every: true,
        });
        expect({
          command,
          scoped: at("allow", "Sh(cd lnk && node **)", line(command)),
          every: at("allow", "Sh(**)", line(command)),
        }).toEqual({ command, scoped: false, every: true });
      }
      // An argument a line hands a program, and a variable that is no
      // directory the shell sets, are read as written, as before.
      for (const command of [
        "cd lnk && cat ${PWD%/*}/x",
        "node $HOME/x.mjs",
        "node ${PWDX}/x.mjs",
        "node $PWD_OLD/x.mjs",
      ]) {
        expect({ command, every: at("restrict", "Sh(nothing-like-it)", line(command)) }).toEqual({
          command,
          every: false,
        });
      }
    });
  });
});

describe("a command's stdin field: the line a shell given no script runs", () => {
  const run = buildTool({
    name: "Run",
    description: "d",
    inputSchema: z.object({
      argv: z.array(z.string()).optional(),
      stdin: z.string().optional(),
      steps: z
        .array(z.object({ argv: z.array(z.string()), stdin: z.string().optional() }))
        .optional(),
    }),
    operativeArgs: [
      { field: "argv", kind: "command", stdin: "stdin" },
      { field: "steps.argv", kind: "command", stdin: "stdin" },
    ],
    execute: async () => "ok",
  });
  const at = (polarity: "allow" | "restrict", pattern: string, input: Record<string, unknown>) =>
    matchesPattern(compilePattern(pattern), "Run", input, {
      polarity,
      operativeValues: operativeValuesFor(run, input) ?? [],
    });

  test("a deny or ask reads each command of it; an allow reads the argv", () => {
    const fed = { argv: ["sh"], stdin: "true && rm -f x" };
    expect(at("restrict", "Run(rm *)", fed)).toBe(true);
    expect(at("restrict", "Run(rm *)", { argv: ["bash", "-s", "a"], stdin: "rm -f x" })).toBe(true);
    expect(at("restrict", "Run(rm *)", { argv: ["env", "sh"], stdin: "rm -f x" })).toBe(true);
    expect(at("allow", "Run(sh)", fed)).toBe(true);
    // A pipeline step reads its own.
    const step = { steps: [{ argv: ["sh"], stdin: "rm -f x" }] };
    expect(at("restrict", "Run(rm *)", step)).toBe(true);
  });

  test("control: text handed to a script or to a program that is no shell is data", () => {
    expect(at("restrict", "Run(rm *)", { argv: ["sh", "x.sh"], stdin: "rm -f x" })).toBe(false);
    expect(at("restrict", "Run(rm *)", { argv: ["sh", "-c", "cat"], stdin: "rm -f x" })).toBe(
      false,
    );
    expect(at("restrict", "Run(rm *)", { argv: ["cat"], stdin: "rm -f x" })).toBe(false);
    expect(at("restrict", "Run(rm *)", { argv: ["python3"], stdin: "rm -f x" })).toBe(false);
  });
});

/**
 * Critic9: a tool that opens fixed files inside the directory it is given —
 * ApprovalStatus's ledger, PermissionsSuggest's session logs — declares them
 * (`opens`), so a deny naming one fires on the call that reads it.
 */
describe("the fixed places a tool opens inside its directory (opens)", () => {
  const suggestLike = () =>
    buildTool({
      name: "SuggestLike",
      description: "mine a harness's logs",
      inputSchema: z.object({ dir: z.string().optional() }),
      readOnly: true,
      operativeArgs: [
        {
          field: "dir",
          kind: "path",
          default: ".",
          opens: [
            { path: ".crewhaus/sessions", beneath: "all" },
            { path: ".crewhaus/settings.json" },
          ],
        },
      ],
      execute: async () => "ok",
    });
  const on = (input: unknown, pattern: string, polarity: "allow" | "restrict") =>
    matchesPattern(compilePattern(pattern), "SuggestLike", input, {
      polarity,
      operativeValues: operativeValuesFor(suggestLike(), input) ?? [],
    });

  test("each is read by a deny or ask where it lands below the directory, never by an allow", () => {
    const values = operativeValuesFor(suggestLike(), {}) ?? [];
    expect(values.map((v) => [v.canonical[0], v.restrictOnly === true, v.beneath])).toEqual([
      [".", false, undefined],
      [".crewhaus/sessions", true, [".crewhaus/sessions/", "./.crewhaus/sessions/"]],
      [".crewhaus/settings.json", true, undefined],
    ]);
    for (const deny of [
      "SuggestLike(.crewhaus/sessions/sess_1.jsonl)",
      "SuggestLike(.crewhaus/sessions/**)",
      "SuggestLike(./.crewhaus/settings.json)",
      "SuggestLike(.crewhaus/**)",
    ]) {
      expect({ deny, fires: on({}, deny, "restrict") }).toEqual({ deny, fires: true });
    }
    // A directory the call names carries them below it.
    for (const deny of [
      "SuggestLike(h/.crewhaus/sessions/**)",
      "SuggestLike(h/.crewhaus/settings.json)",
    ]) {
      expect({ deny, fires: on({ dir: "h/" }, deny, "restrict") }).toEqual({ deny, fires: true });
    }
    // Control: a deny about a place it does not open stays quiet, and an
    // allow on the directory still grants it.
    for (const deny of ["SuggestLike(secrets/**)", "SuggestLike(.env)", "SuggestLike(h/**)"]) {
      expect({ deny, fires: on({}, deny, "restrict") }).toEqual({ deny, fires: false });
    }
    expect(on({}, "SuggestLike(.)", "allow")).toBe(true);
    expect(on({ dir: "h" }, "SuggestLike(h)", "allow")).toBe(true);
    expect(on({ dir: "h" }, "SuggestLike(.crewhaus/**)", "allow")).toBe(false);
  });

  test("a `..` or a link on the way is read where it lands", () => {
    // `pub/..` is the root; with a canonicaliser that follows `lnk` to
    // `secrets`, `lnk/.crewhaus/settings.json` is `secrets/.crewhaus/settings.json`.
    expect(on({ dir: "pub/.." }, "SuggestLike(.crewhaus/settings.json)", "restrict")).toBe(true);
    const followLink: PathCanonicalizer = (raw) => {
      const lexical = lexicalPathValues(raw)[0];
      if (lexical === undefined || lexical.outsideWorkspace === true) return lexicalPathValues(raw);
      const at = (lexical.canonical[0] as string).replace(/^lnk(\/|$)/, "secrets$1");
      return [{ kind: "path", canonical: [at, `./${at}`], spellings: [raw] }];
    };
    const values = operativeValuesFor(
      suggestLike(),
      { dir: "lnk" },
      { canonicalizePath: followLink },
    );
    expect(
      matchesPattern(
        compilePattern("SuggestLike(secrets/.crewhaus/settings.json)"),
        "SuggestLike",
        {},
        {
          polarity: "restrict",
          operativeValues: values ?? [],
        },
      ),
    ).toBe(true);
  });

  test("buildTool refuses an opening that is not a place below a path's directory", () => {
    const build = (arg: Record<string, unknown>) => () =>
      buildTool({
        name: "Bad",
        description: "d",
        inputSchema: z.object({ dir: z.string().optional(), q: z.string().optional() }),
        readOnly: true,
        operativeArgs: [arg as never],
        execute: async () => "ok",
      });
    for (const [arg, says] of [
      [{ field: "dir", kind: "path", opens: [{ path: "../x" }] }, "stay below it"],
      [{ field: "dir", kind: "path", opens: [{ path: "/etc/x" }] }, "stay below it"],
      [{ field: "dir", kind: "path", opens: [{ path: "a//b" }] }, "stay below it"],
      [{ field: "dir", kind: "path", opens: [] }, "one or more"],
      [{ field: "dir", kind: "path", opens: [{ path: "x", beneath: "some" }] }, "beneath"],
      [{ field: "q", kind: "id", opens: [{ path: "x" }] }, 'only a "path"'],
      [{ field: "dir", kind: "path", glob: true, opens: [{ path: "x" }] }, "glob pattern"],
    ] as const) {
      expect(build(arg)).toThrow(says);
    }
    expect(
      build({ field: "dir", kind: "path", opens: [{ path: ".crewhaus/a.json" }] }),
    ).not.toThrow();
  });
});

describe("a value on the service a call names (service)", () => {
  // codehost's shape: a repository within an owner, on the API in baseUrl
  // when the call names one, else on the API the tool is set up for.
  const repoTool = (fieldDefault?: "*") =>
    buildTool({
      name: "Repo",
      description: "d",
      inputSchema: z.object({
        owner: fieldDefault === undefined ? z.string() : z.string().optional(),
        repo: fieldDefault === undefined ? z.string() : z.string().optional(),
        baseUrl: z.string().optional(),
        title: z.string().optional(),
      }),
      operativeArgs: [
        {
          field: "repo",
          kind: "recipient",
          within: "owner",
          service: "baseUrl",
          ...(fieldDefault !== undefined ? { default: fieldDefault } : {}),
        },
      ],
      destructive: true,
      execute: async () => "ok",
    });
  const decide = (tool: ReturnType<typeof repoTool>, input: unknown) => {
    const values = operativeValuesFor(tool, input) ?? [];
    return (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Repo", input, { polarity, operativeValues: values });
  };

  test("a call that names no service is read as before: an allow names the repository alone", () => {
    const tool = repoTool();
    const input = { owner: "acme", repo: "app" };
    expect(operativeValuesFor(tool, input)).toEqual([
      { kind: "recipient", canonical: ["acme/app"], spellings: ["app", "acme"] },
    ]);
    const match = decide(tool, input);
    expect(match("Repo(acme/app)", "allow")).toBe(true);
    expect(match("Repo(**/acme/app)", "allow")).toBe(true);
    expect(match("Repo(https://ghe.example.com/acme/app)", "allow")).toBe(false);
    expect(match("Repo(https://ghe.example.com/**)", "restrict")).toBe(false);
  });

  test("a call that names one is matched with its origin: an allow must name it", () => {
    const tool = repoTool();
    const input = { owner: "acme", repo: "app", baseUrl: "https://ghe.example.com/api/v3" };
    const values = operativeValuesFor(tool, input);
    expect(values?.[0]?.canonical).toEqual(["https://ghe.example.com/acme/app"]);
    expect(values?.[1]).toEqual({
      kind: "url",
      canonical: ["https://ghe.example.com/api/v3"],
      spellings: ["https://ghe.example.com/api/v3"],
      restrictOnly: true,
    });
    expect(readOperativeField(input, tool.operativeArgs?.[0] as never)).toEqual([
      "https://ghe.example.com/acme/app",
    ]);
    const match = decide(tool, input);
    for (const [pattern, allow] of [
      ["Repo(acme/app)", false],
      ["Repo(acme/*)", false],
      ["Repo(*)", false],
      ["Repo(https://ghe.example.com/acme/app)", true],
      ["Repo(https://ghe.example.com/acme/*)", true],
      ["Repo(https://ghe.example.com/**)", true],
      ["Repo(**/acme/app)", true],
      ["Repo(**)", true],
      ["Repo(https://api.github.com/acme/app)", false],
      ["Repo(http://ghe.example.com/acme/app)", false],
      ["Repo(ghe.example.com/acme/app)", false],
    ] as const) {
      expect({ pattern, allow: match(pattern, "allow") }).toEqual({ pattern, allow });
    }
  });

  test("a deny or ask reads the repository on every service, the host and the URL", () => {
    const tool = repoTool();
    const input = { owner: "acme", repo: "app", baseUrl: "http://GHE.example.com.:8443/api/v3/" };
    const match = decide(tool, input);
    for (const [pattern, fires] of [
      // the repository written without a host: every service
      ["Repo(acme/app)", true],
      ["Repo(app)", true],
      ["Repo(acme)", true],
      ["Repo(*)", true],
      // the host, as a URL, a bare host, another scheme, no port, no root dot
      ["Repo(https://ghe.example.com/**)", true],
      ["Repo(http://ghe.example.com:8443/**)", true],
      ["Repo(ghe.example.com/**)", true],
      ["Repo(https://ghe.example.com/acme/app)", true],
      ["Repo(HTTPS://GHE.EXAMPLE.COM/ACME/APP)", true],
      // the API root itself
      ["Repo(http://ghe.example.com.:8443/api/v3/**)", true],
      // somewhere else
      ["Repo(https://ghe.example.com/other/**)", false],
      ["Repo(https://evil.example.com/**)", false],
      ["Repo(other/app)", false],
    ] as const) {
      expect({ pattern, fires: match(pattern, "restrict") }).toEqual({ pattern, fires });
    }
    // An allow reads the origin as the URL parser writes it, and nothing else.
    expect(match("Repo(http://ghe.example.com.:8443/acme/app)", "allow")).toBe(true);
    expect(match("Repo(http://ghe.example.com:8443/acme/app)", "allow")).toBe(false);
    expect(match("Repo(https://ghe.example.com/acme/app)", "allow")).toBe(false);
  });

  test("a URL that names no origin a request can go to cannot be placed", () => {
    const tool = repoTool();
    for (const baseUrl of [
      "not a url",
      "ftp://ghe.example.com/api",
      "https://user:secret@ghe.example.com/api/v3",
      // a user name alone, and a password alone, are each a credential
      "https://user@ghe.example.com/api/v3",
      "https://:secret@ghe.example.com/api/v3",
      "file:///etc/passwd",
    ]) {
      const match = decide(tool, { owner: "acme", repo: "app", baseUrl });
      expect({ baseUrl, allow: match("Repo(**)", "allow") }).toEqual({ baseUrl, allow: false });
      expect({ baseUrl, deny: match("Repo(nothing-like-it)", "restrict") }).toEqual({
        baseUrl,
        deny: true,
      });
    }
  });

  test("a search that names an owner, or nobody, on a service stands for every repository there", () => {
    const tool = repoTool("*");
    const ghe = "https://ghe.example.com/api/v3";
    const owner = decide(tool, { owner: "acme", baseUrl: ghe });
    expect(owner("Repo(https://ghe.example.com/acme/*)", "allow")).toBe(true);
    expect(owner("Repo(acme/*)", "allow")).toBe(false);
    expect(owner("Repo(https://ghe.example.com/acme/secret)", "restrict")).toBe(true);
    expect(owner("Repo(acme/secret)", "restrict")).toBe(true);
    expect(owner("Repo(ghe.example.com/acme/secret)", "restrict")).toBe(true);
    expect(owner("Repo(https://ghe.example.com/other/secret)", "restrict")).toBe(false);
    const nobody = decide(tool, { baseUrl: ghe });
    expect(nobody("Repo(https://ghe.example.com/**)", "allow")).toBe(true);
    expect(nobody("Repo(https://ghe.example.com/*)", "allow")).toBe(false);
    expect(nobody("Repo(https://ghe.example.com/acme/secret)", "restrict")).toBe(true);
    expect(nobody("Repo(acme/secret)", "restrict")).toBe(true);
    expect(nobody("Repo(https://evil.example.com/acme/secret)", "restrict")).toBe(false);
  });

  test("buildTool refuses a service field it cannot read as a URL", () => {
    const build =
      (arg: Record<string, unknown>, extra: Record<string, z.ZodTypeAny> = {}) =>
      () =>
        buildTool({
          name: "Bad",
          description: "d",
          inputSchema: z.object({
            owner: z.string(),
            repo: z.string(),
            baseUrl: z.string().optional(),
            path: z.string().optional(),
            ...extra,
          }),
          operativeArgs: [arg as never],
          execute: async () => "ok",
        });
    expect(build({ field: "path", kind: "path", service: "baseUrl" })).toThrow(
      /only an "id" or a "recipient"/,
    );
    expect(build({ field: "repo", kind: "id", service: "apiRoot" })).toThrow(
      /has no top-level field "apiRoot"/,
    );
    expect(build({ field: "repo", kind: "id", service: "port" }, { port: z.number() })).toThrow(
      /is not a string/,
    );
    expect(
      build({ field: "repo", kind: "id", service: "roots" }, { roots: z.array(z.string()) }),
    ).toThrow(/is a list/);
    expect(build({ field: "repo", kind: "id", within: "owner", service: "owner" })).toThrow(
      /already used/,
    );
    expect(
      build({ field: "repo", kind: "id", prefix: true, default: "*", service: "baseUrl" }),
    ).toThrow(/cannot be combined/);
    expect(build({ field: "repo", kind: "id", within: "owner", service: "baseUrl" })).not.toThrow();
  });
});

describe("a call that names no API goes where the tool's config says (serviceDefaults)", () => {
  // codehost's shape: base_url when the config sets one, else the default API
  // of the dialect the call speaks.
  type Config = { readonly baseUrl?: string; readonly host?: "github" | "gitlab" };
  const API = { github: "https://api.github.com", gitlab: "https://gitlab.com/api/v4" };
  const hostTool = (registered: Config = {}, opts: { readonly throws?: boolean } = {}) =>
    buildTool({
      name: "Repo",
      description: "d",
      inputSchema: z.object({
        owner: z.string(),
        repo: z.string(),
        host: z.enum(["github", "gitlab"]).optional(),
        baseUrl: z.string().optional(),
      }),
      operativeArgs: [{ field: "repo", kind: "recipient", within: "owner", service: "baseUrl" }],
      serviceDefaults: (input, toolConfig) => {
        if (opts.throws === true) throw new Error("a config it cannot read");
        const cfg = (toolConfig ?? registered) as Config;
        const home = cfg.host ?? "github";
        const asked = (input as { host?: "github" | "gitlab" }).host ?? home;
        return { unnamed: cfg.baseUrl ?? API[asked], home: cfg.baseUrl ?? API[home] };
      },
      destructive: true,
      execute: async () => "ok",
    });
  const decide = (tool: ReturnType<typeof hostTool>, input: unknown, toolConfig?: unknown) => {
    const values =
      operativeValuesFor(tool, input, toolConfig !== undefined ? { toolConfig } : {}) ?? [];
    return (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Repo", input, { polarity, operativeValues: values });
  };
  const ghe = { baseUrl: "https://ghe.example.com/api/v3" };

  test("a call that names none is read on the configured API: a deny on that host fires", () => {
    const tool = hostTool(ghe);
    const input = { owner: "acme", repo: "app" };
    const values = operativeValuesFor(tool, input);
    expect(values?.[0]?.canonical).toEqual(["acme/app", "https://ghe.example.com/acme/app"]);
    expect(values?.[1]).toEqual({
      kind: "url",
      canonical: ["https://ghe.example.com/api/v3"],
      spellings: ["https://ghe.example.com/api/v3"],
      restrictOnly: true,
    });
    const match = decide(tool, input);
    for (const [pattern, fires] of [
      ["Repo(https://ghe.example.com/**)", true],
      ["Repo(http://ghe.example.com/**)", true],
      ["Repo(ghe.example.com/**)", true],
      ["Repo(https://ghe.example.com/api/v3/**)", true],
      ["Repo(acme/app)", true],
      ["Repo(https://api.github.com/**)", false],
    ] as const) {
      expect({ pattern, fires: match(pattern, "restrict") }).toEqual({ pattern, fires });
    }
    // An allow that names no host covers it, and so does one that names it.
    expect(match("Repo(acme/app)", "allow")).toBe(true);
    expect(match("Repo(https://ghe.example.com/acme/*)", "allow")).toBe(true);
    expect(match("Repo(https://*/acme/app)", "allow")).toBe(true);
    expect(match("Repo(https://api.github.com/acme/app)", "allow")).toBe(false);
  });

  test("a call that names the configured API is read as one that names none", () => {
    const tool = hostTool(ghe);
    for (const baseUrl of [
      "https://ghe.example.com/api/v3",
      "https://ghe.example.com/api/v3/",
      "HTTPS://GHE.example.com/api/v3",
    ]) {
      const match = decide(tool, { owner: "acme", repo: "app", baseUrl });
      expect({ baseUrl, allow: match("Repo(acme/app)", "allow") }).toEqual({
        baseUrl,
        allow: true,
      });
      expect({ baseUrl, deny: match("Repo(ghe.example.com/**)", "restrict") }).toEqual({
        baseUrl,
        deny: true,
      });
    }
    // Another API on the same host name is another origin: another port.
    const port = decide(tool, {
      owner: "acme",
      repo: "app",
      baseUrl: "https://ghe.example.com:8443",
    });
    expect(port("Repo(acme/app)", "allow")).toBe(false);
    // Another host is not the configured one.
    const other = decide(tool, { owner: "acme", repo: "app", baseUrl: "https://api.github.com" });
    expect(other("Repo(acme/app)", "allow")).toBe(false);
    expect(other("Repo(https://api.github.com/acme/app)", "allow")).toBe(true);
  });

  test("without base_url, a call's host picks the API: another dialect is another host", () => {
    const tool = hostTool();
    const github = decide(tool, { owner: "acme", repo: "app" });
    expect(github("Repo(acme/app)", "allow")).toBe(true);
    expect(github("Repo(https://api.github.com/**)", "restrict")).toBe(true);
    const gitlab = decide(tool, { owner: "acme", repo: "app", host: "gitlab" });
    expect(gitlab("Repo(acme/app)", "allow")).toBe(false);
    expect(gitlab("Repo(https://gitlab.com/acme/app)", "allow")).toBe(true);
    expect(gitlab("Repo(gitlab.com/**)", "restrict")).toBe(true);
    // A config set up for GitLab has it as its home.
    const home = decide(tool, { owner: "acme", repo: "app", host: "gitlab" }, { host: "gitlab" });
    expect(home("Repo(acme/app)", "allow")).toBe(true);
  });

  test("the serving candidate's tool_config is the one read", () => {
    const tool = hostTool(ghe);
    const input = { owner: "acme", repo: "app" };
    const served = decide(tool, input, { baseUrl: "https://gitlab.example.com/api/v4" });
    expect(served("Repo(gitlab.example.com/**)", "restrict")).toBe(true);
    expect(served("Repo(ghe.example.com/**)", "restrict")).toBe(false);
    expect(served("Repo(acme/app)", "allow")).toBe(true);
  });

  test("a config the tool cannot read leaves nothing an allow can grant", () => {
    const tool = hostTool(ghe, { throws: true });
    const match = decide(tool, { owner: "acme", repo: "app" });
    expect(match("Repo(**)", "allow")).toBe(false);
    expect(match("Repo(nothing-like-it)", "restrict")).toBe(true);
    // A call that names its API is read on it; it is not the home one.
    const named = decide(tool, { owner: "acme", repo: "app", ...ghe });
    expect(named("Repo(https://ghe.example.com/acme/app)", "allow")).toBe(true);
    expect(named("Repo(acme/app)", "allow")).toBe(false);
  });

  test("buildTool refuses serviceDefaults on a tool with no service field, or two", () => {
    const build = (operativeArgs: ReadonlyArray<Record<string, unknown>>) => () =>
      buildTool({
        name: "Bad",
        description: "d",
        inputSchema: z.object({
          owner: z.string(),
          repo: z.string(),
          channel: z.string(),
          baseUrl: z.string().optional(),
          apiBaseUrl: z.string().optional(),
        }),
        operativeArgs: operativeArgs as never,
        serviceDefaults: () => ({ unnamed: "https://a.example", home: "https://a.example" }),
        execute: async () => "ok",
      });
    expect(build([{ field: "repo", kind: "id", within: "owner" }])).toThrow(
      /no operative field declares a `service`/,
    );
    expect(
      build([
        { field: "repo", kind: "id", within: "owner", service: "baseUrl" },
        { field: "channel", kind: "id", service: "apiBaseUrl" },
      ]),
    ).toThrow(/declare 2 service fields/);
    expect(
      build([{ field: "repo", kind: "id", within: "owner", service: "baseUrl" }]),
    ).not.toThrow();
  });
});

describe("the API itself: a url declared as its own service", () => {
  // RateLimitStatus's shape: it reads the quota at the API in baseUrl, else
  // at the one its config sends it to, which the call's host may pick.
  type Config = { readonly baseUrl?: string };
  const API = { github: "https://api.github.com", gitlab: "https://gitlab.com/api/v4" };
  const quotaTool = (registered: Config = {}, opts: { readonly throws?: boolean } = {}) =>
    buildTool({
      name: "Quota",
      description: "d",
      inputSchema: z.object({
        host: z.enum(["github", "gitlab"]).optional(),
        baseUrl: z.string().optional(),
        tokenEnv: z.string().optional(),
      }),
      operativeArgs: [{ field: "baseUrl", kind: "url", service: "baseUrl" }],
      serviceDefaults: (input, toolConfig) => {
        if (opts.throws === true) throw new Error("a config it cannot read");
        const cfg = (toolConfig ?? registered) as Config;
        const asked = (input as { host?: "github" | "gitlab" }).host ?? "github";
        return { unnamed: cfg.baseUrl ?? API[asked], home: cfg.baseUrl ?? API.github };
      },
      readOnly: true,
      execute: async () => "ok",
    });
  const decide = (tool: ReturnType<typeof quotaTool>, input: unknown, toolConfig?: unknown) => {
    const values =
      operativeValuesFor(tool, input, toolConfig !== undefined ? { toolConfig } : {}) ?? [];
    return (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Quota", input, {
        polarity,
        operativeValues: values,
      });
  };
  const ghe = "https://ghe.example.com/api/v3";

  test("a call that names the API is read on it, as a URL, whatever else it names", () => {
    const tool = quotaTool();
    for (const input of [{ baseUrl: ghe }, { baseUrl: ghe, host: "github", tokenEnv: "T" }]) {
      expect(operativeValuesFor(tool, input)).toEqual([
        {
          kind: "url",
          canonical: [ghe, `${ghe}/`],
          spellings: [
            ghe,
            "http://ghe.example.com/api/v3",
            "http://ghe.example.com/api/v3/",
            "ghe.example.com/api/v3",
            "ghe.example.com/api/v3/",
          ],
        },
      ]);
      const match = decide(tool, input);
      for (const [pattern, fires] of [
        ["Quota(https://ghe.example.com/**)", true],
        ["Quota(http://ghe.example.com/**)", true],
        ["Quota(*://ghe.example.com/**)", true],
        ["Quota(HTTPS://GHE.example.com/api/v3)", true],
        ["Quota(ghe.example.com/**)", true],
        ["Quota(https://api.github.com/**)", false],
        ["Quota(api.github.com/**)", false],
      ] as const) {
        expect({ input, pattern, fires: match(pattern, "restrict") }).toEqual({
          input,
          pattern,
          fires,
        });
      }
      expect(match("Quota(https://ghe.example.com/**)", "allow")).toBe(true);
      expect(match("Quota(https://api.github.com/**)", "allow")).toBe(false);
      // The host alone is a deny's reading, not a grant.
      expect(match("Quota(ghe.example.com/**)", "allow")).toBe(false);
    }
  });

  test("a call that names none is read on the API its config sends it to", () => {
    const configured = decide(quotaTool({ baseUrl: ghe }), {});
    expect(configured("Quota(ghe.example.com/**)", "restrict")).toBe(true);
    expect(configured("Quota(https://ghe.example.com/**)", "allow")).toBe(true);
    // With no base URL configured, the call's host picks it.
    const tool = quotaTool();
    const github = decide(tool, {});
    expect(github("Quota(https://api.github.com/**)", "restrict")).toBe(true);
    expect(github("Quota(api.github.com)", "restrict")).toBe(true);
    expect(github("Quota(https://api.github.com)", "allow")).toBe(true);
    const gitlab = decide(tool, { host: "gitlab" });
    expect(gitlab("Quota(gitlab.com/**)", "restrict")).toBe(true);
    expect(gitlab("Quota(api.github.com/**)", "restrict")).toBe(false);
    expect(gitlab("Quota(https://api.github.com/**)", "allow")).toBe(false);
    // The serving candidate's tool_config is the one read.
    const served = decide(quotaTool({ baseUrl: ghe }), {}, { baseUrl: API.gitlab });
    expect(served("Quota(gitlab.com/**)", "restrict")).toBe(true);
    expect(served("Quota(ghe.example.com/**)", "restrict")).toBe(false);
  });

  test("an API that cannot be placed is granted by no allow, and every deny fires", () => {
    for (const input of [
      { baseUrl: "https://user:pw@ghe.example.com/api/v3" },
      { baseUrl: "ftp://ghe.example.com/api" },
      { baseUrl: "not a url" },
    ]) {
      const match = decide(quotaTool(), input);
      expect({ input, allow: match("Quota(**)", "allow") }).toEqual({ input, allow: false });
      expect({ input, deny: match("Quota(nothing-like-it)", "restrict") }).toEqual({
        input,
        deny: true,
      });
    }
    const unreadable = decide(quotaTool({}, { throws: true }), {});
    expect(unreadable("Quota(**)", "allow")).toBe(false);
    expect(unreadable("Quota(nothing-like-it)", "restrict")).toBe(true);
  });

  test("the API is read as the tool joins its paths to it: one trailing slash dropped", () => {
    // The tool drops one trailing slash and appends each path as text, so
    // these all send `GET /api/v3/rate_limit`; each is that API, written with
    // a slash at the end or not.
    for (const baseUrl of [
      ghe,
      `${ghe}/`,
      `${ghe}/.`,
      `${ghe}/x/..`,
      `${ghe}/%2e`,
      "HTTPS://GHE.example.com:443/api/v3/",
    ]) {
      expect({
        baseUrl,
        canonical: operativeValuesFor(quotaTool(), { baseUrl })?.[0]?.canonical,
      }).toEqual({ baseUrl, canonical: [ghe, `${ghe}/`] });
    }
    // The path the tool reaches when the slash is not the last character, or
    // there are two: `${ghe}//rate_limit`, `${ghe}/%20/rate_limit`.
    for (const [baseUrl, root] of [
      [`${ghe}//`, `${ghe}/`],
      [`${ghe}\\`, `${ghe}/`],
      [`${ghe}/\n`, `${ghe}/`],
      [`${ghe}/ `, `${ghe}/%20`],
      [`${ghe}/..`, "https://ghe.example.com/api"],
    ] as const) {
      expect({
        baseUrl,
        canonical: operativeValuesFor(quotaTool(), { baseUrl })?.[0]?.canonical,
      }).toEqual({ baseUrl, canonical: [root, `${root}/`] });
    }
    // Two slashes are another path, which an allow on the API does not
    // grant; a deny on it reads them as one, as many servers do.
    for (const baseUrl of [
      `${ghe}//`,
      `${ghe}\\`,
      `${ghe}/\n`,
      "https://ghe.example.com//api//v3",
    ]) {
      const match = decide(quotaTool(), { baseUrl });
      expect({
        baseUrl,
        allow: match(`Quota(${ghe})`, "allow"),
        deny: match(`Quota(${ghe})`, "restrict"),
        host: match("Quota(ghe.example.com/api/v3)", "restrict"),
        other: match("Quota(*://ghe.example.com/api/v3/)", "restrict"),
      }).toEqual({ baseUrl, allow: false, deny: true, host: true, other: true });
    }
    expect(
      decide(quotaTool(), { baseUrl: "https://api.github.com//" })(
        "Quota(https://api.github.com)",
        "restrict",
      ),
    ).toBe(true);
    // The origin's own root, as any URL is.
    for (const baseUrl of ["https://api.github.com", "https://api.github.com/"]) {
      expect(operativeValuesFor(quotaTool(), { baseUrl })?.[0]?.canonical).toEqual([
        "https://api.github.com/",
        "https://api.github.com",
      ]);
    }
    // A root the tool refuses, a query or a fragment in it: nothing to grant.
    for (const baseUrl of [`${ghe}?per_page=1`, `${ghe}#`]) {
      const match = decide(quotaTool(), { baseUrl });
      expect({ baseUrl, allow: match("Quota(**)", "allow") }).toEqual({ baseUrl, allow: false });
      expect({ baseUrl, deny: match("Quota(nothing-like-it)", "restrict") }).toEqual({
        baseUrl,
        deny: true,
      });
    }
  });

  test("the configured API is read as written, with the tool's one slash dropped", () => {
    // A config that writes its root with two slashes sends `${ghe}//rate_limit`.
    const doubled = operativeValuesFor(quotaTool({ baseUrl: `${ghe}//` }), {});
    expect(doubled?.[0]?.canonical).toEqual([`${ghe}/`, `${ghe}//`]);
    expect(decide(quotaTool({ baseUrl: `${ghe}//` }), {})(`Quota(${ghe})`, "allow")).toBe(false);
    const plain = operativeValuesFor(quotaTool({ baseUrl: `${ghe}/` }), {});
    expect(plain?.[0]?.canonical).toEqual([ghe, `${ghe}/`]);
  });

  test("read from the declaration alone, a call that names none carries no API", () => {
    const declared = [{ field: "baseUrl", kind: "url", service: "baseUrl" }] as const;
    expect(operativeValuesOf(declared, {})).toEqual([]);
    expect(operativeValuesOf(declared, { baseUrl: ghe })?.[0]?.canonical).toEqual([ghe, `${ghe}/`]);
    // An approval row shows the API as the call names it.
    expect(readOperativeField({ baseUrl: ghe }, declared[0])).toEqual([ghe]);
    expect(readOperativeField({}, declared[0])).toEqual([]);
  });

  test("buildTool takes a url's service only as its own field, with no default", () => {
    const build = (arg: Record<string, unknown>) => () =>
      buildTool({
        name: "Bad",
        description: "d",
        inputSchema: z.object({
          baseUrl: z.string().optional(),
          mirror: z.string().optional(),
        }),
        operativeArgs: [arg] as never,
        execute: async () => "ok",
      });
    expect(build({ field: "baseUrl", kind: "url", service: "mirror" })).toThrow(
      /names its own field "baseUrl"/,
    );
    expect(
      build({ field: "baseUrl", kind: "url", service: "baseUrl", default: "https://a.example" }),
    ).toThrow(/has no default/);
    expect(build({ field: "baseUrl", kind: "path", service: "baseUrl" })).toThrow(
      /a "path" value is read as it is/,
    );
    expect(build({ field: "baseUrl", kind: "url", service: "baseUrl" })).not.toThrow();
  });
});

describe("a field the tool ignores beside another the call names (ignoredWhen)", () => {
  // ChatPost's shape: a webhook post goes where the webhook is bound, and the
  // channel it carries is not used.
  const postTool = () =>
    buildTool({
      name: "Post",
      description: "d",
      inputSchema: z.object({
        hook: z.string().optional(),
        channel: z.string().optional(),
        text: z.string(),
      }),
      operativeArgs: [
        { field: "hook", kind: "id" },
        { field: "channel", kind: "recipient", ignoredWhen: "hook" },
      ],
      destructive: true,
      execute: async () => "ok",
    });
  const decide = (input: unknown) => {
    const values = operativeValuesFor(postTool(), input) ?? [];
    return (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Post", input, { polarity, operativeValues: values });
  };

  test("with the other named, an allow need not name it and a deny still reads it", () => {
    const match = decide({ hook: "OPS_HOOK", channel: "C123", text: "t" });
    expect(match("Post(OPS_HOOK)", "allow")).toBe(true);
    expect(match("Post(C123)", "allow")).toBe(false);
    expect(match("Post(C123)", "restrict")).toBe(true);
    expect(match("Post(OPS_HOOK)", "restrict")).toBe(true);
  });

  test("without it, the field is where the call acts", () => {
    const match = decide({ channel: "C123", text: "t" });
    expect(match("Post(C123)", "allow")).toBe(true);
    expect(match("Post(OPS_HOOK)", "allow")).toBe(false);
  });

  test("buildTool refuses an ignoredWhen that names no field a rule reads, or one after it", () => {
    const build = (operativeArgs: ReadonlyArray<Record<string, unknown>>) => () =>
      buildTool({
        name: "Bad",
        description: "d",
        inputSchema: z.object({
          hook: z.string().optional(),
          channel: z.string().optional(),
          from: z.string().optional(),
        }),
        operativeArgs: operativeArgs as never,
        execute: async () => "ok",
      });
    const channel = { field: "channel", kind: "recipient" };
    expect(build([{ ...channel, ignoredWhen: "hook" }])).toThrow(/must be another operative field/);
    expect(
      build([
        { field: "hook", kind: "id", source: true },
        { ...channel, ignoredWhen: "hook" },
      ]),
    ).toThrow(/must be another operative field/);
    expect(build([{ ...channel, ignoredWhen: "channel" }])).toThrow(/already used/);
    expect(build([{ ...channel, ignoredWhen: "a.b" }])).toThrow(/one top-level input field/);
    expect(
      build([
        { ...channel, ignoredWhen: "hook" },
        { field: "hook", kind: "id" },
      ]),
    ).toThrow(/declare "hook" before "channel"/);
    expect(
      build([
        { field: "hook", kind: "id" },
        { ...channel, ignoredWhen: "hook" },
      ]),
    ).not.toThrow();
  });
});

describe("an owner's own copy of a value (overlay)", () => {
  // tool-deploy's shape: a pin `<name>/<env>`, or a tenant's overlay of it.
  const pinTool = (envDefault?: "*") =>
    buildTool({
      name: "Pin",
      description: "d",
      inputSchema: z.object({
        name: z.string(),
        env: envDefault === undefined ? z.string() : z.string().optional(),
        tenant: z.string().optional(),
      }),
      operativeArgs: [
        {
          field: "env",
          kind: "id",
          within: "name",
          overlay: "tenant",
          ...(envDefault !== undefined ? { default: envDefault } : {}),
        },
      ],
      destructive: true,
      execute: async () => "ok",
    });
  const decide = (tool: ReturnType<typeof pinTool>, input: unknown) => {
    const values = operativeValuesFor(tool, input) ?? [];
    return (pattern: string, polarity: "allow" | "restrict") =>
      matchesPattern(compilePattern(pattern), "Pin", input, { polarity, operativeValues: values });
  };

  test("a call that names none is the shared value", () => {
    const tool = pinTool();
    const input = { name: "billing", env: "staging" };
    expect(operativeValuesFor(tool, input)?.[0]?.canonical).toEqual(["billing/staging"]);
    expect(decide(tool, input)("Pin(billing/staging)", "allow")).toBe(true);
  });

  test("a call that names one is matched with it in front: an allow must name it", () => {
    const tool = pinTool();
    const input = { name: "billing", env: "staging", tenant: "acme" };
    expect(operativeValuesFor(tool, input)?.[0]?.canonical).toEqual(["acme/billing/staging"]);
    expect(readOperativeField(input, tool.operativeArgs?.[0] as never)).toEqual([
      "acme/billing/staging",
    ]);
    const match = decide(tool, input);
    for (const [pattern, allow] of [
      ["Pin(acme/billing/staging)", true],
      ["Pin(*/billing/staging)", true],
      ["Pin(acme/**)", true],
      ["Pin(billing/staging)", false],
      ["Pin(billing/**)", false],
      ["Pin(acme)", false],
      ["Pin(beta/billing/staging)", false],
    ] as const) {
      expect({ pattern, allow: match(pattern, "allow") }).toEqual({ pattern, allow });
    }
    // A deny reads it with the owner, without it, and the owner alone.
    for (const [pattern, fires] of [
      ["Pin(acme/billing/staging)", true],
      ["Pin(billing/staging)", true],
      ["Pin(acme)", true],
      ["Pin(ACME)", true],
      ["Pin(beta)", false],
      ["Pin(beta/**)", false],
    ] as const) {
      expect({ pattern, fires: match(pattern, "restrict") }).toEqual({ pattern, fires });
    }
  });

  test("a call that names every value of its owner's copy stands for each of them", () => {
    const tool = pinTool("*");
    const match = decide(tool, { name: "billing", tenant: "acme" });
    expect(match("Pin(acme/billing/*)", "allow")).toBe(true);
    expect(match("Pin(billing/*)", "allow")).toBe(false);
    expect(match("Pin(acme/billing/prod)", "restrict")).toBe(true);
    expect(match("Pin(billing/prod)", "restrict")).toBe(true);
  });

  test("buildTool refuses an overlay it cannot put in front of the value", () => {
    const build =
      (arg: Record<string, unknown>, extra: Record<string, z.ZodTypeAny> = {}) =>
      () =>
        buildTool({
          name: "Bad",
          description: "d",
          inputSchema: z.object({
            name: z.string(),
            env: z.string(),
            tenant: z.string().optional(),
            baseUrl: z.string().optional(),
            path: z.string().optional(),
            ...extra,
          }),
          operativeArgs: [arg as never],
          execute: async () => "ok",
        });
    expect(build({ field: "path", kind: "path", overlay: "tenant" })).toThrow(
      /only an "id" or a "recipient"/,
    );
    expect(build({ field: "env", kind: "id", overlay: "owner" })).toThrow(
      /has no top-level field "owner"/,
    );
    expect(build({ field: "env", kind: "id", within: "name", overlay: "name" })).toThrow(
      /already used/,
    );
    expect(
      build({ field: "env", kind: "id", overlay: "tenants" }, { tenants: z.array(z.string()) }),
    ).toThrow(/is a list/);
    expect(build({ field: "env", kind: "id", overlay: "tenant", service: "baseUrl" })).toThrow(
      /cannot be combined/,
    );
    expect(build({ field: "env", kind: "id", within: "name", overlay: "tenant" })).not.toThrow();
  });
});
