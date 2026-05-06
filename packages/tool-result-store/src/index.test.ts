import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@crewhaus/tool-executor";
import {
  DEFAULT_PREVIEW_LINES,
  DEFAULT_THRESHOLD_BYTES,
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
});
