/**
 * M3 · SPEC — the spec's write side: the structured editor, trust tiers,
 * version history + pins + diffs, and the `propose` review path.
 *
 * The one rule this module exists to enforce: **a spec is never written by
 * string-templating YAML.** Everything goes through `@crewhaus/spec-patch`
 * `applySpecEdits(yaml, edits, …)`, which is atomic, comment-preserving and
 * re-validating. Two tiers, enforced HERE and not merely in the UI:
 *
 *   auto-tunable — paths inside `OPTIMIZABLE_PATHS` that are NOT also a
 *     `SECURITY_SURFACES` prefix. Apply with `{ restrictToOptimizable:
 *     true }`; the same restriction the optimizer runs under, so the console
 *     can never write what the machine may not. The exclusion is the other
 *     half of that sentence: a surface the optimizer may tune against an
 *     eval is still human-owned when one operator clicks Save.
 *   human-owned — everything else (permissions, the model roster/candidates,
 *     watchme.*, plugins, expose, learning.sources, thredz,
 *     sandbox/tool_config, transaction_policy). These require the
 *     credential-redacted `diffSpecYaml` interstitial plus a typed
 *     confirmation, or — when the harness is git-tracked — they route to
 *     `crewhaus propose` and become a review PR instead of a write.
 *
 * Everything served from here passes the maskers: `diffSpecYaml` output and
 * CHANGELOG bodies quote spec text verbatim, so a pasted credential reaches
 * a diff even when the live spec has been cleaned. `maskSpecYaml` for YAML,
 * `maskText` for prose, `maskDeep` for trees.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF "NO", AND THE STATUS EACH GETS
 * ---------------------------------------------------------------------------
 * A refusal about the REQUEST is an HTTP error: a malformed edit list, a
 * path that is not a path, a human-owned batch with no typed confirmation
 * (409, carrying the redacted preview the interstitial renders).
 *
 * A refusal about the WORLD is a 200 with `{ ok: false, code, reason }` —
 * the same typed-envelope posture the control.v1 proxy already uses. "This
 * spec does not validate, so no edit can be applied", "that version is not
 * in the registry", "the batch changes nothing" are FACTS the editor has to
 * render next to the field the operator is looking at; turning them into
 * error toasts would throw away the only thing the screen is for. Every
 * such envelope names the code, the reason, and the verb that fixes it.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA IS CHECKED PER HARNESS, OUTSIDE THIS PROCESS
 * ---------------------------------------------------------------------------
 * A machine's harnesses span crewhaus versions; that is the normal case. A
 * harness adopted with `crewhaus harness adopt` on this machine whose
 * `@crewhaus/spec` realpath-contains inside it is checked with that copy, in a
 * child process
 * (`spec-validator-child.ts`): a harness's code never runs inside Home. Any
 * other harness, or a check that cannot answer, is checked with this
 * manager's own schema, with a note that says so. A spec carrying keys the
 * schema in use does not know is READ-ONLY here: every read says so, and
 * every write answers 409 `read-only` naming the keys. Resolution never
 * installs anything: opening a tab must not dirty a git-clean dir.
 *
 * ---------------------------------------------------------------------------
 * EVERY WRITE IS ONE GUARDED COMMIT
 * ---------------------------------------------------------------------------
 * Every spec write here goes through `@crewhaus/spec-patch/commit`, and must
 * carry the revision the editor loaded (`expectedRev`; 428 without one). A
 * spec changed on disk since that read is answered 412 with the current
 * revision, the diff the refused edits would make on top of it, and the id of
 * the draft kept for them (`specDraft` serves it). Every commit records a
 * version in the harness's registry.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { type Spec, parseSpec, parseSpecIssues, specJsonSchema } from "@crewhaus/spec";
import { autoRegisterSpecVersion } from "@crewhaus/spec-changelog/spec-changelog";
import {
  OPTIMIZABLE_PATHS,
  REDACTED_VALUE,
  type SpecDiffEntry,
  type SpecEdit,
  applySpecEdits,
  diffSpecYaml,
  escalationFor,
  isCredentialKey,
  isOptimizable,
  protectedBarChange,
  specHasPath,
  surfaceFor,
  surfaceMatchesFrom,
  withPatchApplied,
} from "@crewhaus/spec-patch";
import {
  type CommitFailure,
  type CommitSuccess,
  DRAFT_ID_RE,
  type WriterId,
  commitSpec,
  parseYamlOnly,
  readSpecDraft,
  specRev,
} from "@crewhaus/spec-patch/commit";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import { MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { HttpError } from "./http";
import { readTextCapped } from "./jsonl";
import {
  type M3Context,
  type M3Handler,
  jobArg,
  requirePermission,
  requireTypedConfirm,
} from "./m3";
import { maskDeep, maskSpecYaml, maskText } from "./mask";
import { resolveContained } from "./safety";
import { type ChildTimer, type SpawnChild, validateInHarness } from "./spec-validator-child";

export { SECURITY_SURFACES } from "@crewhaus/spec-patch";
import { keyLineParts, namedValues } from "./spec-lines";

/** The spec file every harness is anchored on. */
const SPEC_FILE = "crewhaus.yaml";

/** Where the per-spec version registry + CHANGELOG live inside a harness. */
const STATE_DIR = ".crewhaus";
const SPECS_SUBDIR = "specs";

/** Caps: a trust table or an effective-config table is a SCREEN, not a
 *  dump. Both stop long before a pathological spec makes the browser paint
 *  ten thousand rows. */
const MAX_TRUST_ROWS = 600;
const MAX_EFFECTIVE_ROWS = 600;
const MAX_VERSIONS = 100;

// ---------------------------------------------------------------------------
// typed answers
// ---------------------------------------------------------------------------

/** A refusal that is a fact about the harness, not about the request. */
function refusal(
  code: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: false, code, reason, ...extra };
}

/** The three fields every M3 read carries: is there anything to show, why
 *  not when there is not, and the verb that would create it. */
function base(present: boolean, note: string | null, verb: string | null): Record<string, unknown> {
  return { present, note, verb };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// the spec file
// ---------------------------------------------------------------------------

export type SpecFileRead = {
  /** Absolute, contained path — safe to read and to write back through. */
  readonly path: string;
  readonly present: boolean;
  /** Raw text, UNMASKED — masked only on the way out. */
  readonly text: string;
  /** True when the file is past `MAX_TEXT_BYTES` and `text` is only its
   *  HEAD. A view may render a prefix; a write may never round-trip one —
   *  see {@link requireWholeSpec}. */
  readonly truncated: boolean;
  readonly specName: string;
  readonly target: string;
  /** The spec's revision (`specRevision`), or `absent`: the token every write sends back as `expectedRev`. */
  readonly rev: string;
  /** The same value as `rev`, under the name earlier clients read. */
  readonly hash: string;
};

/** Read the harness's spec through the dispatcher's containment closure.
 *  Absence is not an error: `present: false` with empty text. */
export function readSpecFile(ctx: Pick<M3Context, "contain" | "entry">): SpecFileRead {
  const path = ctx.contain([SPEC_FILE]);
  const present = existsSync(path);
  const read = present ? readTextCapped(path, MAX_TEXT_BYTES) : { text: "", truncated: false };
  const header = read.text === "" ? {} : readSpecHeader(read.text);
  return {
    path,
    present,
    text: read.text,
    truncated: read.truncated,
    specName: header.name ?? ctx.entry?.specName ?? "spec",
    target: header.target ?? "unknown",
    rev: present ? specRev(read.text) : "absent",
    hash: present ? specRev(read.text) : "absent",
  };
}

/**
 * The refusal a CAPPED read owes every write path.
 *
 * `readSpecFile` reads through `readTextCapped`, so a spec past the cap
 * comes back as a PREFIX of itself. A prefix is a VIEW: rendering one is
 * honest, building a write from one is not. Refuse instead, with the verb
 * that can do the job. The same refusal `watchme-ops`' `liveSpec` and the
 * settings writer in `inspect.ts` make.
 */
export function requireWholeSpec(file: SpecFileRead): void {
  if (!file.truncated) return;
  throw new HttpError(
    409,
    `${SPEC_FILE} is larger than this server reads (${MAX_TEXT_BYTES} bytes) — refusing to write back a spec it could not read whole. Edit it with the CLI, then \`crewhaus compile ${SPEC_FILE} -o dist\`.`,
  );
}

// ---------------------------------------------------------------------------
// the schema a spec is checked with (the mixed-version fleet)
// ---------------------------------------------------------------------------

export type SpecIssueRow = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code?: string;
};

/** Which schema checked a spec, and what it found. */
export type SchemaCheck = {
  /** The harness's own `@crewhaus/spec` (in a child process), or this manager's. */
  readonly source: "harness" | "manager";
  /** The answering copy's version, when its package.json could be read. */
  readonly version: string | null;
  /** Why the harness's own schema did not answer, when it did not. */
  readonly note: string | null;
  /** Diagnostics, messages masked. */
  readonly issues: ReadonlyArray<SpecIssueRow>;
  /** `op: "schema"` only: the JSON schema. */
  readonly schema?: Record<string, unknown>;
  /** `op: "schema"` only: the spec parsed with defaults, or undefined when it does not parse. */
  readonly parsed?: unknown;
  /** `op: "schema"` only: why it does not parse. */
  readonly parseError?: string;
};

/** The note a harness not adopted with `crewhaus harness adopt` on this machine gets; with
 *  no registry row there is no id to name. */
export function notAdoptedNote(id: string | undefined): string {
  return id === undefined
    ? "Checked with this CrewHaus's schema. To check it with its own, run crewhaus harness adopt <dir>."
    : `Checked with this CrewHaus's schema. To check it with its own, run crewhaus harness adopt ${id}.`;
}

/** Test seam for the child check: its spawn, timer and interpreter. */
export type SchemaCheckDeps = {
  readonly spawn?: SpawnChild;
  readonly timer?: ChildTimer;
  readonly interpreter?: string | undefined;
};

let schemaCheckDeps: SchemaCheckDeps = {};

/** Replace the child check's seams (tests). */
export function setSchemaCheckDeps(deps: SchemaCheckDeps): void {
  schemaCheckDeps = deps;
  schemaChecks.clear();
}

