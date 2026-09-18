/**
 * @crewhaus/tool-buildperf — did this change make the build worse.
 *
 * Three questions a merge gate asks after every change: is the artifact
 * bigger, is it slower, and did the suite stop being trustworthy. Each has a
 * cheap wrong answer that a harness will produce all day — a percentage
 * between two numbers that were never comparable, a mean of five timings, a
 * fail count divided by a run count — and each of those wrong answers is
 * expensive, because a gate that cries wolf gets switched off within a month.
 *
 * So the shared property of this package is the refusal. `BundleSizeCheck`
 * will not subtract two sizes measured at different compression levels.
 * `BenchmarkCompare` will not call significance on five samples per side, and
 * will not call a difference below the caller's declared noise floor a change
 * at all. `FlakyTestDetect` will not report 3-of-5 as "60% flaky", and will
 * not say "nondeterministic" about a suite that never varied its order.
 *
 * All statistics come from `@crewhaus/tool-math`'s kernel — the median, the
 * MAD, Mann-Whitney and Wilson. None of it is re-derived here, so a change to
 * how this repository computes an interval happens in one place.
 *
 * Only `BundleSizeCheck` touches the filesystem, read-only, and every
 * caller-supplied path goes through the same containment resolver the other
 * filesystem packages use. Nothing here runs a build, a benchmark or a test:
 * the measurements come in, the honest reading of them comes out.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { statsKernel } from "@crewhaus/tool-math";
import { z } from "zod";
import { type BenchmarkInput, MIN_SAMPLES_FOR_SIGNIFICANCE, compareBenchmarks } from "./lib/bench";
import { TEST_STATUSES, detectFlaky } from "./lib/flaky";
import {
  COMPRESSION_ALGORITHMS,
  type CompressionParameters,
  JOIN_MODES,
  type JoinMode,
  MAX_GLOB_LENGTH,
  baselineBasisMismatch,
  comparabilityKey,
  compileGlob,
  compressedSize,
  compressionParameters,
  joinKey,
  parametersMismatch,
} from "./lib/size";
import { resolveSafe, toPosix } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

/** Ceilings that keep one pathological input from becoming a hang. */
const LIMITS = {
  /** A build with more artifacts than this is a tree, not a bundle. */
  entries: 2_000,
  /** Compressing a file this big to weigh it is not the intended use. */
  fileBytes: 512 * 1024 * 1024,
  budgets: 200,
  benchmarks: 500,
  samplesPerSide: 10_000,
  runs: 200,
  testsPerRun: 5_000,
  masks: 64,
} as const;

/** The zlib build that produced these numbers; see `runtime` in the report. */
const ZLIB_VERSION: string = process.versions.zlib ?? "unknown";

// --- BundleSizeCheck --------------------------------------------------------

// Not `.strict()`: a stored baseline is a previous REPORT, which carries the
// derived `comparabilityKey` alongside the parameters. Rejecting the report
// this tool just produced would make "store it and pass it back" a lie.
const parametersSchema = z.object({
  algorithm: z.enum(COMPRESSION_ALGORITHMS),
  level: z.number().int().min(0).max(11).nullable(),
  tuning: z.record(z.number()).optional(),
});

