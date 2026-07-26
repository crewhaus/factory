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

/** Variant capturing stderr for the B16 guard-message assertions. Reads the
 *  pipe CONCURRENTLY with the exit (the flywheel.test.ts pattern) — the
 *  Bun 1.3.x capture regression bites only read-after-exit stdout. */
async function runCliStderr(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
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

  // 6 sequential CLI cold-starts; needs headroom over the 5s default under CI contention.
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
  }, 15000);

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

  // B16 — `datasets get` keeps emitting test rows (inspection, not
  // consumption) but discloses it on stderr; test-free output stays silent.
  test("get notes emitted test-split rows on stderr; train-only output stays silent", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 10);
    await runCli(["datasets", "put", "g", "--file", file], root);
    const merged = await runCliStderr(["datasets", "get", "g"], root);
    expect(merged.exitCode).toBe(0);
    expect(merged.stderr).toContain("test-split row(s) emitted");
    const testOnly = await runCliStderr(["datasets", "get", "g", "--split", "test"], root);
    expect(testOnly.exitCode).toBe(0);
    expect(testOnly.stderr).toContain("test-split row(s) emitted");
    const trainOnly = await runCliStderr(["datasets", "get", "g", "--split", "train"], root);
    expect(trainOnly.exitCode).toBe(0);
    expect(trainOnly.stderr).not.toContain("test-split");
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

  // B23 — distilled sample text is PII/secret-redacted by default;
  // --no-redact restores the raw text for dev/local inspection.
  test("redacts distilled sample text by default; --no-redact keeps it raw (B23)", async () => {
    const ssn = ["219", "09", "9999"].join("-");
    const email = ["jane", "example.com"].join("@");
    const writeLeakySession = (root: string): void => {
      const sessionsDir = join(root, ".crewhaus", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const lines = [
        { kind: "user_message", payload: { content: `my ssn is ${ssn}, what next?` } },
        {
          kind: "assistant_message",
          payload: { content: [{ type: "text", text: `reach me at ${email}` }] },
        },
        {
          kind: "user_feedback",
          payload: {
            schemaVersion: 1,
            id: "fb_1",
            sessionId: SESSION,
            turnNumber: 1,
            modality: "binary",
            rating: { thumbs: "up" },
            comment: `handled ${ssn} well`,
            source: "cli",
            ts: "2026-07-01T00:00:01.000Z",
          },
        },
      ];
      writeFileSync(
        join(sessionsDir, `${SESSION}.jsonl`),
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      );
    };

    const redacted = newTempRoot();
    writeLeakySession(redacted);
    const out = join(redacted, "ds.jsonl");
    const run = await runCliStderr(["distill", "--session", SESSION, "-o", out], redacted);
    expect(run.exitCode).toBe(0);
    const redactedText = readFileSync(out, "utf-8");
    expect(redactedText).not.toContain(ssn);
    expect(redactedText).not.toContain(email);
    expect(redactedText).toContain("[REDACTED:ssn]");
    expect(redactedText).toContain("[REDACTED:email]");
    // The up-rated turn's GOLD ("reach me at <email>") was altered by
    // redaction — the instrument warning must say so (string-comparison
    // graders can never match live, unredacted output against it).
    expect(run.stderr).toContain("gold(s) contained redacted text");

    const raw = newTempRoot();
    writeLeakySession(raw);
    const rawOut = join(raw, "ds.jsonl");
    const rawRun = await runCliStderr(
      ["distill", "--session", SESSION, "-o", rawOut, "--no-redact"],
      raw,
    );
    expect(rawRun.exitCode).toBe(0);
    expect(rawRun.stderr).not.toContain("gold(s) contained redacted text");
    const rawText = readFileSync(rawOut, "utf-8");
    expect(rawText).toContain(ssn);
    expect(rawText).toContain(email);
  }, 15000);
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

  // B16 — an explicit #test needs the --allow-test-split opt-in on eval.
  test("eval refuses #test without --allow-test-split and unlocks with it", async () => {
    const root = newTempRoot();
    const graders = writeGraders(root);
    // The lock fires before the registry lookup — no dataset setup needed.
    const locked = await runCliStderr(
      ["eval", HELLO_SPEC, "--dataset", "registry:ghost#test", "--graders", graders],
      root,
    );
    expect(locked.exitCode).toBe(1);
    expect(locked.stderr).toContain("test split locked");
    expect(locked.stderr).toContain("--allow-test-split");
    // With the opt-in, the same ref reaches the ordinary versionless error —
    // proof the flag (and only the flag) disarmed the lock.
    const unlocked = await runCliStderr(
      [
        "eval",
        HELLO_SPEC,
        "--dataset",
        "registry:ghost#test",
        "--graders",
        graders,
        "--allow-test-split",
      ],
      root,
    );
    expect(unlocked.exitCode).toBe(1);
    expect(unlocked.stderr).toContain("no versions in the registry");
  }, 15000);

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

  // B16 — optimize refuses #test outright; there is no opt-in flag for it.
  test("optimize refuses an explicit #test ref with the release-gate explanation", async () => {
    const root = newTempRoot();
    const graders = writeGraders(root);
    const result = await runCliStderr(
      ["optimize", HELLO_SPEC, "--dataset", "registry:golden#test", "--graders", graders],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("optimize never runs over the test split");
  });

  // B16 — deploy canary is a release-gating flow (a sanctioned holdout
  // spender): #test is consumable there, behind the same opt-in as eval.
  test("deploy canary refuses #test without --allow-test-split and unlocks with it", async () => {
    const root = newTempRoot();
    const graders = writeGraders(root);
    const canaryArgs = (extra: string[]): string[] => [
      "deploy",
      "canary",
      HELLO_SPEC,
      "v2",
      "--from",
      "v1",
      "--dataset",
      "registry:ghost#test",
      "--graders",
      graders,
      ...extra,
    ];
    // The lock fires before the registry lookup — no dataset setup needed.
    const locked = await runCliStderr(canaryArgs([]), root);
    expect(locked.exitCode).toBe(1);
    expect(locked.stderr).toContain("test split locked");
    expect(locked.stderr).toContain("--allow-test-split");
    // With the opt-in, the same ref reaches the ordinary versionless error —
    // proof the flag (and only the flag) disarmed the lock.
    const unlocked = await runCliStderr(canaryArgs(["--allow-test-split"]), root);
    expect(unlocked.exitCode).toBe(1);
    expect(unlocked.stderr).toContain("no versions in the registry");
  }, 15000);
});