/** Answers by harness, copy, operation and spec revision: one child per distinct question. */
const schemaChecks = new Map<string, SchemaCheck>();
const MAX_SCHEMA_CHECKS = 64;

function harnessPackageVersion(harnessDir: string): string | null {
  const pkg = resolveContained(
    harnessDir,
    join("node_modules", "@crewhaus", "spec", "package.json"),
  );
  if (pkg === undefined || !existsSync(pkg)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function rowsOf(
  issues: ReadonlyArray<{
    path: ReadonlyArray<string | number>;
    message: string;
    code?: string | null;
  }>,
): SpecIssueRow[] {
  return issues.map((issue) => ({
    path: issue.path.map((p) => String(p)),
    message: maskText(issue.message),
    ...(typeof issue.code === "string" ? { code: issue.code } : {}),
  }));
}

/** This manager's own schema. */
function managerCheck(yamlText: string, op: "issues" | "schema", note: string | null): SchemaCheck {
  let issues: SpecIssueRow[];
  if (yamlText === "") {
    issues = [];
  } else {
    try {
      issues = rowsOf(parseSpecIssues(yamlText));
    } catch (err) {
      issues = [{ path: [], message: maskText(errText(err)), code: "parser_failed" }];
    }
  }
  if (op === "issues") return { source: "manager", version: null, note, issues };
  let parsed: unknown;
  let parseError: string | undefined;
  try {
    parsed = parseSpec(yamlText);
  } catch (err) {
    parseError = errText(err);
  }
  return {
    source: "manager",
    version: null,
    note,
    issues,
    schema: specJsonSchema() as Record<string, unknown>,
    ...(parsed !== undefined ? { parsed } : {}),
    ...(parseError !== undefined ? { parseError } : {}),
  };
}

/**
 * Check `yamlText` with the schema this harness is built against.
 *
 * A harness adopted with `crewhaus harness adopt` on this machine whose
 * `@crewhaus/spec` resolves inside it is checked with that copy, in a child
 * process; anything else, or a child that cannot answer, with this manager's
 * schema and a note naming why. Never throws.
 */
export async function checkSpec(
  ctx: Pick<M3Context, "harnessDir" | "adopted" | "entry">,
  yamlText: string,
  op: "issues" | "schema",
): Promise<SchemaCheck> {
  const dir = ctx.harnessDir;
  if (dir === null || ctx.adopted !== true) {
    return managerCheck(yamlText, op, notAdoptedNote(ctx.entry?.id));
  }
  let resolved: string;
  try {
    resolved = Bun.resolveSync("@crewhaus/spec", dir);
  } catch {
    return managerCheck(
      yamlText,
      op,
      "this harness has no installed @crewhaus/spec — checked with this CrewHaus's schema",
    );
  }
  const entry = resolveContained(dir, resolved);
  if (entry === undefined) {
    return managerCheck(
      yamlText,
      op,
      "this harness resolves @crewhaus/spec outside its own directory — checked with this CrewHaus's schema",
    );
  }
  const version = harnessPackageVersion(dir);
  const key = [dir, entry, version ?? "", op, specRev(yamlText)].join("\u0000");
  const cached = schemaChecks.get(key);
  if (cached !== undefined) return cached;
  const answer = await validateInHarness(dir, yamlText, { op, entry, ...schemaCheckDeps });
  if (!answer.ok) {
    return managerCheck(yamlText, op, `${answer.note} — checked with this CrewHaus's schema`);
  }
  const check: SchemaCheck = {
    source: "harness",
    version,
    note: null,
    issues: rowsOf(answer.issues),
    ...(answer.schema !== undefined ? { schema: answer.schema } : {}),
    ...(answer.parsed !== undefined && answer.parsed !== null ? { parsed: answer.parsed } : {}),
    ...(op === "schema" && (answer.parsed === undefined || answer.parsed === null)
      ? { parseError: "the spec does not validate against the harness's schema" }
      : {}),
  };
  if (schemaChecks.size >= MAX_SCHEMA_CHECKS) {
    const oldest = schemaChecks.keys().next().value;
    if (oldest !== undefined) schemaChecks.delete(oldest);
  }
  schemaChecks.set(key, check);
  return check;
}

/** Diagnostics, as the plain rows the editor anchors to a field. */
function issueRows(check: SchemaCheck): EditIssueRow[] {
  return check.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)),
    message: issue.message,
    code: issue.code ?? null,
  }));
}

// ---------------------------------------------------------------------------
// read-only: a spec with settings this schema does not know
// ---------------------------------------------------------------------------

export type ReadOnlyState = {
  /** Plain sentences: why, and what can help. Never a command line. */
  readonly reason: string;
  readonly paths: ReadonlyArray<string>;
  /** A complete command that can help, or null when none can be named. */
  readonly verb: string | null;
};

/**
 * The settings a schema reports it does not know. Such an issue's `path` is
 * the PARENT object, and the key names are only in the message
 * (`Unrecognized key(s) in object: 'a', 'b'`), so each path is the parent
 * plus each quoted key, falling back to the parent alone.
 */
export function unknownKeyPaths(issues: ReadonlyArray<SpecIssueRow>): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const parent = issue.path.map(String).join(".");
    const keys = [...issue.message.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    if (keys.length === 0) out.push(parent === "" ? "(root)" : parent);
    for (const key of keys) out.push(parent === "" ? key : `${parent}.${key}`);
  }
  return [...new Set(out)];
}

/**
 * The read-only state a check implies, or null when the spec may be edited here.
 *
 * `reason` is plain sentences, never a command. `verb` is a complete command or
 * null: adopting the harness is offered when this Home's schema answered for a
 * registered harness that does not run its own code here (its own schema may know
 * the keys; adopting is still the person's act). With no registry row there is no
 * id to name, and when the harness's own schema answered, or one that runs its own
 * code was checked with this Home's schema anyway, no command here can help.
 */
export function readOnlyOf(
  check: SchemaCheck,
  ctx: Pick<M3Context, "adopted" | "entry">,
): ReadOnlyState | null {
  const paths = unknownKeyPaths(check.issues);
  if (paths.length === 0) return null;
  const lead = `This harness uses settings this version of CrewHaus doesn't know: ${paths.join(", ")}. You can read it here but not change it.`;
  if (check.source === "manager" && ctx.adopted !== true) {
    const id = ctx.entry?.id;
    if (id !== undefined) {
      return {
        reason: `${lead} Adopting it into this Home lets its own copy of CrewHaus check these settings.`,
        paths,
        verb: `crewhaus harness adopt ${id}`,
      };
    }
    return {
      reason: `${lead} Adopt it into this Home so its own copy of CrewHaus checks these settings, or edit crewhaus.yaml with the CrewHaus that wrote it.`,
      paths,
      verb: null,
    };
  }
  return {
    reason: `${lead} Edit crewhaus.yaml with the CrewHaus that wrote it, or upgrade CrewHaus.`,
    paths,
    verb: null,
  };
}

export function readOnlyRefusal(state: ReadOnlyState): HttpError {
  return new HttpError(409, state.reason, {
    code: "read-only",
    readOnly: state,
    verb: state.verb,
  });
}

/**
 * Check the spec a write would start from and refuse a read-only one (409
 * `read-only`), before any edit is applied to it. Answers the check, so the
 * caller previews with the same schema ({@link previewHomeEdits}).
 */
export async function requireEditable(
  ctx: Pick<M3Context, "harnessDir" | "adopted" | "entry">,
  yamlText: string,
): Promise<SchemaCheck> {
  const check = await checkSpec(ctx, yamlText, "issues");
  const state = readOnlyOf(check, ctx);
  if (state !== null) throw readOnlyRefusal(state);
  return check;
}

// ---------------------------------------------------------------------------
// the guarded commit every spec write here goes through
// ---------------------------------------------------------------------------

/**
 * The revision a write was computed from: `expectedRev` (or `expectedHash`)
 * from the body, or `?expectedRev=` on a route with no body. A write without
 * one is answered 428.
 */
export function requireExpectedRev(ctx: M3Context): string {
  const raw = ctx.body["expectedRev"] ?? ctx.body["expectedHash"] ?? ctx.query.get("expectedRev");
  if (typeof raw !== "string" || raw === "") {
    throw new HttpError(428, "send the revision you loaded as expectedRev", { verb: null });
  }
  return raw;
}

