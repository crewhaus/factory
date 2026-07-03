/**
 * CLI integration tests for the item-12 surface: `crewhaus datasets
 * list|get|put` and `crewhaus distill --register`.
 *
 * Follows eval.test.ts's posture: stdout assertions are avoided (Bun 1.3.x
 * spawn-pipe capture is unreliable under `bun test`) — assert on exit codes
 * and on-disk registry state instead. No model/credentials needed anywhere
 * in this file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatasetRecord } from "@crewhaus/dataset-registry";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-datasets-cli-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

function writeDatasetFile(dir: string, n: number, name = "dataset.jsonl"): string {
  const path = join(dir, name);
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({ id: `s${i}`, input: `question ${i}`, expected_output: `answer ${i}` }),
  );
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function readRecord(root: string, name: string, version: string): DatasetRecord {
  return JSON.parse(
    readFileSync(join(root, ".crewhaus", "datasets", name, `${version}.json`), "utf-8"),
  ) as DatasetRecord;
}

describe("crewhaus datasets CLI (item 12)", () => {
  test("datasets --help exits 0; unknown action exits 1", async () => {
    const root = newTempRoot();
    expect((await runCli(["datasets", "--help"], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "bogus"], root)).exitCode).toBe(1);
  });

  test("put imports a JSONL file as v1 with the deterministic 70/15/15 split", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 10);
    const result = await runCli(["datasets", "put", "support", "--file", file], root);
    expect(result.exitCode).toBe(0);
    const rec = readRecord(root, "support", "v1");
    expect(rec.name).toBe("support");
    expect(rec.version).toBe("v1");
    expect(rec.splits.train).toHaveLength(7);
    expect(rec.splits.dev).toHaveLength(1);
    expect(rec.splits.test).toHaveLength(2);
    expect(rec.sampleHashes.train).toHaveLength(7);
    expect(rec.createdAt).toBeDefined();
  });

  test("a second put auto-bumps to v2; both versions remain on disk", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 4);
    expect((await runCli(["datasets", "put", "d", "--file", file], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "put", "d", "--file", file], root)).exitCode).toBe(0);
    expect(existsSync(join(root, ".crewhaus", "datasets", "d", "v1.json"))).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "datasets", "d", "v2.json"))).toBe(true);
    // Same file → same deterministic assignment in both versions.
    const v1 = readRecord(root, "d", "v1");
    const v2 = readRecord(root, "d", "v2");
    expect(v2.splits.train.map((s) => s.id)).toEqual(v1.splits.train.map((s) => s.id));
  });

  test("put --split train lands every sample in train; --split-spec overrides", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 6);
    expect(
      (await runCli(["datasets", "put", "one-split", "--file", file, "--split", "train"], root))
        .exitCode,
    ).toBe(0);
    const rec = readRecord(root, "one-split", "v1");
    expect(rec.splits.train).toHaveLength(6);
    expect(rec.splits.dev).toHaveLength(0);
    expect(rec.splits.test).toBeUndefined();

    expect(
      (
        await runCli(
          ["datasets", "put", "spec-split", "--file", file, "--split-spec", "50/50"],
          root,
        )
      ).exitCode,
    ).toBe(0);
    const rec2 = readRecord(root, "spec-split", "v1");
    expect(rec2.splits.train).toHaveLength(3);
    expect(rec2.splits.dev).toHaveLength(3);
    expect(rec2.splits.test).toBeUndefined();
  });

  test("put rejects --split with --split-spec, a bad spec, a bad split, and a missing file", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 4);
    const bad = [
      ["datasets", "put", "x", "--file", file, "--split", "train", "--split-spec", "70/30"],
      ["datasets", "put", "x", "--file", file, "--split-spec", "70/40"],
      ["datasets", "put", "x", "--file", file, "--split", "validation"],
      ["datasets", "put", "x", "--file", join(root, "nope.jsonl")],
      ["datasets", "put", "x"],
      ["datasets", "put"],
    ];
    for (const args of bad) {
      expect((await runCli(args, root)).exitCode).toBe(1);
    }
    expect(existsSync(join(root, ".crewhaus", "datasets", "x"))).toBe(false);
  });

  test("CREWHAUS_DATASETS_DIR overrides the registry root", async () => {
    const root = newTempRoot();
    const custom = join(root, "custom-registry");
    const file = writeDatasetFile(root, 4);
    const result = await runCli(["datasets", "put", "env-ds", "--file", file], root, {
      CREWHAUS_DATASETS_DIR: custom,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(custom, "env-ds", "v1.json"))).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "datasets", "env-ds"))).toBe(false);
  });

  test("list exits 0 with and without registered datasets", async () => {
    const root = newTempRoot();
    expect((await runCli(["datasets", "list"], root)).exitCode).toBe(0);
    const file = writeDatasetFile(root, 4);
    await runCli(["datasets", "put", "listed", "--file", file], root);
    expect((await runCli(["datasets", "list"], root)).exitCode).toBe(0);
  });

  // This test does 6 sequential CLI cold-starts; under CI contention the
  // default 5000ms/test budget is too tight (narrower still with this
  // branch's +3 import deps), so it gets extra headroom (15000ms, 3rd arg).
  test("get resolves the latest version / an explicit split; failures exit 1", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 10);
    await runCli(["datasets", "put", "g", "--file", file], root);
    expect((await runCli(["datasets", "get", "g"], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "get", "g@v1", "--split", "train"], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "get", "g@v9"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "get", "ghost"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "get", "g", "--split", "validation"], root)).exitCode).toBe(
      1,
    );
    expect((await runCli(["datasets", "get"], root)).exitCode).toBe(1);
  }, 15000);
});

describe("crewhaus distill --register (item 12)", () => {
  const SESSION = "sess_0123456789abcdef";

  /** A minimal transcript: two rated user turns → two distillable samples. */
  function writeSession(root: string): void {
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const fb = (n: number) => ({
      kind: "user_feedback",
      payload: {
        schemaVersion: 1,
        id: `fb_${n}`,
        sessionId: SESSION,
        turnNumber: n,
        modality: "binary",
        rating: { thumbs: "up" },
        source: "cli",
        ts: `2026-07-01T00:00:0${n}.000Z`,
      },
    });
    const lines = [
      { kind: "user_message", payload: { content: "what is 2+2?" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "4" }] } },
      { kind: "user_message", payload: { content: "and 3+3?" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "6" }] } },
      fb(1),
      fb(2),
    ];
    writeFileSync(
      join(sessionsDir, `${SESSION}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  }

  test("--register without -o promotes a v1 into the registry (no file output)", async () => {
    const root = newTempRoot();
    writeSession(root);
    const result = await runCli(["distill", "--session", SESSION, "--register", "golden"], root);
    expect(result.exitCode).toBe(0);
    const rec = readRecord(root, "golden", "v1");
    const total = rec.splits.train.length + rec.splits.dev.length + (rec.splits.test?.length ?? 0);
    expect(total).toBe(2);
    // Every distilled turn was positively rated → gold expected_output.
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    expect(all.map((s) => s.id).sort()).toEqual([`${SESSION}_t1`, `${SESSION}_t2`]);
    expect(existsSync(join(root, "dataset.jsonl"))).toBe(false);
  });

  test("--register with -o keeps the plain file output AND promotes; re-run bumps to v2", async () => {
    const root = newTempRoot();
    writeSession(root);
    const out = join(root, "out", "ds.jsonl");
    const first = await runCli(
      ["distill", "--session", SESSION, "-o", out, "--register", "golden"],
      root,
    );
    expect(first.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "datasets", "golden", "v1.json"))).toBe(true);

    const second = await runCli(["distill", "--session", SESSION, "--register", "golden"], root);
    expect(second.exitCode).toBe(0);
    expect(existsSync(join(root, ".crewhaus", "datasets", "golden", "v2.json"))).toBe(true);
    // Deterministic: identical samples land in identical splits across versions.
    const v1 = readRecord(root, "golden", "v1");
    const v2 = readRecord(root, "golden", "v2");
    expect(v2.splits.train.map((s) => s.id)).toEqual(v1.splits.train.map((s) => s.id));
  });

  test("without --register and without -o it still dies cleanly", async () => {
    const root = newTempRoot();
    writeSession(root);
    expect((await runCli(["distill", "--session", SESSION], root)).exitCode).toBe(1);
  });

  test("an invalid --register name (path traversal) exits 1 and writes nothing", async () => {
    const root = newTempRoot();
    writeSession(root);
    const result = await runCli(["distill", "--session", SESSION, "--register", "../escape"], root);
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(root, ".crewhaus", "escape"))).toBe(false);
  });
});

describe("registry: shorthand resolution errors in eval + optimize (item 12)", () => {
  // Registry resolution runs BEFORE any model call in both subcommands, so
  // the failure paths are fully testable without credentials. The happy path
  // (a resolvable ref feeding a live run) needs a model and is covered by the
  // resolution unit tests in datasets.test.ts plus the credentialed smoke.
  function writeGraders(root: string): string {
    const path = join(root, "graders.yaml");
    writeFileSync(path, "graders:\n  - name: g\n    type: contains\n    substring: 'x'\n");
    return path;
  }

  test("eval exits 1 on an unknown registry dataset and on a malformed ref", async () => {
    const root = newTempRoot();
    const graders = writeGraders(root);
    for (const ref of ["registry:ghost", "registry:x#validation", "registry:"]) {
      const result = await runCli(
        ["eval", HELLO_SPEC, "--dataset", ref, "--graders", graders],
        root,
      );
      expect(result.exitCode).toBe(1);
    }
  });

  test("eval exits 1 when the ref names a split the record lacks", async () => {
    const root = newTempRoot();
    const graders = writeGraders(root);
    const file = writeDatasetFile(root, 4);
    await runCli(["datasets", "put", "no-test", "--file", file, "--split-spec", "70/30"], root);
    const result = await runCli(
      ["eval", HELLO_SPEC, "--dataset", "registry:no-test#test", "--graders", graders],
      root,
    );
    expect(result.exitCode).toBe(1);
  });

  test("optimize exits 1 on an unknown registry dataset and on a malformed ref", async () => {
    const root = newTempRoot();
    const graders = writeGraders(root);
    for (const ref of ["registry:ghost", "registry:x#validation"]) {
      const result = await runCli(
        ["optimize", HELLO_SPEC, "--dataset", ref, "--graders", graders],
        root,
      );
      expect(result.exitCode).toBe(1);
    }
  });
});
