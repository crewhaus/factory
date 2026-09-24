/**
 * `@crewhaus/tool-dataset` — the eval dataset as an operation, not a document.
 *
 * Four tools. `DatasetPut` versions a dataset, `DatasetInspect` reports what
 * is in the registry and whether it is intact, `DatasetLint` runs the offline
 * hygiene gate, and `DatasetMine` grows the dataset from sessions the harness
 * already produced. Everything they know lives in `@crewhaus/dataset-ops`,
 * `@crewhaus/dataset-registry` and `@crewhaus/eval-dataset`; what this package
 * adds is the schema, the containment, the refusals and a result shape a model
 * can act on.
 *
 * FIVE PROPERTIES HOLD ACROSS ALL FOUR.
 *
 * 1. **THE RULES ARE NOT RE-DERIVED HERE.** The lint rules, the PII detector
 *    set, the mining signals, the provenance taxonomy, the canary derivation,
 *    the per-sample hash, the version ordering and the sample schema are all
 *    imported. This package contains exactly one piece of dataset logic of its
 *    own — carrying split assignments forward across a re-put (see
 *    `./lib/splits.ts`) — and it exists because the shipped assignment is
 *    measurably not stable under additions, which is the one property a
 *    versioned dataset has to have.
 *
 * 2. **SPLIT STABILITY IS MEASURED, NOT CLAIMED.** Every `DatasetPut` reports
 *    which rows changed split versus the version it was based on, computed the
 *    same way in both modes. `stable` reports an empty list because the check
 *    ran, not because the mode's name says so. A put that cannot READ the
 *    previous version refuses rather than writing a version whose lineage it
 *    cannot vouch for.
 *
 * 3. **"COULD NOT DETERMINE" IS NOT "NO".** A registry root that does not
 *    exist, a record that is on disk but is not JSON, a near-duplicate scan
 *    the dataset was too large for, a lint rule with no graders to check
 *    against, a mining signal whose trace sidecar was never written, a listing
 *    that hit its cap — each is a named status in the result, never an empty
 *    list. An empty dataset and an unreadable one are different answers, and a
 *    caller that reads "clean" acts on it.
 *
 * 4. **NOTHING LEAVES THE PROCESS, AND NOTHING SENSITIVE COMES BACK.** No
 *    network, no subprocess, no clock in any digest. The PII audit reports
 *    counts and sample ids and never the matched text — a hit echoed into a
 *    model's context is the leak the audit exists to catch. The same reasoning
 *    applies to the B18 canary: its phrase is never echoed, because a tool
 *    result IS prompt-side text, and a phrase that reaches the prompt is
 *    exactly the contamination it was planted to detect.
 *
 * 5. **CONTAINMENT, INCLUDING THE ENVIRONMENT'S OPINION.** Every caller path
 *    goes through `resolveSafe` (copied from `@crewhaus/tool-pkg`), and so
 *    does `CREWHAUS_DATASETS_DIR` — an exported variable cannot point these
 *    tools at a registry outside the workspace, and every result says which
 *    root it actually used.
 *
 * WHAT THESE TOOLS DO NOT DO. They never run an eval, never call a model,
 * never synthesize samples (the `dataset synthesize` paraphrase path is
 * model-backed and deliberately absent), and never delete or overwrite a
 * version — the registry's versions are immutable and `allowOverwrite` is not
 * reachable from any schema here.
 */
import { readFileSync, statSync } from "node:fs";
import {
  DEFAULT_SPLIT_SPEC,
  type LintFinding,
  NEAR_DUP_THRESHOLD,
  REGISTRY_PREFIX,
  type RegistryRef,
  SOURCE_TAXONOMY,
  auditSamples,
  canaryPhrasesIn,
  canarySample,
  candidateToSample,
  containsRedactionMarker,
  dedupeCandidates,
  egressBlocksFromAudit,
  findDuplicateIds,
  inspectRegistryRef,
  lintDataset,
  lintGraderSpecOf,
  mineSession,
  nextVersion,
  offTaxonomySources,
  parseRegistryRef,
  parseSplitSpec,
  promoteVerifiedSynthetics,
  redactDatasetText,
  redactSample,
  sampleSource,
} from "@crewhaus/dataset-ops";
import {
  type DatasetRecord,
  type DatasetSplit,
  hashSample,
  overallDatasetHash,
  verifySplitHashes,
} from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  DEFAULT_DEDUPE_PARAMS,
  type DedupeParams,
  MAX_INDEXED_SAMPLES,
  buildDedupeIndex,
  classifyCandidate,
} from "./lib/dedupe";
import {
  type RegistryRoot,
  allSamplesOf,
  assignmentOf,
  listDatasets,
  listVersions,
  openRegistry,
  presentSplits,
  readRecord,
  resolveRegistryRoot,
  splitSamplesOf,
} from "./lib/registry";
import { type Loaded, errorMessage, fail, json, renderGiven, renderMessage } from "./lib/result";
import { MAX_SAMPLES, goldCount, loadSamplesFromFile, parseInlineSamples } from "./lib/samples";
import {
  AUDIT_REL,
  type AuditRead,
  SESSIONS_REL,
  checkSessionId,
  listSessions,
  readAuditRecords,
  readJsonl,
  resolveDir,
  sessionRel,
  traceRel,
} from "./lib/sessions";
import { type SplitMode, planSplits, splitCounts } from "./lib/splits";
import { ToolPermissionError, resolveSafe } from "./paths";

export { ToolPermissionError } from "./paths";
export { planSplits, splitCounts, type SplitMode, type SplitPlan } from "./lib/splits";
export { buildDedupeIndex, classifyCandidate, DEFAULT_DEDUPE_PARAMS } from "./lib/dedupe";

/** How many samples the PII audit will scan in one call. Past this the audit
 *  is reported as SKIPPED — never as clean. */
const MAX_AUDITED_SAMPLES = 20_000;

/** How many mined candidates one call returns. */
const DEFAULT_MAX_CANDIDATES = 200;

/** How many sessions one mining call reads. */
const DEFAULT_MAX_SESSIONS = 50;

/** Records read out of one session transcript or audit log. */
const MAX_RECORDS_PER_FILE = 500_000;

/** A file scanned for a canary phrase (a spec, a few-shot pool). */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Ids spelled out in a result before eliding. */
const MAX_LISTED_IDS = 50;

/** Datasets listed in one registry-wide inspect before the list is a prefix. */
const MAX_LISTED_DATASETS = 200;

const registryDirField = z
  .string()
  .optional()
  .describe(
    "the dataset registry root, relative to the working directory; omitted, CREWHAUS_DATASETS_DIR is used when it is set and points inside the workspace, else .crewhaus/datasets",
  );

const datasetRefField = z
  .string()
  .describe(
    "the dataset as <name>[@version][#split] (the registry: prefix is accepted and optional); without @version the newest version is used",
  );

/** Sample ids for a result. Ids come out of a caller's file, so they are
 *  rendered rather than pasted: an id carrying an ANSI escape or a newline
 *  would otherwise forge output in whatever reads this. */
