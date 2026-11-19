/**
 * The home area through the API (#524, #507, #513): what a person may take away from a
 * harness, and the `evalrun` and `session` refs, so a link to either opens in place.
 *
 * - `exports.spec` answers the spec as Home shows it: the YAML masked by key name, its
 *   first line saying so, and the real file's place on Home's computer only for a caller
 *   who may read raw files there.
 * - `exports.evalResults` answers one evaluation run's rows as CSV or JSONL, read from
 *   inside the harness's `.crewhaus/evals` and nowhere else.
 * - `exports.harness` writes an archive of the harness's state on Home's own computer,
 *   under Home's folder (`exports/<harness>/<id>.tar.gz`, the folder readable only by its
 *   owner), through a job that runs `crewhaus state backup --out <path>` in the harness
 *   folder. The path is Home's choice, never the request's; the receipt settles with the
 *   job. The archive is never sent to a browser.
 * - `exports.list` names the archives Home wrote for a harness; nothing is opened.
 *
 * Every answer passes the router's one masker, like every other answer.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { EXPORT_FORMATS, type ExportFormat } from "@crewhaus/control-contract";
import { outcomeOf } from "@crewhaus/control-service";
import { buildExportRows, rowsToCsv, rowsToJsonl } from "@crewhaus/eval-report";
import { type HangarHarnessEntry, slugOf } from "@crewhaus/harness-registry";
import { shellQuote } from "@crewhaus/harness-supervisor";
import { exportHarnessArgv } from "@crewhaus/harness-supervisor/job-kinds";
import { MAX_TEXT_BYTES } from "../constants";
import { isRunId } from "../evals";
import { readTextCapped } from "../jsonl";
import { maskSpecYaml } from "../mask";
import { resolveContained, resolveInside } from "../safety";
import { reachableSessionRoot } from "../sessions";
import type { HomeAreaRuntime } from "./areas";
import type { RefResolver, V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { hrefOf } from "./meta";
import { harnessOf, liveDirOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

/** The first line of an exported spec: what the text is, and what it is not. */
export const SPEC_EXPORT_HEADER =
  "# Exported from Home. Values under credential-like names are masked; this is not the file on disk.";

/** The most of one evaluation run's results Home reads to export it. */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

/** Where Home keeps the archives it writes, under its own folder. */
export const EXPORTS_DIR = "exports";

const SPEC_FILE = "crewhaus.yaml";

/** A harness's display name in a filename: its slug, or its id. */
function nameOf(entry: HangarHarnessEntry): string {
  return entry.slug ?? slugOf(entry.specName) ?? entry.id;
}

/** Whether the caller may see paths on Home's computer for this harness. */
function seesHostPaths(ctx: V1Context, harness: string): boolean {
  return ctx.access.authorize("h.files.raw", { harness }).allow;
}

function notFound(reason: string, message: string, remedy?: string): V1Error {
  return new V1Error({
    status: 404,
    code: "not_found",
    reason,
    message,
    ...(remedy !== undefined ? { remedy } : {}),
  });
}

const exportSpec: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const path = resolveInside(dir, [SPEC_FILE]);
  if (path === undefined || !existsSync(path)) {
    throw notFound("spec_missing", "This harness has no crewhaus.yaml to export.");
  }
  const read = readTextCapped(path, MAX_TEXT_BYTES);
  if (read.truncated) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "too_large",
      message:
        "This spec is too large to export from Home. Copy crewhaus.yaml from the harness folder.",
    });
  }
  return {
    status: 200,
    body: {
      filename: `${nameOf(entry)}-crewhaus.yaml`,
      contentType: "application/yaml",
      text: `${SPEC_EXPORT_HEADER}\n${maskSpecYaml(read.text)}`,
      note: seesHostPaths(ctx, entry.id)
        ? `On ${hostname()} the file is ${join(dir, SPEC_FILE)}`
        : null,
    },
    scrubDir: dir,
  };
};

/** A run summary, as the export reads it. */
type EvalRunSummary = Parameters<typeof buildExportRows>[0][number]["summary"];

