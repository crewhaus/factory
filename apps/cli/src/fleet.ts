/**
 * Item 58 — `crewhaus fleet`: the cross-harness view every other single-cwd
 * command lacks. A team runs many harnesses (the Slack bot, the CLI
 * concierge, the nightly optimizer) each in its own directory per the
 * standalone-harness convention; `fleet` discovers them under a root and
 * rolls their state up into one inventory / health table, and runs a safe
 * read-only subcommand across the filtered set.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import and directly unit-testable, mirroring
 * `retention.ts` / `state-backup.ts` / `datasets.ts`:
 *   - discovery + inventory aggregation are pure reads over seeded harness
 *     dirs (no network, no subprocess);
 *   - the bulk-run path launches per-harness `crewhaus` invocations through an
 *     INJECTED runner seam (`FleetRunner`), so tests drive it without a real
 *     CLI.
 *
 * DISCOVERY MODEL — a "harness" is any directory that carries a
 * `crewhaus.yaml` (the spec file the standalone-harness convention roots a
 * harness on). `discoverHarnesses(root)` walks `root` up to a bounded depth,
 * records every dir with a `crewhaus.yaml`, and does NOT descend into a
 * harness's own `.crewhaus/` state dir or into `node_modules` (a bundled
 * template spec under `node_modules` is not a fleet member). The root itself
 * counts when it carries a spec, so `fleet list` run from inside a single
 * harness reports just that one.
 *
 * INVENTORY — per harness, aggregated purely from on-disk state the other
 * commands already write:
 *   - name / target / model: a lenient scan of `crewhaus.yaml` (a full
 *     `parseSpec` can fail on schema drift, and a fleet scan must not die on
 *     one stale spec — so name/target/model are read best-effort);
 *   - registry version + env pins: `@crewhaus/spec-registry` manifest for the
 *     spec name under `.crewhaus/specs`;
 *   - last eval pass-rate: newest entry in `.crewhaus/evals/index.jsonl`
 *     (`@crewhaus/eval-report`'s `readRunIndex`);
 *   - session count: `sess_*.json` files under `.crewhaus/sessions`;
 *   - feedback count: distinct records via `extractFeedbackRecords` over the
 *     same sinks `crewhaus distill` reads (sessions + feedback jsonl).
 *
 * BULK OPS SAFETY — `fleet run <sub>` only accepts commands off an explicit
 * READ-ONLY allow-list (`eval`, `doctor`, `security digest`, `audit verify`).
 * A mutating command is refused unless `--allow-mutating` is passed AND a
 * per-harness confirm callback approves each one — the CLI wires that to an
 * interactive prompt, tests to a predicate. The bulk runner never itself
 * mutates: it launches one `crewhaus <sub>` invocation per harness (cwd = the
 * harness dir, the convention every subcommand resolves state from) and
 * aggregates exit codes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest } from "@crewhaus/spec-registry";
import { extractFeedbackRecords, mergeFeedback } from "./feedback";

/** The spec file that roots a standalone harness. */
export const HARNESS_SPEC_FILENAME = "crewhaus.yaml";

/** Depth cap for the discovery walk (root is depth 0). Deep monorepos still
 *  resolve; a pathological tree can't hang the scan. */
const MAX_DISCOVERY_DEPTH = 6;

/** Directory names never descended into during discovery. */
const DISCOVERY_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".crewhaus",
  "node_modules",
  ".git",
  "dist",
  ".worktrees",
]);

/** Thrown for operational failures (missing root, empty filter, disallowed
 *  bulk subcommand). The CLI entry file catches it and routes the message
 *  through `die()`; tests assert on `.message` without the process exiting. */