function listIds(ids: ReadonlyArray<string>): { ids: string[]; elided?: number } {
  const shown = ids.slice(0, MAX_LISTED_IDS).map(renderGiven);
  return ids.length <= MAX_LISTED_IDS
    ? { ids: shown }
    : { ids: shown, elided: ids.length - MAX_LISTED_IDS };
}

/**
 * Parse a dataset reference. The `registry:` prefix is optional here because
 * these tools only ever address the registry — but the PARSED value is what
 * everything downstream uses, never the caller's string: a split suffix, a
 * version and a name are three different fields and reading them off the
 * original text twice is how they drift apart.
 */
function parseDatasetRef(value: string): Loaded<RegistryRef> {
  const withPrefix = value.startsWith(REGISTRY_PREFIX) ? value : `${REGISTRY_PREFIX}${value}`;
  try {
    const ref = parseRegistryRef(withPrefix);
    if (ref === undefined) {
      return fail("bad-input", `"${renderGiven(value)}" is not a dataset reference`);
    }
    return { ok: true, value: ref };
  } catch (err) {
    return fail("bad-input", errorMessage(err));
  }
}

/** Resolve the registry root and open the registry, or explain why not. */
function openRoot(
  toolName: string,
  given?: string,
): Loaded<{ root: RegistryRoot; registry: ReturnType<typeof openRegistry> }> {
  const root = resolveRegistryRoot(toolName, given);
  if (!root.ok) return root;
  return { ok: true, value: { root: root.value, registry: openRegistry(root.value) } };
}

/** The `metadata.source` histogram of a sample set — provenance at a glance,
 *  with sourceless samples counted rather than dropped. */