/** One run's summary, read from inside the harness's evals folder, or why not. */
function evalSummaryOf(dir: string, run: string): EvalRunSummary {
  const missing = () =>
    notFound("evalrun_unknown", "This harness has no evaluation run by that id with results.");
  if (!isRunId(run)) throw missing();
  const path = resolveInside(dir, [".crewhaus", "evals", run, "results.json"]);
  if (path === undefined || !existsSync(path)) throw missing();
  const read = readTextCapped(path, MAX_EXPORT_BYTES);
  if (read.truncated) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "too_large",
      message: "This run's results are too large to export from Home.",
      verb: "crewhaus eval-report export --runs <run-dir> --format csv",
    });
  }
  if (read.text === "") throw missing();
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    parsed = undefined;
  }
  const summary = parsed as Partial<EvalRunSummary> | undefined;
  if (
    typeof summary !== "object" ||
    summary === null ||
    !Array.isArray(summary.samples) ||
    typeof summary.config !== "object" ||
    summary.config === null
  ) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "unreadable",
      message: "This run's results could not be read.",
    });
  }
  return summary as EvalRunSummary;
}

const exportEvalResults: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const format = (ctx.query["format"] ?? "csv") as ExportFormat;
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: "format",
      message: "An export is csv or jsonl.",
    });
  }
  const run = ctx.params["run"] ?? "";
  const summary = evalSummaryOf(dir, run);
  let rows: ReturnType<typeof buildExportRows>;
  try {
    rows = buildExportRows([{ summary, specName: entry.specName }]);
  } catch {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "unreadable",
      message: "This run's results could not be read.",
    });
  }
  return {
    status: 200,
    body: {
      filename: `${run}.${format}`,
      contentType: format === "csv" ? "text/csv" : "application/x-ndjson",
      format,
      runId: run,
      text: format === "csv" ? rowsToCsv(rows) : rowsToJsonl(rows),
      rows: rows.length,
      masked: true,
    },
    scrubDir: dir,
  };
};

/** The folder Home keeps a harness's archives in, created inside its own, or `undefined`. */
function exportsDirOf(hangarRoot: string, harness: string, create: boolean): string | undefined {
  const rel = join(EXPORTS_DIR, harness);
  const contained = resolveContained(hangarRoot, rel);
  if (contained === undefined) return undefined;
  if (create) {
    try {
      mkdirSync(contained, { recursive: true, mode: 0o700 });
    } catch {
      return undefined;
    }
  }
  // Created or not, it must still be a real folder inside Home's own.
  let real: string;
  let root: string;
  try {
    real = realpathSync(contained);
    root = realpathSync(hangarRoot);
  } catch {
    return undefined;
  }
  const back = relative(root, real);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) return undefined;
  try {
    if (!lstatSync(contained).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return contained;
}

/** The command the export job runs, as it would be typed in the harness folder. */
export function exportCommand(dir: string, out: string): string {
  return `cd ${shellQuote(dir)} && crewhaus state backup --out ${shellQuote(out)}`;
}

/** The archive a command writes: named for the receipt, so a repeat names the same one. */
function archiveName(cmd: string): string {
  return `${cmd.replace(/^cmd_/, "")}.tar.gz`;
}

const exportHarness: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const submit = ctx.deps.submitExportJob;
  if (submit === undefined) {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: "no_jobs",
      message: "This Home starts no jobs, so it cannot write an archive.",
      verb: "crewhaus state backup --out <path>",
    });
  }
  const folder = exportsDirOf(ctx.deps.hangarRoot, entry.id, true);
  if (folder === undefined) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "exports_unwritable",
      message: "Home's exports folder is not a folder inside Home's own, so nothing is written.",
    });
  }
  type Started =
    | { readonly path: string; readonly job: { readonly jobId: string; readonly state: string } }
    | { readonly refused: string };
  const submitted = await submitCommand<Started>(ctx, {
    target: `home/harness/${entry.id}`,
    ledger: { harness: dir },
    effect: async (receipt) => {
      const out = join(folder, archiveName(receipt.id));
      try {
        const job = submit(entry, exportHarnessArgv(out), {
          commandId: receipt.id,
          by: receipt.actor,
        });
        // No settlement here: the job moves the receipt when it ends.
        return { value: { path: out, job: { jobId: job.jobId, state: job.state } } };
      } catch (err) {
        return {
          settle: { state: "rejected", outcome: outcomeOf("conflict") },
          value: { refused: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  });
  const value = submitted.value;
  if (value !== undefined && "refused" in value) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "job_refused",
      message: `The export job could not be queued: ${value.refused}`,
      details: { receipt: submitted.receipt },
    });
  }
  const path = value?.path ?? join(folder, archiveName(submitted.receipt.id));
  return acceptedAnswer(
    submitted,
    {
      path,
      command: exportCommand(dir, path),
      job: value?.job ?? null,
    },
    dir,
  );
};

