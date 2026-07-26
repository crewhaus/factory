/**
 * E50 — `crewhaus experiment` report math + the CLI surface.
 *
 * The report half is pure (buildExperimentStatus over tallies); the CLI half
 * spawns the binary against a sandboxed ledger directory. Every spawn-heavy
 * block carries an explicit timeout — bun's 5s default is not enough for
 * repeated CLI boots on CI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExperimentOutcomeRecord,
  dedupeExperimentOutcomes,
  tallyExperimentOutcomes,
  writeExperimentAssignment,
} from "@crewhaus/canary-controller";
import {
  DEFAULT_MIN_EXPERIMENT_N,
  buildExperimentStatus,
  formatExperimentStatus,
} from "./experiment";

const CLI_PATH = join(import.meta.dir, "index.ts");
const TMP_ROOTS: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-experiment-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

/** n outcomes for `version`, `successes` of which passed. */
function outcomes(
  version: string,
  n: number,
  successes: number,
  rating?: number,
): ExperimentOutcomeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: `2026-07-26T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    experiment: "e",
    version,
    outcome: (i < successes ? "success" : "failure") as "success" | "failure",
    score: i < successes ? 1 : 0,
    ...(rating !== undefined ? { rating } : {}),
  }));
}

/** The same n outcomes, stamped as one eval run's per-sample observations. */
function evalOutcomes(version: string, n: number, successes: number): ExperimentOutcomeRecord[] {
  return outcomes(version, n, successes).map((r, i) => ({
    ...r,
    requestKey: `sample-${i}`,
    source: "eval",
  }));
}

describe("buildExperimentStatus — refusal below min n", () => {
  test("an empty ledger refuses with an explicit reason", () => {
    const report = buildExperimentStatus({ name: "e", tallies: [] });
    expect(report.verdict).toBe("insufficient-data");
    expect(report.reason).toContain("no outcomes recorded");
    expect(report.variants).toHaveLength(0);
  });

  test("a version below min n blocks a winner and names every sample size", () => {
    const tallies = tallyExperimentOutcomes([...outcomes("v1", 40, 20), ...outcomes("v2", 5, 5)]);
    const report = buildExperimentStatus({ name: "e", tallies });
    expect(report.verdict).toBe("insufficient-data");
    expect(report.winner).toBeUndefined();
    expect(report.reason).toContain("v2");
    expect(report.reason).toContain("v1=40");
    expect(report.reason).toContain("v2=5");
    expect(report.reason).toContain(String(DEFAULT_MIN_EXPERIMENT_N));
    // The comparison is withheld too — we do not classify what we refuse to call.
    expect(report.variants.find((v) => v.version === "v2")?.comparison).toBeUndefined();
  });

  test("--min-n can be lowered deliberately and then a winner is reachable", () => {
    const tallies = tallyExperimentOutcomes([...outcomes("v1", 20, 2), ...outcomes("v2", 20, 19)]);
    expect(buildExperimentStatus({ name: "e", tallies }).verdict).toBe("insufficient-data");
    const lowered = buildExperimentStatus({ name: "e", tallies, minN: 20 });
    expect(lowered.verdict).toBe("winner");
    expect(lowered.winner).toBe("v2");
  });
});

describe("buildExperimentStatus — the math", () => {
  test("control is the first-recorded version and rows carry Wilson intervals", () => {
    const tallies = tallyExperimentOutcomes([
      ...outcomes("baseline", 50, 25),
      ...outcomes("candidate", 50, 45),
    ]);
    const report = buildExperimentStatus({ name: "e", tallies });
    expect(report.control).toBe("baseline");
    const ctl = report.variants[0];
    expect(ctl?.successRate).toBe(0.5);
    // Wilson at 25/50 straddles 0.5 and is materially narrower than [0,1].
    expect(ctl?.ci95?.[0]).toBeGreaterThan(0.35);
    expect(ctl?.ci95?.[1]).toBeLessThan(0.65);
    expect(ctl?.successRateDelta).toBeUndefined();
    const cand = report.variants[1];
    expect(cand?.successRateDelta).toBeCloseTo(0.4, 10);
    expect(cand?.comparison).toBe("better");
    expect(report.verdict).toBe("winner");
    expect(report.winner).toBe("candidate");
  });

  test("overlapping intervals are inconclusive, never a winner", () => {
    const tallies = tallyExperimentOutcomes([...outcomes("v1", 50, 25), ...outcomes("v2", 50, 28)]);
    const report = buildExperimentStatus({ name: "e", tallies });
    expect(report.variants[1]?.comparison).toBe("inconclusive");
    expect(report.verdict).toBe("no-difference");
    expect(report.winner).toBeUndefined();
  });

  test("a clearly worse variant is classified worse and still not a winner", () => {
    const tallies = tallyExperimentOutcomes([...outcomes("v1", 60, 55), ...outcomes("v2", 60, 10)]);
    const report = buildExperimentStatus({ name: "e", tallies });
    expect(report.variants[1]?.comparison).toBe("worse");
    expect(report.verdict).toBe("no-difference");
  });

  test("rating and score deltas are reported when both sides carry them", () => {
    const tallies = tallyExperimentOutcomes([
      ...outcomes("v1", 40, 20, 3),
      ...outcomes("v2", 40, 20, 4.5),
    ]);
    const report = buildExperimentStatus({ name: "e", tallies });
    expect(report.variants[1]?.ratingDelta).toBeCloseTo(1.5, 10);
    expect(report.variants[1]?.scoreDelta).toBeCloseTo(0, 10);
  });

  test("--control re-bases the comparison", () => {
    const tallies = tallyExperimentOutcomes([...outcomes("v1", 50, 10), ...outcomes("v2", 50, 45)]);
    const rebased = buildExperimentStatus({ name: "e", tallies, control: "v2" });
    expect(rebased.control).toBe("v2");
    expect(rebased.variants.find((v) => v.version === "v1")?.comparison).toBe("worse");
    // An unknown control falls back to the first version rather than throwing.
    expect(buildExperimentStatus({ name: "e", tallies, control: "nope" }).control).toBe("v1");
  });

  test("a ramp's repeat measurements cannot manufacture significance", () => {
    // The bug: a default 5,25,50,100 ramp evals BOTH versions at every step
    // over the same fixed dataset, so the ledger holds 4×N records per
    // version carrying the same requestKeys. Fed raw to Wilson, the interval
    // is ~2× too narrow and `--min-n 30` is cleared by an 8-sample dataset.
    const ramp = [
      ...evalOutcomes("v1", 8, 4),
      ...evalOutcomes("v2", 8, 7),
      ...evalOutcomes("v1", 8, 4),
      ...evalOutcomes("v2", 8, 7),
      ...evalOutcomes("v1", 8, 4),
      ...evalOutcomes("v2", 8, 7),
      ...evalOutcomes("v1", 8, 4),
      ...evalOutcomes("v2", 8, 7),
    ];
    // Raw: 32 per version clears the 30-observation floor and names a winner.
    const raw = buildExperimentStatus({ name: "e", tallies: tallyExperimentOutcomes(ramp) });
    expect(raw.variants[0]?.n).toBe(32);
    expect(raw.verdict).toBe("winner");
    // Deduped: the real evidence is 8 samples per version — insufficient.
    const { records, collapsed } = dedupeExperimentOutcomes(ramp);
    expect(collapsed).toBe(48);
    const honest = buildExperimentStatus({
      name: "e",
      tallies: tallyExperimentOutcomes(records),
      duplicatesCollapsed: collapsed,
    });
    expect(honest.variants.map((v) => v.n)).toEqual([8, 8]);
    expect(honest.verdict).toBe("insufficient-data");
    expect(honest.winner).toBeUndefined();
    expect(honest.duplicatesCollapsed).toBe(48);
    expect(formatExperimentStatus(honest).join("\n")).toContain("collapsed 48 repeat eval");
  });

  test("the report carries the boundary caveat and each version's provenance", () => {
    const tallies = tallyExperimentOutcomes([
      ...evalOutcomes("v1", 40, 20),
      ...outcomes("v1", 5, 5).map((r) => ({ ...r, source: "serving" })),
      ...evalOutcomes("v2", 40, 22),
    ]);
    const report = buildExperimentStatus({ name: "e", tallies });
    // --json serializes the report verbatim, so the caveat and the source
    // breakdown must live ON it — not only in the human table's footer.
    expect(report.boundary).toContain("CrewHaus does not intercept live requests");
    expect(report.duplicatesCollapsed).toBeUndefined();
    expect(report.variants[0]?.sources).toEqual({ eval: 40, serving: 5 });
    expect(report.variants[1]?.sources).toEqual({ eval: 40 });
    expect(formatExperimentStatus(report).join("\n")).toContain("eval:40 serving:5");
  });

  test("two winners refuse to name one", () => {
    const tallies = tallyExperimentOutcomes([
      ...outcomes("ctl", 60, 5),
      ...outcomes("a", 60, 55),
      ...outcomes("b", 60, 58),
    ]);
    const report = buildExperimentStatus({ name: "e", tallies });
    expect(report.verdict).toBe("no-difference");
    expect(report.reason).toContain("no single winner");
  });
});

describe("formatExperimentStatus", () => {
  test("renders the table and always states the honest boundary", () => {
    const tallies = tallyExperimentOutcomes([...outcomes("v1", 40, 20), ...outcomes("v2", 40, 38)]);
    const lines = formatExperimentStatus(buildExperimentStatus({ name: "checkout", tallies }));
    const text = lines.join("\n");
    expect(text).toContain("[experiment] checkout — control v1");
    expect(text).toContain("version");
    expect(text).toContain("verdict: winner");
    expect(text).toContain("CrewHaus does not intercept live requests");
  });

  test("an empty report still prints the reason and no table", () => {
    const lines = formatExperimentStatus(buildExperimentStatus({ name: "none", tallies: [] }));
    expect(lines.join("\n")).toContain("no outcomes recorded");
    expect(lines.some((l) => l.includes("95% CI"))).toBe(false);
  });
});

describe("crewhaus experiment (CLI)", () => {
  test("record → status → assign round-trips against a sandboxed ledger", async () => {
    const cwd = tmp();
    const record = (version: string, outcome: string) =>
      runCli(
        ["experiment", "record", "--name", "checkout", "--version", version, "--outcome", outcome],
        cwd,
      );
    // Sequential: each append must observe the previous one's bytes.
    for (let i = 0; i < 3; i += 1) {
      const r = await record("v1", i === 0 ? "fail" : "pass");
      expect(r.exitCode).toBe(0);
    }
    const ledger = readFileSync(join(cwd, ".crewhaus", "experiments", "checkout.jsonl"), "utf-8");
    expect(ledger.trim().split("\n")).toHaveLength(3);

    const status = await runCli(["experiment", "status", "--name", "checkout", "--json"], cwd);
    expect(status.exitCode).toBe(0);
    const report = JSON.parse(status.stdout) as {
      verdict: string;
      boundary: string;
      variants: Array<{
        version: string;
        n: number;
        successes: number;
        sources: Record<string, number>;
      }>;
    };
    expect(report.verdict).toBe("insufficient-data");
    expect(report.variants[0]).toMatchObject({ version: "v1", n: 3, successes: 2 });
    // The machine surface carries the caveat and the provenance, not just the
    // human table — `--json` is what gets piped into a dashboard.
    expect(report.boundary).toContain("CrewHaus does not intercept live requests");
    expect(report.variants[0]?.sources).toEqual({ cli: 3 });

    writeExperimentAssignment(
      {
        name: "checkout",
        updatedAt: "2026-07-26T00:00:00.000Z",
        variants: [
          { version: "v1", weight: 50 },
          { version: "v2", weight: 50 },
        ],
      },
      join(cwd, ".crewhaus", "experiments"),
    );
    const assign = await runCli(
      ["experiment", "assign", "--name", "checkout", "--key", "user-42"],
      cwd,
    );
    expect(assign.exitCode).toBe(0);
    expect(["v1", "v2"]).toContain(assign.stdout.trim());
    expect(assign.stderr).toContain("CrewHaus does not route live requests");
    // The assignment's own provenance rides the note, so a human reading a
    // routing decision can see WHICH split and HOW OLD it is.
    expect(assign.stderr).toContain("assignment: v1=50% v2=50%");
    expect(assign.stderr).toContain("updatedAt 2026-07-26T00:00:00.000Z");
    // Deterministic: the same key resolves identically on a second boot.
    const again = await runCli(
      ["experiment", "assign", "--name", "checkout", "--key", "user-42"],
      cwd,
    );
    expect(again.stdout.trim()).toBe(assign.stdout.trim());
  }, 120_000);

  test("help, bad flags and missing state all fail loudly with guidance", async () => {
    const cwd = tmp();
    const [help, unknownAction, noExperiments, badOutcome] = await Promise.all([
      runCli(["experiment", "--help"], cwd),
      runCli(["experiment", "frobnicate"], cwd),
      runCli(["experiment", "status"], cwd),
      runCli(["experiment", "record", "--name", "e", "--version", "v1", "--outcome", "maybe"], cwd),
    ]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("WHAT THIS IS NOT");
    expect(help.stdout).toContain("It does NOT split live traffic");
    expect(unknownAction.exitCode).not.toBe(0);
    expect(unknownAction.stderr).toContain("unknown experiment action");
    expect(noExperiments.exitCode).not.toBe(0);
    expect(noExperiments.stderr).toContain("no experiments under");
    expect(badOutcome.exitCode).not.toBe(0);
    expect(badOutcome.stderr).toContain('--outcome must be "pass" or "fail"');
  }, 120_000);

  test("deploy canary documents --traffic-split honestly and accepts the flag", async () => {
    const cwd = tmp();
    const [help, parsed, topLevel] = await Promise.all([
      runCli(["deploy", "canary", "--help"], cwd),
      // No --dataset: the run dies AFTER arg parsing, which is exactly the
      // proof that `--traffic-split` is a known flag (an unknown one dies
      // with `unknown flag` instead).
      runCli(["deploy", "canary", "spec.yaml", "v2", "--traffic-split"], cwd),
      runCli(["--help"], cwd),
    ]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--traffic-split");
    expect(help.stdout).toContain("E50 BOUNDARY");
    expect(help.stdout).toContain("not live request splitting");
    expect(help.stdout).toContain(
      "NOTHING in CrewHaus's serving\n  surfaces reads that assignment",
    );
    // The identifier is the one thing that travels without its paragraph, so
    // the help must own the naming choice rather than leave it accidental.
    expect(help.stdout).toContain("named for the capability\n  it PREPARES");
    expect(help.stdout).toContain("ASSIGNMENT LIFECYCLE");
    expect(parsed.stderr).toContain("missing --dataset");
    expect(parsed.stderr).not.toContain("unknown flag");
    expect(topLevel.stdout).toContain("experiment status|record|assign");
  }, 120_000);

  test("a ledger with no assignment tells the operator how to write one", async () => {
    const cwd = tmp();
    const ledgerDir = join(cwd, ".crewhaus", "experiments");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, "solo.jsonl"),
      `${JSON.stringify({ ts: "t", experiment: "solo", version: "v1", outcome: "success" })}\n`,
      "utf-8",
    );
    // --name omitted: exactly one experiment exists, so it is unambiguous.
    const assign = await runCli(["experiment", "assign", "--key", "k"], cwd);
    expect(assign.exitCode).not.toBe(0);
    expect(assign.stderr).toContain("no variant assignment");
    expect(assign.stderr).toContain("--traffic-split");
    // A missing file is ambiguous between "never ran" and "ramp concluded";
    // the message names both so an operator does not read it as a bug.
    expect(assign.stderr).toContain("RETIRES the assignment");
  }, 60_000);
});