function nameOf(yamlText: string): string | undefined {
  try {
    const parsed = parseYamlOnly(yamlText) as unknown;
    const name = isPlainObject(parsed) ? parsed["name"] : undefined;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Record a version of `yamlText` in this harness's registry (`.crewhaus/specs`). */
async function registerHomeVersion(
  ctx: M3Context,
  specName: string,
  yamlText: string,
): Promise<{ version: string }> {
  const rootDir = ctx.contain([STATE_DIR, SPECS_SUBDIR]);
  mkdirSync(rootDir, { recursive: true });
  const result = await autoRegisterSpecVersion({
    registry: createFileBackedRegistry({ rootDir }),
    registryRootDir: rootDir,
    specName: nameOf(yamlText) ?? specName,
    yaml: yamlText,
  });
  return { version: result.version };
}

export type HomeCommitOptions = {
  readonly writer: WriterId;
  readonly expectedRev: string;
  /** Run under the optimizer's path restriction. */
  readonly restrict: boolean;
  /** The typed name, when the operator typed one. */
  readonly confirmName?: string | undefined;
};

/** A commit refused for a reason about the WORLD (the 200 typed envelope). */
export type HomeCommitRefusal = { readonly refused: Record<string, unknown> };

/** The permission a spec change on a security surface, or one that can raise spending, needs. */
export const SPEC_SECURITY_PERMISSION = "h.spec.edit.security";

/** Said when a spec change needs the security edit permission the caller does not hold. */
const SECURITY_EDIT_REFUSAL =
  "Only an owner of this harness can change this part of the spec: it touches what the agent may do or what it may spend.";

/**
 * The spec paths in a batch that need the security edit permission: every edit on a
 * security surface, and every path a raise of spending touches. Empty when none does.
 */
export function securityPathsOf(
  target: string,
  before: string,
  edits: readonly SpecEdit[],
): string[] {
  const paths = new Set<string>();
  for (const edit of edits) {
    const row = classifyPath(target, segmentsOf(edit));
    if (row.securitySurface) paths.add(row.path);
  }
  for (const escalation of escalationsFor(before, edits)) {
    if (escalation.needs === SPEC_SECURITY_PERMISSION) {
      for (const path of escalation.paths) paths.add(path);
    }
  }
  // By what the batch changes, not by where each edit points: one edit on a parent block
  // can carry a security surface inside its value.
  let after: string | undefined;
  try {
    after = applySpecEdits(before, edits, { parse: parseYamlOnly }).yaml;
  } catch {
    after = undefined;
  }
  if (after !== undefined) {
    for (const path of securityChangesOf(before, after)) paths.add(path);
  }
  return [...paths];
}

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null;

/** A container's entries, a list's indexes as their own segments. */
function entriesOf(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
}

/**
 * Every place two parsed specs differ that a security surface covers, as dotted paths.
 * Where a value is added, removed or replaced by one of another shape, every path inside
 * it counts, and the place itself (a whole step, node or role is a surface of its own).
 *
 * First consumers: {@link securityPathsOf}, and the in-lock check in
 * {@link commitHomeEdits}.
 */
export function securityChangesBetween(before: unknown, after: unknown): string[] {
  const found = new Set<string>();
  const mark = (path: readonly string[]): void => {
    if (path.length > 0 && surfaceFor(path) !== undefined) found.add(path.join("."));
  };
  const markAll = (value: unknown, path: readonly string[]): void => {
    mark(path);
    if (isContainer(value)) {
      for (const [key, inner] of entriesOf(value)) markAll(inner, [...path, key]);
    }
  };
  const walk = (a: unknown, b: unknown, path: readonly string[]): void => {
    if (isDeepStrictEqual(a, b)) return;
    if (isContainer(a) && isContainer(b) && Array.isArray(a) === Array.isArray(b)) {
      const keys = new Set([...entriesOf(a).map(([k]) => k), ...entriesOf(b).map(([k]) => k)]);
      const at = (value: Record<string, unknown> | unknown[], key: string): unknown =>
        Array.isArray(value) ? value[Number(key)] : value[key];
      for (const key of keys) walk(at(a, key), at(b, key), [...path, key]);
      return;
    }
    markAll(a, path);
    markAll(b, path);
  };
  walk(before, after, []);
  return [...found];
}

/** {@link securityChangesBetween} over two spec texts; empty when either does not parse. */
function securityChangesOf(before: string, after: string): string[] {
  try {
    return securityChangesBetween(parseYamlOnly(before), parseYamlOnly(after));
  } catch {
    return [];
  }
}

/**
 * Refuse a spec change the caller may not make: one that touches a security surface or
 * raises spending needs the security edit permission, whatever name was typed. A 403
 * naming what is missing, before any preview asks for a typed name.
 *
 * First consumers: every spec write this manager makes (the editor, a patch, advice,
 * synthesized edits, the builders' connector writes).
 */
export function requireSpecEditAuthority(
  ctx: Pick<M3Context, "authorize">,
  before: string,
  edits: readonly SpecEdit[],
): void {
  let target = "unknown";
  try {
    target = readSpecHeader(before).target ?? "unknown";
  } catch {
    // An unreadable header still has its security surfaces, which no target changes.
  }
  const paths = securityPathsOf(target, before, edits);
  if (paths.length === 0) return;
  requirePermission(ctx, SPEC_SECURITY_PERMISSION, { paths, message: SECURITY_EDIT_REFUSAL });
}

/**
 * Commit a batch of edits to this harness's spec through the guarded commit.
 *
 * A conflict is answered 412 (`current: {rev, diff, draftId}`), a read-only
 * spec 409 `read-only`, a rename or budget raise without the typed name 409
 * carrying `needs`, an over-cap spec 409. A change that raises spending, by a
 * caller without the security edit permission, is 403, decided inside the lock on
 * the text actually being written. A batch the schema rejects comes back as
 * `{ refused }`, the typed envelope the editor renders beside the field.
 */
export async function commitHomeEdits(
  ctx: M3Context,
  file: SpecFileRead,
  edits: readonly SpecEdit[],
  opts: HomeCommitOptions,
): Promise<CommitSuccess | HomeCommitRefusal> {
  const check = await checkSpec(ctx, file.text, "issues");
  let securityRefusal: { readonly role: unknown; readonly paths: readonly string[] } | undefined;
  /** The check of the text the validator refused, so the answer names who refused it. */
  let refusedBy: SchemaCheck | undefined;
  const committed = await commitSpec(
    { specPath: file.path },
    { kind: "edits", edits, ...(opts.restrict ? { restrictToOptimizable: true } : {}) },
    {
      expectedRev: opts.expectedRev,
      writer: opts.writer,
      actor: { kind: "person", by: ctx.principal },
      confirm: { ...(opts.confirmName !== undefined ? { name: opts.confirmName } : {}) },
      // The harness's own schema decides; this manager's must not refuse a key it does not know.
      ...(check.source === "harness" ? { parse: parseYamlOnly } : {}),
      validate: async (yamlText, { before }) => {
        if (before !== undefined) {
          const state = readOnlyOf(await checkSpec(ctx, before, "issues"), ctx);
          if (state !== null) {
            return { ok: false, code: "read-only", reason: state.reason, paths: state.paths };
          }
          // On the text this commit writes, inside the lock: a change on a security surface
          // or a raise of spending needs the security edit permission, whatever the
          // caller's preview said.
          const needing = [
            ...new Set([
              ...securityChangesOf(before, yamlText),
              ...escalationBetween(before, yamlText)
                .filter((e) => e.needs === SPEC_SECURITY_PERMISSION)
                .flatMap((e) => e.paths),
            ]),
          ];
          if (needing.length > 0) {
            const verdict = ctx.authorize(SPEC_SECURITY_PERMISSION);
            if (!verdict.allow) {
              securityRefusal = { role: verdict.role, paths: needing };
              return {
                ok: false,
                reason: SECURITY_EDIT_REFUSAL,
                paths: securityRefusal.paths,
              };
            }
          }
        }
        if (check.source === "harness") {
          const after = await checkSpec(ctx, yamlText, "issues");
          if (after.issues.length > 0) {
            refusedBy = after;
            return {
              ok: false,
              reason: after.issues.map((i) => i.message).join("; "),
              issues: after.issues,
            };
          }
        }
        return { ok: true };
      },
      register: async (yamlText) => await registerHomeVersion(ctx, file.specName, yamlText),
    },
  );
  if (committed.ok) return committed;
  if (securityRefusal !== undefined) {
    throw new HttpError(403, SECURITY_EDIT_REFUSAL, {
      code: "forbidden",
      reason: "permission",
      needs: SPEC_SECURITY_PERMISSION,
      role: securityRefusal.role,
      paths: [...securityRefusal.paths],
    });
  }
  return await homeCommitFailure(ctx, file, edits, committed, check, opts.restrict, refusedBy);
}

/** The confirmations the change from `before` to `after` would need, by its text. */
function escalationBetween(before: string, after: string): ReturnType<typeof escalationFor> {
  try {
    return escalationFor(parseYamlOnly(before), parseYamlOnly(after));
  } catch {
    return [];
  }
}

/** One issue row, as the editor anchors it to a field. */
export type EditIssueRow = {
  readonly path: string[];
  readonly message: string;
  readonly code: string | null;
};

/** Whether a value a validator handed back is an issue row this module can name. */
function isIssueLike(
  value: unknown,
): value is { path: ReadonlyArray<unknown>; message: string; code?: unknown } {
  return (
    isPlainObject(value) &&
    Array.isArray(value["path"]) &&
    (value["path"] as unknown[]).every((p) => typeof p === "string" || typeof p === "number") &&
    typeof value["message"] === "string"
  );
}

/**
 * The issues that refused a batch, as the rows the editor places beside a field, and the
 * check that found them. In order of preference:
 *
 *   1. the rows the in-lock validator produced (`failureIssues`; only the harness's own
 *      schema fills them), found by `failureCheck` when it is known;
 *   2. the issues of the EDITED text: the batch applied as YAML only, then checked with
 *      the schema {@link checkSpec} picks for this harness (its own only when it runs its
 *      own code here, this Home's otherwise, whose note names `crewhaus harness adopt`);
 *   3. when the batch does not apply even as YAML, the issues of the text before it.
 *
 * Messages are masked: they come from rows {@link checkSpec} built, or are masked here.
 *
 * First consumers: the `invalid` answer of {@link commitHomeEdits}, and {@link specDiff}'s
 * refusal.
 */
export async function editedIssues(
  ctx: Pick<M3Context, "harnessDir" | "adopted" | "entry">,
  before: string,
  edits: readonly SpecEdit[],
  check: SchemaCheck,
  restrict: boolean,
  failureIssues?: ReadonlyArray<unknown>,
  failureCheck?: SchemaCheck,
): Promise<{ issues: EditIssueRow[]; check: SchemaCheck }> {
  const given = (failureIssues ?? []).filter(isIssueLike).map(
    (issue): EditIssueRow => ({
      path: issue.path.map((p) => String(p)),
      message: maskText(issue.message),
      code: typeof issue.code === "string" ? issue.code : null,
    }),
  );
  if (given.length > 0) return { issues: given, check: failureCheck ?? check };
  const applied = previewSpecEdits(before, edits, { parse: parseYamlOnly, restrict });
  if (applied.yaml !== null) {
    const after = await checkSpec(ctx, applied.yaml, "issues");
    return { issues: issueRows(after), check: after };
  }
  return { issues: issueRows(check), check };
}

/** Map a refused commit onto Home's answers. Throws for the request-level ones. */
async function homeCommitFailure(
  ctx: M3Context,
  file: SpecFileRead,
  edits: readonly SpecEdit[],
  failure: CommitFailure,
  check: SchemaCheck,
  restrict: boolean,
  refusedBy?: SchemaCheck,
): Promise<HomeCommitRefusal> {
  switch (failure.code) {
    case "conflict": {
      const now = readSpecFile(ctx);
      const preview = await previewHomeEdits(
        ctx,
        now.text,
        edits,
        await checkSpec(ctx, now.text, "issues"),
        { restrict },
      );
      throw new HttpError(
        412,
        "the spec changed on disk since this editor loaded it — your edit is kept as a draft",
        {
          current: {
            rev: failure.current?.rev ?? now.rev,
            diff: preview.ok ? preview.diff : (preview.error ?? ""),
            draftId: failure.draft?.id ?? null,
          },
        },
      );
    }
    case "read-only":
      throw readOnlyRefusal(
        readOnlyOf(check, ctx) ?? {
          reason: failure.reason,
          paths: failure.paths ?? [],
          verb: null,
        },
      );
    case "needs-confirmation":
      if (failure.needs === SPEC_SECURITY_PERMISSION) {
        const verdict = ctx.authorize(SPEC_SECURITY_PERMISSION);
        if (!verdict.allow) {
          throw new HttpError(403, SECURITY_EDIT_REFUSAL, {
            code: "forbidden",
            reason: "permission",
            needs: SPEC_SECURITY_PERMISSION,
            role: verdict.role,
            paths: failure.paths ?? [],
          });
        }
      }
      throw new HttpError(
        409,
        `${failure.reason} Send "confirmName": "${file.specName}" to apply it.`,
        {
          needs: failure.needs ?? "typed-name",
          warning: failure.reason,
          paths: failure.paths ?? [],
          confirmName: file.specName,
        },
      );
    case "too-large":
      throw new HttpError(409, `${failure.reason}. Edit it with the CLI.`);
    case "invalid": {
      const found = await editedIssues(
        ctx,
        file.text,
        edits,
        check,
        restrict,
        failure.issues,
        refusedBy,
      );
      return {
        refused: refusal("edit_rejected", maskText(failure.reason), {
          specName: file.specName,
          target: file.target,
          issues: found.issues,
          schemaSource: found.check.source,
          schemaNote: found.check.note,
          rev: file.rev,
          hash: file.hash,
          verb: "crewhaus compile crewhaus.yaml -o dist",
        }),
      };
    }
    case "unwritable":
      return { refused: refusal("not_writable", maskText(failure.reason), { rev: file.rev }) };
  }
}

/** The confirmations a batch would need: a rename, a budget raise. Empty when it needs none. */
export function escalationsFor(
  before: string,
  edits: readonly SpecEdit[],
): ReturnType<typeof escalationFor> {
  try {
    const after = applySpecEdits(before, edits, { parse: parseYamlOnly }).yaml;
    return escalationFor(parseYamlOnly(before), parseYamlOnly(after));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// trust tiers
// ---------------------------------------------------------------------------

export type SpecTrustTier = "auto-tunable" | "human-owned";

export type SpecTrustRow = {
  readonly path: string;
  readonly segments: readonly string[];
  readonly tier: SpecTrustTier;
  /** True for the surfaces that additionally demand the interstitial. */
  readonly securitySurface: boolean;
  readonly reason: string;
};

/** `prefix` matches `path` from its root (`"*"` in `prefix` = any one segment). */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return surfaceMatchesFrom(prefix, path, 0);
}

function optimizableFor(target: string): ReadonlyArray<readonly string[]> {
  const table = OPTIMIZABLE_PATHS as Readonly<Record<string, ReadonlyArray<readonly string[]>>>;
  return table[target] ?? [];
}

/** Auto-tunable ⇔ `applySpecEdits(…, { restrictToOptimizable: true })` would
 *  accept it. Delegates to spec-patch's own `isOptimizable` — the ONE matcher
 *  the optimizer runs under (exact match, the wildcard segment, the
 *  structural `model_pool` / `judge` / `sub_agents` / `temperature` rule,
 *  then prefix) — so the badge and the server's refusal can never disagree.
 *  A hand-rolled prefix copy here once said "auto-tunable" for
 *  `steps[0].model_pool.candidates`, which the write then rejected. */
export function isAutoTunable(target: string, path: readonly string[]): boolean {
  if (!(target in OPTIMIZABLE_PATHS)) return false;
  return isOptimizable(target as keyof typeof OPTIMIZABLE_PATHS, path);
}

/**
 * Classify one path for the badge AND for the write gate.
 *
 * `SECURITY_SURFACES` is consulted BEFORE `OPTIMIZABLE_PATHS`, and the order
 * is the whole point: a security surface stays human-owned even when the
 * optimizer may tune it. The two tables answer different questions. The
 * optimizer writes `transaction_policy`, `chains`, `security.justification`
 * and the `agent.model_pool` policy knobs only as the outcome of an eval
 * that scored the change; the console writes them because one operator
 * clicked once. Testing `isAutoTunable` first made those `SECURITY_SURFACES`
 * rows unreachable for exactly the paths they were written to gate — the
 * on-chain value ceiling could be raised, and pre-broadcast simulation
 * switched off, with no interstitial and no typed confirmation at all.
 */
export function classifyPath(target: string, segments: readonly string[]): SpecTrustRow {
  const path = segments.join(".");
  const surface = surfaceFor(segments);
  if (surface !== undefined) {
    return {
      path,
      segments,
      tier: "human-owned",
      securitySurface: true,
      reason: isAutoTunable(target, segments)
        ? `${surface.reason} — the optimizer may tune it against an eval, but a console write takes the typed confirmation`
        : surface.reason,
    };
  }
  if (isAutoTunable(target, segments)) {
    return {
      path,
      segments,
      tier: "auto-tunable",
      securitySurface: false,
      reason: "listed in OPTIMIZABLE_PATHS — the optimizer may write it, so the console may too",
    };
  }
  const holdsTunable =
    segments.length > 0 && optimizableFor(target).some((entry) => isPrefix(segments, entry));
  return {
    path,
    segments,
    tier: "human-owned",
    securitySurface: false,
    reason: holdsTunable
      ? "this block is human-owned; individual fields inside it are auto-tunable"
      : "not listed in OPTIMIZABLE_PATHS — an author owns this field",
  };
}

// ---------------------------------------------------------------------------
// the lenient path scan
// ---------------------------------------------------------------------------

const BLOCK_SCALAR_RE = /^[|>][-+0-9]*\s*(?:#.*)?$/;

/**
 * Every map path a spec's TEXT declares, dotted, in document order.
 *
 * Deliberately a text scan and not a parse: the trust table has to render
 * for a spec one schema version ahead of this manager, and for one that does
 * not validate at all — which is exactly when an operator needs the editor.
 *
 * Two things it does NOT do, both on purpose. Block scalars (`instructions:
 * |`) are skipped wholesale, so prose that reads `Note: something` never
 * becomes a fake path; and sequence ITEMS are represented by their container
 * path rather than by index, because the console addresses list fields whole.
 *
 * Each key line is read by a scan (`keyLineParts`, spec-lines.ts) that
 * answers what `/^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/` did;
 * the pattern was quadratic in a run of spaces on a line holding a U+2028.
 */
export function declaredPaths(yamlText: string): string[][] {
  const out: string[][] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let blockIndent: number | null = null;
  let seqIndent: number | null = null;
  for (const rawLine of yamlText.split("\n")) {
    if (out.length >= MAX_TRUST_ROWS) break;
    const line = rawLine.replace(/\t/g, "  ");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    if (seqIndent !== null) {
      if (indent > seqIndent) continue;
      seqIndent = null;
    }
    if (line.trimStart().startsWith("- ") || line.trim() === "-") {
      // A sequence item and everything under it: the container already has a
      // row, and an index is not a field this editor can address.
      seqIndent = indent;
      continue;
    }
    const parts = keyLineParts(line);
    if (parts === null) continue;
    const [, key, rawValue] = parts;
    const value = (rawValue ?? "").trim();
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }
    stack.push({ indent, key });
    out.push(stack.map((s) => s.key));
    if (BLOCK_SCALAR_RE.test(value)) blockIndent = indent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// effective config — declared vs defaulted
// ---------------------------------------------------------------------------

export type EffectiveRow = {
  readonly path: string;
  /** The same path as segments: a dotted path cannot tell a key holding a `.` (a model id) from two keys. */
  readonly segments: readonly string[];
  readonly value: unknown;
  /** `declared` when the TEXT carries the key; `default` when only the
   *  schema does — the whole point of the viewer. */
  readonly source: "declared" | "default";
};

/**
 * The parsed spec with its zod defaults materialized, each row marked
 * declared or defaulted via `specHasPath`.
 *
 * Echoing raw YAML is the thing this replaces: a spec that never mentions a
 * default-ON block still RUNS it, and an operator reading the file cannot
 * see that. A row whose source is `default` is the answer to "what is this
 * harness actually doing".
 *
 * Credential-carrying paths render `[redacted]`: the value here sits under
 * the key `value`, so the tree masker's key-based layer cannot see it — the
 * redaction has to happen at the point the row is built.
 */
export function effectiveConfig(spec: unknown, yamlText: string): EffectiveRow[] {
  return effectiveConfigOf(spec, yamlText).rows;
}

/**
 * {@link effectiveConfig}'s rows, and whether the walk stopped at
 * `MAX_EFFECTIVE_ROWS` with a setting left over (`truncated`), so a screen
 * can say it shows only the first ones.
 */
export function effectiveConfigOf(
  spec: unknown,
  yamlText: string,
): { rows: EffectiveRow[]; truncated: boolean } {
  const rows: EffectiveRow[] = [];
  let truncated = false;
  const walk = (node: unknown, segments: string[]): void => {
    if (truncated) return;
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...segments, key]);
      return;
    }
    if (segments.length === 0) return;
    if (rows.length >= MAX_EFFECTIVE_ROWS) {
      truncated = true;
      return;
    }
    const redacted = segments.some((seg) => isCredentialKey(seg));
    rows.push({
      path: segments.join("."),
      segments,
      value: redacted ? REDACTED_VALUE : node,
      source: specHasPath(yamlText, segments) ? "declared" : "default",
    });
  };
  walk(spec, []);
  return { rows, truncated };
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

/** Render a structural diff as the text a human reads. `diffSpecYaml` has
 *  already redacted credential values; `maskText` is the second layer for a
 *  token pasted into a field whose name says nothing. */
export function renderDiff(entries: ReadonlyArray<SpecDiffEntry>): string {
  return entries
    .map((entry) => {
      switch (entry.kind) {
        case "added":
          return `+ ${entry.path}: ${entry.after ?? ""}`;
        case "removed":
          return `- ${entry.path}: ${entry.before ?? ""}`;
        case "changed":
          return `~ ${entry.path}: ${entry.before ?? ""} → ${entry.after ?? ""}`;
      }
    })
    .map((line) => maskText(line))
    .join("\n");
}

function diffEntries(before: string, after: string): ReadonlyArray<SpecDiffEntry> {
  if (before === after) return [];
  return diffSpecYaml(before, after);
}

// ---------------------------------------------------------------------------
// edit parsing
// ---------------------------------------------------------------------------

/** One edit as the client sends it: a dotted string or a segment array, plus
 *  a value (absent ⇒ delete the path). */
function parseEdit(raw: unknown, label: string): SpecEdit {
  if (!isPlainObject(raw)) throw new HttpError(400, `${label} must be an object`);
  const rawPath = raw["path"];
  let segments: Array<string | number>;
  if (typeof rawPath === "string") {
    segments = rawPath.split(".").filter((s) => s !== "");
  } else if (Array.isArray(rawPath)) {
    segments = rawPath.map((seg) => {
      if (typeof seg === "string" && seg !== "") return seg;
      if (typeof seg === "number" && Number.isInteger(seg) && seg >= 0) return seg;
      throw new HttpError(400, `${label}: every path segment must be a key or a list index`);
    });
  } else {
    throw new HttpError(400, `${label} needs a "path" (dotted string or segment array)`);
  }
  if (segments.length === 0) throw new HttpError(400, `${label}: "path" is empty`);
  const edit: { path: Array<string | number>; value?: unknown; rationale?: string } = {
    path: segments,
  };
  if ("value" in raw) edit.value = raw["value"];
  const rationale = raw["rationale"];
  if (typeof rationale === "string" && rationale !== "") edit.rationale = rationale;
  return edit as SpecEdit;
}

function parseEdits(body: Readonly<Record<string, unknown>>): SpecEdit[] {
  const raw = body["edits"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, '"edits" must be an array');
  return raw.map((edit, i) => parseEdit(edit, `edit #${i}`));
}

/** Segment array as plain strings — a list index reads as its own segment. */
function segmentsOf(edit: SpecEdit): string[] {
  return edit.path.map((seg) => String(seg));
}

type Split = { readonly auto: SpecTrustRow[]; readonly human: SpecTrustRow[] };

/**
 * Each edit's tier. An edit the optimizer could make that loosens a bar the
 * spec protects (`protectedBarChange` against the current spec, `current`) is
 * the owner's: it moves to human-owned as a security surface, with the bar's
 * reason, so it never applies under the optimizer's restriction.
 */
function splitByTier(target: string, edits: readonly SpecEdit[], current: string): Split {
  const auto: SpecTrustRow[] = [];
  const human: SpecTrustRow[] = [];
  let doc: unknown;
  try {
    doc = parseYamlOnly(current);
  } catch {
    doc = undefined;
  }
  for (const edit of edits) {
    const row = classifyPath(target, segmentsOf(edit));
    if (row.tier === "auto-tunable" && doc !== undefined) {
      const after = withPatchApplied(
        doc,
        edit.path,
        edit.value === undefined ? "remove" : "replace",
        edit.value,
      );
      const loosened = protectedBarChange(doc, after);
      if (loosened !== undefined) {
        human.push({
          ...row,
          tier: "human-owned",
          securitySurface: true,
          reason: `${loosened.reason} — loosening a protected bar is the owner's change`,
        });
        continue;
      }
    }
    (row.tier === "auto-tunable" ? auto : human).push(row);
  }
  return { auto, human };
}

// ---------------------------------------------------------------------------
// the write path shared by specEdit / specPatch
// ---------------------------------------------------------------------------

/** Diff a batch WITHOUT writing it. Never throws: a preview that cannot be
 *  produced is itself the thing the interstitial has to say. Shared with the
 *  builders, whose connector writes are spec edits like any other. */
export type SpecPreview = {
  readonly ok: boolean;
  readonly entries: ReadonlyArray<SpecDiffEntry>;
  readonly diff: string;
  readonly error: string | null;
  /** The edited text, UNMASKED (a write source, never an answer); null when the batch does not apply. */
  readonly yaml: string | null;
  /** Why it failed: the batch does not apply, or the harness's own schema refuses the result. */
  readonly stage?: "apply" | "schema";
};

export function previewSpecEdits(
  before: string,
  edits: readonly SpecEdit[],
  opts: { readonly parse?: (yamlText: string) => Spec; readonly restrict?: boolean } = {},
): SpecPreview {
  if (edits.length === 0) return { ok: true, entries: [], diff: "", error: null, yaml: before };
  try {
    const after = applySpecEdits(before, edits, {
      ...(opts.parse !== undefined ? { parse: opts.parse } : {}),
      ...(opts.restrict === true ? { restrictToOptimizable: true } : {}),
    });
    const entries = diffEntries(before, after.yaml);
    return { ok: true, entries, diff: renderDiff(entries), error: null, yaml: after.yaml };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      diff: "",
      error: maskText(errText(err)),
      yaml: null,
      stage: "apply",
    };
  }
}

/**
 * Preview a batch on this harness's spec with the schema that decides for it,
 * as {@link commitHomeEdits} commits it: where the harness's own schema
 * answered `check`, the batch is parsed as YAML only and the result is checked
 * by that schema in its child; otherwise this manager's schema decides.
 */
export async function previewHomeEdits(
  ctx: Pick<M3Context, "harnessDir" | "adopted" | "entry">,
  before: string,
  edits: readonly SpecEdit[],
  check: SchemaCheck,
  opts: { readonly restrict?: boolean } = {},
): Promise<SpecPreview> {
  if (check.source !== "harness") return previewSpecEdits(before, edits, opts);
  const preview = previewSpecEdits(before, edits, { ...opts, parse: parseYamlOnly });
  if (!preview.ok || preview.yaml === null || edits.length === 0) return preview;
  const after = await checkSpec(ctx, preview.yaml, "issues");
  if (after.issues.length === 0) return preview;
  return {
    ok: false,
    entries: [],
    diff: "",
    error: after.issues.map((i) => i.message).join("; "),
    yaml: null,
    stage: "schema",
  };
}

/**
 * Apply a batch. The trust split happens BEFORE the write:
 *
 *   - all-auto-tunable → applied under `restrictToOptimizable`, the same
 *     restriction the optimizer runs under;
 *   - any human-owned path with no typed confirmation → 409 carrying the
 *     redacted preview the interstitial renders, the name of the route that
 *     turns the same batch into a review PR, and — for a rename or a budget
 *     raise — what it needs and why;
 *   - human-owned WITH the confirmation → applied unrestricted, because the
 *     operator has now said the sentence the machine may not say for them.
 *
 * Every write is one guarded commit ({@link commitHomeEdits}) against the
 * revision the editor loaded, and records a version.
 */
async function applyBatch(
  ctx: M3Context,
  edits: readonly SpecEdit[],
  gated = true,
  writer: WriterId = "home.spec",
): Promise<Record<string, unknown>> {
  const file = readSpecFile(ctx);
  if (!file.present) {
    return refusal("no_spec", `this harness has no ${SPEC_FILE} to edit`, {
      verb: "crewhaus init",
    });
  }
  // Before ANY of the rest: the read this batch would be applied to has to
  // be the whole document.
  requireWholeSpec(file);
  const check = await checkSpec(ctx, file.text, "issues");
  const readOnly = readOnlyOf(check, ctx);
  const { auto, human } = splitByTier(file.target, edits, file.text);

  if (edits.length === 0) {
    // A zero-edit batch is the no-op the editor uses to re-read and rebase.
    // It writes nothing, so it needs no revision.
    return {
      ok: true,
      applied: 0,
      rev: file.rev,
      hash: file.hash,
      specName: file.specName,
      target: file.target,
      tiers: { autoTunable: auto, humanOwned: human },
      entries: [],
      diff: "",
      issues: issueRows(check),
      schemaSource: check.source,
      readOnly,
      note: "nothing to apply — the spec is unchanged",
    };
  }
  if (readOnly !== null) throw readOnlyRefusal(readOnly);
  const expectedRev = requireExpectedRev(ctx);
  // Before the interstitial, and whether or not a name was typed: a change to a security
  // surface, or one that raises spending, is the security edit permission's.
  requireSpecEditAuthority(ctx, file.text, edits);
  const confirmed = ctx.body["confirmName"] !== undefined;
  if (gated && human.length > 0 && !confirmed) {
    // The interstitial's data: what would change, and why it is gated.
    const preview = await previewHomeEdits(ctx, file.text, edits, check);
    const escalations = escalationsFor(file.text, edits);
    const warning = escalations.map((e) => e.reason).join(" ");
    throw new HttpError(
      409,
      `${human.length} of these ${edits.length} edits touch human-owned paths (${human
        .map((row) => row.path)
        .join(
          ", ",
        )}) — send "confirmName": "${file.specName}" to apply them here, or POST the same batch to /spec/propose for review.${
        warning === "" ? "" : ` ${warning}`
      } Preview: ${preview.diff === "" ? "no structural change" : preview.diff}`,
      escalations.length > 0
        ? {
            needs:
              escalations.find((e) => e.needs === "h.spec.edit.security")?.needs ?? "typed-name",
            warning,
            paths: escalations.flatMap((e) => e.paths),
            confirmName: file.specName,
          }
        : undefined,
    );
  }
  if (gated && human.length > 0) requireTypedConfirm(ctx.body, file.specName);

  const committed = await commitHomeEdits(ctx, file, edits, {
    writer,
    expectedRev,
    restrict: human.length === 0,
    confirmName: typeof ctx.body["confirmName"] === "string" ? ctx.body["confirmName"] : undefined,
  });
  if ("refused" in committed) {
    return { ...committed.refused, tiers: { autoTunable: auto, humanOwned: human } };
  }
  const after = await checkSpec(ctx, committed.yaml, "issues");
  return {
    ok: true,
    applied: committed.applied ?? 0,
    wrote: committed.wrote,
    rev: committed.rev,
    hash: committed.rev,
    registered: committed.registered ?? null,
    formatting: committed.formatting,
    specName: file.specName,
    target: file.target,
    tiers: { autoTunable: auto, humanOwned: human },
    entries: committed.entries,
    diff: renderDiff(committed.entries),
    issues: issueRows(after),
    yaml: maskSpecYaml(committed.yaml),
    schemaSource: check.source,
    note:
      committed.note ??
      (committed.wrote
        ? `written and recorded as version ${committed.registered ?? "(none)"}`
        : "the spec already says this — nothing was written"),
  };
}

/**
 * Apply + write a batch whose gate the CALLER has already run.
 *
 * The builders' connector writes are ordinary spec edits on a human-owned
 * block, and they run their own dry-run-then-typed-confirm ladder before
 * calling this. Sharing the write means there is exactly one place in the
 * manager where a spec file is replaced.
 */
export async function commitSpecEdits(
  ctx: M3Context,
  edits: readonly SpecEdit[],
  writer: WriterId = "home.builder",
): Promise<Record<string, unknown>> {
  return await applyBatch(ctx, edits, false, writer);
}

// ---------------------------------------------------------------------------
// version registry (`.crewhaus/specs/<name>/`)
// ---------------------------------------------------------------------------

/**
 * A spec's display name mapped onto the registry's stricter directory
 * grammar — the same deterministic transform the compiler's
 * auto-registration uses, so the manager looks in the directory the CLI
 * actually wrote ("My Agent" → `My-Agent`).
 */
export function registryDirName(specName: string): string {
  const cleaned = specName.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^\.+/, "");
  const name = cleaned.length > 0 ? cleaned : "spec";
  return SAFE_SEGMENT_RE.test(name) ? name : "spec";
}

type Manifest = {
  readonly versions: readonly string[];
  readonly pins: Readonly<Record<string, string>>;
};

function readManifest(ctx: M3Context, dirName: string): Manifest | null {
  const path = ctx.contain([STATE_DIR, SPECS_SUBDIR, dirName, "manifest.json"]);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readTextCapped(path, MAX_TEXT_BYTES).text) as {
      versions?: unknown;
      pins?: unknown;
    };
    const versions = Array.isArray(parsed.versions)
      ? parsed.versions.filter((v): v is string => typeof v === "string" && SAFE_SEGMENT_RE.test(v))
      : [];
    const pins: Record<string, string> = {};
    if (isPlainObject(parsed.pins)) {
      for (const [env, version] of Object.entries(parsed.pins)) {
        if (typeof version === "string") pins[env] = version;
      }
    }
    return { versions: versions.slice(0, MAX_VERSIONS), pins };
  } catch {
    return null;
  }
}

