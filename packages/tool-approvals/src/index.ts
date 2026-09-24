/**
 * @crewhaus/tool-approvals — what is parked waiting for a human, what humans
 * have been asked before, and the permission rules that would stop the asking.
 *
 * A headless run under `permissions.ask_mode: pause` cannot prompt. When a tool
 * call needs permission it writes a `PendingApproval` to the harness's
 * `approvals.jsonl` and STOPS. Nobody is told. The run is not failed, not
 * finished and not progressing, and the only way anyone finds out is if
 * somebody looks. These three tools are that looking, without a model turn:
 *
 *   ApprovalStatus     one harness — what is parked, what was decided, by whom
 *   ApprovalsInbox     the fleet — every harness under a root, in one page
 *   PermissionsSuggest the history — the rules that would stop the re-asking
 *
 * ---------------------------------------------------------------------------
 * FOUR PROPERTIES HOLD ACROSS THE PACKAGE
 * ---------------------------------------------------------------------------
 *  1. NOTHING HERE DECIDES ANYTHING. No tool grants, denies, resolves, expires
 *     or applies. `PermissionsSuggest` PROPOSES rules and writes nothing;
 *     applying them is `crewhaus permissions suggest --apply`, which is always
 *     an interactive human confirm, because permissions are excluded from the
 *     optimizer's writable paths by design — an agent must never widen its own
 *     permissions. Every description says so, in those words.
 *  2. A SUGGESTED RULE MEANS ONLY WHAT IT SAYS. A rule built from an observed
 *     value is a privilege-escalation vector if the value is spliced in raw: a
 *     path containing `*` turns "approve this one file" into "approve
 *     everything". `@crewhaus/tool-permission-matcher` owns the escaping and
 *     the operative-field table; `lib/rule-check.ts` then VERIFIES each finished
 *     rule by running the real matcher against the approved call and a set of
 *     near-misses, and refuses any rule that reaches past it.
 *  3. "COULD NOT DETERMINE" IS NOT "NOTHING IS PARKED". An approvals file that
 *     is absent means no run ever parked here; one that cannot be opened means
 *     nobody knows what is parked here, and a run may be blocked right now.
 *     Every count these tools cannot establish is `null` with a named reason in
 *     `unknown[]`, never a zero.
 *  4. DETERMINISM. Listings sort with plain string comparison (never
 *     `localeCompare`), every ordering is pinned and documented, and the one
 *     place a clock can enter — how long something has been parked — is an
 *     explicit `now` input rather than a read of the host's clock.
 *
 * Containment: every caller-supplied path goes through `resolveSafe` (copied
 * verbatim from `@crewhaus/tool-pkg`), which refuses anything resolving outside
 * `process.cwd()`, including via a symlink inside the workspace. The fleet walk
 * never follows a directory symlink, for the same reason.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_SUGGEST_THRESHOLDS,
  type PermissionSuggestion,
  type SettingsPermissionRule,
  type SuggestToolLookup,
  aggregateAsks,
  diffPermissions,
  isArgScoped,
  rankSuggestions,
} from "@crewhaus/harness-advice";
import { buildTool } from "@crewhaus/tool-builder";
import type { OperativeArg, RegisteredTool } from "@crewhaus/tool-catalog";
import { TOOL_FLAGS_BY_NAME } from "@crewhaus/tool-registry-manifest/flags";
import { z } from "zod";
import {
  APPROVALS_FILENAME,
  APPROVAL_STATUSES,
  type ApprovalOrder,
  type ApprovalRecord,
  type ApprovalRow,
  type ApprovalStatusName,
  SESSIONS_SUBDIR,
  countByStatus,
  filterApprovals,
  foldApprovals,
  isApprovalId,
  orderApprovals,
  parseInstant,
  toRow,
} from "./lib/approvals";
import { discoverHarnesses } from "./lib/harnesses";
import { verifyRule } from "./lib/rule-check";
import { sessionRootRelocation } from "./lib/session-root";
import { DEFAULT_SESSION_LIMIT, readRecentSessions } from "./lib/sessions";
import { readSettings } from "./lib/settings";
import { Unknowns, compareStrings } from "./lib/unknown";
import { type SafePath, ToolPermissionError, resolveSafe, toPosix } from "./paths";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** Default rows returned by a listing. */
const DEFAULT_LIMIT = 50;
/** Hard ceiling on rows in one call, whatever the caller asks for. */
const MAX_LIMIT = 1000;
/** Default depth of the fleet walk, mirroring `crewhaus fleet`. */
const DEFAULT_MAX_DEPTH = 6;
/** Default cap on harnesses visited in one fleet walk. */
const DEFAULT_MAX_HARNESSES = 200;

// ---------------------------------------------------------------------------
// shared input plumbing
// ---------------------------------------------------------------------------

type Refusal = { readonly ok: false; readonly message: string };
type Ok<T> = { readonly ok: true; readonly value: T };
type Loaded<T> = Ok<T> | Refusal;

/**
 * Resolve a caller-supplied directory inside the workspace.
 *
 * The NUL check happens FIRST, on the string the caller wrote, because a path
 * carrying one reaches `path.resolve` intact and only fails later inside a
 * syscall — where the error is an opaque `ERR_INVALID_ARG_VALUE` that looks
 * like a bug in this tool rather than like bad input.
 */