export class FleetError extends Error {
  override readonly name = "FleetError";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** A discovered harness: its absolute directory + the spec path within it. */
export type DiscoveredHarness = {
  readonly dir: string;
  readonly specPath: string;
};

/**
 * Walk `root` for directories carrying a `crewhaus.yaml`, bounded to
 * {@link MAX_DISCOVERY_DEPTH}. Never descends into `.crewhaus`, `node_modules`,
 * `.git`, `dist`, or `.worktrees`. A directory that IS a harness is still
 * descended into (a harness may nest sub-harnesses in a demo tree), just not
 * through its state dir. Results are sorted by directory for stable output.
 */
export function discoverHarnesses(root: string): DiscoveredHarness[] {
  const absRoot = resolve(root);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new FleetError(`no directory at ${absRoot} — nothing to scan for harnesses`);
  }
  const found: DiscoveredHarness[] = [];
  const visit = (dir: string, depth: number): void => {
    const specPath = join(dir, HARNESS_SPEC_FILENAME);
    if (existsSync(specPath) && statSync(specPath).isFile()) {
      found.push({ dir, specPath });
    }
    if (depth >= MAX_DISCOVERY_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't abort the whole scan
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(absRoot, 0);
  found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return found;
}

// ---------------------------------------------------------------------------
// Lenient spec header read (name / target / model)
// ---------------------------------------------------------------------------

/** The identity fields a fleet row needs, read best-effort. */
export type SpecHeader = {
  readonly name?: string;
  readonly target?: string;
  readonly model?: string;
};

/**
 * Read `name`, `target`, and `model` from a `crewhaus.yaml` WITHOUT a full
 * schema parse. A fleet scan must survive a stale/invalid spec (schema drift,
 * a half-edited file), so this is a tolerant top-level-key scrape rather than
 * `parseSpec`. `name`/`target` are top-level on every target shape; `model`
 * lives at `agent.model` (cli/channel/voice) OR top-level `model`
 * (workflow/graph/pipeline/crew) depending on the shape — the first
 * `model:` at any indentation is taken. Values are unquoted and trimmed.
 */
export function readSpecHeader(yamlText: string): SpecHeader {
  const topLevel = (key: string): string | undefined => {
    // `key:` at column 0 (top-level YAML mapping key).
    const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
    const m = re.exec(yamlText);
    if (m === null) return undefined;
    return cleanScalar(m[1] ?? "");
  };
  const anyLevel = (key: string): string | undefined => {
    // `key:` at any indentation — for `model` under `agent:`.
    const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, "m");
    const m = re.exec(yamlText);
    if (m === null) return undefined;
    return cleanScalar(m[1] ?? "");
  };
  const name = topLevel("name");
  const target = topLevel("target");
  const model = topLevel("model") ?? anyLevel("model");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** Strip surrounding quotes, an inline `# comment`, and whitespace from a
 *  scalar. Returns undefined for an empty/block-scalar-only value. */
function cleanScalar(raw: string): string | undefined {
  let s = raw.trim();
  if (s === "" || s === "|" || s === ">" || s === "|-" || s === ">-") return undefined;
  const quote = s.startsWith('"') ? '"' : s.startsWith("'") ? "'" : undefined;
  if (quote !== undefined) {
    // Quoted value: take everything up to the closing quote (a `#` inside is
    // data); anything after the close (e.g. ` # comment`) is dropped.
    const close = s.indexOf(quote, 1);
    if (close !== -1) return s.slice(1, close);
    // Unterminated quote — fall through to the unquoted handling.
  }
  const hash = s.indexOf(" #");
  if (hash !== -1) s = s.slice(0, hash).trim();
  return s === "" ? undefined : s;
}

// ---------------------------------------------------------------------------
// Inventory aggregation
// ---------------------------------------------------------------------------

/** The `.crewhaus/specs`-registered version + env pins for a harness spec. */
export type RegistryStatus = {
  /** Latest registered version (`v3`), or undefined when nothing is registered. */
  readonly latestVersion?: string;
  /** env → version pins from the registry manifest. */
  readonly pins: Readonly<Record<string, string>>;
};

/** The newest recorded eval run for a harness. */
export type LastEval = {
  readonly datasetName: string;
  readonly passRate: number;
  readonly ts: string;
};

/** Minimal shape of an eval index entry the fleet row needs. */
export type LastEvalEntry = {
  readonly datasetName: string;
  readonly passRate: number;
  readonly ts: string;
};

/** One harness's rolled-up inventory row. */
export type HarnessInventory = {
  readonly dir: string;
  readonly header: SpecHeader;
  /** Best-effort spec name (header name, else the dir basename). */
  readonly specName: string;
  readonly registry: RegistryStatus;
  readonly lastEval?: LastEval;
  readonly sessionCount: number;
  readonly feedbackCount: number;
  /** True when the spec file did not read at all (unreadable/absent). */
  readonly specUnreadable: boolean;
};

const SESSION_JSON_REGEX = /^sess_[0-9a-f]{16}\.json$/;

/** Count `sess_<16hex>.json` files under `.crewhaus/sessions`. */
export function countSessions(harnessDir: string): number {
  const dir = join(harnessDir, ".crewhaus", "sessions");
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (SESSION_JSON_REGEX.test(f)) n += 1;
  }
  return n;
}

/** Parse a JSONL blob into objects, skipping blank/malformed lines. */
function parseJsonlObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerated — one torn line must not hide the rest
    }
  }
  return out;
}

