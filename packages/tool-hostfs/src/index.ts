/**
 * `@crewhaus/tool-hostfs` — the filesystem work that is about the HOST rather
 * than about the workspace.
 *
 * `@crewhaus/tool-fs` reads and writes files. `@crewhaus/tool-fsx` copies,
 * moves and removes them. What is left over are three jobs that need
 * something the operating system owns:
 *
 *   - `WatchPath` waits on the kernel's change notifications, bounded by both
 *     a deadline and an event cap, and reports which of the two ended it.
 *   - `TrashPath` moves a path into the OS trash — the recoverable deletion,
 *     which is a different operation from `rm` and not an alias for it.
 *   - `OsIndexSearch` asks the index the OS already maintains, and reports a
 *     missing or stale index as a distinct answer rather than as "no matches".
 *
 * FOUR RULES HOLD ACROSS ALL THREE.
 *
 * 1. THE HOST IS NEVER ASSUMED. Every platform-specific path is behind a
 *    seam in `./host` and `./run`, every parser is fed from output recorded
 *    on a real machine (`./fixtures`), and a platform this package cannot
 *    serve CORRECTLY is refused with the reason rather than approximated. The
 *    refusals are in the tools' own descriptions, so a model reads them
 *    before it calls and not after.
 * 2. ARGV IS AN ARRAY. There is no shell here, and no command line is built
 *    by interpolation. The one backend whose query language could still be
 *    injected — Spotlight's predicate — is escaped and then asserted to start
 *    with `kMDItem` before it is allowed to become an argv element, because
 *    `mdfind` has no `--` (recorded) and so cannot be defended the usual way.
 * 3. A DESTRUCTIVE TOOL OFFERS A DRY RUN THROUGH ITS OWN CODE PATH.
 *    `TrashPath` plans, and `dryRun` reports the plan; the real call applies
 *    the same plan. A preview that re-derived the answer separately would
 *    eventually describe something the real call does not do.
 * 4. AN ANSWER SAYS WHAT IT IS. "No events" names the bound that ended the
 *    watch. "No matches" names the state of the index it came from. A caller
 *    that cannot tell an empty answer from a broken one will act on both.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type HostPlatform, hostPlatform, now, probePath } from "./host";
import type { CoalescedEvent, EventKind, StopReason } from "./lib/coalesce";
import {
  LOCATE_DB_PATHS,
  type LocateBackend,
  classifyLocateResult,
  describeIndexAge,
  locateArgv,
} from "./lib/locate";
import { applyLimit, compileGlob, dropTruncatedTail, scopeResults } from "./lib/scope";
import {
  buildPredicate,
  classifyMdfindResult,
  mdfindArgv,
  mdutilArgv,
  parseMdutilStatus,
  parseNulList,
  rejectUnsafeQuery,
} from "./lib/spotlight";
import { type AppliedEntry, applyEntry, findTopdir, planTrash } from "./lib/trash-engine";
import { RECONCILE_MAX_ENTRIES, runWatchSession, snapshotTree } from "./lib/watch-session";
import { ToolPermissionError, resolveSafe, workspaceRoot } from "./paths";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  MAX_COMMAND_TIMEOUT_MS,
  type RunResult,
  runHostCommand,
} from "./run";

export {
  _setClock,
  _setIdentity,
  _setMonotonicClock,
  _setPathProbe,
  _setPlatform,
  _resetHostSeams,
} from "./host";
export { _setRunner, type Runner, type RunRequest, type RunResult } from "./run";
export { _setWatchFactory, type WatchFactory } from "./lib/watch-session";
export { _setRenamer, type Renamer } from "./lib/trash-engine";
export { ToolPermissionError } from "./paths";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

const DEFAULT_WATCH_SETTLE_MS = 200;
const DEFAULT_WATCH_MAX_EVENTS = 100;
/** Retained raw notifications. A `bun install` in a watched tree produces thousands. */
const MAX_RAW_EVENTS = 20_000;
/** Entries walked before the watch starts, to tell `created` from `modified`. */
const SNAPSHOT_MAX_ENTRIES = 50_000;
const MAX_WATCH_MS = 600_000;

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
/** Two days: `plocate`'s database is rebuilt by a daily timer. */
const DEFAULT_STALE_AFTER_SECONDS = 172_800;
/**
 * How many hits to ask a backend for, per hit the caller wants.
 *
 * `plocate` cannot scope a search to a directory at all, so its answer is
 * filtered here afterwards. Asking for exactly the caller's limit would let
 * out-of-scope hits consume the whole allowance and return "nothing found"
 * while matches sat just past the cap.
 */
