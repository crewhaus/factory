/**
 * 0.7.1 — the files NAMED UNDER a contained directory are contained too
 * (security-7#0, flag-truth-4#3, security-7#12).
 *
 * Only the evals directory used to go through the resolver. `baselines.json`,
 * `index.jsonl` and a run's `results.json` were joined onto its real path and
 * opened, which follows a symbolic link planted at that name: a committed
 * EvalBaselinePin `set` CREATED a file anywhere the user could write (through
 * a dangling link) or merged a key into any JSON object file; EvalHistory
 * stat'ed and line-counted an outside file; EvalAggregate quoted an outside
 * file's first token in its parse error. Every case asserts the outside file
 * — its bytes or its absence — and the absence of its contents in the result,
 * not only that the call failed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EVALS_DIR, makeWorkspace, row, sample, writeIndex, writeRun } from "./fixtures";
import { evalAggregate, evalBaselinePin, evalHistory } from "./index";

type Json = Record<string, unknown>;

let root: string;
let outside: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  root = makeWorkspace();
  outside = makeWorkspace();
  process.chdir(root);
  writeRun(root, "r1", { samples: [sample({ sampleId: "a" })] });
  writeIndex(root, [row({ runId: "r1", ts: "2026-01-01T00:00:00Z" })]);
});
afterEach(() => {
  process.chdir(previousCwd);
});

async function call(tool: { execute: (i: unknown) => Promise<unknown> }, input: Json) {
  const raw = String(await tool.execute(input));
  return { raw, out: JSON.parse(raw) as Json };
}

const baselinesPath = (): string => join(root, EVALS_DIR, "baselines.json");
const SET = { action: "set", spec: "shop", dataset: "smoke", runId: "r1" } as const;
/** A token-shaped sentinel, built at run time so no literal trips push protection. */
const TOKEN = ["gh", "p_", "LEAKTEST".repeat(4)].join("");

describe("EvalBaselinePin writes only a regular baselines.json", () => {
  test("a DANGLING link leading out: set and its dryRun refuse, and nothing is created", async () => {
    const target = join(outside, "created.json");
    symlinkSync(target, baselinesPath());
    for (const input of [SET, { ...SET, dryRun: true }]) {
      const { out, raw } = await call(evalBaselinePin, input);
      expect(out["ok"]).toBe(false);
      expect(out["code"]).toBe("refused");
      expect(String(out["error"])).toMatch(/outside the workspace root/);
      expect(raw).not.toContain(outside);
    }
    expect(existsSync(target)).toBe(false);
    expect(readlinkSync(baselinesPath())).toBe(target);
  });

  test("a link to an outside JSON object: set and clear refuse, its bytes are untouched", async () => {
    const target = join(outside, "settings.json");
    writeFileSync(target, '{"editor.fontSize": 14}');
    symlinkSync(target, baselinesPath());
    for (const input of [SET, { ...SET, action: "clear" }, { ...SET, dryRun: true }]) {
      const { out } = await call(evalBaselinePin, input);
      expect(out["code"]).toBe("refused");
      expect(readFileSync(target, "utf8")).toBe('{"editor.fontSize": 14}');
    }
  });

  test("a link to an outside token file: show and EvalHistory never quote it", async () => {
    const target = join(outside, "token");
    writeFileSync(target, `${TOKEN}\n`);
    symlinkSync(target, baselinesPath());
    const shown = await call(evalBaselinePin, { ...SET, action: "show" });
    expect(shown.out["code"]).toBe("refused");
    expect(shown.raw).not.toContain(TOKEN);
    const history = await call(evalHistory, {});
    // The history still lists its runs; the pins are named as unreadable, and why.
    expect(history.out["runsRead"]).toBe(1);
    expect(String(history.out["baselinesUnreadable"])).toMatch(/outside the workspace root/);
    expect(history.raw).not.toContain(TOKEN);
  });

  test("an in-workspace link is READ through, but a pin is never WRITTEN through it", async () => {
    const shared = join(root, "shared-pins.json");
    writeFileSync(shared, "{}\n");
    symlinkSync(shared, baselinesPath());
    const shown = await call(evalBaselinePin, { ...SET, action: "show" });
    expect(shown.out["ok"]).toBe(true);
    for (const input of [SET, { ...SET, dryRun: true }]) {
      const { out } = await call(evalBaselinePin, input);
      expect(out["code"]).toBe("refused");
      expect(String(out["error"])).toMatch(/is a symbolic link .* never through a link/);
    }
    expect(readFileSync(shared, "utf8")).toBe("{}\n");
    expect(lstatSync(baselinesPath()).isSymbolicLink()).toBe(true);
  });

  test("a dangling link that stays inside is not read as 'no pins yet'", async () => {
    symlinkSync(join(root, "nowhere.json"), baselinesPath());
    const { out } = await call(evalBaselinePin, SET);
    expect(out["code"]).toBe("refused");
    expect(existsSync(join(root, "nowhere.json"))).toBe(false);
  });

  test("a plain set still writes the two-space file with a newline, and leaves no temp", async () => {
    const { out } = await call(evalBaselinePin, SET);
    expect(out["committed"]).toBe(true);
    const text = readFileSync(baselinesPath(), "utf8");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(Object.keys(JSON.parse(text))).toEqual(["shop::smoke"]);
    expect(readdirSync(join(root, EVALS_DIR)).sort()).toEqual([
      "baselines.json",
      "index.jsonl",
      "r1",
    ]);
    const cleared = await call(evalBaselinePin, { ...SET, action: "clear" });
    expect(cleared.out["committed"]).toBe(true);
    expect(readFileSync(baselinesPath(), "utf8")).toBe("{}\n");
  });

  test("a run whose results.json links out of the workspace is not pinned", async () => {
    const target = join(outside, "results.json");
    writeFileSync(target, JSON.stringify({ samples: [] }));
    const runDir = join(root, EVALS_DIR, "r2");
    mkdirSync(runDir, { recursive: true });
    symlinkSync(target, join(runDir, "results.json"));
    writeIndex(root, [row({ runId: "r2", ts: "2026-01-02T00:00:00Z" })]);
    const { out } = await call(evalBaselinePin, { ...SET, runId: "r2" });
    expect(out["code"]).toBe("refused");
    expect(existsSync(baselinesPath())).toBe(false);
  });
});

