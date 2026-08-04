/**
 * The M3 handler seam: the context every per-area route body receives, and
 * the guards the dispatcher has ALREADY applied before calling one.
 *
 * M1 browsed harness state, M2 drove processes. M3 is the detail surface —
 * spec editing, the memory fabric's write side, the eval/dataset/feedback
 * loops, credentials + channels + security, Thredz, and the raw inspectors.
 * That is far too many routes to hand-branch, so dispatch is a pure-data
 * table (`m3-routes.ts`) matched against the request and validated in ONE
 * place. A handler therefore never re-checks any of this:
 *
 *   - AUTH — the bearer was verified before the path was even split.
 *   - ID SHAPE — `:id` matched `HARNESS_ID_RE` and resolved to a registry
 *     entry whose directory exists (404 otherwise). Every other `:param`
 *     matched its guard ({@link PARAM_GUARDS}, {@link SAFE_SEGMENT_RE}
 *     by default) BEFORE any filesystem work.
 *   - BODY — POST/PUT bodies are parsed and proven to be JSON objects.
 *   - MASKING — whatever a handler returns passes `maskDeep` on the way out.
 *     That is defense in depth, not permission: a handler that reads free
 *     text (a wiki body, a changelog, a captured log) still masks it itself,
 *     because `maskDeep`'s key-based redaction cannot see into prose.
 *
 * ---------------------------------------------------------------------------
 * THE WRITE COVENANT — every M3 handler is bound by it
 * ---------------------------------------------------------------------------
 * "One state tree, two heads": the manager and the CLI write the SAME files
 * through the SAME libraries. A handler never hand-rolls a file format and
 * never string-templates YAML.
 *
 *   spec        → `@crewhaus/spec-patch` `applySpecEdits(yaml, edits,
 *                 { restrictToOptimizable: true })`. Paths OUTSIDE
 *                 `OPTIMIZABLE_PATHS` (permissions, the model roster,
 *                 watchme.*, plugins, expose, learning.sources, thredz,
 *                 sandbox/tool_config, transaction_policy) are human-owned:
 *                 they get the credential-redacted `diffSpecYaml`
 *                 interstitial + typed confirm, or route to
 *                 `crewhaus propose`. Enforced HERE, server-side — never
 *                 only in the UI.
 *   env         → `upsertEnvVar` (0600, comments + order preserved, the
 *                 `# NAME=` stub grammar). Values go IN; only presence
 *                 booleans come OUT. No value is ever stored by the manager,
 *                 returned to a client, or put in a URL.
 *   secrets     → `@crewhaus/secrets-manager` `rotate` (so `onRotation`
 *                 subscribers refresh without a restart).
 *   memory      → the memory/wiki/continuity stores. NO HARD DELETE EXISTS
 *                 ANYWHERE: forget = a supersede tombstone with a recorded
 *                 reason, continuity clear = `trash/<ts>/` with restore,
 *                 wiki = archived status (or Thredz soft-delete + restore),
 *                 sessions = TTL + pins. Hangar ships no affordance that
 *                 unlinks a memory file.
 *   wiki        → writes carry `expectedVersion`; a `stale_article_version`
 *                 refusal is a FIRST-CLASS state (re-read, show the diff,
 *                 offer retry), identical for the local and Thredz backends.
 *   feedback    → the `FeedbackRecord` writers (the `crewhaus rate` path).
 *   approvals   → `createPendingApprovalStore`.
 *   pins        → session-store retention helpers; spec pins via
 *                 spec-registry / the `deploy` verbs (audit + quorum kept).
 *   anything else that is a CLI verb → the job queue (`ctx.jobs.submit`),
 *                 with argv built from a CLOSED vocabulary and every
 *                 interpolated value shape-checked ({@link jobArg}). A
 *                 request body must never be able to append a flag — or a
 *                 second command — to a spawn.
 *
 * READS NEVER MUTATE. Never `SessionStore.list()` (its TTL eviction deletes
 * transcripts) and never `PendingApprovalStore.list()` (it COMPACTS the
 * ledger): browse raw, fold tombstones, skip torn lines, cap what you read.
 * `index.json` caches are rebuildable hints, never the source of truth.
 *
 * CONTAINMENT IS PER FILE. `ctx.contain([...])` realpath-checks every single
 * read: listing a directory yields NAMES, and a name can be a symlink out of
 * the tree. Re-check per file, never once per directory.
 *
 * THE DESTRUCTIVE LADDER — three rungs, and the rung is chosen by how
 * recoverable the action is, not by how scary it sounds:
 *   confirm        — stop/restart, forget a memory (tombstone), archive a
 *                    wiki article, reset the routing scoreboard: a dialog.
 *   typed-confirm  — retention purge, `state restore` over a non-empty
 *                    `.crewhaus`, cross-harness credential rotate, deleting
 *                    a deployment record, `migrate-all`: the operator types
 *                    the harness/spec name and the SERVER verifies it.
 *   dry-run-first  — `retire`, `retention sweep|purge`: the manager runs
 *                    `--dry-run` and shows the plan; the real run is a
 *                    SECOND, typed-confirm gesture. `retire` additionally
 *                    surfaces its active-pin refusal before offering the
 *                    real thing.
 *
 * SUGGESTION FEEDS ARE ADVISORY. `advise`, `watchme synthesize`,
 * `model-scan`/`right-size`, `graders suggest`: rendering a proposal is
 * never applying it. Apply is always a separate, explicit gesture that goes
 * back through the spec write path above.
 */
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import type { JobQueue, JobRecord } from "@crewhaus/harness-supervisor";
import type { ControlClient } from "./control-client";
import { HttpError } from "./http";
import type { HarnessProcess } from "./process";

