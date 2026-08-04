/**
 * M3 · DATA — the dataset registry, its hygiene verbs, and the growth loops.
 *
 * Everything lives under `/api/h/:id/data/…` and the dataset NAME travels in
 * the BODY for every write, deliberately: a name is operator-supplied, and
 * routing it through a path segment would put a user-chosen string in the
 * position where a literal route keyword ("status", "quarantine") lives. The
 * one read that takes a name (`/data/datasets/:name`) validates it as a safe
 * segment first, like every other id in this server.
 *
 * Rules the registry already encodes and this console must not soften:
 *   - VERIFY IS A HASH CHECK. A mismatch means TAMPERED — badge it as such,
 *     never as "stale". The stored per-sample hashes are what the run index's
 *     `datasetHash` folds, so a divergence means the gate is comparing
 *     different data under one lineage.
 *   - PROVENANCE IS A TAXONOMY, not a free-text note: `metadata.source`
 *     (including the canary bucket) is what makes a dataset trustworthy.
 *   - `<spec>-ratings` and `<spec>-regressions` are AUTO-MAINTAINED. They are
 *     rendered as such; this surface offers no hand edit that the next
 *     distill would overwrite.
 *   - THE TEST SPLIT IS LOCKED to the release flow, with a burn count from
 *     `releases[]`. Using it is a visible, gated gesture (the launcher in
 *     `evals-ops.ts` enforces the gate server-side).
 *   - QUARANTINE IS EVIDENCE. `_quarantine/` entries surface beside the
 *     registry WITH their provenance — a quarantined sample that vanishes
 *     from the UI is a bug report nobody can file.
 *   - `dataset lint` is the canary-CONTAMINATION scan across specs and
 *     few-shot pools; `dataset audit` is the registry integrity pass. They
 *     answer different questions and get different buttons.
 *
 * The growth verbs (`mine`, `synthesize`, `refresh-goldens`) add rows to a
 * dataset that later GATES A RELEASE, so each previews before it writes.
 * Where the CLI verb has a native preview (`refresh-goldens` proposes a diff
 * and only writes under `--apply`) the preview IS the verb; where it does not,
 * the preview is an explicit plan naming the argv and the paths it will
 * touch — an honest plan, never a fabricated diff.
 */