/** One archived version's YAML, contained per file. */
function readVersionYaml(ctx: M3Context, dirName: string, version: string): string | null {
  if (!SAFE_SEGMENT_RE.test(version)) return null;
  const path = ctx.contain([STATE_DIR, SPECS_SUBDIR, dirName, `${version}.yaml`]);
  if (!existsSync(path)) return null;
  return readTextCapped(path, MAX_TEXT_BYTES).text;
}

/** Optimizer provenance from a version's write-back header comment: the
 *  `runId`/`mutator`/score fields the optimizer stamps above the document.
 *
 *  The fields are read by a scan (`namedValues`, spec-lines.ts) that finds
 *  what `/([A-Za-z][A-Za-z0-9_]*)=("[^"]*"|\S+)/g` found: the pattern read a
 *  long word with no `=` from every letter in it, and with the `m` flag a
 *  header can start after a U+2028 inside model-written instructions. */
export function provenanceOf(yamlText: string): Record<string, unknown> | null {
  const header = yamlText.match(/^#\s*crewhaus:optimize\s+(.*)$/m)?.[1];
  if (header === undefined) return null;
  const fields: Record<string, unknown> = {};
  for (const [key, quoted] of namedValues(header)) {
    const raw = quoted.replace(/^"|"$/g, "");
    const num = Number(raw);
    fields[key] = raw !== "" && !Number.isNaN(num) ? num : raw;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/** Per-tenant pin overlays (`_tenants/<id>/<name>.json`). */
function readTenantOverlays(ctx: M3Context, dirName: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const root = ctx.contain([STATE_DIR, SPECS_SUBDIR, "_tenants"]);
  if (!existsSync(root)) return out;
  let tenants: string[];
  try {
    tenants = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const tenant of tenants) {
    if (!SAFE_SEGMENT_RE.test(tenant)) continue;
    // Per FILE: a listed tenant dir entry can be a symlink out of the tree.
    const file = ctx.contain([STATE_DIR, SPECS_SUBDIR, "_tenants", tenant, `${dirName}.json`]);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readTextCapped(file, MAX_TEXT_BYTES).text) as unknown;
      out.push({ tenant, pins: isPlainObject(parsed) ? parsed : {}, unreadable: false });
    } catch {
      out.push({ tenant, pins: {}, unreadable: true });
    }
  }
  return out;
}

function changelogText(ctx: M3Context, dirName: string): string | null {
  const path = ctx.contain([STATE_DIR, SPECS_SUBDIR, dirName, "CHANGELOG.md"]);
  if (!existsSync(path)) return null;
  // A changelog quotes spec values verbatim — mask it like any other prose.
  return maskText(readTextCapped(path, MAX_TEXT_BYTES).text);
}

const VERSIONS_VERB = "crewhaus spec put <name> <version> crewhaus.yaml";

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

/**
 * `PUT /api/h/:id/spec` — apply a BATCH of spec edits.
 *
 * Body: `{ edits: SpecEdit[], expectedRev, confirmName? }` (`expectedHash`
 * is the same field's earlier name). Answers the re-validated diagnostics,
 * the new revision and the recorded version, so the editor rebases.
 */
export const specEdit: M3Handler = async (ctx) => await applyBatch(ctx, parseEdits(ctx.body));

/**
 * `POST /api/h/:id/spec/patch` — apply ONE `SpecPatch`.
 *
 * The single-edit twin of {@link specEdit} (the form editor's per-field
 * save). Same restriction, same refusal, same re-validation.
 */
export const specPatch: M3Handler = async (ctx) => {
  const raw = ctx.body["edit"] ?? ctx.body["patch"];
  if (raw === undefined) throw new HttpError(400, 'missing "edit"');
  return await applyBatch(ctx, [parseEdit(raw, '"edit"')]);
};

/**
 * `POST /api/h/:id/spec/diff` — PREVIEW a batch without writing it.
 *
 * The interstitial's data source: `diffSpecYaml(before, after)`, masked. A
 * preview must never touch the file — this is the one write-shaped route
 * that is a pure function of its inputs.
 */
export const specDiff: M3Handler = async (ctx) => {
  const edits = parseEdits(ctx.body);
  const file = readSpecFile(ctx);
  const check = await checkSpec(ctx, file.text, "issues");
  const readOnly = readOnlyOf(check, ctx);
  const { auto, human } = splitByTier(file.target, edits, file.text);
  const preview = await previewHomeEdits(ctx, file.text, edits, check);
  const escalations = escalationsFor(file.text, edits);
  // A refused preview names the edited text's issues, so the editor can put each beside its field.
  const refused = preview.ok ? null : await editedIssues(ctx, file.text, edits, check, false);
  return {
    ok: preview.ok,
    ...(refused === null
      ? {}
      : {
          code: "edit_rejected",
          reason: preview.error,
          schemaSource: refused.check.source,
          schemaNote: refused.check.note,
        }),
    specName: file.specName,
    target: file.target,
    rev: file.rev,
    hash: file.hash,
    readOnly,
    /** A rename or a budget raise: what it needs, and the sentence the confirmation shows. */
    escalations: escalations.map((e) => ({ needs: e.needs, warning: e.reason, paths: e.paths })),
    /** A preview of a spec read past the cap is a preview of its HEAD; the
     *  write path refuses that batch, so the flag says why in advance. */
    truncated: file.truncated,
    entries: preview.entries,
    diff: preview.diff,
    tiers: { autoTunable: auto, humanOwned: human },
    /** True when this batch may be applied straight from the editor. */
    autoApplicable: human.length === 0 && !file.truncated && readOnly === null,
    confirmName: human.length > 0 ? file.specName : null,
    proposeRoute: human.length > 0 ? "specPropose" : null,
    issues: refused === null ? issueRows(check) : refused.issues,
  };
};

/**
 * Narrow a whole-union JSON Schema down to one target's shape.
 *
 * Serving the target's definition ALONE would break it: its internal
 * `$ref`s are document-absolute (`#/definitions/cli/properties/name`), so
 * lifting the definition out of the document leaves every one of them
 * dangling. The narrowed document therefore keeps the `definitions`
 * namespace and points at the target with a root `$ref`, carrying along any
 * sibling definition the target actually references.
 */
export function narrowSchema(
  whole: Record<string, unknown>,
  target: string,
): { schema: Record<string, unknown>; narrowed: boolean } {
  const definitions = whole["definitions"];
  if (!isPlainObject(definitions) || !isPlainObject(definitions[target])) {
    return { schema: whole, narrowed: false };
  }
  const kept: Record<string, unknown> = {};
  const queue: string[] = [target];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (name in kept) continue;
    const definition = definitions[name];
    if (!isPlainObject(definition)) continue;
    kept[name] = definition;
    for (const m of JSON.stringify(definition).matchAll(/#\/definitions\/([A-Za-z0-9_-]+)/g)) {
      const referenced = m[1] as string;
      if (!(referenced in kept)) queue.push(referenced);
    }
  }
  return { schema: { $ref: `#/definitions/${target}`, definitions: kept }, narrowed: true };
}

/** What a schema read needs of a request: the harness, its directory, whether it runs its own code here, and containment. */
export type SpecView = Pick<M3Context, "entry" | "harnessDir" | "adopted" | "contain">;

/**
 * The schema the structured editor renders, plus the effective configuration.
 *
 * The schema is the one {@link checkSpec} checks this harness with: its own
 * `@crewhaus/spec` when it runs its own code here, this Home's otherwise, so a
 * mixed-version fleet renders each harness against the schema that decides for
 * it; `schemaSource` says which copy answered and `schemaNote` why. `effective`
 * is the parsed spec with zod defaults materialized, each row marked declared
 * or defaulted and carrying its `segments`; `effectiveTruncated` says the rows
 * stopped at the cap. Echoing raw YAML would hide every default-ON block.
 *
 * First consumers: `GET /api/h/:id/spec/schema` and the versioned API's
 * `specs.schema`, which answer the same body.
 */
export async function specSchemaView(view: SpecView): Promise<Record<string, unknown>> {
  const file = readSpecFile(view);
  const check = await checkSpec(view, file.text, "schema");
  if (!file.present) {
    return {
      ...base(false, `no ${SPEC_FILE} in this harness`, "crewhaus init"),
      specName: file.specName,
      target: null,
      schema: null,
      schemaSource: check.source,
      schemaVersion: check.version,
      schemaNote: check.note,
      effective: [],
      effectiveTruncated: false,
      effectiveNote: null,
      declaredCount: 0,
      defaultedCount: 0,
      issues: [],
      warnings: [],
      warningsVerb: "crewhaus compile crewhaus.yaml -o dist",
      rev: file.rev,
      hash: file.hash,
      readOnly: null,
      truncated: false,
    };
  }
  let schema: Record<string, unknown> | null = null;
  let schemaNote: string | null = check.note;
  try {
    const narrowed = narrowSchema(check.schema ?? {}, file.target);
    schema = narrowed.schema;
    if (!narrowed.narrowed) {
      schemaNote =
        schemaNote ??
        `this schema has no definition for target "${file.target}" — showing the whole spec union`;
    }
  } catch (err) {
    schemaNote = maskText(errText(err));
  }

  let effective: EffectiveRow[] = [];
  let effectiveTruncated = false;
  let effectiveNote: string | null = null;
  if (check.parsed !== undefined) {
    const walked = effectiveConfigOf(check.parsed, file.text);
    effective = walked.rows;
    effectiveTruncated = walked.truncated;
  } else {
    effectiveNote = `defaults cannot be materialized until the spec validates: ${maskText(
      check.parseError ?? "the spec does not validate",
    )}`;
  }
  const declaredCount = effective.filter((row) => row.source === "declared").length;
  return {
    ...base(true, schemaNote, "crewhaus init"),
    specName: file.specName,
    target: file.target,
    schema,
    schemaSource: check.source,
    schemaVersion: check.version,
    schemaNote,
    effective,
    effectiveTruncated,
    effectiveNote,
    declaredCount,
    defaultedCount: effective.length - declaredCount,
    issues: issueRows(check),
    /** Compile warnings (accepted-but-unwired keys) come from the compiler,
     *  which this server does not run: naming the verb is the honest answer
     *  until the manager can read a compile report. */
    warnings: [],
    warningsVerb: "crewhaus compile crewhaus.yaml -o dist",
    /** The revision every write sends back as `expectedRev`. */
    rev: file.rev,
    hash: file.hash,
    /** Set when the spec carries settings the schema in use does not know: no write is taken. */
    readOnly: readOnlyOf(check, view),
    /** This VIEW may show the head of an over-cap spec; the write path
     *  refuses it. The flag is what stops the two reading as the same file. */
    truncated: file.truncated,
  };
}

/**
 * `GET /api/h/:id/spec/schema` — {@link specSchemaView} for this harness.
 */
export const specSchema: M3Handler = async (ctx) => await specSchemaView(ctx);

/**
 * `GET /api/h/:id/spec/trust` — the trust-tier map for this spec.
 *
 * Every path the spec TEXT declares, marked auto-tunable (in
 * `OPTIMIZABLE_PATHS`) or human-owned, with the reason. The editor badges
 * fields from this; the server enforces the same table on write, so the two
 * can never disagree.
 */
export const specTrust: M3Handler = async (ctx) => {
  const file = readSpecFile(ctx);
  if (!file.present) {
    return {
      ...base(false, `no ${SPEC_FILE} in this harness`, "crewhaus init"),
      specName: file.specName,
      target: null,
      paths: [],
      autoTunableCount: 0,
      humanOwnedCount: 0,
      securitySurfaceCount: 0,
      confirmName: file.specName,
      rev: file.rev,
      readOnly: null,
      truncated: false,
    };
  }
  const readOnly = readOnlyOf(await checkSpec(ctx, file.text, "issues"), ctx);
  const paths = declaredPaths(file.text).map((segments) => classifyPath(file.target, segments));
  const auto = paths.filter((row) => row.tier === "auto-tunable").length;
  return {
    ...base(
      paths.length > 0,
      paths.length === 0 ? "this spec declares no editable fields" : null,
      "crewhaus init",
    ),
    specName: file.specName,
    target: file.target,
    paths,
    autoTunableCount: auto,
    humanOwnedCount: paths.length - auto,
    securitySurfaceCount: paths.filter((row) => row.securitySurface).length,
    confirmName: file.specName,
    rev: file.rev,
    readOnly,
    /** True ⇒ these are the paths of the spec's HEAD only, and no edit from
     *  this table will be applied. */
    truncated: file.truncated,
  };
};

/**
 * `GET /api/h/:id/spec/versions` — the version history.
 *
 * Source: `.crewhaus/specs/<name>/manifest.json` (versions, env pins,
 * `_tenants/` overlays) plus the rendered CHANGELOG. Optimizer-authored
 * versions carry their write-back provenance (score before → after) as a
 * badge. Diffs are credential-redacted.
 */
export const specVersions: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const dirName = registryDirName(file.specName);
  const manifest = readManifest(ctx, dirName);
  const changelog = changelogText(ctx, dirName);
  const versions = (manifest?.versions ?? []).map((version) => {
    const yamlText = readVersionYaml(ctx, dirName, version);
    const pinnedEnvs = Object.entries(manifest?.pins ?? {})
      .filter(([, pinned]) => pinned === version)
      .map(([env]) => env)
      .sort();
    return {
      version,
      present: yamlText !== null,
      bytes: yamlText === null ? 0 : yamlText.length,
      pinnedEnvs,
      isCurrent: yamlText !== null && yamlText === file.text,
      provenance: yamlText === null ? null : provenanceOf(yamlText),
    };
  });
  const present = manifest !== null || changelog !== null;
  return {
    ...base(
      present,
      present
        ? null
        : "this harness has no spec version registry yet — compiling registers the first version",
      VERSIONS_VERB,
    ),
    specName: file.specName,
    registryName: dirName,
    dir: `${STATE_DIR}/${SPECS_SUBDIR}/${dirName}`,
    versions,
    pins: manifest?.pins ?? {},
    tenants: readTenantOverlays(ctx, dirName),
    changelog,
    current: { hash: file.hash, bytes: file.text.length, present: file.present },
    confirmName: file.specName,
  };
};

