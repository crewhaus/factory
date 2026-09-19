/**
 * B23 — CLI integration for `crewhaus dataset audit` (report / --apply /
 * --strict). Split out of the unit tests when the audit core moved to
 * `@crewhaus/dataset-ops`: these spawn the CLI, so they stay with the app.
 *
 * All synthetic PII below is built from parts so no secret-shaped literal
 * ever lands in the source (push protection), and no test needs a model or
 * credentials.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatasetRecord } from "@crewhaus/dataset-registry";

// Synthetic PII, assembled from parts.
const SSN = ["219", "09", "9999"].join("-");
const EMAIL = ["jane", "example.com"].join("@");
const SECRET_KEY = ["sk", "TESTTESTTEST1234567890abcd"].join("-");

// -------- CLI integration (offline — env carries only PATH) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-dataset-audit-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
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
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

function writeLeakyDataset(dir: string, name = "ds.jsonl"): string {
  const path = join(dir, name);
  const rows = [
    { id: "s1", input: `my ssn is ${SSN} thanks`, expected_output: "ok" },
    // s2's GOLD leaks — --apply must warn that redaction altered a gold.
    {
      id: "s2",
      input: "plain question",
      expected_output: `reach me at ${EMAIL}`,
      metadata: { comment: `key ${SECRET_KEY}` },
    },
    { id: "s3", input: "clean" },
  ];
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

function readRecord(root: string, name: string, version: string): DatasetRecord {
  return JSON.parse(
    readFileSync(join(root, ".crewhaus", "datasets", name, `${version}.json`), "utf-8"),
  ) as DatasetRecord;
}

describe("crewhaus dataset audit (CLI, offline)", () => {
  it("reports on a leaky file (exit 0) and --strict flips the exit to 1", async () => {
    const root = newTempRoot();
    writeLeakyDataset(root);
    expect((await runCli(["dataset", "audit", "--dataset", "ds.jsonl"], root)).exitCode).toBe(0);
    expect(
      (await runCli(["dataset", "audit", "--pii", "--dataset", "ds.jsonl"], root)).exitCode,
    ).toBe(0);
    expect(
      (await runCli(["dataset", "audit", "--dataset", "ds.jsonl", "--strict"], root)).exitCode,
    ).toBe(1);
  }, 15000);

  it("--strict on a clean dataset exits 0; missing --dataset exits 1", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "clean.jsonl"), `${JSON.stringify({ id: "c1", input: "hi" })}\n`);
    expect(
      (await runCli(["dataset", "audit", "--dataset", "clean.jsonl", "--strict"], root)).exitCode,
    ).toBe(0);
    expect((await runCli(["dataset", "audit"], root)).exitCode).toBe(1);
    expect((await runCli(["dataset", "audit", "--dataset", "nope.jsonl"], root)).exitCode).toBe(1);
  }, 15000);

  it("--apply refuses a file path and a #split ref", async () => {
    const root = newTempRoot();
    writeLeakyDataset(root);
    expect(
      (await runCli(["dataset", "audit", "--dataset", "ds.jsonl", "--apply"], root)).exitCode,
    ).toBe(1);
    expect(
      (await runCli(["dataset", "audit", "--dataset", "registry:x#train", "--apply"], root))
        .exitCode,
    ).toBe(1);
  }, 15000);

  it("--apply on a registry ref writes a redacted NEW version preserving splits", async () => {
    const root = newTempRoot();
    const file = writeLeakyDataset(root);
    expect((await runCli(["datasets", "put", "leaky", "--file", file], root)).exitCode).toBe(0);
    const applied = await runCli(
      ["dataset", "audit", "--dataset", "registry:leaky", "--apply"],
      root,
    );
    expect(applied.exitCode).toBe(0);
    // s2's gold changed under redaction — the instrument warning must fire.
    expect(applied.stderr).toContain("1 gold(s) contained redacted text");

    const v1 = readRecord(root, "leaky", "v1");
    const v2 = readRecord(root, "leaky", "v2");
    // Split MEMBERSHIP is preserved exactly — never re-split.
    for (const split of ["train", "dev", "test"] as const) {
      expect((v2.splits[split] ?? []).map((s) => s.id)).toEqual(
        (v1.splits[split] ?? []).map((s) => s.id),
      );
    }
    // v2 carries no raw PII; the prior version is untouched.
    const v2Text = JSON.stringify(v2);
    expect(v2Text).not.toContain(SSN);
    expect(v2Text).not.toContain(SECRET_KEY);
    expect(v2Text).not.toContain(EMAIL);
    expect(v2Text).toContain("[REDACTED:ssn]");
    expect(JSON.stringify(v1)).toContain(SSN);
    // The redacted version now audits clean under --strict.
    expect(
      (await runCli(["dataset", "audit", "--dataset", "registry:leaky@v2", "--strict"], root))
        .exitCode,
    ).toBe(0);
    // And no v3 appears when --apply finds nothing to rewrite.
    expect(
      (await runCli(["dataset", "audit", "--dataset", "registry:leaky@v2", "--apply"], root))
        .exitCode,
    ).toBe(0);
    expect(existsSync(join(root, ".crewhaus", "datasets", "leaky", "v3.json"))).toBe(false);
  }, 20000);
});