import { join } from "node:path";
import {
  type DatasetRecord,
  type DatasetSplit,
  compareVersions,
  createFileBackedRegistry,
  verifySplitHashes,
} from "@crewhaus/dataset-registry";
import { readRunIndexLatest } from "@crewhaus/eval-report";
import { MAX_JSONL_LINES } from "./constants";
import {
  absent,
  asObject,
  datasetFilterMatches,
  found,
  isDirAt,
  listNames,
  readJsonAt,
  safeContain,
  str,
} from "./evals-ops";
import { HttpError } from "./http";
import { readJsonlCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { isDryRun, jobArg, requireString } from "./m3";
import { maskDeep, maskText } from "./mask";

const REGISTRY_SEGMENTS: readonly string[] = [".crewhaus", "datasets"];
const QUARANTINE_SEGMENTS: readonly string[] = [".crewhaus", "datasets", "_quarantine"];

/** The registry name grammar the store itself enforces, re-checked here so a
 *  body-supplied name is refused with a 400 instead of a library throw. */
const DATASET_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function datasetName(ctx: M3Context, key = "name"): string {
  const value = requireString(ctx.body, key);
  if (!DATASET_NAME_RE.test(value) || value.length > 128) {
    throw new HttpError(400, `"${key}" is not a valid dataset name`);
  }
  return value;
}

/** The harness-local registry root. The CLI also honours
 *  `CREWHAUS_DATASETS_DIR`, which this console deliberately does NOT follow:
 *  an env-relocated root can point outside the harness, and every read here
 *  is containment-checked against the harness directory. */
function registryRoot(ctx: M3Context): string | undefined {
  const root = safeContain(ctx, REGISTRY_SEGMENTS);
  return isDirAt(root) ? root : undefined;
}

const specNameOf = (ctx: M3Context): string => ctx.entry?.specName ?? "spec";

/** `<spec>-ratings` and `<spec>-regressions` are rebuilt by distill and by the
 *  gate; a hand edit to either is overwritten by the next run. */
function autoMaintained(ctx: M3Context, name: string): string | null {
  const spec = specNameOf(ctx);
  if (name === `${spec}-ratings`) return "rebuilt by `crewhaus distill --register`";
  if (name === `${spec}-regressions`) return "rebuilt by the eval gate's regression union";
  return null;
}

type SplitSizes = { train: number; dev: number; test: number | null };

function splitSizes(record: DatasetRecord): SplitSizes {
  return {
    train: record.splits.train?.length ?? 0,
    dev: record.splits.dev?.length ?? 0,
    test: record.splits.test === undefined ? null : record.splits.test.length,
  };
}

/**
 * The provenance breakdown: a tally of `metadata.source` across every split.
 * This is a TAXONOMY, not a note — `human`, `synthetic`,
 * `synthetic_human_verified`, `mined`, `canary` each mean something different
 * about whether the dataset can be trusted to gate a release, and the canary
 * bucket in particular is what `dataset lint` scans for contamination.
 */
function provenance(record: DatasetRecord): Record<string, number> {
  const tally: Record<string, number> = {};
  const splits: readonly DatasetSplit[] = ["train", "dev", "test"];
  for (const split of splits) {
    for (const sample of record.splits[split] ?? []) {
      const source = str(sample.metadata?.["source"]) ?? "(unlabelled)";
      tally[source] = (tally[source] ?? 0) + 1;
    }
  }
  return tally;
}

type VerifyState = {
  readonly ok: boolean;
  readonly mismatches: number;
  /** TAMPERED, never "stale": the stored hashes are the version's identity. */
  readonly badge: "intact" | "tampered";
  readonly detail: ReadonlyArray<Record<string, unknown>>;
};

function verifyRecord(record: DatasetRecord): VerifyState {
  const mismatches = verifySplitHashes(record);
  return {
    ok: mismatches.length === 0,
    mismatches: mismatches.length,
    badge: mismatches.length === 0 ? "intact" : "tampered",
    detail: mismatches.slice(0, 50).map((m) => ({ ...m })),
  };
}

/** Release entries = the version's test-split BURN count. A holdout is only
 *  hidden while its peeks are counted. */
function burn(record: DatasetRecord): { count: number; releases: ReadonlyArray<unknown> } {
  const releases = record.releases ?? [];
  return { count: releases.length, releases: releases.map((r) => ({ ...r })) };
}

async function loadVersions(
  ctx: M3Context,
  name: string,
): Promise<{ versions: string[]; records: Map<string, DatasetRecord> }> {
  const root = registryRoot(ctx);
  const records = new Map<string, DatasetRecord>();
  if (root === undefined) return { versions: [], records };
  const registry = createFileBackedRegistry({ rootDir: root });
  let versions: string[] = [];
  try {
    versions = [...(await registry.list(name))].sort(compareVersions);
  } catch {
    return { versions: [], records };
  }
  for (const version of versions) {
    // Per FILE containment: a `<name>/<version>.json` entry can be a symlink
    // pointing out of the harness, and listing the directory only yielded a
    // name. The registry read happens only after the path is contained.
    if (safeContain(ctx, [...REGISTRY_SEGMENTS, name, `${version}.json`]) === undefined) continue;
    try {
      records.set(version, await registry.getRecord(name, version));
    } catch {
      // Unreadable or torn record — the version still lists, without detail.
    }
  }
  return { versions, records };
}

async function datasetNames(ctx: M3Context): Promise<string[]> {
  const root = registryRoot(ctx);
  if (root === undefined) return [];
  try {
    const names = await createFileBackedRegistry({ rootDir: root }).listDatasets();
    return [...names].filter((n) => DATASET_NAME_RE.test(n) && isDirAt(join(root, n))).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/data/datasets` — the registry panel. */
export const datasets: M3Handler = async (ctx) => {
  const names = await datasetNames(ctx);
  const rows: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const { versions, records } = await loadVersions(ctx, name);
    const latestVersion = versions[versions.length - 1];
    const latest = latestVersion === undefined ? undefined : records.get(latestVersion);
    rows.push({
      name,
      versions: versions.length,
      latestVersion: latestVersion ?? null,
      createdAt: latest?.createdAt ?? null,
      splits: latest === undefined ? null : splitSizes(latest),
      provenance: latest === undefined ? null : provenance(latest),
      verify: latest === undefined ? null : verifyRecord(latest),
      testSplitBurn: latest === undefined ? null : burn(latest).count,
      autoMaintained: autoMaintained(ctx, name),
    });
  }
  if (rows.length === 0) {
    return {
      ...absent("no datasets registered on this harness", "crewhaus distill --register"),
      datasets: rows,
      root: REGISTRY_SEGMENTS.join("/"),
    };
  }
  const tampered = rows.filter((r) => asObject(r["verify"])?.["ok"] === false).length;
  return {
    ...found(
      tampered > 0
        ? `${tampered} dataset(s) fail their stored sample hashes — TAMPERED, not stale: the version's content no longer matches the identity every gated run was keyed on`
        : null,
      "crewhaus datasets list",
    ),
    datasets: rows,
    root: REGISTRY_SEGMENTS.join("/"),
  };
};

