import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { ReportError } from "./errors";

export type LoadedRun = {
  readonly summary: EvalRunSummary;
  readonly perSample: Record<
    string,
    {
      readonly transcript: string;
      readonly events: string;
      readonly grades: string;
      readonly meta: string;
    }
  >;
};

/**
 * Resolve a runId or filesystem path to a loaded run summary plus the per-sample
 * raw artifact text. If `idOrPath` matches `^run_<hex>$`, it is looked up under
 * `.crewhaus/evals/<id>/`. Otherwise it is treated as a filesystem path to the
 * run's output directory.
 */
export async function loadRun(idOrPath: string): Promise<LoadedRun> {
  const dir = resolveDir(idOrPath);
  const resultsPath = join(dir, "results.json");
  if (!existsSync(resultsPath)) {
    throw new ReportError(`results.json not found in ${dir}`);
  }
  let summary: EvalRunSummary;
  try {
    summary = JSON.parse(readFileSync(resultsPath, "utf-8")) as EvalRunSummary;
  } catch (err) {
    throw new ReportError(`failed to parse ${resultsPath}: ${(err as Error).message}`);
  }

  const perSample: Record<string, LoadedRun["perSample"][string]> = {};
  for (const entry of readdirSync(dir)) {
    const sampleDir = join(dir, entry);
    if (!statSync(sampleDir).isDirectory()) continue;
    perSample[entry] = {
      transcript: safeRead(join(sampleDir, "transcript.jsonl")),
      events: safeRead(join(sampleDir, "events.jsonl")),
      grades: safeRead(join(sampleDir, "grades.json")),
      meta: safeRead(join(sampleDir, "meta.json")),
    };
  }
  return { summary, perSample };
}

function resolveDir(idOrPath: string): string {
  if (/^run_[0-9a-f]{16}$/.test(idOrPath)) {
    return join(".crewhaus", "evals", idOrPath);
  }
  return idOrPath;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