const OVERFETCH_FACTOR = 20;
const MAX_OVERFETCH = 10_000;

/**
 * What a caller has to be told when the backend's output was cut at the cap.
 *
 * Not a nicety: the listing is NUL-SEPARATED, so a cut stream ends in half a
 * path. That fragment is dropped (see `dropTruncatedTail`), but everything
 * BEYOND the cut is invisible too, and a list that looks complete is the
 * answer a caller acts on.
 */
const TRUNCATED_LISTING_CAVEAT =
  "the backend's output was cut at this package's capture ceiling, so this listing is incomplete and the entry it was cut in the middle of was dropped rather than reported as a path — narrow the query or the roots";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

type Resolved = { readonly abs: string; readonly real: string; readonly rel: string };

/** Contain a caller path, turning the refusal into a string rather than a throw. */
function contain(
  toolName: string,
  given: string,
): { ok: true; path: Resolved } | { ok: false; message: string } {
  try {
    const safe = resolveSafe(toolName, given);
    return { ok: true, path: { abs: safe.abs, real: safe.real, rel: safe.rel } };
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return {
        ok: false,
        message: `refused path "${given}": it resolves outside the workspace root`,
      };
    }
    return { ok: false, message: `refused path "${given}": ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// WatchPath
// ---------------------------------------------------------------------------

const watchKindSchema = z.enum(["created", "modified", "deleted"]);

export const watchPath: RegisteredTool = buildTool({
  name: "WatchPath",
  description:
    "Watch a file or directory for changes for a bounded time and report what happened. Use it instead of sleeping and re-reading: it ends at whichever comes first of a required deadline and an event cap, and always says which one, so an empty answer cannot be mistaken for a satisfied wait. Events for the same path within a settle window fold into ONE event that reports how many raw notifications it absorbed — an editor writes a file two or three times to save it once, and most editors save by writing a temp file and renaming it over the target, so a caller counting raw notifications counts several saves where there was one. The kind (created, modified, deleted) is derived from the filesystem rather than from the platform's own event name, because macOS calls an ordinary append a 'rename'. On Linux a file created inside a directory that was itself created during the watch may be missed, and the result says so rather than implying the tree was covered.",
  inputSchema: z.object({
    path: z.string().min(1).describe("the file or directory to watch, inside the workspace"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_WATCH_MS)
      .describe("required deadline in milliseconds — the watch never lasts longer than this"),
    maxEvents: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        `stop after this many COALESCED events (default ${DEFAULT_WATCH_MAX_EVENTS}); 1 means "return as soon as something settles"`,
      ),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe(
        `quiet period after which a path's pending notifications fold into one event (default ${DEFAULT_WATCH_SETTLE_MS}); 0 disables folding`,
      ),
    recursive: z
      .boolean()
      .optional()
      .describe("watch subdirectories too (directories only; default false)"),
    kinds: z
      .array(watchKindSchema)
      .min(1)
      .max(3)
      .optional()
      .describe("only these kinds count towards the cap and appear in the result"),
    match: z
      .string()
      .max(200)
      .optional()
      .describe(
        "glob over the path relative to the watched directory, e.g. '**/*.ts'; only matching events count",
      ),
    includeTransient: z
      .boolean()
      .optional()
      .describe(
        "report paths that appeared and vanished inside one window — an editor's temp files (default false)",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx?: ToolExecuteContext) => {
    const contained = contain("WatchPath", input.path);
    if (!contained.ok) return `[WatchPath error] ${contained.message}`;
    const target = contained.path;

    const facts = probePath(target.real);
    if (facts === undefined) {
      return `[WatchPath error] no such path: ${target.rel === "" ? input.path : target.rel}`;
    }
    const recursive = input.recursive === true && facts.isDirectory;
    if (input.recursive === true && !facts.isDirectory) {
      return "[WatchPath error] recursive was requested for a path that is not a directory";
    }

    const settleMs = input.settleMs ?? DEFAULT_WATCH_SETTLE_MS;
    const maxEvents = input.maxEvents ?? DEFAULT_WATCH_MAX_EVENTS;
    const snapshot = snapshotTree(target.real, recursive, SNAPSHOT_MAX_ENTRIES);
    const matcher = input.match === undefined ? undefined : compileGlob(input.match);

    const outcome = await runWatchSession({
      rootAbs: target.real,
      isDirectory: facts.isDirectory,
      recursive,
      timeoutMs: input.timeoutMs,
      settleMs,
      maxEvents,
      maxRawEvents: MAX_RAW_EVENTS,
      known: snapshot.entries,
      ...(input.kinds !== undefined
        ? { kinds: new Set<EventKind>(input.kinds as EventKind[]) }
        : {}),
      ...(matcher !== undefined ? { matches: matcher } : {}),
      dropTransient: input.includeTransient !== true,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });

    const { result } = outcome;
    const notes: string[] = [];
    if (recursive && hostPlatform() === "linux") {
      notes.push(
        "on Linux a recursive watch can miss a file created inside a directory that was itself created during the watch",
      );
    }
    if (snapshot.truncated) {
      notes.push(
        `the pre-watch listing stopped at ${SNAPSHOT_MAX_ENTRIES} entries, so a change to a file beyond that point is reported as 'created' rather than 'modified'`,
      );
    }
    if (outcome.staleNotifications > 0) {
      notes.push(
        `${outcome.staleNotifications} notification(s) named a path that was unchanged (same modification time, inode-change time and size) and were not counted — macOS can deliver a write made just before the watch started`,
      );
    }
    if (outcome.reconciledEvents > 0) {
      notes.push(
        `${outcome.reconciledEvents} event(s) were found by re-reading the directory rather than reported by the OS: on this runtime an editor's atomic save can deliver events for the temp file and none for the file it replaces (they are tagged "reconciled")`,
      );
    }
    if (outcome.reconcileSkipped > 0) {
      notes.push(
        `${outcome.reconcileSkipped} directory re-read(s) were skipped (the directory held more than ${RECONCILE_MAX_ENTRIES} entries, or could not be read), so on a runtime that does not report the rename of an atomic save, a save in that directory may be missing from this answer`,
      );
    }
    if (result.rawDropped > 0) {
      notes.push(
        `${result.rawDropped} raw notifications were not retained: the tree was busier than the ${MAX_RAW_EVENTS}-notification ceiling`,
      );
    }
    if (outcome.watchError !== undefined) notes.push(outcome.watchError);

    return json({
      path: target.rel === "" ? "." : target.rel,
      recursive,
      // The bound that ended it, always. "deadline" with no events is a
      // different fact from "eventCap" with the events you asked for.
      stoppedBy: result.stoppedBy satisfies StopReason,
      durationMs: Math.round(outcome.endedAtMs - outcome.startedAtMs),
      settleMs,
      maxEvents,
      eventCount: result.events.length,
      events: result.events.map((event) => renderEvent(event, outcome.startedAtMs)),
      rawCount: result.rawCount,
      ...(result.filteredOut > 0 ? { filteredOut: result.filteredOut } : {}),
      ...(result.transientDropped > 0 ? { transientDropped: result.transientDropped } : {}),
      ...(result.droppedByCap > 0 ? { droppedByCap: result.droppedByCap } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
  },
});

/** One folded event, with times relative to the start so the shape is readable. */
function renderEvent(event: CoalescedEvent, startedAtMs: number): Record<string, unknown> {
  return {
    path: event.path === "" ? "." : event.path,
    kind: event.kind,
    rawCount: event.rawCount,
    atMs: Math.round(Math.max(0, event.firstAtMs - startedAtMs)),
    spanMs: Math.round(Math.max(0, event.lastAtMs - event.firstAtMs)),
    // The platform's own words, kept so a surprising classification can be
    // argued with rather than just disbelieved.
    eventTypes: event.eventTypes,
    ...(event.transient === true ? { transient: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// TrashPath
// ---------------------------------------------------------------------------

/**
 * Why this tool refuses on macOS.
 *
 * The OS trash is not a directory you move things into — it is an operation,
 * `NSFileManager.trashItemAtURL:`, which also writes the record that makes
 * "Put Back" work. There is no command-line front end for it: the Finder
 * scripting route needs an Automation permission a harness cannot be relied
 * on to have and fails outright with no user session. A plain move into
 * `~/.Trash` LOOKS right and is not the same operation, and `rm` is the exact
 * thing this tool exists not to do. So it refuses and says what it would take.
 */
const MACOS_REFUSAL =
  "TrashPath does not support macOS. The Finder trash is an operation (NSFileManager trashItemAtURL:), not a directory: it writes the 'Put Back' record that makes a file restorable, and nothing on the command line performs it — Finder scripting needs an Automation permission and a logged-in session, and this package will not add a native binding. Moving the file into ~/.Trash by hand would look like trashing while silently losing the restore record, and unlinking it is the opposite of what this tool is for. To delete a file on macOS, use RemovePath, which says that it deletes.";

const WINDOWS_REFUSAL =
  "TrashPath does not support Windows. The Recycle Bin is reached through the shell API (IFileOperation, or SHFileOperation with FOF_ALLOWUNDO), which needs either a native binding or a PowerShell host — and no Windows machine was available to record real output from, so any implementation here would be unverified. An unverified deletion path is exactly the failure this tool exists to prevent.";

const OTHER_PLATFORM_REFUSAL =
  "TrashPath supports only Linux, where the FreeDesktop trash specification defines the operation exactly. This platform has no specification this package can implement correctly.";

function platformRefusal(platform: HostPlatform): string | undefined {
  if (platform === "linux") return undefined;
  if (platform === "darwin") return MACOS_REFUSAL;
  if (platform === "win32") return WINDOWS_REFUSAL;
  return OTHER_PLATFORM_REFUSAL;
}

export const trashPath: RegisteredTool = buildTool({
  name: "TrashPath",
  operativeArgs: [{ field: "paths", kind: "path" }],
  description:
    "Move paths into the operating system's trash, where they can be restored, instead of unlinking them. Use it wherever a harness would otherwise delete something it might want back. LINUX ONLY: it implements the FreeDesktop trash specification — a .trashinfo record naming the original location and the deletion time, the name claimed atomically, and the file MOVED, never copied. It refuses on macOS and Windows rather than approximating, because the only honest implementations there need an OS API this package cannot reach, and a 'trash' that quietly unlinks is worse than no trash at all. A path on a different filesystem from its trash is refused with that reason unless the volume's own top-level trash can be used, because a rename cannot cross a filesystem and a copy is not a trash. Ambiguous input — the same path twice, or a path nested inside another path in the same call — is refused rather than guessed at. Pass dryRun to see exactly what would move, planned by the same code that performs the move.",
  inputSchema: z.object({
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("paths to move to the trash, inside the workspace"),
    dryRun: z
      .boolean()
      .optional()
      .describe("report what would move, and move nothing (default false)"),
  }),
  destructive: true,
  execute: async (input) => {
    const platform = hostPlatform();
    const refusal = platformRefusal(platform);
    if (refusal !== undefined) {
      return json({ supported: false, platform, trashed: 0, reason: refusal });
    }

    const resolvedInputs: Array<{ given: string; abs: string; rel: string }> = [];
    for (const given of input.paths) {
      const contained = contain("TrashPath", given);
      if (!contained.ok) {
        return json({
          supported: true,
          platform,
          dryRun: input.dryRun === true,
          trashed: 0,
          refused: input.paths.length,
          reason: contained.message,
          entries: [],
        });
      }
      // The LEXICAL path, not the real one: a symlink is trashed as the link
      // itself, the way `rm` removes a link rather than its target. `real`
      // was still computed, and is what proved containment.
      resolvedInputs.push({ given, abs: contained.path.abs, rel: contained.path.rel });
    }

    const plan = planTrash(resolvedInputs, { workspaceRoot: workspaceRoot() });
    const applied: AppliedEntry[] =
      input.dryRun === true
        ? plan.entries.map((entry) => ({ ...entry, trashed: false }))
        : plan.entries.map((entry) => applyEntry(entry));

    const entries = applied.map((entry) => {
      // The destination fields are named for what actually happened. A
      // refused entry carries a PLANNED destination that nothing was written
      // to, and reporting that as `trashedTo` would tell a caller a file is
      // somewhere it is not.
      const moved = entry.trashed;
      const planned = entry.status === "ready" && !moved;
      return {
        path: entry.rel === "" ? "." : entry.rel,
        status: entry.status === "refused" ? "refused" : moved ? "trashed" : "would-trash",
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
        ...(entry.sizeBytes !== undefined && entry.kind === "file"
          ? { sizeBytes: entry.sizeBytes }
          : {}),
        ...(entry.trashDir !== undefined ? { trashDir: entry.trashDir } : {}),
        ...(entry.topdir !== undefined ? { topdir: entry.topdir } : {}),
        ...(moved
          ? {
              storedAs: entry.storedAs,
              trashedTo: entry.filesPath,
              record: entry.infoPath,
            }
          : {}),
        ...(planned
          ? {
              wouldStoreAs: entry.storedName,
              wouldTrashTo: entry.filesPath,
              wouldRecord: entry.infoPath,
            }
          : {}),
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      };
    });

    const trashed = applied.filter((entry) => entry.trashed).length;
    const refused = applied.filter((entry) => entry.status === "refused").length;
    return json({
      supported: true,
      platform,
      dryRun: input.dryRun === true,
      trashed,
      ...(input.dryRun === true
        ? { wouldTrash: applied.filter((entry) => entry.status === "ready").length }
        : {}),
      refused,
      entries,
      ...(trashed > 0
        ? {
            restoreHint:
              "each entry's record names where it came from; move the file at trashedTo back there with MovePath and delete the record",
          }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// OsIndexSearch
// ---------------------------------------------------------------------------

type IndexReport = {
  state: "enabled" | "disabled" | "unknown" | "missing";
  detail: string;
  volume?: string;
  path?: string;
  ageSeconds?: number;
  stale?: boolean;
};

export const osIndexSearch: RegisteredTool = buildTool({
  name: "OsIndexSearch",
  operativeArgs: [{ field: "roots", kind: "path", default: "." }],
  description:
    "Search the file index the operating system already maintains — Spotlight on macOS, plocate/locate on Linux — for paths inside the workspace. Use it to find a file by name, or (macOS only) by content, across a large tree without walking it. NAMED OsIndexSearch to keep it distinct from IndexSearch, which is BM25 retrieval over an index a harness builds for itself; this one queries the machine's index and builds nothing. A stale, disabled or missing index is reported as its own outcome, never as 'no matches': an empty answer from an index that was never built is a false negative a caller acts on. An empty answer the tool could not CHECK — the index's state could not be determined, or the backend's output was cut off — is 'noMatchesUnverified', which is not evidence that the file is absent. Results are filtered to the search roots AFTER the backend answers, because the backends' own scoping differs and plocate has none, and the limit is applied after that filtering so out-of-scope hits cannot eat the allowance. Content search is refused on Linux, where the locate database indexes names only. The query is matched as a substring; * and ? are wildcards on both backends.",
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe("text to look for in the file name, or in content"),
    mode: z
      .enum(["name", "content"])
      .optional()
      .describe("search file names (default) or file contents (macOS only)"),
    roots: z
      .array(z.string().min(1))
      // `.min(1)`: an EMPTY array is not "search everywhere", it is a search
      // whose every result is then filtered out — a whole-machine `mdfind`
      // that can only ever answer "nothing found".
      .min(1)
      .max(16)
      .optional()
      .describe("directories to search, inside the workspace (default: the workspace root)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .optional()
      .describe(`most results to return (default ${DEFAULT_SEARCH_LIMIT})`),
    exclude: z
      // `.max(200)` per pattern, matching WatchPath's `match`: the compiled
      // matcher runs once per hit, and an unbounded pattern is an unbounded
      // amount of work per result.
      .array(z.string().min(1).max(200))
      .max(32)
      .optional()
      .describe("globs over the absolute path; matching results are dropped"),
    matchCase: z.boolean().optional().describe("match case exactly (default false)"),
    checkIndex: z
      .boolean()
      .optional()
      .describe(
        "always report the index's state, not only when there were no matches (costs one extra command)",
      ),
    staleAfterSeconds: z
      .number()
      .int()
      .min(60)
      .max(31_536_000)
      .optional()
      .describe(`call the index stale past this age (default ${DEFAULT_STALE_AFTER_SECONDS})`),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(MAX_COMMAND_TIMEOUT_MS)
      .optional()
      .describe(`milliseconds before the backend is killed (default ${DEFAULT_SEARCH_TIMEOUT_MS})`),
  }),
  readOnly: true,
  concurrencySafe: true,
  // It spawns a program, so it declares the process capability and the
  // external scope the audit requires of anything that crosses that boundary.
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx?: ToolExecuteContext) => {
    const unsafe = rejectUnsafeQuery(input.query);
    if (unsafe !== undefined) return `[OsIndexSearch error] ${unsafe}`;

    const platform = hostPlatform();
    const mode = input.mode ?? "name";
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const timeoutMs = input.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

    const rootGiven = input.roots ?? ["."];
    const roots: string[] = [];
    for (const given of rootGiven) {
      const contained = contain("OsIndexSearch", given);
      if (!contained.ok) return `[OsIndexSearch error] ${contained.message}`;
      const facts = probePath(contained.path.real);
      if (facts === undefined || !facts.isDirectory) {
        // Recorded behaviour: `mdfind -onlyin /no/such/dir` exits 0 and prints
        // nothing, which would read as "no matches" for a root that is simply
        // not there. Refusing here is what stops that becoming an answer.
        return `[OsIndexSearch error] search root "${given}" is not a directory that exists`;
      }
      roots.push(contained.path.real);
    }

    const excludes = (input.exclude ?? []).map((pattern) => compileGlob(pattern));

    if (platform === "darwin") {
      return await searchSpotlight({
        query: input.query,
        mode,
        roots,
        limit,
        excludes,
        matchCase: input.matchCase === true,
        checkIndex: input.checkIndex === true,
        timeoutMs,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
    }
    if (platform === "linux") {
      return await searchLocate({
        query: input.query,
        mode,
        roots,
        limit,
        excludes,
        matchCase: input.matchCase === true,
        staleAfterSeconds: input.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
        timeoutMs,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
    }
    return json({
      backend: "none",
      platform,
      outcome: "unsupported",
      matches: [],
      matchCount: 0,
      reason:
        platform === "win32"
          ? "Windows Search is queried through an ADO/OLE DB connection driven by PowerShell, and no Windows machine was available to record real output from — an unverified parser would report confident wrong answers rather than none"
          : "this platform has no file index this package knows how to query",
    });
  },
});

type SpotlightOptions = {
  readonly query: string;
  readonly mode: "name" | "content";
  readonly roots: readonly string[];
  readonly limit: number;
  readonly excludes: readonly ((path: string) => boolean)[];
  readonly matchCase: boolean;
  readonly checkIndex: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

async function searchSpotlight(options: SpotlightOptions): Promise<string> {
  const predicate = buildPredicate({
    query: options.query,
    mode: options.mode,
    matchCase: options.matchCase,
  });
  const argv = mdfindArgv({ predicate, roots: options.roots });
  const run = await runHostCommand({
    argv,
    timeoutMs: options.timeoutMs,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const failure = classifyMdfindResult(run);
  if (failure !== undefined) {
    return json({
      backend: "mdfind",
      platform: "darwin",
      outcome: failure.kind === "backendMissing" ? "indexUnavailable" : "failed",
      matches: [],
      matchCount: 0,
      reason: failure.detail,
    });
  }

  // A listing cut at the output cap ends in a fragment of a path, which would
  // otherwise be reported as a file that exists.
  const cut = dropTruncatedTail(parseNulList(run.stdout), run.stdoutTruncated === true);
  const scoped = scopeResults(cut.paths, options.roots, options.excludes);
  const limited = applyLimit(scoped.kept, options.limit);
  const empty = limited.items.length === 0;

  let index: IndexReport | undefined;
  if (empty || options.checkIndex) {
    index = await probeSpotlightIndex(
      options.roots[0] as string,
      options.timeoutMs,
      options.signal,
    );
  }

  // An empty answer is only a fact about the filesystem when the index that
  // produced it can be believed. `mdfind` prints nothing and exits 0 for a
  // miss, for an unindexed volume and for a directory Spotlight was told to
  // skip, so the state of the index IS the answer here — and when `mdutil`
  // could not tell us (it is absent, it timed out, or it reported "unknown
  // indexing state"), "no matches" is a conclusion nobody is entitled to.
  // `noMatchesUnverified` says the search came back empty and the index could
  // not be confirmed, which is a different instruction to a caller than
  // "this file is not on the machine".
  const unverified = run.stdoutTruncated === true || index?.state === "unknown";
  const outcome = empty
    ? index?.state === "disabled"
      ? "indexUnavailable"
      : unverified
        ? "noMatchesUnverified"
        : "noMatches"
    : "matches";

  // Collected rather than assigned one at a time: a later `caveat:` key in an
  // object literal silently replaces an earlier one, which is how a caller
  // stops hearing about the first thing that was wrong.
  const caveats: string[] = [];
  if (run.stdoutTruncated === true) caveats.push(TRUNCATED_LISTING_CAVEAT);
  if (empty && index?.state === "unknown") {
    caveats.push(
      "nothing matched, and mdutil could not say whether the volume is indexed, so this is not evidence the file is absent — use FindFiles, which walks the tree instead of asking an index",
    );
  }
  if (empty && index?.state === "enabled") {
    // Measured on the capture host: a volume can report "Indexing enabled"
    // while a particular directory returns nothing, because Spotlight skips
    // hidden paths, anything under a .metadata_never_index marker, and
    // whatever is on the privacy list.
    caveats.push(
      "the volume is indexed, but an individual directory can still be excluded from Spotlight (a hidden path, a .metadata_never_index marker, or the privacy list), so this is 'nothing in the index' rather than 'nothing on disk'",
    );
  }

  return json({
    backend: "mdfind",
    platform: "darwin",
    outcome,
    query: options.query,
    mode: options.mode,
    matches: limited.items,
    matchCount: limited.items.length,
    limit: options.limit,
    ...(limited.truncated ? { truncated: true, moreAvailable: scoped.kept.length } : {}),
    ...(scoped.outOfScope > 0 ? { outOfScope: scoped.outOfScope } : {}),
    ...(scoped.excluded > 0 ? { excluded: scoped.excluded } : {}),
    ...(run.stdoutTruncated === true
      ? { backendOutputTruncated: true, partialDropped: cut.partialDropped }
      : {}),
    roots: options.roots,
    ...(index !== undefined ? { index } : {}),
    ...(caveats.length > 0 ? { caveat: caveats.join(" | ") } : {}),
  });
}

/** `mdutil -s` on the volume the first root lives on. */
async function probeSpotlightIndex(
  root: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IndexReport> {
  const facts = probePath(root);
  const volume = facts === undefined ? "/" : (findTopdir(root, facts.device) ?? "/");
  let run: RunResult;
  try {
    run = await runHostCommand({
      argv: mdutilArgv(volume),
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    return { state: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
  if (run.missing) {
    return { state: "unknown", detail: "mdutil is not installed, so the index state is unknown" };
  }
  const status = parseMdutilStatus(run.stdout, volume);
  return { state: status.state, detail: status.detail, volume: status.volume };
}

type LocateOptions = {
  readonly query: string;
  readonly mode: "name" | "content";
  readonly roots: readonly string[];
  readonly limit: number;
  readonly excludes: readonly ((path: string) => boolean)[];
  readonly matchCase: boolean;
  readonly staleAfterSeconds: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

async function searchLocate(options: LocateOptions): Promise<string> {
  if (options.mode === "content") {
    return json({
      backend: "plocate",
      platform: "linux",
      outcome: "unsupported",
      matches: [],
      matchCount: 0,
      reason:
        "the locate database indexes file NAMES only, so a content search here would have to fall back to walking the tree — which is a different tool (Grep or FindFiles), not this one pretending to have an index it does not have",
    });
  }

  const fetchLimit = Math.min(options.limit * OVERFETCH_FACTOR, MAX_OVERFETCH);
  const backends: LocateBackend[] = ["plocate", "locate"];
  let run: RunResult | undefined;
  let backend: LocateBackend | undefined;
  for (const candidate of backends) {
    const attempt = await runHostCommand({
      argv: locateArgv({
        backend: candidate,
        pattern: options.query,
        limit: fetchLimit,
        matchCase: options.matchCase,
        basenameOnly: false,
      }),
      timeoutMs: options.timeoutMs,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (attempt.missing) continue;
    run = attempt;
    backend = candidate;
    break;
  }

  if (run === undefined || backend === undefined) {
    return json({
      backend: "none",
      platform: "linux",
      outcome: "indexUnavailable",
      matches: [],
      matchCount: 0,
      reason:
        "no locate backend is installed (looked for plocate, then locate) — install plocate and run updatedb, or use FindFiles, which walks the tree instead of asking an index",
    });
  }

  const classified = classifyLocateResult(run);
  const index = describeLocateIndex(backend, options.staleAfterSeconds);

  if (classified.kind !== "matches" && classified.kind !== "noMatches") {
    return json({
      backend,
      platform: "linux",
      // Anything that is not a clean answer is reported as an unavailable
      // index rather than as an empty result: exit 1 means BOTH "no matches"
      // and "no database" on this backend, and only one of them is an answer.
      outcome: classified.kind === "timedOut" ? "failed" : "indexUnavailable",
      matches: [],
      matchCount: 0,
      reason: classified.detail,
      index,
    });
  }

  const rawFound = classified.kind === "matches" ? classified.paths : [];
  // Same cut-stream trap as `mdfind`, and this backend never reported it at
  // all: `plocate -0` is NUL-separated, so a listing that hit the capture
  // ceiling ends in a fragment that reads as a complete short path.
  const cut = dropTruncatedTail(rawFound, run.stdoutTruncated === true);
  const found = cut.paths;
  const scoped = scopeResults(found, options.roots, options.excludes);
  const limited = applyLimit(scoped.kept, options.limit);
  const hitFetchCap = rawFound.length >= fetchLimit;
  const truncatedOutput = run.stdoutTruncated === true;

  // Collected rather than assigned one at a time: three of these can be true
  // at once, and a later `caveat:` key silently replacing an earlier one is
  // how a caller stops hearing about the first thing that was wrong.
  const caveats: string[] = [];
  if (truncatedOutput) caveats.push(TRUNCATED_LISTING_CAVEAT);
  if (hitFetchCap) {
    caveats.push(
      `the backend returned its full ${fetchLimit} hits before filtering, so matches inside the roots may exist beyond them — narrow the query`,
    );
  }
  if (limited.items.length === 0 && index.stale === true) {
    caveats.push(
      `nothing matched, but the index was last built ${index.ageSeconds} seconds ago — a file created since then is not in it`,
    );
  }

  return json({
    backend,
    platform: "linux",
    outcome:
      limited.items.length > 0 ? "matches" : truncatedOutput ? "noMatchesUnverified" : "noMatches",
    query: options.query,
    mode: options.mode,
    matches: limited.items,
    matchCount: limited.items.length,
    limit: options.limit,
    ...(limited.truncated ? { truncated: true, moreAvailable: scoped.kept.length } : {}),
    ...(scoped.outOfScope > 0 ? { outOfScope: scoped.outOfScope } : {}),
    ...(scoped.excluded > 0 ? { excluded: scoped.excluded } : {}),
    ...(truncatedOutput
      ? { backendOutputTruncated: true, partialDropped: cut.partialDropped }
      : {}),
    roots: options.roots,
    index,
    ...(caveats.length > 0 ? { caveat: caveats.join(" | ") } : {}),
  });
}

/** The database's age, read from its mtime: `--statistics` does not exist in every build. */
function describeLocateIndex(backend: LocateBackend, staleAfterSeconds: number): IndexReport {
  const dbPath = LOCATE_DB_PATHS[backend];
  const facts = probePath(dbPath);
  if (facts === undefined) {
    return {
      state: "missing",
      detail: `${dbPath} does not exist or cannot be read — run updatedb`,
      path: dbPath,
    };
  }
  const age = describeIndexAge(facts.mtimeMs, now(), staleAfterSeconds);
  return {
    // A stale database is still a database: the state says it is there, and
    // `stale` says how much to trust it. Reporting staleness as "unknown"
    // would throw away the one fact the caller can act on.
    state: "enabled",
    detail:
      age.stale === true
        ? `${dbPath} was last rebuilt ${age.ageSeconds} seconds ago`
        : `${dbPath} is current`,
    path: dbPath,
    ...(age.ageSeconds !== undefined ? { ageSeconds: age.ageSeconds } : {}),
    ...(age.stale !== undefined ? { stale: age.stale } : {}),
  };
}

/** Every tool this package registers, in the order a catalog should list them. */
export const HOSTFS_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  watchPath,
  trashPath,
  osIndexSearch,
]);
