/**
 * E50 — N-variant online experiments: deterministic per-request version
 * selection plus per-version outcome accounting.
 *
 * HONEST BOUNDARY (read this before claiming "traffic splitting"). This
 * module ships the two halves of an A/B experiment that CrewHaus can
 * actually reach today:
 *
 *   1. SELECTION — {@link selectExperimentVariant} maps a stable request key
 *      to exactly one variant version, deterministically (sha256 of
 *      `salt|requestKey`, mod 100, walked over the declared weights). Same
 *      key ⇒ same version, forever, in every process, with no shared state.
 *      This is the same hash `CanaryController.route()` uses, generalized
 *      from two versions to N.
 *   2. ACCOUNTING — {@link appendExperimentOutcome} records one outcome per
 *      (experiment, version) observation into an append-only JSONL, and
 *      {@link tallyExperimentOutcomes} folds it per version.
 *
 * What this module DOES NOT do: it does not intercept live requests. Nothing
 * in CrewHaus's serving surfaces (gateway-server's `RunHandler`, the managed
 * daemon, the channel bots) consults an assignment today — a genuine
 * request-level split needs a consumer at each shape's serving boundary, and
 * `target: cli` has no live request stream at all. So an operator gets the
 * decision function and the ledger; wiring them into a serving boundary is
 * an explicit integration, not something a flag silently turns on. Every
 * user-facing string in this feature says exactly that.
 *
 * Storage is an append-only JSONL per experiment under
 * `.crewhaus/experiments/`, mirroring the alert-watchdog's session-metrics
 * history: readers tolerate torn/partial lines (a crashed writer must not
 * make the ledger unreadable), and validation is hand-rolled rather than zod
 * so this package stays a dependency-light leaf.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CanaryError } from "./errors";

/** Default location of the experiment ledgers, relative to cwd. */
export const DEFAULT_EXPERIMENTS_DIR = join(".crewhaus", "experiments");

/** Suffix of an experiment's append-only outcome ledger. */
export const EXPERIMENT_LEDGER_SUFFIX = ".jsonl";
/** Suffix of an experiment's variant-assignment manifest. */
export const EXPERIMENT_ASSIGNMENT_SUFFIX = ".assignment.json";

export type ExperimentVariant = {
  /** The spec-registry version this variant serves. */
  readonly version: string;
  /** Integer 1..100 — percent of the request-key space this variant owns. */
  readonly weight: number;
};

export type ExperimentConfig = {
  readonly name: string;
  /** Two or more variants whose weights are positive integers summing to 100. */
  readonly variants: ReadonlyArray<ExperimentVariant>;
  /**
   * Optional stable salt mixed into the hash before bucketing (a tenant id,
   * or a rotation token when an operator deliberately wants a fresh split).
   * Absent ⇒ the empty salt, matching `CanaryController.route()` without a
   * tenant.
   */
  readonly salt?: string;
};

export type ExperimentSelection = {
  readonly version: string;
  /** Hash bucket value, 0-99 — the same space `route()` buckets into. */
  readonly bucket: number;
  /** 0-based index of the selected variant in `config.variants`. */
  readonly index: number;
};

/**
 * The hash bucket a request key lands in: `sha256(salt|requestKey)`, first
 * 4 bytes as a uint32, mod 100. Shared with `CanaryController.route()` so
 * the two-version canary and the N-variant experiment can never disagree
 * about which side of the split a given key is on.
 */
export function requestBucket(salt: string | undefined, requestKey: string): number {
  const seed = `${salt ?? ""}|${requestKey}`;
  const hash = createHash("sha256").update(seed).digest();
  const v =
    ((hash[0] ?? 0) << 24) | ((hash[1] ?? 0) << 16) | ((hash[2] ?? 0) << 8) | (hash[3] ?? 0);
  return Math.abs(v) % 100;
}

/**
 * Validate an {@link ExperimentConfig}. Weights are integers because the
 * bucket space is exactly 100 wide: fractional weights would silently round,
 * and a rounded split is not the split the operator declared.
 */