describe("the read side follows no link out of the workspace", () => {
  test("EvalHistory refuses an index.jsonl linked out, and reports none of its lines", async () => {
    const target = join(outside, "big.log");
    writeFileSync(target, "a\nb\nc\n");
    const dir = join(root, "ev2");
    mkdirSync(dir);
    symlinkSync(target, join(dir, "index.jsonl"));
    const { out } = await call(evalHistory, { evalsDir: "ev2" });
    expect(out["ok"]).toBe(false);
    expect(out["code"]).toBe("refused");
    expect(out["unparsedLines"]).toBeUndefined();
  });

  test("EvalAggregate refuses a run directory whose results.json links out, quoting nothing", async () => {
    const target = join(outside, "secret.txt");
    writeFileSync(target, `root:x:${TOKEN}\n`);
    const runDir = join(root, "runs", "r2");
    mkdirSync(runDir, { recursive: true });
    symlinkSync(target, join(runDir, "results.json"));
    const { out, raw } = await call(evalAggregate, { run: "runs/r2" });
    expect(out["code"]).toBe("refused");
    expect(raw).not.toContain("root:x");
    expect(raw).not.toContain(TOKEN);
  });

  test("a malformed results.json inside the workspace is named, without quoting it", async () => {
    const runDir = join(root, "runs", "r3");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "results.json"), `${TOKEN} not json`);
    const { out, raw } = await call(evalAggregate, { run: "runs/r3" });
    expect(out["code"]).toBe("malformed");
    expect(String(out["error"])).toMatch(
      /runs\/r3\/results\.json" is not valid JSON \(Unexpected identifier\)$/,
    );
    expect(raw).not.toContain(TOKEN);
    // A truncated file says what the parser saw, as 0.7.0 did.
    writeFileSync(join(runDir, "results.json"), '{"samples": [');
    const truncated = await call(evalAggregate, { run: "runs/r3" });
    expect(String(truncated.out["error"])).toMatch(/is not valid JSON \(Unexpected EOF\)$/);
  });

  // In a child process: a regression here BLOCKS on the FIFO, and a blocked
  // test would hang the suite instead of failing.
  test.skipIf(process.platform === "win32")(
    "a FIFO at index.jsonl is refused without being opened",
    async () => {
      const fifo = join(root, EVALS_DIR, "index.jsonl");
      require("node:fs").rmSync(fifo);
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const script = `
        process.chdir(${JSON.stringify(root)});
        const { evalHistory } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        console.log(await evalHistory.execute({}));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const text = await new Response(child.stdout).text();
      clearTimeout(killer);
      expect(await child.exited).toBe(0);
      const out = JSON.parse(text) as Json;
      expect(out["code"]).toBe("not-a-file");
      expect(String(out["error"])).toMatch(/fifo/);
    },
    20_000,
  );
});