describe("crewhaus datasets verify (NEW-registry-1)", () => {
  test("an intact registry verifies clean; a tampered record exits 1", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 6);
    expect((await runCli(["datasets", "put", "ver", "--file", file], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "verify", "ver"], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "verify", "ver@v1"], root)).exitCode).toBe(0);
    // Hand-edit a sample — the recorded identity no longer matches content.
    const path = join(root, ".crewhaus", "datasets", "ver", "v1.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.splits.train[0].input = "TAMPERED";
    writeFileSync(path, JSON.stringify(raw));
    expect((await runCli(["datasets", "verify", "ver"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "verify", "ver@v1"], root)).exitCode).toBe(1);
  });

  test("missing name/version exit 1", async () => {
    const root = newTempRoot();
    expect((await runCli(["datasets", "verify"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "verify", "ghost"], root)).exitCode).toBe(1);
    const file = writeDatasetFile(root, 3);
    expect((await runCli(["datasets", "put", "ver2", "--file", file], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "verify", "ver2@v9"], root)).exitCode).toBe(1);
  });
});

describe("crewhaus datasets put --canary (B18)", () => {
  test("injects exactly one deterministic source:canary sample", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 9);
    expect(
      (await runCli(["datasets", "put", "cnry", "--file", file, "--canary"], root)).exitCode,
    ).toBe(0);
    const rec = readRecord(root, "cnry", "v1");
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    expect(all).toHaveLength(10);
    const canaries = all.filter(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.["source"] === "canary",
    );
    expect(canaries).toHaveLength(1);
    expect(canaries[0]?.input).toMatch(/CREWHAUS-CANARY [0-9a-f]{32}/);
    expect(canaries[0]?.expected_output).toBeUndefined();
    // The canary'd registry still verifies clean.
    expect((await runCli(["datasets", "verify", "cnry"], root)).exitCode).toBe(0);
  });
});

describe("crewhaus datasets status (B17)", () => {
  test("reports a run-less dataset (exit 0) and rejects bad --runs", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 6);
    expect((await runCli(["datasets", "put", "st", "--file", file], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "status", "st"], root)).exitCode).toBe(0);
    expect((await runCli(["datasets", "status", "st", "--runs", "0"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "status", "ghost"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "status"], root)).exitCode).toBe(1);
  });
});