function resolveDirArg(toolName: string, rel: string | undefined): Loaded<SafePath> {
  const given = rel ?? ".";
  if (given.includes("\u0000")) {
    return { ok: false, message: `${toolName}: the path contains a NUL byte and is not a path` };
  }
  try {
    return { ok: true, value: resolveSafe(toolName, given) };
  } catch (err) {
    if (err instanceof ToolPermissionError) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * Join a WORKSPACE-relative directory with a fixed sub-path, re-checking
 * containment. The harness directory having been contained is not enough:
 * `.crewhaus/sessions` inside it can itself be a symlink out of the workspace,
 * and that link is the door.
 *
 * `dirWsRel` must be relative to the workspace root, never to whatever root a
 * caller named — `resolveSafe` resolves against `process.cwd()`.
 */
function containedChild(toolName: string, dirWsRel: string, child: string): Loaded<SafePath> {
  try {
    return { ok: true, value: resolveSafe(toolName, toPosix(path.join(dirWsRel, child))) };
  } catch (err) {
    if (err instanceof ToolPermissionError) return { ok: false, message: err.message };
    throw err;
  }
}

/** A caller-supplied instant, or a refusal naming what was wrong with it. */
function parseInstantArg(label: string, text: string | undefined): Loaded<number | undefined> {
  if (text === undefined) return { ok: true, value: undefined };
  const ms = parseInstant(text);
  if (ms === null) {
    return {
      ok: false,
      message: `"${label}" must be an ISO-8601 instant (e.g. 2026-09-19T14:00:00Z); got ${JSON.stringify(text)}`,
    };
  }
  return { ok: true, value: ms };
}

const statusEnum = z.enum(["pending", "granted", "granted-always", "denied", "consumed"]);

const listingFields = {
  status: z
    .array(statusEnum)
    .optional()
    .describe("keep only these statuses; omitted, every status is returned"),
  tool: z
    .string()
    .optional()
    .describe("keep only parks for this EXACT tool name (not a glob, not a prefix)"),
  since: z
    .string()
    .optional()
    .describe("keep only parks created at or after this ISO-8601 instant"),
  until: z
    .string()
    .optional()
    .describe("keep only parks created at or before this ISO-8601 instant"),
  order: z
    .enum(["operator", "oldest", "newest"])
    .optional()
    .describe(
      "operator (default): pending first, oldest pending first, then settled by most recently decided; oldest/newest: plain creation order",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`rows to return AFTER filtering (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
  now: z
    .string()
    .optional()
    .describe(
      "an ISO-8601 instant to measure parked time against; omitted, rows carry no age, because this tool never reads the host clock",
    ),
};

type ListingArgs = {
  readonly status?: ReadonlyArray<ApprovalStatusName>;
  readonly tool?: string;
  readonly since?: string;
  readonly until?: string;
  readonly order?: ApprovalOrder;
  readonly limit?: number;
  readonly now?: string;
};

type ResolvedListing = {
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly nowMs?: number;
  readonly order: ApprovalOrder;
  readonly limit: number;
};

function resolveListing(args: ListingArgs): Loaded<ResolvedListing> {
  const since = parseInstantArg("since", args.since);
  if (!since.ok) return since;
  const until = parseInstantArg("until", args.until);
  if (!until.ok) return until;
  const now = parseInstantArg("now", args.now);
  if (!now.ok) return now;
  if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
    return { ok: false, message: `"since" is after "until" — that window selects nothing` };
  }
  // An EMPTY status list selects nothing, which is a correct answer to a
  // question nobody meant to ask. Refusing beats handing back an empty inbox
  // that reads exactly like "nothing is parked".
  if (args.status !== undefined && args.status.length === 0) {
    return {
      ok: false,
      message:
        '"status" is an empty list, which matches nothing — name at least one status, or omit the field to see them all',
    };
  }
  return {
    ok: true,
    value: {
      ...(since.value !== undefined ? { sinceMs: since.value } : {}),
      ...(until.value !== undefined ? { untilMs: until.value } : {}),
      ...(now.value !== undefined ? { nowMs: now.value } : {}),
      order: args.order ?? "operator",
      // Clamped as well as schema-bounded: `execute` is reachable directly
      // (every test in this package calls it that way), and a limit of 0 would
      // produce an empty page indistinguishable from an empty ledger.
      limit: Math.min(MAX_LIMIT, Math.max(1, args.limit ?? DEFAULT_LIMIT)),
    },
  };
}

/** One harness's approvals log, folded, with the read's own health attached. */
type StoreRead = {
  readonly records: readonly ApprovalRecord[];
  readonly state: "missing" | "read" | "unreadable";
  readonly reason?: string;
  readonly truncated: boolean;
  readonly tornLines: number;
  readonly foreignLines: number;
  readonly lineCount: number;
  readonly bytes: number | null;
};

function readStore(pathReal: string): StoreRead {
  const folded = foldApprovals(pathReal);
  const state = folded.read.state;
  return {
    records: folded.records,
    state: state.kind,
    ...(state.kind === "unreadable" ? { reason: state.reason } : {}),
    truncated: folded.read.truncated,
    tornLines: folded.read.tornCount,
    foreignLines: folded.foreignLines,
    lineCount: folded.read.lineCount,
    bytes: folded.read.bytes,
  };
}

/**
 * Turn a store read's health into unknowns.
 *
 * Three separate conditions, because they mean different things to an operator:
 * unreadable (nothing is known), truncated (the oldest records were not read),
 * torn (some records inside the window did not parse).
 *
 * EACH GETS ITS OWN FIELD. `Unknowns.add` is first-writer-wins — right for one
 * fact reached by two probes, wrong for two different facts about one number —
 * so filing all three under `total` would report the first and silently drop the
 * rest. The two partial-read conditions are filed under the result fields that
 * actually carry them (`store.truncated`, `store.tornLines`), which are real
 * paths into the output and say in their reason what they cost `total`.
 */
function noteStoreHealth(unknowns: Unknowns, store: StoreRead, probe: string): void {
  if (store.state === "unreadable") {
    unknowns.add(
      "total",
      probe,
      `${store.reason ?? "the approvals log could not be read"} — whether a run is parked here is UNKNOWN, not "none"`,
    );
    unknowns.add("counts", probe, "the approvals log could not be read");
    unknowns.add("matched", probe, "the approvals log could not be read");
    unknowns.add(
      "store.bytes",
      probe,
      "the approvals log could not be read, so its size on disk was never measured",
    );
    return;
  }
  if (store.truncated) {
    unknowns.add(
      "store.truncated",
      probe,
      "the approvals log is larger than this tool's read cap; the newest records were read and older ones were not, so `total` and `counts` are a FLOOR",
    );
  }
  if (store.tornLines > 0) {
    unknowns.add(
      "store.tornLines",
      probe,
      `${store.tornLines} line(s) in the approvals log did not parse, so \`total\` and \`counts\` are a FLOOR`,
    );
  }
}

// ---------------------------------------------------------------------------
// ApprovalStatus — one harness
// ---------------------------------------------------------------------------

export const approvalStatus: RegisteredTool = buildTool({
  name: "ApprovalStatus",
  description:
    "Read one harness's tool-approval ledger: what is parked waiting for a human right now, what was decided, when and by whom. Use to answer 'is this harness blocked on me?' before assuming a quiet run is a finished one — a run under `permissions.ask_mode: pause` stops silently and waits. Pass `approvalId` for one record in full. This is a pure read: it never grants, denies, expires or compacts anything, so polling it is free of side effects. An approvals log that cannot be read is reported as UNKNOWN, never as an empty inbox.",
  inputSchema: z.object({
    dir: z
      .string()
      .optional()
      .describe("the harness root holding .crewhaus/, relative to the working directory"),
    approvalId: z
      .string()
      .optional()
      .describe("one approval id (appr_ + 16 hex) to report in full, instead of a listing"),
    ...listingFields,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const dir = resolveDirArg("ApprovalStatus", input.dir);
    if (!dir.ok) return dir.message;
    const logPath = containedChild(
      "ApprovalStatus",
      dir.value.rel,
      path.join(SESSIONS_SUBDIR, APPROVALS_FILENAME),
    );
    if (!logPath.ok) return logPath.message;
    const listing = resolveListing(input);
    if (!listing.ok) return listing.message;

    const unknowns = new Unknowns();
    const store = readStore(logPath.value.real);
    const shownPath = logPath.value.rel;
    noteStoreHealth(unknowns, store, `read ${shownPath}`);

    // AN ABSENT LEDGER IS "NOTHING WAS PARKED" ONLY IF THIS IS WHERE A LEDGER
    // WOULD BE. The session root moves with `CREWHAUS_SESSION_DIR`, and the
    // approvals log moves with it; this tool reads the ONE conventional path,
    // so when there is evidence of a relocation the honest answer about a
    // missing file is "unknown", not zero.
    const relocated = store.state === "missing" ? sessionRootRelocation(dir.value.real) : undefined;
    if (relocated !== undefined) {
      for (const field of ["total", "counts", "matched"]) {
        unknowns.add(
          field,
          `read ${shownPath}`,
          `${relocated} — nothing is parked at the path this tool read, but what is parked at the relocated root is UNKNOWN, not "none"`,
        );
      }
    }

    const known = store.state !== "unreadable" && relocated === undefined;
    const base = {
      harnessDir: dir.value.rel === "" ? "." : dir.value.rel,
      approvalsPath: shownPath,
      store: {
        state: store.state,
        ...(store.reason !== undefined ? { reason: store.reason } : {}),
        lines: store.lineCount,
        tornLines: store.tornLines,
        foreignLines: store.foreignLines,
        truncated: store.truncated,
        bytes: store.bytes,
      },
      // Never a zero for an unreadable log: the count is genuinely unknown.
      total: known ? store.records.length : null,
      counts: known ? countByStatus(store.records) : null,
    };

    if (input.approvalId !== undefined) {
      const id = input.approvalId;
      const record = store.records.find((r) => r.id === id);
      if (record === undefined && !isApprovalId(id) && known) {
        // A well-formed refusal beats a bare "not found": an id of the wrong
        // shape could never have been written by the store.
        return json({
          ...base,
          approvalId: id,
          found: false,
          approval: null,
          note: `"${id}" is not an approval id — the store writes appr_ followed by 16 hex characters`,
          unknown: unknowns.list(),
        });
      }
      if (!known) {
        unknowns.add(
          "found",
          `read ${shownPath}`,
          `${relocated ?? store.reason ?? "the approvals log could not be read"} — whether "${id}" exists is UNKNOWN`,
        );
        unknowns.add(
          "approval",
          `read ${shownPath}`,
          `${relocated ?? store.reason ?? "the approvals log could not be read"} — the record was not found because nothing could be read, not because it is absent`,
        );
      }
      // A MISS IN A PARTIAL READ IS NOT AN ABSENCE. The listing already declares
      // its counts a FLOOR when the read was capped or a line did not parse, but
      // a single-id lookup answers `true`/`false`, and a bare `false` reads as
      // "there is no such approval". The record may be in the bytes past the cap
      // or in the line that did not parse, so the answer is `null` and says
      // which. A HIT is still a hit: the record was read, whatever else was not.
      const incomplete = known && record === undefined && (store.truncated || store.tornLines > 0);
      if (incomplete) {
        const why = store.truncated
          ? `the ledger is larger than this tool's read cap, so its older records were never read`
          : `${store.tornLines} line(s) in the ledger did not parse`;
        for (const field of ["found", "approval"]) {
          unknowns.add(
            field,
            `read ${shownPath}`,
            `"${id}" is not among the records that were read, but ${why} — whether it exists is UNKNOWN, not "no"`,
          );
        }
      }
      return json({
        ...base,
        approvalId: id,
        found: known && !incomplete ? record !== undefined : null,
        approval: record === undefined ? null : toRow(record, listing.value.nowMs),
        unknown: unknowns.list(),
      });
    }

    // FILTER FIRST, THEN LIMIT. Pushing the limit into the read and filtering
    // after it returns fewer rows than exist, with nothing to say so.
    const filtered = filterApprovals(store.records, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      ...(listing.value.sinceMs !== undefined ? { sinceMs: listing.value.sinceMs } : {}),
      ...(listing.value.untilMs !== undefined ? { untilMs: listing.value.untilMs } : {}),
    });
    if (filtered.undatedIds.length > 0) {
      unknowns.add(
        "approvals",
        `parsed createdAt on ${filtered.undatedIds.length} record(s)`,
        `these records carry an unparseable createdAt and could not be placed in the requested time window, so they were KEPT rather than dropped: ${filtered.undatedIds.slice(0, 10).join(", ")}`,
      );
    }
    const ordered = orderApprovals(filtered.kept, listing.value.order);
    const page = ordered.slice(0, listing.value.limit);
    return json({
      ...base,
      order: listing.value.order,
      matched: known ? filtered.kept.length : null,
      returned: page.length,
      limit: listing.value.limit,
      moreMatchedThanReturned: filtered.kept.length > page.length,
      approvals: page.map((r) => toRow(r, listing.value.nowMs)),
      unknown: unknowns.list(),
    });
  },
});

// ---------------------------------------------------------------------------
// ApprovalsInbox — the fleet
// ---------------------------------------------------------------------------

type InboxRow = ApprovalRow & { readonly harness: string };

export const approvalsInbox: RegisteredTool = buildTool({
  name: "ApprovalsInbox",
  description:
    "The fleet's parked tool-approval requests in one page: every harness under a root that has a `crewhaus.yaml`, folded into a single list with the harness, the tool and the argument that parked each run. Use as the operator's morning read — one blocked harness in a fleet of twenty is invisible from any single run. A harness whose ledger cannot be read is listed in `unreadableHarnesses` and makes the totals a FLOOR rather than a total, so one bad mount never reports the fleet as idle. A pure read: it settles nothing and rewrites nothing.",
  inputSchema: z.object({
    root: z
      .string()
      .optional()
      .describe("the directory to walk for harnesses, relative to the working directory"),
    harnesses: z
      .array(z.string())
      .optional()
      .describe("explicit harness directories to read instead of walking for them"),
    maxDepth: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe(
        `how deep the walk descends looking for crewhaus.yaml (default ${DEFAULT_MAX_DEPTH})`,
      ),
    maxHarnesses: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe(`stop the walk after this many harnesses (default ${DEFAULT_MAX_HARNESSES})`),
    ...listingFields,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = resolveDirArg("ApprovalsInbox", input.root);
    if (!root.ok) return root.message;
    const listing = resolveListing(input);
    if (!listing.ok) return listing.message;
    const unknowns = new Unknowns();

    // Either an explicit list or a bounded walk. The explicit list is the
    // honest path for a fleet whose members are registered elsewhere; the walk
    // is for "everything under here".
    //
    // TWO paths per target, and they are not the same string. `rel` is relative
    // to the ROOT the caller named and is what the page shows; `wsRel` is
    // relative to the WORKSPACE and is the only one `resolveSafe` may be given.
    // Passing the display path to the containment check reads every harness of
    // `root: "fleet"` at `<cwd>/alpha` instead of `<cwd>/fleet/alpha` — which,
    // because a missing ledger is a legitimate "nothing parked", reports the
    // whole fleet as idle with nothing to say it looked in the wrong place.
    let targets: Array<{ readonly rel: string; readonly wsRel: string; readonly real: string }>;
    let walkNote: Record<string, unknown> = {};
    /** Why the harness LIST itself is incomplete — a fleet this page never saw
     *  is as invisible to the totals as one whose ledger would not open. */
    const walkLimits: string[] = [];
    if (input.harnesses !== undefined) {
      targets = [];
      // Deduplicate on the REAL path, so two spellings of one harness (a
      // relative path, a trailing slash, a symlink) do not double-count its
      // parks into the fleet totals.
      const seen = new Set<string>();
      for (const given of input.harnesses) {
        const resolved = resolveDirArg("ApprovalsInbox", given);
        if (!resolved.ok) return resolved.message;
        if (seen.has(resolved.value.real)) continue;
        seen.add(resolved.value.real);
        targets.push({
          rel: resolved.value.rel === "" ? "." : resolved.value.rel,
          wsRel: resolved.value.rel,
          real: resolved.value.real,
        });
      }
      targets.sort((a, b) => compareStrings(a.rel, b.rel));
      walkNote = { source: "explicit" };
    } else {
      const found = discoverHarnesses(
        root.value.real,
        input.maxDepth ?? DEFAULT_MAX_DEPTH,
        input.maxHarnesses ?? DEFAULT_MAX_HARNESSES,
      );
      targets = found.harnesses.map((h) => ({
        rel: h.rel,
        // The walk's `rel` is measured from the root; re-base it on the root's
        // own workspace-relative path before anything resolves it.
        wsRel: toPosix(path.join(root.value.rel, h.rel === "." ? "" : h.rel)),
        real: h.dir,
      }));
      walkNote = {
        source: "walk",
        truncated: found.truncated,
        depthLimited: found.depthLimited,
        unreadableDirs: found.unreadable,
      };
      // ALL THREE REASONS, IN ONE ENTRY. `Unknowns.add` is first-writer-wins,
      // so three `add("harnessCount", …)` calls report the first condition and
      // silently drop the other two — the exact collision this package files
      // separate facts under separate fields to avoid. These three are facts
      // about the SAME number, so they are joined into one reason instead.
      if (found.truncated) {
        walkLimits.push(
          `the walk stopped at its cap of ${input.maxHarnesses ?? DEFAULT_MAX_HARNESSES} harnesses, so more may exist below it`,
        );
      }
      if (found.depthLimited) {
        walkLimits.push(
          `the walk stopped at depth ${input.maxDepth ?? DEFAULT_MAX_DEPTH}, so a harness nested deeper was not seen`,
        );
      }
      if (found.unreadable.length > 0) {
        walkLimits.push(
          `${found.unreadable.length} director${found.unreadable.length === 1 ? "y" : "ies"} could not be listed, so a harness inside one was not seen`,
        );
      }
      if (walkLimits.length > 0) {
        unknowns.add("harnessCount", `walked ${root.value.rel || "."}`, walkLimits.join("; "));
      }
    }

    const rows: InboxRow[] = [];
    const unreadableHarnesses: Array<{ harness: string; reason: string }> = [];
    const truncatedHarnesses: string[] = [];
    const undatedIds: string[] = [];
    const totals = { pending: 0, granted: 0, "granted-always": 0, denied: 0, consumed: 0 };
    let matched = 0;
    let readHarnesses = 0;

    for (const target of targets) {
      // A directory the caller NAMED that is not there is a different answer
      // from a harness with an empty ledger, and reporting it as the second
      // would silently drop a fleet member from the totals.
      if (!existsSync(target.real)) {
        unreadableHarnesses.push({
          harness: target.rel,
          reason: "the directory does not exist",
        });
        continue;
      }
      const logPath = containedChild(
        "ApprovalsInbox",
        target.wsRel,
        path.join(SESSIONS_SUBDIR, APPROVALS_FILENAME),
      );
      if (!logPath.ok) {
        // A harness whose session root escapes the workspace is a refusal for
        // THAT harness, not for the page.
        unreadableHarnesses.push({
          harness: target.rel,
          reason: "its approvals log resolves outside the workspace root",
        });
        continue;
      }
      const store = readStore(logPath.value.real);
      if (store.state === "unreadable") {
        unreadableHarnesses.push({
          harness: target.rel,
          reason: store.reason ?? "the approvals log could not be read",
        });
        continue;
      }
      // A harness that relocates its session root keeps its approvals there
      // too, so "no ledger at the conventional path" says nothing about what is
      // parked. It joins the unreadable list, which is what makes the fleet
      // totals a floor rather than a count that quietly omits it.
      if (store.state === "missing") {
        const moved = sessionRootRelocation(target.real);
        if (moved !== undefined) {
          unreadableHarnesses.push({ harness: target.rel, reason: moved });
          continue;
        }
      }
      readHarnesses += 1;
      if (store.truncated || store.tornLines > 0) truncatedHarnesses.push(target.rel);
      const counts = countByStatus(store.records);
      for (const status of APPROVAL_STATUSES) totals[status] += counts[status];
      const filtered = filterApprovals(store.records, {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.tool !== undefined ? { tool: input.tool } : {}),
        ...(listing.value.sinceMs !== undefined ? { sinceMs: listing.value.sinceMs } : {}),
        ...(listing.value.untilMs !== undefined ? { untilMs: listing.value.untilMs } : {}),
      });
      undatedIds.push(...filtered.undatedIds);
      matched += filtered.kept.length;
      for (const record of filtered.kept) {
        rows.push({ harness: target.rel, ...toRow(record, listing.value.nowMs) });
      }
    }

    // The FLEET list is ordered by the SAME comparator one harness uses — a
    // parallel comparator for the fleet is exactly the kind of second
    // implementation that drifts. Each row is tagged onto the record it came
    // from, so ordering the records reorders the rows with no lookup key.
    //
    // Pre-sorting by (harness, id) supplies the cross-harness tiebreak:
    // `orderApprovals` breaks ties on `id` alone, and `Array.prototype.sort` is
    // stable, so two harnesses whose parks share a timestamp always interleave
    // the same way rather than in whatever order the walk happened to visit.
    const tagged = rows
      .slice()
      .sort((a, b) => compareStrings(a.harness, b.harness) || compareStrings(a.id, b.id))
      .map((r) => ({ ...rowAsRecord(r), row: r }));
    const sorted = (
      orderApprovals(tagged, listing.value.order) as Array<ApprovalRecord & { row: InboxRow }>
    ).map((t) => t.row);
    const page = sorted.slice(0, listing.value.limit);

    // EVERY WAY THE PAGE CAN BE SHORT, IN ONE PLACE. A harness whose ledger
    // would not open is not the only way the fleet totals come up short: a walk
    // that stopped at its count cap, at its depth cap, or at a directory it
    // could not list never SAW some harnesses at all, and a harness nobody
    // looked at is as absent from the totals as one whose file failed to open.
    // Reporting `totalsAreComplete: true` after a capped walk is exactly the
    // "bounded read presented as the whole answer" this package exists to
    // refuse — an operator reads `pending: 0, totalsAreComplete: true` as "the
    // fleet is idle" and stops looking, while a run sits parked below the cap.
    const floorReasons: string[] = [];
    if (unreadableHarnesses.length > 0) {
      floorReasons.push(
        `${unreadableHarnesses.length} harness(es) could not be read (see unreadableHarnesses)`,
      );
    }
    floorReasons.push(...walkLimits);
    if (truncatedHarnesses.length > 0) {
      floorReasons.push(
        `${truncatedHarnesses.length} harness ledger(s) were read only in part (see truncatedHarnesses)`,
      );
    }
    if (floorReasons.length > 0) {
      const probe = `walked ${root.value.rel || "."} and read ${readHarnesses} harness approvals log(s)`;
      unknowns.add(
        "totals",
        probe,
        `${floorReasons.join("; ")} — so every total below is a FLOOR, not a total: a run may be parked behind one of them right now`,
      );
      unknowns.add("matched", probe, `${floorReasons.join("; ")} — so the match count is a floor`);
    }
    if (truncatedHarnesses.length > 0) {
      unknowns.add(
        "truncatedHarnesses",
        `read ${truncatedHarnesses.length} large or partly torn approvals log(s)`,
        `${truncatedHarnesses.length} harness ledger(s) were read only in part (size cap or unparseable lines), so their older records are not counted`,
      );
    }
    if (undatedIds.length > 0) {
      unknowns.add(
        "approvals",
        `parsed createdAt on ${undatedIds.length} record(s)`,
        `these records carry an unparseable createdAt and could not be placed in the requested time window, so they were KEPT rather than dropped: ${undatedIds.slice(0, 10).join(", ")}`,
      );
    }

    return json({
      root: root.value.rel === "" ? "." : root.value.rel,
      walk: walkNote,
      harnessCount: targets.length,
      harnessesRead: readHarnesses,
      harnesses: targets.map((t) => t.rel),
      unreadableHarnesses: unreadableHarnesses.sort((a, b) => compareStrings(a.harness, b.harness)),
      truncatedHarnesses: truncatedHarnesses.sort(compareStrings),
      totals,
      // True only when every harness under the root was SEEN and every ledger
      // was read in full — see `floorReasons` above.
      totalsAreComplete: floorReasons.length === 0,
      order: listing.value.order,
      matched,
      returned: page.length,
      limit: listing.value.limit,
      moreMatchedThanReturned: sorted.length > page.length,
      approvals: page,
      unknown: unknowns.list(),
    });
  },
});

/**
 * Formerly: the `BLANKET GRANT` line for a proposal that covers the whole
 * tool rather than the approved call. Since 0.7.1 `rankSuggestions` writes
 * that line itself, for every reason a proposal can be bare (the tool
 * declares no scoping argument, the calls varied, a value no rule can name),
 * and this tool reports it from there. Its old wording also claimed no rule
 * could constrain an undeclared tool, which was not true.
 *
 * Kept, returning nothing, so a caller written against 0.7.0 keeps compiling.
 *
 * @deprecated Always returns `[]`; read the suggestion's `evidence`.
 */
export function blastRadiusNotes(
  _toolName: string,
  _argSamples: ReadonlyArray<string>,
  _argConstrained: boolean,
): string[] {
  return [];
}

/**
 * Which argument of a builtin decides where it acts, from the builtin
 * manifest — the compiled bundle this runs in carries only the tools its spec
 * granted, and a session log names tools it may not have. A tool the manifest
 * does not describe (MCP, custom) is unknown here, and its proposals are bare.
 */
const builtinLookup: SuggestToolLookup = (toolName) => {
  const row = TOOL_FLAGS_BY_NAME.get(toolName);
  if (row === undefined) return undefined;
  return row.operativeArgs !== undefined
    ? { operativeArgs: row.operativeArgs as ReadonlyArray<OperativeArg> }
    : {};
};

/**
 * Formerly: say out loud that an argument-constrained rule for a tool with
 * more than one operative field (Read, Write, Edit, Grep) was wider than the
 * call it came from, because the matcher accepted the argument in ANY of the
 * fields — so `Read(notes/a.md)` also covered
 * `{ file_path: "notes/a.md", path: "/etc/shadow" }`.
 *
 * Since 0.7.1 an allow rule needs EVERY operative value of the call to match,
 * and the file tools declare the one field they read, so that call is not
 * covered and there is nothing to disclose. Kept, returning nothing, so a
 * caller written against 0.7.0 keeps compiling.
 *
 * @deprecated Always returns `[]`.
 */
export function aliasFieldNotes(_toolName: string, _argConstrained: boolean): string[] {
  return [];
}

/** An inbox row back in record shape, so the SAME ordering code runs over the
 *  fleet list as over one harness. A parallel comparator for the fleet is
 *  exactly the kind of second implementation that drifts. */
function rowAsRecord(row: InboxRow): ApprovalRecord & { readonly harness: string } {
  return {
    harness: row.harness,
    id: row.id,
    toolName: row.toolName,
    inputHash: row.inputHash,
    runId: row.runId,
    sessionId: row.sessionId,
    surface: row.surface,
    createdAt: row.createdAt,
    ...(row.decidedBy !== null ? { decidedBy: row.decidedBy } : {}),
    ...(row.decidedAt !== null ? { decidedAt: row.decidedAt } : {}),
    // The projection lost `decision`/`consumedAt`, but `status` is the thing the
    // comparator reads — so it is reconstituted from the status, not guessed.
    ...(row.status === "granted" || row.status === "granted-always"
      ? { decision: "grant" }
      : row.status === "denied"
        ? { decision: "deny" }
        : {}),
    ...(row.status === "consumed" ? { consumedAt: row.decidedAt ?? row.createdAt } : {}),
    ...(row.always === true ? { always: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// PermissionsSuggest — the rules that would stop the asking
// ---------------------------------------------------------------------------

export const permissionsSuggest: RegisteredTool = buildTool({
  name: "PermissionsSuggest",
  description:
    "Mine a harness's own ask/deny history into permission rules that would stop the re-asking, each verified to match ONLY the call it was derived from. Recurring asks a human always approved become an `alwaysAllow` proposal; recurring DENIED asks become an `alwaysAsk` tightening, never a blanket deny. This tool PROPOSES and writes nothing — applying a rule is `crewhaus permissions suggest --apply`, which is always an interactive human confirm, because an agent must never widen its own permissions. Rules built from observed values are glob-escaped and then checked against the real permission matcher; any rule that would also match a value the human never approved is refused and reported in `rejected`, not suggested.",
  inputSchema: z.object({
    dir: z
      .string()
      .optional()
      .describe("the harness root holding .crewhaus/, relative to the working directory"),
    sessions: z
      .union([z.number().int().min(1).max(10_000), z.literal("all")])
      .optional()
      .describe(
        `how many of the most recent session logs to mine (default ${DEFAULT_SESSION_LIMIT})`,
      ),
    readOnlyTools: z
      .array(z.string())
      .optional()
      .describe(
        "names of NON-builtin tools (MCP, custom) known to be read-only. A CALLER'S CLAIM, never verified here. A builtin's own flag is always used instead; a tool that is neither is reported as unknown",
      ),
    minAsks: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `minimum prompts for a tool before any rule is proposed (default ${DEFAULT_SUGGEST_THRESHOLDS.minAsks})`,
      ),
    approveRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `fraction of asks approved at or above which a grant is proposed (default ${DEFAULT_SUGGEST_THRESHOLDS.approveRate}). A grant ALSO requires zero denials, whatever this is set to, so lowering it never proposes a grant for a tool a human has ever denied`,
      ),
    denyRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `fraction of asks denied at or above which a tightening is proposed (default ${DEFAULT_SUGGEST_THRESHOLDS.denyRate})`,
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const dir = resolveDirArg("PermissionsSuggest", input.dir);
    if (!dir.ok) return dir.message;
    const sessionsDir = containedChild("PermissionsSuggest", dir.value.rel, SESSIONS_SUBDIR);
    if (!sessionsDir.ok) return sessionsDir.message;
    const settingsPath = containedChild(
      "PermissionsSuggest",
      dir.value.rel,
      ".crewhaus/settings.json",
    );
    if (!settingsPath.ok) return settingsPath.message;

    const unknowns = new Unknowns();
    const limit = input.sessions ?? DEFAULT_SESSION_LIMIT;
    const read = readRecentSessions(sessionsDir.value.real, limit);

    if (read.unreadableDir !== undefined) {
      unknowns.add("mined.available", `list ${sessionsDir.value.rel}`, read.unreadableDir);
    }
    if (read.failures.length > 0) {
      unknowns.add(
        "mined.unreadable",
        `read ${read.failures.length} session log(s)`,
        `${read.failures.length} session log(s) could not be read, so asks they recorded are not counted and a tool's approve/deny ratio may be wrong: ${read.failures
          .map((f) => `${f.file} (${f.reason})`)
          .slice(0, 5)
          .join("; ")}`,
      );
    }
    if (read.truncatedFiles.length > 0) {
      unknowns.add(
        "mined.truncatedFiles",
        `read ${read.truncatedFiles.length} oversized session log(s)`,
        `${read.truncatedFiles.length} session log(s) exceeded the read cap; only their newest records were mined, so earlier denials may be missing from the counts`,
      );
    }
    if (read.tornLines > 0) {
      unknowns.add(
        "mined.tornLines",
        "parsed the mined session logs",
        `${read.tornLines} line(s) did not parse, so the ask/deny counts below are a floor — a "never denied" verdict may be an artefact of the lines that went missing`,
      );
    }

    const aggregates = aggregateAsks(read.sessions, builtinLookup);
    // A builtin's read-only flag is known from the manifest; anything else
    // only from the caller's claim, and otherwise not at all.
    const claimed = input.readOnlyTools;
    const readOnly = new Map<string, boolean>();
    for (const name of aggregates.keys()) {
      const row = TOOL_FLAGS_BY_NAME.get(name);
      if (row !== undefined) readOnly.set(name, row.readOnly);
      else if (claimed !== undefined) readOnly.set(name, claimed.includes(name));
    }
    const readOnlyKnown = (name: string): boolean => readOnly.has(name);

    const thresholds = {
      minAsks: input.minAsks ?? DEFAULT_SUGGEST_THRESHOLDS.minAsks,
      approveRate: input.approveRate ?? DEFAULT_SUGGEST_THRESHOLDS.approveRate,
      denyRate: input.denyRate ?? DEFAULT_SUGGEST_THRESHOLDS.denyRate,
    };
    const ranked = rankSuggestions(aggregates, readOnly, thresholds);
    const unknownReadOnly = [
      ...new Set(ranked.map((r) => r.toolName).filter((n) => !readOnlyKnown(n))),
    ].sort(compareStrings);
    if (unknownReadOnly.length > 0) {
      unknowns.add(
        "suggestions[].readOnly",
        "looked each suggested tool up among the builtins",
        `${unknownReadOnly.slice(0, 5).join(", ")} ${unknownReadOnly.length === 1 ? "is not a builtin" : "are not builtins"}, so whether ${unknownReadOnly.length === 1 ? "it is" : "they are"} read-only is not known here; pass readOnlyTools to say so`,
      );
    }

    // ---- the security gate -------------------------------------------------
    // Every proposal is checked against the real matcher before it is named.
    // A rule that reaches past the call it came from is refused, not softened.
    const verified: PermissionSuggestion[] = [];
    const rejected: Array<Record<string, unknown>> = [];
    const verifiedJson: Array<Record<string, unknown>> = [];
    for (const suggestion of ranked) {
      const agg = aggregates.get(suggestion.toolName);
      // The value `patternFor` embeds is the single place every recorded call
      // acted on, and only when there is one. Anything else yields a bare tool
      // glob with no argument to verify.
      const scoped = agg !== undefined && isArgScoped(agg);
      const embedded = scoped ? agg.argSamples[0] : undefined;
      const verdict = verifyRule(
        suggestion.rule.pattern,
        suggestion.toolName,
        embedded,
        scoped ? agg.argKind : undefined,
      );
      if (!verdict.ok) {
        rejected.push({
          toolName: suggestion.toolName,
          type: suggestion.rule.type,
          pattern: suggestion.rule.pattern,
          reason: verdict.reason,
        });
        continue;
      }
      verified.push(suggestion);
      const notes = readOnlyKnown(suggestion.toolName)
        ? []
        : [
            "whether this tool is read-only is not known here, so any line above calling it not-read-only is the fail-closed default rather than an observation",
          ];
      verifiedJson.push({
        type: suggestion.rule.type,
        pattern: suggestion.rule.pattern,
        reason: suggestion.reason,
        toolName: suggestion.toolName,
        readOnly: readOnlyKnown(suggestion.toolName) ? suggestion.readOnly : null,
        weight: suggestion.weight,
        // The single fact that separates "allow this one call" from "allow this
        // tool for anything": whether the rule constrains an argument at all.
        argConstrained: verdict.argConstrained,
        evidence: [...suggestion.evidence, ...notes],
        verified: verdict.checks,
      });
    }
    if (rejected.length > 0) {
      unknowns.add(
        "rejected",
        "verified each proposed rule against the permission matcher",
        `${rejected.length} proposal(s) were refused because the rule would also match calls the human never approved (see rejected); those tools will keep asking until a human writes a rule by hand`,
      );
    }

    // ---- what is already in force -----------------------------------------
    const settings = readSettings(settingsPath.value.real);
    let diff: {
      readonly additions: ReadonlyArray<SettingsPermissionRule>;
      readonly alreadyPresent: ReadonlyArray<SettingsPermissionRule>;
      readonly merged: ReadonlyArray<SettingsPermissionRule> | null;
    } | null = null;
    const settingsJson: Record<string, unknown> = {
      path: settingsPath.value.rel,
      state: settings.kind,
    };
    if (settings.kind === "unusable") {
      settingsJson["reason"] = settings.reason;
      // A file that cannot be read is NOT a file with no rules. Diffing against
      // an empty baseline would propose additions that may already exist and a
      // merged list that would delete whatever is really in there.
      unknowns.add(
        "diff",
        `read ${settingsPath.value.rel}`,
        `${settings.reason} — the rules already in force are unknown, so no additive diff is offered; the suggestions above are still valid on their own`,
      );
    } else {
      const existing = settings.kind === "read" ? settings.rules : [];
      settingsJson["existingRules"] = existing.length;
      if (settings.kind === "read" && settings.declaredEntries !== null) {
        settingsJson["declaredRuleEntries"] = settings.declaredEntries;
      }
      const computed = diffPermissions(existing, verified);
      const mergeUnsafe = settings.kind === "read" ? settings.mergeUnsafeReason : undefined;
      if (mergeUnsafe !== undefined) {
        unknowns.add("diff.merged", `read ${settingsPath.value.rel}`, mergeUnsafe);
      }
      diff = {
        additions: computed.additions,
        alreadyPresent: computed.alreadyPresent,
        merged: mergeUnsafe === undefined ? computed.merged : null,
      };
    }

    const askRows = [...aggregates.values()]
      .map((a) => ({
        toolName: a.toolName,
        asks: a.asks,
        approved: a.approved,
        denied: a.denied,
        distinctInputsSampled: a.argSamples.length,
      }))
      .sort((a, b) => b.asks - a.asks || compareStrings(a.toolName, b.toolName));

    return json({
      harnessDir: dir.value.rel === "" ? "." : dir.value.rel,
      sessionsDir: sessionsDir.value.rel,
      // Said in the result as well as the description: a caller that only reads
      // the JSON must not think a rule took effect because this tool named it.
      appliesRules: false,
      applyWith: "crewhaus permissions suggest --apply (interactive confirm only)",
      mined: {
        requested: limit,
        // `null`, not 0: a directory that could not be LISTED holds an
        // unknown number of logs, and a zero there reads as "this harness has
        // never run".
        available: read.unreadableDir !== undefined ? null : read.available,
        sessionsDirMissing: read.missingDir,
        mined: read.sessions.map((s) => s.sessionId).sort(compareStrings),
        unreadable: read.failures,
        truncatedFiles: read.truncatedFiles,
        tornLines: read.tornLines,
      },
      thresholds,
      asks: askRows,
      suggestions: verifiedJson,
      rejected,
      settings: settingsJson,
      diff,
      unknown: unknowns.list(),
    });
  },
});

export const APPROVALS_TOOLS: readonly RegisteredTool[] = Object.freeze([
  approvalStatus,
  approvalsInbox,
  permissionsSuggest,
]);

export {
  APPROVAL_STATUSES,
  APPROVALS_FILENAME,
  SESSIONS_SUBDIR,
  countByStatus,
  filterApprovals,
  foldApprovals,
  isApprovalId,
  orderApprovals,
  parseInstant,
  statusOf,
  toRow,
} from "./lib/approvals";
export type {
  ApprovalOrder,
  ApprovalRecord,
  ApprovalRow,
  ApprovalStatusName,
} from "./lib/approvals";
export { discoverHarnesses } from "./lib/harnesses";
export { argNearMisses, verifyRule } from "./lib/rule-check";
export type { RuleVerdict } from "./lib/rule-check";
export { DEFAULT_SESSION_LIMIT, isSessionLogName, readRecentSessions } from "./lib/sessions";
export { SESSION_DIR_ENV, declaresSessionDir, sessionRootRelocation } from "./lib/session-root";
export { countDeclaredRuleEntries, readSettings } from "./lib/settings";
export type { SettingsRead } from "./lib/settings";
export { Unknowns } from "./lib/unknown";
export type { UnknownFact } from "./lib/unknown";