/**
 * `GET /api/h/:id/spec/versions/:version` — one archived version's YAML.
 *
 * Masked with `maskSpecYaml`, never the raw file: an old version is exactly
 * where a credential that has since been cleaned out still lives.
 */
export const specVersion: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const version = ctx.params["version"] as string;
  const dirName = registryDirName(file.specName);
  const yamlText = readVersionYaml(ctx, dirName, version);
  if (yamlText === null) {
    return {
      ...base(
        false,
        `no version "${version}" under ${STATE_DIR}/${SPECS_SUBDIR}/${dirName}`,
        VERSIONS_VERB,
      ),
      version,
      specName: file.specName,
      yaml: null,
      bytes: 0,
      provenance: null,
      isCurrent: false,
    };
  }
  return {
    ...base(true, null, VERSIONS_VERB),
    version,
    specName: file.specName,
    yaml: maskSpecYaml(yamlText),
    bytes: yamlText.length,
    provenance: provenanceOf(yamlText),
    isCurrent: yamlText === file.text,
  };
};

/**
 * `GET /api/h/:id/spec/versions/:version/diff` — that version vs the live
 * spec (or vs `?against=<version>`), through `diffSpecYaml`, masked.
 */
export const specVersionDiff: M3Handler = (ctx) => {
  const file = readSpecFile(ctx);
  const version = ctx.params["version"] as string;
  const dirName = registryDirName(file.specName);
  const left = readVersionYaml(ctx, dirName, version);
  const againstParam = ctx.query.get("against");
  const against = againstParam !== null && againstParam !== "" ? againstParam : "live";
  const right = against === "live" ? file.text : readVersionYaml(ctx, dirName, against);
  if (left === null || right === null || (against === "live" && !file.present)) {
    const missing = left === null ? version : against;
    return {
      ...base(false, `no version "${missing}" to diff against`, VERSIONS_VERB),
      version,
      against,
      entries: [],
      diff: "",
    };
  }
  let entries: ReadonlyArray<SpecDiffEntry> = [];
  let note: string | null = null;
  try {
    entries = diffEntries(left, right);
  } catch (err) {
    note = maskText(errText(err));
  }
  return {
    ...base(
      true,
      note ?? (entries.length === 0 ? "no structural difference" : null),
      VERSIONS_VERB,
    ),
    version,
    against,
    entries,
    diff: renderDiff(entries),
  };
};

