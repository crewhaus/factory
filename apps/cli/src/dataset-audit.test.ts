/**
 * B23 — unit tests for the dataset-audit core (the shared sync PII/secret
 * redaction + the offline audit scan/report/apply primitives) and CLI
 * integration for `crewhaus dataset audit` (report / --apply / --strict).
 * All synthetic PII below is built from parts so no secret-shaped literal
 * ever lands in the source (push protection), and no test needs a model or
 * credentials.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatasetRecord } from "@crewhaus/dataset-registry";
import { SampleSchema } from "@crewhaus/eval-dataset";
import { createPiiRedactor } from "@crewhaus/pii-redactor";
import {
  auditSamples,
  containsRedactionMarker,
  redactDatasetText,
  redactSample,
  renderAuditReport,
  sampleTextFields,
} from "./dataset-audit";
import { SYNTHESIZE_PII_DETECTORS } from "./dataset-mine";

// Synthetic PII, assembled from parts.
const SSN = ["219", "09", "9999"].join("-");
const EMAIL = ["jane", "example.com"].join("@");
const SECRET_KEY = ["sk", "TESTTESTTEST1234567890abcd"].join("-");

describe("redactDatasetText", () => {
  it("matches the async PiiRedactor's replace mode byte-for-byte", async () => {
    const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });
    const texts = [
      `my ssn is ${SSN}, email ${EMAIL}, and the key ${SECRET_KEY} — please redeploy`,
      "no pii here at all",
      `${SSN} ${SSN} twice`,
      "",
    ];
    for (const text of texts) {
      expect(redactDatasetText(text)).toBe((await redactor.redact(text)).text);
    }
  });

  it("preserves non-PII text exactly and is deterministic", () => {
    const text = `Before ${SSN} middle ${EMAIL} after.`;
    const once = redactDatasetText(text);
    expect(once).toBe(redactDatasetText(text));
    expect(once).toBe("Before [REDACTED:ssn] middle [REDACTED:email] after.");
    expect(redactDatasetText("nothing to redact")).toBe("nothing to redact");
  });
});

describe("containsRedactionMarker", () => {
  it("detects both marker shapes, nothing else, and stays stateless", () => {
    expect(containsRedactionMarker("x [REDACTED:email] y")).toBe(true);
    expect(containsRedactionMarker("[REDACTED:credit_card]")).toBe(true);
    expect(containsRedactionMarker("[HASHED:ssn:0123456789abcdef]")).toBe(true);
    expect(containsRedactionMarker("plain text, even the word redacted")).toBe(false);
    expect(containsRedactionMarker("[REDACTED:]")).toBe(false);
    // A second call on the same input must not flip (non-global regex).
    expect(containsRedactionMarker("x [REDACTED:email] y")).toBe(true);
  });
});

describe("sampleTextFields + auditSamples", () => {
  it("scans input, expected_output, and string metadata leaves (incl. arrays)", () => {
    const fields = sampleTextFields({
      id: "s1",
      input: "in",
      expected_output: "out",
      expected_tools: ["Fetch"],
      metadata: { comment: "c", tags: ["a", 2, "b"], n: 3, nested: { x: "y" } },
    });
    expect(fields.map((f) => f.field)).toEqual([
      "input",
      "expected_output",
      "metadata.comment",
      "metadata.tags[0]",
      "metadata.tags[2]",
    ]);
  });

  it("reports hits per detector/field with sample ids and never fabricates any", () => {
    const report = auditSamples([
      { id: "s1", input: `ssn ${SSN} here` },
      { id: "s2", input: "clean", metadata: { comment: `mail ${EMAIL}` } },
      { id: "s3", input: "also clean" },
    ]);
    expect(report.samplesScanned).toBe(3);
    expect(report.samplesWithHits).toBe(2);
    expect(report.totalHits).toBe(2);
    expect(report.hits).toContainEqual({ sampleId: "s1", field: "input", kind: "ssn", count: 1 });
    expect(report.hits).toContainEqual({
      sampleId: "s2",
      field: "metadata.comment",
      kind: "email",
      count: 1,
    });
    const clean = auditSamples([{ id: "c1", input: "hello" }]);
    expect(clean.totalHits).toBe(0);
    expect(clean.hits).toEqual([]);
  });
});

describe("redactSample", () => {
  it("redacts every scannable field, leaves everything else byte-identical", () => {
    const s = redactSample({
      id: "s1",
      input: `call ${SSN} now`,
      expected_output: `write to ${EMAIL}`,
      expected_tools: ["Fetch", "Write"],
      metadata: {
        comment: `key ${SECRET_KEY}`,
        tags: [`cc ${EMAIL}`, 7],
        n: 3,
        raw_rating: { thumbs: "up" },
      },
    });
    expect(SampleSchema.safeParse(s).success).toBe(true);
    expect(s.id).toBe("s1");
    expect(s.input).toBe("call [REDACTED:ssn] now");
    expect(s.expected_output).toBe("write to [REDACTED:email]");
    expect(s.expected_tools).toEqual(["Fetch", "Write"]);
    expect(s.metadata?.["comment"]).toBe("key [REDACTED:secret]");
    expect(s.metadata?.["tags"]).toEqual(["cc [REDACTED:email]", 7]);
    expect(s.metadata?.["n"]).toBe(3);
    expect(s.metadata?.["raw_rating"]).toEqual({ thumbs: "up" });
  });

  it("keeps a clean sample identical and never adds absent fields", () => {
    const s = redactSample({ id: "c1", input: "plain" });
    expect(s).toEqual({ id: "c1", input: "plain" });
    expect("expected_output" in s).toBe(false);
    expect("metadata" in s).toBe(false);
  });
});

describe("renderAuditReport", () => {
  it("lists kinds/fields/counts/sample ids but NEVER the matched text", () => {
    const samples = [
      { id: "s1", input: `ssn ${SSN}` },
      { id: "s2", input: "ok", metadata: { comment: `mail ${EMAIL}` } },
    ];
    const out = renderAuditReport(auditSamples(samples), "leaky@v1");
    expect(out).toContain("leaky@v1");
    expect(out).toContain("2 PII/secret hit(s)");
    expect(out).toContain("ssn in input");
    expect(out).toContain("email in metadata.comment");
    expect(out).toContain("s1");
    expect(out).toContain("s2");
    expect(out).not.toContain(SSN);
    expect(out).not.toContain(EMAIL);
  });

  it("says so plainly when the dataset is clean", () => {
    const out = renderAuditReport(auditSamples([{ id: "c1", input: "hello" }]), "clean");
    expect(out).toContain("no PII/secret hits");
  });
});

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
