import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAuditLog, verify } from "@crewhaus/audit-log";
import type { FeedbackRecord } from "./feedback";
import {
  type BackupManifest,
  MANIFEST_FILENAME,
  buildManifest,
  defaultBackupFileName,
  isBackupManifest,
  isExcluded,
  isSqliteHeader,
  parseExcludeGlobs,
  planAdditiveMerge,
  planFeedbackMerge,
  sanitizeBackupLabel,
  sqliteSidecarBase,
} from "./state-backup";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const SESSION_ID = "sess_00000000000000fe";

type RunResult = { exitCode: number; stdout: string; stderr: string };

/** Spawn the CLI as a child Bun process and capture exit code + streams. */
async function runCli(args: ReadonlyArray<string>, cwd: string): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** List a tarball's file entries (system tar, `./`-stripped, dirs dropped). */
async function tarEntries(archive: string): Promise<string[]> {
  const proc = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  return out
    .split("\n")
    .map((l) => l.replace(/^\.\//, ""))
    .filter((l) => l !== "" && !l.endsWith("/"));
}

/** Extract a tarball into a fresh dir and return the dir. */
async function extractTo(archive: string, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawn(["tar", "-xzf", archive, "-C", dir], { stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  return dir;
}

function readManifestFromArchiveDir(dir: string): BackupManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, MANIFEST_FILENAME), "utf-8"));
  expect(isBackupManifest(parsed)).toBe(true);
  return parsed as BackupManifest;
}

