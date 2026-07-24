/**
 * "Watch me" lifecycle core (watch-me §7) — the pure, side-effect-free half of
 * `crewhaus watchme start|stop|status`. Owns spec-path resolution (standalone-
 * harness cwd convention), the start/stop state transitions over the watchme
 * store's `state.json`, registration in the global user-scope harness registry
 * (what `report --all` iterates), and the status summary assembly.
 *
 * Everything effectful is an injected seam (watch.ts / feedback.ts precedent):
 * the store and registry arrive as narrow structural slices of the
 * `@crewhaus/watchme-store` objects, the sessions directory arrives as a
 * basename listing, and the immediate deterministic backfill `watchme start`
 * triggers is a callback the CLI wires to the report module — this module
 * never imports watchme-report, so the lifecycle verbs stay unit-testable
 * with manual fakes and free of the report module's heavy seams.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { HarnessRegistry, WatchmeState, WatchmeStore } from "@crewhaus/watchme-store";

export { resolveWatchmeEnv } from "./run-observability";

export class WatchmeError extends Error {
  override readonly name = "WatchmeError";
}

/**
 * Resolve the spec behind a `watchme` action: the explicit `--spec` when
 * given, else `crewhaus.yaml` in the cwd (the standalone-harness convention —
 * the watched sessions live under the `.crewhaus/` of the directory you run
 * from, so its spec is the natural default). Returns an ABSOLUTE path. Throws
 * `WatchmeError` — naming the candidate(s) it looked for — when the chosen
 * spec does not exist. `exists` is injected so resolution is unit-testable
 * without touching the filesystem.
 */
export function resolveWatchmeSpecPath(
  specFlag: string | undefined,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (specFlag !== undefined) {
    const abs = isAbsolute(specFlag) ? specFlag : resolve(cwd, specFlag);
    if (!exists(abs)) {
      throw new WatchmeError(`--spec not found: ${abs}`);
    }
    return abs;
  }
  const fallback = join(cwd, "crewhaus.yaml");
  if (!exists(fallback)) {
    throw new WatchmeError(
      `no --spec given and no crewhaus.yaml in ${cwd}. Pass --spec <path>, or run from the harness directory whose .crewhaus/sessions you want watched.`,
    );
  }
  return fallback;
}

/** The store slice the start/stop transitions drive. */
export type WatchmeLifecycleStore = Pick<WatchmeStore, "state" | "setState">;

/** The store slice `watchme status` reads. */
export type WatchmeStatusStore = Pick<
  WatchmeStore,
  "state" | "readObservations" | "readAggregates"
>;

/** The harness identity `watchme start` upserts into the global (user-scope)
 *  registry — the `HarnessEntry` descriptive fields; the registry stamps
 *  `registeredAt`/`lastSeen` itself. */
export type WatchmeHarnessIdentity = {
  readonly dir: string;
  readonly specName: string;
  readonly target: string;
  readonly agentId?: string;
};

export type WatchmeStartOptions<T> = {
  readonly store: WatchmeLifecycleStore;
  readonly registry: Pick<HarnessRegistry, "register">;
  readonly harness: WatchmeHarnessIdentity;
  /** The immediate deterministic backfill digest over the sessions that
   *  already exist (day-one value from the default-on advisor mirrors). The
   *  CLI wires this to watchme-report's phase 1; injected so this module
   *  never imports the report module. Runs AFTER the state flip + registry
   *  upsert have landed, so a backfill crash never loses the start itself. */
  readonly runBackfill: () => T | Promise<T>;
  readonly now?: () => number;
};

export type WatchmeStartResult<T> = {
  /** True when `state.json` already said watching. Start is idempotent: the
   *  original `startedAt` is preserved, and the registry upsert + backfill
   *  still run (the report window key dedupes repeat digests). */
  readonly alreadyWatching: boolean;
  readonly startedAt: number;
  readonly backfill: T;
};

/**
 * `watchme start`: flip `state.json` to watching, register the harness in the
 * global registry, then run the immediate deterministic backfill digest.
 */
export async function watchmeStart<T>(
  opts: WatchmeStartOptions<T>,
): Promise<WatchmeStartResult<T>> {
  const now = opts.now ?? Date.now;
  const prior = opts.store.state();
  const alreadyWatching = prior.watching;
  const startedAt = alreadyWatching && prior.startedAt !== undefined ? prior.startedAt : now();
  opts.store.setState({ watching: true, startedAt });
  opts.registry.register(opts.harness);
  const backfill = await opts.runBackfill();
  return { alreadyWatching, startedAt, backfill };
}

export type WatchmeStopOptions = {
  readonly store: WatchmeLifecycleStore;
  readonly registry: Pick<HarnessRegistry, "deregister">;
  /** The harness dir `--forget` deregisters (the registry's upsert key). */
  readonly harnessDir: string;
  /** `--forget`: also drop this harness from the global registry. The digest
   *  data under `.crewhaus/watchme/` is ALWAYS kept — stop never deletes. */
  readonly forget?: boolean;
};

export type WatchmeStopResult = {
  readonly wasWatching: boolean;
  readonly forgotten: boolean;
};

