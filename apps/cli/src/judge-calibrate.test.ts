/**
 * Item 8 — unit tests for the judge-calibrate core: normalization, Pearson
 * correlation, systematic bias, confusion + accuracy at a cut, the ROC-optimal
 * cut (Youden's J), per-rubric disagreement flagging with exemplars, the
 * calibration card + persisted file, and the no-credentials CLI exit.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CalibrationPair,
  DEFAULT_JUDGE_CUT,
  type JudgeCalibrationFile,
  accuracyAt,
  buildCalibrationCard,
  buildCalibrationFile,
  confusionAt,
  flagDisagreements,
  judgeBias,
  normalizeJudge,
  pearson,
  renderCalibrationCard,
  rocOptimalCut,
} from "./judge-calibrate";

function pair(
  human: number,
  judge: number,
  overrides: Partial<CalibrationPair> = {},
): CalibrationPair {
  return { sessionId: "sess_x", turnNumber: 1, human, judge, ...overrides };
}

describe("normalizeJudge", () => {
  it("maps 1-5 to [0,1] via (n-1)/4", () => {
    expect(normalizeJudge(1)).toBe(0);
    expect(normalizeJudge(3)).toBe(0.5);
    expect(normalizeJudge(5)).toBe(1);
  });
});

describe("pearson", () => {
  it("is +1 for a perfectly monotone-linear agreement", () => {
    const pairs = [pair(0, 1), pair(0.25, 2), pair(0.5, 3), pair(0.75, 4), pair(1, 5)];
    expect(pearson(pairs)).toBeCloseTo(1, 5);
  });

  it("is negative when the judge inverts the human", () => {
    const pairs = [pair(0, 5), pair(0.5, 3), pair(1, 1)];
    expect(pearson(pairs)).toBeLessThan(0);
  });

  it("is 0 with no variance", () => {
    expect(pearson([pair(0.5, 3), pair(0.5, 3)])).toBe(0);
  });
});

describe("judgeBias", () => {
  it("is positive when the judge is more generous than users", () => {
    // judge always 5 (norm 1), human always 0.5 → bias +0.5.
    expect(judgeBias([pair(0.5, 5), pair(0.5, 5)])).toBeCloseTo(0.5, 5);
  });

  it("is negative when the judge is harsher", () => {
    expect(judgeBias([pair(1, 1), pair(1, 1)])).toBeCloseTo(-1, 5);
  });
});

describe("confusion + accuracy", () => {
  const pairs = [
    pair(1, 5), // human up, judge pass → tp
    pair(0, 5), // human down, judge pass → fp
    pair(0, 1), // human down, judge fail → tn
    pair(1, 1), // human up, judge fail → fn
  ];

  it("classifies each quadrant at the default cut", () => {
    const c = confusionAt(pairs, DEFAULT_JUDGE_CUT);
    expect(c).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(accuracyAt(pairs, DEFAULT_JUDGE_CUT)).toBeCloseTo(0.5, 5);
  });
});

describe("rocOptimalCut", () => {
  it("finds a cut that perfectly separates up- from down-rated turns", () => {
    // Down-rated judged low (1-2), up-rated judged high (4-5). A cut at 0.5-0.75
    // separates them perfectly (Youden J = 1).
    const pairs = [pair(0, 1), pair(0, 2), pair(1, 4), pair(1, 5)];
    const roc = rocOptimalCut(pairs);
    expect(roc).toBeDefined();
    expect(roc?.youdenJ).toBeCloseTo(1, 5);
    expect(roc?.tpr).toBeCloseTo(1, 5);
    expect(roc?.fpr).toBeCloseTo(0, 5);
    // The cut sits above the highest down-rated judge score (norm 0.25) and at
    // or below the lowest up-rated (norm 0.75).
    expect(roc?.cut).toBeGreaterThan(0.25);
    expect(roc?.cut).toBeLessThanOrEqual(0.75);
  });

  it("returns undefined without both classes present", () => {
    expect(rocOptimalCut([pair(1, 5), pair(1, 4)])).toBeUndefined();
    expect(rocOptimalCut([pair(0, 1), pair(0, 2)])).toBeUndefined();
  });
});

describe("flagDisagreements", () => {
  it("flags a criterion whose judge scores diverge from users, naming exemplars", () => {
    const pairs = [
      pair(0, 5, {
        sessionId: "sess_a",
        turnNumber: 1,
        criterionScores: { helpfulness: 5, safety: 1 },
      }),
      pair(0, 5, {
        sessionId: "sess_b",
        turnNumber: 2,
        criterionScores: { helpfulness: 5, safety: 1 },
      }),
    ];
    // helpfulness: judge norm 1 vs human 0 → err 1 (flagged). safety: judge
    // norm 0 vs human 0 → err 0 (not flagged).
    const flags = flagDisagreements(pairs);
    expect(flags.map((f) => f.criterion)).toEqual(["helpfulness"]);
    expect(flags[0]?.meanAbsError).toBeCloseTo(1, 5);
    expect(flags[0]?.exemplars).toContain("sess_a#1");
  });

  it("flags nothing when the judge and users agree per criterion", () => {
    const pairs = [
      pair(1, 5, { criterionScores: { q: 5 } }),
      pair(0, 1, { criterionScores: { q: 1 } }),
    ];
    expect(flagDisagreements(pairs)).toEqual([]);
  });
});

describe("buildCalibrationCard + file", () => {
  const pairs = [
    pair(0, 1, { sessionId: "sess_a", turnNumber: 1 }),
    pair(0, 2, { sessionId: "sess_b", turnNumber: 1 }),
    pair(1, 4, { sessionId: "sess_c", turnNumber: 1 }),
    pair(1, 5, { sessionId: "sess_d", turnNumber: 1 }),
  ];

  it("assembles a card with correlation, bias, confusion, and the ROC cut", () => {
    const card = buildCalibrationCard(pairs, { specName: "helper", model: "claude-sonnet-4-5" });
    expect(card.pairCount).toBe(4);
    expect(card.correlation).toBeGreaterThan(0.9);
    expect(card.recommendedCut).toBeDefined();
    expect(card.specName).toBe("helper");
  });

  it("buildCalibrationFile merges without clobbering other specs", () => {
    const existing: JudgeCalibrationFile = {
      version: 1,
      calibrations: {
        other: {
          minScore: 0.6,
          correlation: 0.5,
          bias: 0,
          pairCount: 3,
          updatedAt: "2026-06-01T00:00:00Z",
        },
      },
    };
    const card = buildCalibrationCard(pairs, { specName: "helper" });
    const file = buildCalibrationFile(existing, card, "2026-07-02T00:00:00Z");
    expect(file.calibrations["other"]).toBeDefined();
    expect(file.calibrations["helper"]).toBeDefined();
    expect(file.calibrations["helper"]?.minScore).toBe(
      card.recommendedCut?.cut ?? DEFAULT_JUDGE_CUT,
    );
  });

  it("renders a readable calibration card", () => {
    const card = buildCalibrationCard(pairs, { specName: "helper", model: "claude-sonnet-4-5" });
    const out = renderCalibrationCard(card);
    expect(out).toContain('judge calibration for "helper"');
    expect(out).toContain("correlation:");
    expect(out).toContain("ROC-optimal cut:");
  });

  it("card renders n/a for the ROC cut when a class is missing", () => {
    const card = buildCalibrationCard([pair(1, 5), pair(1, 4)]);
    expect(card.recommendedCut).toBeUndefined();
    expect(renderCalibrationCard(card)).toContain("n/a");
  });
});

// -------- CLI integration (offline — no judge credentials) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-judge-calibrate-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(cliArgs: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...cliArgs], {
    cwd,
    // No ANTHROPIC creds → the judge path must exit cleanly, not fabricate.
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

const CLI_SPEC = `name: helper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: You help.
tools: [read]
`;

describe("crewhaus judge calibrate (CLI, no credentials)", () => {
  it("exits cleanly (code 1, no fabricated scores) when no judge model creds exist", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // A rated turn exists, but there are no judge credentials.
    const lines = [
      JSON.stringify({ kind: "user_message", payload: { content: "summarize this" } }),
      JSON.stringify({
        kind: "assistant_message",
        payload: { content: [{ type: "text", text: "a summary" }] },
      }),
      JSON.stringify({
        kind: "user_feedback",
        payload: {
          schemaVersion: 1,
          id: "fb_1",
          sessionId: "sess_00000000000000e1",
          turnNumber: 1,
          modality: "binary",
          rating: { thumbs: "up" },
          source: "cli",
          ts: "2026-07-02T00:00:00.000Z",
        },
      }),
    ];
    writeFileSync(join(sessionsDir, "sess_00000000000000e1.jsonl"), `${lines.join("\n")}\n`);

    const got = await runCli(["judge", "calibrate"], root);
    // Clean exit explaining it needs a judge model — never a crash, never a card.
    expect(got.exitCode).toBe(1);
    // No calibration file was written.
    expect(existsSync(join(root, ".crewhaus", "judge-calibration.json"))).toBe(false);
  });

  it("exits cleanly when there are no rated turns to calibrate against", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    mkdirSync(join(root, ".crewhaus", "sessions"), { recursive: true });
    expect((await runCli(["judge", "calibrate"], root)).exitCode).toBe(1);
  });
});
