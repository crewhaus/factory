/** One evaluation run's results, written beside the seeded eval history, for the export and link journeys. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the planted run's one row carries, to find it in an export. */
export const PLANTED_EVAL = {
  sampleId: "planted-sample",
  grader: "exact-match",
  rationale: "matched",
};

/**
 * Write `results.json` for the seeded history's newest run and answer its id: the run
 * Quality › Results lists first. Throws when the seed wrote no history.
 */
export function plantEvalResults(harnessDir: string): string {
  const evals = join(harnessDir, ".crewhaus", "evals");
  const ids = readFileSync(join(evals, "index.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { runId?: string }).runId)
    .filter((id): id is string => typeof id === "string" && /^run_[0-9a-f]{16}$/.test(id));
  const runId = ids.at(-1);
  if (runId === undefined) throw new Error("the seed wrote no eval history");
  mkdirSync(join(evals, runId), { recursive: true });
  const summary = {
    runId,
    startedAt: "2026-11-18T00:00:00.000Z",
    endedAt: "2026-11-18T00:01:00.000Z",
    config: { specHash: "h", datasetName: "smoke", model: "test/model" },
    samples: [
      {
        sampleId: PLANTED_EVAL.sampleId,
        startedAt: "2026-11-18T00:00:01.000Z",
        endedAt: "2026-11-18T00:00:02.000Z",
        latencyMs: 1000,
        grades: {
          overall: { passed: true, score: 1, rationale: PLANTED_EVAL.rationale },
          perGrader: [
            {
              name: PLANTED_EVAL.grader,
              passed: true,
              score: 1,
              rationale: PLANTED_EVAL.rationale,
            },
          ],
        },
      },
    ],
  };
  writeFileSync(join(evals, runId, "results.json"), `${JSON.stringify(summary)}\n`);
  return runId;
}