/**
 * Distinct feedback a harness carries, counted the way `crewhaus distill`
 * folds it: `user_feedback` events in `sessions/*.jsonl` PLUS bare records in
 * `feedback/*.jsonl` (`extractFeedbackRecords` accepts both encodings), then
 * `mergeFeedback` collapses to one per (sessionId, turnNumber). The row shows
 * distinct rated turns, not raw line count, so a re-rated turn counts once.
 */
export function countFeedback(harnessDir: string): number {
  const objects: unknown[] = [];
  for (const sub of ["sessions", "feedback"]) {
    const dir = join(harnessDir, ".crewhaus", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      objects.push(...parseJsonlObjects(readFileSync(join(dir, f), "utf-8")));
    }
  }
  return mergeFeedback(extractFeedbackRecords(objects)).length;
}

/** The newest run in an eval index, or undefined. Newest by `ts` (ISO-8601
 *  lexical order is chronological). */
export function lastEvalFor(evalEntries: ReadonlyArray<LastEvalEntry>): LastEval | undefined {
  let best: LastEvalEntry | undefined;
  for (const e of evalEntries) {
    if (best === undefined || e.ts > best.ts) best = e;
  }
  if (best === undefined) return undefined;
  return { datasetName: best.datasetName, passRate: best.passRate, ts: best.ts };
}

/**
 * Manifest reader seam — production passes a closure over
 * `@crewhaus/spec-registry`; tests pass a stub. Returns undefined when the
 * spec has no registry entry (never registered / compiled).
 */
export type ManifestReader = (
  specName: string,
  registryRoot: string,
) => Promise<Manifest | undefined>;

/** Eval-index reader seam — production passes `readRunIndex`; tests stub. */
export type EvalIndexReader = (evalsDir: string) => ReadonlyArray<LastEvalEntry>;

export type BuildInventoryDeps = {
  readonly readManifest: ManifestReader;
  readonly readEvalIndex: EvalIndexReader;
};

/**
 * Aggregate one harness directory into an inventory row. All reads are
 * tolerant: a missing state dir, an unregistered spec, or an unreadable spec
 * file each degrade to an empty/absent field rather than throwing, so one
 * broken harness never aborts a `fleet list`.
 */
export async function buildHarnessInventory(
  harness: DiscoveredHarness,
  deps: BuildInventoryDeps,
): Promise<HarnessInventory> {
  let header: SpecHeader = {};
  let specUnreadable = false;
  try {
    header = readSpecHeader(readFileSync(harness.specPath, "utf-8"));
  } catch {
    specUnreadable = true;
  }
  const specName = header.name ?? basenameOf(harness.dir);

  let registry: RegistryStatus = { pins: {} };
  const manifest = await deps.readManifest(specName, join(harness.dir, ".crewhaus", "specs"));
  if (manifest !== undefined) {
    const latest = manifest.versions[manifest.versions.length - 1];
    registry = {
      ...(latest !== undefined ? { latestVersion: latest } : {}),
      pins: manifest.pins,
    };
  }

  const lastEval = lastEvalFor(deps.readEvalIndex(join(harness.dir, ".crewhaus", "evals")));

  return {
    dir: harness.dir,
    header,
    specName,
    registry,
    ...(lastEval !== undefined ? { lastEval } : {}),
    sessionCount: countSessions(harness.dir),
    feedbackCount: countFeedback(harness.dir),
    specUnreadable,
  };
}

function basenameOf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? dir;
}

