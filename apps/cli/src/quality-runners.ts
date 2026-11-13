/**
 * The functions a change's check runs through, wired to the CLI's own eval stack: the
 * same runner `crewhaus eval` uses (tool packages imported through the CLI's literal
 * loader table), the same regrade `crewhaus eval --regrade` uses, and the same dataset
 * loader and content hash. `@crewhaus/quality-service` imports none of this; it is
 * handed these functions.
 *
 * Check runs are written under the change's own directory and never to the run
 * history: no `record` is passed to the regrade, and `runEval` writes no index line.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lower } from "@crewhaus/compiler";
import { canonicalJson } from "@crewhaus/control-contract";
import { type Sample, loadDataset } from "@crewhaus/eval-dataset";
import { gradersConfigHash, parseGradersConfig } from "@crewhaus/eval-grader";
import {
  type Instrument,
  calibrationDigestOf,
  getBaseline,
  hashDatasetFile,
  loadRun,
} from "@crewhaus/eval-report";
import {
  type EvalRunSummary,
  JUDGE_CALIBRATION_RELPATH,
  pluginsDigestOf,
  runEval as runEvalCore,
} from "@crewhaus/eval-runner";
import type { CheckRunners, InstrumentInputs, RecordedRun } from "@crewhaus/quality-service";
import { parseSpec } from "@crewhaus/spec";
import { BUILTIN_TOOLS } from "@crewhaus/tool-categories";
import { defaultMatrixPricing } from "./eval-matrix";
import { evalRunCost, graderRegistryForCompiled } from "./eval-output";
import { provabilityGraderNamesOf, regradeRecordedRun } from "./eval-regrade";
import { importToolPackage, loadBuiltinTools } from "./tool-packages";
import { cliVersion } from "./version";

function cliIr(specYaml: string) {
  const ir = lower(parseSpec(specYaml));
  if (ir.target !== "cli") {
    throw new Error(`a change is checked on a target: cli spec (got "${ir.target}")`);
  }
  return ir;
}

async function collect(samples: AsyncIterable<Sample>): Promise<Sample[]> {
  const out: Sample[] = [];
  for await (const s of samples) out.push(s);
  return out;
}

function stream(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  return (async function* () {
    for (const s of samples) yield s;
  })();
}

/**
 * Whether a spec's compiled tools include one that writes outside the process: a tool
 * with `scope: "external"` that is not read-only, any MCP server (its tools are not
 * known offline), and any tool key the builtin table does not name.
 */
export async function hasExternalWriteTools(specYaml: string): Promise<boolean> {
  const ir = cliIr(specYaml);
  if (Object.keys(ir.mcp_servers ?? {}).length > 0) return true;
  const keys = [...ir.tools];
  if (keys.some((key) => !Object.hasOwn(BUILTIN_TOOLS, key))) return true;
  if (keys.length === 0) return false;
  const tools = await loadBuiltinTools(keys);
  return Object.values(tools).some((tool) => tool.scope === "external" && tool.readOnly !== true);
}

/**
 * The MCP servers a candidate spec adds or defines differently from the base (each
 * entry compared as canonical JSON of its compiled form), then the tool keys it names
 * that the base does not, by name; `[]` when it adds neither, and `undefined` when
 * either spec cannot be compiled, so the caller cannot be told it adds nothing.
 */
export function addedToolSurface(
  baseYaml: string,
  candidateYaml: string,
): ReadonlyArray<string> | undefined {
  try {
    const base = cliIr(baseYaml);
    const candidate = cliIr(candidateYaml);
    const baseServers = (base.mcp_servers ?? {}) as Record<string, unknown>;
    const added: string[] = [];
    for (const [name, entry] of Object.entries(candidate.mcp_servers ?? {})) {
      if (
        !Object.hasOwn(baseServers, name) ||
        canonicalJson(baseServers[name]) !== canonicalJson(entry)
      ) {
        added.push(name);
      }
    }
    const baseTools = new Set(base.tools);
    for (const key of candidate.tools) if (!baseTools.has(key)) added.push(key);
    return added;
  } catch {
    return undefined;
  }
}

