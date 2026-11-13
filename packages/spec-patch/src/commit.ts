/**
 * `@crewhaus/spec-patch/commit` — the one way a spec file is written.
 *
 * Every writer (Home's spec routes, the CLI's write-backs, the optimizer, the
 * `SpecPatchApply` tool, service setup) hands its change to
 * {@link commitSpec} together with the revision of the text it computed the
 * change from. The helper:
 *
 *   1. reads the spec whole (never past {@link MAX_SPEC_BYTES}) and computes
 *      the change from it — edits through `applySpecEdits` with the
 *      minimal-diff renderer, or text the writer rendered itself — and runs
 *      the writer's own validation, and nothing more;
 *   2. takes the per-spec lock (`<spec dir>/.crewhaus/run/spec/lock`), reads
 *      the file again, and compares its revision with `expectedRev`. A
 *      mismatch writes nothing: the change is kept as a draft and the answer
 *      is `conflict`, with the current revision and the draft's id;
 *   3. writes atomically beside the file (a random temp, renamed into place),
 *      keeping the file's mode, and where a spec path is a link, writing where
 *      the link leads. A result identical to the file writes nothing;
 *   4. registers a version when the writer asks to, appends one content-free
 *      line to the commit log, and releases the lock;
 *   5. tells every post-commit hook what changed.
 *
 * The revision is `specRevision` from `@crewhaus/ir/policy`, the same one a
 * deployment record carries: line endings normalized, one trailing newline
 * ignored.
 *
 * Everything this module keeps lives under `.crewhaus/run/spec/` beside the
 * spec — `lock`, `commits.jsonl` and `drafts/` — written only by this helper,
 * and on the runtime-state floor for a run in the spec's own directory (and
 * for `crewhaus run` or `crewhaus runs resume` of that spec from elsewhere).
 * Each of those directories is a plain directory (never a link) whose real
 * path lies inside the spec's real directory; when one is not, nothing is
 * written there or read from there, and the commit answers `unwritable`.
 */
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { withFileLock } from "@crewhaus/infra-utils";
import { specRevision } from "@crewhaus/ir/policy";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { writeFileSafe } from "@crewhaus/tool-safety/fs";
import { parseDocument } from "yaml";
import { type SpecDiffEntry, type SpecEdit, applySpecEdits, diffSpecYaml } from "./index";
import { type SpecEscalation, escalationFor } from "./surfaces";

export { changedSurfaces, surfaceDigests, surfaceKey } from "./surface-digests";

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** Who writes. A closed list: a new writer adds its id here. */
export const WRITER_IDS = Object.freeze([
  "home.spec",
  "home.advice",
  "home.watchme",
  "home.builder",
  "home.wizard",
  "cli.lint",
  "cli.optimize",
  "cli.flywheel",
  "cli.model-scan",
  "cli.right-size",
  "cli.upgrade",
  "cli.doctor",
  "cli.init",
  "optimizer",
  "tool.SpecPatchApply",
  "tool.DoctorFix",
  "service-setup",
] as const);

export type WriterId = (typeof WRITER_IDS)[number];

/**
 * On whose behalf. `by` is a principal id (`prn_…`) and nothing else: a raw
 * user or host name never reaches the commit log, and one that is not a
 * principal id is left out.
 */
export type ActorRef = {
  readonly kind: "person" | "agent" | "process";
  readonly by?: string;
};

export type SpecChange =
  | {
      readonly kind: "edits";
      readonly edits: ReadonlyArray<SpecEdit>;
      readonly restrictToOptimizable?: boolean;
    }
  /** A writer that renders its own text (a CST edit, a template, a migration). */
  | { readonly kind: "text"; readonly text: string };

/** The answer of a writer's own validation. */
export type ValidateVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `read-only`: this spec may not be written here at all. Default `invalid`. */
      readonly code?: "invalid" | "read-only";
      readonly reason: string;
      readonly issues?: ReadonlyArray<unknown>;
      readonly paths?: ReadonlyArray<string>;
    };