/** Seed a harness dir: a parseable spec + a one-turn session transcript. */
function seedHarness(dir: string, name = "backup-smoke"): void {
  mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: ${name}\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    be brief\n`,
  );
  const lines = [
    { ts: 1, version: 1, kind: "user_message", payload: { content: "hello" } },
    { ts: 2, version: 1, kind: "assistant_message", payload: { content: "world" } },
  ];
  writeFileSync(
    join(dir, ".crewhaus", "sessions", `${SESSION_ID}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: "fb_local",
    sessionId: SESSION_ID,
    turnNumber: 1,
    modality: "binary",
    rating: { thumbs: "up" },
    source: "cli",
    ts: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-state-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("default backup file name", () => {
  test("carries the sanitized label and the ISO date", () => {
    const d = new Date("2026-07-01T12:34:56.000Z");
    expect(defaultBackupFileName("my-bot", d)).toBe("crewhaus-state-my-bot-2026-07-01.tar.gz");
    expect(defaultBackupFileName("weird name!/x", d)).toBe(
      "crewhaus-state-weird-name-x-2026-07-01.tar.gz",
    );
  });

  test("sanitizeBackupLabel falls back to 'state' when nothing survives", () => {
    expect(sanitizeBackupLabel("///")).toBe("state");
    expect(sanitizeBackupLabel("ok_name.v2")).toBe("ok_name.v2");
  });
});

describe("exclude globs", () => {
  test("parseExcludeGlobs splits, trims, and drops empties", () => {
    expect(parseExcludeGlobs(undefined)).toEqual([]);
    expect(parseExcludeGlobs(" sessions , *.sqlite ,,")).toEqual(["sessions", "*.sqlite"]);
  });

  test("path globs match relative paths; bare patterns match any segment", () => {
    expect(isExcluded("sessions/a.jsonl", ["sessions/*.jsonl"])).toBe(true);
    expect(isExcluded("feedback/a.jsonl", ["sessions/*.jsonl"])).toBe(false);
    // bare basename pattern reaches nested files (tar --exclude ergonomics)
    expect(isExcluded("deep/nested/state.sqlite", ["*.sqlite"])).toBe(true);
    // a bare dir name drops the whole subdir
    expect(isExcluded("sessions/a.jsonl", ["sessions"])).toBe(true);
    expect(isExcluded("sessions/a.jsonl", [])).toBe(false);
  });
});

describe("sqlite detection", () => {
  test("isSqliteHeader matches the 16-byte magic only", () => {
    const magic = new Uint8Array(16);
    for (let i = 0; i < 15; i++) magic[i] = "SQLite format 3".charCodeAt(i);
    magic[15] = 0;
    expect(isSqliteHeader(magic)).toBe(true);
    expect(isSqliteHeader(magic.slice(0, 8))).toBe(false);
    expect(isSqliteHeader(new TextEncoder().encode("definitely not a db!"))).toBe(false);
  });

  test("sqliteSidecarBase resolves -wal/-shm/-journal to the main db", () => {
    expect(sqliteSidecarBase("a/state.sqlite-wal")).toBe("a/state.sqlite");
    expect(sqliteSidecarBase("a/state.sqlite-shm")).toBe("a/state.sqlite");
    expect(sqliteSidecarBase("a/state.sqlite-journal")).toBe("a/state.sqlite");
    expect(sqliteSidecarBase("a/state.sqlite")).toBeUndefined();
  });
});

describe("buildManifest", () => {
  test("groups counts + bytes per top-level subdir, root files under '.'", () => {
    const manifest = buildManifest(
      [
        { relPath: "sessions/a.jsonl", bytes: 10 },
        { relPath: "sessions/b.jsonl", bytes: 5 },
        { relPath: "memories/m.md", bytes: 7 },
        { relPath: "settings.json", bytes: 2 },
      ],
      {
        createdAt: "2026-07-01T00:00:00.000Z",
        sourceDir: "/x/.crewhaus",
        crewhausVersion: "0.1.4",
        sqliteConsistent: true,
        sqlite: { snapshotted: [], copiedRaw: [], foldedSidecars: [] },
      },
    );
    expect(manifest.totals).toEqual({ files: 4, bytes: 24 });
    expect(manifest.subdirs["sessions"]).toEqual({ files: 2, bytes: 15 });
    expect(manifest.subdirs["memories"]).toEqual({ files: 1, bytes: 7 });
    expect(manifest.subdirs["."]).toEqual({ files: 1, bytes: 2 });
    expect(isBackupManifest(manifest)).toBe(true);
    expect(isBackupManifest({ schemaVersion: 2 })).toBe(false);
    expect(isBackupManifest(null)).toBe(false);
  });
});

describe("planAdditiveMerge", () => {
  test("copies only files absent locally, skips the rest", () => {
    const local = new Set(["feedback/x.jsonl"]);
    const plan = planAdditiveMerge(["feedback/x.jsonl", "memories/new.md"], (rel) =>
      local.has(rel),
    );
    expect(plan.copy).toEqual(["memories/new.md"]);
    expect(plan.skip).toEqual(["feedback/x.jsonl"]);
  });
});

describe("planFeedbackMerge", () => {
  test("archived-only keys are added", () => {
    const plan = planFeedbackMerge([], [record({ id: "fb_a" })]);
    expect(plan.added).toBe(1);
    expect(plan.updated).toBe(0);
    expect(plan.unchanged).toBe(0);
    expect(plan.toImport.map((r) => r.id)).toEqual(["fb_a"]);
  });

  test("identical records dedupe to unchanged — re-merging is a no-op", () => {
    const r = record();
    const plan = planFeedbackMerge([r], [r]);
    expect(plan).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(plan.toImport).toEqual([]);
  });

  test("a later archived comment folds into the local rating (mergeFeedback semantics)", () => {
    const local = record({ ts: "2026-07-01T00:00:00.000Z" });
    const archivedComment = record({
      id: "fb_c",
      modality: "comment",
      rating: {},
      comment: "great answer",
      ts: "2026-07-02T00:00:00.000Z",
    });
    const plan = planFeedbackMerge([local], [archivedComment]);
    expect(plan.updated).toBe(1);
    const folded = plan.toImport[0] as FeedbackRecord;
    // the later comment-only record must NOT erase the earlier rating
    expect(folded.rating.thumbs).toBe("up");
    expect(folded.comment).toBe("great answer");
  });

  test("an archived record older than (and subsumed by) the local fold is unchanged", () => {
    const older = record({ ts: "2026-06-30T00:00:00.000Z", comment: "ok" });
    const newer = record({ id: "fb_n", ts: "2026-07-01T00:00:00.000Z" });
    // local already folded older + newer (rating from newer, comment from older)
    const plan = planFeedbackMerge([older, newer], [older]);
    expect(plan).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
  });
});

// ---------------------------------------------------------------------------
// backup (CLI integration)
// ---------------------------------------------------------------------------

describe("crewhaus state backup", () => {
  test("default name carries the harness name; manifest counts are right", async () => {
    const harness = join(tmp, "harness");
    seedHarness(harness);
    mkdirSync(join(harness, ".crewhaus", "memories"), { recursive: true });
    writeFileSync(join(harness, ".crewhaus", "memories", "m1.md"), "remember me\n");
    writeFileSync(join(harness, ".crewhaus", "settings.json"), "{}\n");

    const result = await runCli(["state", "backup"], harness);
    expect(result.exitCode).toBe(0);
    const tarball = readdirSync(harness).find((f) => f.endsWith(".tar.gz"));
    expect(tarball).toBeDefined();
    expect(tarball).toStartWith("crewhaus-state-backup-smoke-");

    const extracted = await extractTo(join(harness, tarball as string), join(tmp, "x"));
    const manifest = readManifestFromArchiveDir(extracted);
    // realpath-normalized (macOS tmpdir is a /private symlink in the child cwd)
    expect(manifest.sourceDir).toBe(join(realpathSync(harness), ".crewhaus"));
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false);
    expect(manifest.crewhausVersion).not.toBe("");
    expect(manifest.totals.files).toBe(3);
    expect(manifest.subdirs["sessions"]?.files).toBe(1);
    expect(manifest.subdirs["memories"]?.files).toBe(1);
    expect(manifest.subdirs["."]?.files).toBe(1);
    expect(manifest.sqliteConsistent).toBe(true);
    // and the archived bytes are the source bytes
    expect(readFileSync(join(extracted, "memories", "m1.md"), "utf-8")).toBe("remember me\n");
  });

  test("--exclude drops matching files from archive and manifest", async () => {
    const harness = join(tmp, "harness");
    seedHarness(harness);
    mkdirSync(join(harness, ".crewhaus", "memories"), { recursive: true });
    writeFileSync(join(harness, ".crewhaus", "memories", "m1.md"), "keep\n");

    const out = join(tmp, "b.tar.gz");
    const result = await runCli(["state", "backup", "-o", out, "--exclude", "sessions"], harness);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("excluded 1 file(s)");
    const entries = await tarEntries(out);
    expect(entries).toContain("memories/m1.md");
    expect(entries.some((e) => e.startsWith("sessions/"))).toBe(false);
    const manifest = readManifestFromArchiveDir(await extractTo(out, join(tmp, "x")));
    expect(manifest.subdirs["sessions"]).toBeUndefined();
    expect(manifest.totals.files).toBe(1);
  });

  test("dies cleanly when there is no .crewhaus dir", async () => {
    const empty = join(tmp, "no-state");
    mkdirSync(empty, { recursive: true });
    const result = await runCli(["state", "backup"], empty);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to back up");
  });

  test("help mentions the deliberate scope cuts", async () => {
    const result = await runCli(["state", "backup", "--help"], tmp);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out of scope");
    expect(result.stdout).toContain("S3/R2");
  });
});

