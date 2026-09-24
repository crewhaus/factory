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
