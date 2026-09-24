/**
 * 0.7.1 — a permission rule is checked against the call the tool will run,
 * not the call the model wrote. See `permission-subject.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";
import { z } from "zod";
import {
  executeTool,
  operativeValuesFor,
  preparePermissionSubject,
  readOperativeField,
} from "./index";

let ws: string;
beforeEach(() => {
  // realpath: on macOS the temp dir is itself behind a symlink (/var → /private/var).
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), "perm-subject-")));
  mkdirSync(path.join(ws, "src"));
  mkdirSync(path.join(ws, "build"));
  mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(path.join(ws, "src", "app.ts"), "app");
  symlinkSync("../src", path.join(ws, "build", "link"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

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
    const s = preparePermissionSubject(
      writeLike(),
      { path: "src/a.ts", file_path: "docs/ok.md", content: "x" },
      { workspaceRoot: ws },
    );
    if (!s.ok) throw new Error(s.reason);
    expect(s.input).toEqual({ path: "src/a.ts", content: "x" });
    expect(s.operativeValues?.map((v) => v.canonical[0])).toEqual(["src/a.ts"]);
  });

  test("an input the schema rejects is refused with the schema's message", () => {
    const s = preparePermissionSubject(
      writeLike(),
      { path: 7, content: "x" },
      { workspaceRoot: ws },
    );
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

describe("path canonicalisation (permission-integration#1)", () => {
  const values = (p: string) =>
    operativeValuesFor(writeLike(), { path: p, content: "" }, { workspaceRoot: ws }) ?? [];

  test("`..` is collapsed before a rule sees the path", () => {
    const [v] = values("build/../src/app.ts");
    expect(v?.canonical[0]).toBe("src/app.ts");
    expect(v?.spellings).toContain("build/../src/app.ts");
    expect(v?.outsideWorkspace).toBeUndefined();
  });

  test("a symlinked directory is followed to where the tool will act", () => {
    const [v] = values("build/link/app.ts");
    expect(v?.canonical[0]).toBe("src/app.ts");
    // The name the model used is still a spelling a deny can catch.
    expect(v?.spellings).toContain("build/link/app.ts");
  });

  test("a file that does not exist yet resolves through its existing ancestors", () => {
    const [v] = values("build/link/new/deep.ts");
    expect(v?.canonical[0]).toBe("src/new/deep.ts");
  });

  test("a symlink as the LAST component is two places: the link and its target", () => {
    // A tool that replaces the file acts on `src/hook`; one that opens it
    // acts on the hook. An allow must cover both; a deny fires on either.
    // Dangling on purpose: a missing target is still a door.
    symlinkSync("../.git/hooks/pre-commit", path.join(ws, "src", "hook"));
    expect(values("src/hook").map((v) => v.canonical[0])).toEqual([
      "src/hook",
      ".git/hooks/pre-commit",
    ]);
    const deny = compilePattern("WriteLike(.git/**)");
    const allow = compilePattern("WriteLike(src/**)");
    const vs = values("src/hook");
    expect(
      matchesPattern(deny, "WriteLike", {}, { polarity: "restrict", operativeValues: vs }),
    ).toBe(true);
    expect(matchesPattern(allow, "WriteLike", {}, { polarity: "allow", operativeValues: vs })).toBe(
      false,
    );
    // A leaf link pointing out of the workspace brings an outside value.
    symlinkSync(tmpdir(), path.join(ws, "src", "away"));
    expect(values("src/away").map((v) => v.outsideWorkspace === true)).toEqual([false, true]);
  });

  test("an absolute path inside the workspace becomes workspace-relative", () => {
    const [v] = values(path.join(ws, "src", "app.ts"));
    expect(v?.canonical).toEqual(["src/app.ts", "./src/app.ts", path.join(ws, "src", "app.ts")]);
  });

  test("escaping the workspace — lexically or through a symlink — is flagged", () => {
    expect(values("../elsewhere")[0]?.outsideWorkspace).toBe(true);
    expect(values("/etc/passwd")[0]?.outsideWorkspace).toBe(true);
    symlinkSync(tmpdir(), path.join(ws, "out"));
    expect(values("out/x")[0]?.outsideWorkspace).toBe(true);
    // Every path yields at least one value; only a symlinked leaf yields two.
    expect(values("src/app.ts")).toHaveLength(1);
    // Flagged values carry nothing canonical for an allow to match.
    expect(values("../elsewhere")[0]?.canonical).toEqual([]);
  });

  test("the workspace root itself is `.`", () => {
    expect(values(".")[0]?.canonical[0]).toBe(".");
    expect(values("")[0]?.canonical[0]).toBe(".");
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
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
    process.chdir(ws);
  });
  afterEach(() => {
    process.chdir(cwd);
  });

  test("a decoy key the schema strips does not satisfy an allow", async () => {
    const r = await executeTool(
      writeLike(),
      { file_path: "src/ok.ts", path: ".git/hooks/pre-commit", content: "x" },
      { toolUseId: "t1", allowedPatterns: ["WriteLike(src/**)"] },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toBe('tool "WriteLike" is not permitted by the current permission set');
  });

  test("traversal and symlinks are matched where they land", async () => {
    for (const p of ["src/../.git/hooks/pre-commit", "build/link/app.ts"]) {
      const r = await executeTool(
        writeLike(),
        { path: p, content: "x" },
        { toolUseId: "t2", allowedPatterns: ["WriteLike(build/**)"] },
      );
      expect(r.isError).toBe(true);
    }
    const ok = await executeTool(
      writeLike(),
      { path: "build/link/app.ts", content: "x" },
      { toolUseId: "t3", allowedPatterns: ["WriteLike(src/**)"] },
    );
    expect(ok).toEqual({ toolUseId: "t3", content: "wrote build/link/app.ts", isError: false });
  });

  test("the matcher is handed exactly these values", () => {
    const tool = writeLike();
    const values = operativeValuesFor(
      tool,
      { path: "build/../src/a", content: "" },
      { workspaceRoot: ws },
    );
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
