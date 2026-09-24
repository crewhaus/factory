import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import type { ToolResult } from "@crewhaus/tool-executor";
import {
  DEFAULT_PREVIEW_LINES,
  DEFAULT_THRESHOLD_BYTES,
  assertUnderRoot,
  previewHead,
  resolveStoragePath,
  storeAndPreview,
} from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-result-store-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeResult(content: string, isError = false): ToolResult {
  return { toolUseId: "tu_X", content, isError };
}

describe("storeAndPreview — under threshold", () => {
  test("small content is returned verbatim, no file written", async () => {
    const rootDir = newTempRoot();
    const out = await storeAndPreview(makeResult("tiny output"), {
      runId: "run_a",
      toolUseId: "tu_1",
      rootDir,
    });
    expect(out.persisted).toBe(false);
    expect(out.fullPath).toBeNull();
    expect(out.previewContent).toBe("tiny output");
  });

  test("exactly at threshold is still treated as small", async () => {
    const rootDir = newTempRoot();
    const content = "a".repeat(DEFAULT_THRESHOLD_BYTES);
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_a",
      toolUseId: "tu_1",
      rootDir,
    });
    expect(out.persisted).toBe(false);
    expect(out.fullPath).toBeNull();
    expect(out.previewContent).toBe(content);
  });
});

describe("storeAndPreview — non-string content", () => {
  test("image content-block array bypasses persistence and is forwarded verbatim", async () => {
    const rootDir = newTempRoot();
    // A large base64 payload that would blow past the byte threshold if it
    // were a string — confirms the array short-circuits before any sizing.
    const blocks: ToolResult["content"] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "Q".repeat(DEFAULT_THRESHOLD_BYTES + 10),
        },
      },
    ];
    const out = await storeAndPreview(
      { toolUseId: "tu_img", content: blocks, isError: false },
      {
        runId: "run_img",
        toolUseId: "tu_img",
        rootDir,
      },
    );
    expect(out.persisted).toBe(false);
    expect(out.fullPath).toBeNull();
    // Same reference forwarded unchanged — no copy, no preview wrapping.
    expect(out.previewContent).toBe(blocks);
    // Nothing was written under the run directory.
    expect(() => statSync(join(rootDir, "run_img"))).toThrow();
  });

  test("mixed text + image blocks are also forwarded as-is", async () => {
    const rootDir = newTempRoot();
    const blocks: ToolResult["content"] = [
      { type: "text", text: "caption" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
      },
    ];
    const out = await storeAndPreview(
      { toolUseId: "tu_mix", content: blocks, isError: false },
      {
        runId: "run_mix",
        toolUseId: "tu_mix",
        rootDir,
      },
    );
    expect(out.persisted).toBe(false);
    expect(out.fullPath).toBeNull();
    expect(out.previewContent).toEqual(blocks);
  });
});

/** The part of a preview before the truncation marker. */
function headOf(preview: unknown): string {
  if (typeof preview !== "string") throw new Error("expected a string preview");
  const at = preview.lastIndexOf("\n[truncated, full output at ");
  if (at === -1) throw new Error("no truncation marker");
  return preview.slice(0, at);
}