// ---------------------------------------------------------------------------
// restore (CLI integration)
// ---------------------------------------------------------------------------

async function makeBackup(harness: string, out: string): Promise<void> {
  const result = await runCli(["state", "backup", "-o", out], harness);
  expect(result.exitCode).toBe(0);
}

describe("crewhaus state restore", () => {
  test("restores into an absent .crewhaus; the manifest is not restored as state", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    const out = join(tmp, "b.tar.gz");
    await makeBackup(harness, out);

    const dest = join(tmp, "dest");
    mkdirSync(dest, { recursive: true });
    const result = await runCli(["state", "restore", out, "--into", dest], dest);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("restored 1 file(s)");
    expect(existsSync(join(dest, ".crewhaus", "sessions", `${SESSION_ID}.jsonl`))).toBe(true);
    expect(existsSync(join(dest, ".crewhaus", MANIFEST_FILENAME))).toBe(false);
  });

  test("refuses an existing non-empty .crewhaus and says how to proceed", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    const out = join(tmp, "b.tar.gz");
    await makeBackup(harness, out);

    const dest = join(tmp, "dest");
    mkdirSync(join(dest, ".crewhaus", "memories"), { recursive: true });
    writeFileSync(join(dest, ".crewhaus", "memories", "precious.md"), "mine\n");
    const result = await runCli(["state", "restore", out], dest);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to overwrite");
    expect(result.stderr).toContain("memories/ (1 file(s))");
    expect(result.stderr).toContain("--force");
    expect(result.stderr).toContain("--merge feedback|all");
    // and nothing was touched
    expect(readFileSync(join(dest, ".crewhaus", "memories", "precious.md"), "utf-8")).toBe(
      "mine\n",
    );
  });

  test("--force moves the existing dir aside to .crewhaus.bak-<ts> (never deletes)", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    const out = join(tmp, "b.tar.gz");
    await makeBackup(harness, out);

    const dest = join(tmp, "dest");
    mkdirSync(join(dest, ".crewhaus"), { recursive: true });
    writeFileSync(join(dest, ".crewhaus", "marker.txt"), "old state\n");
    const result = await runCli(["state", "restore", out, "--force"], dest);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("moved existing state aside");
    // new state in place, marker gone from the live dir…
    expect(existsSync(join(dest, ".crewhaus", "sessions", `${SESSION_ID}.jsonl`))).toBe(true);
    expect(existsSync(join(dest, ".crewhaus", "marker.txt"))).toBe(false);
    // …but preserved byte-for-byte in the bak dir
    const bak = readdirSync(dest).find((f) => f.startsWith(".crewhaus.bak-"));
    expect(bak).toBeDefined();
    expect(readFileSync(join(dest, bak as string, "marker.txt"), "utf-8")).toBe("old state\n");
  });

  test("--merge and --force are mutually exclusive; --merge validates its value", async () => {
    const out = join(tmp, "b.tar.gz");
    writeFileSync(out, "placeholder");
    const both = await runCli(["state", "restore", out, "--merge", "feedback", "--force"], tmp);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("mutually exclusive");
    const bogus = await runCli(["state", "restore", out, "--merge", "bogus"], tmp);
    expect(bogus.exitCode).toBe(1);
    expect(bogus.stderr).toContain('invalid --merge "bogus"');
    const noFile = await runCli(["state", "restore"], tmp);
    expect(noFile.exitCode).toBe(1);
    expect(noFile.stderr).toContain("missing <file.tar.gz>");
  });

  test("unknown state action dies with the allowed set", async () => {
    const result = await runCli(["state", "frobnicate"], tmp);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('state action must be "backup" or "restore"');
  });
});