export type CommitOptions = {
  /** The revision of the text the change was computed from; `"absent"` when the file must not exist. */
  readonly expectedRev: string;
  readonly writer: WriterId;
  readonly actor: ActorRef;
  /** The schema parse, in place of `parseSpec` (see {@link parseYamlOnly}). */
  readonly parse?: (yamlText: string) => Spec;
  /** Further validation of the text about to be written; `before` is the file as read. */
  readonly validate?: (
    yamlText: string,
    context: { readonly before: string | undefined },
  ) => Promise<ValidateVerdict>;
  /** Record a version of the written text. Runs inside the lock after the write; its failure never fails the commit. */
  readonly register?: (yamlText: string) => Promise<{ version: string } | undefined>;
  /**
   * A writer that asks a person passes this. A rename or a budget raise then
   * needs `name` to be the spec's current name, or the answer is
   * `needs-confirmation`. A writer without it is never asked.
   */
  readonly confirm?: { readonly name?: string };
  /** Clock for the log, drafts and pruning. */
  readonly now?: () => Date;
  /** Where a failed post-commit hook or registration is reported. Default: stderr. */
  readonly onWarn?: (message: string) => void;
  /** Test seam: runs after the change is computed and before the lock is taken. */
  readonly hooks?: { readonly afterRead?: () => Promise<void> | void };
};

export type CommitFormatting = "kept" | "restyled" | "as-given";

export type CommitSuccess = {
  readonly ok: true;
  /** The revision on disk after the commit. */
  readonly rev: string;
  /** The revision the commit replaced. */
  readonly fromRev: string;
  readonly entries: ReadonlyArray<SpecDiffEntry>;
  readonly formatting: CommitFormatting;
  /** The version registered for this commit, when one was. */
  readonly registered?: string;
  /** False when the result was byte-identical to the file, so nothing was written. */
  readonly wrote: boolean;
  /** For an edits change: how many edits changed the document. */
  readonly applied?: number;
  /** The written text. */
  readonly yaml: string;
  /** A degradation worth showing (registration failed, …). */
  readonly note?: string;
};

export type CommitFailureCode =
  | "conflict"
  | "invalid"
  | "read-only"
  | "needs-confirmation"
  | "too-large"
  | "unwritable";

export type CommitFailure = {
  readonly ok: false;
  readonly code: CommitFailureCode;
  readonly reason: string;
  /** The revision on disk, on a conflict. */
  readonly current?: { readonly rev: string };
  /** The kept draft, on a conflict. */
  readonly draft?: { readonly id: string; readonly path: string };
  readonly needs?: SpecEscalation["needs"];
  readonly escalations?: ReadonlyArray<SpecEscalation>;
  readonly paths?: ReadonlyArray<string>;
  readonly issues?: ReadonlyArray<unknown>;
};

export type CommitResult = CommitSuccess | CommitFailure;

/** What a post-commit hook is told. No spec text, no values. */
export type PostCommitEvent = {
  readonly specDir: string;
  readonly fromRev: string;
  readonly toRev: string;
  readonly paths: ReadonlyArray<string>;
  readonly writer: WriterId;
  readonly actor: ActorRef;
};

/** A spec past this many bytes is never read whole here, and so never written. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;

/** A draft's id: a UTC stamp and four random bytes. Every reader checks it before joining a path. */
export const DRAFT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** Drafts older than this are removed by the next commit. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The revision of a spec's text (`specRevision`). One place, so every writer computes the same one. */
export function specRev(text: string): string {
  return specRevision(text);
}

/** The revision of a spec file, or `"absent"` when there is none. */
export function specFileRev(specPath: string): string {
  const read = readWhole(resolve(specPath));
  if (read.kind === "absent") return "absent";
  if (read.kind === "too-large")
    throw new Error(`${specPath} is larger than ${MAX_SPEC_BYTES} bytes`);
  return specRev(read.text);
}

/**
 * A parse that checks YAML syntax only, no schema: for a writer that
 * validates nothing more than that, so the commit adds a revision check and
 * never a validation the writer did not make.
 */
export function parseYamlOnly(yamlText: string): Spec {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error(`the YAML does not parse: ${doc.errors[0]?.message ?? "unknown error"}`);
  }
  return doc.toJS() as Spec;
}

// ---------------------------------------------------------------------------
// where things live
// ---------------------------------------------------------------------------