const listExports: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const folder = exportsDirOf(ctx.deps.hangarRoot, entry.id, false);
  const rows: { name: string; bytes: number; at: string }[] = [];
  const names = folder === undefined ? [] : safeReaddir(folder).map((name) => [name, folder]);
  for (const [name, inside] of names as [string, string][]) {
    if (!name.endsWith(".tar.gz")) continue;
    try {
      const stats = lstatSync(join(inside, name));
      if (!stats.isFile()) continue;
      rows.push({ name, bytes: stats.size, at: stats.mtime.toISOString() });
    } catch {
      // gone since the listing: not shown
    }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name < b.name ? 1 : -1));
  const where = folder ?? join(ctx.deps.hangarRoot, EXPORTS_DIR, entry.id);
  return {
    status: 200,
    body: {
      exports: rows,
      note:
        rows.length === 0
          ? "No archives yet. Export the harness to write one on Home's computer."
          : `Saved on ${hostname()} in ${where}. Copy them from there.`,
    },
  };
};

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function harnessDir(ctx: V1Context, scope: string): string {
  const entry = harnessOf({ ...ctx, params: { ...ctx.params, h: scope } });
  const dir = liveDirOf(entry);
  if (dir === undefined) throw notFound("ref_unknown", "This Home has no harness by that ref.");
  return dir;
}

/**
 * An evaluation run, read from the harness's evals folder. The quality area owns eval runs;
 * when it registers this kind's resolver it moves the kind there, since one kind is
 * resolved by one area.
 */
const resolveEvalRun: RefResolver = async (ctx, ref) => {
  const dir = harnessDir(ctx, ref.scope);
  const runDir = isRunId(ref.id) ? resolveInside(dir, [".crewhaus", "evals", ref.id]) : undefined;
  let isDir = false;
  try {
    isDir = runDir !== undefined && statSync(runDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw notFound("ref_unknown", "This Home has no evaluation run by that ref.");
  const results = resolveInside(dir, [".crewhaus", "evals", ref.id, "results.json"]);
  const recorded = results !== undefined && existsSync(results);
  return {
    status: 200,
    body: {
      kind: "evalrun",
      ...hrefOf(ctx, `${ref.scope}/evalrun/${ref.id}`),
      rev: recorded ? "results" : "running",
      summary: recorded ? "An evaluation run" : "An evaluation run with no results yet",
    },
    scrubDir: dir,
  };
};

/** A conversation, found only in the harness's own sessions folder. */
const resolveSession: RefResolver = async (ctx, ref) => {
  const dir = harnessDir(ctx, ref.scope);
  const reach = reachableSessionRoot(dir);
  if (!reach.reachable) {
    throw notFound("unreachable", "This harness's sessions folder is unreachable.");
  }
  const path = resolveContained(reach.root, `${ref.id}.json`);
  if (path === undefined) throw notFound("ref_unknown", "This Home has no session by that ref.");
  const read = readTextCapped(path, MAX_TEXT_BYTES);
  if (read.text === "") throw notFound("ref_unknown", "This Home has no session by that ref.");
  let turn: number | undefined;
  try {
    const meta = JSON.parse(read.text) as { lastTurnIndex?: unknown };
    turn = typeof meta.lastTurnIndex === "number" ? meta.lastTurnIndex : undefined;
  } catch {
    turn = undefined;
  }
  return {
    status: 200,
    body: {
      kind: "session",
      ...hrefOf(ctx, `${ref.scope}/session/${ref.id}`),
      rev: String(turn ?? 0),
      summary: "A conversation",
    },
    scrubDir: dir,
  };
};

export const HOME_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "exports.spec": exportSpec,
  "exports.evalResults": exportEvalResults,
  "exports.harness": exportHarness,
  "exports.list": listExports,
};

export const HOME_HOME: HomeAreaRuntime = {
  area: "home",
  handlers: HOME_HANDLERS,
  refResolvers: { evalrun: resolveEvalRun, session: resolveSession },
};
