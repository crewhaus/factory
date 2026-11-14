/**
 * `crewhaus criteria`: the criteria a harness's graders check for, in
 * `graders.yaml` beside the graders.
 *
 *   list     every criterion: the declared ones, each grader no criterion
 *            binds (`grader:<name>`), and the bars set in the spec itself
 *            (`spec:evaluation`, `spec:judge:<step|node>`, `spec:provability`)
 *   show     one criterion, its revisions and its last results
 *   lint     what a criteria block leaves unsaid or matches nothing
 *   apply    structured edits, against the revision you read; loosening a
 *            protected criterion needs the spec's name typed and the owner
 *   preview  what an edit would change, graded on a recorded run's answers
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch on import). Side-effect-free on import; each verb returns lines and
 * an exit code, and bad arguments throw plain `Error`s that `index.ts` routes
 * through `die()`. The clock, the owner check and the regrade are injected.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Sample, loadDataset } from "@crewhaus/eval-dataset";
import {
  type CompiledGrader,
  type CriterionScope,
  type GraderKind,
  type GraderSpec,
  type GradersConfig,
  GradersEditsSchema,
  applyGradersEdits,
  boundSpecsOf,
  criterionDigest,
  graderSpecDigest,
  gradersConfigHash,
  inCriterionScope,
  kindOfGraderSpec,
  loosening,
  parseGradersConfig,
  runCriteriaRecord,
  stableDigest,
} from "@crewhaus/eval-grader";
import {
  type RunIndexEntry,
  getBaseline,
  hashDatasetFile,
  readRunIndexLatest,
} from "@crewhaus/eval-report";
import {
  type EvalRunSummary,
  type SampleResult,
  builtinGraderMeta,
  createRegrade,
  readRecordedRun,
} from "@crewhaus/eval-runner";
import {
  CRITERIA_APPLY_CMD,
  CRITERIA_HISTORY_REL,
  type CriteriaHistoryLine,
  appendCriteriaHistory,
  gradersRevision,
  readCriteriaHistory,
} from "@crewhaus/quality-service/criteria-history";
import { parse as parseYaml } from "yaml";
import { type OwnerCheck, ownerCheck as defaultOwnerCheck } from "./owner-check";
import type { CliFamily } from "./verbs";

export type CriteriaCommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
};

/** What `preview` hands the regrade it asks for. */
export type PreviewRegradeArgs = {
  readonly specPath: string;
  /** Where the preview run is written: under the harness's evals directory. */
  readonly outDir: string;
  /** The judge model the source run bound, so the preview grades with the same one. */
  readonly judgeModel?: string;
  readonly sourceDir: string;
  readonly datasetName: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly datasetHash: string;
  readonly compiled: ReadonlyArray<CompiledGrader>;
  readonly gradersConfig: GradersConfig;
  readonly gradersHash: string;
};

export type CriteriaCommandOptions = {
  /** Environment; tests inject one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The working directory the default paths resolve against. */
  readonly cwd?: string;
  /** Clock (epoch ms). */
  readonly now?: () => number;
  /** The owner check for a protected change; defaults to the approver projection. */
  readonly ownerCheck?: (harnessDir: string) => OwnerCheck;
  /** The evals directory (`.crewhaus/evals` under the working directory). */
  readonly evalsDir?: string;
  /** Grades a recorded run with edited graders; the CLI's regrade by default. */
  readonly regrade?: (args: PreviewRegradeArgs) => Promise<EvalRunSummary>;
};

/** The criteria history log lives in `@crewhaus/quality-service`; re-exported here. */
export {
  CRITERIA_APPLY_CMD,
  CRITERIA_HISTORY_REL,
  gradersRevision,
} from "@crewhaus/quality-service/criteria-history";

const CRITERIA_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus criteria list [--json]                every criterion, with its mode, protection,",
  "                                                  kinds, digest and revision",
  "  crewhaus criteria show <id> [--json]           one criterion, its revisions and last results",
  "  crewhaus criteria lint [--dataset <d>] [--json]   what is unsaid, or matches no case",
  "  crewhaus criteria apply <edits.json> --expect <revision> [--confirm <spec name>]",
  "                                                  apply structured edits; loosening a protected",
  "                                                  criterion needs --confirm and the owner",
  "  crewhaus criteria preview <edits.json> --dataset <d> [--run <runId>] [--yes] [--json]",
  "                                                  regrade a recorded run with the edits applied",
  "",
  "  Every verb takes --graders <file> (default eval/graders.yaml) and --spec <file>",
  "  (default crewhaus.yaml). `list` prints the file's revision that `apply --expect`",
  "  takes. A preview that would call a judge says how many calls and stops unless",
  "  --yes; it is never gated or pinned.",
];

