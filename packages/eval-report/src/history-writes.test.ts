/**
 * 0.7.1 — the history files are written only as regular files at their own
 * names (security-7#0, flag-truth-4#3).
 *
 * `setBaseline` used to read and `writeFileSync` `<evalsDir>/baselines.json`,
 * and `appendRunIndex` to `appendFileSync` `<evalsDir>/index.jsonl`, both of
 * which follow a symbolic link — a dangling one included, which CREATES its
 * target. A cloned repository can commit such a link, so a routine re-pin by
 * `crewhaus eval`, Hangar or the EvalBaselinePin tool wrote wherever it
 * pointed. Every case below asserts the OUTSIDE file (its bytes, or its
 * absence) after the call, never only that something threw.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINES_FILENAME,
  type BaselineEntry,
  HistoryWriteError,
  INDEX_FILENAME,
  type RunIndexEntry,
  appendRunIndex,
  baselineKey,
  clearBaseline,
  latestRunIndexEntries,
  lookupBaseline,
  parseBaselines,
  parseRunIndex,
  readBaselines,
  readRunIndex,
  readRunIndexLatest,
  setBaseline,
} from "./history";
import { jsonSyntaxProblem } from "./json-problem";

const ROOTS: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function pin(runId: string, overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    specName: "concierge",
    datasetName: "smoke",
    runId,
    outDir: `/abs/evals/${runId}`,
    datasetHash: "d".repeat(64),
    ts: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function entry(runId: string, overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId,
    specName: "concierge",
    specHash: "abc123",
    datasetName: "smoke",
    datasetHash: "d".repeat(64),
    passRate: 0.8,
    meanScore: 0.75,
    sampleCount: 5,
    ts: "2026-07-01T00:00:00.000Z",
    outDir: `/abs/evals/${runId}`,
    ...overrides,
  };
}

/** An evals dir and a sibling directory standing for "anywhere else". */
function layout(): { evalsDir: string; outside: string } {
  const root = tmp("crewhaus-history-writes-");
  const evalsDir = join(root, "ws", ".crewhaus", "evals");
  mkdirSync(evalsDir, { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { evalsDir, outside };
}

function refusal(fn: () => unknown): HistoryWriteError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HistoryWriteError) return err;
    throw err;
  }
  throw new Error("expected a HistoryWriteError, and the call returned");
}