const baselineSchema = z.object({
  // Optional ON PURPOSE. A baseline that never declared its parameters is
  // refused by the tool with an explanation, which is a more useful answer
  // than a schema error about a missing field.
  parameters: parametersSchema.optional(),
  entries: z
    .array(
      z.object({
        path: z.string().min(1),
        bytes: z.number().int().nonnegative(),
        compressedBytes: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .max(LIMITS.entries),
  runtime: z.object({ zlib: z.string() }).optional(),
});

type BaselineInput = z.infer<typeof baselineSchema>;

type MeasuredEntry = {
  path: string;
  key: string;
  bytes: number;
  compressedBytes: number | null;
};

type Walk = { files: string[]; links: string[] };

/** Every file under a directory, workspace-relative, sorted, capped. */
function filesUnder(root: string, rel: string, out: Walk): Walk {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      filesUnder(root, child, out);
      continue;
    }
    if (entry.isFile()) {
      out.files.push(child);
    } else if (entry.isSymbolicLink()) {
      // `readdir` reports links by their own type, so a link is neither a file
      // nor a directory here and is not followed. Weighing both the link and
      // its target would double-count, and following one out of the workspace
      // is what the resolver exists to stop — but silently dropping it would
      // under-report the total, so it is counted and named in the report.
      out.links.push(child);
    }
    if (out.files.length > LIMITS.entries) {
      throw new Error(
        `more than ${LIMITS.entries} files under "${rel}" — narrow it with extensions, or point at the build output directory rather than the project root`,
      );
    }
  }
  return out;
}

function measure(
  paths: ReadonlyArray<string>,
  parameters: CompressionParameters,
  mode: JoinMode,
  custom: RegExp | undefined,
): MeasuredEntry[] {
  return paths.map((path) => {
    const at = resolveSafe("BundleSizeCheck", path);
    const stats = statSync(at.real);
    if (!stats.isFile()) throw new Error(`"${path}" is not a file`);
    if (stats.size > LIMITS.fileBytes) {
      throw new Error(`"${path}" is ${stats.size} bytes, over the ${LIMITS.fileBytes}-byte limit`);
    }
    const bytes = readFileSync(at.real);
    return {
      path: at.rel,
      key: joinKey(at.rel, mode, custom).key,
      bytes: bytes.byteLength,
      compressedBytes: parameters.algorithm === "none" ? null : compressedSize(bytes, parameters),
    };
  });
}

/** The number a budget and a regression are measured against. */
const primarySize = (entry: { bytes: number; compressedBytes: number | null }): number =>
  entry.compressedBytes ?? entry.bytes;

function percentDelta(before: number, after: number): number | null {
  // A baseline of zero bytes has no percentage: every increase is infinite.
  // The absolute delta is still reported, which is the honest half.
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

export const bundleSizeCheck: RegisteredTool = buildTool({
  name: "BundleSizeCheck",
  description:
    "Weigh build artifacts — raw and gzip or brotli — against declared budgets and a stored baseline, and report what actually grew. Use it as the size gate on a pull request, instead of a model comparing two numbers whose provenance it cannot see. The compression parameters are part of the measurement and travel with the report: a baseline produced at a different level, with a different algorithm, or with no declared parameters at all is REFUSED rather than differenced, because the gap between gzip level 6 and level 9 is the same few percent a regression is, and subtracting them produces a confident number about nothing. Hashed filenames (app-4f2a1c.js) can be joined on a normalised key so a content-hash change is not reported as every file being new, and two artifacts that normalise to the same key are reported as ambiguous rather than silently paired. The report is itself a baseline: store it and pass it back next time.",
  inputSchema: z
    .object({
      files: z
        .array(z.string().min(1))
        .max(LIMITS.entries)
        .optional()
        .describe("workspace-relative artifact paths"),
      directory: z.string().min(1).optional().describe("or a directory to weigh every file under"),
      extensions: z
        .array(z.string().min(1))
        .max(32)
        .optional()
        .describe("with directory: keep only these extensions, e.g. ['.js','.css']"),
      algorithm: z
        .enum(COMPRESSION_ALGORITHMS)
        .optional()
        .describe("gzip (default), brotli, or none for raw bytes only"),
      level: z
        .number()
        .int()
        .min(0)
        .max(11)
        .optional()
        .describe("compression level; gzip 0-9 (default 9), brotli 0-11 (default 11)"),
      join: z
        .enum(JOIN_MODES)
        .optional()
        .describe("exact (default), auto to strip content hashes, or custom"),
      joinPattern: z
        .string()
        .optional()
        .describe("with join=custom: a regex whose matches are replaced by [hash]"),
      baseline: baselineSchema.optional().describe("a previous report, inline"),
      baselineFile: z
        .string()
        .min(1)
        .optional()
        .describe("or a workspace-relative JSON file holding one"),
      budgets: z
        .array(
          z
            .object({
              pattern: z
                .string()
                .min(1)
                .max(MAX_GLOB_LENGTH)
                .describe("glob: * within a segment, ** across segments"),
              maxBytes: z.number().int().positive(),
              on: z.enum(["compressed", "raw"]).optional(),
            })
            .strict(),
        )
        .max(LIMITS.budgets)
        .optional(),
      totalMaxBytes: z.number().int().positive().optional(),
      maxIncreasePercent: z
        .number()
        .min(0)
        .optional()
        .describe("fail when a matched entry or the total grows by more than this"),
    })
    .strict()
    .refine((v) => (v.files === undefined) !== (v.directory === undefined), {
      message: "give exactly one of files or directory",
    })
    .refine((v) => !(v.baseline !== undefined && v.baselineFile !== undefined), {
      message: "give at most one of baseline or baselineFile",
    })
    .refine((v) => v.join !== "custom" || v.joinPattern !== undefined, {
      message: "join=custom needs joinPattern",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const warnings: string[] = [];
    let parameters: CompressionParameters;
    try {
      parameters = compressionParameters(input.algorithm ?? "gzip", input.level);
    } catch (err) {
      return (err as Error).message;
    }
    const mode: JoinMode = input.join ?? "exact";
    let custom: RegExp | undefined;
    if (input.joinPattern !== undefined) {
      try {
        custom = new RegExp(input.joinPattern, "g");
      } catch (err) {
        return `joinPattern /${input.joinPattern}/ is not a valid regular expression: ${(err as Error).message}`;
      }
    }

    let paths: string[];
    if (input.directory !== undefined) {
      const at = resolveSafe("BundleSizeCheck", input.directory);
      if (!statSync(at.real).isDirectory()) return `"${input.directory}" is not a directory`;
      const walk = filesUnder(at.real, "", { files: [], links: [] });
      const found = walk.files.map((rel) => toPosix(join(at.rel, rel)));
      const extensions = input.extensions;
      paths =
        extensions === undefined
          ? found
          : found.filter((p) => extensions.some((e) => p.endsWith(e)));
      if (walk.links.length > 0) {
        // Workspace-relative, like every other path in the report: a warning
        // naming `alias.js` where the entries say `dist/alias.js` sends the
        // reader looking in the wrong directory.
        const named = walk.links.slice(0, 5).map((rel) => toPosix(join(at.rel, rel)));
        warnings.push(
          `${walk.links.length} symlink(s) under "${at.rel}" were not weighed (${named.join(
            ", ",
          )}); pass them in files: [...] to measure what they point at`,
        );
      }
    } else {
      paths = [...(input.files ?? [])];
      const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
      if (duplicates.length > 0) {
        return `the same path was given twice (${[...new Set(duplicates)].join(", ")}); one file cannot contribute two rows to a size report`;
      }
    }
    if (paths.length === 0) {
      return "no files matched — there is nothing to weigh, which is not the same as a build of zero bytes";
    }

    const entries = measure(paths, parameters, mode, custom);
    const totals = entries.reduce(
      (acc, e) => ({
        bytes: acc.bytes + e.bytes,
        compressedBytes:
          e.compressedBytes === null
            ? acc.compressedBytes
            : (acc.compressedBytes ?? 0) + e.compressedBytes,
      }),
      { bytes: 0, compressedBytes: null as number | null },
    );

    // --- budgets ---
    const budgets = input.budgets ?? [];
    const violations: unknown[] = [];
    for (const budget of budgets) {
      const on = budget.on ?? (parameters.algorithm === "none" ? "raw" : "compressed");
      if (on === "compressed" && parameters.algorithm === "none") {
        return `a budget on the compressed size cannot be checked with algorithm "none"; choose gzip or brotli, or set on: "raw"`;
      }
      // Compiled once per budget, not once per artifact: at the 200-budget and
      // 2,000-entry ceilings the per-path form tokenizes 400,000 times.
      let match: ReturnType<typeof compileGlob>;
      try {
        match = compileGlob(budget.pattern);
      } catch (err) {
        return (err as Error).message;
      }
      const matched = entries.filter((e) => match(e.path));
      for (const entry of matched) {
        const size = on === "raw" ? entry.bytes : (entry.compressedBytes ?? entry.bytes);
        if (size > budget.maxBytes) {
          violations.push({
            pattern: budget.pattern,
            path: entry.path,
            on,
            size,
            maxBytes: budget.maxBytes,
            overBytes: size - budget.maxBytes,
          });
        }
      }
      if (matched.length === 0) {
        // A budget that matches nothing passes vacuously, which is the most
        // common way a size gate stops gating: the bundler renamed the entry.
        violations.push({
          pattern: budget.pattern,
          matched: 0,
          why: "this budget matched no artifact, so it checked nothing — a renamed entry point is the usual cause",
        });
      }
    }
    if (input.totalMaxBytes !== undefined) {
      const total = totals.compressedBytes ?? totals.bytes;
      if (total > input.totalMaxBytes) {
        violations.push({
          pattern: "<total>",
          on: parameters.algorithm === "none" ? "raw" : "compressed",
          size: total,
          maxBytes: input.totalMaxBytes,
          overBytes: total - input.totalMaxBytes,
        });
      }
    }

    // --- baseline ---
    let baseline: BaselineInput | undefined = input.baseline;
    if (input.baselineFile !== undefined) {
      const at = resolveSafe("BundleSizeCheck", input.baselineFile);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(at.real, "utf-8"));
      } catch (err) {
        return `baseline file "${at.rel}" is not valid JSON: ${(err as Error).message}`;
      }
      const result = baselineSchema.safeParse(parsed);
      if (!result.success) {
        return `baseline file "${at.rel}" is not a size report: ${result.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`;
      }
      baseline = result.data;
    }

    // Two artifacts that normalise to one key cannot both be "the" successor
    // of the baseline row under it. Pairing either one arbitrarily produces a
    // delta for a file the reader never chose, so both are set aside.
    const byKey = new Map<string, string[]>();
    for (const entry of entries) {
      byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry.path]);
    }
    const ambiguous = [...byKey.entries()]
      .filter(([, hits]) => hits.length > 1)
      .map(([key, hits]) => ({ key, paths: hits }));

    // The growth gate is applied AFTER the baseline block rather than inside
    // it, because the case that matters is the one where the block produces no
    // rows: a build that renames every file joins nothing, and a gate that
    // only walks matched rows then inspects nothing and reports "pass".
    let growth: {
      rows: Array<{ path: string; deltaPercent: number | null }>;
      total: { baseline: number; current: number; deltaPercent: number | null };
    } | null = null;

    let comparison: unknown;
    if (baseline === undefined) {
      comparison = {
        status: "no-baseline",
        why: "no baseline was given, so this report is a measurement, not a comparison",
      };
    } else if (baseline.parameters === undefined) {
      comparison = {
        status: "refused",
        why: "the baseline does not declare the compression parameters it was measured with, so there is no way to know whether its sizes are comparable to these. Re-record it with a report from this tool",
        parameters,
      };
    } else {
      const baselineParameters: CompressionParameters = {
        algorithm: baseline.parameters.algorithm,
        level: baseline.parameters.level,
        tuning: baseline.parameters.tuning ?? {},
      };
      const mismatch =
        parametersMismatch(baselineParameters, parameters) ??
        // The settings agreeing is not enough: the column has to agree too.
        baselineBasisMismatch(parameters.algorithm, baseline.entries);
      if (mismatch !== null) {
        comparison = {
          status: "refused",
          why: mismatch,
          baselineParameters: {
            ...baselineParameters,
            comparabilityKey: comparabilityKey(baselineParameters),
          },
          parameters: { ...parameters, comparabilityKey: comparabilityKey(parameters) },
        };
      } else {
        if (baseline.runtime !== undefined && baseline.runtime.zlib !== ZLIB_VERSION) {
          warnings.push(
            `the baseline was compressed by a different zlib build (${baseline.runtime.zlib} vs ${ZLIB_VERSION}); the parameters match, so the comparison stands, but a handful of bytes may come from the library rather than from the change`,
          );
        }
        const ambiguousKeys = new Set(ambiguous.map((a) => a.key));
        // The baseline is normalised with the SAME mode, and gets the same
        // treatment when two of its rows collapse onto one key: neither is
        // used. Keeping the first would pair the head against whichever row
        // the baseline happened to list first, which is the arbitrary pairing
        // the head-side check already refuses to make.
        const baselineGroups = new Map<
          string,
          Array<{ path: string; bytes: number; compressed: number | null }>
        >();
        for (const entry of baseline.entries) {
          const key = joinKey(entry.path, mode, custom).key;
          baselineGroups.set(key, [
            ...(baselineGroups.get(key) ?? []),
            { path: entry.path, bytes: entry.bytes, compressed: entry.compressedBytes ?? null },
          ]);
        }
        const baselineByKey = new Map<
          string,
          { path: string; bytes: number; compressed: number | null }
        >();
        const baselineDuplicates: string[] = [];
        const baselineSetAside: string[] = [];
        for (const [key, rows] of baselineGroups) {
          const only = rows[0];
          if (rows.length > 1 || only === undefined) {
            baselineDuplicates.push(key);
            ambiguousKeys.add(key);
            continue;
          }
          if (ambiguousKeys.has(key)) {
            // Two HEAD artifacts share this key, so this baseline row has no
            // single successor either. Leaving it in the map drops it out the
            // far end as `removed` — and a reader acts on "removed": they go
            // looking for a deleted chunk that was in fact split in two.
            baselineSetAside.push(only.path);
            continue;
          }
          baselineByKey.set(key, only);
        }
        const matched: unknown[] = [];
        const added: string[] = [];
        for (const entry of entries) {
          if (ambiguousKeys.has(entry.key)) continue;
          const before = baselineByKey.get(entry.key);
          if (before === undefined) {
            added.push(entry.path);
            continue;
          }
          baselineByKey.delete(entry.key);
          const beforeSize = before.compressed ?? before.bytes;
          const afterSize = primarySize(entry);
          matched.push({
            path: entry.path,
            key: entry.key,
            ...(before.path === entry.path ? {} : { baselinePath: before.path }),
            baselineBytes: before.bytes,
            bytes: entry.bytes,
            baselineCompressedBytes: before.compressed,
            compressedBytes: entry.compressedBytes,
            deltaBytes: afterSize - beforeSize,
            deltaPercent: percentDelta(beforeSize, afterSize),
          });
        }
        const removed = [...baselineByKey.values()].map((b) => b.path).sort();
        const baselineTotal = baseline.entries.reduce(
          (acc, e) => acc + (e.compressedBytes ?? e.bytes),
          0,
        );
        const headTotal = totals.compressedBytes ?? totals.bytes;
        const total = {
          baseline: baselineTotal,
          current: headTotal,
          deltaBytes: headTotal - baselineTotal,
          deltaPercent: percentDelta(baselineTotal, headTotal),
        };
        comparison = {
          status: "compared",
          on: parameters.algorithm === "none" ? "raw" : "compressed",
          matched,
          added,
          removed,
          ...(baselineDuplicates.length > 0 ? { baselineAmbiguousKeys: baselineDuplicates } : {}),
          ...(baselineSetAside.length > 0 ? { baselineSetAside } : {}),
          total,
        };
        growth = {
          rows: matched as Array<{ path: string; deltaPercent: number | null }>,
          total,
        };
        if (matched.length === 0 && baseline.entries.length > 0 && mode === "exact") {
          warnings.push(
            'nothing joined against the baseline by exact path. If this build writes content hashes into filenames, every run looks entirely new — re-run with join: "auto"',
          );
        }
      }
    }

    // --- growth ---
    if (input.maxIncreasePercent !== undefined) {
      const limit = input.maxIncreasePercent;
      if (growth === null) {
        const status = (comparison as { status: string }).status;
        // A refusal already lands on `indeterminate`, which is not a green
        // light. "no-baseline" lands on `pass`, so a growth limit declared
        // without a baseline would gate nothing and still report success —
        // the same vacuous pass a budget that matches nothing gets.
        if (status === "no-baseline") {
          violations.push({
            pattern: "<regression>",
            maxIncreasePercent: limit,
            why: "a growth limit was declared but no baseline was given, so nothing was gated on growth",
          });
        }
      } else {
        for (const row of growth.rows) {
          if (row.deltaPercent !== null && row.deltaPercent > limit) {
            violations.push({
              pattern: "<regression>",
              path: row.path,
              deltaPercent: row.deltaPercent,
              maxIncreasePercent: limit,
            });
          }
        }
        // The total, which is the number the gate is actually about. Every
        // matched row can be flat while the bundle doubles: a new chunk is
        // `added`, not matched, and a build that writes a fresh content hash
        // into every filename matches nothing at all under join "exact".
        const totalDelta = growth.total.deltaPercent;
        if (totalDelta !== null && totalDelta > limit) {
          violations.push({
            pattern: "<total-regression>",
            deltaPercent: totalDelta,
            maxIncreasePercent: limit,
            baselineBytes: growth.total.baseline,
            bytes: growth.total.current,
          });
        } else if (totalDelta === null && growth.total.current > growth.total.baseline) {
          violations.push({
            pattern: "<total-regression>",
            maxIncreasePercent: limit,
            baselineBytes: growth.total.baseline,
            bytes: growth.total.current,
            why: "the baseline total is 0 bytes, so growth has no percentage to compare against the limit and this run is larger — the gate could not be applied",
          });
        }
      }
    }

    const refused = (comparison as { status: string }).status === "refused";
    if (ambiguous.length > 0) {
      warnings.push(
        `${ambiguous.length} normalised key(s) cover more than one artifact; those entries are excluded from the comparison rather than paired arbitrarily`,
      );
    }
    const verdict = violations.length > 0 ? "fail" : refused ? "indeterminate" : "pass";

    return json({
      parameters: { ...parameters, comparabilityKey: comparabilityKey(parameters) },
      runtime: { zlib: ZLIB_VERSION },
      join: { mode, ...(ambiguous.length > 0 ? { ambiguous } : {}) },
      entries,
      totals: { files: entries.length, ...totals },
      budgets: { checked: budgets.length, violations },
      comparison,
      ...(warnings.length > 0 ? { warnings } : {}),
      verdict,
    });
  },
});