/** `GET /api/h/:id/data/datasets/:name` — one dataset in full. */
export const dataset: M3Handler = async (ctx) => {
  const name = ctx.params["name"] as string;
  const { versions, records } = await loadVersions(ctx, name);
  if (versions.length === 0) {
    return {
      ...absent(`no dataset "${name}" in this harness's registry`, "crewhaus distill --register"),
      name,
      versions: [],
      autoMaintained: autoMaintained(ctx, name),
    };
  }
  const versionRows = versions.map((version) => {
    const record = records.get(version);
    if (record === undefined) {
      return { version, readable: false, note: "record unreadable or torn" };
    }
    return {
      version,
      readable: true,
      createdAt: record.createdAt,
      splits: splitSizes(record),
      provenance: provenance(record),
      verify: verifyRecord(record),
      burn: burn(record),
    };
  });
  const latest = versions[versions.length - 1];
  return {
    ...found(null, "crewhaus datasets status"),
    name,
    latestVersion: latest ?? null,
    versions: versionRows,
    autoMaintained: autoMaintained(ctx, name),
    testSplit: {
      locked: true,
      note: "the held-out test split can only be spent through the release flow; every spend is recorded as a burn in releases[]",
      verb: "crewhaus datasets release",
    },
  };
};

/** Does a run-index `datasetName` belong to `<name>@<version>`? Exact, or
 *  continued by `#<split>` (split-pinned) or `+` (regression union) — the
 *  same continuation grammar the dataset filter uses. */
function runMatchesVersion(name: string, version: string, recorded: string): boolean {
  const base = `${name}@${version}`;
  return (
    recorded === base || recorded.startsWith(`${base}#`) || datasetFilterMatches(base, recorded)
  );
}

/**
 * `GET /api/h/:id/data/status` — `datasets status` rendered.
 *
 * Three questions an operator actually has: is the dataset STALE (how old is
 * the newest version, when did a run last touch it), has it SATURATED (which
 * samples pass in every recent run and therefore no longer discriminate), and
 * how much of the holdout has been BURNED.
 */
export const datasetStatus: M3Handler = async (ctx) => {
  const names = await datasetNames(ctx);
  if (names.length === 0) {
    return {
      ...absent("no datasets registered on this harness", "crewhaus distill --register"),
      datasets: [],
    };
  }
  const evalsDir = safeContain(ctx, [".crewhaus", "evals"]);
  let index: ReturnType<typeof readRunIndexLatest> = [];
  try {
    index = evalsDir === undefined ? [] : readRunIndexLatest(evalsDir);
  } catch {
    index = [];
  }
  const nowMs = ctx.now();
  const rows: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const { versions, records } = await loadVersions(ctx, name);
    for (const version of versions) {
      const record = records.get(version);
      const joined = index
        .filter((e) => runMatchesVersion(name, version, e.datasetName))
        .sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const createdMs = record === undefined ? Number.NaN : Date.parse(record.createdAt);
      rows.push({
        name,
        version,
        createdAt: record?.createdAt ?? null,
        ageDays: Number.isNaN(createdMs)
          ? null
          : Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000)),
        splits: record === undefined ? null : splitSizes(record),
        runCount: joined.length,
        lastRunTs: joined[0]?.ts ?? null,
        testSplitBurn: record === undefined ? 0 : burn(record).count,
        saturation: saturationFor(
          ctx,
          joined.slice(0, 5).map((e) => e.runId),
        ),
        autoMaintained: autoMaintained(ctx, name),
      });
    }
  }
  return {
    ...found(
      "saturation is computed over the five most recent joined runs — a sample that passed in every one of them no longer discriminates and is a rotation candidate",
      "crewhaus datasets status",
    ),
    datasets: rows,
  };
};

/**
 * Always-passing samples across the given runs. Bounded on purpose: this is a
 * console poll, not a batch job, so it opens at most five `results.json`
 * files and never walks a run's per-sample directories.
 */