// flag-truth-6#4 / security-12#8 — the preview kept the first 100 LINES, so a
// result on one line (every builtin that returns JSON.stringify'd output,
// RunCommand's stdout included) reached the model whole, plus a marker.
describe("storeAndPreview — the preview is capped by bytes, not only lines", () => {
  test("a single long line is cut to the threshold, and the file keeps all of it", async () => {
    const rootDir = newTempRoot();
    const content = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ i, v: "x" })));
    expect(content.includes("\n")).toBe(false);
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_long",
      toolUseId: "tu_1",
      rootDir,
    });
    expect(out.persisted).toBe(true);
    const head = headOf(out.previewContent);
    expect(Buffer.byteLength(head, "utf8")).toBe(DEFAULT_THRESHOLD_BYTES);
    expect(content.startsWith(head)).toBe(true);
    expect(String(out.previewContent).endsWith(`full output at ${out.fullPath}]`)).toBe(true);
    expect(readFileSync(out.fullPath as string, "utf8")).toBe(content);
  });

  test("wide multi-line output is capped too", async () => {
    const rootDir = newTempRoot();
    const content = Array.from({ length: 50 }, () => "w".repeat(4096)).join("\n");
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_wide",
      toolUseId: "tu_1",
      rootDir,
    });
    const head = headOf(out.previewContent);
    expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(DEFAULT_THRESHOLD_BYTES);
    expect(content.startsWith(head)).toBe(true);
  });

  test("the cut never splits a character", () => {
    // Two-byte characters with an odd budget: the last one would be split.
    expect(previewHead("é".repeat(20_000), 100, 10_001)).toBe("é".repeat(5_000));
    // Three-byte characters: a whole number of them, no replacement char.
    const euro = previewHead("€".repeat(20_000), 100, 10_240);
    expect(Buffer.byteLength(euro, "utf8") % 3).toBe(0);
    expect(euro).toBe("€".repeat(3_413));
    // Surrogate pairs: neither half is left on its own, whichever way the
    // budget falls.
    for (const budget of [10, 11, 13]) {
      const emoji = previewHead("😀".repeat(100), 100, budget);
      expect(emoji).toBe("😀".repeat(Math.floor(budget / 4)));
      expect(emoji).not.toContain("\ufffd");
    }
    // The window of `budget` code units ends between the two halves.
    expect(previewHead("a😀b", 100, 2)).toBe("a");
    expect(previewHead("a😀b", 100, 5)).toBe("a😀");
  });

  test("the line limit still applies first, and a caller's byte budget is honoured", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(previewHead(lines, 3, 1_000)).toBe("line 0\nline 1\nline 2");
    expect(previewHead(lines, 3, 10)).toBe("line 0\nlin");
    expect(previewHead(lines, 0, 1_000)).toBe("");
    expect(previewHead(lines, 3, 0)).toBe("");
  });

  test("the byte budget defaults to the threshold", async () => {
    const rootDir = newTempRoot();
    const out = await storeAndPreview(makeResult("y".repeat(500)), {
      runId: "run_default",
      toolUseId: "tu_1",
      rootDir,
      thresholdBytes: 100,
    });
    expect(headOf(out.previewContent)).toBe("y".repeat(100));
  });
});

describe("storeAndPreview — over threshold", () => {
  test("large content is persisted; preview shows first N lines + marker", async () => {
    const rootDir = newTempRoot();
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    // pad past the byte threshold so the persistence path fires
    const padded = `${content}\n${"x".repeat(DEFAULT_THRESHOLD_BYTES)}`;
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);
    const out = await storeAndPreview(makeResult(padded), {
      runId: "run_b",
      toolUseId: "tu_2",
      rootDir,
    });
    expect(out.persisted).toBe(true);
    expect(out.fullPath).not.toBeNull();
    if (out.fullPath === null) throw new Error("unreachable");
    expect(statSync(out.fullPath).size).toBe(Buffer.byteLength(padded, "utf8"));

    // Preview = first DEFAULT_PREVIEW_LINES lines + truncation marker.
    if (typeof out.previewContent !== "string") throw new Error("expected string preview");
    const previewLines = out.previewContent.split("\n");
    // last line should be the marker, the line before that may be partial.
    expect(previewLines[previewLines.length - 1]).toContain("[truncated, full output at ");
    expect(previewLines[previewLines.length - 1]).toContain(out.fullPath);
    expect(previewLines.length).toBe(DEFAULT_PREVIEW_LINES + 1);
    // First preview line should be the very first line of input.
    expect(previewLines[0]).toBe("line 1");
  });

  test("custom previewLines, thresholdBytes, rootDir overrides honored", async () => {
    const rootDir = newTempRoot();
    const content = "line a\nline b\nline c\nline d\nline e\nline f";
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_c",
      toolUseId: "tu_3",
      rootDir,
      thresholdBytes: 5,
      previewLines: 2,
      previewBytes: 100,
    });
    expect(out.persisted).toBe(true);
    expect(out.previewContent).toContain("line a\nline b\n[truncated, full output at ");
    expect(out.fullPath).toContain(rootDir);
  });

  test("idempotent on retry — second call with same ids returns same path without throwing", async () => {
    const rootDir = newTempRoot();
    const content = "x".repeat(DEFAULT_THRESHOLD_BYTES + 10);
    const first = await storeAndPreview(makeResult(content), {
      runId: "run_d",
      toolUseId: "tu_4",
      rootDir,
    });
    const second = await storeAndPreview(makeResult(content), {
      runId: "run_d",
      toolUseId: "tu_4",
      rootDir,
    });
    expect(first.fullPath).toBe(second.fullPath);
    if (first.fullPath === null) throw new Error("unreachable");
    // File still exists and has the original content.
    expect(readFileSync(first.fullPath, "utf8")).toBe(content);
  });

  test("multi-byte UTF-8 byte length, not character length, drives the threshold", async () => {
    const rootDir = newTempRoot();
    // 5000 emoji × 4 bytes each = 20_000 bytes (over threshold) but only 5000 chars.
    const content = "🌟".repeat(5000);
    expect(content.length).toBe(10000); // emoji is 2 surrogate code units in JS
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_e",
      toolUseId: "tu_5",
      rootDir,
    });
    expect(out.persisted).toBe(true);
  });

  test("error results (isError: true) also get persisted when large", async () => {
    const rootDir = newTempRoot();
    const stack = `Error: boom\n${"    at foo\n".repeat(5000)}`;
    const out = await storeAndPreview(makeResult(stack, true), {
      runId: "run_f",
      toolUseId: "tu_6",
      rootDir,
    });
    expect(out.persisted).toBe(true);
    expect(out.fullPath).toContain(`${rootDir}/run_f/tu_6.txt`);
  });
});