/**
 * The `criteria` family in the CLI's verb inventory (`verbs.ts`): each
 * sub-verb and the flags its parser takes.
 */
export const CLI_FAMILY = {
  verb: "criteria",
  since: "0.9.0",
  sub: {
    list: { flags: { json: "boolean", graders: "value", spec: "value" } },
    show: { flags: { json: "boolean", graders: "value", spec: "value" } },
    lint: { flags: { json: "boolean", graders: "value", spec: "value", dataset: "value" } },
    apply: {
      flags: { expect: "value", confirm: "value", graders: "value", spec: "value" },
    },
    preview: {
      flags: {
        run: "value",
        yes: "boolean",
        json: "boolean",
        dataset: "value",
        graders: "value",
        spec: "value",
      },
    },
  },
} as const satisfies CliFamily;

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

type FlagKind = "value" | "values" | "boolean";

type Args = {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
};

function parseArgs(
  verb: string,
  argv: readonly string[],
  spec: Readonly<Record<string, FlagKind>>,
): Args {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (kind === undefined) {
      const known = Object.keys(spec).map((key) => `--${key}`);
      throw new Error(`criteria ${verb}: unknown flag "${arg}" (expected: ${known.join(", ")})`);
    }
    if (kind === "boolean") {
      booleans.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`criteria ${verb}: ${arg} needs a value`);
    if (values.has(name)) throw new Error(`criteria ${verb}: ${arg} can be given once`);
    values.set(name, value);
    i++;
  }
  return { positional, values, booleans };
}

function onlyPositional(verb: string, args: Args, count: number, what: string): string[] {
  if (args.positional.length < count) throw new Error(`criteria ${verb}: missing ${what}`);
  if (args.positional.length > count) {
    throw new Error(`criteria ${verb}: unexpected argument "${args.positional[count]}"`);
  }
  return [...args.positional];
}

// ---------------------------------------------------------------------------
// reading the files
// ---------------------------------------------------------------------------

type Session = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly ownerCheck: (harnessDir: string) => OwnerCheck;
  readonly evalsDir: string;
  readonly regrade?: (args: PreviewRegradeArgs) => Promise<EvalRunSummary>;
};

type GradersFile = {
  readonly path: string;
  readonly text: string;
  readonly revision: string;
  readonly config: GradersConfig;
  readonly compiled: ReadonlyArray<CompiledGrader>;
};

function readGraders(session: Session, args: Args): GradersFile {
  const path = resolve(session.cwd, args.values.get("graders") ?? join("eval", "graders.yaml"));
  if (!existsSync(path)) {
    throw new Error(`no graders file at ${path} — write one with \`crewhaus graders suggest\``);
  }
  // The whole file, never a capped view: a write is computed from it.
  const text = readFileSync(path, "utf8");
  const { config, compiled } = parseGradersConfig(text);
  return { path, text, revision: gradersRevision(text), config, compiled };
}

type SpecFile = {
  readonly path: string;
  readonly harnessDir: string;
  readonly doc?: Record<string, unknown>;
  readonly name?: string;
};

function readSpecDoc(session: Session, args: Args): SpecFile {
  const path = resolve(session.cwd, args.values.get("spec") ?? "crewhaus.yaml");
  const harnessDir = dirname(path);
  if (!existsSync(path)) return { path, harnessDir };
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return { path, harnessDir };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { path, harnessDir };
  const record = doc as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : undefined;
  return { path, harnessDir, doc: record, ...(name !== undefined ? { name } : {}) };
}

type HistoryLine = CriteriaHistoryLine;

const readHistory = readCriteriaHistory;