describe("crewhaus datasets card (B21)", () => {
  test("-o writes the markdown datasheet without mutating the record", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 8);
    expect(
      (await runCli(["datasets", "put", "cardset", "--file", file, "--canary"], root)).exitCode,
    ).toBe(0);
    const before = readFileSync(join(root, ".crewhaus", "datasets", "cardset", "v1.json"), "utf-8");
    const out = join(root, "card.md");
    expect((await runCli(["datasets", "card", "cardset", "-o", out], root)).exitCode).toBe(0);
    const card = readFileSync(out, "utf-8");
    expect(card).toContain("# Dataset card — cardset@v1");
    expect(card).toContain("## Splits");
    expect(card).toContain("## Provenance");
    expect(card).toContain("| canary | 1 |");
    expect(card).toContain("Test split never released");
    expect(card).toContain("## Lint");
    const after = readFileSync(join(root, ".crewhaus", "datasets", "cardset", "v1.json"), "utf-8");
    expect(after).toBe(before);
    // Unknown dataset exits 1.
    expect((await runCli(["datasets", "card", "ghost"], root)).exitCode).toBe(1);
  });
});

describe("crewhaus datasets release (NEW-HUNT-9)", () => {
  const writeSpecAndGraders = (root: string): { spec: string; graders: string } => {
    const spec = join(root, "crewhaus.yaml");
    writeFileSync(
      spec,
      "name: rel-spec\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: test\n",
    );
    const graders = join(root, "graders.yaml");
    writeFileSync(graders, "graders:\n  - name: exact\n    type: exact_match\n");
    return { spec, graders };
  };

  test("refuses a version without a test split, before any eval", async () => {
    const root = newTempRoot();
    const { spec, graders } = writeSpecAndGraders(root);
    const file = writeDatasetFile(root, 4);
    // 80/20 split spec → no test key at all.
    expect(
      (await runCli(["datasets", "put", "no-test", "--file", file, "--split-spec", "80/20"], root))
        .exitCode,
    ).toBe(0);
    const result = await runCliStderr(
      ["datasets", "release", "no-test", "--spec", spec, "--graders", graders],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has no test split");
  });

  test("refuses a second release without --force (the holdout is spent)", async () => {
    const root = newTempRoot();
    const { spec, graders } = writeSpecAndGraders(root);
    const file = writeDatasetFile(root, 10);
    expect((await runCli(["datasets", "put", "burned", "--file", file], root)).exitCode).toBe(0);
    // Simulate a prior sanctioned release directly on the record.
    const path = join(root, ".crewhaus", "datasets", "burned", "v1.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.releases = [
      { version: "v1", runId: "run_prior", ts: "2026-07-24T00:00:00.000Z", passRate: 0.9 },
    ];
    writeFileSync(path, JSON.stringify(raw));
    const result = await runCliStderr(
      ["datasets", "release", "burned", "--spec", spec, "--graders", graders],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already released");
    expect(result.stderr).toContain("--force");
    // The record's release history is untouched by the refusal.
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.releases).toHaveLength(1);
  });

  test("missing --spec/--graders/name exit 1", async () => {
    const root = newTempRoot();
    expect((await runCli(["datasets", "release"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "release", "x"], root)).exitCode).toBe(1);
    expect((await runCli(["datasets", "release", "x", "--spec", "spec.yaml"], root)).exitCode).toBe(
      1,
    );
  });
});

describe("crewhaus dataset lint CLI (B26)", () => {
  test("reports findings; --strict exits 1, plain lint exits 0", async () => {
    const root = newTempRoot();
    const bad = join(root, "bad.jsonl");
    writeFileSync(
      bad,
      [
        JSON.stringify({ id: "dup", input: "same question" }),
        JSON.stringify({ id: "dup", input: "same question again" }),
        JSON.stringify({ id: "empty-gold", input: "q", expected_output: "" }),
      ].join("\n"),
    );
    expect((await runCli(["dataset", "lint", "--dataset", bad], root)).exitCode).toBe(0);
    const strict = await runCliStderr(["dataset", "lint", "--dataset", bad, "--strict"], root);
    expect(strict.exitCode).toBe(1);
    expect(strict.stderr).toContain("finding(s)");
  });

  test("a clean registry dataset lints clean under --strict; --all sweeps", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 5);
    expect((await runCli(["datasets", "put", "clean", "--file", file], root)).exitCode).toBe(0);
    expect(
      (await runCli(["dataset", "lint", "--dataset", "registry:clean", "--strict"], root)).exitCode,
    ).toBe(0);
    expect((await runCli(["dataset", "lint", "--all", "--strict"], root)).exitCode).toBe(0);
    // Exactly one of --dataset/--all is required.
    expect((await runCli(["dataset", "lint"], root)).exitCode).toBe(1);
    expect((await runCli(["dataset", "lint", "--dataset", file, "--all"], root)).exitCode).toBe(1);
  });

  test("detects a canary leak into the cwd spec (contamination)", async () => {
    const root = newTempRoot();
    const file = writeDatasetFile(root, 5);
    expect(
      (await runCli(["datasets", "put", "leaky", "--file", file, "--canary"], root)).exitCode,
    ).toBe(0);
    const rec = readRecord(root, "leaky", "v1");
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    const canary = all.find(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.["source"] === "canary",
    );
    const phrase = /[0-9a-f]{32}/.exec(canary?.input ?? "")?.[0] as string;
    // Leak the phrase into the conventional spec.
    writeFileSync(
      join(root, "crewhaus.yaml"),
      `name: leaked\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: say ${phrase}\n`,
    );
    const result = await runCliStderr(
      ["dataset", "lint", "--dataset", "registry:leaky", "--strict"],
      root,
    );
    expect(result.exitCode).toBe(1);
  });
});