// ---------------------------------------------------------------------------
// --merge feedback: fixtures built via the REAL capture path (`crewhaus rate`
// / `feedback` append user_feedback events through the event log)
// ---------------------------------------------------------------------------

describe("crewhaus state restore --merge feedback", () => {
  test("transports deployed-bot feedback; re-merge dedupes; distill consumes it", async () => {
    // "Deployed bot": rate + comment a turn through the real capture path.
    const deployed = join(tmp, "deployed");
    seedHarness(deployed);
    expect(
      (await runCli(["rate", "--session", SESSION_ID, "--thumbs", "up"], deployed)).exitCode,
    ).toBe(0);
    expect(
      (await runCli(["feedback", "--session", SESSION_ID, "--text", "loved the brevity"], deployed))
        .exitCode,
    ).toBe(0);
    const out = join(tmp, "b.tar.gz");
    await makeBackup(deployed, out);

    // "Dev machine": same session transcript, no feedback yet.
    const dev = join(tmp, "dev");
    seedHarness(dev);
    const first = await runCli(["state", "restore", out, "--merge", "feedback"], dev);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("2 archived feedback record(s)");
    expect(first.stdout).toContain("1 new");
    const feedbackDir = join(dev, ".crewhaus", "feedback");
    const imported = readdirSync(feedbackDir).filter((f) => f.startsWith("restored-"));
    expect(imported).toHaveLength(1);
    const rec = JSON.parse(
      readFileSync(join(feedbackDir, imported[0] as string), "utf-8").trim(),
    ) as FeedbackRecord;
    // the fold carries BOTH the rating and the later comment
    expect(rec.rating.thumbs).toBe("up");
    expect(rec.comment).toBe("loved the brevity");

    // Re-merging the same archive is a no-op (mergeFeedback dedupe).
    const second = await runCli(["state", "restore", out, "--merge", "feedback"], dev);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("1 already present (deduped)");
    expect(second.stdout).toContain("nothing to merge");
    expect(readdirSync(feedbackDir).filter((f) => f.startsWith("restored-"))).toHaveLength(1);

    // The point of the feature: distill on the dev machine now sees it.
    const distill = await runCli(
      ["distill", "--session", SESSION_ID, "-o", join(dev, "ds.jsonl")],
      dev,
    );
    expect(distill.exitCode).toBe(0);
    const sample = JSON.parse(readFileSync(join(dev, "ds.jsonl"), "utf-8").trim()) as {
      input: string;
      metadata: Record<string, unknown>;
    };
    expect(sample.input).toBe("hello");
    expect(sample.metadata["user_rating"]).toBe(1);
  });

  test("a local rating folds with archived feedback instead of being clobbered", async () => {
    // Deployed bot rated the turn (earlier ts) with a comment.
    const deployed = join(tmp, "deployed");
    seedHarness(deployed);
    expect(
      (
        await runCli(
          ["rate", "--session", SESSION_ID, "--thumbs", "up", "--comment", "solid"],
          deployed,
        )
      ).exitCode,
    ).toBe(0);
    const out = join(tmp, "b.tar.gz");
    await makeBackup(deployed, out);

    // Dev machine later re-rated the same turn down (real capture path, later ts).
    const dev = join(tmp, "dev");
    seedHarness(dev);
    expect(
      (await runCli(["rate", "--session", SESSION_ID, "--thumbs", "down"], dev)).exitCode,
    ).toBe(0);

    const result = await runCli(["state", "restore", out, "--merge", "feedback"], dev);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 updated fold(s)");
    const feedbackDir = join(dev, ".crewhaus", "feedback");
    const imported = readdirSync(feedbackDir).filter((f) => f.startsWith("restored-"));
    const rec = JSON.parse(
      readFileSync(join(feedbackDir, imported[0] as string), "utf-8").trim(),
    ) as FeedbackRecord;
    // newest rating wins (local down came later); the archived comment survives
    expect(rec.rating.thumbs).toBe("down");
    expect(rec.comment).toBe("solid");
  });

  test("dies cleanly when the archive carries no feedback at all", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness); // transcript only — no ratings
    const out = join(tmp, "b.tar.gz");
    await makeBackup(harness, out);
    const dev = join(tmp, "dev");
    mkdirSync(dev, { recursive: true });
    const result = await runCli(["state", "restore", out, "--merge", "feedback"], dev);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no feedback records");
  });
});