/** `watchme stop`: flip `state.json` to not-watching (data kept). */
export function watchmeStop(opts: WatchmeStopOptions): WatchmeStopResult {
  const wasWatching = opts.store.state().watching;
  opts.store.setState({ watching: false });
  if (opts.forget === true) opts.registry.deregister(opts.harnessDir);
  return { wasWatching, forgotten: opts.forget === true };
}

/** The `watchme status` summary — the `--json` payload; `formatWatchmeStatus`
 *  renders the same object for humans. */
export type WatchmeStatusSummary = {
  readonly watching: boolean;
  readonly startedAt?: number;
  readonly watermark: WatchmeState["watermark"];
  /** Session event logs on disk (`<id>.jsonl`, trace siblings excluded). */
  readonly sessionsCaptured: number;
  /** Sessions already digested into `observations.jsonl`: raw digest lines
   *  plus the sessions folded away into `{agg:1}` lines by `compact()`. */
  readonly sessionsAnalyzed: number;
  /** `.events.jsonl` trace-sibling coverage over the captured sessions. */
  readonly eventsCoverage: { readonly withEvents: number; readonly total: number };
  readonly lastReportAt?: number;
  /** Consumed report windows by windowKey → outcome. */
  readonly windows: WatchmeState["windows"];
  /** Harnesses in the global registry (vanished dirs already pruned). */
  readonly registeredHarnesses: number;
};

export type WatchmeStatusOptions = {
  readonly store: WatchmeStatusStore;
  readonly registry: Pick<HarnessRegistry, "list">;
  /** Basenames in `.crewhaus/sessions` (a missing dir lists as empty). The
   *  caller lists the directory; this module classifies the names. */
  readonly sessionFiles: readonly string[];
};

const EVENTS_SUFFIX = ".events.jsonl";
const LOG_SUFFIX = ".jsonl";

/** Assemble the `watchme status` summary from the injected store, registry,
 *  and sessions-directory listing. Pure — no fs, no clock. */
export function watchmeStatus(opts: WatchmeStatusOptions): WatchmeStatusSummary {
  const state = opts.store.state();
  const logs = new Set<string>();
  const events = new Set<string>();
  for (const name of opts.sessionFiles) {
    if (name.endsWith(EVENTS_SUFFIX)) {
      events.add(name.slice(0, -EVENTS_SUFFIX.length));
    } else if (name.endsWith(LOG_SUFFIX)) {
      logs.add(name.slice(0, -LOG_SUFFIX.length));
    }
  }
  let withEvents = 0;
  for (const id of logs) {
    if (events.has(id)) withEvents += 1;
  }
  const analyzedRaw = opts.store.readObservations().length;
  const analyzedFolded = opts.store.readAggregates().reduce((sum, agg) => sum + agg.n, 0);
  return {
    watching: state.watching,
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    watermark: state.watermark,
    sessionsCaptured: logs.size,
    sessionsAnalyzed: analyzedRaw + analyzedFolded,
    eventsCoverage: { withEvents, total: logs.size },
    ...(state.lastReportAt !== undefined ? { lastReportAt: state.lastReportAt } : {}),
    windows: state.windows,
    registeredHarnesses: opts.registry.list().length,
  };
}

function shortIso(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

function summarizeWindowOutcomes(windows: WatchmeStatusSummary["windows"]): string {
  const counts = new Map<string, number>();
  for (const outcome of Object.values(windows)) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  if (counts.size === 0) return "none consumed";
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(" · ");
}

/** Render the status summary as the human `watchme status` block (dream-cli
 *  status mold); `--json` callers serialize the summary object instead. */
export function formatWatchmeStatus(summary: WatchmeStatusSummary): string {
  const lines: string[] = [];
  lines.push(
    summary.watching
      ? `watching${summary.startedAt !== undefined ? ` since ${shortIso(summary.startedAt)}` : ""}`
      : "not watching ('crewhaus watchme start' to begin)",
  );
  lines.push(
    `  ${"sessions".padEnd(11)} ${summary.sessionsCaptured} captured · ${summary.sessionsAnalyzed} analyzed · ${summary.eventsCoverage.withEvents}/${summary.eventsCoverage.total} with .events.jsonl siblings`,
  );
  lines.push(
    summary.watermark.lastMtimeMs > 0
      ? `  ${"watermark".padEnd(11)} ${shortIso(summary.watermark.lastMtimeMs)}${summary.watermark.lastSessionId !== undefined ? ` (${summary.watermark.lastSessionId})` : ""}`
      : `  ${"watermark".padEnd(11)} none (no analysis yet)`,
  );
  lines.push(
    summary.lastReportAt !== undefined
      ? `  ${"last report".padEnd(11)} ${shortIso(summary.lastReportAt)}`
      : `  ${"last report".padEnd(11)} never`,
  );
  lines.push(`  ${"windows".padEnd(11)} ${summarizeWindowOutcomes(summary.windows)}`);
  lines.push(
    `  ${"registry".padEnd(11)} ${summary.registeredHarnesses} registered harness${summary.registeredHarnesses === 1 ? "" : "es"}`,
  );
  return lines.join("\n");
}