export type QualityRunnersOptions = {
  readonly harnessDir: string;
  /** The graders file the check measures with, for what counts as measured. */
  readonly gradersYaml: string;
  /** Whether each spec text the check runs (base, candidate) writes outside. */
  readonly externalWrites: ReadonlyMap<string, boolean>;
  /** The spec's name: the lineage a pinned run is looked up under. */
  readonly specName?: string;
  readonly evalsDir?: string;
};

/** The check's runners over the CLI's eval stack. */
export function qualityRunners(opts: QualityRunnersOptions): CheckRunners {
  const pricing = defaultMatrixPricing();
  const version = cliVersion();
  const evalsDir = opts.evalsDir ?? join(opts.harnessDir, ".crewhaus", "evals");
  const compiledForNames = parseGradersConfig(opts.gradersYaml).compiled;
  const usd = (micros: number | undefined): number | undefined =>
    micros !== undefined ? micros / 1_000_000 : undefined;
  return {
    async evalSpec(args) {
      const ir = cliIr(args.specYaml);
      const { compiled, config } = parseGradersConfig(args.gradersYaml);
      const graderRegistry = await graderRegistryForCompiled(compiled, { pricing });
      return runEvalCore({
        ir,
        dataset: { name: args.datasetName, samples: stream(args.samples) },
        compiledGraders: compiled,
        opts: {
          importToolPackage,
          outDir: args.outDir,
          datasetHash: args.datasetHash,
          gradersHash: gradersConfigHash(config),
          cwd: opts.harnessDir,
          ...(args.replayToolsDir !== undefined ? { replayToolsDir: args.replayToolsDir } : {}),
          ...(graderRegistry !== undefined ? { graderRegistry } : {}),
          ...(version !== undefined ? { cliVersion: version } : {}),
          pricing,
        },
      });
    },
    async regrade(args) {
      const ir = cliIr(args.specYaml);
      const { compiled, config } = parseGradersConfig(args.gradersYaml);
      const graderRegistry = await graderRegistryForCompiled(compiled, { pricing });
      return regradeRecordedRun({
        ir,
        sourceDir: args.sourceDir,
        purpose: "preview",
        datasetName: args.datasetName,
        samples: args.samples,
        datasetHash: args.datasetHash,
        compiled,
        gradersConfig: config,
        gradersHash: gradersConfigHash(config),
        outDir: args.outDir,
        ...(graderRegistry !== undefined ? { graderRegistry } : {}),
        ...(version !== undefined ? { cliVersion: version } : {}),
        pricing,
        cwd: opts.harnessDir,
      });
    },
    async loadFileDataset(absPath) {
      const loaded = await loadDataset(absPath);
      return {
        name: loaded.name,
        samples: await collect(loaded.samples),
        datasetHash: hashDatasetFile(absPath),
      };
    },
    recordedRun: (datasetName) =>
      opts.specName === undefined
        ? undefined
        : recordedRunOf(opts.harnessDir, evalsDir, opts.specName, datasetName),
    async loadRun(dir) {
      try {
        return (await loadRun(resolve(dir))).summary;
      } catch {
        return undefined;
      }
    },
    provabilityGraderNames: provabilityGraderNamesOf(compiledForNames),
    externalWriteTools: (specYaml) => opts.externalWrites.get(specYaml) ?? true,
    addedToolSurface,
    judgeCostUsd: (s: EvalRunSummary) => usd(evalRunCost(s, pricing).judgeMicros),
    agentCostUsd: (s: EvalRunSummary) => usd(evalRunCost(s, pricing).agentMicros),
  };
}

const recordedCache = new Map<string, RecordedRun | undefined>();

