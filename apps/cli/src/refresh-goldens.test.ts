/**
 * Item 5 — unit tests for the refresh-goldens core: input matching
 * (equality + similarity), cross-run staleness, reconciliation of corrections
 * / up-rated divergences into proposals, apply-produces-new-samples (never
 * in-place), and hash provenance lining up with the registry's own hashSample.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSample } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import type { FeedbackRecord, SessionTurn } from "./feedback";
import {
  type GoldProposal,
  type RunSampleOutcome,
  applyProposals,
  isStaleSample,
  matchSampleByInput,
  reconcileGoldens,
  renderProposals,
} from "./refresh-goldens";

function fb(
  overrides: Partial<FeedbackRecord> & { sessionId: string; turnNumber: number },
): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: `fb_${overrides.sessionId}_${overrides.turnNumber}`,
    modality: "comment",
    rating: {},
    source: "cli",
    ts: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

function turn(sessionId: string, turnNumber: number, input: string, output: string): SessionTurn {
  return { sessionId, turnNumber, input, output, toolNames: [] };
}

describe("matchSampleByInput", () => {
  const samples: Sample[] = [
    {
      id: "s1",
      input: "What is the deploy command for payments?",
      expected_output: "deploy payments",
    },
    { id: "s2", input: "Summarize the Q3 sales report.", expected_output: "summary" },
  ];

  it("matches on exact (normalized) input equality", () => {
    expect(matchSampleByInput("  What is the deploy command for payments?  ", samples)?.id).toBe(
      "s1",
    );
  });

  it("matches a lightly-reworded input via similarity", () => {
    expect(
      matchSampleByInput("what is the deploy command for the payments service?", samples)?.id,
    ).toBe("s1");
  });

  it("returns undefined for a genuinely new input", () => {
    expect(
      matchSampleByInput("please rotate the database credentials now", samples),
    ).toBeUndefined();
  });
});

describe("isStaleSample", () => {
  const runs: RunSampleOutcome[][] = [
    [
      { sampleId: "s1", passed: false },
      { sampleId: "s2", passed: true },
    ],
    [
      { sampleId: "s1", passed: false },
      { sampleId: "s2", passed: true },
    ],
  ];

  it("is stale when it fails in every run and is seen enough times", () => {
    expect(isStaleSample("s1", runs)).toBe(true);
  });

  it("is not stale when it passes in any run", () => {
    expect(isStaleSample("s2", runs)).toBe(false);
  });

  it("is not stale (no signal) when absent from the run history", () => {
    expect(isStaleSample("s3", runs)).toBe(false);
  });

  it("respects minRuns (a single failing run is not enough)", () => {
    expect(isStaleSample("s1", [runs[0] as RunSampleOutcome[]], 2)).toBe(false);
  });
});

describe("reconcileGoldens", () => {
  const samples: Sample[] = [
    { id: "s1", input: "What is the deploy command?", expected_output: "old answer" },
    { id: "s2", input: "Summarize Q3.", expected_output: "old summary" },
  ];

  it("proposes a gold update from a user correction", () => {
    const result = reconcileGoldens({
      samples,
      turns: [turn("sess_00000000000000a1", 1, "What is the deploy command?", "wrong live answer")],
      records: [
        fb({ sessionId: "sess_00000000000000a1", turnNumber: 1, correction: "the RIGHT answer" }),
      ],
      minScore: 0.7,
    });
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0] as GoldProposal;
    expect(p.sampleId).toBe("s1");
    expect(p.evidence).toBe("correction");
    expect(p.currentGold).toBe("old answer");
    expect(p.proposedGold).toBe("the RIGHT answer");
    // Provenance hash matches the registry's own hashSample of the stored sample.
    expect(p.currentHash).toBe(hashSample(samples[0] as Sample));
  });

  it("proposes an update from an up-rated live answer that diverges from the gold", () => {
    const result = reconcileGoldens({
      samples,
      turns: [turn("sess_00000000000000a2", 1, "Summarize Q3.", "a much better live summary")],
      records: [
        fb({
          sessionId: "sess_00000000000000a2",
          turnNumber: 1,
          modality: "binary",
          rating: { thumbs: "up" },
        }),
      ],
      minScore: 0.7,
    });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.evidence).toBe("up-rated-divergence");
    expect(result.proposals[0]?.proposedGold).toBe("a much better live summary");
  });

  it("does NOT propose when the correction already matches the stored gold", () => {
    const result = reconcileGoldens({
      samples,
      turns: [turn("sess_00000000000000a3", 1, "What is the deploy command?", "x")],
      records: [
        fb({ sessionId: "sess_00000000000000a3", turnNumber: 1, correction: "old answer" }),
      ],
      minScore: 0.7,
    });
    expect(result.proposals).toHaveLength(0);
  });

  it("skips down-rated turns and counts unmatched feedback", () => {
    const result = reconcileGoldens({
      samples,
      turns: [
        turn("sess_00000000000000a4", 1, "totally unrelated new prompt about widgets", "ans"),
      ],
      records: [
        fb({
          sessionId: "sess_00000000000000a4",
          turnNumber: 1,
          modality: "binary",
          rating: { thumbs: "up" },
        }),
        // down-rated, no correction → not a proposal source
        fb({
          sessionId: "sess_00000000000000a4",
          turnNumber: 2,
          modality: "binary",
          rating: { thumbs: "down" },
        }),
      ],
      minScore: 0.7,
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.unmatched).toBeGreaterThanOrEqual(1);
  });

  it("flags a proposal STALE when the run history shows persistent failure", () => {
    const result = reconcileGoldens({
      samples,
      turns: [turn("sess_00000000000000a5", 1, "What is the deploy command?", "x")],
      records: [fb({ sessionId: "sess_00000000000000a5", turnNumber: 1, correction: "corrected" })],
      minScore: 0.7,
      runOutcomes: [[{ sampleId: "s1", passed: false }], [{ sampleId: "s1", passed: false }]],
    });
    expect(result.proposals[0]?.stale).toBe(true);
  });
});

describe("applyProposals", () => {
  const samples: Sample[] = [
    { id: "s1", input: "q1", expected_output: "old" },
    { id: "s2", input: "q2", expected_output: "keep" },
  ];
  const proposals: GoldProposal[] = [
    {
      sampleId: "s1",
      currentHash: hashSample(samples[0] as Sample),
      input: "q1",
      currentGold: "old",
      proposedGold: "new gold",
      evidence: "correction",
      sourceRef: "sess_x#1",
      stale: false,
    },
  ];

  it("produces a NEW sample array (never mutates the input) with provenance", () => {
    const updated = applyProposals(samples, proposals);
    // Input untouched.
    expect(samples[0]?.expected_output).toBe("old");
    // s1 updated, s2 unchanged.
    expect(updated[0]?.expected_output).toBe("new gold");
    expect(updated[1]?.expected_output).toBe("keep");
    expect(updated[0]?.metadata?.["gold_refreshed"]).toMatchObject({
      from: "old",
      evidence: "correction",
      source: "sess_x#1",
    });
  });
});

describe("renderProposals", () => {
  it("renders an old→new review diff and an empty message", () => {
    const result = {
      proposals: [
        {
          sampleId: "s1",
          currentHash: "abc",
          input: "q1",
          currentGold: "old",
          proposedGold: "new",
          evidence: "correction" as const,
          sourceRef: "sess_x#1",
          stale: true,
        },
      ],
      unmatched: 1,
      sampleCount: 3,
    };
    const out = renderProposals(result, "smoke@v1");
    expect(out).toContain("1 proposed gold update");
    expect(out).toContain("STALE across runs");
    expect(out).toContain("- old:");
    expect(out).toContain("+ new:");
    expect(out).toContain("--apply");

    const empty = renderProposals({ proposals: [], unmatched: 0, sampleCount: 2 }, "smoke@v1");
    expect(empty).toContain("no gold updates");
  });
});

// -------- CLI integration (offline) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-refresh-goldens-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(cliArgs: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...cliArgs], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_DATASETS_DIR: join(cwd, ".crewhaus", "datasets"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

/** Seed a session JSONL with one user turn + a correction feedback event. */
function seedSessionWithCorrection(
  sessionsDir: string,
  id: string,
  input: string,
  correction: string,
): void {
  const lines = [
    JSON.stringify({ kind: "user_message", payload: { content: input } }),
    JSON.stringify({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "wrong" }] },
    }),
    JSON.stringify({
      kind: "user_feedback",
      payload: {
        schemaVersion: 1,
        id: "fb_1",
        sessionId: id,
        turnNumber: 1,
        modality: "comment",
        rating: {},
        correction,
        source: "cli",
        ts: "2026-07-02T00:00:00.000Z",
      },
    }),
  ];
  writeFileSync(join(sessionsDir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("crewhaus dataset refresh-goldens (CLI, offline)", () => {
  it("prints a diff by default and writes a NEW registry version with --apply", async () => {
    const root = newTempRoot();
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    seedSessionWithCorrection(
      sessionsDir,
      "sess_00000000000000f1",
      "What is the deploy command?",
      "the corrected gold answer",
    );

    // Register a dataset with a stale gold.
    const datasetsDir = join(root, ".crewhaus", "datasets");
    const dsDir = join(datasetsDir, "smoke");
    mkdirSync(dsDir, { recursive: true });
    const v1 = {
      name: "smoke",
      version: "v1",
      splits: {
        train: [{ id: "s1", input: "What is the deploy command?", expected_output: "old gold" }],
        dev: [],
      },
      sampleHashes: { train: [], dev: [] },
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    writeFileSync(join(dsDir, "v1.json"), JSON.stringify(v1));

    // Default: prints the diff, writes nothing new.
    const preview = await runCli(
      ["dataset", "refresh-goldens", "--dataset", "registry:smoke"],
      root,
    );
    expect(preview.exitCode).toBe(0);
    expect(existsSync(join(dsDir, "v2.json"))).toBe(false);

    // --apply: writes a NEW version (never in-place).
    const applied = await runCli(
      ["dataset", "refresh-goldens", "--dataset", "registry:smoke", "--apply"],
      root,
    );
    expect(applied.exitCode).toBe(0);
    expect(existsSync(join(dsDir, "v2.json"))).toBe(true);
    // v1 is untouched.
    expect(
      JSON.parse(readFileSync(join(dsDir, "v1.json"), "utf-8")).splits.train[0].expected_output,
    ).toBe("old gold");
    const v2 = JSON.parse(readFileSync(join(dsDir, "v2.json"), "utf-8"));
    const all = [...v2.splits.train, ...v2.splits.dev, ...(v2.splits.test ?? [])];
    const refreshed = all.find((s: { id: string }) => s.id === "s1");
    expect(refreshed.expected_output).toBe("the corrected gold answer");
    expect(refreshed.metadata.gold_refreshed).toBeDefined();
  });

  it("errors without --dataset", async () => {
    const root = newTempRoot();
    expect((await runCli(["dataset", "refresh-goldens"], root)).exitCode).toBe(1);
  });
});