/** `r<n>`: the digest's place among the criterion's recorded revisions, or "edited outside Home". */
function revisionOf(history: ReadonlyArray<HistoryLine>, id: string, digest: string): string {
  const digests: string[] = [];
  for (const line of history) {
    if (line.criterion === id && !digests.includes(line.digest)) digests.push(line.digest);
  }
  const at = digests.indexOf(digest);
  return at >= 0 ? `r${at + 1}` : "edited outside Home";
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

const BUILTIN_NAMESPACES = [
  "provability.",
  "continuity.",
  "twelve.",
  "nlg.",
  "semantic.",
  "multimodal.",
  "safety.",
  "calibration.",
  "consistency.",
];

/** A grader spec's kind; a registry entry's from its built-in pack, else `custom`. */
function kindOf(spec: GraderSpec): GraderKind {
  const kind = kindOfGraderSpec(spec);
  if (kind !== undefined) return kind;
  if (spec.type === "registry" && BUILTIN_NAMESPACES.some((ns) => spec.grader.startsWith(ns))) {
    return builtinGraderMeta(spec.grader).kind ?? "custom";
  }
  return "custom";
}

export type CriterionRow = {
  readonly id: string;
  readonly title?: string;
  readonly source: "graders" | "implicit" | "spec";
  readonly mode: "enforce" | "observe" | "observing";
  readonly protected: boolean;
  readonly kinds: readonly GraderKind[];
  readonly digest: string;
  readonly revision: string;
};

function rowsOf(
  file: GradersFile,
  spec: SpecFile,
  history: ReadonlyArray<HistoryLine>,
): CriterionRow[] {
  const rows: CriterionRow[] = [];
  const bound = new Set<string>();
  for (const c of file.config.criteria ?? []) {
    const specs = boundSpecsOf(file.config, c);
    for (const s of specs) bound.add(s.name);
    const digest = criterionDigest(c, specs);
    rows.push({
      id: c.id,
      ...(c.title !== undefined ? { title: c.title } : {}),
      source: "graders",
      mode: c.mode ?? "enforce",
      protected: c.protected === true,
      kinds: [...new Set(specs.map(kindOf))],
      digest,
      revision: revisionOf(history, c.id, digest),
    });
  }
  for (const g of file.config.graders) {
    if (bound.has(g.name)) continue;
    rows.push({
      id: `grader:${g.name}`,
      source: "implicit",
      mode: "enforce",
      protected: false,
      kinds: [kindOf(g)],
      digest: graderSpecDigest(g),
      revision: "—",
    });
  }
  rows.push(...inLoopRows(spec.doc));
  return rows;
}

const plain = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** The bars the spec sets itself: its evaluation, its judge gates and its provability block. */
function inLoopRows(doc: Record<string, unknown> | undefined): CriterionRow[] {
  if (doc === undefined) return [];
  const rows: CriterionRow[] = [];
  const row = (
    id: string,
    block: Record<string, unknown>,
    kind: GraderKind,
    observingWhen: readonly string[],
  ): CriterionRow => ({
    id,
    source: "spec",
    mode: observingWhen.includes(String(block["on_fail"])) ? "observing" : "enforce",
    protected: block["protected"] === true,
    kinds: [kind],
    digest: stableDigest(block),
    revision: "in the spec",
  });
  const evaluation = plain(doc["evaluation"]);
  if (evaluation !== undefined) {
    const grader = plain(evaluation["grader"]);
    rows.push(
      row(
        "spec:evaluation",
        evaluation,
        grader?.["type"] === "llm_judge" ? "model" : "deterministic",
        ["note"],
      ),
    );
  }
  const steps = Array.isArray(doc["steps"]) ? (doc["steps"] as unknown[]) : [];
  for (const step of steps) {
    const s = plain(step);
    const judge = plain(s?.["judge"]);
    if (s === undefined || judge === undefined) continue;
    rows.push(row(`spec:judge:${String(s["name"])}`, judge, "model", ["continue"]));
  }
  for (const [name, node] of Object.entries(plain(doc["nodes"]) ?? {})) {
    const judge = plain(plain(node)?.["judge"]);
    if (judge !== undefined) rows.push(row(`spec:judge:${name}`, judge, "model", ["continue"]));
  }
  const provability = plain(doc["provability"]);
  if (provability !== undefined) rows.push(row("spec:provability", provability, "proof", ["note"]));
  return rows;
}

// ---------------------------------------------------------------------------
// the verbs
// ---------------------------------------------------------------------------

function listVerb(session: Session, argv: readonly string[]): CriteriaCommandResult {
  const args = parseArgs("list", argv, CLI_FAMILY.sub.list.flags);
  onlyPositional("list", args, 0, "");
  const file = readGraders(session, args);
  const spec = readSpecDoc(session, args);
  const rows = rowsOf(file, spec, readHistory(spec.harnessDir));
  if (args.booleans.has("json")) {
    return {
      lines: [
        JSON.stringify({ graders: file.path, revision: file.revision, criteria: rows }, null, 2),
      ],
      exitCode: 0,
    };
  }
  const lines = [`${file.path}  revision ${file.revision}`];
  for (const r of rows) {
    lines.push(
      `  ${r.id}${r.title !== undefined ? ` — ${r.title}` : ""}  ${r.mode}${r.protected ? "  protected" : ""}  ${r.kinds.join("+")}  ${r.digest.slice(0, 12)}  ${r.revision}`,
    );
  }
  if (rows.length === 0) lines.push("  no graders yet");
  return { lines, exitCode: 0 };
}

type GraderCounts = {
  pass: number;
  fail: number;
  notMeasured: number;
  skipped: number;
  observing: number;
  wouldFail: number;
};

/** The newest live run of this spec in the history, optionally of one dataset. */
function newestRun(
  session: Session,
  specName: string | undefined,
  datasetName?: string,
): RunIndexEntry | undefined {
  if (specName === undefined) return undefined;
  let rows: RunIndexEntry[];
  try {
    rows = readRunIndexLatest(session.evalsDir);
  } catch {
    return undefined;
  }
  return rows
    .filter(
      (r) =>
        r.specName === specName &&
        r.purpose === undefined &&
        (datasetName === undefined || r.datasetName === datasetName),
    )
    .at(-1);
}

function countsFor(samples: ReadonlyArray<SampleResult>, name: string): GraderCounts {
  const counts: GraderCounts = {
    pass: 0,
    fail: 0,
    notMeasured: 0,
    skipped: 0,
    observing: 0,
    wouldFail: 0,
  };
  for (const s of samples) {
    const g = s.grades.perGrader.find((x) => x.name === name);
    if (g === undefined) continue;
    if (g.status === "not_measured") counts.notMeasured++;
    else if (g.status === "skipped") counts.skipped++;
    else if (g.status === "observing") {
      counts.observing++;
      if (!g.passed) counts.wouldFail++;
    } else if (g.passed) counts.pass++;
    else counts.fail++;
  }
  return counts;
}

function showVerb(session: Session, argv: readonly string[]): CriteriaCommandResult {
  const args = parseArgs("show", argv, CLI_FAMILY.sub.show.flags);
  const [id] = onlyPositional("show", args, 1, "<id>");
  const file = readGraders(session, args);
  const spec = readSpecDoc(session, args);
  const history = readHistory(spec.harnessDir);
  const criterion = (file.config.criteria ?? []).find((c) => c.id === id);
  const graderName = id?.startsWith("grader:") === true ? id.slice("grader:".length) : undefined;
  const implicit =
    graderName !== undefined ? file.config.graders.find((g) => g.name === graderName) : undefined;
  if (criterion === undefined && implicit === undefined) {
    throw new Error(
      `criteria show: no criterion "${id}" in ${file.path} (crewhaus criteria list names them)`,
    );
  }
  const specs =
    criterion !== undefined ? boundSpecsOf(file.config, criterion) : [implicit as GraderSpec];
  const digest =
    criterion !== undefined
      ? criterionDigest(criterion, specs)
      : graderSpecDigest(implicit as GraderSpec);
  const revisions = history.filter((h) => h.criterion === id);
  const run = newestRun(session, spec.name);
  let results: Record<string, GraderCounts> | undefined;
  let note: string | undefined;
  if (run === undefined) {
    note = "no recorded run of this spec yet — run `crewhaus eval` to see results";
  } else {
    try {
      const recorded = readRecordedRun(run.outDir);
      results = Object.fromEntries(
        specs.map((s) => [s.name, countsFor(recorded.summary.samples, s.name)]),
      );
    } catch (err) {
      note = `the newest run ${run.runId} could not be read (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const view = {
    id,
    ...(criterion !== undefined ? { criterion } : { implicit: true }),
    graders: specs.map((s) => ({
      name: s.name,
      kind: kindOf(s),
      digest: graderSpecDigest(s).slice(0, 12),
    })),
    digest,
    revision: criterion !== undefined ? revisionOf(history, criterion.id, digest) : "—",
    history: revisions,
    ...(run !== undefined ? { run: run.runId } : {}),
    ...(results !== undefined ? { results } : {}),
    ...(note !== undefined ? { note } : {}),
  };
  if (args.booleans.has("json")) return { lines: [JSON.stringify(view, null, 2)], exitCode: 0 };
  const lines = [`${id}  ${digest.slice(0, 12)}  ${view.revision}`];
  if (criterion !== undefined) {
    if (criterion.title !== undefined) lines.push(`  title: ${criterion.title}`);
    if (criterion.description !== undefined) lines.push(`  description: ${criterion.description}`);
    lines.push(
      `  mode: ${criterion.mode ?? "enforce"}${criterion.protected === true ? ", protected" : ""}${criterion.severity !== undefined ? `, severity ${criterion.severity}` : ""}${criterion.owner !== undefined ? `, owner ${criterion.owner}` : ""}`,
    );
    if (criterion.scope !== undefined) {
      lines.push(
        `  scope: ${Object.entries(criterion.scope.metadata)
          .map(([k, v]) => `${k} in [${(v as string[]).join(", ")}]`)
          .join(" and ")}`,
      );
    }
  }
  for (const g of view.graders) lines.push(`  measured by ${g.name} (${g.kind}, ${g.digest})`);
  for (const [i, h] of revisions.entries()) {
    lines.push(`  r${i + 1} ${h.digest.slice(0, 12)} at ${h.at} by ${h.by ?? "—"} (${h.cmd})`);
  }
  if (results !== undefined && run !== undefined) {
    lines.push(`  last results (run ${run.runId}):`);
    for (const [name, c] of Object.entries(results)) {
      const parts = [
        `pass ${c.pass}`,
        `fail ${c.fail}`,
        `not measured ${c.notMeasured}`,
        `skipped ${c.skipped}`,
      ];
      if (c.observing > 0)
        parts.push(`observing ${c.observing} (would fail ${c.wouldFail} of ${c.observing})`);
      lines.push(`    ${name}: ${parts.join(", ")}`);
    }
  }
  if (note !== undefined) lines.push(`  ${note}`);
  return { lines, exitCode: 0 };
}

export type LintFinding = {
  readonly rule:
    | "unbound-grader"
    | "protected-without-owner"
    | "observe-without-cases"
    | "scope-matches-nothing"
    | "no-description";
  readonly severity: "info" | "warning";
  readonly subject: string;
  readonly message: string;
};

/** The findings for a graders config, against the dataset's cases when given. */
export function lintCriteria(
  config: GradersConfig,
  samples?: ReadonlyArray<Sample>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const bound = new Set((config.criteria ?? []).flatMap((c) => c.measured_by));
  for (const g of config.graders) {
    if (bound.has(g.name)) continue;
    findings.push({
      rule: "unbound-grader",
      severity: "info",
      subject: g.name,
      message: `grader ${g.name} measures no named criterion (it reads as grader:${g.name})`,
    });
  }
  for (const c of config.criteria ?? []) {
    if (c.protected === true && c.owner === undefined) {
      findings.push({
        rule: "protected-without-owner",
        severity: "warning",
        subject: c.id,
        message: `criterion ${c.id} is protected but names no owner — say who keeps it`,
      });
    }
    if (c.description === undefined) {
      findings.push({
        rule: "no-description",
        severity: "info",
        subject: c.id,
        message: `criterion ${c.id} has no description`,
      });
    }
    if (samples !== undefined) {
      const reached = samples.filter((s) =>
        inCriterionScope(c.scope as CriterionScope | undefined, s.metadata),
      );
      if (reached.length > 0) continue;
      if (c.mode === "observe") {
        findings.push({
          rule: "observe-without-cases",
          severity: "warning",
          subject: c.id,
          message: `criterion ${c.id} observes, but no case of the dataset is in its scope, so it would record nothing`,
        });
      } else if (c.scope !== undefined) {
        findings.push({
          rule: "scope-matches-nothing",
          severity: "warning",
          subject: c.id,
          message: `criterion ${c.id}'s scope matches no case of the dataset`,
        });
      }
    }
  }
  return findings;
}

