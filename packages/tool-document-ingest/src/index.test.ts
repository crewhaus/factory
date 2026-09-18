/**
 * Tests for tool-document-ingest. Built-in handling for plain text /
 * structured / tabular formats, operator-registered parsers, and
 * workspace path containment (mirrors tool-fs's traversal-rejection
 * cases).
 *
 * The harness chdirs into a temp workspace because IngestDocument is
 * sandboxed to `process.cwd()` — tests address files by workspace-
 * relative path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  DocumentIngestError,
  ToolPermissionError,
  clearDocumentParsers,
  ingestDocument,
  registerDocumentParser,
} from "./index";

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  // realpath so absolute-path-inside-workspace assertions hold on macOS,
  // where tmpdir() lives behind the /var → /private/var symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "doc-ingest-")));
  process.chdir(tmp);
  clearDocumentParsers();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  clearDocumentParsers();
});

/** Write `content` into the temp workspace; returns the workspace-relative path. */
function writeFile(name: string, content: string): string {
  writeFileSync(join(tmp, name), content);
  return name;
}

describe("ingestDocument — basics", () => {
  test("tool flags: read-only, non-destructive, named 'IngestDocument'", () => {
    expect(ingestDocument.name).toBe("IngestDocument");
    expect(ingestDocument.readOnly).toBe(true);
    expect(ingestDocument.destructive).toBe(false);
  });

  test("throws when file does not exist", async () => {
    await expect(ingestDocument.execute({ path: "does/not/exist.txt" })).rejects.toThrow(
      DocumentIngestError,
    );
  });

  test("ingests a plain .txt file with the document envelope", async () => {
    const path = writeFile("note.txt", "hello\nworld\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain("<document path=");
    expect(result).toContain("hello");
    expect(result).toContain("</document>");
    expect(result).toContain("metadata:");
  });

  test("emits line count + ext in metadata for .md", async () => {
    const path = writeFile("doc.md", "# title\n\nbody.\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"ext":"\.md"/);
    expect(result).toMatch(/"lines":3/);
  });
});

describe("ingestDocument — path containment", () => {
  test("ToolPermissionError is a CrewhausError with code 'tool'", () => {
    const err = new ToolPermissionError("IngestDocument", "../../escape");
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("tool");
    expect(err.toolName).toBe("IngestDocument");
    expect(err.path).toBe("../../escape");
    expect(err.message).toContain("escapes the workspace root");
  });

  test("rejects parent-directory traversal", async () => {
    await expect(ingestDocument.execute({ path: "../../../etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects absolute path outside workspace", async () => {
    await expect(ingestDocument.execute({ path: "/etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects subdir-then-traversal", async () => {
    mkdirSync(join(tmp, "sub"));
    await expect(ingestDocument.execute({ path: "sub/../../escape.txt" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects an in-root symlink whose target escapes the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "doc-ingest-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "top secret");
      symlinkSync(join(outside, "secret.txt"), join(tmp, "link.txt"));
      await expect(ingestDocument.execute({ path: "link.txt" })).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("allows an absolute path inside the workspace", async () => {
    writeFile("inside.txt", "in-root content");
    const result = await ingestDocument.execute({ path: join(tmp, "inside.txt") });
    expect(result).toContain("in-root content");
  });

  test("allows an in-root symlink to an in-root file (no over-blocking)", async () => {
    writeFile("real.txt", "linked content");
    symlinkSync(join(tmp, "real.txt"), join(tmp, "good-link.txt"));
    const result = await ingestDocument.execute({ path: "good-link.txt" });
    expect(result).toContain("linked content");
  });
});

describe("ingestDocument — tabular formats", () => {
  test("counts rows + columns in CSV", async () => {
    const path = writeFile("data.csv", "a,b,c\n1,2,3\n4,5,6\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"rows":3/);
    expect(result).toMatch(/"columns":3/);
  });

  test("uses tab delimiter for .tsv", async () => {
    const path = writeFile("data.tsv", "a\tb\n1\t2\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"columns":2/);
  });
});

describe("ingestDocument — structured formats", () => {
  test("validates JSON parse for .json files", async () => {
    const path = writeFile("config.json", '{"k":1}');
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"valid_json":true/);
  });

  test("flags malformed JSON without throwing", async () => {
    const path = writeFile("config.json", "{not json}");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"valid_json":false/);
    expect(result).toContain("parse_error");
  });
});

describe("ingestDocument — stubbed extensions", () => {
  test(".pdf raises with a pointer to registerDocumentParser", async () => {
    const path = writeFile("doc.pdf", "%PDF-1.4 fake content");
    await expect(ingestDocument.execute({ path })).rejects.toThrow(
      /needs a parser registered via registerDocumentParser/,
    );
  });

  test(".docx and .xlsx similarly throw with extension-specific message", async () => {
    const docx = writeFile("a.docx", "fake docx");
    await expect(ingestDocument.execute({ path: docx })).rejects.toThrow(/"\.docx"/);
    const xlsx = writeFile("b.xlsx", "fake xlsx");
    await expect(ingestDocument.execute({ path: xlsx })).rejects.toThrow(/"\.xlsx"/);
  });
});

describe("ingestDocument — operator-registered parsers", () => {
  test("registerDocumentParser overrides built-in handling", async () => {
    registerDocumentParser(".pdf", async (path) => ({
      content: `parsed PDF text from ${path}`,
      metadata: { pages: 42 },
    }));
    const path = writeFile("doc.pdf", "fake content");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain("parsed PDF text from");
    expect(result).toMatch(/"pages":42/);
  });

  test("registerDocumentParser rejects extensions without leading dot", () => {
    expect(() => registerDocumentParser("pdf", async () => ({ content: "" }))).toThrow(
      DocumentIngestError,
    );
  });

  test("ext matching is case-insensitive", async () => {
    registerDocumentParser(".PDF", async () => ({ content: "uppercase ext" }));
    const path = writeFile("doc.pdf", "x");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain("uppercase ext");
  });
});

describe("ingestDocument — size cap", () => {
  test("truncates content above maxBytes with a TRUNCATED notice", async () => {
    const path = writeFile("big.txt", "x".repeat(200));
    const result = await ingestDocument.execute({ path, maxBytes: 50 });
    expect(result).toContain("TRUNCATED to 50 bytes");
  });

  test("default maxBytes is 1MB", () => {
    const parsed = ingestDocument.inputSchema.parse({ path: "x" });
    expect(parsed.maxBytes).toBeUndefined();
  });
});

// Regression — the DANGLING-symlink variant of the containment hole. A link
// whose target is missing answers false to `existsSync`, because `existsSync`
// follows symlinks: a containment walk that probes with it strolls past the
// link, treats it as a plain missing leaf, and re-appends the name to the
// realpath'd parent, so the check passes on a path that really points outside
// the workspace. IngestDocument is read-only and opens with O_NOFOLLOW, so
// nothing escapes through it TODAY — these tests pin the boundary itself, so
// that a future writing tool (or an operator-registered parser, which receives
// the resolved path and is outside the O_NOFOLLOW guard) inherits a `resolveSafe`
// that already refuses the link.
describe("ingestDocument — dangling-symlink containment", () => {
  test("a dangling symlink pointing outside the workspace is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "doc-ingest-outside-"));
    try {
      // The target does not exist: this is the case `existsSync` gets wrong.
      const target = join(outside, "pwned.txt");
      symlinkSync(target, join(tmp, "dangling.txt"));

      const err = await ingestDocument.execute({ path: "dangling.txt" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      // Refused as a CONTAINMENT failure, not as an incidental "file not found".
      expect(err).toBeInstanceOf(ToolPermissionError);
      expect((err as Error).message).toMatch(/escapes the workspace root/);
      // Read-only tool, so the interesting negatives are that the refusal did
      // not bring the outside target into being and left the bait untouched.
      expect(existsSync(target)).toBe(false);
      expect(lstatSync(join(tmp, "dangling.txt")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling symlinked DIRECTORY pointing outside is refused", async () => {
    // The escape does not need the leaf to be the link: a link standing in for
    // a directory that does not exist yet is walked past the same way, and the
    // whole subtree underneath it then reads as in-workspace.
    const outside = mkdtempSync(join(tmpdir(), "doc-ingest-outside-"));
    try {
      const missing = join(outside, "not-yet-a-dir");
      symlinkSync(missing, join(tmp, "dlink"));

      const err = await ingestDocument.execute({ path: "dlink/secret.txt" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ToolPermissionError);
      expect((err as Error).message).toMatch(/escapes the workspace root/);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling symlink that stays inside the workspace is not a containment refusal", async () => {
    // The mirror of the tests above: refusing every dangling link would also
    // "pass" them. An in-workspace dangling link must fail — there is nothing
    // to read — but it must fail as an ordinary not-found, never as an escape.
    mkdirSync(join(tmp, "sub"));
    const realTarget = join(tmp, "sub", "made.txt");
    symlinkSync(realTarget, join(tmp, "inside.txt"));

    const err = await ingestDocument.execute({ path: "inside.txt" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DocumentIngestError);
    expect((err as Error).message).not.toMatch(/escapes the workspace root/);

    // And once the target exists, the same link reads straight through it.
    writeFileSync(realTarget, "arrived through the link");
    const result = await ingestDocument.execute({ path: "inside.txt" });
    expect(result).toContain("arrived through the link");
  });

  test("an in-workspace dangling link written through an aliased prefix is honoured", async () => {
    // The macOS /var -> /private/var wrinkle, built by hand so it holds on
    // every platform: the link's target names a path OUTSIDE the workspace
    // that itself resolves back INSIDE it. Following one `readlink` hop and
    // returning the raw target refuses this; recursing resolves the alias
    // first and sees that the write would land in the workspace after all.
    const outside = mkdtempSync(join(tmpdir(), "doc-ingest-alias-"));
    try {
      mkdirSync(join(tmp, "sub"));
      symlinkSync(tmp, join(outside, "ws")); // outside/ws -> the workspace
      const aliased = join(outside, "ws", "sub", "made.txt");
      symlinkSync(aliased, join(tmp, "aliased-link.txt"));

      const err = await ingestDocument.execute({ path: "aliased-link.txt" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((err as Error).message).not.toMatch(/escapes the workspace root/);
      expect(err).toBeInstanceOf(DocumentIngestError);

      // Positive half: with the target in place the read succeeds, proving the
      // alias resolved to a real in-workspace file rather than being tolerated.
      writeFileSync(join(tmp, "sub", "made.txt"), "aliased but inside");
      const result = await ingestDocument.execute({ path: "aliased-link.txt" });
      expect(result).toContain("aliased but inside");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Regression — a RELATIVE symlink target must be resolved against the
// directory that actually CONTAINS the link, not the link's lexical parent.
// The two differ exactly when that parent is itself reached through a
// symlink, and following one `readlink` hop is what first makes the
// difference reachable: the leaf now stays in the RESOLVED part of the path,
// so measuring it from the wrong directory names a location the caller's
// path does not lead to.
describe("ingestDocument — relative dangling-link base", () => {
  test("an outward directory link holding a relative dangling link is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "doc-ingest-outside-"));
    try {
      mkdirSync(join(outside, "realdir"));
      symlinkSync(join(outside, "realdir"), join(tmp, "pdir"));
      // True destination <outside>/secret.txt; lexically it reads as the
      // in-root <tmp>/secret.txt.
      symlinkSync("../secret.txt", join(outside, "realdir", "l"));

      const err = await ingestDocument.execute({ path: "pdir/l" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ToolPermissionError);
      expect((err as Error).message).toMatch(/escapes the workspace root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