describe("crewhaus eval preflight (NEW-HUNT-10)", () => {
  test("duplicate ids refuse before any model spend (no out dir, no credentials needed)", async () => {
    const root = newTempRoot();
    const dataset = join(root, "dup.jsonl");
    writeFileSync(
      dataset,
      [
        JSON.stringify({ id: "q1", input: "a", expected_output: "a" }),
        JSON.stringify({ id: "q1", input: "b", expected_output: "b" }),
      ].join("\n"),
    );
    const graders = join(root, "graders.yaml");
    writeFileSync(graders, "graders:\n  - name: exact\n    type: exact_match\n");
    const out = join(root, "out");
    const result = await runCliStderr(
      ["eval", HELLO_SPEC, "--dataset", dataset, "--graders", graders, "-o", out],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("preflight refused");
    expect(result.stderr).toContain('duplicate sample id "q1"');
    expect(result.stderr).toContain("--no-preflight");
    expect(existsSync(out)).toBe(false);
  });

  test("--no-preflight skips the refusal (the run proceeds past the lint-lite)", async () => {
    const root = newTempRoot();
    const dataset = join(root, "dup.jsonl");
    writeFileSync(
      dataset,
      [
        JSON.stringify({ id: "q1", input: "a", expected_output: "a" }),
        JSON.stringify({ id: "q1", input: "b", expected_output: "b" }),
      ].join("\n"),
    );
    const graders = join(root, "graders.yaml");
    writeFileSync(graders, "graders:\n  - name: exact\n    type: exact_match\n");
    // `-o` points at an existing regular FILE: the runner's own out-dir
    // mkdir throws immediately — offline, deterministic, and strictly
    // AFTER the preflight point — so a non-"preflight refused" failure
    // here proves the escape hatch let the run proceed without any model
    // spend in this test.
    const outAsFile = join(root, "not-a-dir");
    writeFileSync(outAsFile, "occupied");
    const result = await runCliStderr(
      [
        "eval",
        HELLO_SPEC,
        "--dataset",
        dataset,
        "--graders",
        graders,
        "--no-preflight",
        "-o",
        outAsFile,
      ],
      root,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain("preflight refused");
  });

  test("gold-needing graders over an all-goldless dataset refuse pre-spend", async () => {
    const root = newTempRoot();
    const dataset = join(root, "goldless.jsonl");
    writeFileSync(
      dataset,
      [JSON.stringify({ id: "q1", input: "a" }), JSON.stringify({ id: "q2", input: "b" })].join(
        "\n",
      ),
    );
    const graders = join(root, "graders.yaml");
    writeFileSync(graders, "graders:\n  - name: exact\n    type: exact_match\n");
    const result = await runCliStderr(
      ["eval", HELLO_SPEC, "--dataset", dataset, "--graders", graders, "-o", join(root, "out")],
      root,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fail by construction");
  });
});