/** Build the full fleet inventory for a root. */
export async function buildFleetInventory(
  root: string,
  deps: BuildInventoryDeps,
): Promise<HarnessInventory[]> {
  const harnesses = discoverHarnesses(root);
  const rows: HarnessInventory[] = [];
  for (const h of harnesses) {
    rows.push(await buildHarnessInventory(h, deps));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render the inventory as aligned columns for `fleet list`. */
export function formatInventory(
  rows: ReadonlyArray<HarnessInventory>,
  root: string,
): ReadonlyArray<string> {
  if (rows.length === 0) {
    return [`no harnesses (no ${HARNESS_SPEC_FILENAME}) found under ${resolve(root)}`];
  }
  const lines: string[] = [`${rows.length} harness(es) under ${resolve(root)}:`, ""];
  for (const r of rows) {
    const rel = relTo(root, r.dir);
    lines.push(`• ${r.specName}${rel !== "" ? `  (${rel})` : ""}`);
    const shape = r.header.target ?? "?";
    const model = r.header.model ?? "?";
    lines.push(`    shape=${shape} model=${model}`);
    const ver = r.registry.latestVersion ?? "unregistered";
    const pins = Object.entries(r.registry.pins);
    const pinStr = pins.length === 0 ? "no pins" : pins.map(([e, v]) => `${e}→${v}`).join(", ");
    lines.push(`    registry=${ver}  pins: ${pinStr}`);
    if (r.lastEval !== undefined) {
      lines.push(
        `    last eval: ${(r.lastEval.passRate * 100).toFixed(1)}% pass (${r.lastEval.datasetName}, ${r.lastEval.ts})`,
      );
    } else {
      lines.push("    last eval: none recorded");
    }
    lines.push(`    sessions=${r.sessionCount}  feedback=${r.feedbackCount}`);
    if (r.specUnreadable) lines.push("    ⚠ spec file unreadable");
  }
  return lines;
}

function relTo(root: string, dir: string): string {
  const absRoot = resolve(root);
  const absDir = resolve(dir);
  if (absDir === absRoot) return ".";
  if (absDir.startsWith(`${absRoot}/`)) return absDir.slice(absRoot.length + 1);
  return absDir;
}

// ---------------------------------------------------------------------------
// Health rollup (fleet status)
// ---------------------------------------------------------------------------

export type HarnessHealth = {
  readonly dir: string;
  readonly specName: string;
  /** True when a compiled bundle / registry entry exists (deployable). */
  readonly registered: boolean;
  /** env pins present. */
  readonly pinnedEnvs: ReadonlyArray<string>;
  /** True when a pinned eval baseline exists AND the last run met/held it. */
  readonly evalHealthy: boolean;
  readonly evalNote: string;
  /** Open incidents from the ops-batch incidents dir, if present. */
  readonly openIncidents: number;
  /** Whether `.crewhaus/audit` exists (tamper-evidence available). */
  readonly hasAudit: boolean;
};

/** Reader seam: newest pass-rate + whether it dropped vs the pinned baseline. */
export type EvalHealthReader = (
  evalsDir: string,
  specName: string,
) => { healthy: boolean; note: string };

/** Count open incidents under `.crewhaus/incidents` (files not ending
 *  `.resolved.json`). Absent dir → 0. The ops batch writes one JSON per
 *  incident; a resolved one is renamed `<id>.resolved.json`. */
export function countOpenIncidents(harnessDir: string): number {
  const dir = join(harnessDir, ".crewhaus", "incidents");
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json") && !f.endsWith(".resolved.json")) n += 1;
  }
  return n;
}

export async function buildHarnessHealth(
  inv: HarnessInventory,
  readEvalHealth: EvalHealthReader,
): Promise<HarnessHealth> {
  const evalHealth = readEvalHealth(join(inv.dir, ".crewhaus", "evals"), inv.specName);
  return {
    dir: inv.dir,
    specName: inv.specName,
    registered: inv.registry.latestVersion !== undefined,
    pinnedEnvs: Object.keys(inv.registry.pins).sort(),
    evalHealthy: evalHealth.healthy,
    evalNote: evalHealth.note,
    openIncidents: countOpenIncidents(inv.dir),
    hasAudit: existsSync(join(inv.dir, ".crewhaus", "audit")),
  };
}

/** Render the health rollup as status lines for `fleet status`. */
export function formatHealth(
  rows: ReadonlyArray<HarnessHealth>,
  root: string,
): ReadonlyArray<string> {
  if (rows.length === 0) {
    return [`no harnesses found under ${resolve(root)}`];
  }
  const lines: string[] = [`fleet health — ${rows.length} harness(es) under ${resolve(root)}:`, ""];
  for (const r of rows) {
    const flags: string[] = [];
    flags.push(r.registered ? "registered" : "unregistered");
    flags.push(r.evalHealthy ? "eval:ok" : "eval:attention");
    if (r.openIncidents > 0) flags.push(`incidents:${r.openIncidents}`);
    if (r.hasAudit) flags.push("audit");
    const mark = healthMark(r);
    lines.push(`${mark} ${r.specName}`);
    lines.push(`    ${flags.join("  ")}`);
    lines.push(`    eval: ${r.evalNote}`);
    if (r.pinnedEnvs.length > 0) lines.push(`    pinned envs: ${r.pinnedEnvs.join(", ")}`);
  }
  const attention = rows.filter((r) => healthMark(r) !== "✓").length;
  lines.push("");
  lines.push(
    attention === 0
      ? "summary: all harnesses healthy"
      : `summary: ${attention} harness(es) need attention`,
  );
  return lines;
}

/** ✓ healthy / ✗ needs attention. Attention = an open incident, an eval
 *  regression, or an unregistered harness that nonetheless has env pins
 *  (a pin pointing at nothing registered). */
export function healthMark(r: HarnessHealth): "✓" | "✗" {
  if (r.openIncidents > 0) return "✗";
  if (!r.evalHealthy) return "✗";
  if (!r.registered && r.pinnedEnvs.length > 0) return "✗";
  return "✓";
}

// ---------------------------------------------------------------------------
// Bulk run (fleet run <sub> --filter <glob>)
// ---------------------------------------------------------------------------

/** Read-only / idempotent subcommands the bulk runner accepts without an
 *  explicit opt-in. Each maps to a `crewhaus <argv...>` invocation. */
export const READ_ONLY_BULK_COMMANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  eval: ["eval"],
  doctor: ["doctor"],
  "security digest": ["security", "digest"],
  "audit verify": ["audit", "verify"],
};