describe("setBaseline / clearBaseline never write through a link", () => {
  test("a DANGLING baselines.json link does not create its target", () => {
    const { evalsDir, outside } = layout();
    const target = join(outside, "created.json");
    symlinkSync(target, join(evalsDir, BASELINES_FILENAME));
    const err = refusal(() => setBaseline(pin("run_a"), evalsDir));
    expect(err.refusal).toBe("is-symlink");
    expect(err.file).toBe(BASELINES_FILENAME);
    expect(existsSync(target)).toBe(false);
    // The link is left as it was, not replaced behind the operator's back.
    expect(readlinkSync(join(evalsDir, BASELINES_FILENAME))).toBe(target);
    // The message names the file, never where the link leads.
    expect(err.message).not.toContain(outside);
  });

  test("a link to an existing JSON object is neither merged into nor rewritten", () => {
    const { evalsDir, outside } = layout();
    const target = join(outside, "settings.json");
    const before = '{"editor.fontSize": 14}';
    writeFileSync(target, before);
    symlinkSync(target, join(evalsDir, BASELINES_FILENAME));
    expect(refusal(() => setBaseline(pin("run_a"), evalsDir)).refusal).toBe("is-symlink");
    expect(refusal(() => clearBaseline(baselineKey("editor", "x"), evalsDir)).refusal).toBe(
      "is-symlink",
    );
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("a link to a token file is refused before it is read, so no parse error quotes it", () => {
    const { evalsDir, outside } = layout();
    const token = ["gh", "p_", "LEAKTEST".repeat(4)].join("");
    const target = join(outside, "token");
    writeFileSync(target, `${token}\n`);
    symlinkSync(target, join(evalsDir, BASELINES_FILENAME));
    const err = refusal(() => setBaseline(pin("run_a"), evalsDir));
    expect(err.message).not.toContain(token);
    expect(readFileSync(target, "utf8")).toBe(`${token}\n`);
  });

  // In a child process: a regression here BLOCKS (a synchronous open of a
  // FIFO waits for a writer), and a blocked test would take the whole suite
  // with it instead of failing.
  test.skipIf(process.platform === "win32")(
    "a FIFO at baselines.json is refused without being opened",
    async () => {
      const { evalsDir } = layout();
      const fifo = join(evalsDir, BASELINES_FILENAME);
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const script = `
        const { setBaseline, HistoryWriteError } = await import(${JSON.stringify(join(import.meta.dir, "history.ts"))});
        try { setBaseline(${JSON.stringify(pin("run_a"))}, ${JSON.stringify(evalsDir)}); console.log("wrote"); }
        catch (err) { console.log(err instanceof HistoryWriteError ? err.refusal : "other: " + err.message); }
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const out = await new Response(child.stdout).text();
      clearTimeout(killer);
      expect({ exit: await child.exited, out: out.trim() }).toEqual({
        exit: 0,
        out: "not-regular-file",
      });
      expect(lstatSync(fifo).isFIFO()).toBe(true);
    },
    20_000,
  );

  test("a plain file still round-trips byte for byte, and no temp is left behind", () => {
    const { evalsDir } = layout();
    setBaseline(pin("run_a"), evalsDir);
    setBaseline(pin("run_b", { datasetName: "full" }), evalsDir);
    const expected = {
      [baselineKey("concierge", "smoke")]: pin("run_a"),
      [baselineKey("concierge", "full")]: pin("run_b", { datasetName: "full" }),
    };
    expect(readFileSync(join(evalsDir, BASELINES_FILENAME), "utf8")).toBe(
      `${JSON.stringify(expected, null, 2)}\n`,
    );
    expect(clearBaseline(baselineKey("concierge", "smoke"), evalsDir)).toBe(true);
    expect(clearBaseline(baselineKey("concierge", "smoke"), evalsDir)).toBe(false);
    expect(readBaselines(evalsDir)).toEqual({
      [baselineKey("concierge", "full")]: pin("run_b", { datasetName: "full" }),
    });
    expect(readdirSync(evalsDir)).toEqual([BASELINES_FILENAME]);
  });

  test("a baselines.json that is not a JSON object is not written over", () => {
    const { evalsDir } = layout();
    writeFileSync(join(evalsDir, BASELINES_FILENAME), "[]");
    expect(() => setBaseline(pin("run_a"), evalsDir)).toThrow(/not a JSON object/);
    expect(readFileSync(join(evalsDir, BASELINES_FILENAME), "utf8")).toBe("[]");
  });
});

describe("appendRunIndex never appends through a link", () => {
  test("a dangling index.jsonl link is refused and its target never created", () => {
    const { evalsDir, outside } = layout();
    const target = join(outside, "log.jsonl");
    symlinkSync(target, join(evalsDir, INDEX_FILENAME));
    expect(refusal(() => appendRunIndex(entry("run_a"), evalsDir)).refusal).toBe("is-symlink");
    expect(existsSync(target)).toBe(false);
  });

  test("a link to an existing outside file is not appended to", () => {
    const { evalsDir, outside } = layout();
    const target = join(outside, "profile");
    writeFileSync(target, "export A=1\n");
    symlinkSync(target, join(evalsDir, INDEX_FILENAME));
    expect(refusal(() => appendRunIndex(entry("run_a"), evalsDir)).refusal).toBe("is-symlink");
    expect(readFileSync(target, "utf8")).toBe("export A=1\n");
  });

  test("a plain index still appends one line per run, creating the directory", () => {
    const evalsDir = join(tmp("crewhaus-history-writes-"), "fresh", "evals");
    appendRunIndex(entry("run_a"), evalsDir);
    appendRunIndex(entry("run_b"), evalsDir);
    expect(readFileSync(join(evalsDir, INDEX_FILENAME), "utf8")).toBe(
      `${JSON.stringify(entry("run_a"))}\n${JSON.stringify(entry("run_b"))}\n`,
    );
  });
});

describe("a .crewhaus or .crewhaus/evals directory link does not take the write out of the workspace", () => {
  // The first 0.7.1 cut contained only the LEAF: the evals directory was the
  // containment root, realpathed first, so a committed `.crewhaus ->
  // /anywhere` link took `crewhaus eval`'s index append and first-run pin
  // there. The workspace above `.crewhaus` is the root now.
  function workspace(): { ws: string; outside: string } {
    const root = tmp("crewhaus-history-dirlink-");
    const ws = join(root, "ws");
    const outside = join(root, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
    return { ws, outside };
  }

  test("a .crewhaus link out: no append, no pin, nothing created where it leads", () => {
    const { ws, outside } = workspace();
    symlinkSync(outside, join(ws, ".crewhaus"));
    const evalsDir = join(ws, ".crewhaus", "evals");
    const refusals = [
      refusal(() => appendRunIndex(entry("run_a"), evalsDir)),
      refusal(() => setBaseline(pin("run_a"), evalsDir)),
    ];
    expect(refusals.map((e) => [e.file, e.refusal])).toEqual([
      [INDEX_FILENAME, "escapes-root"],
      [BASELINES_FILENAME, "escapes-root"],
    ]);
    // No evals directory where the link leads: nothing to clear, nothing made.
    expect(clearBaseline(baselineKey("concierge", "smoke"), evalsDir)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    for (const err of refusals) expect(err.message).not.toContain(outside);
    // And a pin file already there is neither read into a rewrite nor changed.
    mkdirSync(join(outside, "evals"));
    const there = `${JSON.stringify({ [baselineKey("concierge", "smoke")]: pin("run_z") })}\n`;
    writeFileSync(join(outside, "evals", BASELINES_FILENAME), there);
    expect(refusal(() => clearBaseline(baselineKey("concierge", "smoke"), evalsDir)).refusal).toBe(
      "escapes-root",
    );
    expect(refusal(() => setBaseline(pin("run_a"), evalsDir)).refusal).toBe("escapes-root");
    expect(readFileSync(join(outside, "evals", BASELINES_FILENAME), "utf8")).toBe(there);
    expect(readdirSync(join(outside, "evals"))).toEqual([BASELINES_FILENAME]);
  });

  test("the default relative evals dir is contained in the cwd", () => {
    const { ws, outside } = workspace();
    symlinkSync(outside, join(ws, ".crewhaus"));
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      expect(refusal(() => appendRunIndex(entry("run_a"))).refusal).toBe("escapes-root");
      expect(refusal(() => setBaseline(pin("run_a"))).refusal).toBe("escapes-root");
    } finally {
      process.chdir(cwd);
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a .crewhaus/evals link out is refused the same way", () => {
    const { ws, outside } = workspace();
    mkdirSync(join(ws, ".crewhaus"));
    symlinkSync(outside, join(ws, ".crewhaus", "evals"));
    const evalsDir = join(ws, ".crewhaus", "evals");
    expect(refusal(() => appendRunIndex(entry("run_a"), evalsDir)).refusal).toBe("escapes-root");
    expect(refusal(() => setBaseline(pin("run_a"), evalsDir)).refusal).toBe("escapes-root");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a link that stays inside the workspace is followed, and a fresh workspace is created", () => {
    const { ws } = workspace();
    mkdirSync(join(ws, "history"));
    symlinkSync(join(ws, "history"), join(ws, ".crewhaus"));
    appendRunIndex(entry("run_a"), join(ws, ".crewhaus", "evals"));
    setBaseline(pin("run_a"), join(ws, ".crewhaus", "evals"));
    expect(readdirSync(join(ws, "history", "evals")).sort()).toEqual([
      BASELINES_FILENAME,
      INDEX_FILENAME,
    ]);
    // First use in a workspace with no .crewhaus yet: the whole path is made.
    const fresh = workspace().ws;
    setBaseline(pin("run_b"), join(fresh, ".crewhaus", "evals"));
    expect(
      readBaselines(join(fresh, ".crewhaus", "evals"))[baselineKey("concierge", "smoke")]?.runId,
    ).toBe("run_b");
  });
});

describe("the text-level readers agree with the path readers", () => {
  test("parseRunIndex + latestRunIndexEntries = readRunIndex / readRunIndexLatest", () => {
    const { evalsDir } = layout();
    appendRunIndex(entry("run_a", { passRate: 0.2 }), evalsDir);
    appendRunIndex(entry("run_b"), evalsDir);
    appendRunIndex(entry("run_a", { passRate: 1, ts: "2026-07-02T00:00:00.000Z" }), evalsDir);
    const text = `${readFileSync(join(evalsDir, INDEX_FILENAME), "utf8")}{torn\nnull\n`;
    writeFileSync(join(evalsDir, INDEX_FILENAME), text);
    expect(parseRunIndex(text)).toEqual(readRunIndex(evalsDir));
    expect(latestRunIndexEntries(parseRunIndex(text))).toEqual(readRunIndexLatest(evalsDir));
    expect(readRunIndexLatest(evalsDir).map((e) => [e.runId, e.passRate])).toEqual([
      ["run_b", 0.8],
      ["run_a", 1],
    ]);
  });

  test("parseBaselines accepts only a JSON object, and lookupBaseline reads it", () => {
    for (const bad of ["{ nope", "[]", "null", "3", '"x"']) {
      expect(parseBaselines(bad)).toBeUndefined();
    }
    const map = { [baselineKey("concierge", "smoke")]: pin("run_a") };
    const parsed = parseBaselines(JSON.stringify(map));
    expect(parsed).toEqual(map);
    expect(
      lookupBaseline(parsed ?? {}, { specName: "concierge", datasetName: "smoke" }).entry?.runId,
    ).toBe("run_a");
  });
});

describe("a baselines.json that does not parse is named with the parser's words, not its text", () => {
  test("a token in the file is not quoted; what is wrong with it is", () => {
    const { evalsDir } = layout();
    const token = ["gh", "p_", "LEAKTEST".repeat(4)].join("");
    writeFileSync(join(evalsDir, BASELINES_FILENAME), `${token}\n`);
    let message = "";
    try {
      setBaseline(pin("run_a"), evalsDir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("baselines.json is not valid JSON (Unexpected identifier)");
    expect(message).not.toContain(token);
    expect(readFileSync(join(evalsDir, BASELINES_FILENAME), "utf8")).toBe(`${token}\n`);
  });

  test("jsonSyntaxProblem keeps the parser's words and drops everything it quotes", () => {
    const problem = (text: string): string => {
      try {
        JSON.parse(text);
      } catch (err) {
        return jsonSyntaxProblem(err);
      }
      return "parsed";
    };
    expect(["", '{"a": 1', '{"a": 1,}', "secretword", "{'a':1}"].map(problem)).toEqual([
      "Unexpected EOF",
      "Expected '}'",
      "Property name must be a string literal",
      "Unexpected identifier",
      "Single quotes (') are not allowed in JSON",
    ]);
    // A V8-shaped message: the quoted slice of the input goes.
    expect(
      jsonSyntaxProblem(new SyntaxError(`Unexpected token 's', "secretword" is not valid JSON`)),
    ).toBe("Unexpected token 's'");
    expect(jsonSyntaxProblem("not an error")).toBe("a syntax error");
  });
});