// ---------------------------------------------------------------------------
// pins, rollback, propose — all through CLI verbs, never the manifest
// ---------------------------------------------------------------------------

/** `--actor` only when the operator identity is argv-safe; the flag is a
 *  courtesy on the audit record, never worth mangling a command line for. */
function actorFlags(operator: string): string[] {
  try {
    return ["--actor", jobArg("actor", operator)];
  } catch {
    return [];
  }
}

/**
 * The re-pin command line. `deploy rollback <name> <env> <version>` IS the
 * verb that re-pins an environment to a version, and it is the one carrying
 * the protected-env approval gate and the audit record — so both the pin and
 * the rollback route shell it. The manager never writes `manifest.json`.
 */
function pinArgv(specName: string, env: string, version: string, operator: string): string[] {
  return [
    "deploy",
    "rollback",
    jobArg("name", specName),
    jobArg("env", env),
    jobArg("version", version),
    "--require-approval",
    ...actorFlags(operator),
  ];
}

/** `deploy promote <name> <fromEnv> <toEnv>` — copy an env pin forward. */
function promoteArgv(specName: string, from: string, to: string, operator: string): string[] {
  return [
    "deploy",
    "promote",
    jobArg("name", specName),
    jobArg("from", from),
    jobArg("to", to),
    "--require-approval",
    ...actorFlags(operator),
  ];
}