/** The spec's real directory: where its link leads, or its directory's real path when it does not exist yet. */
function specRealDir(specPath: string): string {
  const given = resolve(specPath);
  try {
    return dirname(realpathSync(given));
  } catch {
    // No file yet.
  }
  try {
    return realpathSync(dirname(given));
  } catch {
    return dirname(given);
  }
}

/** The commit state's place below the spec's directory (`specStateDir` spells it out for `join`). */
const STATE_SEGMENTS = [".crewhaus", "run", "spec"] as const;

/** The directory a spec's commit state lives in: `<spec's real dir>/.crewhaus/run/spec`. */
export function specStateDir(specPath: string): string {
  return join(specRealDir(specPath), ".crewhaus", "run", "spec");
}

/** `path` lies inside `root` (or is it), by the `relative()` rule. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type ContainedDir =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly reason: string };

/**
 * `root` joined with `segments`, each a plain directory (never a link), whose
 * real path lies inside `root`. With `create`, missing directories are made
 * (`0700`) one at a time; without it, a missing one is a refusal.
 */
function containedDir(root: string, segments: readonly string[], create: boolean): ContainedDir {
  const shown = (n: number): string => segments.slice(0, n).join("/");
  let dir = root;
  for (let i = 0; i < segments.length; i++) {
    dir = join(dir, segments[i] as string);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(dir);
    } catch (err) {
      if (!create || (err as { code?: unknown }).code !== "ENOENT") {
        return { ok: false, reason: `${shown(i + 1)} cannot be read beside the spec` };
      }
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (mkErr) {
        if ((mkErr as { code?: unknown }).code !== "EEXIST") {
          return {
            ok: false,
            reason: `${shown(i + 1)} cannot be created beside the spec: ${(mkErr as Error).message}`,
          };
        }
      }
      stat = lstatSync(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        ok: false,
        reason: `${shown(i + 1)} beside the spec is not a plain directory; nothing is kept through it`,
      };
    }
  }
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return { ok: false, reason: `${shown(segments.length)} cannot be resolved beside the spec` };
  }
  if (!isInside(root, real)) {
    return {
      ok: false,
      reason: `${shown(segments.length)} resolves outside the spec's directory; nothing is kept through it`,
    };
  }
  return { ok: true, dir: real };
}

/**
 * The spec's commit-state directory, contained: created when `create` is set,
 * refused when any part of it is a link or resolves outside the spec's directory.
 */
export function containedSpecStateDir(specPath: string, create = false): ContainedDir {
  return containedDir(specRealDir(specPath), STATE_SEGMENTS, create);
}

/** The path of a draft, or undefined for an id that is not a draft id. */
export function specDraftPath(specPath: string, id: string): string | undefined {
  if (!DRAFT_ID_RE.test(id)) return undefined;
  return join(specStateDir(specPath), "drafts", `${id}.json`);
}

export type SpecDraft = {
  readonly v: 1;
  readonly at: string;
  readonly baseRev: string;
  readonly writer: string;
  readonly actor: ActorRef;
  readonly edits?: ReadonlyArray<SpecEdit>;
  readonly text?: string;
};

/** Read a kept draft. Undefined for a bad id, a missing draft, or one that is not a regular file. */
export function readSpecDraft(specPath: string, id: string): SpecDraft | undefined {
  if (!DRAFT_ID_RE.test(id)) return undefined;
  const drafts = containedDir(specRealDir(specPath), [...STATE_SEGMENTS, "drafts"], false);
  if (!drafts.ok) return undefined;
  const path = join(drafts.dir, `${id}.json`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_SPEC_BYTES * 2) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as SpecDraft;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// post-commit hooks
// ---------------------------------------------------------------------------

type PostCommitHook = (event: PostCommitEvent) => void | Promise<void>;

const postCommitHooks: PostCommitHook[] = [];

/** Run `hook` after every successful write. Returns the function that removes it. */
export function registerPostCommitHook(hook: PostCommitHook): () => void {
  postCommitHooks.push(hook);
  return () => {
    const i = postCommitHooks.indexOf(hook);
    if (i >= 0) postCommitHooks.splice(i, 1);
  };
}

/** Remove every post-commit hook. */
export function clearPostCommitHooks(): void {
  postCommitHooks.length = 0;
}

// ---------------------------------------------------------------------------
// create-only writers
// ---------------------------------------------------------------------------

export type CreateSpecFileResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "exists" | "unwritable"; readonly reason: string };