describe("storeAndPreview — path traversal guard", () => {
  test("runId with .. is rejected", async () => {
    const rootDir = newTempRoot();
    const big = "x".repeat(DEFAULT_THRESHOLD_BYTES + 10);
    await expect(
      storeAndPreview(makeResult(big), {
        runId: "../escape",
        toolUseId: "tu_7",
        rootDir,
      }),
    ).rejects.toThrow(/runId/);
  });

  test("toolUseId with slash is rejected", async () => {
    const rootDir = newTempRoot();
    const big = "x".repeat(DEFAULT_THRESHOLD_BYTES + 10);
    await expect(
      storeAndPreview(makeResult(big), {
        runId: "ok",
        toolUseId: "etc/passwd",
        rootDir,
      }),
    ).rejects.toThrow(/toolUseId/);
  });

  test("empty runId is rejected", async () => {
    const rootDir = newTempRoot();
    const big = "x".repeat(DEFAULT_THRESHOLD_BYTES + 10);
    await expect(
      storeAndPreview(makeResult(big), { runId: "", toolUseId: "tu", rootDir }),
    ).rejects.toThrow(/runId/);
  });

  test("resolveStoragePath returns a path under rootDir", () => {
    const path = resolveStoragePath("run_x", "tu_y", "/tmp/cr-test");
    expect(path).toContain("/tmp/cr-test/run_x/tu_y.txt");
  });

  test("assertUnderRoot accepts a path strictly under root", () => {
    expect(() => assertUnderRoot("/tmp/cr-root/run/file.txt", "/tmp/cr-root")).not.toThrow();
  });

  test("assertUnderRoot rejects a path that escapes root (defence-in-depth throw)", () => {
    // Exercises the boundary check directly: a resolved path that does NOT
    // sit under root must throw, even though rejectUnsafeSegment normally
    // makes this unreachable from resolveStoragePath.
    expect(() => assertUnderRoot("/etc/passwd", "/tmp/cr-root")).toThrow(RuntimeError);
    expect(() => assertUnderRoot("/tmp/cr-root-sibling/x", "/tmp/cr-root")).toThrow(
      /escapes rootDir/,
    );
  });
});

describe("storeAndPreview — cross-tenant fencing (CWE-1230)", () => {
  const big = "x".repeat(DEFAULT_THRESHOLD_BYTES + 10);

  test("inside tenantA, a store rooted under tenantB fails closed", async () => {
    const tenantsRoot = newTempRoot();
    const tenantA = buildTenant("tenant-a", { tenantsRoot });
    const tenantB = buildTenant("tenant-b", { tenantsRoot });
    // Persisting under tenantB's toolResultRoot while tenantA is active
    // resolves a path outside tenantA's root, so it fails closed.
    await withTenant(tenantA, async () => {
      await expect(
        storeAndPreview(makeResult(big), {
          runId: "run_x",
          toolUseId: "tu_x",
          rootDir: tenantB.toolResultRoot,
        }),
      ).rejects.toThrow(TenancyError);
    });
  });

  test("inside tenantA, a store rooted under tenantA persists", async () => {
    const tenantsRoot = newTempRoot();
    const tenantA = buildTenant("tenant-a", { tenantsRoot });
    await withTenant(tenantA, async () => {
      const out = await storeAndPreview(makeResult(big), {
        runId: "run_x",
        toolUseId: "tu_x",
        rootDir: tenantA.toolResultRoot,
      });
      expect(out.persisted).toBe(true);
      expect(out.fullPath).toContain(tenantA.toolResultRoot);
    });
  });

  test("no active tenant — behaviour is unchanged (no fencing)", async () => {
    const rootDir = newTempRoot();
    const out = await storeAndPreview(makeResult(big), {
      runId: "run_x",
      toolUseId: "tu_x",
      rootDir,
    });
    expect(out.persisted).toBe(true);
  });
});