function sourceHistogram(samples: ReadonlyArray<Sample>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) {
    const key = sampleSource(s) ?? "(none)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

type AuditSummary =
  | {
      readonly status: "scanned";
      readonly samplesScanned: number;
      readonly samplesWithHits: number;
      readonly totalHits: number;
      readonly byKind: Record<string, number>;
      /** (sample, field, detector) rows found — `hits` below is a PREFIX of
       *  this many, which is not the same number as `totalHits`. */
      readonly hitGroups: number;
      readonly hits: Array<{ sampleId?: string; field: string; kind: string; count: number }>;
      readonly hitsElided?: number;
      readonly note: string;
    }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * The PII/secret audit, summarized for a result. `withheldIds` names samples
 * whose id must not be echoed (the locked test split without
 * `allowTestSplit`): their hits still COUNT — a leak in the holdout is still a
 * leak — they just arrive without the id.
 */
function auditSummary(
  samples: ReadonlyArray<Sample>,
  withheldIds: ReadonlySet<string> = new Set(),
): AuditSummary {
  if (samples.length > MAX_AUDITED_SAMPLES) {
    return {
      status: "skipped",
      reason: `${samples.length} samples is over the ${MAX_AUDITED_SAMPLES} audit cap — this is NOT a clean result; audit a split at a time`,
    };
  }
  const report = auditSamples(samples);
  const byKind: Record<string, number> = {};
  for (const hit of report.hits) byKind[hit.kind] = (byKind[hit.kind] ?? 0) + hit.count;
  return {
    status: "scanned",
    samplesScanned: report.samplesScanned,
    samplesWithHits: report.samplesWithHits,
    totalHits: report.totalHits,
    byKind,
    // The list is CUT here, and a cut list that does not say so reads as the
    // whole story: `totalHits` counts matches, `hitGroups` counts the
    // (sample, field, detector) rows this list is a prefix of.
    hitGroups: report.hits.length,
    hits: report.hits.slice(0, MAX_LISTED_IDS).map((h) => ({
      ...(withheldIds.has(h.sampleId) ? {} : { sampleId: h.sampleId }),
      field: h.field,
      kind: h.kind,
      count: h.count,
    })),
    ...(report.hits.length > MAX_LISTED_IDS
      ? { hitsElided: report.hits.length - MAX_LISTED_IDS }
      : {}),
    note: "matched text is never echoed — inspect the listed samples by id",
  };
}

/**
 * The egress-block signal, which is a report about a LOG rather than about a
 * harness. Every way of not knowing is a different answer here:
 *
 *   - the audit directory is absent or refused  → unavailable, with the reason
 *   - it holds no `.jsonl` at all               → unavailable ("nothing was
 *                                                 written", not "nothing was
 *                                                 blocked")
 *   - every file in it failed to open           → unavailable, naming them
 *   - some opened, some did not / the record
 *     cap cut the read                          → available but PARTIAL
 *
 * Only the last-but-one of those used to exist: a directory of unreadable
 * files reported `available: true` with an empty block list, which is a
 * permission error rendered as a clean bill of health.
 */
function egressSignal(auditDirGiven: string, read: Loaded<AuditRead>): Record<string, unknown> {
  const auditDir = renderGiven(auditDirGiven);
  if (!read.ok) return { available: false, auditDir, reason: read.message };
  const { records, malformed, truncated, filesRead, filesSkipped } = read.value;
  if (filesRead === 0) {
    return {
      available: false,
      auditDir,
      reason:
        filesSkipped.length > 0
          ? `every audit file under "${auditDir}" failed to open (${renderMessage(filesSkipped.join("; "))}) — this is a read failure, NOT an absence of egress blocks`
          : `"${auditDir}" holds no .jsonl audit file — nothing was ever written here, which is not the same as nothing having been blocked`,
      ...(filesSkipped.length > 0 ? { filesSkipped } : {}),
    };
  }
  const blocks = egressBlocksFromAudit(records);
  const partial = filesSkipped.length > 0 || truncated;
  return {
    available: true,
    auditDir,
    filesRead,
    ...(partial
      ? {
          partial: true,
          partialReason: truncated
            ? `the audit log exceeded ${MAX_RECORDS_PER_FILE} records — the blocks below are from a prefix of it`
            : "some audit files could not be opened — the blocks below are from the ones that could",
        }
      : {}),
    ...(filesSkipped.length > 0 ? { filesSkipped } : {}),
    malformedLines: malformed,
    blockCount: blocks.length,
    blocks: blocks.slice(0, MAX_LISTED_IDS),
    ...(blocks.length > MAX_LISTED_IDS ? { blocksElided: blocks.length - MAX_LISTED_IDS } : {}),
    note: "egress blocks are reported, not turned into samples: the audit record carries no turn input, and a sample whose input is an error string teaches nothing",
  };
}

// ---------------------------------------------------------------------------
// DatasetPut
// ---------------------------------------------------------------------------

const putSchema = z.object({
  name: z.string().min(1).max(200).describe("the dataset name in the registry"),
  samples: z
    .array(z.unknown())
    .optional()
    .describe(
      "the samples inline ({id, input, expected_output?, expected_tools?, history?, metadata?}); pass this or path, not both",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "a dataset file inside the workspace instead (.jsonl, .ndjson, .csv, .yaml, .yml) — never a URL",
    ),
  splitSpec: z
    .string()
    .optional()
    .describe(
      `train/dev or train/dev/test integer percentages summing to 100, e.g. "70/15/15" (default ${DEFAULT_SPLIT_SPEC.train}/${DEFAULT_SPLIT_SPEC.dev}/${DEFAULT_SPLIT_SPEC.test})`,
    ),
  split: z
    .enum(["train", "dev", "test"])
    .optional()
    .describe("put every sample into this one split instead of splitting"),
  splitMode: z
    .enum(["stable", "recompute"])
    .optional()
    .describe(
      "stable (default) keeps every existing row in the split it is already in and assigns only the new rows; recompute re-runs the percentage split over everything, which moves rows and invalidates baselines keyed on this dataset",
    ),
  basedOn: z
    .string()
    .optional()
    .describe("the version whose split assignment is carried forward (default: the newest)"),
  canary: z
    .boolean()
    .optional()
    .describe("inject this version's deterministic contamination tripwire sample"),
  redact: z
    .boolean()
    .optional()
    .describe(
      "PII/secret-redact every free-text field before writing (the same detector set the ingestion paths use)",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("resolve the version, the splits and the hash but write nothing"),
  registryDir: registryDirField,
});

export const datasetPut: RegisteredTool = buildTool({
  name: "DatasetPut",
  operativeArgs: [
    { field: "registryDir", kind: "path" },
    { field: "name", kind: "id" },
  ],
  description:
    "Write samples to the dataset registry as a new, auto-bumped, immutable version, keeping every existing row in the split it is already in. Use it to grow an eval dataset without invalidating the baselines keyed on it: the result names every row that changed split (none, in the default mode) and every row the previous version had that this one drops. It never overwrites a version and never deletes one; it reports PII/secret hit counts in what it wrote without ever echoing a match, and dryRun resolves the same version, splits and content hash the real call would write.",
  inputSchema: putSchema,
  // Not because it deletes anything — versions are immutable and this tool
  // cannot reach `allowOverwrite`. Because a new version becomes what every
  // bare `registry:<name>` ref resolves to, so a careless put silently
  // changes which data every eval of that dataset runs on.
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    const toolName = "DatasetPut";
    if ((input.samples === undefined) === (input.path === undefined)) {
      return `${toolName}: pass either "samples" (inline) or "path" (a dataset file), not both and not neither`;
    }
    if (input.split !== undefined && input.splitSpec !== undefined) {
      return `${toolName}: "split" puts everything in one split and "splitSpec" divides them — pass one or the other`;
    }
    const opened = openRoot(toolName, input.registryDir);
    if (!opened.ok) return opened.message;
    const { root, registry } = opened.value;

    const versions = await listVersions(registry, input.name);
    if (!versions.ok) return `${toolName}: ${versions.message}`;

    let samples: Sample[];
    if (input.path !== undefined) {
      const loaded = await loadSamplesFromFile(toolName, input.path);
      if (!loaded.ok) return `${toolName}: ${loaded.message}`;
      if (loaded.value.truncated) {
        // A version written from a truncated read is a version that silently
        // lost rows — the one case where a cap must refuse rather than report.
        return `${toolName}: "${renderGiven(input.path)}" holds more than ${MAX_SAMPLES} samples — this tool will not write a version from a partial read`;
      }
      samples = loaded.value.samples;
    } else {
      const parsed = parseInlineSamples(input.samples ?? []);
      if (!parsed.ok) return `${toolName}: ${parsed.message}`;
      samples = parsed.value;
    }
    if (samples.length === 0) {
      return `${toolName}: no samples to write — a version with no rows has no lineage to carry`;
    }

    // The registry stores whatever it is given; duplicate ids corrupt the
    // per-sample artifact dirs and the id-keyed regression flips downstream.
    // The lint's own rule, not a second copy of it — but the RULE, not the
    // whole lint: `lintDataset` would also run the all-pairs near-duplicate
    // scan over every row on the WRITE path, millions of comparisons to
    // answer a set-membership question.
    const duplicates = findDuplicateIds(samples);
    if (duplicates.length > 0) {
      return `${toolName}: refusing to write a version with duplicate sample ids — ${renderMessage(
        duplicates.map((f) => f.message).join("; "),
      )}`;
    }

    const redaction = {
      applied: input.redact === true,
      samplesAltered: 0,
      goldsAltered: [] as string[],
    };
    if (input.redact === true) {
      const redacted = samples.map((s) => redactSample(s));
      for (const [i, after] of redacted.entries()) {
        const before = samples[i] as Sample;
        if (JSON.stringify(before) !== JSON.stringify(after)) redaction.samplesAltered += 1;
        // A gold that redaction rewrote can never be matched by a string
        // grader at eval time, because the agent's live output is not
        // redacted. Reported, not fixed: only the caller knows which it wants.
        if (
          after.expected_output !== undefined &&
          after.expected_output !== before.expected_output &&
          containsRedactionMarker(after.expected_output)
        ) {
          redaction.goldsAltered.push(after.id);
        }
      }
      samples = redacted;
    }

    const version = nextVersion(versions.value);
    // The id is READ OFF the sample that is actually written, never re-spelled
    // here: `canary_<name>_<version>` is `canarySampleId`'s rule, and a second
    // copy of it would hand the caller an id that does not exist the first
    // time the reserved prefix changes. The id is all the caller gets — the
    // PHRASE is deliberately never echoed.
    let canaryId: string | undefined;
    if (input.canary === true) {
      const canary = canarySample(input.name, version);
      canaryId = canary.id;
      samples = [...samples, canary];
    }

    // B22, the registry's synthetic-never-gold invariant: `registry.put`
    // THROWS on a `source: synthetic` sample carrying an expected_output. A
    // dry run that skips it predicts a write the real call refuses — the
    // parallel-preview drift house rule 7 exists to prevent — so both paths
    // ask the same question here, before either of them plans anything.
    // The condition is not re-derived: `promoteVerifiedSynthetics` is
    // dataset-ops' own retag rule, and the samples it rewrites are exactly
    // the ones the registry rejects.
    const promoted = promoteVerifiedSynthetics(samples);
    const syntheticGolds = samples
      .filter((s, i) => sampleSource(promoted[i] as Sample) !== sampleSource(s))
      .map((s) => s.id);
    if (syntheticGolds.length > 0) {
      return `${toolName}: ${syntheticGolds.length} sample(s) are tagged metadata.source: "synthetic" and carry an expected_output — synthetic samples never define the gold standard, and the registry refuses the write; set metadata.source to "synthetic_human_verified" on ${renderMessage(listIds(syntheticGolds).ids.join(", "))} if a human verified those golds`;
    }

    let spec = DEFAULT_SPLIT_SPEC;
    if (input.splitSpec !== undefined) {
      try {
        spec = parseSplitSpec(input.splitSpec);
      } catch (err) {
        return `${toolName}: ${errorMessage(err)}`;
      }
    }

    // The previous version's assignment is the ground truth stability is
    // carried forward from. If it cannot be READ, this call cannot promise
    // anything about lineage — and writing anyway is exactly the failure this
    // package is built around, so it refuses instead.
    const basedOn = input.basedOn ?? versions.value[versions.value.length - 1];
    let previous: Map<string, DatasetSplit> | undefined;
    if (basedOn !== undefined) {
      if (input.basedOn !== undefined && !versions.value.includes(input.basedOn)) {
        return `${toolName}: basedOn "${renderGiven(input.basedOn)}" is not a version of "${renderGiven(input.name)}" (have: ${versions.value.join(", ") || "none"})`;
      }
      const record = await readRecord(registry, input.name, basedOn);
      if (!record.ok) {
        return `${toolName}: the previous version "${renderGiven(basedOn)}" could not be read (${record.message}) — refusing to write a version whose split lineage cannot be verified; pass basedOn to choose another version`;
      }
      previous = assignmentOf(record.value);
    }

    const mode: SplitMode = input.splitMode ?? "stable";
    const plan = planSplits({
      samples,
      spec,
      ...(previous !== undefined ? { previous } : {}),
      mode,
      ...(input.split !== undefined ? { singleSplit: input.split } : {}),
    });

    // The hash a real put will store, derived the way the registry derives it
    // (its own `hashSample`, its own canonical fold) so the dry run predicts
    // the write rather than describing a parallel one.
    const planned: DatasetRecord = {
      name: input.name,
      version,
      splits: plan.splits,
      sampleHashes: {
        train: plan.splits.train.map(hashSample),
        dev: plan.splits.dev.map(hashSample),
        ...(plan.splits.test !== undefined ? { test: plan.splits.test.map(hashSample) } : {}),
      },
      createdAt: "",
    };
    const datasetHash = overallDatasetHash(planned, presentSplits(planned));

    const provenance = [...offTaxonomySources(samples)].map(([source, ids]) => ({
      source,
      count: ids.length,
      ...listIds(ids),
      note: `outside the provenance taxonomy (${SOURCE_TAXONOMY.join(" | ")}) — imported anyway`,
    }));

    const warnings: string[] = [];
    if (plan.moved.length > 0) {
      warnings.push(
        `${plan.moved.length} row(s) changed split — every baseline keyed on this dataset compares different data from here on`,
      );
    }
    if (plan.dropped.length > 0) {
      warnings.push(
        `${plan.dropped.length} row(s) present in "${basedOn}" are not in this version`,
      );
    }
    if (redaction.goldsAltered.length > 0) {
      warnings.push(
        `redaction rewrote ${redaction.goldsAltered.length} expected_output value(s) — string-matching graders can never match a redacted gold`,
      );
    }

    const result = {
      name: input.name,
      version,
      registryRoot: root.rel,
      registryRootSource: root.source,
      sampleCount: samples.length,
      splits: splitCounts(plan.splits),
      golds: goldCount(samples),
      datasetHash,
      splitMode: mode,
      ...(input.split !== undefined ? { singleSplit: input.split } : {}),
      splitSpec: input.split !== undefined ? null : `${spec.train}/${spec.dev}/${spec.test}`,
      stability: {
        basedOn: basedOn ?? null,
        carriedForward: plan.carriedForward,
        newlyAssigned: plan.newlyAssigned,
        movedCount: plan.moved.length,
        moved: plan.moved.slice(0, MAX_LISTED_IDS),
        droppedCount: plan.dropped.length,
        ...listIds(plan.dropped),
      },
      ...(canaryId !== undefined
        ? {
            canary: {
              sampleId: canaryId,
              note: "the phrase itself is not echoed — a tool result is prompt-side text, and a canary that reaches the prompt is the contamination it exists to detect",
            },
          }
        : {}),
      redaction,
      provenanceWarnings: provenance,
      pii: auditSummary(samples),
      warnings,
    };

    if (input.dryRun === true) {
      return json({ wrote: false, dryRun: true, ...result });
    }
    try {
      // The registry computes the per-sample hashes and the timestamp itself;
      // this call hands it exactly what the dry run above described.
      const written = await registry.put({ name: input.name, version, splits: plan.splits });
      return json({ wrote: true, createdAt: written.createdAt, ...result });
    } catch (err) {
      return `${toolName}: the registry refused the write — ${errorMessage(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// DatasetInspect
// ---------------------------------------------------------------------------

const inspectSchema = z.object({
  dataset: z
    .string()
    .optional()
    .describe(
      "the dataset to inspect as <name>[@version] (the registry: prefix is accepted and optional); without @version the newest version is used; a #split suffix is refused, because this tool reports every split; omitted, every dataset in the registry is listed instead",
    ),
  allowTestSplit: z
    .boolean()
    .optional()
    .describe(
      "echo per-sample detail (ids, PII hit locations) for the locked test split; counts and hashes are reported either way",
    ),
  includeSampleIds: z.boolean().optional().describe("list the sample ids of each split"),
  audit: z
    .boolean()
    .optional()
    .describe("run the offline PII/secret scan over the version's samples (default true)"),
  registryDir: registryDirField,
});

export const datasetInspect: RegisteredTool = buildTool({
  name: "DatasetInspect",
  description:
    "Report what a dataset registry holds and whether it is intact: versions, split sizes, gold coverage, provenance, releases, the stored-vs-recomputed sample hashes, and PII/secret hit counts. Use it before trusting a dataset — a version whose stored hashes no longer match its samples has had its eval identity silently diverge from its content, and this is what says so. A version that cannot be read is reported as unreadable, never as absent, and per-sample detail for the locked test split is withheld unless you ask for it, because inspection is how a holdout quietly gets burned.",
  inputSchema: inspectSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const toolName = "DatasetInspect";
    const opened = openRoot(toolName, input.registryDir);
    if (!opened.ok) return opened.message;
    const { root, registry } = opened.value;
    const rootFacts = {
      registryRoot: root.rel,
      registryRootSource: root.source,
      registryExists: root.exists,
    };
    if (!root.exists) {
      return json({
        ...rootFacts,
        datasets: [],
        note: "no registry at this root — nothing has been written here yet (this is not an empty registry, it is an absent one)",
      });
    }

    if (input.dataset === undefined) {
      const names = await listDatasets(registry);
      if (!names.ok) return `${toolName}: ${names.message}`;
      const listed = names.value.slice(0, MAX_LISTED_DATASETS);
      const datasets: Array<Record<string, unknown>> = [];
      for (const name of listed) {
        const versions = await listVersions(registry, name);
        if (!versions.ok) {
          datasets.push({ name, status: "unreadable", reason: versions.message });
          continue;
        }
        datasets.push({
          name,
          versionCount: versions.value.length,
          versions: versions.value,
          latest: versions.value[versions.value.length - 1] ?? null,
        });
      }
      return json({
        ...rootFacts,
        datasetCount: names.value.length,
        ...(names.value.length > listed.length
          ? {
              truncated: true,
              note: `${names.value.length} datasets, showing the first ${MAX_LISTED_DATASETS} by name`,
            }
          : {}),
        datasets,
      });
    }

    const ref = parseDatasetRef(input.dataset);
    if (!ref.ok) return `${toolName}: ${ref.message}`;
    // A `#split` suffix PARSES here and this tool reports every split, so
    // acting as if it had not been written would answer a question about the
    // whole dataset under a reference that asks about one split — a
    // `sampleCount` read as a split's size. House rule: act on the parsed
    // value or refuse it; never parse it and carry on with something else.
    if (ref.value.split !== undefined) {
      return `${toolName}: "${renderGiven(input.dataset)}" names the "${ref.value.split}" split, and this tool reports every split of a version (per-split counts, golds and hashes are in "splits") — drop the #${ref.value.split} suffix, and pass allowTestSplit to see per-sample detail for the holdout`;
    }
    const versions = await listVersions(registry, ref.value.name);
    if (!versions.ok) return `${toolName}: ${versions.message}`;
    if (versions.value.length === 0) {
      return json({
        ...rootFacts,
        name: ref.value.name,
        versions: [],
        status: "absent",
        reason: `no versions of "${ref.value.name}" in this registry`,
      });
    }
    const version = ref.value.version ?? (versions.value[versions.value.length - 1] as string);
    const record = await readRecord(registry, ref.value.name, version);
    if (!record.ok) {
      // A torn record is a finding, not a missing dataset: the write DID
      // happen and something else is wrong.
      return json({
        ...rootFacts,
        name: ref.value.name,
        version,
        versions: versions.value,
        status: record.code === "missing" ? "absent" : "unreadable",
        reason: record.message,
      });
    }

    const splits = presentSplits(record.value);
    const withheld = new Set<string>();
    const testDetailWithheld = splits.includes("test") && input.allowTestSplit !== true;
    if (testDetailWithheld) {
      for (const s of splitSamplesOf(record.value, "test")) withheld.add(s.id);
    }

    const splitFacts: Record<string, unknown> = {};
    for (const split of splits) {
      const rows = splitSamplesOf(record.value, split);
      const ids = rows.map((s) => s.id);
      splitFacts[split] = {
        count: rows.length,
        golds: goldCount(rows),
        ...(input.includeSampleIds === true && !(split === "test" && testDetailWithheld)
          ? listIds(ids)
          : {}),
        ...(split === "test" && testDetailWithheld ? { detailWithheld: true } : {}),
      };
    }

    // The stored hashes are what the run history keys on. Absent hashes and
    // WRONG hashes are different failures and must not collapse into one.
    const mismatches = verifySplitHashes(record.value);
    const hashesAbsent =
      splits.length > 0 &&
      (record.value.sampleHashes === undefined ||
        splits.every((s) => record.value.sampleHashes?.[s] === undefined));
    let hashes: Record<string, unknown>;
    if (hashesAbsent) {
      hashes = {
        status: "unavailable",
        reason:
          "the record carries samples but no stored sample hashes — its content identity cannot be verified or even computed (hand-written or pre-registry record)",
      };
    } else {
      let overall: string | undefined;
      // The registry THROWS rather than hashing a record whose splits carry no
      // hashes, on purpose — an empty digest would let two different datasets
      // compare equal. Its reason is kept: "could not be computed" without one
      // is the same non-answer this package exists to avoid.
      let hashFailure: string | undefined;
      try {
        overall = overallDatasetHash(record.value, splits);
      } catch (err) {
        overall = undefined;
        hashFailure = errorMessage(err);
      }
      hashes =
        overall === undefined
          ? {
              status: "unavailable",
              reason: hashFailure ?? "the overall content hash could not be computed",
            }
          : {
              status: mismatches.length === 0 ? "verified" : "mismatched",
              overall,
              mismatchCount: mismatches.length,
              mismatches: mismatches.slice(0, MAX_LISTED_IDS).map((m) => ({
                split: m.split,
                index: m.index,
                ...(m.sampleId !== undefined && !withheld.has(m.sampleId)
                  ? { sampleId: m.sampleId }
                  : {}),
                storedHash: m.storedHash ?? null,
                actualHash: m.actualHash ?? null,
              })),
              ...(mismatches.length > 0
                ? {
                    note: "stored hashes no longer match the samples — this version's eval identity has diverged from its content",
                  }
                : {}),
            };
    }

    const samples = allSamplesOf(record.value);
    const canaries = samples.filter((s) => sampleSource(s) === "canary").map((s) => s.id);
    return json({
      ...rootFacts,
      name: record.value.name,
      version,
      resolvedFrom: ref.value.version === undefined ? "latest" : "pinned",
      versions: versions.value,
      createdAt: record.value.createdAt ?? null,
      sampleCount: samples.length,
      golds: goldCount(samples),
      splits: splitFacts,
      testSplit: {
        present: splits.includes("test"),
        detailWithheld: testDetailWithheld,
        ...(testDetailWithheld
          ? { note: "pass allowTestSplit to see per-sample detail for the held-out split" }
          : {}),
      },
      hashes,
      sources: sourceHistogram(samples),
      offTaxonomySources: [...offTaxonomySources(samples)].map(([source, ids]) => ({
        source,
        count: ids.length,
      })),
      canary: { count: canaries.length, sampleIds: canaries.filter((id) => !withheld.has(id)) },
      releases: record.value.releases ?? [],
      pii:
        input.audit === false
          ? { status: "skipped", reason: "audit was turned off by the caller — not a clean result" }
          : auditSummary(samples, withheld),
    });
  },
});

// ---------------------------------------------------------------------------
// DatasetLint
// ---------------------------------------------------------------------------

const graderField = z
  .array(
    z.object({
      name: z.string(),
      type: z.string(),
      grader: z.string().optional().describe('the registry pack ref for type: "registry"'),
      opts: z.record(z.unknown()).optional(),
    }),
  )
  .optional()
  .describe(
    "the graders this dataset will be run with (the entries of a graders.yaml), so gold-needing graders can be checked against the samples that carry no gold",
  );

const lintSchema = z.object({
  dataset: datasetRefField.optional(),
  path: z
    .string()
    .optional()
    .describe("a dataset file inside the workspace instead (.jsonl, .ndjson, .csv, .yaml, .yml)"),
  samples: z.array(z.unknown()).optional().describe("the samples inline instead"),
  graders: graderField,
  specHasTools: z
    .boolean()
    .optional()
    .describe(
      "whether the spec these samples run against exposes any tools; omitted, the expected_tools rule is reported as not evaluated rather than as passing",
    ),
  leakScanPaths: z
    .array(z.string())
    .optional()
    .describe(
      "files whose text is scanned for this dataset's canary phrases — the spec, few-shot pools, anything prompt-side",
    ),
  crossVersion: z
    .boolean()
    .optional()
    .describe(
      "check the other versions of a registry dataset for ids reused with different content (default true for a registry dataset)",
    ),
  registryDir: registryDirField,
});

export const datasetLint: RegisteredTool = buildTool({
  name: "DatasetLint",
  description:
    "Run the offline eval-dataset hygiene gate over a registry dataset or a local file: duplicate ids, empty golds, near-duplicate inputs, ids reused across versions with different content, graders that need a gold the samples do not carry, expected_tools a tool-less spec can never satisfy, off-taxonomy provenance, and canary phrases leaked into prompt-side text. Use it before an eval run rather than after paying for one. Every rule the call could not evaluate — no graders passed, no other versions, nothing to scan for a leak, a dataset too large for the all-pairs near-duplicate scan — is listed as not evaluated, so a short finding list is never mistaken for a clean dataset.",
  inputSchema: lintSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const toolName = "DatasetLint";
    const sources = [input.dataset, input.path, input.samples].filter((v) => v !== undefined);
    if (sources.length !== 1) {
      return `${toolName}: pass exactly one of "dataset", "path" or "samples"`;
    }

    let samples: Sample[];
    let label: string;
    let otherVersions: Array<{ version: string; samples: Sample[] }> | undefined;
    const skippedVersions: string[] = [];
    let version: string | undefined;
    /** True when the samples linted are a PREFIX of the source, so no finding
     *  count and no "clean" is about the whole dataset. */
    let truncated = false;

    if (input.dataset !== undefined) {
      const ref = parseDatasetRef(input.dataset);
      if (!ref.ok) return `${toolName}: ${ref.message}`;
      const opened = openRoot(toolName, input.registryDir);
      if (!opened.ok) return opened.message;
      const { registry } = opened.value;
      let inspected: Awaited<ReturnType<typeof inspectRegistryRef>>;
      try {
        // The read-side resolver: every split, test included. A hygiene gate
        // over a partial record misreports — PII in the holdout is still PII.
        inspected = await inspectRegistryRef(registry, ref.value);
      } catch (err) {
        return `${toolName}: ${errorMessage(err)}`;
      }
      samples = inspected.samples;
      version = inspected.version;
      label = inspected.datasetName;
      if (input.crossVersion !== false) {
        const versions = await listVersions(registry, ref.value.name);
        if (!versions.ok) return `${toolName}: ${versions.message}`;
        otherVersions = [];
        for (const other of versions.value) {
          if (other === inspected.version) continue;
          const record = await readRecord(registry, ref.value.name, other);
          if (!record.ok) {
            // A version that could not be read is a version this rule did not
            // check — said out loud, not dropped.
            skippedVersions.push(`${other}: ${record.message}`);
            continue;
          }
          otherVersions.push({ version: other, samples: allSamplesOf(record.value) });
        }
      }
    } else if (input.path !== undefined) {
      const loaded = await loadSamplesFromFile(toolName, input.path);
      if (!loaded.ok) return `${toolName}: ${loaded.message}`;
      samples = loaded.value.samples;
      label = renderGiven(input.path);
      truncated = loaded.value.truncated;
    } else {
      const parsed = parseInlineSamples(input.samples ?? []);
      if (!parsed.ok) return `${toolName}: ${parsed.message}`;
      samples = parsed.value;
      label = "inline samples";
    }

    const leakScanTexts: Array<{ label: string; text: string }> = [];
    const leakScanSkipped: string[] = [];
    for (const rel of input.leakScanPaths ?? []) {
      const read = readScanText(toolName, rel);
      if (read.ok) leakScanTexts.push({ label: renderGiven(rel), text: read.value });
      else leakScanSkipped.push(`${renderGiven(rel)}: ${read.message}`);
    }

    const graders = input.graders?.map((g) => lintGraderSpecOf(g));
    const findings = lintDataset({
      samples,
      ...(graders !== undefined ? { graders } : {}),
      ...(input.specHasTools !== undefined ? { specHasTools: input.specHasTools } : {}),
      leakScanTexts,
      ...(otherVersions !== undefined ? { otherVersions } : {}),
      ...(version !== undefined ? { version } : {}),
    });

    // The near-duplicate rule gives up above its own comparison cap and says
    // so with a finding that names no samples. That is the structural
    // difference between "no near-duplicates" and "did not look", and it is
    // read structurally rather than by matching the message text.
    const scanSkipped = findings.find(
      (f) => f.rule === "near-duplicate-input" && f.sampleIds === undefined,
    );
    const canaryCount = samples.filter((s) => sampleSource(s) === "canary").length;
    // What the leak scan actually had to SEARCH FOR. The rule takes phrases,
    // not canary samples: a canary-tagged sample whose 32-hex phrase is gone
    // (hand-edited record, a redacted import, a foreign dataset that borrowed
    // the tag) contributes nothing, and a scan with an empty needle list can
    // only ever come back clean. Counted with the rule's own extractor, never
    // by re-matching the phrase shape here — and the phrases themselves are
    // never echoed, since a result is prompt-side text.
    const canaryPhraseCount = canaryPhrasesIn(samples).length;

    const notEvaluated: Array<{ rule: string; reason: string }> = [];
    if (graders === undefined) {
      notEvaluated.push({
        rule: "grader-gold-mismatch",
        reason:
          "no graders were passed — whether the graders need a gold these samples lack is unknown",
      });
    }
    if (input.specHasTools === undefined) {
      notEvaluated.push({
        rule: "expected-tools-no-tools",
        reason: "specHasTools was not passed — whether the spec exposes tools is unknown",
      });
    }
    if (otherVersions === undefined || otherVersions.length === 0) {
      notEvaluated.push({
        rule: "cross-version-id-reuse",
        reason:
          input.dataset === undefined
            ? "a file dataset has no other versions to compare against"
            : "this dataset has no other readable versions",
      });
    }
    if (leakScanTexts.length === 0) {
      notEvaluated.push({
        rule: "canary-leak",
        reason:
          canaryPhraseCount > 0
            ? `the dataset carries ${canaryPhraseCount} canary tripwire(s) and no prompt-side text was given to scan — pass leakScanPaths`
            : "no prompt-side text was given to scan",
      });
    } else if (canaryPhraseCount === 0) {
      // Files WERE scanned, and the search had no needle. Reporting that as a
      // rule that ran and found nothing is the exact shape this package
      // refuses: "nothing to look for" is not "nothing there".
      notEvaluated.push({
        rule: "canary-leak",
        reason:
          canaryCount > 0
            ? `${leakScanTexts.length} file(s) were scanned but this dataset yields no canary phrase to search for — ${canaryCount} sample(s) are tagged metadata.source: "canary" and none embeds a recoverable phrase`
            : `${leakScanTexts.length} file(s) were scanned but this dataset carries no canary tripwire to search for — write a version with DatasetPut canary: true to make this rule meaningful`,
      });
    }
    if (scanSkipped !== undefined) {
      notEvaluated.push({
        rule: "near-duplicate-input",
        reason: renderMessage(scanSkipped.message),
      });
    }

    const reported = findings.filter((f) => f !== scanSkipped);
    const errors = reported.filter((f) => f.severity === "error");
    return json({
      dataset: label,
      ...(version !== undefined ? { version } : {}),
      sampleCount: samples.length,
      ...(truncated
        ? {
            truncated: true,
            note: `more than ${MAX_SAMPLES} samples in the source — everything below is about the first ${samples.length}`,
          }
        : {}),
      // "clean" is only ever true about the rules that RAN.
      clean: reported.length === 0,
      errorCount: errors.length,
      warningCount: reported.length - errors.length,
      findings: reported.map(findingJson),
      nearDuplicateScan:
        scanSkipped === undefined
          ? { performed: true, threshold: NEAR_DUP_THRESHOLD }
          : { performed: false, reason: renderMessage(scanSkipped.message) },
      // The needle count, not the phrases: a reader can see whether the leak
      // scan below had anything to find.
      canaryPhrases: canaryPhraseCount,
      rulesNotEvaluated: notEvaluated,
      ...(skippedVersions.length > 0 ? { versionsSkipped: skippedVersions } : {}),
      ...(leakScanSkipped.length > 0 ? { leakScanSkipped } : {}),
      leakScanned: leakScanTexts.map((t) => t.label),
    });
  },
});

function findingJson(f: LintFinding): Record<string, unknown> {
  return {
    rule: f.rule,
    severity: f.severity,
    message: renderMessage(f.message),
    ...(f.sampleIds !== undefined ? listIds(f.sampleIds) : {}),
  };
}

/** Read one prompt-side file for the canary scan. */
function readScanText(toolName: string, rel: string): Loaded<string> {
  const shown = renderGiven(rel);
  try {
    const safe = resolveSafe(toolName, rel);
    const stat = statSync(safe.real);
    if (!stat.isFile()) return fail("bad-input", `"${shown}" is not a file`);
    if (stat.size > MAX_SCAN_BYTES) {
      return fail(
        "too-large",
        `"${shown}" is ${stat.size} bytes, over the ${MAX_SCAN_BYTES} scan limit`,
      );
    }
    return { ok: true, value: readFileSync(safe.real, "utf8") };
  } catch (err) {
    if (err instanceof ToolPermissionError) return fail("refused", err.message);
    return fail("missing", `"${shown}" does not exist or could not be read`);
  }
}

// ---------------------------------------------------------------------------
// DatasetMine
// ---------------------------------------------------------------------------

const mineSchema = z.object({
  sessionsDir: z
    .string()
    .optional()
    .describe(`where the session transcripts are (default ${SESSIONS_REL})`),
  sessions: z
    .array(z.string())
    .optional()
    .describe("mine only these session ids instead of scanning the directory"),
  maxSessions: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(`how many sessions to read, newest by name (default ${DEFAULT_MAX_SESSIONS})`),
  auditDir: z
    .string()
    .optional()
    .describe(
      `where the audit log is, for egress-block signals (default ${AUDIT_REL}; absent, that signal is reported as unavailable)`,
    ),
  dedupeAgainst: z
    .string()
    .optional()
    .describe(
      "a registry dataset name whose every version the candidates are deduped against; omitted, no dedupe is performed and the result says so",
    ),
  nearDuplicates: z
    .boolean()
    .optional()
    .describe("also drop candidates that are near-duplicates of an existing sample (default true)"),
  nearDuplicateThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `token-overlap at or above which a candidate counts as a near-duplicate (default ${DEFAULT_DEDUPE_PARAMS.threshold}); the blocking parameters, not this number, decide which pairs are looked at at all`,
    ),
  redact: z
    .boolean()
    .optional()
    .describe("PII/secret-redact candidate text before returning it (default true)"),
  maxCandidates: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(`how many candidates to return (default ${DEFAULT_MAX_CANDIDATES})`),
  includeSamples: z
    .boolean()
    .optional()
    .describe(
      "include the quarantine Sample for each candidate, ready to hand to DatasetPut (default true)",
    ),
  registryDir: registryDirField,
});