/** A resolved bulk-run plan: the base argv + whether it is a mutating command. */
export type BulkCommandPlan = {
  /** The base argv (e.g. ["security","digest"]). */
  readonly argv: ReadonlyArray<string>;
  /** True when the command is off the read-only allow-list. */
  readonly mutating: boolean;
};

/**
 * Resolve a `fleet run` subcommand + trailing args into a plan. Refuses
 * anything off the read-only allow-list unless `allowMutating` is set. The
 * longest allow-listed prefix wins, so `security digest` resolves ahead of a
 * bare `security`.
 */
export function resolveBulkCommand(
  subcommandTokens: ReadonlyArray<string>,
  allowMutating: boolean,
): BulkCommandPlan {
  if (subcommandTokens.length === 0) {
    throw new FleetError(
      "missing subcommand — usage: crewhaus fleet run <eval|doctor|security digest|audit verify> [--filter <glob>]",
    );
  }
  const joined2 = subcommandTokens.slice(0, 2).join(" ");
  const joined1 = subcommandTokens[0] as string;
  const two = READ_ONLY_BULK_COMMANDS[joined2];
  if (two !== undefined) {
    return { argv: [...two, ...subcommandTokens.slice(2)], mutating: false };
  }
  const one = READ_ONLY_BULK_COMMANDS[joined1];
  if (one !== undefined) {
    return { argv: [...one, ...subcommandTokens.slice(1)], mutating: false };
  }
  if (!allowMutating) {
    const allowed = Object.keys(READ_ONLY_BULK_COMMANDS).join(", ");
    throw new FleetError(
      `"${joined1}" is not a read-only fleet subcommand (allowed: ${allowed}). Pass --allow-mutating to run a mutating command across the fleet (each harness will require confirmation).`,
    );
  }
  return { argv: [...subcommandTokens], mutating: true };
}

/** Match a harness against a `--filter` glob, tested against BOTH the spec
 *  name and the directory basename, so `--filter '*bot*'` catches either. */
