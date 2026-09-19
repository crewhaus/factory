import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, against a real temporary workspace.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERIFY_TOOLS,
  acceptanceCheck,
  checksumVerify,
  citationLint,
  factCrossCheck,
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
    expect(VERIFY_TOOLS.length).toBe(7);
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

  test("a link that leaves the workspace through a symlink is reported, not opened", async () => {
    // `resolve` does not follow symlinks and `statSync` does, so a lexical
    // containment check calls this link fine and then opens the file it
    // really points at. The anchor answer would report whether a file nobody
    // may read carries a given heading.
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-verify-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "# Top Secret Heading\n");
      symlinkSync(join(outside, "secret.md"), join(workspace, "docs/escape.md"));
      writeFileSync(join(workspace, "docs/d.md"), "[out](./escape.md#top-secret-heading)\n");
      const result = await call<{ broken: Array<{ href: string; reason: string }> }>(
        markdownLinkCheck,
        { path: "docs", checkAnchors: true },
      );
      expect(result.broken.find((b) => b.href.includes("escape.md"))?.reason).toContain(
        "outside the workspace",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

describe("FactCrossCheck", () => {
  type Claim = {
    verdict: string;
    reason: string;
    mode: string;
    claim: string;
    foundIn?: { source: string; line: number; excerpt: string };
    sources: Array<{ source: string; status: string; missing?: string[]; differing?: string[] }>;
  };
  type Report = {
    ok: boolean;
    checked: number;
    counts: Record<string, number>;
    note: string;
    detail?: string;
    claims: Claim[];
  };

  const REPORT =
    '# Quarterly report\n\nRevenue rose 4.5% in the second quarter, to $1,200,000 across all regions.\nThe migration did not complete on schedule.\nThe chief engineer said "the rollout was slower than we expected" during the call.\nThe budget was not approved by the board.\n';

  beforeEach(() => {
    mkdirSync(join(workspace, "sources"));
    writeFileSync(join(workspace, "sources/report.md"), REPORT);
  });

  const check = (input: unknown) => call<Report>(factCrossCheck, input);
  const one = (claim: string, sources: string[]) =>
    check({ claims: [{ text: claim, sources }] }).then((r) => r.claims[0] as Claim);

  test("a claim whose words are all in the cited source is supported, with the span", async () => {
    const result = await check({
      claims: [
        { text: "Revenue rose 4.5% in the second quarter.", sources: ["sources/report.md"] },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.claims[0]?.verdict).toBe("supported");
    expect(result.claims[0]?.foundIn).toEqual({
      source: "sources/report.md",
      line: 3,
      excerpt: "Revenue rose 4.5% in the second quarter",
    });
    // The one thing a caller must not read into a pass.
    expect(result.note).toContain("never that the claim is true");
  });

  test("a claim the source does not carry is NOT FOUND, which is not a contradiction", async () => {
    const claim = await one("Adoption doubled in Europe.", ["sources/report.md"]);
    expect(claim.verdict).toBe("notFound");
    expect(claim.reason).toContain("not a finding that it says otherwise");
    expect(claim.sources[0]?.missing).toEqual(["adoption", "doubled", "europe"]);
  });

  test("words found inside a negated span are a polarity conflict, not support", async () => {
    // Every word of the claim is there; the span carrying them says the
    // opposite. Calling this supported is the one way word-matching lies.
    const claim = await one("The budget was approved by the board.", ["sources/report.md"]);
    expect(claim.verdict).toBe("polarityConflict");
    expect(claim.sources[0]?.differing).toEqual(["not"]);
    expect(claim.reason).toContain("read it before relying on either");
  });

  test("a quotation the source did not write is reported with what it did write", async () => {
    const claim = await one('The engineer said "the rollout was slower than anyone expected".', [
      "sources/report.md",
    ]);
    expect(claim.mode).toBe("quote");
    expect(claim.verdict).toBe("misquoted");
    expect(claim.sources[0]?.missing).toEqual(["anyone"]);
    expect(claim.sources[0]?.differing).toEqual(["we"]);
  });

  test("a quotation the source did write is supported, punctuation aside", async () => {
    const claim = await one('It said "the rollout was slower than we expected!"', [
      "sources/report.md",
    ]);
    expect(claim.verdict).toBe("supported");
  });

  test("an unreadable source leaves the claim undetermined rather than unsupported", async () => {
    // The dominant failure of a checker like this: reporting "not in the
    // sources" when one of the sources was never read.
    const claim = await one("Adoption doubled in Europe.", [
      "sources/gone.md",
      "sources/report.md",
    ]);
    expect(claim.verdict).toBe("unreadable");
    expect(claim.sources.map((s) => s.status)).toEqual(["unreadable", "notFound"]);
    expect(claim.reason).toContain("it is not there");
  });

  test("a source that does support it wins over one that could not be read", async () => {
    const claim = await one("Revenue rose 4.5%.", ["sources/gone.md", "sources/report.md"]);
    expect(claim.verdict).toBe("supported");
    expect(claim.foundIn?.source).toBe("sources/report.md");
  });

  test("a URL source is unchecked and never fetched", async () => {
    const claim = await one("Everything is fine.", ["https://example.test/page"]);
    expect(claim.verdict).toBe("unchecked");
    expect(claim.reason).toContain("nothing in this package fetches");
  });

  test("a file whose name has a space in it is still a file", async () => {
    // Deciding on the shape of the string alone would call this prose and
    // report a source that is right there as unread.
    writeFileSync(join(workspace, "sources/my report.md"), "Adoption doubled in Europe.\n");
    expect((await one("Adoption doubled in Europe.", ["sources/my report.md"])).verdict).toBe(
      "supported",
    );
  });

  test("a written reference is unchecked, not a missing file", async () => {
    const claim = await one("A further point.", ["Smith, J. (2024). Something Printed."]);
    expect(claim.verdict).toBe("unchecked");
    expect(claim.reason).toContain("not a file in the workspace");
  });

  test("a source reached through a symlink out of the workspace is refused", async () => {
    // `join` does not resolve symlinks and `existsSync` follows them, so the
    // path that gets opened is the only one worth containing.
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-verify-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "Adoption doubled in Europe.\n");
      symlinkSync(join(outside, "secret.md"), join(workspace, "sources/escape.md"));
      const claim = await one("Adoption doubled in Europe.", ["sources/escape.md"]);
      expect(claim.verdict).toBe("unreadable");
      expect(claim.reason).toContain("outside the workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a source that is not text is unreadable, not empty", async () => {
    writeFileSync(join(workspace, "sources/blob.bin"), Buffer.from([0x68, 0x00, 0x69]));
    const claim = await one("Adoption doubled in Europe.", ["sources/blob.bin"]);
    expect(claim.verdict).toBe("unreadable");
    expect(claim.reason).toContain("not text");
  });

  test("a directory cited as a source says so", async () => {
    const claim = await one("Adoption doubled in Europe.", ["sources"]);
    expect(claim.verdict).toBe("unreadable");
    expect(claim.reason).toContain("directory");
  });

  test("a claim that cites nothing is kept apart from one that was checked", async () => {
    const claim = await one("Revenue rose 4.5%.", []);
    expect(claim.verdict).toBe("noSource");
  });

  test("a claim with no words of its own is unchecked, never vacuously supported", async () => {
    // An empty set of words is contained in every source. Returning
    // "supported" here would be a pass that checked nothing.
    const claim = await one("It is so.", ["sources/report.md"]);
    expect(claim.verdict).toBe("unchecked");
    expect(claim.reason).toContain("no words to look for");
  });

  test("a figure is not its percentage, and grouped thousands are the same number", async () => {
    expect((await one("Revenue rose 4.5 points.", ["sources/report.md"])).verdict).toBe("notFound");
    expect((await one("Revenue of 1200000.", ["sources/report.md"])).verdict).toBe("supported");
  });

  test("how far apart the words may sit is the caller's decision", async () => {
    writeFileSync(join(workspace, "sources/spread.md"), `alpha ${"filler ".repeat(40)}omega\n`);
    const near = await check({
      claims: [{ text: "alpha omega", sources: ["sources/spread.md"] }],
      windowTokens: 10,
    });
    const far = await check({
      claims: [{ text: "alpha omega", sources: ["sources/spread.md"] }],
      windowTokens: 100,
    });
    expect(near.claims[0]?.verdict).toBe("notFound");
    expect(far.claims[0]?.verdict).toBe("supported");
  });

  describe("over a document", () => {
    beforeEach(() => {
      writeFileSync(
        join(workspace, "brief.md"),
        "# Brief\n\nRevenue rose 4.5% in the second quarter [1]. The migration completed on schedule [1].\n\nBoth agree on the regions [1] [2].\n\n[1]: ./sources/report.md\n[2]: ./sources/second.md\n",
      );
      writeFileSync(
        join(workspace, "sources/second.md"),
        "The two teams both agree on the regions.\n",
      );
    });

    test("each cited sentence is checked, and the sentence checked is reported", async () => {
      const result = await check({ file: "brief.md" });
      expect(result.checked).toBe(3);
      expect(result.claims.map((c) => c.verdict)).toEqual(["supported", "notFound", "supported"]);
      expect(result.claims[1]?.claim).toBe("The migration completed on schedule.");
    });

    test("a sentence citing two sources is one claim, supported by either", async () => {
      const result = await check({ file: "brief.md" });
      expect(result.claims[2]?.sources).toHaveLength(2);
      expect(result.claims[2]?.foundIn?.source).toBe("sources/second.md");
    });

    test("a source path is resolved from the document, not the working directory", async () => {
      mkdirSync(join(workspace, "docs"));
      writeFileSync(
        join(workspace, "docs/deep.md"),
        "Claimed thing [1].\n\n[1]: ../sources/x.md\n",
      );
      writeFileSync(join(workspace, "sources/x.md"), "The claimed thing is written here.\n");
      const result = await check({ file: "docs/deep.md" });
      expect(result.claims[0]?.verdict).toBe("supported");
      expect(result.claims[0]?.foundIn?.source).toBe("sources/x.md");
    });

    test("a marker with no source behind it is not counted as checked", async () => {
      const result = await check({ text: "A claim with a dangling marker [9].\n" });
      expect(result.claims[0]?.verdict).toBe("unchecked");
      expect(result.claims[0]?.reason).toContain("CitationLint");
      expect(result.ok).toBe(false);
    });

    test("a document that cites nothing says so instead of passing quietly", async () => {
      const result = await check({ text: "Just prose, no citations.\n" });
      expect(result.checked).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("nothing was checked");
    });

    test("a claim inside a code block is not a claim", async () => {
      const result = await check({
        text: "```\nA fenced claim [1].\n```\n\n[1]: ./sources/report.md\n",
      });
      expect(result.checked).toBe(0);
    });

    test("a run that stopped at the limit is not a pass", async () => {
      // The claims past the cap were never looked at. Reporting `ok` on the
      // ones that fit is "could not determine" answered as "no problem" —
      // and the one left unread here is the one that is wrong.
      writeFileSync(
        join(workspace, "many.md"),
        "Revenue rose 4.5% [1].\n\nThe treasury was looted by pirates [1].\n\n[1]: ./sources/report.md\n",
      );
      const result = await check({ file: "many.md", limit: 1 });
      expect(result.claimsFound).toBe(2);
      expect(result.checked).toBe(1);
      expect(result.truncated).toBe(true);
      expect(result.counts.supported).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("never checked");
    });

    test("a fragment on a cited source names the file in front of it", async () => {
      // MarkdownLinkCheck splits the fragment off a link destination. A
      // second rule here that did not would have the two tools disagree
      // about which file a citation names, and report a source sitting right
      // there as one that could not be read.
      writeFileSync(
        join(workspace, "frag.md"),
        "Revenue rose 4.5% [1].\n\n[1]: ./sources/report.md#revenue\n",
      );
      const result = await check({ file: "frag.md" });
      expect(result.claims[0]?.verdict).toBe("supported");
      expect(result.claims[0]?.foundIn?.source).toBe("sources/report.md");
    });

    test("a source on the line under its marker is read, not blamed on CitationLint", async () => {
      // The two tools must agree about what counts as a source behind a
      // marker. They did not: CitationLint called this defined while
      // FactCrossCheck said "marker [1] has no source behind it — that is
      // CitationLint's finding", a finding CitationLint does not make.
      writeFileSync(
        join(workspace, "wrapped.md"),
        "Revenue rose 4.5% [1].\n\n[1]:\n./sources/report.md\n",
      );
      const lint = await call<{ ok: boolean }>(citationLint, { file: "wrapped.md" });
      const result = await check({ file: "wrapped.md" });
      expect(lint.ok).toBe(true);
      expect(result.claims[0]?.verdict).toBe("supported");
    });

    test("a citation that is only a fragment points at no source at all", async () => {
      const result = await check({ text: "A claim [1].\n\n[1]: #elsewhere-in-this-document\n" });
      expect(result.claims[0]?.verdict).toBe("unchecked");
      expect(result.claims[0]?.reason).toContain("inside the document itself");
    });
  });

  test("a claim checked by its quotation alone is not a claim checked whole", async () => {
    // The words around an attributed quotation are not verified, so the one
    // summary line a caller reads has to say so — otherwise `supported` here
    // reads as "the board firing everyone checks out", which nothing checked.
    const result = await check({
      claims: [
        {
          text: 'The board fired everyone, and the engineer said "the rollout was slower than we expected".',
          sources: ["sources/report.md"],
        },
      ],
    });
    expect(result.claims[0]?.mode).toBe("quote");
    expect(result.claims[0]?.verdict).toBe("supported");
    expect(result.claims[0]?.reason).toContain("the quoted words");
    expect(result.note).toContain("only the quoted span");
  });

  test("a large source is scanned once per claim, not once per candidate position", async () => {
    // The budget is generous on purpose: CI is a loaded two-core box, and
    // what is being pinned is the single pass, not a stopwatch.
    const filler = `${"lorem ipsum dolor sit amet ".repeat(20_000)}the needle is at the end\n`;
    writeFileSync(join(workspace, "sources/big.md"), filler);
    const claim = await one("The needle is at the end.", ["sources/big.md"]);
    expect(claim.verdict).toBe("supported");
  }, 20_000);
});