/** The lineage's pinned run for a dataset, loaded once per process. */
function recordedRunOf(
  harnessDir: string,
  evalsDir: string,
  specName: string,
  datasetName: string,
): RecordedRun | undefined {
  const key = `${evalsDir}\u0000${specName}\u0000${datasetName}`;
  if (recordedCache.has(key)) return recordedCache.get(key);
  const pin = getBaseline(specName, datasetName, evalsDir);
  let found: RecordedRun | undefined;
  if (pin !== undefined) {
    try {
      const dir = resolve(harnessDir, pin.outDir);
      const summary = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as EvalRunSummary;
      found = { summary, dir };
    } catch {
      found = undefined;
    }
  }
  recordedCache.set(key, found);
  return found;
}

type CompiledGraders = ReturnType<typeof parseGradersConfig>["compiled"];

/**
 * The judge calibration a check's run would apply, digested as a run records it: the
 * runner reads `.crewhaus/judge-calibration.json` from the harness and applies the
 * spec's (or the default) cut to every scalar `llm_judge` grader that declares no
 * `passing_score`. A check never routes arms, so no pair cut applies. `undefined` when
 * nothing would be applied; a throw when the file cannot be read.
 */
function calibrationDigestNow(
  harnessDir: string,
  specName: string,
  compiled: CompiledGraders,
): string | undefined {
  const judged = compiled.filter(
    (g) =>
      g.judgeSpec !== undefined &&
      g.judgeSpec.rubric.kind !== "categorical" &&
      g.judgeSpec.rubric.passing_score === undefined,
  );
  if (judged.length === 0) return undefined;
  const path = join(harnessDir, JUDGE_CALIBRATION_RELPATH);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // The runner reads a malformed file as no calibration; a file that cannot be
    // read at all is not an answer.
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
  const calibrations = (parsed as { calibrations?: unknown } | null)?.calibrations;
  if (calibrations === null || typeof calibrations !== "object") return undefined;
  const record = calibrations as Record<string, { minScore?: unknown } | undefined>;
  const specKey = record[specName] !== undefined ? specName : "default";
  const minScore = record[specKey]?.minScore;
  if (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    return undefined;
  }
  const applied = judged.map((g) => ({
    grader: g.name,
    specKey,
    minScore,
    passingScore: 1 + minScore * 4,
  }));
  return calibrationDigestOf({
    config: { judgeCalibration: { path, applied } },
  } as unknown as EvalRunSummary);
}

/**
 * The instrument a change's check would measure with now, computed as its runner
 * computes it: the graders' config hash, no `--judge-model` (the check passes none),
 * the judge calibration it would apply and the plugin graders it would resolve.
 * `undefined` when any part cannot be determined.
 */
export async function currentCheckInstrument(
  harnessDir: string,
  inputs: InstrumentInputs,
): Promise<Instrument | undefined> {
  try {
    const ir = cliIr(inputs.specYaml);
    const { compiled, config } = parseGradersConfig(inputs.gradersYaml);
    const registry = await graderRegistryForCompiled(compiled, {
      pricing: defaultMatrixPricing(),
    });
    const sources = registry?.pluginSources?.();
    const plugins = new Map<string, string>();
    for (const g of compiled) {
      const name = g.registrySpec?.grader;
      const modulePath = name !== undefined ? sources?.get(name) : undefined;
      if (name !== undefined && modulePath !== undefined) plugins.set(name, modulePath);
    }
    const pluginsDigest = pluginsDigestOf([...plugins.entries()]);
    const calibrationDigest = calibrationDigestNow(harnessDir, ir.name, compiled);
    const version = cliVersion();
    return {
      source: "summary",
      routed: false,
      gradersHash: gradersConfigHash(config),
      ...(calibrationDigest !== undefined ? { calibrationDigest } : {}),
      ...(pluginsDigest !== undefined ? { pluginsDigest } : {}),
      ...(version !== undefined ? { cliVersion: version } : {}),
    };
  } catch {
    return undefined;
  }
}