export function validateExperimentConfig(config: ExperimentConfig): void {
  if (config.name.trim() === "") {
    throw new CanaryError("experiment name must be a non-empty string");
  }
  if (config.variants.length < 2) {
    throw new CanaryError(
      `experiment "${config.name}" needs at least 2 variants; got ${config.variants.length}`,
    );
  }
  const seen = new Set<string>();
  let total = 0;
  for (const v of config.variants) {
    if (v.version.trim() === "") {
      throw new CanaryError(`experiment "${config.name}" has a variant with an empty version`);
    }
    if (seen.has(v.version)) {
      throw new CanaryError(
        `experiment "${config.name}" lists version "${v.version}" more than once`,
      );
    }
    seen.add(v.version);
    if (!Number.isInteger(v.weight) || v.weight < 1 || v.weight > 100) {
      throw new CanaryError(
        `experiment "${config.name}" variant "${v.version}" weight must be an integer in 1..100; got ${v.weight}`,
      );
    }
    total += v.weight;
  }
  if (total !== 100) {
    throw new CanaryError(
      `experiment "${config.name}" weights must sum to exactly 100; got ${total}`,
    );
  }
}

/**
 * Deterministically select the variant serving `requestKey`. Pure: the same
 * (config, key) pair always yields the same version, in any process, with no
 * shared state — which is what makes the assignment sticky for a user across
 * requests and reproducible for an operator debugging one.
 */
export function selectExperimentVariant(
  config: ExperimentConfig,
  requestKey: string,
): ExperimentSelection {
  validateExperimentConfig(config);
  const bucket = requestBucket(config.salt, requestKey);
  let cursor = 0;
  for (let i = 0; i < config.variants.length; i += 1) {
    const variant = config.variants[i];
    if (variant === undefined) continue;
    cursor += variant.weight;
    if (bucket < cursor) {
      return { version: variant.version, bucket, index: i };
    }
  }
  // Unreachable while the weights sum to 100 (validated above); the last
  // variant is the honest fallback rather than a throw on a hot path.
  const last = config.variants[config.variants.length - 1] as ExperimentVariant;
  return { version: last.version, bucket, index: config.variants.length - 1 };
}

// --------- durable assignment manifest ---------

export type ExperimentAssignment = ExperimentConfig & {
  /** ISO timestamp of the last write. */
  readonly updatedAt: string;
  /** Optional environment the variants are pinned for (informational). */
  readonly env?: string;
  /**
   * Free-text note recording HOW the assignment is expected to be consumed.
   * Written by `deploy canary --traffic-split` so a file found on disk months
   * later still states its own boundary.
   */
  readonly note?: string;
};

/** Filesystem-safe form of an experiment name (path traversal floor). */
export function experimentFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  // A name that sanitizes to punctuation only ("///", "..") would collide
  // with every other such name and read as a traversal attempt — refuse it
  // rather than silently writing to `___.jsonl`.
  if (!/[A-Za-z0-9]/.test(safe)) {
    throw new CanaryError(`experiment name "${name}" has no filesystem-safe characters`);
  }
  return safe;
}

