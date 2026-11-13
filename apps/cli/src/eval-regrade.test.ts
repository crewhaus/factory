import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { parseRegrade, provabilityGraderNamesOf, resolveRegradeSource } from "./eval-regrade";

const TMP: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-regrade-"));
  TMP.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

describe("parseRegrade", () => {
  test("nothing asked, nothing parsed", () => {
    expect(parseRegrade({})).toEqual({ ok: true });
  });

  test("--regrade takes a run id", () => {
    expect(parseRegrade({ regrade: "run_0123abcd0123abcd" })).toEqual({
      ok: true,
      regrade: { runId: "run_0123abcd0123abcd" },
    });
    expect(parseRegrade({ regrade: "../etc" })).toMatchObject({ ok: false });
    expect(parseRegrade({ regrade: true })).toMatchObject({ ok: false });
  });

  test("--regrade refuses every flag it cannot be combined with, naming why", () => {
    for (const [flag, value] of [
      ["gate", true],
      ["rebaseline", true],
      ["regrade-baseline", true],
      ["resume", "/tmp/run"],
      ["models", "a,b"],
      ["sentinel", true],
      ["provability", "cited"],
      ["record-tools", "/tmp/r"],
      ["replay-tools", "/tmp/r"],
      ["voice", true],
      ["repeats", "3"],
    ] as const) {
      const parsed = parseRegrade({ regrade: "run_0123abcd0123abcd", [flag]: value });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(`--regrade and --${flag} cannot be combined`);
    }
  });

  test("--regrade-baseline is refused with --rebaseline and the flags that pin no run", () => {
    expect(parseRegrade({ "regrade-baseline": true })).toEqual({ ok: true, regradeBaseline: true });
    for (const flag of ["rebaseline", "models", "sentinel", "voice"]) {
      const parsed = parseRegrade({
        "regrade-baseline": true,
        [flag]: flag === "models" ? "a" : true,
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect(parsed.error).toContain(`--regrade-baseline and --${flag} cannot be combined`);
    }
  });
});

describe("resolveRegradeSource", () => {
  const index = (evalsDir: string, rows: object[]) => {
    mkdirSync(evalsDir, { recursive: true });
    writeFileSync(
      join(evalsDir, "index.jsonl"),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
  };
  const row = (runId: string, outDir: string, extra: object = {}) => ({
    runId,
    specName: "s",
    specHash: "h",
    datasetName: "d",
    datasetHash: "x",
    passRate: 1,
    meanScore: 1,
    sampleCount: 1,
    ts: "2026-11-01T00:00:00.000Z",
    outDir,
    ...extra,
  });

  test("the newest row of a run inside the evals directory", () => {
    const evalsDir = join(tempDir(), "evals");
    const outDir = join(evalsDir, "run_aaaa1111");
    mkdirSync(outDir, { recursive: true });
    index(evalsDir, [
      row("run_aaaa1111", outDir, { ts: "2026-11-01T00:00:00.000Z", passRate: 0.5 }),
      row("run_aaaa1111", outDir, { ts: "2026-11-02T00:00:00.000Z", passRate: 1 }),
    ]);
    expect(resolveRegradeSource("run_aaaa1111", evalsDir).passRate).toBe(1);
  });

  test("an unknown id, a regrade itself, and a directory outside the evals dir are refused", () => {
    const evalsDir = join(tempDir(), "evals");
    const inside = join(evalsDir, "run_bbbb2222");
    mkdirSync(inside, { recursive: true });
    const outside = tempDir();
    const linked = join(evalsDir, "run_link");
    symlinkSync(outside, linked);
    index(evalsDir, [
      row("run_bbbb2222", inside, { purpose: "regrade", regradeOf: "run_aaaa1111" }),
      row("run_cccc3333", outside),
      row("run_dddd4444", linked),
    ]);
    expect(() => resolveRegradeSource("run_zzzz9999", evalsDir)).toThrow(/no run run_zzzz9999/);
    expect(() => resolveRegradeSource("run_bbbb2222", evalsDir)).toThrow(/is itself a regrade/);
    expect(() => resolveRegradeSource("run_cccc3333", evalsDir)).toThrow(/is not inside/);
    expect(() => resolveRegradeSource("run_dddd4444", evalsDir)).toThrow(/is not inside/);
    expect(() => resolveRegradeSource("../x", evalsDir)).toThrow(/is not a run id/);
  });
});

describe("provabilityGraderNamesOf", () => {
  test("names the entries recorded through one of the six, under their own names", () => {
    const { compiled } = parseGradersConfig(`graders:
  - { name: cov, type: registry, grader: provability.claimCoverage }
  - { name: rouge, type: registry, grader: nlg.rougeL }
  - { name: exact, type: exact_match }
`);
    expect([...provabilityGraderNamesOf(compiled)]).toEqual(["cov"]);
  });
});