const GATE_NOTE =
  "a protected environment refuses the flip until its approval quorum is met; the decision is audit-logged either way";

type PinRequest = {
  readonly file: SpecFileRead;
  readonly env: string;
  readonly version: string;
  readonly manifest: Manifest | null;
};

function readPinRequest(ctx: M3Context): PinRequest {
  const file = readSpecFile(ctx);
  requireTypedConfirm(ctx.body, file.specName);
  const env = ctx.body["env"];
  const version = ctx.body["version"];
  if (typeof env !== "string" || env === "") throw new HttpError(400, 'missing "env"');
  if (typeof version !== "string" || version === "") throw new HttpError(400, 'missing "version"');
  return {
    file,
    env: jobArg("env", env),
    version: jobArg("version", version),
    manifest: readManifest(ctx, registryDirName(file.specName)),
  };
}

/** The refusal a pin that names an unknown version earns — a first-class
 *  state, and the versions that DO exist are the useful half of it. */
function unknownVersion(req: PinRequest, dirName: string): Record<string, unknown> | null {
  const known = req.manifest?.versions ?? [];
  if (known.includes(req.version)) return null;
  return refusal(
    "unknown_version",
    `${req.file.specName} has no version "${req.version}" in ${STATE_DIR}/${SPECS_SUBDIR}/${dirName}`,
    { known, pins: req.manifest?.pins ?? {}, verb: VERSIONS_VERB },
  );
}

