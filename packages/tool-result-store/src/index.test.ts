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