export function writeExperimentAssignment(
  assignment: ExperimentAssignment,
  dir: string = DEFAULT_EXPERIMENTS_DIR,
): string {
  validateExperimentConfig(assignment);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${experimentFileName(assignment.name)}${EXPERIMENT_ASSIGNMENT_SUFFIX}`);
  // Small single-writer manifest — a plain write is fine here; the ledger
  // beside it is the append-only surface that must survive a torn write.
  writeFileSync(path, `${JSON.stringify(assignment, null, 2)}\n`, "utf-8");
  return path;
}

/**
 * Retire an experiment's variant assignment. Returns true when a file was
 * actually removed.
 *
 * A split is a TEMPORARY state: once the ramp concludes — promotion (100%
 * candidate) or rollback (100% baseline) — the env pin is single-version and
 * any surviving `[{v1,50},{v2,50}]` on disk would keep a compliant serving
 * integration sending half its keys to a version nobody is running. There is
 * no representable "100% one version" assignment ({@link
 * validateExperimentConfig} requires ≥2 variants summing to 100, deliberately
 * — a one-variant split is not a split), so a concluded experiment REMOVES
 * the file and lets the env pin do the talking. `crewhaus experiment assign`
 * then fails loudly instead of routing on a stale split.
 */
export function removeExperimentAssignment(
  name: string,
  dir: string = DEFAULT_EXPERIMENTS_DIR,
): boolean {
  const path = join(dir, `${experimentFileName(name)}${EXPERIMENT_ASSIGNMENT_SUFFIX}`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function readExperimentAssignment(
  name: string,
  dir: string = DEFAULT_EXPERIMENTS_DIR,
): ExperimentAssignment | undefined {
  const path = join(dir, `${experimentFileName(name)}${EXPERIMENT_ASSIGNMENT_SUFFIX}`);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const variants = rec["variants"];
  if (typeof rec["name"] !== "string" || !Array.isArray(variants)) return undefined;
  const cleaned: ExperimentVariant[] = [];
  for (const v of variants) {
    if (typeof v !== "object" || v === null) return undefined;
    const entry = v as Record<string, unknown>;
    if (typeof entry["version"] !== "string" || typeof entry["weight"] !== "number") {
      return undefined;
    }
    cleaned.push({ version: entry["version"], weight: entry["weight"] });
  }
  return {
    name: rec["name"],
    variants: cleaned,
    updatedAt: typeof rec["updatedAt"] === "string" ? rec["updatedAt"] : "",
    ...(typeof rec["salt"] === "string" ? { salt: rec["salt"] } : {}),
    ...(typeof rec["env"] === "string" ? { env: rec["env"] } : {}),
    ...(typeof rec["note"] === "string" ? { note: rec["note"] } : {}),
  };
}

// --------- append-only outcome ledger ---------

export type ExperimentOutcomeRecord = {
  /** ISO timestamp of the observation. */
  readonly ts: string;
  readonly experiment: string;
  /** The variant version this outcome is attributed to. */
  readonly version: string;
  readonly outcome: "success" | "failure";
  /** The stable request key that selected the version, when known. */
  readonly requestKey?: string;
  /** A normalized 0..1 quality score (eval/judge score), when known. */
  readonly score?: number;
  /** A human rating on its own scale (1-5, thumbs as 0/1, …), when known. */
  readonly rating?: number;
  /** Where the observation came from — `eval`, `serving`, `cli`, … */
  readonly source?: string;
};

function ledgerPath(name: string, dir: string): string {
  return join(dir, `${experimentFileName(name)}${EXPERIMENT_LEDGER_SUFFIX}`);
}

export function appendExperimentOutcomes(
  records: ReadonlyArray<ExperimentOutcomeRecord>,
  dir: string = DEFAULT_EXPERIMENTS_DIR,
): number {
  if (records.length === 0) return 0;
  mkdirSync(dir, { recursive: true });
  // Group by experiment so a mixed batch still lands one append per file.
  const byExperiment = new Map<string, string[]>();
  for (const rec of records) {
    const lines = byExperiment.get(rec.experiment) ?? [];
    lines.push(JSON.stringify(rec));
    byExperiment.set(rec.experiment, lines);
  }
  for (const [name, lines] of byExperiment) {
    appendFileSync(ledgerPath(name, dir), `${lines.join("\n")}\n`, "utf-8");
  }
  return records.length;
}

export function appendExperimentOutcome(
  record: ExperimentOutcomeRecord,
  dir: string = DEFAULT_EXPERIMENTS_DIR,
): void {
  appendExperimentOutcomes([record], dir);
}

/**
 * Read an experiment's ledger. Torn/partial lines are SKIPPED rather than
 * throwing: a crashed writer must degrade the tally by one observation, not
 * make the whole experiment unreadable.
 */
export function readExperimentOutcomes(
  name: string,
  dir: string = DEFAULT_EXPERIMENTS_DIR,
): ReadonlyArray<ExperimentOutcomeRecord> {
  const path = ledgerPath(name, dir);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: ExperimentOutcomeRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    const version = rec["version"];
    const outcome = rec["outcome"];
    if (typeof version !== "string" || (outcome !== "success" && outcome !== "failure")) continue;
    out.push({
      ts: typeof rec["ts"] === "string" ? rec["ts"] : "",
      experiment: typeof rec["experiment"] === "string" ? rec["experiment"] : name,
      version,
      outcome,
      ...(typeof rec["requestKey"] === "string" ? { requestKey: rec["requestKey"] } : {}),
      ...(typeof rec["score"] === "number" && Number.isFinite(rec["score"])
        ? { score: rec["score"] }
        : {}),
      ...(typeof rec["rating"] === "number" && Number.isFinite(rec["rating"])
        ? { rating: rec["rating"] }
        : {}),
      ...(typeof rec["source"] === "string" ? { source: rec["source"] } : {}),
    });
  }
  return out;
}

/** Every experiment name with a ledger under `dir`, sorted. */
export function listExperiments(dir: string = DEFAULT_EXPERIMENTS_DIR): ReadonlyArray<string> {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(EXPERIMENT_LEDGER_SUFFIX))
    .map((f) => f.slice(0, -EXPERIMENT_LEDGER_SUFFIX.length))
    .sort();
}

// --------- per-version tally ---------

export type VariantTally = {
  readonly version: string;
  /** Observations recorded for this version. */
  readonly n: number;
  readonly successes: number;
  readonly failures: number;
  /** successes / n; 0 when n is 0. */
  readonly successRate: number;
  /** Mean of the recorded 0..1 scores. Absent when none carried a score. */
  readonly meanScore?: number;
  /** How many observations carried a score. */
  readonly scoredN: number;
  /** Mean of the recorded human ratings. Absent when none carried a rating. */
  readonly meanRating?: number;
  /** How many observations carried a rating. */
  readonly ratedN: number;
  /**
   * Observation count per `source` (`eval` / `serving` / `cli` / …; records
   * without a source fold into `"unknown"`). A reader must be able to tell an
   * n built from offline eval re-runs from one built from live serving
   * outcomes — they are not the same evidence.
   */
  readonly sources: Readonly<Record<string, number>>;
};

/**
 * Collapse REPEATED MEASUREMENTS of the same unit so a tally cannot mistake
 * them for independent observations.
 *
 * The motivating case is `deploy canary --traffic-split`: an eval observation
 * is keyed by DATASET SAMPLE, and a ramp (or a re-invoked ramp under the same
 * experiment name) grades the same fixed sample against the same version more
 * than once. Four ramp steps over an 8-sample dataset would otherwise report
 * n=32 per version and shrink a Wilson half-width ~2×, naming a "winner" on
 * evidence that is inconclusive at the real sample size.
 *
 * Scope is deliberately narrow: only records with `source: "eval"` AND a
 * `requestKey` collapse, last-write-wins per (version, requestKey). Serving
 * records pass through untouched — there a request key is commonly a STICKY
 * user/session id, so repeats are genuinely separate requests and collapsing
 * them would destroy real data.
 */
export function dedupeExperimentOutcomes(records: ReadonlyArray<ExperimentOutcomeRecord>): {
  readonly records: ReadonlyArray<ExperimentOutcomeRecord>;
  /** How many records were dropped as repeat measurements. */
  readonly collapsed: number;
} {
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as ExperimentOutcomeRecord;
    if (rec.source !== "eval" || rec.requestKey === undefined) continue;
    lastIndex.set(`${rec.version} ${rec.requestKey}`, i);
  }
  const kept: ExperimentOutcomeRecord[] = [];
  let collapsed = 0;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as ExperimentOutcomeRecord;
    if (rec.source === "eval" && rec.requestKey !== undefined) {
      if (lastIndex.get(`${rec.version} ${rec.requestKey}`) !== i) {
        collapsed += 1;
        continue;
      }
    }
    kept.push(rec);
  }
  return { records: kept, collapsed };
}

/**
 * Fold outcome records per version, in first-appearance order (so the first
 * version written — the control/baseline in a canary — leads the table).
 */
export function tallyExperimentOutcomes(
  records: ReadonlyArray<ExperimentOutcomeRecord>,
): ReadonlyArray<VariantTally> {
  type Acc = {
    n: number;
    successes: number;
    scoreSum: number;
    scoredN: number;
    ratingSum: number;
    ratedN: number;
    sources: Record<string, number>;
  };
  const order: string[] = [];
  const acc = new Map<string, Acc>();
  for (const rec of records) {
    let entry = acc.get(rec.version);
    if (entry === undefined) {
      entry = { n: 0, successes: 0, scoreSum: 0, scoredN: 0, ratingSum: 0, ratedN: 0, sources: {} };
      acc.set(rec.version, entry);
      order.push(rec.version);
    }
    entry.n += 1;
    const source = rec.source ?? "unknown";
    entry.sources[source] = (entry.sources[source] ?? 0) + 1;
    if (rec.outcome === "success") entry.successes += 1;
    if (rec.score !== undefined) {
      entry.scoreSum += rec.score;
      entry.scoredN += 1;
    }
    if (rec.rating !== undefined) {
      entry.ratingSum += rec.rating;
      entry.ratedN += 1;
    }
  }
  return order.map((version) => {
    const e = acc.get(version) as Acc;
    return {
      version,
      n: e.n,
      successes: e.successes,
      failures: e.n - e.successes,
      successRate: e.n > 0 ? e.successes / e.n : 0,
      scoredN: e.scoredN,
      ratedN: e.ratedN,
      sources: e.sources,
      ...(e.scoredN > 0 ? { meanScore: e.scoreSum / e.scoredN } : {}),
      ...(e.ratedN > 0 ? { meanRating: e.ratingSum / e.ratedN } : {}),
    };
  });
}