function saturationFor(
  ctx: M3Context,
  runIds: readonly string[],
): { runsConsidered: number; alwaysPassing: string[] } {
  const seen = new Map<string, { runs: number; passes: number }>();
  let considered = 0;
  for (const runId of runIds) {
    const path = safeContain(ctx, [".crewhaus", "evals", runId, "results.json"]);
    if (path === undefined) continue;
    const summary = asObject(readJsonAt(path));
    if (summary === undefined) continue;
    considered += 1;
    const rows = Array.isArray(summary["results"])
      ? summary["results"]
      : Array.isArray(summary["samples"])
        ? summary["samples"]
        : [];
    for (const raw of rows) {
      const row = asObject(raw);
      const sampleId = str(row?.["sampleId"]) ?? str(row?.["id"]);
      if (sampleId === undefined) continue;
      const tally = seen.get(sampleId) ?? { runs: 0, passes: 0 };
      tally.runs += 1;
      const passed =
        row?.["pass"] === true ||
        row?.["passed"] === true ||
        asObject(asObject(row?.["grades"])?.["overall"])?.["passed"] === true;
      if (passed) tally.passes += 1;
      seen.set(sampleId, tally);
    }
  }
  const alwaysPassing = [...seen.entries()]
    .filter(([, t]) => t.runs >= 2 && t.passes === t.runs)
    .map(([sampleId]) => sampleId)
    .sort();
  return { runsConsidered: considered, alwaysPassing };
}

/**
 * `GET /api/h/:id/data/quarantine` — `.crewhaus/datasets/_quarantine/`.
 *
 * Quarantine is EVIDENCE: `dataset mine` stages its hard cases here rather
 * than promoting them straight into a gating dataset. Each entry surfaces
 * WITH its provenance, because a quarantined sample nobody can see is a bug
 * nobody can file.
 */
export const datasetQuarantine: M3Handler = (ctx) => {
  const dir = safeContain(ctx, QUARANTINE_SEGMENTS);
  const files = listNames(dir).filter((n) => n.endsWith(".jsonl"));
  const entries: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (const file of files) {
    const path = safeContain(ctx, [...QUARANTINE_SEGMENTS, file]);
    if (path === undefined) continue;
    const read = readJsonlCapped(path, MAX_JSONL_LINES);
    truncated = truncated || read.truncated;
    for (const raw of read.objects) {
      const row = asObject(raw);
      if (row === undefined) continue;
      const metadata = asObject(row["metadata"]);
      entries.push({
        file,
        id: str(row["id"]) ?? null,
        input: maskText(str(row["input"]) ?? ""),
        expectedOutput: maskText(str(row["expected_output"]) ?? ""),
        // Provenance is why it was pulled — the taxonomy plus whatever the
        // miner recorded as the struggle signal.
        source: str(metadata?.["source"]) ?? null,
        reason: maskText(str(metadata?.["reason"]) ?? str(row["reason"]) ?? ""),
        metadata: maskDeep(metadata ?? {}),
      });
    }
  }
  if (entries.length === 0) {
    return {
      ...absent(
        "nothing in quarantine — mined hard cases stage here before anything promotes them",
        "crewhaus dataset mine --sessions all",
      ),
      entries,
      files,
      truncated,
    };
  }
  return {
    ...found(
      truncated ? "the quarantine staging files were read up to the line cap" : null,
      "crewhaus dataset mine --review",
    ),
    entries,
    files,
    truncated,
    promoteVerb: "crewhaus dataset mine --review",
  };
};

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

/**
 * `POST /api/h/:id/data/verify` — body `{ name }`.
 *
 * Runs IN PROCESS through the registry's own `verifySplitHashes` rather than
 * queueing a spawn: the check is a pure recomputation of the stored per-sample
 * hashes, and the library that wrote them is the library that checks them. A
 * mismatch means TAMPERED — the version's content no longer matches the
 * identity every run keyed on it — not "stale".
 */