/** Path params, already validated by the dispatcher. */
export type M3Params = Readonly<Record<string, string>>;

/** One registered, live harness — the shape the fleet-wide handlers fold. */
export type M3Harness = {
  readonly id: string;
  readonly dir: string;
  readonly specName: string;
};

/**
 * What a handler is handed. Everything here is already validated; nothing
 * here is optional guesswork.
 */
export type M3Context = {
  /** The registry row, or null on a fleet-wide route (`/api/credentials`…). */
  readonly entry: HangarHarnessEntry | null;
  /** The harness's live directory, or null on a fleet-wide route. Present
   *  implies it exists (a vanished dir 404s before the handler runs). */
  readonly harnessDir: string | null;
  /** Validated `:param` values from the path. */
  readonly params: M3Params;
  /** The request's query string. Never carries anything credential-shaped. */
  readonly query: URLSearchParams;
  /** Parsed JSON object body for POST/PUT; `{}` for GET/DELETE. */
  readonly body: Readonly<Record<string, unknown>>;
  /** The manager's environment merged with the harness's `.env` files —
   *  the same layering preflight and spawns see. Values, so a handler can
   *  READ a signing secret server-side; never serialize one. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected clock (epoch ms) — handlers must not call `Date.now()`. */
  readonly now: () => number;
  /** Identity recorded on any decision this request settles. */
  readonly operator: string;
  /**
   * A `<harness>`-relative path, realpath-contained. Throws `HttpError(400)`
   * when the segments are unsafe or the resolved path escapes the harness
   * dir. Call it PER FILE — a listed name can be a symlink.
   */
  readonly contain: (segments: readonly string[]) => string;
  /** Every live registered harness (fleet-wide folds). */
  readonly harnesses: () => readonly M3Harness[];
  /** The supervised process handle (adopted first), for routes that need the
   *  runfile, the control port, or the port ledger. */
  readonly process: () => Promise<HarnessProcess>;
  /** The `crewhaus.control.v1` proxy — never returns the bearer. */
  readonly control: ControlClient;
  /** The durable job queue: the ONLY sanctioned way to run a CLI verb. */
  readonly jobs: JobQueue;
  /** Submit a CLI job. `kind` is a display/lock key (`isReadOnlyJob` decides
   *  whether it takes the harness mutex); `argv` must come from the module's
   *  own closed vocabulary, never from the request body verbatim. */
  readonly submitJob: (kind: string, argv: readonly string[]) => JobRecord;
  /** Warning sink — an honest degradation, never a thrown 500. */
  readonly warn: (message: string) => void;
};

/** A route body. Return a plain value (masked + JSON-encoded for you) or a
 *  `Response` when the route needs its own status/headers. */
export type M3Handler = (ctx: M3Context) => unknown | Promise<unknown>;

/**
 * The stub every M3 handler currently is. The status is deliberately 501 and
 * not 404: the route EXISTS, the client's map is right, and the console can
 * render "not built yet" instead of "you are lost". The contract test drives
 * every M3 route and accepts exactly this — so an implementer's only job is
 * to make their handler return real data and the test starts demanding the
 * fields the view reads.
 */
export function notImplemented(what: string): never {
  throw new HttpError(501, `not implemented (M3): ${what}`);
}

/**
 * One path segment, or a harness-relative path of such segments — the same
 * shape `process.ts` pins for job argv. Re-exported as a guard so each area
 * module builds its CLOSED argv vocabulary against the identical rule
 * instead of inventing a looser one.
 */
export const M3_JOB_ARG_RE =
  /^[A-Za-z0-9_][A-Za-z0-9._@:-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._@:-]{0,127})*$/;

/** Shape-check one value on its way into a command line. Throws a 400 —
 *  a bad argument is a client error, never a spawn. */
export function jobArg(name: string, value: unknown): string {
  if (typeof value !== "string" || !M3_JOB_ARG_RE.test(value)) {
    throw new HttpError(
      400,
      `"${name}" must be a plain name or harness-relative path (no flags, no absolute paths)`,
    );
  }
  return value;
}

/** Require a string body field. */
export function requireString(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw new HttpError(400, `missing "${key}"`);
  return value;
}

/** Require a boolean body field. */
export function requireBoolean(body: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new HttpError(400, `missing "${key}" boolean`);
  return value;
}

/**
 * The typed-confirm rung: the operator must echo the harness/spec name and
 * the SERVER verifies it. A client-side confirmation is decoration; this is
 * the gate.
 */
export function requireTypedConfirm(
  body: Readonly<Record<string, unknown>>,
  expected: string,
): void {
  if (body["confirmName"] !== expected) {
    throw new HttpError(
      409,
      `this action needs a typed confirmation: send "confirmName": "${expected}"`,
    );
  }
}

/** True when the caller asked for the dry run. The destructive verbs treat
 *  `dryRun` as the DEFAULT — an omitted flag must never mean "do it". */
export function isDryRun(body: Readonly<Record<string, unknown>>): boolean {
  return body["dryRun"] !== false;
}