/**
 * Create a spec that must not exist yet (`init`, the console's wizard). An
 * existing file is never replaced: the answer is `exists` and the file is
 * left as it was. The file is created `0644` (umask applies), atomically.
 */
export function createSpecFile(path: string, text: string): CreateSpecFileResult {
  const abs = resolve(path);
  const written = writeFileSafe(dirname(abs), basename(abs), text, {
    overwrite: false,
    mode: 0o644,
  });
  if (written.ok) return { ok: true };
  return written.code === "exists"
    ? { ok: false, code: "exists", reason: `${abs} already exists; it was not replaced` }
    : { ok: false, code: "unwritable", reason: written.reason };
}

// ---------------------------------------------------------------------------
// the commit
// ---------------------------------------------------------------------------

type WholeRead =
  | { readonly kind: "absent" }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "present"; readonly text: string; readonly real: string };

function readWhole(given: string): WholeRead {
  let real: string;
  try {
    real = realpathSync(given);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      // A dangling link is a file the operator pointed somewhere: not absent.
      try {
        lstatSync(given);
      } catch {
        return { kind: "absent" };
      }
    }
    throw err;
  }
  const size = statSync(real).size;
  if (size > MAX_SPEC_BYTES) return { kind: "too-large", bytes: size };
  return { kind: "present", text: readFileSync(real, "utf8"), real };
}

function revOf(read: WholeRead): string {
  return read.kind === "present" ? specRev(read.text) : "absent";
}

function rawParse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    const doc = parseDocument(text);
    return doc.errors.length > 0 ? undefined : doc.toJS();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The top-level keys whose values differ between two texts. */
function touchedTopLevel(before: string | undefined, after: string): string[] {
  const a = rawParse(before);
  const b = rawParse(after);
  const left = isPlainObject(a) ? a : {};
  const right = isPlainObject(b) ? b : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !Bun.deepEquals(left[key], right[key], true)).sort();
}

function stampOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function stampTime(id: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  if (m === null) return undefined;
  const t = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isFinite(t) ? t : undefined;
}

function cleanActor(actor: ActorRef): ActorRef {
  return typeof actor.by === "string" && /^prn_[A-Za-z0-9_-]{1,128}$/.test(actor.by)
    ? { kind: actor.kind, by: actor.by }
    : { kind: actor.kind };
}

/** Append one line, `0600` when created, never through a link. */
function appendLine(path: string, line: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

function pruneDrafts(stateDir: string, now: Date): void {
  const dir = join(stateDir, "drafts");
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return;
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = now.getTime() - DRAFT_TTL_MS;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!DRAFT_ID_RE.test(id)) continue;
    const at = stampTime(id);
    if (at === undefined || at >= cutoff) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Already gone.
    }
  }
}

function keepDraft(
  stateDir: string,
  change: SpecChange,
  opts: CommitOptions,
  now: Date,
): { id: string; path: string } | { refused: string } {
  const drafts = containedDir(stateDir, ["drafts"], true);
  if (!drafts.ok) return { refused: drafts.reason };
  const dir = drafts.dir;
  const draft: SpecDraft = {
    v: 1,
    at: now.toISOString(),
    baseRev: opts.expectedRev,
    writer: opts.writer,
    actor: cleanActor(opts.actor),
    ...(change.kind === "edits" ? { edits: change.edits } : { text: change.text }),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `${stampOf(now)}-${randomBytes(4).toString("hex")}`;
    const written = writeFileSafe(dir, `${id}.json`, `${JSON.stringify(draft, null, 2)}\n`, {
      overwrite: false,
      mode: 0o600,
    });
    if (written.ok) return { id, path: join(dir, `${id}.json`) };
    if (written.code !== "exists")
      throw new Error(`the draft could not be kept: ${written.reason}`);
  }
  throw new Error("the draft could not be kept: no free draft id");
}