// ---------------------------------------------------------------------------
// --merge all
// ---------------------------------------------------------------------------

describe("crewhaus state restore --merge all", () => {
  test("copies only files absent locally and reports skips", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    mkdirSync(join(harness, ".crewhaus", "memories"), { recursive: true });
    writeFileSync(join(harness, ".crewhaus", "memories", "new.md"), "from archive\n");
    const out = join(tmp, "b.tar.gz");
    await makeBackup(harness, out);

    const dest = join(tmp, "dest");
    mkdirSync(join(dest, ".crewhaus", "sessions"), { recursive: true });
    writeFileSync(join(dest, ".crewhaus", "sessions", `${SESSION_ID}.jsonl`), "local wins\n");

    const result = await runCli(["state", "restore", out, "--merge", "all"], dest);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`skipped sessions/${SESSION_ID}.jsonl`);
    expect(result.stdout).toContain("merged 1 new file(s)");
    // existing local file untouched, new archive file copied in
    expect(readFileSync(join(dest, ".crewhaus", "sessions", `${SESSION_ID}.jsonl`), "utf-8")).toBe(
      "local wins\n",
    );
    expect(readFileSync(join(dest, ".crewhaus", "memories", "new.md"), "utf-8")).toBe(
      "from archive\n",
    );
    // the manifest is metadata, never merged in as state
    expect(existsSync(join(dest, ".crewhaus", MANIFEST_FILENAME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// round-trip byte identity (item 69 requirement 3) + sqlite safety
// ---------------------------------------------------------------------------

describe("backup → restore round trip", () => {
  test("every restored file is byte-identical; the audit chain still verifies", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    // A REAL hash-chained audit dir — the artifact whose bytes must survive.
    const auditDir = join(harness, ".crewhaus", "audit");
    const audit = await openAuditLog({ rootDir: auditDir });
    await audit.append({ kind: "policy_decision", payload: { toolName: "Bash", n: 1 } });
    await audit.append({ kind: "egress_decision", payload: { sinkId: "fetch", n: 2 } });
    await audit.append({ kind: "model_call", payload: { n: 3 } });
    // Binary content too, so identity isn't just a text-file accident.
    mkdirSync(join(harness, ".crewhaus", "datasets"), { recursive: true });
    writeFileSync(join(harness, ".crewhaus", "datasets", "blob.bin"), randomBytes(4096));

    const out = join(tmp, "b.tar.gz");
    await makeBackup(harness, out);
    const dest = join(tmp, "dest");
    mkdirSync(dest, { recursive: true });
    expect((await runCli(["state", "restore", out, "--into", dest], dest)).exitCode).toBe(0);

    // Byte-identity for EVERY archived file.
    const srcRoot = join(harness, ".crewhaus");
    const destRoot = join(dest, ".crewhaus");
    const walk = (root: string, rel = ""): string[] =>
      readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        return e.isDirectory() ? walk(root, childRel) : [childRel];
      });
    const files = walk(srcRoot).sort();
    expect(files.length).toBeGreaterThanOrEqual(4); // transcript + audit day file + chain tail + blob
    expect(walk(destRoot).sort()).toEqual(files);
    for (const f of files) {
      const same = readFileSync(join(srcRoot, f)).equals(readFileSync(join(destRoot, f)));
      expect(`${f}: ${same}`).toBe(`${f}: true`);
    }

    // `audit verify`-ability survives the trip (and the source is untouched).
    expect((await verify(join(destRoot, "audit"))).ok).toBe(true);
    expect((await verify(auditDir)).ok).toBe(true);
  });
});

describe("sqlite handling", () => {
  test("a live WAL database is snapshotted consistently; sidecars fold in", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    const dbPath = join(harness, ".crewhaus", "durable-state.sqlite");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE dedup (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    db.run("INSERT INTO dedup VALUES ('evt_1', 42)");
    db.run("INSERT INTO dedup VALUES ('evt_2', 43)");
    // Writer stays OPEN across the backup — the WAL is live and un-checkpointed.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    try {
      const out = join(tmp, "b.tar.gz");
      await makeBackup(harness, out);

      const entries = await tarEntries(out);
      expect(entries).toContain("durable-state.sqlite");
      expect(entries.some((e) => e.endsWith("-wal") || e.endsWith("-shm"))).toBe(false);
      const manifest = readManifestFromArchiveDir(await extractTo(out, join(tmp, "x")));
      expect(manifest.sqliteConsistent).toBe(true);
      expect(manifest.sqlite.snapshotted).toEqual(["durable-state.sqlite"]);
      expect(manifest.sqlite.foldedSidecars).toContain("durable-state.sqlite-wal");

      // The restored snapshot opens and carries the WAL rows.
      const dest = join(tmp, "dest");
      mkdirSync(dest, { recursive: true });
      expect((await runCli(["state", "restore", out, "--into", dest], dest)).exitCode).toBe(0);
      const restored = new Database(join(dest, ".crewhaus", "durable-state.sqlite"));
      try {
        const rows = restored.query("SELECT key FROM dedup ORDER BY key").all() as Array<{
          key: string;
        }>;
        expect(rows.map((r) => r.key)).toEqual(["evt_1", "evt_2"]);
      } finally {
        restored.close();
      }
      // Source db untouched and still live.
      expect(db.query("SELECT COUNT(*) AS n FROM dedup").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  test("an unsnapshotttable sqlite file falls back to a raw copy with a warning", async () => {
    const harness = join(tmp, "src");
    seedHarness(harness);
    // SQLite magic header + garbage: opens lazily, serialize() throws.
    const corrupt = Buffer.concat([
      Buffer.from([
        0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33,
        0x00,
      ]),
      Buffer.from([7, 7, 7, 7, 9, 9, 1, 3]),
    ]);
    writeFileSync(join(harness, ".crewhaus", "broken.sqlite"), corrupt);

    const out = join(tmp, "b.tar.gz");
    const result = await runCli(["state", "backup", "-o", out], harness);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("could not snapshot sqlite file broken.sqlite");
    expect(result.stderr).toContain("sqliteConsistent: false");

    const extracted = await extractTo(out, join(tmp, "x"));
    const manifest = readManifestFromArchiveDir(extracted);
    expect(manifest.sqliteConsistent).toBe(false);
    expect(manifest.sqlite.copiedRaw).toEqual(["broken.sqlite"]);
    expect(manifest.sqlite.snapshotted).toEqual([]);
    // raw fallback is still an exact byte copy
    expect(readFileSync(join(extracted, "broken.sqlite")).equals(corrupt)).toBe(true);
  });
});