export const datasetVerify: M3Handler = async (ctx) => {
  const name = datasetName(ctx);
  const { versions, records } = await loadVersions(ctx, name);
  if (versions.length === 0) {
    // A typed refusal rather than a 404: the request was well-formed, the
    // registry simply holds no such dataset, and the panel renders that
    // beside the name the operator typed.
    return {
      ...absent(`no dataset "${name}" in this harness's registry`, "crewhaus distill --register"),
      name,
      results: [],
      tampered: [],
      readOnly: true,
    };
  }
  const results = versions.map((version) => {
    const record = records.get(version);
    if (record === undefined) {
      return { version, readable: false, verify: null };
    }
    return { version, readable: true, verify: verifyRecord(record) };
  });
  const tampered = results.filter((r) => r.verify?.ok === false);
  return {
    ...found(
      tampered.length === 0
        ? "every version matches its stored sample hashes"
        : `${tampered.length} version(s) TAMPERED — the stored hashes no longer match the content`,
      "crewhaus datasets verify",
    ),
    name,
    results,
    tampered: tampered.map((r) => r.version),
    readOnly: true,
  };
};

/**
 * `POST /api/h/:id/data/audit` — registry INTEGRITY across every dataset.
 *
 * Distinct from {@link datasetLint}: this asks "is the registry internally
 * consistent" (hashes intact, splits present, versions readable and ordered),
 * which is answerable offline from the records themselves. Read-only, and the
 * result is a list of actionable rows rather than a log dump.
 */
export const datasetAudit: M3Handler = async (ctx) => {
  const names = await datasetNames(ctx);
  const findings: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const { versions, records } = await loadVersions(ctx, name);
    if (versions.length === 0) {
      findings.push({
        name,
        version: null,
        level: "warn",
        finding: "dataset directory has no versions",
      });
      continue;
    }
    for (const version of versions) {
      const record = records.get(version);
      if (record === undefined) {
        findings.push({
          name,
          version,
          level: "error",
          finding: "version record is unreadable or torn",
        });
        continue;
      }
      const verify = verifyRecord(record);
      if (!verify.ok) {
        findings.push({
          name,
          version,
          level: "error",
          finding: `TAMPERED — ${verify.mismatches} stored sample hash(es) do not match the content`,
        });
      }
      const sizes = splitSizes(record);
      if (sizes.train === 0 && sizes.dev === 0) {
        findings.push({
          name,
          version,
          level: "warn",
          finding: "version has no train or dev samples",
        });
      }
      if (sizes.test === null) {
        findings.push({
          name,
          version,
          level: "info",
          finding: "no held-out test split — this version cannot gate a release",
        });
      }
      const unlabelled = provenance(record)["(unlabelled)"] ?? 0;
      if (unlabelled > 0) {
        findings.push({
          name,
          version,
          level: "warn",
          finding: `${unlabelled} sample(s) carry no metadata.source — provenance is a taxonomy, and an unlabelled sample cannot be trusted to gate`,
        });
      }
    }
  }
  return {
    ...found(
      names.length === 0 ? "no datasets registered — nothing to audit" : null,
      "crewhaus dataset audit",
    ),
    datasetsAudited: names.length,
    findings,
    readOnly: true,
    scope:
      "registry integrity (hashes, splits, provenance labels) — NOT the canary-contamination scan",
  };
};

/**
 * `POST /api/h/:id/data/lint` — the canary-CONTAMINATION scan.
 *
 * A different question from {@link datasetAudit}: this one crosses OUT of the
 * registry, into the spec and the few-shot pool, looking for canary samples
 * that have leaked into the agent's own context (at which point the canary
 * proves nothing). It needs the CLI's cross-surface knowledge, so it runs
 * through the job queue.
 */
export const datasetLint: M3Handler = (ctx) => {
  const argv = ["dataset", "lint"];
  const name = ctx.body["name"];
  if (name === undefined) argv.push("--all");
  else argv.push("--dataset", jobArg("name", name));
  const graders = ctx.body["graders"];
  if (graders !== undefined) argv.push("--graders", jobArg("graders", graders));
  return {
    ...found(
      "queued — lint scans specs and the few-shot pool for canary contamination; `dataset audit` is the separate registry-integrity pass",
      "crewhaus dataset lint",
    ),
    job: ctx.submitJob("dataset lint", argv),
    argv,
    readOnly: true,
  };
};

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

type GrowthPlan = {
  readonly argv: readonly string[];
  /** Paths the verb writes into, named before it runs. */
  readonly writes: readonly string[];
  /** The review gate between "produced" and "gating a release". */
  readonly reviewGate: string;
  /** True when the CLI verb has a native preview mode this dry run uses. */
  readonly nativePreview: boolean;
};

