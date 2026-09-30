import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import type { ToolResult } from "@crewhaus/tool-executor";
import {
  DEFAULT_PREVIEW_LINES,
  DEFAULT_THRESHOLD_BYTES,
  MAX_NAME_ATTEMPTS,
  MAX_PARTS,
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
  const body = preview.slice(0, at);
  // The line naming part 2, when the rest was saved in parts.
  const part = body.lastIndexOf("\n[part 1 of ");
  return part === -1 ? body : body.slice(0, part);
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

// 0.7.1 review — capping a one-line result's preview by bytes put the rest
// out of the model's reach: `Read` has no offset, and a Read of the saved
// file is cut to the same preview. The rest is now also saved in parts that
// one Read returns whole, each naming the next.
describe("storeAndPreview — the rest of the output in parts", () => {
  /** Follow the chain from the preview, as a model with only Read would. */
  async function followParts(preview: string): Promise<{ pieces: string[]; paths: string[] }> {
    const pieces = [headOf(preview)];
    const paths: string[] = [];
    let next = /\n\[part 1 of \d+; Read (.+) for part 2\]\n/.exec(preview)?.[1];
    while (next !== undefined) {
      paths.push(next);
      const text = readFileSync(next, "utf8");
      // A Read of a part comes back whole: it is not over the threshold.
      const again = await storeAndPreview(makeResult(text), {
        runId: "run_read",
        toolUseId: `tu_read_${paths.length}`,
        rootDir: newTempRoot(),
      });
      expect(again.persisted).toBe(false);
      const cut = text.lastIndexOf("\n[part ");
      pieces.push(text.slice(0, cut));
      next = /; Read (.+) for part \d+; full output at /.exec(text.slice(cut))?.[1];
    }
    return { pieces, paths };
  }

  test("an 18 KB one-line JSON result: every item is reachable with Read alone", async () => {
    const rootDir = newTempRoot();
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      tags: ["a"],
    }));
    const content = JSON.stringify(items);
    expect(content.includes("\n")).toBe(false);
    expect(Buffer.byteLength(content)).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_parts",
      toolUseId: "tu_1",
      rootDir,
    });
    const { pieces, paths } = await followParts(String(out.previewContent));
    expect(pieces.join("")).toBe(content);
    expect(paths).toEqual(out.partPaths ?? []);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(paths[paths.length - 1] as string, "utf8")).toContain(
      "the end of the output; full output at",
    );
    // The full file is unchanged by the parts.
    expect(readFileSync(out.fullPath as string, "utf8")).toBe(content);
  });

  test("multi-line output is cut at newlines, and a multi-byte character is never split", async () => {
    const rootDir = newTempRoot();
    const content = Array.from({ length: 3000 }, (_, i) => `row ${i} — ${"é".repeat(i % 7)}`).join(
      "\n",
    );
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_lines",
      toolUseId: "tu_1",
      rootDir,
    });
    const { pieces } = await followParts(String(out.previewContent));
    expect(pieces.join("")).toBe(content);
    for (const piece of pieces.slice(1, -1)) expect(piece.endsWith("\n")).toBe(true);
    for (const piece of pieces) expect(piece).not.toContain("\ufffd");
  });

  test("past MAX_PARTS the last part says the rest is only in the full output", async () => {
    const rootDir = newTempRoot();
    const content = "z".repeat(DEFAULT_THRESHOLD_BYTES * (MAX_PARTS + 4));
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_cap",
      toolUseId: "tu_1",
      rootDir,
    });
    expect(String(out.previewContent)).toContain(`[part 1 of ${MAX_PARTS}; Read `);
    expect(out.partPaths).toHaveLength(MAX_PARTS - 1);
    const last = readFileSync(out.partPaths?.[MAX_PARTS - 2] as string, "utf8");
    expect(last).toMatch(
      new RegExp(
        `\\[part ${MAX_PARTS} of ${MAX_PARTS}, the last part saved; the remaining \\d+ bytes are only in the full output at `,
      ),
    );
    const { pieces } = await followParts(String(out.previewContent));
    const shown = pieces.join("");
    expect(content.startsWith(shown)).toBe(true);
    const remaining = Number(/the remaining (\d+) bytes/.exec(last)?.[1]);
    expect(shown.length + remaining).toBe(content.length);
  }, 20_000);

  test("a retried call reuses its parts; a part taken by other content is reported", async () => {
    const rootDir = newTempRoot();
    const content = "q".repeat(DEFAULT_THRESHOLD_BYTES * 3);
    const opts = { runId: "run_retry", toolUseId: "tu_1", rootDir };
    const first = await storeAndPreview(makeResult(content), opts);
    const again = await storeAndPreview(makeResult(content), opts);
    expect(again.reused).toBe(true);
    expect(again.partPaths).toEqual(first.partPaths ?? []);
    expect(again.previewContent).toBe(first.previewContent);

    const planted = { runId: "run_planted", toolUseId: "tu_1", rootDir };
    mkdirSync(join(rootDir, "run_planted"), { recursive: true });
    writeFileSync(join(rootDir, "run_planted", "tu_1.part-2.txt"), "someone else's");
    const out = await storeAndPreview(makeResult(content), planted);
    expect(out.persisted).toBe(true);
    expect(out.partPaths).toBeUndefined();
    expect(String(out.previewContent)).toContain(
      "[the rest could not also be saved in parts to Read one at a time: ",
    );
    expect(readFileSync(join(rootDir, "run_planted", "tu_1.part-2.txt"), "utf8")).toBe(
      "someone else's",
    );
  });

  test("a threshold too small for a useful part writes none, as before", async () => {
    const rootDir = newTempRoot();
    const out = await storeAndPreview(makeResult("y".repeat(5_000)), {
      runId: "run_small",
      toolUseId: "tu_1",
      rootDir,
      thresholdBytes: 100,
    });
    expect(out.partPaths).toBeUndefined();
    expect(String(out.previewContent)).not.toContain("[part 1 of");
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

    // Preview = first DEFAULT_PREVIEW_LINES lines, the line naming part 2,
    // then the truncation marker.
    if (typeof out.previewContent !== "string") throw new Error("expected string preview");
    const previewLines = out.previewContent.split("\n");
    // last line should be the marker, the line before it names the next part.
    expect(previewLines[previewLines.length - 1]).toContain("[truncated, full output at ");
    expect(previewLines[previewLines.length - 1]).toContain(out.fullPath);
    expect(previewLines[previewLines.length - 2]).toMatch(
      /^\[part 1 of \d+; Read .+ for part 2\]$/,
    );
    expect(previewLines.length).toBe(DEFAULT_PREVIEW_LINES + 2);
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

// C129 — a tool_use_id repeats within a run whenever a provider sends none
// and one is synthesised per response (Gemini's `gemini_Bash_0` in every
// turn). The store treated the taken name as "the same result, already
// saved", so the second call's pointer named the FIRST call's output and its
// own output was lost.
describe("storeAndPreview — a repeated tool_use_id", () => {
  const T = DEFAULT_THRESHOLD_BYTES;
  const pointerOf = (out: { previewContent: unknown }): string => {
    const m = /\[truncated, full output at (.+)\]$/.exec(String(out.previewContent));
    if (m === null) throw new Error(`no pointer in ${String(out.previewContent).slice(-120)}`);
    return m[1] as string;
  };

  test("different content under the same ids never points at the earlier output", async () => {
    const rootDir = newTempRoot();
    const ids = { runId: "run_e", toolUseId: "tu_5", rootDir };
    const first = await storeAndPreview(makeResult("A".repeat(T + 10)), ids);
    const second = await storeAndPreview(makeResult("B".repeat(T + 10)), ids);
    expect(second.fullPath).not.toBe(first.fullPath);
    expect(second.fullPath).toBe(join(rootDir, "run_e", "tu_5.2.txt"));
    expect(readFileSync(second.fullPath as string, "utf8")).toBe("B".repeat(T + 10));
    expect(readFileSync(first.fullPath as string, "utf8")).toBe("A".repeat(T + 10));
    expect(pointerOf(second)).toBe(second.fullPath as string);
    expect(second.reused).toBeUndefined();
    // A third distinct result takes the next name; a retry of the second
    // reuses the second's file.
    const third = await storeAndPreview(makeResult("C".repeat(T + 10)), ids);
    expect(third.fullPath).toBe(join(rootDir, "run_e", "tu_5.3.txt"));
    const retry = await storeAndPreview(makeResult("B".repeat(T + 10)), ids);
    expect(retry.fullPath).toBe(second.fullPath);
    expect(retry.reused).toBe(true);
  });

  test("a result that is a prefix of the saved one is not the same result", async () => {
    const rootDir = newTempRoot();
    const ids = { runId: "run_p", toolUseId: "tu_p", rootDir };
    const long = await storeAndPreview(makeResult(`${"x".repeat(T + 10)}tail`), ids);
    const short = await storeAndPreview(makeResult("x".repeat(T + 10)), ids);
    expect(short.fullPath).not.toBe(long.fullPath);
    expect(readFileSync(short.fullPath as string, "utf8")).toBe("x".repeat(T + 10));
  });

  test("a link planted at the name is neither written through nor reused", async () => {
    const rootDir = newTempRoot();
    const outside = newTempRoot();
    const target = join(outside, "victim.txt");
    const content = "S".repeat(T + 10);
    // Even a link to a file holding the very same bytes is not reused: the
    // pointer must name a file the store itself wrote.
    writeFileSync(target, content);
    mkdirSync(join(rootDir, "run_l"), { recursive: true });
    symlinkSync(target, join(rootDir, "run_l", "tu_l.txt"));
    symlinkSync(join(outside, "absent.txt"), join(rootDir, "run_l", "tu_l.2.txt"));
    const out = await storeAndPreview(makeResult(content), {
      runId: "run_l",
      toolUseId: "tu_l",
      rootDir,
    });
    expect(out.fullPath).toBe(join(rootDir, "run_l", "tu_l.3.txt"));
    expect(readFileSync(target, "utf8")).toBe(content);
    expect(existsSync(join(outside, "absent.txt"))).toBe(false);
    expect(pointerOf(out)).toBe(out.fullPath as string);
  });

  test("a FIFO planted at the name is skipped, not opened", async () => {
    if (process.platform === "win32") return;
    const rootDir = newTempRoot();
    mkdirSync(join(rootDir, "run_f"), { recursive: true });
    const fifo = join(rootDir, "run_f", "tu_f.txt");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const out = await storeAndPreview(makeResult("F".repeat(T + 10)), {
      runId: "run_f",
      toolUseId: "tu_f",
      rootDir,
    });
    expect(out.fullPath).toBe(join(rootDir, "run_f", "tu_f.2.txt"));
    expect(readFileSync(out.fullPath as string, "utf8")).toBe("F".repeat(T + 10));
  });

  test("a run directory linked out of the root is refused, and the model still gets the preview", async () => {
    const rootDir = newTempRoot();
    const outside = newTempRoot();
    symlinkSync(outside, join(rootDir, "run_o"));
    const out = await storeAndPreview(makeResult(`first line\n${"O".repeat(T + 10)}`), {
      runId: "run_o",
      toolUseId: "tu_o",
      rootDir,
    });
    expect(out.persisted).toBe(false);
    expect(out.fullPath).toBeNull();
    expect(Bun.spawnSync(["ls", outside]).stdout.toString()).toBe("");
    expect(out.unsaved).toContain("run_o/tu_o.txt");
    const preview = String(out.previewContent);
    expect(preview.startsWith("first line\n")).toBe(true);
    expect(preview).toContain("[truncated; the full output could not be saved: ");
    expect(preview).toContain("run_o/tu_o.txt");
  });

  test("the name search is bounded", async () => {
    const rootDir = newTempRoot();
    const dir = join(rootDir, "run_b");
    mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
      writeFileSync(join(dir, n === 1 ? "tu_b.txt" : `tu_b.${n}.txt`), "other");
    }
    const out = await storeAndPreview(makeResult("b".repeat(T + 10)), {
      runId: "run_b",
      toolUseId: "tu_b",
      rootDir,
    });
    expect(out.persisted).toBe(false);
    expect(out.unsaved).toContain("is taken");
    expect(existsSync(join(dir, `tu_b.${MAX_NAME_ATTEMPTS + 1}.txt`))).toBe(false);
  }, 20_000);
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