/**
 * `POST /api/h/:id/spec/pin` — pin/promote a version to an environment.
 *
 * Shells the `deploy` verbs rather than writing the manifest directly, so
 * the audit record and the quorum rule are preserved. Body:
 * `{ env, version, from?, confirmName }` — a pin move is typed-confirm.
 * With `from`, the move is an env → env promotion instead of a version pin.
 */
export const specPin: M3Handler = (ctx) => {
  const req = readPinRequest(ctx);
  const dirName = registryDirName(req.file.specName);
  const from = ctx.body["from"];
  if (typeof from === "string" && from !== "") {
    const source = jobArg("from", from);
    const current = req.manifest?.pins[source];
    if (current === undefined) {
      return refusal("unpinned_source", `nothing is pinned to "${source}" to promote from`, {
        pins: req.manifest?.pins ?? {},
        verb: VERSIONS_VERB,
      });
    }
    return {
      ok: true,
      action: "promote",
      from: source,
      // `envName`, not `env`: the outbound tree masker redacts everything
      // under a key named `env`, and a pin that reports "[redacted]" as the
      // environment it moved would be worse than reporting nothing.
      envName: req.env,
      version: current,
      job: ctx.submitJob(
        "spec-promote",
        promoteArgv(req.file.specName, source, req.env, ctx.operator),
      ),
      verb: "crewhaus deploy promote",
      note: GATE_NOTE,
    };
  }
  const unknown = unknownVersion(req, dirName);
  if (unknown !== null) return unknown;
  return {
    ok: true,
    action: "pin",
    envName: req.env,
    version: req.version,
    replaces: req.manifest?.pins[req.env] ?? null,
    job: ctx.submitJob("spec-pin", pinArgv(req.file.specName, req.env, req.version, ctx.operator)),
    verb: "crewhaus deploy rollback",
    note: GATE_NOTE,
  };
};

/**
 * `POST /api/h/:id/spec/rollback` — roll an environment back to a version.
 *
 * Same verb family as {@link specPin} and the same gate. The refusal an
 * active pin produces is a first-class state, not an error toast.
 */
export const specRollback: M3Handler = (ctx) => {
  const req = readPinRequest(ctx);
  const dirName = registryDirName(req.file.specName);
  const unknown = unknownVersion(req, dirName);
  if (unknown !== null) return unknown;
  const current = req.manifest?.pins[req.env] ?? null;
  if (current === req.version) {
    return refusal("already_pinned", `"${req.env}" is already pinned to ${req.version}`, {
      pins: req.manifest?.pins ?? {},
    });
  }
  return {
    ok: true,
    action: "rollback",
    envName: req.env,
    version: req.version,
    replaces: current,
    job: ctx.submitJob(
      "spec-rollback",
      pinArgv(req.file.specName, req.env, req.version, ctx.operator),
    ),
    verb: "crewhaus deploy rollback",
    note: GATE_NOTE,
  };
};

/** Where a proposal's candidate spec is staged — beside the review bundle
 *  the `propose` verb writes, and nowhere else in the harness. */
const PROPOSAL_SUBDIR = "proposals";
const PROPOSAL_FILE = "proposed.yaml";
/** The ONE argv shape this module ever hands the CLI for a proposal. The
 *  directory is derived from the injected clock, never from the body. */
const PROPOSAL_PATH_RE = /^\.crewhaus\/proposals\/hangar-[0-9]{1,20}\/proposed\.yaml$/;

/**
 * `POST /api/h/:id/spec/propose` — the review path for human-owned edits.
 *
 * Runs `crewhaus propose` through the job queue: a git-tracked harness gets
 * a review branch/PR instead of a direct write. This is where every refusal
 * from {@link specEdit} is meant to land, so the refusal names it.
 *
 * `dryRun` defaults TRUE — an omitted flag never opens a PR.
 */
export const specPropose: M3Handler = async (ctx) => {
  const edits = parseEdits(ctx.body);
  const file = readSpecFile(ctx);
  if (!file.present) {
    return refusal("no_spec", `this harness has no ${SPEC_FILE} to propose against`, {
      verb: "crewhaus init",
    });
  }
  // A proposal STAGES a candidate document — `applySpecEdits(file.text, …)`
  // — so a capped read would put a mutilated spec into the review bundle and
  // ask a human to approve it. Same refusal as a direct write.
  requireWholeSpec(file);
  const check = await requireEditable(ctx, file.text);
  const preview = await previewHomeEdits(ctx, file.text, edits, check);
  if (!preview.ok || preview.yaml === null) {
    return refusal("edit_rejected", preview.error ?? "the batch does not apply", {
      issues: issueRows(check),
      verb: "crewhaus compile crewhaus.yaml -o dist",
    });
  }
  if (preview.entries.length === 0) {
    return refusal("no_change", "this batch changes nothing — there is nothing to review", {
      specName: file.specName,
      verb: "crewhaus propose",
    });
  }
  const { auto, human } = splitByTier(file.target, edits, file.text);
  const proposed = preview.yaml;
  const stamp = String(ctx.now());
  const rel = `${STATE_DIR}/${PROPOSAL_SUBDIR}/hangar-${stamp}/${PROPOSAL_FILE}`;
  if (!PROPOSAL_PATH_RE.test(rel)) {
    throw new HttpError(500, "refusing to stage a proposal outside the proposals directory");
  }
  // Its job is checked before the proposal is staged, so a refused job leaves nothing.
  ctx.checkJob();
  const dir = ctx.contain([STATE_DIR, PROPOSAL_SUBDIR, `hangar-${stamp}`]);
  mkdirSync(dir, { recursive: true });
  const target = ctx.contain([STATE_DIR, PROPOSAL_SUBDIR, `hangar-${stamp}`, PROPOSAL_FILE]);
  writeFileSync(target, proposed, { mode: 0o644 });
  const dryRun = ctx.body["dryRun"] !== false;
  const title = ctx.body["title"];
  return {
    ok: true,
    dryRun,
    staged: rel,
    specName: file.specName,
    title: typeof title === "string" ? maskText(title) : null,
    tiers: { autoTunable: auto, humanOwned: human },
    entries: preview.entries,
    diff: preview.diff,
    job: ctx.submitJob("spec-propose", [
      "propose",
      rel,
      "--current",
      SPEC_FILE,
      "--source",
      "manual",
      ...(dryRun ? ["--dry-run"] : []),
    ]),
    verb: "crewhaus propose",
    note: dryRun
      ? 'dry run: the review bundle is assembled and printed, and no branch or PR is opened. Send "dryRun": false to open one.'
      : "the proposal opens a review PR and never auto-merges — the human gate is the PR itself",
  };
};

/**
 * One kept edit as a view: its path, and its value redacted when any segment
 * of the path names a credential (an edit's own keys are only `path` and
 * `value`, so a key-name masker never sees the setting it writes).
 */
function maskDraftEdit(raw: unknown): unknown {
  if (!isPlainObject(raw)) return maskDeep(raw);
  const path = Array.isArray(raw["path"]) ? (raw["path"] as unknown[]) : [];
  const underCredential = path.some((seg) => typeof seg === "string" && isCredentialKey(seg));
  const out: Record<string, unknown> = { path: path.map((seg) => maskDeep(seg)) };
  if ("value" in raw) out["value"] = underCredential ? REDACTED_VALUE : maskDeep(raw["value"]);
  if (typeof raw["rationale"] === "string") out["rationale"] = maskText(raw["rationale"]);
  return out;
}

/**
 * `GET /api/h/:id/spec/drafts/:draft` — a draft kept when a write found the
 * spec changed on disk.
 *
 * Answers the draft (masked: a text draft as spec YAML, an edit draft as a
 * tree) and the diff it would make on top of the spec as it is now. An id
 * that is not a draft id, or names no draft, is a 404.
 */
export const specDraft: M3Handler = async (ctx) => {
  const id = ctx.params["draft"] ?? "";
  if (!DRAFT_ID_RE.test(id)) throw new HttpError(404, "no such draft");
  try {
    // Per file, through the dispatcher's closure: a draft is read only from inside the harness.
    ctx.contain([STATE_DIR, "run", "spec", "drafts", `${id}.json`]);
  } catch {
    throw new HttpError(404, "no such draft");
  }
  const file = readSpecFile(ctx);
  const draft = readSpecDraft(file.path, id);
  if (draft === undefined) throw new HttpError(404, "no such draft");
  let diff = "";
  let yaml: string | null = null;
  let edits: unknown = null;
  if (typeof draft.text === "string") {
    yaml = maskSpecYaml(draft.text);
    try {
      diff = renderDiff(diffEntries(file.text, draft.text));
    } catch (err) {
      diff = maskText(errText(err));
    }
  } else if (Array.isArray(draft.edits)) {
    edits = draft.edits.map(maskDraftEdit);
    const preview = await previewHomeEdits(
      ctx,
      file.text,
      draft.edits,
      await checkSpec(ctx, file.text, "issues"),
    );
    diff = preview.ok ? preview.diff : (preview.error ?? "");
  }
  return {
    ...base(true, null, null),
    draftId: id,
    at: typeof draft.at === "string" ? draft.at : null,
    writer: typeof draft.writer === "string" ? draft.writer : null,
    baseRev: typeof draft.baseRev === "string" ? draft.baseRev : null,
    currentRev: file.rev,
    yaml,
    edits,
    diff,
  };
};