export const datasetMine: RegisteredTool = buildTool({
  name: "DatasetMine",
  description:
    "Mine recorded sessions for the turns a harness visibly struggled on — uncaught errors, tool-error spikes, loop nudges, a user re-asking the same question, and the in-loop judge's own failures — and return them as quarantine samples ready to version. Use it to grow an eval dataset from production without waiting for anyone to rate anything. It writes nothing: candidates come back for review and DatasetPut is the only writer. Candidates already in the registry are dropped by id, by content and (with a blocking index, so the parameters rather than the threshold set the recall) by near-duplicate input. A signal whose evidence is missing — no trace sidecar, no audit log — is reported as unavailable rather than as a signal that did not fire.",
  inputSchema: mineSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const toolName = "DatasetMine";
    const sessionsDir = input.sessionsDir ?? SESSIONS_REL;
    const maxSessions = input.maxSessions ?? DEFAULT_MAX_SESSIONS;

    let ids: string[];
    let total: number;
    let listingTruncated = false;
    const skipped: Array<{ session: string; reason: string }> = [];
    if (input.sessions !== undefined) {
      ids = [];
      for (const given of input.sessions) {
        const checked = checkSessionId(given);
        if (!checked.ok) return `${toolName}: ${checked.message}`;
        ids.push(checked.value);
      }
      total = ids.length;
      const dir = resolveDir(toolName, sessionsDir);
      if (!dir.ok) return `${toolName}: ${dir.message}`;
    } else {
      const listing = listSessions(toolName, sessionsDir, maxSessions);
      if (!listing.ok) return `${toolName}: ${listing.message}`;
      ids = listing.value.ids;
      total = listing.value.total;
      listingTruncated = listing.value.truncated;
      for (const line of listing.value.skipped) {
        const [name = "", ...rest] = line.split(": ");
        skipped.push({ session: name, reason: rest.join(": ") });
      }
    }

    const raw: ReturnType<typeof mineSession> = [];
    let malformedLines = 0;
    let sidecarsPresent = 0;
    let scanned = 0;
    for (const id of ids) {
      const events = readJsonl(toolName, sessionRel(sessionsDir, id), MAX_RECORDS_PER_FILE);
      if (!events.ok) {
        skipped.push({ session: id, reason: events.message });
        continue;
      }
      malformedLines += events.value.malformed;
      if (events.value.truncated) {
        skipped.push({
          session: id,
          reason: `transcript exceeded ${MAX_RECORDS_PER_FILE} records — mined a prefix of this session`,
        });
      }
      const trace = readJsonl(toolName, traceRel(sessionsDir, id), MAX_RECORDS_PER_FILE);
      if (trace.ok) sidecarsPresent += 1;
      else if (trace.code !== "missing") {
        // A sidecar that is THERE and unreadable is not the same as one that
        // was never written; folding it into "absent" would blame the wrong
        // thing (an unset CREWHAUS_WATCHME) for a torn file.
        skipped.push({ session: id, reason: `trace sidecar: ${trace.message}` });
      }
      scanned += 1;
      raw.push(
        ...mineSession(
          id,
          events.value.records as Parameters<typeof mineSession>[1],
          trace.ok ? trace.value.records : [],
        ),
      );
    }

    // The egress signal comes out of the audit log, which many harnesses never
    // write. Its absence is reported as "unavailable", because "no egress
    // blocks" is a claim about a log that exists.
    const auditDirGiven = input.auditDir ?? AUDIT_REL;
    const auditRead = readAuditRecords(toolName, auditDirGiven, MAX_RECORDS_PER_FILE);

    const candidates = dedupeCandidates(raw);
    const redact = input.redact === false ? undefined : redactDatasetText;

    // Dedupe against what is already versioned.
    const params: DedupeParams = {
      ...DEFAULT_DEDUPE_PARAMS,
      ...(input.nearDuplicateThreshold !== undefined
        ? { threshold: input.nearDuplicateThreshold }
        : {}),
    };
    let index: ReturnType<typeof buildDedupeIndex> | undefined;
    let dedupeStatus: Record<string, unknown> = {
      performed: false,
      reason:
        "no dedupeAgainst dataset was given — these candidates may already be in the registry",
    };
    if (input.dedupeAgainst !== undefined) {
      const opened = openRoot(toolName, input.registryDir);
      if (!opened.ok) return opened.message;
      const versions = await listVersions(opened.value.registry, input.dedupeAgainst);
      if (!versions.ok) return `${toolName}: ${versions.message}`;
      const corpus: Array<{ id: string; version: string; input: string; sample: Sample }> = [];
      const versionsSkipped: string[] = [];
      let versionsRead = 0;
      for (const version of versions.value) {
        const record = await readRecord(opened.value.registry, input.dedupeAgainst, version);
        if (!record.ok) {
          versionsSkipped.push(`${version}: ${record.message}`);
          continue;
        }
        versionsRead += 1;
        for (const s of allSamplesOf(record.value)) {
          corpus.push({ id: s.id, version, input: s.input, sample: s });
        }
      }
      // A DEDUPE AGAINST NOTHING IS NOT A DEDUPE. A dataset name that does not
      // exist in this registry — a typo, the wrong registryDir, a registry
      // that was never written — lists zero versions, and every candidate
      // then comes back "new" against an empty corpus. Reported as
      // `performed: true` that is a clean bill of health handed out by a
      // misspelling, so it is a refusal to claim the question was asked.
      // A version with no rows IS an answer, so the test is readability, not
      // corpus size.
      if (versions.value.length === 0) {
        dedupeStatus = {
          performed: false,
          against: input.dedupeAgainst,
          registryRoot: opened.value.root.rel,
          registryExists: opened.value.root.exists,
          reason: `no versions of "${renderGiven(input.dedupeAgainst)}" exist under "${opened.value.root.rel}" — there was nothing to compare against, so the candidates below are UNCHECKED, not new`,
        };
      } else if (versionsRead === 0) {
        dedupeStatus = {
          performed: false,
          against: input.dedupeAgainst,
          registryRoot: opened.value.root.rel,
          versions: versions.value,
          versionsSkipped,
          reason: `none of the ${versions.value.length} version(s) of "${renderGiven(input.dedupeAgainst)}" could be read — the candidates below are UNCHECKED, not new`,
        };
      } else {
        index = buildDedupeIndex(corpus, params, MAX_INDEXED_SAMPLES);
        dedupeStatus = {
          performed: true,
          against: input.dedupeAgainst,
          registryRoot: opened.value.root.rel,
          versions: versions.value,
          ...(versionsSkipped.length > 0
            ? {
                versionsSkipped,
                partial: true,
                partialReason: "a verdict below is a verdict about the versions that could be read",
              }
            : {}),
          indexedSamples: index.indexed,
          ...(index.truncated
            ? {
                corpusTruncated: true,
                note: `only the first ${MAX_INDEXED_SAMPLES} samples were indexed — a "new" verdict is a verdict about that prefix`,
              }
            : {}),
          nearDuplicates:
            input.nearDuplicates === false
              ? {
                  performed: false,
                  reason: "turned off by the caller — only id and content duplicates were removed",
                }
              : {
                  performed: true,
                  threshold: params.threshold,
                  tokensIndexedPerSample: params.tokensIndexedPerSample,
                  maxPostingsPerToken: params.maxPostingsPerToken,
                  exhaustive: false,
                  note: "blocked scan: a pair is scored only when the candidate carries one of the indexed sample's rarest tokens, so these parameters — not the threshold — set the recall",
                },
        };
      }
    }

    const kept: Array<Record<string, unknown>> = [];
    const droppedBy: Record<string, number> = {
      "duplicate-id": 0,
      "duplicate-content": 0,
      "near-duplicate": 0,
    };
    const droppedExamples: Array<Record<string, unknown>> = [];
    let comparisons = 0;
    const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    let truncated = false;
    const bySignal: Record<string, number> = {};
    for (const candidate of candidates) {
      const sample = candidateToSample(candidate, redact);
      if (index !== undefined) {
        const classified = classifyCandidate(index, sample, input.nearDuplicates !== false);
        comparisons += classified.comparisons;
        if (classified.verdict.verdict !== "new") {
          droppedBy[classified.verdict.verdict] = (droppedBy[classified.verdict.verdict] ?? 0) + 1;
          if (droppedExamples.length < 10) {
            droppedExamples.push({
              candidateId: sample.id,
              verdict: classified.verdict.verdict,
              matchedId: classified.verdict.matchedId,
              matchedVersion: classified.verdict.matchedVersion,
              ...(classified.verdict.score !== undefined
                ? { score: classified.verdict.score }
                : {}),
            });
          }
          continue;
        }
      }
      // Counted before the return cap, so `bySignal` describes everything
      // that survived dedupe while `candidateCount` is what came back.
      bySignal[candidate.signal] = (bySignal[candidate.signal] ?? 0) + 1;
      if (kept.length >= maxCandidates) {
        truncated = true;
        continue;
      }
      kept.push({
        id: sample.id,
        signal: candidate.signal,
        sessionId: candidate.sessionId,
        turnNumber: candidate.turnNumber,
        reason: renderMessage(redact === undefined ? candidate.reason : redact(candidate.reason)),
        ...(input.includeSamples === false ? {} : { sample }),
      });
    }

    return json({
      sessionsDir: renderGiven(sessionsDir),
      sessionsScanned: scanned,
      sessionsAvailable: total,
      ...(listingTruncated
        ? {
            listingTruncated: true,
            note: `only the newest ${maxSessions} session(s) by name were read`,
          }
        : {}),
      sessionsSkipped: skipped,
      malformedLines,
      signals: {
        "eval-fail": {
          available: sidecarsPresent > 0,
          sidecarsPresent,
          sidecarsAbsent: scanned - sidecarsPresent,
          ...(sidecarsPresent === 0
            ? {
                reason:
                  "no session carried a trace sidecar (<id>.events.jsonl, written only under CREWHAUS_WATCHME=1) — the in-loop judge signal could not be evaluated, which is not the same as no turn having failed it",
              }
            : {}),
        },
        "egress-block": egressSignal(auditDirGiven, auditRead),
      },
      candidateCount: kept.length,
      candidatesFound: candidates.length,
      ...(truncated ? { truncated: true, note: `capped at ${maxCandidates} candidates` } : {}),
      bySignal,
      redacted: redact !== undefined,
      dedupe: {
        ...dedupeStatus,
        ...(index !== undefined
          ? { dropped: droppedBy, comparisons, examples: droppedExamples }
          : {}),
      },
      candidates: kept,
      next: "review these, then hand the samples to DatasetPut — this tool writes nothing",
    });
  },
});

export const DATASET_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  datasetInspect,
  datasetLint,
  datasetMine,
  datasetPut,
]);
