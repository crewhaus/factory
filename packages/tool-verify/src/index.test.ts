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
  seoLint,
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
    expect(VERIFY_TOOLS.length).toBe(8);
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

describe("SeoLint", () => {
  type SeoResult = {
    ok: boolean;
    from: string;
    counts: Record<string, number>;
    language: { tag: string | null; from: string; wordBoundaries: boolean };
    prose: { region: string; words: number | null; sentences: number | null };
    corpus?: { path: string; comparedWith: number };
    errors: Array<{ check: string; detail: string; location?: string }>;
    warnings: Array<{ check: string; detail: string; location?: string }>;
    observations: Array<{ check: string; detail: string }>;
    notChecked: Array<{ check: string; reason: string }>;
    notRequested: Array<{ check: string; reason: string }>;
    passed: string[];
    suppressed?: Record<string, number>;
    note: string;
  };

  /** Enough English prose to clear the word-count floor, in short sentences. */
  const PROSE =
    "<p>The kettle boils the water and the machine pulls the shot. The grind decides most of what lands in the cup. Filter coffee rewards patience, and good burr grinders reward it more. We tested nine burr grinders over three months in a small kitchen. The water there is hard and the scale reads to a tenth of a gram. Each one ground two hundred grams of the same washed lot. We ground in three batches, at the same setting, on the same morning. We measured the spread of the particles under a loupe. We measured the retention left behind in the chute after each dose. We measured the noise at one metre from the bench. The cheapest of them beat two machines that cost four times as much. That was not what any of us expected when we started. We repeated the worst results a week later with fresh beans. The ranking turned out to be about the machines and not the coffee.</p>";

  /** A page with nothing wrong with it, as the starting point for each defect. */
  function goodPage(over: { body?: string; head?: string; lang?: string } = {}): string {
    return `<!doctype html><html lang="${over.lang ?? "en"}"><head>
<title>The best burr grinders for filter coffee in 2026</title>
<meta name="description" content="We ground two hundred grams through nine burr grinders and measured spread, retention and noise. Here is what filter coffee needs from one.">
<link rel="canonical" href="https://example.com/guides/burr-grinders">
<meta property="og:title" content="The best burr grinders for filter coffee in 2026">
<meta property="og:description" content="We ground two hundred grams through nine burr grinders and measured spread, retention and noise. Here is what filter coffee needs from one.">
<meta property="og:image" content="https://example.com/img/grinders.png">
<meta property="og:url" content="https://example.com/guides/burr-grinders">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"The best burr grinders","author":"A Writer","datePublished":"2026-01-01","dateModified":"2026-02-01","image":"https://example.com/img/grinders.png"}</script>
${over.head ?? ""}</head><body><nav><a href="/">Home</a></nav>
<main><h1>The best burr grinders</h1>
${over.body ?? PROSE}
<img src="/img/grinders.png" alt="Nine burr grinders on a counter">
<a href="/guides/water">Why water hardness changes the shot</a>
</main></body></html>`;
  }

  const lint = (input: Record<string, unknown>) => call<SeoResult>(seoLint, input);
  const idsOf = (rows: Array<{ check: string }>): string[] => rows.map((r) => r.check);
  const reasonFor = (result: SeoResult, check: string): string =>
    [...result.notChecked, ...result.notRequested].find((n) => n.check === check)?.reason ?? "";
  /** Which bucket a check landed in — the distinction `ok` turns on. */
  const bucketOf = (result: SeoResult, check: string): string =>
    result.notChecked.some((n) => n.check === check)
      ? "notChecked"
      : result.notRequested.some((n) => n.check === check)
        ? "notRequested"
        : "neither";

  test("a clean page passes only once every check has something to look at", async () => {
    mkdirSync(join(workspace, "published"));
    writeFileSync(
      join(workspace, "published/other.html"),
      "<p>An unrelated page about bicycle chains, sprocket wear and the tools for measuring it.</p>",
    );
    const result = await lint({
      html: goodPage(),
      keyword: "burr grinders",
      url: "https://example.com/guides/burr-grinders",
      corpus: "published",
    });
    expect({ ok: result.ok, errors: result.errors, notChecked: result.notChecked }).toEqual({
      ok: true,
      errors: [],
      notChecked: [],
    });
    expect(result.corpus).toEqual({ path: "published", comparedWith: 1 });
  });

  test("a check that was ASKED FOR and could not be answered withholds ok", async () => {
    // The whole reason the strict rule exists: a corpus WAS configured and
    // could not be read, so the near-duplicate question was asked and went
    // unanswered. Nothing failed, and this must still not read as a pass.
    const result = await lint({ html: goodPage(), corpus: "../elsewhere" });
    expect(result.errors).toEqual([]);
    expect(bucketOf(result, "duplicate.nearMatch")).toBe("notChecked");
    expect(result.ok).toBe(false);
    expect(result.passed).not.toContain("duplicate.nearMatch");
  });

  test("a check NOBODY ASKED FOR is named, kept out of passed, and does not withhold ok", async () => {
    // The other half, and the reason the two are not one bucket. With both
    // folded together this page — clean, nothing failed — came back
    // ok: false, and so did every other ordinary invocation. An ok that is
    // always false is an ok nobody reads, which costs exactly the signal the
    // test above protects.
    const result = await lint({ html: goodPage() });
    expect(result.errors).toEqual([]);
    expect(result.notChecked).toEqual([]);
    expect(idsOf(result.notRequested).sort()).toEqual([
      "canonical.matchesUrl",
      "duplicate.nearMatch",
      "keyword.density",
      "keyword.placement",
    ]);
    // Named, and still not a pass — it is simply not `ok`'s business.
    for (const check of idsOf(result.notRequested)) {
      expect(result.passed).not.toContain(check);
    }
    expect(result.ok).toBe(true);
    expect(result.note).toContain("a run with no corpus says nothing about near-duplicates");
  });

  test("what the tool SAYS about ok matches the ok it returns", async () => {
    // A description promising a stricter gate than the code applies is the
    // same lie as a wrong result: it is what a caller reads when deciding
    // whether to trust the thing. This caught a real one — the description
    // and the README still read "ok is false whenever anything went
    // unchecked" after ok had stopped working that way, so the tool was
    // advertising a gate it no longer was.
    const result = await lint({ html: goodPage() });
    // The run this is asserting about: clean, and with checks that never ran.
    expect(result.ok).toBe(true);
    expect(result.notRequested.length).toBeGreaterThan(0);
    // Checked per TEXT, not over the two joined. Joined, the note's mention
    // covered for a description that had stopped naming the bucket at all —
    // a mutation removing it from the description left this green, which is
    // how the weakness was found rather than reasoned about.
    const said = `${seoLint.description} ${result.note}`;
    for (const [where, text] of [
      ["description", seoLint.description],
      ["note", String(result.note)],
    ] as const) {
      // Both buckets named wherever the tool explains itself, because the
      // difference between them is the whole of what ok means.
      expect(text, `${where} does not name notChecked`).toContain("notChecked");
      expect(text, `${where} does not name notRequested`).toContain("notRequested");
    }
    // And every "ok is false" it states is QUALIFIED by having been asked.
    // An unqualified one is the old claim, and it is false of the run above.
    // Asserted as a property rather than by banning the exact old sentence,
    // which a reword would slip past.
    const claims = [...said.matchAll(/ok is false[\s\S]{0,80}/gi)].map((m) => m[0]);
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim).toMatch(/asked/i);
  });

  test("the near-duplicate check says NOT CHECKED without a corpus, never a pass", async () => {
    // The survey's own warning: this check must never degrade into a pass
    // when no corpus is set. It is in notRequested rather than notChecked —
    // nobody asked — but the guarantee that matters is unchanged: it is
    // named, it says what to configure, and it is NOT in passed.
    const result = await lint({ html: goodPage() });
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("no corpus was configured");
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("does not pass by default");
    expect(result.passed).not.toContain("duplicate.nearMatch");
  });

  test("a corpus that exists but holds nothing readable is NOT CHECKED, not a pass", async () => {
    // The degradation that matters most: a corpus path WAS configured, so a
    // careless implementation reports "compared, found nothing".
    mkdirSync(join(workspace, "empty"));
    writeFileSync(join(workspace, "empty/notes.pdf"), "not text");
    const result = await lint({ html: goodPage(), corpus: "empty" });
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("no readable page");
    // Asked and unanswerable, so this one DOES withhold the pass.
    expect(bucketOf(result, "duplicate.nearMatch")).toBe("notChecked");
    expect(result.ok).toBe(false);
    expect(result.passed).not.toContain("duplicate.nearMatch");
  });

  test("a corpus path outside the workspace is NOT CHECKED, with the reason", async () => {
    const result = await lint({ html: goodPage(), corpus: "../elsewhere" });
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("outside the workspace");
    expect(result.passed).not.toContain("duplicate.nearMatch");
  });

  test("a page that copies a corpus document is an error naming the document", async () => {
    mkdirSync(join(workspace, "published"));
    writeFileSync(
      join(workspace, "published/twin.html"),
      `<html><body><main>${PROSE}</main></body></html>`,
    );
    const result = await lint({ html: goodPage(), corpus: "published" });
    expect(result.errors.find((e) => e.check === "duplicate.nearMatch")?.detail).toContain(
      "published/twin.html",
    );
  });

  test("a corpus document reached through a symlink out of the workspace is never read", async () => {
    // Containing the DIRECTORY the caller named is not enough on its own:
    // `join` does not resolve symlinks and the read that follows does. What
    // is pinned here is the property — the outside file was not compared —
    // rather than which of the two guards declined it.
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-verify-outside-"));
    try {
      mkdirSync(join(workspace, "published"));
      writeFileSync(
        join(outside, "secret.html"),
        `<html><body><main>${PROSE}</main></body></html>`,
      );
      symlinkSync(join(outside, "secret.html"), join(workspace, "published/escape.html"));
      writeFileSync(
        join(workspace, "published/real.html"),
        "<p>A page about bicycle chains and nothing else at all.</p>",
      );
      const result = await lint({ html: goodPage(), corpus: "published" });
      expect(result.corpus?.comparedWith).toBe(1);
      expect(JSON.stringify(result)).not.toContain("secret.html");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("readability is a band, never a number", async () => {
    const result = await lint({ html: goodPage() });
    const grade = result.observations.find((o) => o.check === "readability.grade");
    expect(grade?.detail).toContain("grade");
    // No decimal in the sentence that reports it: a grade to two places would
    // be this tool's rounding error presented as a fact about the prose.
    expect(grade?.detail).not.toMatch(/\d\.\d/);
    expect(result.note).toContain("band and never a number");
  });

  test("readability declines to answer for a language it was not fitted on", async () => {
    const result = await lint({
      html: goodPage({
        body: "<p>Der Wasserkocher kocht das Wasser und die Maschine zieht den Espresso. Das Mahlgut entscheidet den groessten Teil dessen, was in der Tasse landet. Filterkaffee belohnt Geduld, und eine gute Muehle belohnt sie noch mehr. Wir haben neun Muehlen ueber drei Monate in einer kleinen Kueche getestet. Das Wasser dort ist hart und die Waage wiegt auf ein Zehntel Gramm genau. Jede Muehle hat zweihundert Gramm derselben gewaschenen Partie gemahlen. Wir haben die Streuung der Partikel unter der Lupe gemessen. Wir haben den Rueckstand im Schacht nach jeder Dosis gemessen. Die guenstigste Muehle war besser als zwei Maschinen, die viermal so viel kosten.</p>",
        lang: "de",
      }),
      keyword: "muehle",
    });
    expect(reasonFor(result, "readability.grade")).toContain("fitted on English");
    expect(result.passed).not.toContain("readability.grade");
    // German still separates its words, so the density check is unaffected.
    expect(idsOf(result.notChecked)).not.toContain("keyword.density");
  });

  test("keyword density disables itself where words are not separated by spaces", async () => {
    const result = await lint({
      html: goodPage({
        body: "<p>このページはコーヒーミルについて説明します。挽き方の均一性と保持量を測定しました。三か月にわたって九台のコーヒーミルを試験し、硬水の台所で同じ豆を二百グラムずつ挽きました。粒度の分布はルーペで確認し、シュートに残る量は一回ごとに量りました。最も安い機種が、四倍の価格の機械二台より良い結果を出しました。</p>",
        lang: "ja",
      }),
      keyword: "コーヒーミル",
    });
    expect(result.language.wordBoundaries).toBe(false);
    expect(reasonFor(result, "keyword.density")).toContain("without spaces between words");
    expect(result.passed).not.toContain("keyword.density");
    // A word count is withheld rather than reported as a confident number.
    expect(result.prose.words).toBeNull();
    // Placement needs no word boundaries, so it still runs.
    expect(idsOf(result.notChecked)).not.toContain("keyword.placement");
  });

  test("the text overrides a lang attribute that disagrees with it", async () => {
    // A `lang` attribute is a claim, not a fact. Trusting it is how a density
    // comes to be computed over text that has no word boundaries.
    const result = await lint({
      html: goodPage({
        body: "<p>このページはコーヒーミルについて説明します。挽き方の均一性と保持量を測定しました。三か月にわたって九台のコーヒーミルを試験し、硬水の台所で同じ豆を二百グラムずつ挽きました。粒度の分布はルーペで確認し、シュートに残る量は一回ごとに量りました。最も安い機種が、四倍の価格の機械二台より良い結果を出しました。</p>",
        lang: "en",
      }),
      keyword: "コーヒーミル",
    });
    expect(result.language.wordBoundaries).toBe(false);
    expect(reasonFor(result, "keyword.density")).toContain("whatever the declared language");
  });

  test("too little prose withholds the statistics instead of computing them", async () => {
    const result = await lint({
      html: goodPage({ body: "<p>Short page.</p>" }),
      keyword: "grinder",
    });
    expect(reasonFor(result, "readability.grade")).toContain("under the");
    expect(reasonFor(result, "keyword.density")).toContain("under the");
  });

  test("the passive-voice count is an observation that says it over-fires", async () => {
    const body = `<p>The beans were ground by the machine. The water was heated by the kettle. The results were checked twice.</p>${PROSE}`;
    const result = await lint({ html: goodPage({ body }) });
    const passive = result.observations.find((o) => o.check === "readability.passive");
    expect(passive?.detail).toContain("part-of-speech");
    expect(passive?.detail).toContain("candidates");
    expect(idsOf(result.errors).concat(idsOf(result.warnings))).not.toContain(
      "readability.passive",
    );
  });

  test("the missing title and the missing h1 are errors, apart from the warnings", async () => {
    const result = await lint({ html: "<html lang='en'><body><p>Nothing here.</p></body></html>" });
    expect(idsOf(result.errors).sort()).toEqual(["heading.h1", "title.present"]);
    // A check with nothing to measure never lands in passed either.
    expect(result.passed).not.toContain("title.length");
  });

  test("a heading level that is skipped is located", async () => {
    const result = await lint({
      html: goodPage({ body: `${PROSE}<h2>How we tested</h2><h4>The water</h4>` }),
    });
    const finding = result.warnings.find((w) => w.check === "heading.order");
    expect(finding?.detail).toContain("h2 to h4");
    expect(finding?.location).toContain("The water");
  });

  test("an image with no alt attribute is an error; an empty alt is not", async () => {
    const result = await lint({
      html: goodPage({ body: `${PROSE}<img src="/a.png"><img src="/line.png" alt="">` }),
    });
    const missing = result.errors.filter((e) => e.check === "image.alt");
    expect(missing.length).toBe(1);
    expect(missing[0]?.location).toContain("/a.png");
    expect(result.observations.some((o) => o.detail.includes("decorative"))).toBe(true);
  });

  test("anchor text that names nothing is reported, and an image link is not", async () => {
    const result = await lint({
      html: goodPage({
        body: `${PROSE}<a href="/x">Read more →</a><a href="/y"><img src="/i.png" alt="The water guide"></a>`,
      }),
    });
    const anchors = result.warnings.filter((w) => w.check === "link.anchorText");
    expect(anchors.length).toBe(1);
    expect(anchors[0]?.detail).toContain("Read more");
  });

  test("a heading with no text is reported, since the outline cannot show it", async () => {
    const result = await lint({ html: goodPage({ body: `${PROSE}<h2></h2>` }) });
    const finding = result.warnings.find((w) => w.check === "heading.empty");
    expect(finding?.detail).toContain("carries no text");
    expect(finding?.location).toBe("<h2>");
  });

  test("a page claiming two different addresses for itself is a warning", async () => {
    const result = await lint({
      html: goodPage({ head: '<meta property="og:url" content="https://example.com/other">' }),
    });
    // The two og:url tags: the later one wins in `extractStructuredData`, the
    // same way a browser reads them, and it disagrees with the canonical.
    const finding = result.warnings.find((w) => w.check === "og.consistency");
    expect(finding?.detail).toContain("two different addresses");
  });

  test("a canonical is compared with the url as parsed, not as spelled", async () => {
    // Case in the host and a trailing slash are not differences; the path is.
    const same = await lint({
      html: goodPage(),
      url: "https://EXAMPLE.com/guides/burr-grinders/",
    });
    expect(same.passed).toContain("canonical.matchesUrl");

    const different = await lint({ html: goodPage(), url: "https://example.com/guides/grinders" });
    const finding = different.errors.find((e) => e.check === "canonical.matchesUrl");
    expect(finding?.detail).toContain("https://example.com/guides/burr-grinders");
    expect(finding?.detail).toContain("https://example.com/guides/grinders");
  });

  test("a url that is only a path checks the slug and says so about the canonical", async () => {
    const result = await lint({ html: goodPage(), url: "/guides/Burr_Grinders" });
    expect(reasonFor(result, "canonical.matchesUrl")).toContain("cannot be compared");
    const slug = result.warnings
      .filter((w) => w.check === "slug.format")
      .map((w) => w.detail)
      .join(" ");
    expect(slug).toContain("underscores");
    expect(slug).toContain("capital letters");
  });

  test("JSON-LD that does not parse is an error, and an unbundled type is NOT CHECKED", async () => {
    const result = await lint({
      html: goodPage({
        head: `<script type="application/ld+json">{ oops }</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"VeterinaryCare","name":"A Clinic"}</script>`,
      }),
    });
    expect(idsOf(result.errors)).toContain("jsonld.parse");
    expect(reasonFor(result, "jsonld.fields")).toContain("VeterinaryCare");
    expect(result.note).toContain("never for whether a property name exists");
  });

  test("a required field missing from a nested node is located", async () => {
    const result = await lint({
      html: goodPage({
        head: `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"A Grinder","offers":{"@type":"Offer","price":"99.00"}}]}</script>`,
      }),
    });
    expect(result.errors.find((e) => e.detail.includes("priceCurrency"))?.location).toContain(
      "offers",
    );
  });

  test("a page with no JSON-LD says so as a finding rather than as silence", async () => {
    const result = await lint({
      html: "<html lang='en'><head><title>A page about grinders and water</title></head><body><h1>Grinders</h1></body></html>",
    });
    expect(idsOf(result.warnings)).toContain("jsonld.present");
    expect(result.passed).not.toContain("jsonld.fields");
    expect(idsOf(result.notChecked)).not.toContain("jsonld.fields");
  });

  test("a file is read from the contained path, and Markdown is refused with a reason", async () => {
    writeFileSync(join(workspace, "page.html"), goodPage());
    expect((await lint({ file: "page.html" })).from).toBe("page.html");

    writeFileSync(join(workspace, "post.md"), "# A post\n");
    await expect(raw(seoLint, { file: "post.md" })).rejects.toThrow(/second Markdown parser/);
  });

  test("a @type that names something on Object.prototype is reported, not thrown", async () => {
    // `SCHEMA_RULES` is an object literal, so `SCHEMA_RULES["constructor"]`
    // finds the Object constructor: not undefined, and with no `required`
    // for the loop below to walk. The lint used to die on the page.
    for (const type of ["constructor", "__proto__", "Constructor"]) {
      const result = await lint({
        html: goodPage({
          head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":${JSON.stringify(type)},"name":"X"}</script>`,
        }),
      });
      expect(reasonFor(result, "jsonld.fields")).toContain(type);
    }
  });

  test("the page being linted is not a near-duplicate of itself", async () => {
    // The obvious way to run this — lint a page in the published tree
    // against the published tree — used to report a 1.00 match against the
    // page's own path, as an error, every single time.
    mkdirSync(join(workspace, "published"));
    writeFileSync(join(workspace, "published/burr-grinders.html"), goodPage());
    writeFileSync(
      join(workspace, "published/other.html"),
      "<p>An unrelated page about bicycle chains, sprocket wear and the tools for measuring it.</p>",
    );
    const result = await lint({ file: "published/burr-grinders.html", corpus: "published" });
    expect(result.errors.filter((e) => e.check === "duplicate.nearMatch")).toEqual([]);
    expect(result.corpus).toEqual({ path: "published", comparedWith: 1 });
  });

  test("a corpus holding only the page itself is NOT CHECKED, not a pass", async () => {
    mkdirSync(join(workspace, "solo"));
    writeFileSync(join(workspace, "solo/page.html"), goodPage());
    const result = await lint({ file: "solo/page.html", corpus: "solo" });
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("nothing but the page being linted");
    expect(result.passed).not.toContain("duplicate.nearMatch");
  });

  test("a keyword the tokenizer cannot carry whole names what was searched", async () => {
    // The verdict must not be published under a spelling that was never
    // looked for: every match here is word by word, so "C++" is searched
    // for as the word `c`, and a page full of "c" is not a page about C++.
    const result = await lint({
      html: goodPage({
        body: "<p>The c language is old and small. A c compiler is small. We wrote c for years and the c we wrote then still builds today with a c compiler that is modern, small and fast. The letter c is the token this reduces to, and c is what gets counted here.</p>",
      }),
      keyword: "C++",
    });
    const density = [...result.warnings, ...result.observations].find(
      (f) => f.check === "keyword.density",
    );
    expect(density?.detail).toContain('looked for as the word "c"');
    expect(density?.detail).toContain("C++");
  });

  test("a keyword with no word in it is NOT CHECKED, never 'does not appear'", async () => {
    const result = await lint({ html: goodPage(), keyword: "+++" });
    expect(idsOf(result.notChecked)).toContain("keyword.density");
    expect(idsOf(result.notChecked)).toContain("keyword.placement");
    expect(reasonFor(result, "keyword.density")).toContain("no letters or digits");
    // The accusation this replaces: a definite negative for a search that
    // never ran.
    expect(JSON.stringify(result.errors.concat(result.warnings))).not.toContain("does not appear");
    expect(result.passed).not.toContain("keyword.density");
  });

  test("a lang attribute that is not a language tag does not pass html.lang", async () => {
    for (const tag of ["!!!", "e", "zzzzzzzzzzzz"]) {
      const result = await lint({ html: goodPage({ lang: tag }) });
      expect(result.passed).not.toContain("html.lang");
      expect(result.warnings.find((w) => w.check === "html.lang")?.detail).toContain(
        "not a BCP-47 language code",
      );
      // And the readability decline names the tag rather than claiming the
      // page declared nothing.
      expect(reasonFor(result, "readability.grade")).toContain(`lang="${tag}"`);
    }
    expect((await lint({ html: goodPage({ lang: "en-GB" }) })).passed).toContain("html.lang");
  });

  test("a check that is partly unchecked is not listed under passed", async () => {
    // `passed` is the one word a caller reads as a verdict. A corpus with a
    // stylesheet in it, or a page carrying one bundled @type and one
    // unbundled, used to appear in `passed` and `notChecked` at once.
    mkdirSync(join(workspace, "pub"));
    writeFileSync(
      join(workspace, "pub/a.html"),
      "<p>Bicycle chains and sprockets, unrelated to coffee equipment of any kind at all.</p>",
    );
    writeFileSync(join(workspace, "pub/site.css"), "body{}");
    const result = await lint({
      html: goodPage({
        head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"VeterinaryCare","name":"A Clinic"}</script>`,
      }),
      corpus: "pub",
    });
    for (const check of ["duplicate.nearMatch", "jsonld.fields"]) {
      expect(idsOf(result.notChecked)).toContain(check);
      expect(result.passed).not.toContain(check);
    }
  });

  test("two paths are compared with each other rather than declined", async () => {
    // Neither carries a host, so there is nothing to guess: the old message
    // claimed one of them was absolute, which was not true of either.
    // Built directly: `extractStructuredData` reads the FIRST canonical, so
    // adding one to goodPage's head would leave its absolute one in place.
    const withCanonical = (href: string) =>
      goodPage().replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${href}">`);

    const match = await lint({
      html: withCanonical("/guides/burr-grinders/"),
      url: "/guides/burr-grinders",
    });
    expect(match.passed).toContain("canonical.matchesUrl");

    const differ = await lint({
      html: withCanonical("/guides/burr-grinders?page=2"),
      url: "/guides/burr-grinders",
    });
    expect(differ.errors.find((e) => e.check === "canonical.matchesUrl")?.detail).toContain(
      "?page=2",
    );
  });

  test("a sentence count is withheld wherever the word count is", async () => {
    // The splitter ends a sentence on ".", "!" and "?"; over prose that ends
    // its sentences with "。" it counts paragraphs. Publishing that number
    // beside a word count of null asserts a measurement it did not make.
    const result = await lint({
      html: goodPage({
        body: "<p>このページはコーヒーミルについて説明します。挽き方の均一性と保持量を測定しました。三か月にわたって九台のコーヒーミルを試験し、硬水の台所で同じ豆を二百グラムずつ挽きました。</p>",
        lang: "ja",
      }),
    });
    expect({ words: result.prose.words, sentences: result.prose.sentences }).toEqual({
      words: null,
      sentences: null,
    });
  });

  test("a title too short and a title too long are both reported", async () => {
    const withTitle = (t: string) =>
      goodPage().replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
    const short = await lint({ html: withTitle("Grinders") });
    expect(short.warnings.find((w) => w.check === "title.length")?.detail).toContain(
      "8 characters",
    );
    const long = await lint({
      html: withTitle(
        "The very best burr grinders for filter coffee in 2026, ranked and measured over three months",
      ),
    });
    expect(long.warnings.find((w) => w.check === "title.length")?.detail).toContain("truncated");
    // And a title in range is a pass rather than silence.
    expect((await lint({ html: goodPage() })).passed).toContain("title.length");
  });

  test("a check that floods is capped, and the cap is reported as a count", async () => {
    // A capped list read as a complete one is the failure here: 25 images
    // with no alt must not come back as 20 findings and no sign of the rest.
    const images = Array.from({ length: 25 }, (_, i) => `<img src="/i${i}.png">`).join("");
    const result = await lint({ html: goodPage({ body: PROSE + images }) });
    expect(result.errors.filter((e) => e.check === "image.alt").length).toBe(20);
    expect(result.suppressed).toEqual({ "image.alt": 5 });
    // Under the cap there is no suppressed block at all.
    expect((await lint({ html: goodPage() })).suppressed).toBeUndefined();
  });

  test("a corpus over the cap is refused rather than sampled", async () => {
    // Comparing the first 200 of 201 and reporting no duplicate is the
    // silent pass this check exists to prevent.
    mkdirSync(join(workspace, "big"));
    for (let i = 0; i < 201; i++) {
      writeFileSync(join(workspace, `big/p${i}.html`), `<p>Page ${i} about sprockets.</p>`);
    }
    const result = await lint({ html: goodPage(), corpus: "big" });
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("201 files");
    expect(reasonFor(result, "duplicate.nearMatch")).toContain("narrow the corpus");
    expect(result.passed).not.toContain("duplicate.nearMatch");
    expect(result.corpus).toBeUndefined();
  });

  test("the corpus reader does not follow symlinks at all, in or out", async () => {
    // The out-of-workspace case is covered above. This pins the mechanism
    // that actually declines it: the directory walk yields real files only,
    // so a link is never opened even when its target is perfectly legal.
    // If that ever changes, the leaf containment check becomes load-bearing
    // and this test is the one that says so.
    mkdirSync(join(workspace, "published"));
    writeFileSync(
      join(workspace, "published/real.html"),
      "<p>A page about bicycle chains and nothing else at all.</p>",
    );
    writeFileSync(
      join(workspace, "inside.html"),
      `<html><body><main>${PROSE}</main></body></html>`,
    );
    symlinkSync(join(workspace, "inside.html"), join(workspace, "published/link.html"));
    const result = await lint({ html: goodPage(), corpus: "published" });
    expect(result.corpus?.comparedWith).toBe(1);
    expect(JSON.stringify(result)).not.toContain("link.html");
  });

  test("a declared non-segmenting language refuses the tokenizer on its own", async () => {
    // Not via the script share: this prose is entirely Latin letters, so the
    // only thing that can decline the density is the declared language.
    const result = await lint({
      html: goodPage({
        lang: "zh",
        body: "<p>Zhe shi yi ge guan yu mo dou ji de ye mian. Wo men ce liang le yan mo de jun yun du he can liu liang, yi ji mei yi ci de sheng yin da xiao.</p>",
      }),
      keyword: "mo dou ji",
    });
    expect(result.language.wordBoundaries).toBe(false);
    expect(reasonFor(result, "keyword.density")).toContain('the page\'s language is "zh"');
    expect(result.prose.words).toBeNull();
  });

  test("a page outside the workspace is refused, however it is spelled", async () => {
    await expect(raw(seoLint, { file: "../page.html" })).rejects.toThrow(/escapes the workspace/);
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-verify-outside-"));
    try {
      writeFileSync(join(outside, "secret.html"), goodPage());
      symlinkSync(join(outside, "secret.html"), join(workspace, "escape.html"));
      await expect(raw(seoLint, { file: "escape.html" })).rejects.toThrow(/escapes the workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