// --- BenchmarkCompare -------------------------------------------------------

export const benchmarkCompare: RegisteredTool = buildTool({
  name: "BenchmarkCompare",
  description:
    "Compare benchmark samples from two builds and say which differences are real. Use it on the output of a benchmark run at base and at head, instead of a model eyeballing two means. Benchmark timings are right-skewed — a GC pause is a tail event, not noise to average away — so the location estimate is the median and the test is Mann-Whitney, not a t-test on means. Two refusals are the point: a difference inside the noise floor you DECLARE (required, never guessed) is reported as no detectable change however small p is, and below 8 samples per side no significance is called at all, because the normal approximation to U is materially wrong there. At the usual default of 5 runs the answer is 'cannot tell', and this tool says so instead of picking a side. A framework that reports only an aggregate mean per side is compared against the noise floor and explicitly left untested.",
  inputSchema: z
    .object({
      benchmarks: z
        .array(
          z
            .object({
              name: z.string().min(1),
              base: z
                .array(z.number().finite())
                .max(LIMITS.samplesPerSide)
                .optional()
                .describe("per-iteration samples from the base build"),
              head: z.array(z.number().finite()).max(LIMITS.samplesPerSide).optional(),
              baseAggregate: z
                .number()
                .finite()
                .optional()
                .describe("or one pre-aggregated number, when that is all the framework reports"),
              headAggregate: z.number().finite().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.benchmarks),
      noiseFloorPercent: z
        .number()
        .min(0)
        .max(100)
        .describe(
          "required: the smallest relative difference this machine can actually resolve; differences under it are reported as no detectable change",
        ),
      unit: z.string().min(1).optional().describe("what the samples measure, e.g. ms, ns/op"),
      lowerIsBetter: z
        .boolean()
        .optional()
        .describe("true (default) for durations, false for throughput"),
      alpha: z.number().gt(0).lt(1).optional().describe("significance level; default 0.05"),
      collection: z
        .enum(["interleaved", "sequential", "unknown"])
        .optional()
        .describe("how the two sides were sampled; interleaving is what cancels machine drift"),
      continuityCorrection: z
        .boolean()
        .optional()
        .describe("default true, matching R's wilcox.test(correct = TRUE)"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const inputs: BenchmarkInput[] = input.benchmarks.map((b) => ({
      name: b.name,
      ...(b.base === undefined ? {} : { base: b.base }),
      ...(b.head === undefined ? {} : { head: b.head }),
      ...(b.baseAggregate === undefined ? {} : { baseAggregate: b.baseAggregate }),
      ...(b.headAggregate === undefined ? {} : { headAggregate: b.headAggregate }),
    }));
    let report: ReturnType<typeof compareBenchmarks>;
    try {
      report = compareBenchmarks(inputs, {
        noiseFloorPercent: input.noiseFloorPercent,
        ...(input.alpha === undefined ? {} : { alpha: input.alpha }),
        ...(input.lowerIsBetter === undefined ? {} : { lowerIsBetter: input.lowerIsBetter }),
        ...(input.continuityCorrection === undefined
          ? {}
          : { continuityCorrection: input.continuityCorrection }),
      });
    } catch (err) {
      return (err as Error).message;
    }
    const collection = input.collection ?? "unknown";
    const caveats: string[] = [];
    if (collection !== "interleaved") {
      // Machine drift is a bias, not a variance: a base suite run at 09:00 on
      // a cold machine and a head suite at 09:20 on a hot one differ by the
      // machine. No test on the samples can see that, so it is said out loud.
      caveats.push(
        collection === "sequential"
          ? "the two sides were sampled one after the other, so thermal drift and background load are confounded with the change; interleave base and head per benchmark to remove it"
          : "the sampling order was not declared; unless base and head runs were interleaved, machine drift is confounded with the change and no test on these samples can separate them",
      );
    }
    const underpowered = report.benchmarks.filter(
      (b) => b.test !== null && !b.test.normalApproximationValid,
    ).length;
    if (underpowered > 0) {
      caveats.push(
        `${underpowered} benchmark(s) had fewer than ${MIN_SAMPLES_FOR_SIGNIFICANCE} samples on a side; no significance was called for them`,
      );
    }
    return json({
      ...report,
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      collection,
      ...(caveats.length > 0 ? { caveats } : {}),
    });
  },
});

// --- FlakyTestDetect --------------------------------------------------------

export const flakyTestDetect: RegisteredTool = buildTool({
  name: "FlakyTestDetect",
  description:
    "Classify each test across repeated runs as passing, flaky, failing every run or never observed, with a Wilson interval on its failure rate rather than a fail/run ratio. Use it on the results of running a suite several times, to decide what to quarantine. Three failures in five runs is not '60% flaky' — the interval is 23%-88%, which does not distinguish annoying from broken — so the quarantine recommendation keys on the interval's lower bound and says 'run it more' when that bound is not yet clear of the floor. It separates nondeterminism from order dependence when the input carries execution order: for a test that both passed and failed it names the tests that ran before it in every failure and in none of the passes. When every run used the SAME order it reports that the question is undecidable rather than answering 'nondeterministic', and a skipped test is never counted as a pass. One run is always inconclusive.",
  inputSchema: z
    .object({
      runs: z
        .array(
          z
            .object({
              id: z.string().min(1).optional(),
              seed: z
                .string()
                .min(1)
                .optional()
                .describe("the shuffle seed, if the runner has one"),
              tests: z
                .array(
                  z
                    .object({
                      id: z.string().min(1),
                      status: z.enum(TEST_STATUSES),
                      error: z.string().max(10_000).optional(),
                      signature: z
                        .string()
                        .min(1)
                        .optional()
                        .describe("a pre-computed failure signature, e.g. from ErrorCluster"),
                    })
                    .strict(),
                )
                .max(LIMITS.testsPerRun)
                .describe("in execution order"),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.runs),
      confidence: z
        .enum(["0.80", "0.90", "0.95", "0.99"])
        .optional()
        .describe("two-sided confidence for the interval; default 0.95"),
      quarantineLowerBound: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "recommend quarantine only when the interval's LOWER bound clears this; default 0.05",
        ),
      masks: z
        .array(
          z
            .object({
              pattern: z.string().min(1),
              with: z.string().optional(),
              flags: z.string().max(8).optional(),
            })
            .strict(),
        )
        .max(LIMITS.masks)
        .optional()
        .describe(
          "substitutions applied to failure text before grouping; each one's hit count is reported",
        ),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    // The kernel's table is the only place a confidence level is defined in
    // this repository; a literal 1.96 here would be a fourth copy.
    const z = statsKernel.TWO_SIDED_Z[input.confidence ?? "0.95"];
    try {
      return json(
        detectFlaky(input.runs, {
          z,
          ...(input.quarantineLowerBound === undefined
            ? {}
            : { quarantineLowerBound: input.quarantineLowerBound }),
          ...(input.masks === undefined ? {} : { masks: input.masks }),
        }),
      );
    } catch (err) {
      return (err as Error).message;
    }
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const BUILDPERF_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  benchmarkCompare,
  bundleSizeCheck,
  flakyTestDetect,
]);