async function lintVerb(session: Session, argv: readonly string[]): Promise<CriteriaCommandResult> {
  const args = parseArgs("lint", argv, CLI_FAMILY.sub.lint.flags);
  onlyPositional("lint", args, 0, "");
  const file = readGraders(session, args);
  const datasetPath = args.values.get("dataset");
  const samples =
    datasetPath !== undefined ? await collect(resolve(session.cwd, datasetPath)) : undefined;
  const findings = lintCriteria(file.config, samples);
  const failing = findings.some((f) => f.severity !== "info");
  if (args.booleans.has("json")) {
    return {
      lines: [JSON.stringify({ graders: file.path, findings }, null, 2)],
      exitCode: failing ? 1 : 0,
    };
  }
  const lines = findings.map(
    (f) => `${f.severity === "info" ? "info" : "warn"} ${f.rule}: ${f.message}`,
  );
  if (findings.length === 0) lines.push("no findings");
  if (samples === undefined) {
    lines.push("(pass --dataset <d> to check scopes and observed criteria against its cases)");
  }
  return { lines, exitCode: failing ? 1 : 0 };
}

async function collect(path: string): Promise<Sample[]> {
  const loaded = await loadDataset(path);
  const out: Sample[] = [];
  for await (const s of loaded.samples) out.push(s);
  return out;
}