type Computed =
  | {
      readonly ok: true;
      readonly yaml: string;
      readonly formatting: CommitFormatting;
      readonly applied?: number;
    }
  | CommitFailure;

async function compute(
  before: string | undefined,
  change: SpecChange,
  opts: CommitOptions,
): Promise<Computed> {
  let yaml: string;
  let formatting: CommitFormatting;
  let applied: number | undefined;
  if (change.kind === "edits") {
    if (before === undefined) {
      return { ok: false, code: "invalid", reason: "there is no spec to edit" };
    }
    try {
      const result = applySpecEdits(before, change.edits, {
        ...(change.restrictToOptimizable === true ? { restrictToOptimizable: true } : {}),
        ...(opts.parse !== undefined ? { parse: opts.parse } : {}),
      });
      yaml = result.yaml;
      formatting = result.formatting;
      applied = result.applied;
    } catch (err) {
      return { ok: false, code: "invalid", reason: (err as Error).message };
    }
  } else {
    yaml = change.text;
    formatting = "as-given";
    try {
      (opts.parse ?? parseSpec)(yaml);
    } catch (err) {
      return { ok: false, code: "invalid", reason: (err as Error).message };
    }
  }
  if (opts.validate !== undefined) {
    const verdict = await opts.validate(yaml, { before });
    if (!verdict.ok) {
      return {
        ok: false,
        code: verdict.code ?? "invalid",
        reason: verdict.reason,
        ...(verdict.issues !== undefined ? { issues: verdict.issues } : {}),
        ...(verdict.paths !== undefined ? { paths: verdict.paths } : {}),
      };
    }
  }
  if (opts.confirm !== undefined && yaml !== before) {
    const raw = rawParse(before);
    const escalations = escalationFor(raw, rawParse(yaml));
    const currentName = isPlainObject(raw) ? raw["name"] : undefined;
    if (escalations.length > 0 && opts.confirm.name !== currentName) {
      const security = escalations.find((e) => e.needs === "h.spec.edit.security");
      return {
        ok: false,
        code: "needs-confirmation",
        needs: (security ?? (escalations[0] as SpecEscalation)).needs,
        escalations,
        reason: escalations.map((e) => e.reason).join(" "),
        paths: escalations.flatMap((e) => e.paths),
      };
    }
  }
  return { ok: true, yaml, formatting, ...(applied !== undefined ? { applied } : {}) };
}

function conflict(
  stateDir: string,
  change: SpecChange,
  opts: CommitOptions,
  now: Date,
  currentRev: string,
): CommitFailure {
  const draft = keepDraft(stateDir, change, opts, now);
  if ("refused" in draft) {
    return {
      ok: false,
      code: "unwritable",
      reason: `the spec changed after this change was computed; nothing was written, and no draft was kept: ${draft.refused}`,
      current: { rev: currentRev },
    };
  }
  return {
    ok: false,
    code: "conflict",
    reason:
      currentRev === "absent"
        ? "the spec was removed after this change was computed; nothing was written, and the change is kept as a draft"
        : opts.expectedRev === "absent"
          ? "a spec already exists here; nothing was written, and the change is kept as a draft"
          : "the spec changed after this change was computed; nothing was written, and the change is kept as a draft",
    current: { rev: currentRev },
    draft,
  };
}

function tooLarge(bytes: number): CommitFailure {
  return {
    ok: false,
    code: "too-large",
    reason: `the spec is ${bytes} bytes, past the ${MAX_SPEC_BYTES}-byte limit a spec is read whole under; nothing was written`,
  };
}

/**
 * Commit one change to the spec at `target.specPath`, guarded by
 * `opts.expectedRev`. See the module docblock for the order of events.
 */