export function matchesFilter(inv: HarnessInventory, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const glob = new Bun.Glob(filter);
  return glob.match(inv.specName) || glob.match(basenameOf(inv.dir));
}

/** Launch seam: run `crewhaus <argv>` in `cwd`, resolve to an exit code + the
 *  captured tail of output. Production wires this to `Bun.spawn`; tests inject
 *  a deterministic stub so no subprocess runs. */
export type FleetRunner = (opts: {
  readonly cwd: string;
  readonly argv: ReadonlyArray<string>;
}) => Promise<{ readonly exitCode: number; readonly tail: string }>;

/** Per-harness confirm seam for `--allow-mutating` (interactive prompt in the
 *  CLI; a predicate in tests). Returning false skips that harness. */
export type ConfirmMutating = (
  inv: HarnessInventory,
  argv: ReadonlyArray<string>,
) => Promise<boolean>;

export type BulkRunResult = {
  readonly inv: HarnessInventory;
  readonly ran: boolean;
  /** exit code when ran; undefined when skipped (filter/decline). */
  readonly exitCode?: number;
  readonly tail?: string;
  /** Reason a harness was skipped, if it was. */
  readonly skipReason?: string;
};

export type RunFleetBulkOptions = {
  readonly root: string;
  readonly subcommandTokens: ReadonlyArray<string>;
  readonly filter?: string;
  readonly allowMutating: boolean;
  readonly deps: BuildInventoryDeps;
  readonly runner: FleetRunner;
  readonly confirm: ConfirmMutating;
};

export type RunFleetBulkReport = {
  readonly plan: BulkCommandPlan;
  readonly results: ReadonlyArray<BulkRunResult>;
  /** Harnesses that ran and exited non-zero. */
  readonly failed: number;
  /** Harnesses that ran and exited zero. */
  readonly passed: number;
  /** Harnesses skipped (filtered out or declined). */
  readonly skipped: number;
};

/**
 * Run one subcommand across the filtered fleet. Read-only commands run
 * unconditionally on every matched harness; a mutating command (only reachable
 * with `allowMutating`) runs a harness only when `confirm` approves it. The
 * runner is the sole side-effect surface, injected for testability.
 */
export async function runFleetBulk(opts: RunFleetBulkOptions): Promise<RunFleetBulkReport> {
  const plan = resolveBulkCommand(opts.subcommandTokens, opts.allowMutating);
  const inventory = await buildFleetInventory(opts.root, opts.deps);
  const results: BulkRunResult[] = [];
  let failed = 0;
  let passed = 0;
  let skipped = 0;
  for (const inv of inventory) {
    if (!matchesFilter(inv, opts.filter)) {
      results.push({ inv, ran: false, skipReason: "filtered out" });
      skipped += 1;
      continue;
    }
    if (plan.mutating) {
      const ok = await opts.confirm(inv, plan.argv);
      if (!ok) {
        results.push({ inv, ran: false, skipReason: "declined at confirm" });
        skipped += 1;
        continue;
      }
    }
    const { exitCode, tail } = await opts.runner({ cwd: inv.dir, argv: plan.argv });
    results.push({ inv, ran: true, exitCode, tail });
    if (exitCode === 0) passed += 1;
    else failed += 1;
  }
  return { plan, results, failed, passed, skipped };
}

/** Render a bulk-run report as summary lines for `fleet run`. */
export function formatBulkReport(report: RunFleetBulkReport): ReadonlyArray<string> {
  const cmd = report.plan.argv.join(" ");
  const lines: string[] = [
    `fleet run: crewhaus ${cmd}${report.plan.mutating ? " (mutating — confirmed per harness)" : ""}`,
    "",
  ];
  for (const r of report.results) {
    if (!r.ran) {
      lines.push(`~ ${r.inv.specName} — skipped (${r.skipReason})`);
      continue;
    }
    const mark = r.exitCode === 0 ? "✓" : "✗";
    lines.push(`${mark} ${r.inv.specName} — exit ${r.exitCode}`);
    const tail = (r.tail ?? "").trim();
    if (tail !== "") {
      for (const line of tail.split("\n").slice(-3)) lines.push(`    ${line}`);
    }
  }
  lines.push("");
  lines.push(
    `summary: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  );
  return lines;
}