/** Submit a growth verb, or answer with its plan when this is a dry run. */
function growth(ctx: M3Context, kind: string, plan: GrowthPlan): unknown {
  if (isDryRun(ctx.body)) {
    return {
      ...found(
        plan.nativePreview
          ? "preview — this verb proposes a diff and writes nothing until you confirm"
          : "plan — this verb has no offline diff, so here is exactly what it will run and where it will write",
        `crewhaus ${kind}`,
      ),
      dryRun: true,
      plan,
      confirmWith: 'send the same body with "dryRun": false to run it',
    };
  }
  return {
    ...found(`queued — writes land under ${plan.writes.join(", ")}`, `crewhaus ${kind}`),
    dryRun: false,
    plan,
    job: ctx.submitJob(kind, plan.argv),
  };
}

/**
 * `POST /api/h/:id/data/mine` — `dataset mine`.
 *
 * Mines session struggle signals (errors, eval failures, loops, retries,
 * egress denials) into candidate samples. Its output STAGES in
 * `_quarantine/`, not in a gating dataset — promotion is the separate
 * `--review` gesture — which is why the preview here names the staging file
 * rather than claiming a dataset diff.
 */
export const datasetMine: M3Handler = (ctx) => {
  const name = datasetName(ctx);
  const argv = ["dataset", "mine", "--out-dataset", jobArg("name", name)];
  const sessions = ctx.body["sessions"];
  if (sessions !== undefined) argv.push("--sessions", jobArg("sessions", sessions));
  if (ctx.body["review"] === true) argv.push("--review");
  return growth(ctx, "dataset mine", {
    argv,
    writes: [`${QUARANTINE_SEGMENTS.join("/")}/${name}-hardcases.jsonl`],
    reviewGate:
      "mined candidates stage in _quarantine; nothing reaches the dataset until `dataset mine --review` promotes it",
    nativePreview: false,
  });
};

/** `POST /api/h/:id/data/synthesize` — `dataset synthesize`. Synthetic rows
 *  land in their own split and can never define the gold standard (the
 *  registry refuses a `source: synthetic` sample carrying an expected
 *  output), so the preview says where they will land. */
export const datasetSynthesize: M3Handler = (ctx) => {
  const name = datasetName(ctx);
  const from = ctx.body["seedDataset"] ?? ctx.body["from"] ?? name;
  const argv = ["dataset", "synthesize", "--from", jobArg("seedDataset", from)];
  argv.push("--out-dataset", jobArg("name", name));
  const count = ctx.body["count"];
  if (count !== undefined) {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      throw new HttpError(400, '"count" must be a positive integer');
    }
    argv.push("--count", String(count));
  }
  return growth(ctx, "dataset synthesize", {
    argv,
    writes: [`${REGISTRY_SEGMENTS.join("/")}/${name}/<next version>.json`],
    reviewGate:
      "synthetic rows land in a separate split and are never gold — a synthetic sample carrying an expected output is refused at the registry boundary",
    nativePreview: false,
  });
};

/**
 * `POST /api/h/:id/data/refresh-goldens` — `dataset refresh-goldens`.
 *
 * Re-generating goldens changes what "correct" MEANS for every future run, so
 * the diff preview is mandatory rather than a nicety — and here it is the
 * verb's own behaviour: without `--apply` it proposes the gold updates as a
 * review diff, and with `--apply` it writes a NEW registry version (never in
 * place, so the old identity survives).
 */
export const datasetRefreshGoldens: M3Handler = (ctx) => {
  const name = datasetName(ctx);
  const argv = ["dataset", "refresh-goldens", "--dataset", `registry:${jobArg("name", name)}`];
  const dry = isDryRun(ctx.body);
  if (!dry) argv.push("--apply");
  return {
    ...found(
      dry
        ? "preview queued — the verb proposes gold updates as a review diff and writes nothing"
        : "queued with --apply — it writes a NEW registry version, never in place",
      "crewhaus dataset refresh-goldens",
    ),
    dryRun: dry,
    plan: {
      argv,
      writes: dry ? [] : [`${REGISTRY_SEGMENTS.join("/")}/${name}/<next version>.json`],
      reviewGate: "changing goldens changes what correct means — review the proposed diff first",
      nativePreview: true,
    },
    job: ctx.submitJob("dataset refresh-goldens", argv),
  };
};

/** Exported for this area's tests: the provenance tally IS the trust story,
 *  and the run↔version join is the grammar the freshness columns depend on. */
export { provenance, splitSizes, verifyRecord, runMatchesVersion };