function readEdits(verb: string, session: Session, path: string) {
  const abs = resolve(session.cwd, path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(
      `criteria ${verb}: ${abs} is not readable JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const parsed = GradersEditsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `criteria ${verb}: ${abs} is not a list of criteria edits: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Whether the graders file, links resolved, belongs to the harness directory:
 * it lies inside it (by `relative()`), and no directory between the two holds
 * a `crewhaus.yaml` of its own, so the harness of --spec is the file's
 * nearest one.
 */
function gradersInHarness(gradersPath: string, harnessDir: string): boolean {
  let file: string;
  let root: string;
  try {
    file = realpathSync(gradersPath);
    root = realpathSync(harnessDir);
  } catch {
    return false;
  }
  const rel = relative(root, file);
  if (!(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))) return false;
  for (let dir = dirname(file); dir !== root; dir = dirname(dir)) {
    if (existsSync(join(dir, "crewhaus.yaml"))) return false;
    // Unreachable while `file` is inside `root`; a guard against a loop.
    if (dirname(dir) === dir) return false;
  }
  return true;
}

function applyVerb(session: Session, argv: readonly string[]): CriteriaCommandResult {
  const args = parseArgs("apply", argv, CLI_FAMILY.sub.apply.flags);
  const [editsPath] = onlyPositional("apply", args, 1, "<edits.json>");
  const expect = args.values.get("expect");
  if (expect === undefined) {
    throw new Error(
      "criteria apply: --expect <revision> is required (`crewhaus criteria list` prints it)",
    );
  }
  const edits = readEdits("apply", session, editsPath as string);
  const file = readGraders(session, args);
  if (expect !== file.revision) {
    return {
      lines: [
        `criteria apply: ${file.path} changed since revision ${expect}; nothing was written`,
        `current revision: ${file.revision}`,
      ],
      exitCode: 1,
    };
  }
  const result = applyGradersEdits(file.text, edits);
  const spec = readSpecDoc(session, args);
  // One harness: the owner check, the typed name, the write and the history
  // line all bind to the harness of --spec, so the graders file must be in it.
  if (!gradersInHarness(file.path, spec.harnessDir)) {
    return {
      lines: [
        "criteria apply: the graders file is not inside the harness of --spec; nothing was written",
      ],
      exitCode: 1,
    };
  }
  const owner = session.ownerCheck(spec.harnessDir);
  const loosened = loosening(file.config, result.config);
  if (loosened.length > 0) {
    const reasons = loosened.map((l) => `  ${l.criterion}: ${l.reason}`);
    if (spec.name === undefined || args.values.get("confirm") !== spec.name) {
      return {
        lines: [
          "criteria apply: these edits loosen a protected criterion; nothing was written",
          ...reasons,
          spec.name === undefined
            ? `  no spec name could be read from ${spec.path} to confirm it`
            : `  confirm with --confirm ${spec.name} (the spec's name), as its owner`,
        ],
        exitCode: 1,
      };
    }
    if (!owner.ok) {
      return {
        lines: [
          "criteria apply: these edits loosen a protected criterion, which needs this harness's owner; nothing was written",
          ...reasons,
          `  ${owner.reason}`,
        ],
        exitCode: 1,
      };
    }
  }
  // In place, so the file keeps its mode.
  writeFileSync(file.path, result.yaml);
  const at = new Date(session.now()).toISOString();
  const by = owner.ok && owner.principal !== undefined ? { by: owner.principal } : {};
  {
    // Contained in the harness directory, and never through a link at the file.
    const appended = appendCriteriaHistory(spec.harnessDir, result.changed, {
      at,
      cmd: CRITERIA_APPLY_CMD,
      ...by,
    });
    if (!appended.ok) {
      return {
        lines: [
          `criteria apply: wrote ${file.path}, but could not record its history in ${CRITERIA_HISTORY_REL} (${appended.reason})`,
        ],
        exitCode: 1,
      };
    }
  }
  const lines = [
    `applied ${edits.length} edit(s) to ${file.path}`,
    `revision ${gradersRevision(result.yaml)}`,
    `gradersHash ${result.gradersHash}${result.gradersHash !== gradersConfigHash(file.config) ? " (runs after this read as measured differently)" : ""}`,
  ];
  for (const c of result.changed) {
    lines.push(
      c.after === undefined
        ? `  ${c.criterion}: removed`
        : c.before === undefined
          ? `  ${c.criterion}: added (${c.after.slice(0, 12)})`
          : `  ${c.criterion}: ${c.before.slice(0, 12)} → ${c.after.slice(0, 12)}`,
    );
  }
  return { lines, exitCode: 0 };
}

/** A case's verdict as one word. */
function verdictOf(s: SampleResult | undefined): string {
  if (s === undefined) return "absent";
  if (s.error !== undefined) return "error";
  const overall = s.grades.overall;
  if (overall.status !== undefined)
    return overall.status === "not_measured" ? "not measured" : overall.status;
  if (overall.abstained === true) return "abstained";
  return overall.passed ? "pass" : "fail";
}

async function previewVerb(
  session: Session,
  argv: readonly string[],
): Promise<CriteriaCommandResult> {
  const args = parseArgs("preview", argv, CLI_FAMILY.sub.preview.flags);
  const [editsPath] = onlyPositional("preview", args, 1, "<edits.json>");
  const datasetPath = args.values.get("dataset");
  if (datasetPath === undefined) {
    throw new Error(
      "criteria preview: --dataset <d> is required — a regrade reads each case's input from it",
    );
  }
  const edits = readEdits("preview", session, editsPath as string);
  const file = readGraders(session, args);
  const spec = readSpecDoc(session, args);
  const edited = applyGradersEdits(file.text, edits);
  const absDataset = resolve(session.cwd, datasetPath);
  const loaded = await loadDataset(absDataset);
  const samples: Sample[] = [];
  for await (const s of loaded.samples) samples.push(s);
  const datasetHash = hashDatasetFile(absDataset);

  const runFlag = args.values.get("run");
  let source: RunIndexEntry | undefined;
  if (runFlag !== undefined) {
    const { resolveRegradeSource } = await import("./eval-regrade");
    source = resolveRegradeSource(runFlag, session.evalsDir);
  } else {
    source = newestRun(session, spec.name, loaded.name);
  }
  if (source === undefined) {
    return {
      lines: [
        `criteria preview: no recorded run of ${spec.name ?? spec.path} on ${loaded.name} to regrade — run \`crewhaus eval\` first, or name one with --run`,
      ],
      exitCode: 1,
    };
  }

  // What the regrade would call: every judge-backed grader on every case it
  // can regrade, in its scope, without a recorded grade to reuse.
  const { compiled } = parseGradersConfig(edited.yaml);
  const criteria = runCriteriaRecord(edited.config);
  const plan = createRegrade({
    sourceDir: source.outDir,
    purpose: "preview",
    samples,
    datasetHash,
    ...(criteria !== undefined ? { criteria } : {}),
    ...(source.judgeModel !== undefined ? { judgeModel: source.judgeModel } : {}),
  });
  const specs = new Map(edited.config.graders.map((g) => [g.name, g]));
  let judgeCalls = 0;
  for (const g of compiled) {
    const gs = specs.get(g.name);
    if (gs === undefined || kindOf(gs) !== "model") continue;
    const perCase = gs.type === "llm_judge" ? (gs.judges?.length ?? 1) * (gs.repeats ?? 1) : 1;
    for (const s of samples) {
      if (!inCriterionScope(g.criterion?.scope, s.metadata)) continue;
      if (plan.caseRefusal(s.id) !== undefined) continue;
      if (plan.reuse(s.id, g.name) !== undefined) continue;
      judgeCalls += perCase;
    }
  }
  const recordedCalls = plan.source.summary.aggregates.judgeUsage?.calls;
  const estimate =
    source.judgeCostUsd !== undefined && recordedCalls !== undefined && recordedCalls > 0
      ? `about $${((source.judgeCostUsd / recordedCalls) * judgeCalls).toFixed(4)}`
      : "cost unknown";
  if (judgeCalls > 0 && !args.booleans.has("yes")) {
    return {
      lines: [
        `criteria preview: regrading run ${source.runId} with these edits would make ${judgeCalls} judge call(s), ${estimate}`,
        "  nothing was run; add --yes to run it",
      ],
      exitCode: 1,
    };
  }
  if (session.regrade === undefined) {
    throw new Error("criteria preview: no regrade is wired in this build");
  }
  const regraded = await session.regrade({
    specPath: spec.path,
    outDir: join(session.evalsDir, `run_${randomBytes(8).toString("hex")}`),
    ...(source.judgeModel !== undefined ? { judgeModel: source.judgeModel } : {}),
    sourceDir: source.outDir,
    datasetName: loaded.name,
    samples,
    datasetHash,
    compiled,
    gradersConfig: edited.config,
    gradersHash: edited.gradersHash,
  });
  const before = new Map(plan.source.summary.samples.map((s) => [s.sampleId, s]));
  const changes = regraded.samples
    .map((s) => ({ id: s.sampleId, from: verdictOf(before.get(s.sampleId)), to: verdictOf(s) }))
    .filter((c) => c.from !== c.to);
  let comparable: boolean | undefined;
  if (spec.name !== undefined) {
    try {
      const pin = getBaseline(spec.name, loaded.name, session.evalsDir);
      if (pin?.gradersHash !== undefined) comparable = pin.gradersHash === edited.gradersHash;
    } catch {
      comparable = undefined;
    }
  }
  const view = {
    run: source.runId,
    preview: regraded.runId,
    gradersHash: edited.gradersHash,
    judgeCalls,
    changes,
    nextGate:
      comparable === undefined
        ? "no baseline to compare"
        : comparable
          ? "comparable"
          : "not comparable",
  };
  if (args.booleans.has("json")) return { lines: [JSON.stringify(view, null, 2)], exitCode: 0 };
  const lines = [
    `preview of run ${source.runId} with the edits: ${regraded.runId} (never gated or pinned)`,
    `gradersHash ${edited.gradersHash}`,
    ...(judgeCalls > 0 ? [`judge calls: ${judgeCalls}, ${estimate}`] : ["no judge calls"]),
  ];
  if (changes.length === 0) lines.push("no case changes its verdict");
  for (const c of changes) lines.push(`  ${c.id}: ${c.from} → ${c.to}`);
  lines.push(
    comparable === false
      ? "the next `crewhaus eval --gate` reads not comparable (the graders changed); `--regrade-baseline` gates it on the baseline's answers"
      : comparable === true
        ? "the next `crewhaus eval --gate` compares as before"
        : "no pinned baseline to compare against yet",
  );
  return { lines, exitCode: 0 };
}

/** The CLI's own regrade for a preview: the spec lowered, the run graded, nothing recorded. */
async function cliPreviewRegrade(args: PreviewRegradeArgs): Promise<EvalRunSummary> {
  const [{ lower }, { parseSpec }, { regradeRecordedRun }, { graderRegistryForCompiled }] =
    await Promise.all([
      import("@crewhaus/compiler"),
      import("@crewhaus/spec"),
      import("./eval-regrade"),
      import("./eval-output"),
    ]);
  const ir = lower(parseSpec(readFileSync(args.specPath, "utf8")));
  if (ir.target !== "cli")
    throw new Error(
      `criteria preview: only a target: cli spec can be evaluated (got ${ir.target})`,
    );
  const graderRegistry = await graderRegistryForCompiled(args.compiled);
  return regradeRecordedRun({
    ir,
    sourceDir: args.sourceDir,
    purpose: "preview",
    datasetName: args.datasetName,
    samples: args.samples,
    datasetHash: args.datasetHash,
    compiled: args.compiled,
    gradersConfig: args.gradersConfig,
    gradersHash: args.gradersHash,
    outDir: args.outDir,
    ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
    ...(graderRegistry !== undefined ? { graderRegistry } : {}),
  });
}

/** Run `crewhaus criteria <verb> ...`. */
export async function runCriteriaCommand(
  argv: readonly string[],
  opts: CriteriaCommandOptions = {},
): Promise<CriteriaCommandResult> {
  const verb = argv[0] ?? "";
  if (verb === "" || verb === "--help" || verb === "-h" || verb === "help") {
    return { lines: CRITERIA_USAGE_LINES, exitCode: 0 };
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { lines: CRITERIA_USAGE_LINES, exitCode: 0 };
  }
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const session: Session = {
    cwd,
    env,
    now: opts.now ?? Date.now,
    ownerCheck: opts.ownerCheck ?? ((dir) => defaultOwnerCheck(dir, undefined, env)),
    evalsDir: opts.evalsDir ?? join(cwd, ".crewhaus", "evals"),
    regrade: opts.regrade ?? cliPreviewRegrade,
  };
  switch (verb) {
    case "list":
      return listVerb(session, rest);
    case "show":
      return showVerb(session, rest);
    case "lint":
      return lintVerb(session, rest);
    case "apply":
      return applyVerb(session, rest);
    case "preview":
      return previewVerb(session, rest);
    default:
      throw new Error(
        `criteria: unknown verb "${verb}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
      );
  }
}