export async function commitSpec(
  target: { readonly specPath: string },
  change: SpecChange,
  opts: CommitOptions,
): Promise<CommitResult> {
  const given = resolve(target.specPath);
  const clock = opts.now ?? (() => new Date());
  const warn = opts.onWarn ?? ((message: string) => process.stderr.write(`${message}\n`));

  // The change is computed (and validated, which may take a while) before the
  // lock, from the text the caller's revision should name.
  const first = readWhole(given);
  if (first.kind === "too-large") return tooLarge(first.bytes);
  const firstText = first.kind === "present" ? first.text : undefined;
  let computed: Computed | undefined;
  if (revOf(first) === opts.expectedRev) {
    computed = await compute(firstText, change, opts);
    if (!computed.ok) return computed;
  }
  await opts.hooks?.afterRead?.();

  const state = containedSpecStateDir(given, true);
  if (!state.ok) {
    return { ok: false, code: "unwritable", reason: `nothing was written: ${state.reason}` };
  }
  const stateDir = state.dir;
  const outcome = await withFileLock(
    join(stateDir, "lock"),
    async (): Promise<{ result: CommitResult; event?: PostCommitEvent }> => {
      const now = clock();
      pruneDrafts(stateDir, now);
      // The comparison and the write happen in this one lock hold.
      const current = readWhole(given);
      if (current.kind === "too-large") return { result: tooLarge(current.bytes) };
      const currentRev = revOf(current);
      if (currentRev !== opts.expectedRev) {
        return { result: conflict(stateDir, change, opts, now, currentRev) };
      }
      const currentText = current.kind === "present" ? current.text : undefined;
      let ready = computed;
      if (ready === undefined || currentText !== firstText) {
        // Same revision, different bytes (line endings): compute from what is on disk.
        ready = await compute(currentText, change, opts);
      }
      if (!ready.ok) return { result: ready };
      if (currentText !== undefined && ready.yaml === currentText) {
        return {
          result: {
            ok: true,
            rev: currentRev,
            fromRev: currentRev,
            entries: [],
            formatting: ready.formatting,
            wrote: false,
            yaml: currentText,
            ...(ready.applied !== undefined ? { applied: ready.applied } : {}),
          },
        };
      }

      const real = current.kind === "present" ? current.real : given;
      const written = writeFileSafe(dirname(real), basename(real), ready.yaml, {
        overwrite: current.kind === "present",
        mode: 0o644,
      });
      if (!written.ok) {
        return {
          result: {
            ok: false,
            code: written.code === "exists" ? "conflict" : "unwritable",
            reason: written.reason,
            ...(written.code === "exists" ? { current: { rev: revOf(readWhole(given)) } } : {}),
          },
        };
      }
      const toRev = specRev(ready.yaml);

      let registered: string | undefined;
      let note: string | undefined;
      if (opts.register !== undefined) {
        try {
          registered = (await opts.register(ready.yaml))?.version;
        } catch (err) {
          note = `the change was written, but no version was recorded: ${(err as Error).message}`;
          warn(`spec-commit: ${note}`);
        }
      }
      const paths = touchedTopLevel(currentText, ready.yaml);
      const actor = cleanActor(opts.actor);
      appendLine(
        join(stateDir, "commits.jsonl"),
        JSON.stringify({
          v: 1,
          at: now.toISOString(),
          fromRev: currentRev,
          toRev,
          writer: opts.writer,
          actor,
          paths,
          ...(registered !== undefined ? { registered } : {}),
          formatting: ready.formatting,
        }),
      );
      let entries: ReadonlyArray<SpecDiffEntry> = [];
      try {
        entries = diffSpecYaml(currentText ?? "", ready.yaml);
      } catch {
        entries = [];
      }
      return {
        result: {
          ok: true,
          rev: toRev,
          fromRev: currentRev,
          entries,
          formatting: ready.formatting,
          wrote: true,
          yaml: ready.yaml,
          ...(ready.applied !== undefined ? { applied: ready.applied } : {}),
          ...(registered !== undefined ? { registered } : {}),
          ...(note !== undefined ? { note } : {}),
        },
        event: {
          specDir: dirname(real),
          fromRev: currentRev,
          toRev,
          paths,
          writer: opts.writer,
          actor,
        },
      };
    },
    { label: "spec-commit", waitMs: 10_000 },
  );

  if (outcome.event !== undefined) {
    for (const hook of [...postCommitHooks]) {
      try {
        await hook(outcome.event);
      } catch (err) {
        warn(`spec-commit: a post-commit hook failed: ${(err as Error).message}`);
      }
    }
  }
  return outcome.result;
}
