import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, against a real temporary workspace.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERIFY_TOOLS,
  acceptanceCheck,
  checksumVerify,
  citationLint,
  goldenCompare,
  goldenUpdate,
  markdownLinkCheck,
} from "./index";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

async function raw(tool: (typeof VERIFY_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof VERIFY_TOOLS)[number],
  input: unknown,
): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-verify-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("package-wide contract", () => {
  test("every tool is exported in VERIFY_TOOLS", () => {
    expect(VERIFY_TOOLS.length).toBe(6);
  });

  test("names are unique and PascalCase", () => {
    const names = VERIFY_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of VERIFY_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("only GoldenUpdate writes, and it is destructive and justification-gated", () => {
    // It overwrites a reviewed baseline, which is the one irreversible act
    // in the package.
    for (const t of VERIFY_TOOLS) {
      const writes = t.name === "GoldenUpdate";
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: !writes });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: writes,
      });
    }
    expect(goldenUpdate.requireJustification).toBe(true);
  });

  test("no tool declares a network capability, because none reaches one", () => {
    for (const t of VERIFY_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
    }
  });

  test("every description says what it is for, and every schema is strict", () => {
    for (const t of VERIFY_TOOLS) {
      expect(t.description).toContain("Use it");
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });
});

describe("GoldenCompare and GoldenUpdate", () => {
  const noisy = "run at 2026-01-02T03:04:05.123Z\nid 7f3e4d2a-1b9c-4e5f-8a7b-6c5d4e3f2a1b\nok\n";

  test("a masked difference matches and the masks are counted", () => {
    writeFileSync(join(workspace, "g.txt"), "run at <timestamp>\nid <uuid>\nok\n");
    return call<{ match: boolean; normalized: Record<string, number> }>(goldenCompare, {
      actual: noisy,
      golden: "g.txt",
      normalize: ["timestamps", "uuids"],
    }).then((result) => {
      expect(result.match).toBe(true);
      expect(result.normalized).toEqual({ timestamps: 1, uuids: 1 });
    });
  });

  test("a real change is caught with the line that changed", async () => {
    writeFileSync(join(workspace, "g.txt"), "run at <timestamp>\nid <uuid>\nok\n");
    const result = await call<{ match: boolean; differences: Array<{ line: number }> }>(
      goldenCompare,
      {
        actual: noisy.replace("ok", "CHANGED"),
        golden: "g.txt",
        normalize: ["timestamps", "uuids"],
      },
    );
    expect(result.match).toBe(false);
    expect(result.differences[0]).toEqual({ line: 3, expected: "ok", actual: "CHANGED" });
  });

  test("a missing golden explains what to do rather than failing opaquely", async () => {
    expect(await raw(goldenCompare, { actual: "x", golden: "nope.txt" })).toContain("GoldenUpdate");
  });

  test("update writes the normalized text and reports whether it changed", async () => {
    const first = await call<{ created: boolean }>(goldenUpdate, {
      actual: "at 2026-01-01T00:00:00Z\n",
      golden: "new.txt",
      normalize: ["timestamps"],
    });
    expect(first.created).toBe(true);
    expect(readFileSync(join(workspace, "new.txt"), "utf-8")).toBe("at <timestamp>\n");

    const again = await call<{ created: boolean; changed: boolean }>(goldenUpdate, {
      actual: "at 2026-06-06T00:00:00Z\n",
      golden: "new.txt",
      normalize: ["timestamps"],
    });
    expect(again).toMatchObject({ created: false, changed: false });
  });

  test("a tree compare reports added, removed and changed files", async () => {
    mkdirSync(join(workspace, "golden"));
    mkdirSync(join(workspace, "actual"));
    writeFileSync(join(workspace, "golden/same.txt"), "x");
    writeFileSync(join(workspace, "golden/gone.txt"), "y");
    writeFileSync(join(workspace, "golden/changed.txt"), "old");
    writeFileSync(join(workspace, "actual/same.txt"), "x");
    writeFileSync(join(workspace, "actual/changed.txt"), "new");
    writeFileSync(join(workspace, "actual/added.txt"), "z");
    const result = await call<{
      match: boolean;
      added: string[];
      removed: string[];
      changed: string[];
    }>(goldenCompare, { actualFile: "actual", golden: "golden" });
    expect(result).toMatchObject({
      match: false,
      added: ["added.txt"],
      removed: ["gone.txt"],
      changed: ["changed.txt"],
    });
  });

  test("a path outside the workspace is refused", async () => {
    await expect(raw(goldenCompare, { actual: "x", golden: "../g.txt" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });
});

describe("ChecksumVerify", () => {
  test("the three failure modes are reported separately", async () => {
    // Missing, changed and extra need different action, and an unexpected
    // file is how something ships that nobody meant to ship.
    writeFileSync(join(workspace, "a.txt"), "a");
    writeFileSync(join(workspace, "extra.txt"), "e");
    writeFileSync(
      join(workspace, "SHA256SUMS"),
      `${"0".repeat(64)}  a.txt\n${"1".repeat(64)}  gone.txt\n`,
    );
    const result = await call<{
      ok: boolean;
      mismatched: string[];
      missing: string[];
      unexpected: string[];
    }>(checksumVerify, { manifest: "SHA256SUMS" });
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual(["a.txt"]);
    expect(result.missing).toEqual(["gone.txt"]);
    expect(result.unexpected).toContain("extra.txt");
  });

  test("a manifest it wrote verifies against itself", async () => {
    writeFileSync(join(workspace, "a.txt"), "a");
    const written = await call<{ manifest: string }>(checksumVerify, { write: true });
    writeFileSync(join(workspace, "SUMS"), written.manifest);
    const result = await call<{ mismatched: string[]; missing: string[] }>(checksumVerify, {
      manifest: "SUMS",
      files: ["a.txt"],
    });
    expect(result.mismatched).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  test("a missing manifest says how to make one", async () => {
    expect(await raw(checksumVerify, { manifest: "nope" })).toContain("write:true");
  });
});

describe("AcceptanceCheck", () => {
  test("every check reports its own verdict, so one failure hides none", async () => {
    writeFileSync(join(workspace, "f.txt"), "hello world\n");
    const result = await call<{ ok: boolean; failed: number; results: Array<{ ok: boolean }> }>(
      acceptanceCheck,
      {
        checks: [
          { kind: "fileExists", path: "f.txt" },
          { kind: "fileAbsent", path: "f.txt" },
          { kind: "fileContains", path: "f.txt", text: "hello" },
          { kind: "fileOmits", path: "f.txt", text: "hello" },
          { kind: "fileMatches", path: "f.txt", pattern: "^hello", flags: "m" },
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(2);
    expect(result.results.map((r) => r.ok)).toEqual([true, false, true, false, true]);
  });

  test("a containment escape is a failed check, not a crash", async () => {
    const result = await call<{ results: Array<{ ok: boolean; detail: string }> }>(
      acceptanceCheck,
      {
        checks: [{ kind: "fileExists", path: "../outside" }],
      },
    );
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.detail).toContain("escapes the workspace");
  });

  test("an invalid pattern fails that check alone", async () => {
    writeFileSync(join(workspace, "f.txt"), "x");
    const result = await call<{ failed: number; results: Array<{ detail: string }> }>(
      acceptanceCheck,
      {
        checks: [
          { kind: "fileExists", path: "f.txt" },
          { kind: "fileMatches", path: "f.txt", pattern: "([a-" },
        ],
      },
    );
    expect(result.failed).toBe(1);
    expect(result.results[1]?.detail).toContain("invalid pattern");
  });
});

describe("MarkdownLinkCheck", () => {
  beforeEach(() => {
    mkdirSync(join(workspace, "docs"));
    writeFileSync(
      join(workspace, "docs/a.md"),
      "# Title\n\n[good](./b.md) [bad](./nope.md) [ext](https://x.test)\n[anchor](#title) [bad](#nope)\n\n```\n[incode](./never.md)\n```\n",
    );
    writeFileSync(join(workspace, "docs/b.md"), "# B\n");
  });

  test("broken file links and broken anchors are both found", async () => {
    const result = await call<{ ok: boolean; broken: Array<{ href: string; reason: string }> }>(
      markdownLinkCheck,
      { path: "docs", checkAnchors: true },
    );
    expect(result.ok).toBe(false);
    expect(result.broken.map((b) => b.href).sort()).toEqual(["#nope", "./nope.md"]);
  });

  test("external links are counted and never fetched", async () => {
    const result = await call<{ external: number; note: string }>(markdownLinkCheck, {
      path: "docs",
    });
    expect(result.external).toBe(1);
    expect(result.note).toContain("never fetched");
  });

  test("links inside code blocks are not checked", async () => {
    const result = await call<{ broken: Array<{ href: string }> }>(markdownLinkCheck, {
      path: "docs",
    });
    expect(result.broken.some((b) => b.href === "./never.md")).toBe(false);
  });

  test("a link pointing outside the workspace is reported, not followed", async () => {
    writeFileSync(join(workspace, "docs/c.md"), "[out](../../../etc/passwd)\n");
    const result = await call<{ broken: Array<{ href: string; reason: string }> }>(
      markdownLinkCheck,
      {
        path: "docs",
      },
    );
    expect(result.broken.find((b) => b.href.includes("passwd"))?.reason).toContain(
      "outside the workspace",
    );
  });
});

describe("CitationLint", () => {
  test("a marker with no source fails; an uncited source does not", async () => {
    const result = await call<{ ok: boolean; undefinedMarkers: unknown[]; uncited: string[] }>(
      citationLint,
      { text: "Claim [1] and [2].\n\n[1]: https://a.test\n[3]: https://c.test\n" },
    );
    expect(result.ok).toBe(false);
    expect(result.undefinedMarkers).toHaveLength(1);
    expect(result.uncited).toEqual(["3"]);
  });

  test("it reads a file too", async () => {
    writeFileSync(join(workspace, "brief.md"), "Claim [1].\n\n[1]: s\n");
    expect(await call<{ ok: boolean }>(citationLint, { file: "brief.md" })).toMatchObject({
      ok: true,
    });
  });

  test("giving both a file and text is refused by the schema", () => {
    expect(citationLint.inputSchema.safeParse({ text: "x", file: "y" }).success).toBe(false);
    expect(citationLint.inputSchema.safeParse({}).success).toBe(false);
  });
});
