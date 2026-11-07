/** The benchmark's machinery, on the smoke profile. */
import { join } from "node:path";
import { readBenchReport, runBench } from "../perf/bench";
import type { Journey } from "./journey";

export const benchDryRun: Journey = {
  id: "bench-dry-run",
  shard: "smoke",
  proves:
    "The benchmark boots over the seed, walks its routes and writes a well-formed report. It checks the report's shape, never a time.",
  run: async (scope) => {
    const out = join(scope.tempDir("hangar-e2e-bench-"), "bench.json");
    await runBench({ profile: "smoke", out });
    // Throws on anything malformed.
    const report = readBenchReport(out);
    if (Object.keys(report.samples).length === 0) {
      throw new Error("the benchmark's report holds no samples");
    }
  },
};
