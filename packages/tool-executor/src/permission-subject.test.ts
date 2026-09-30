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
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";
import { z } from "zod";
import {
  type PathCanonicalizer,
  executeTool,
  lexicalPathValues,
  operativeValuesFor,
  preparePermissionSubject,
  readOperativeField,
} from "./index";

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
    // `..` in the directory is collapsed with the rest.
    expect(canonical({ cwd: "pkg/..", paths: [".env"] })).toEqual([".env"]);
    expect(canonical({ cwd: "pkg", paths: ["/etc/passwd"] })).toEqual(["/etc/passwd"]);
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
