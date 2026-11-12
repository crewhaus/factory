/**
 * Catalog R8 `permission-engine` — modes, layered rule sources, decisions.
 *
 * Modes
 *   default — ask on first encounter; rules can pre-decide
 *   plan    — read-only; non-readOnly tools always denied. Only deny and ask
 *             rules are consulted (both deny); allow rules are ignored, so
 *             plan mode can never be widened, and the sandbox floor holds —
 *             plan never allows what auto would not
 *   auto    — read-only auto-allow; destructive auto-ask; rules can override
 *   bypass  — allow everything (CLI flag only — see security note)
 *
 * Floors (no rule can lift them; bypass consults nothing)
 *   sandbox       — a `requiresSandbox` tool needs a real sandbox backend and,
 *                   outside plan mode, an explicit alwaysAllow
 *   runtime state — a call that is not read-only never writes inside
 *                   `EvaluateOptions.protectedRoots` (the session logs,
 *                   spilled tool results and proof bundles the gates read as
 *                   evidence, and the files that control the run: the
 *                   harness's run files, settings, gate records, environment
 *                   files, compiled bundle and dependencies, Hangar's directory),
 *                   nor acts beneath a workspace directory that holds one
 *   credentials   — on a run that sets `EvaluateOptions.credentialRoots`, a call
 *                   that names one of those files, or a file
 *                   `isCredentialFileName` matches, is denied, read-only or
 *                   not; `Bash` and `RunCommand` stay outside it
 *
 * Rule sources (priority high → low)
 *   flag → settings → yaml → hooks → builtin
 * The first matching rule in source-priority order wins. A later source
 * cannot override an earlier source's decision.
 *
 * Rule types: alwaysAllow / alwaysDeny / alwaysAsk
 *
 * An argument-scoped rule (`Tool(glob)`) is matched differently by type
 * (0.7.1): an allow needs EVERY operative value of the call to match its
 * glob, a deny or ask fires when ANY does. See `matchesPattern` in
 * `@crewhaus/tool-permission-matcher`.
 *
 * SECURITY: `mode: bypass` must NEVER come from a config file. Both
 * `parsePermissionsConfig()` (yaml/settings) and the Zod schema reject it
 * explicitly. Bypass enters the system through the `--permission-mode bypass`
 * CLI flag and nothing else. See the T8 test in src/index.test.ts.
 *
 * References: claude-code/utils/permissions/ (24 files); AI-Harness-Systems
 * §Policy engine.
 */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  type CompiledPattern,
  type OperativeValue,
  type RulePolarity,
  compilePattern,
  matchesPattern,
} from "@crewhaus/tool-permission-matcher";
import {
  foldedName,
  isCredentialFileName,
  namesGitDirectory,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { z } from "zod";

export type PermissionMode = "default" | "plan" | "auto" | "bypass";
export type RuleType = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";
export type RuleSource = "flag" | "settings" | "yaml" | "hook" | "builtin";

export type PermissionRule = {
  readonly type: RuleType;
  readonly pattern: string;
  readonly source: RuleSource;
};

export type RuleSet = {
  readonly flag: ReadonlyArray<PermissionRule>;
  readonly settings: ReadonlyArray<PermissionRule>;
  readonly yaml: ReadonlyArray<PermissionRule>;
  readonly hooks: ReadonlyArray<PermissionRule>;
  readonly builtin: ReadonlyArray<PermissionRule>;
};

export type ToolCallContext = {
  readonly toolName: string;
  /**
   * The call's input. Pass it AFTER the tool's schema has parsed it (unknown
   * keys stripped, defaults filled in): that is what the tool acts on, so it
   * is what a rule must be checked against.
   */
  readonly input: unknown;
  /**
   * The values of the tool's declared `operativeArgs`, canonicalised (paths
   * resolved against the workspace, URLs parsed). When present, argument
   * globs are matched against these instead of `input`. Absent ⇒ the tool
   * declares none, and the matcher falls back to `input`'s string values.
   */
  readonly operativeValues?: ReadonlyArray<OperativeValue>;
  /**
   * 0.8.0 — what the runtime-state floor reads (`EvaluateOptions
   * .protectedRoots`): the values of the fields the call WRITES. The runtime
   * leaves out a field declared `relocates` that names a store inside the
   * run's record, which the tool works in through its own format
   * (EmitTraceEvent's namespaced `custom.*` lines), or one the tool reads whole
   * (IncidentBundle's sessions), and one declared `source`, where the tool
   * takes a value FROM (the files IndexBuild indexes). Empty for a tool that
   * declares `[]`, read-only or not: what it carries is text. Absent ⇒
   * `operativeValues`.
   */
  readonly floorValues?: ReadonlyArray<OperativeValue>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  /**
   * Section 18 — when true, the tool is gated behind the production
   * safety floor. `evaluate()` refuses to grant `allow` in default mode
   * unless an `alwaysAllow` rule matches AND a non-noop sandbox backend
   * is configured (`sandboxAvailable: true`).
   */
  readonly requiresSandbox?: boolean;
};

export type Decision = "allow" | "deny" | "ask";

/**
 * Section 18 — extra signals the runtime threads through. `sandboxAvailable`
 * is true when a non-noop sandbox backend is wired; without it, any
 * `requiresSandbox: true` tool is denied even if a rule would have allowed
 * it. This keeps the noop backend strictly test-scope.
 */
export type EvaluateOptions = {
  readonly sandboxAvailable?: boolean;
  /**
   * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2) — the
   * runtime's own record of the run, and the files that control it: paths
   * (absolute, or relative to the workspace) that the runtime and CrewHaus's
   * own code write and no agent tool may. A root is a directory, protecting
   * everything under it, or an exact file, protecting that file alone. The
   * record is what the gates read as evidence — the session event logs
   * (every `tool_use` and `tool_result` the provability gate grounds a claim
   * on, and `continuity.proof` resolves), the tool results the runtime
   * spilled to a file (read whole as a long fetch's body) and the proof
   * bundles. The files that control the run decide what the agent may do
   * next — the harness's run files (`.crewhaus/run`), its settings file
   * (`.crewhaus/settings.json`: permission rules, runtime hooks and the
   * manager's spawn hooks) and Hangar's directory (the Hangar root). A call
   * that is not read-only and names a path inside one is DENIED whatever a
   * rule says — the runtime-state floor, beside the sandbox floor: a
   * hand-written log line holding a fetch that never ran would otherwise
   * ground any text under any URL. Only `bypass` mode, which consults
   * nothing, lets such a call through. Absent ⇒ no floor.
   *
   * The floor reads the call's operative values, so it covers every tool that
   * names where it writes (Write, Edit, MultiEdit, the fsx writers' paths).
   * A writer that acts BENEATH a directory it names (`beneath`) — a tree
   * removed, emptied, imported into, migrated, copied, moved or extracted
   * onto it — is denied when a root lies under that directory and the
   * directory is inside the workspace (`.crewhaus` holds `.crewhaus/run` and
   * `.crewhaus/settings.json`: StateImport's `stateDir`, StoreMigrate's
   * `to`). The workspace root itself is left to the rules, since a git
   * pathspec, a patch's `cwd` or a harness directory defaults to `.` and
   * every such call would otherwise be refused;
   * a writer that acts beneath it checks its own targets against the same
   * roots, which the runtime hands it on the bridge
   * (`RuntimeBridge.protectedRoots`; CopyPath, MovePath, RemovePath,
   * ArchiveExtract, GitApplyPatch, SpecPin, DeployRollback). Neither can see where a shell command
   * writes: `Bash` / `RunCommand` stay a documented residual, closed only by
   * keyed integrity on the log lines themselves (a MAC with a key outside
   * the tree the agent can write), as does `bypass` mode.
   *
   * A value is compared by name, as a filesystem that folds names compares
   * it (`foldedName`), where the canonicaliser marks it `caseInsensitive`, and
   * where nothing says how its volume compares names: a path outside the
   * workspace, and the text of a tool that declares no paths. Any other value
   * compares exactly. The text of a tool that declares no paths is not compared
   * with the relative roots of {@link NAMES_IN_TEXT}, which are ordinary words
   * and file names there; their absolute spellings still are.
   *
   * When the list is not empty the floor also denies a call that is not
   * read-only and names a path with a name git treats as its own directory
   * (`namesGitDirectory`), wherever it lies in the workspace: that directory
   * belongs to git and to the person running it. A value is read by its
   * workspace-relative spellings, so a link to one is caught by where it leads
   * and a workspace that itself sits under such a name is not walled off. A
   * field declared `relocates` is left out, as its writer adds fixed
   * subdirectories and suffixes. A string from a tool that declares no paths
   * counts only when a name follows that one and it holds no `://`, whitespace
   * or glob characters: a URL, a sentence, a search term or an exclude pattern
   * is not a path being written, and that tool may be a chat post, where the
   * deny would have no rule to lift it. Any other such string goes to the rules.
   */
  readonly protectedRoots?: ReadonlyArray<string>;
  /**
   * A store's own files, kept from every tool but the store's own (the
   * continuity store's `focus.md`, `goals.yaml`, `plans`, ... under
   * `.crewhaus/state/<spec>/`). A call that is not read-only and names one,
   * or a path inside one, is denied before any rule is read, as a
   * {@link protectedRoots} root is. Unlike a root, a file is never read the
   * `above` way: a call that acts beneath a directory holding one (StateImport
   * over the whole of `.crewhaus/state`) is not refused for it, and the tool
   * checks its own targets against the roots on its bridge. Only `bypass`
   * skips it. Absent ⇒ no check.
   */
  readonly protectedFiles?: ReadonlyArray<string>;
  /**
   * The files a run keeps from its agent's tools. A call that names one, or a
   * file `isCredentialFileName` matches, is denied whatever a rule says,
   * read-only or not. The runtime sets this on a `channel` or `managed` run.
   * Only `bypass` skips it, and `Bash` and `RunCommand` stay outside it.
   * Absent ⇒ no check.
   */
  readonly credentialRoots?: ReadonlyArray<string>;
};

/**
 * Decision details. `evaluate()` returns just the Decision (back-compat);
 * `evaluateWithReason()` exposes the structured form so runtime-core can
 * publish `permission_decision { reason }` events.
 */
export type DecisionDetails = {
  readonly decision: Decision;
  readonly reason?: string;
};

export class PermissionConfigError extends CrewhausError {
  override readonly name = "PermissionConfigError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const SOURCE_PRIORITY: ReadonlyArray<keyof RuleSet> = [
  "flag",
  "settings",
  "yaml",
  "hooks",
  "builtin",
];

export const emptyRuleSet: RuleSet = {
  flag: [],
  settings: [],
  yaml: [],
  hooks: [],
  builtin: [],
};

/**
 * #383 — the runtime's own bookkeeping toolset: the `Skill` loader plus the
 * non-destructive continuity tools (`@crewhaus/tool-plan`'s focus/plan/goal
 * family). Continuity is default-on, and the agent loop calls these
 * autonomously on every fresh session — with varying input, so on a headless
 * surface (`ask_mode: pause`) an unruled loop parks on its OWN bookkeeping
 * and a one-shot `(toolName, inputHash)` grant can never satisfy the next
 * call. These are local-only reads/writes to the harness's continuity store
 * (no network, no process boundary), so they get a builtin `alwaysAllow` —
 * the same reasoning that already allows `Read`/`Glob`/`Grep`. `MemoryClear`
 * is deliberately EXCLUDED: it erases continuity state, so it keeps the
 * mode-default behavior unless a spec rule allows it. A spec can still
 * override any of these (the `yaml` source outranks `builtin`).
 */
export const BUILTIN_BOOKKEEPING_RULES: ReadonlyArray<PermissionRule> = [
  { type: "alwaysAllow", pattern: "Skill", source: "builtin" },
  { type: "alwaysAllow", pattern: "FocusRead", source: "builtin" },
  { type: "alwaysAllow", pattern: "FocusWrite", source: "builtin" },
  { type: "alwaysAllow", pattern: "PlanRead", source: "builtin" },
  { type: "alwaysAllow", pattern: "PlanUpdate", source: "builtin" },
  { type: "alwaysAllow", pattern: "PlanComplete", source: "builtin" },
  { type: "alwaysAllow", pattern: "GoalWrite", source: "builtin" },
  { type: "alwaysAllow", pattern: "GoalUpdate", source: "builtin" },
  { type: "alwaysAllow", pattern: "GoalList", source: "builtin" },
  // #405 — the toolset-introspection tool. Read-only and side-effect-free,
  // and its whole purpose is breaking the stale-transcript deadlock in a
  // HEADLESS session — an introspection tool that parks on approval there
  // is useless for exactly the case it exists for.
  { type: "alwaysAllow", pattern: "ListTools", source: "builtin" },
  // 0.8.0 (design/0.8.0-provability-release.md §7) — the provability gate's
  // read-only tools. `provability:` installs them without the spec listing
  // them, and the gate's own retry nudge tells the model to run
  // ProvabilityPreflight; on a headless surface an unruled call parks the
  // turn on the gate's bookkeeping. Both only read (the evidence, the
  // checkers' availability).
  { type: "alwaysAllow", pattern: "ProvabilityPreflight", source: "builtin" },
  { type: "alwaysAllow", pattern: "ProofCheckers", source: "builtin" },
  // 0.8.0 (design §6.4, §7) — `ProofCheck` with the BUILTIN checker: the one
  // way to reach the `proven` rung on a sandbox-less harness, and the path
  // `provability: proven` steers the model to first. Unruled, every headless
  // surface (`crewhaus run --prompt`, a channel bot, the managed gateway)
  // parked the honest proven answer on its first proof. The builtin checker
  // parses a certificate in a worker thread under the formal timeout — no
  // container, no network, no process — and the one file a call writes is a
  // new artifact under the proofs root, a place the model cannot name. The
  // sandbox checkers (`ProofCheck(smt)`, `ProofCheck(lean4)`) start a
  // container and keep the mode default; an operator allows them by rule
  // (`crewhaus lint` says so on a headless shape). Like every builtin allow,
  // a spec rule outranks it, and plan mode ignores it (the tool writes).
  { type: "alwaysAllow", pattern: "ProofCheck(builtin)", source: "builtin" },
];

/**
 * Reasonable starting defaults. The CLI seeds these into the `builtin` source.
 * Intentionally small — just dangerous bash forms get an `alwaysAsk`, a
 * few obviously-safe read-only tools get `alwaysAllow`, and the runtime's own
 * bookkeeping toolset rides along via {@link BUILTIN_BOOKKEEPING_RULES}.
 * Everything else falls through to mode-specific behavior (default → ask).
 */
export const BUILTIN_DEFAULT_RULES: ReadonlyArray<PermissionRule> = [
  // `**` (vs `*`) matches across path separators — necessary to catch `rm -rf /tmp/foo`.
  { type: "alwaysAsk", pattern: "Bash(rm**)", source: "builtin" },
  { type: "alwaysAsk", pattern: "Bash(sudo**)", source: "builtin" },
  { type: "alwaysAllow", pattern: "Read", source: "builtin" },
  { type: "alwaysAllow", pattern: "Glob", source: "builtin" },
  { type: "alwaysAllow", pattern: "Grep", source: "builtin" },
  ...BUILTIN_BOOKKEEPING_RULES,
];

function rulePolarity(t: RuleType): RulePolarity {
  return t === "alwaysAllow" ? "allow" : "restrict";
}

function ruleTypeToDecision(t: RuleType): Decision {
  switch (t) {
    case "alwaysAllow":
      return "allow";
    case "alwaysDeny":
      return "deny";
    case "alwaysAsk":
      return "ask";
  }
}

const compileCache = new WeakMap<PermissionRule, CompiledPattern>();
function compile(rule: PermissionRule): CompiledPattern {
  const cached = compileCache.get(rule);
  if (cached !== undefined) return cached;
  const compiled = compilePattern(rule.pattern);
  compileCache.set(rule, compiled);
  return compiled;
}

/**
 * The first rule, in source-priority order, that matches `call` among the
 * rules `consider` admits. Each rule is matched with its own polarity: an
 * allow needs every operative value to match, a deny or ask any one.
 *
 * A malformed rule pattern fails CLOSED for safety rules: an uncompilable
 * `alwaysDeny`/`alwaysAsk` still gates (it counts as a match), so an
 * attacker-influenced broken guard — e.g. a deny pattern in an untrusted
 * sub-agent definition — can't be silently dropped to fail open. A malformed
 * `alwaysAllow` is skipped: a broken grant simply isn't honored.
 */
function firstMatchingRule(
  call: ToolCallContext,
  rules: RuleSet,
  consider: (type: RuleType) => boolean,
): PermissionRule | undefined {
  for (const sourceKey of SOURCE_PRIORITY) {
    for (const rule of rules[sourceKey]) {
      if (!consider(rule.type)) continue;
      try {
        const compiled = compile(rule);
        const matched = matchesPattern(compiled, call.toolName, call.input, {
          polarity: rulePolarity(rule.type),
          ...(call.operativeValues !== undefined ? { operativeValues: call.operativeValues } : {}),
        });
        if (matched) return rule;
      } catch {
        if (rule.type === "alwaysDeny" || rule.type === "alwaysAsk") return rule;
      }
    }
  }
  return undefined;
}

/**
 * Why a sandboxed tool was refused for want of a sandbox. The runtime reads
 * CREWHAUS_SANDBOX through the sandbox's own parser: unset means docker, so
 * the floor only closes on `noop` or a value that names no backend — or in a
 * runtime that never said a sandbox exists.
 */
function noSandboxReason(toolName: string): string {
  return `tool "${toolName}" requires a sandbox, and the runtime reports none (CREWHAUS_SANDBOX is noop or names no backend — set it to docker or podman, or leave it unset for docker)`;
}

/** A Windows drive path (`C:\srv\ws`, `C:/srv/ws`, the bare `C:`): absolute, as the runtime's canonicaliser spells a path on Windows. */
const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/;

/**
 * A path as the floor compares it: `\\` as `/`, `.` and `..` collapsed, no
 * trailing `/`, in Unicode normal form C (a name spelled with a combining
 * accent is the precomposed one, as on macOS), and with each name folded
 * ({@link foldedName}) where the filesystem does not tell names apart by case.
 * One pass over the string, and
 * no `node:path`: the path is model-written and can be long (critic8).
 *
 * A drive path is absolute, as a UNC one (`\\host\share`) already is: its
 * key is `/c:/srv/ws`, the drive lower-cased (a letter names one drive in
 * either case) and held as the first name, which no `..` pops. Read as
 * relative, the workspace root's own Windows spelling `C:/srv/ws` was a
 * directory INSIDE the workspace holding every root, and the `above`
 * reading refused each writer that acts on `.` — GitCommit, GitAdd `.`,
 * Lint, Format — on every Windows harness (design §10: the workspace root
 * is left to the rules). `drives: false` reads one as written, relative —
 * a directory named `C:` on POSIX, where `C:/../x` is `x`.
 */
function floorKey(path: string, fold: boolean, drives = true): string {
  const drive = drives && DRIVE_PATH.test(path);
  const absolute = drive || path.startsWith("/") || path.startsWith("\\");
  const names: string[] = drive ? [path.slice(0, 2).toLowerCase()] : [];
  const pinned = names.length;
  for (const written of (drive ? path.slice(2) : path).split(/[\\/]/)) {
    const name = fold ? foldedName(written) : written;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      if (names.length > pinned && names[names.length - 1] !== "..") names.pop();
      else if (!absolute) names.push("..");
      continue;
    }
    names.push(name);
  }
  const joined = `${absolute ? "/" : ""}${names.join("/")}`;
  return (joined === "" ? "." : joined).normalize("NFC");
}

/** Whether `path` is `root` or lies under it (both {@link floorKey}s). */
function liesUnder(path: string, root: string): boolean {
  if (path === root) return true;
  return root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`);
}

/** Every string in `input`, however deep (a tool that declares no operative arguments). */
function inputStrings(input: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof input === "string") {
    out.push(input);
  } else if (depth < 8 && typeof input === "object" && input !== null) {
    for (const value of Object.values(input as Record<string, unknown>)) {
      inputStrings(value, out, depth + 1);
    }
  }
  return out;
}

/** Is this floor key a workspace-relative path strictly inside the workspace (not `.`, not above it)? */
function insideWorkspace(key: string): boolean {
  return key !== "." && !key.startsWith("/") && key !== ".." && !key.startsWith("../");
}

/** What {@link protectedRootHit} reports for a path with a name git treats as its own directory. */
const GIT_DIRECTORY = ".git";

/** A string from a tool with no declared paths that reads as a URL, a sentence or a pattern, not a path. */
const NOT_A_PATH = /:\/\/|\s|[*?[\]{}]/;

/** Does a name follow a git directory's name in this floor key? `.git` and `n/.git` name no file in it. */
function namesInsideGitDirectory(key: string): boolean {
  const last = key.lastIndexOf("/");
  return last > 0 && namesGitDirectory(key.slice(0, last));
}

/**
 * Relative roots that mean something else in the text of a tool that declares no
 * paths: words for a label, a channel or a branch, and file names that every
 * repository in another system holds.
 */
const NAMES_IN_TEXT: ReadonlySet<string> = new Set([
  "dist",
  "build",
  "node_modules",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
]);

/**
 * The protected root a call reaches (see `EvaluateOptions.protectedRoots`),
 * and how, or `undefined`. Read from the call's `path` operative values (its
 * `floorValues` when the runtime names the written fields) — every
 * spelling the runtime's canonicaliser gives (workspace-relative and
 * absolute, symlinks followed, the name as sent), case folded where the
 * filesystem folds it — or, for a tool that declares none, from the strings
 * in its input as written (the runtime passes empty `floorValues` for one that
 * declares `[]`, whose strings are text). Read from a tool that declares none,
 * the relative roots of {@link NAMES_IN_TEXT}, and any name below one, are not
 * taken for paths, so a label, a channel or a branch of that name, or a file of
 * that name in another system, is not refused: an absolute spelling is still
 * read, as every other root is. A plugin tool that writes such a file declares
 * `operativeArgs`, and an MCP tool that writes files is decided by a rule on that
 * tool. A path is caught when it IS a protected root or lies under one (`inside`), and a directory the call acts BENEATH (its
 * value's `beneath` prefixes: a tree removed, emptied, imported into or
 * migrated onto) when a root lies under it (`above`) — `.crewhaus` for the
 * session logs at `.crewhaus/sessions`, which StateImport and StoreMigrate
 * could otherwise fill with a forged fetch. The workspace root and what lies
 * above it are not read that way: a git pathspec, a patch or a harness
 * directory defaults to `.`, and every such call would be refused; a writer
 * that acts beneath the workspace root checks its own targets against the
 * roots on the bridge, and a shell command stays a residual. The `above`
 * reading compares workspace-relative spellings only, so a root outside the
 * workspace (where no in-workspace writer reaches) is read `inside` alone. A
 * path with a name git treats as its own directory is reported as
 * {@link GIT_DIRECTORY}, before any root is compared.
 */
function protectedRootHit(
  call: ToolCallContext,
  opts: EvaluateOptions,
): { readonly root: string; readonly above?: string } | undefined {
  if (call.readOnly || opts.protectedRoots === undefined || opts.protectedRoots.length === 0) {
    return undefined;
  }
  return rootHit(call.floorValues ?? call.operativeValues, call.input, opts.protectedRoots);
}

/**
 * The store file a call names (see `EvaluateOptions.protectedFiles`), or
 * `undefined`. Read as {@link protectedRootHit} reads a root, the `inside` way
 * only: a directory the call acts beneath is never compared, so a tool that
 * imports into or migrates the directory holding a store keeps working.
 */
function protectedFileHit(call: ToolCallContext, opts: EvaluateOptions): string | undefined {
  if (call.readOnly || opts.protectedFiles === undefined || opts.protectedFiles.length === 0) {
    return undefined;
  }
  const hit = rootHit(
    call.floorValues ?? call.operativeValues,
    call.input,
    opts.protectedFiles,
    undefined,
    true,
  );
  // The git-directory name check is the roots' to answer.
  return hit === undefined || hit.root === GIT_DIRECTORY ? undefined : hit.root;
}

/**
 * What a call names among the files a run keeps from its tools (see
 * `EvaluateOptions.credentialRoots`), read-only or not, or `undefined`. It reads
 * all of the call's operative values, a field the call only reads from included,
 * so a tool's `reads`, `source` and `relocates` fields count here. A tool that
 * declares `[]` has no such values (`floorValues` is empty for it), and what it
 * carries is text. A string from a tool that declares nothing counts as a path
 * unless it reads as text ({@link readsAsText}): that tool may be a chat post,
 * where the deny would have no rule to lift it.
 */
function credentialHit(
  call: ToolCallContext,
  opts: EvaluateOptions,
): { readonly root: string; readonly above?: string } | undefined {
  if (opts.credentialRoots === undefined) return undefined;
  return rootHit(
    call.operativeValues ?? call.floorValues,
    call.input,
    opts.credentialRoots,
    isCredentialFileName,
  );
}

/** Punctuation a sentence or clause ends on, and a file name rarely does. */
const ENDS_A_CLAUSE = /[.,:;!?)\]'"`]$/;

/**
 * Whether a string from a tool that declares no paths reads as text, not as a
 * file: a URL, or one whose last written name holds whitespace, or one with
 * whitespace in it whose last name ends on a clause's punctuation. The name is
 * taken as written, since {@link foldedName} cuts it at `:` and trims its end. A
 * name's own trailing dots and spaces do not count as whitespace in it, and a
 * string that climbs with `..` is read as a path, URL-shaped or not. One pass
 * over the string.
 */
function readsAsText(written: string): boolean {
  const names = written.split(/[\\/]/).filter((name) => name !== "" && name !== ".");
  const last = names[names.length - 1] ?? "";
  if (written.includes("://") && !names.includes("..")) return true;
  let end = last.length;
  while (end > 0 && (last[end - 1] === "." || last[end - 1] === " ")) end--;
  if (/\s/.test(last.slice(0, end))) return true;
  return ENDS_A_CLAUSE.test(last) && /\s/.test(written);
}

/**
 * The walk both checks share: `values` (or `input`'s strings, when there are
 * none) against `roots`, and, when `names` is given, each spelling's last name
 * against it. A name is read as the spelling folds, so a folding volume's other
 * spellings of it are caught. When `names` is given, a string that reads as text
 * is compared to the roots whole, its case aside, and its last name goes unread.
 * The git-directory name check is the floor's alone: it runs when `names` is not
 * given, so the credential check never answers {@link GIT_DIRECTORY}.
 */
function rootHit(
  values: ReadonlyArray<OperativeValue> | undefined,
  input: unknown,
  roots: ReadonlyArray<string>,
  names?: (name: string) => boolean,
  insideOnly = false,
): { readonly root: string; readonly above?: string } | undefined {
  const candidates: Array<{
    readonly path: string;
    readonly fold: boolean;
    readonly text?: boolean;
    /** How the git-directory name check reads this spelling: only inside the workspace, or as text. */
    readonly gitName: "workspace" | "text" | "none";
  }> = [];
  /** Directories the call acts beneath, as workspace-relative keys. */
  const walked: Array<{
    readonly key: string;
    readonly fold: boolean;
    readonly opensHidden: boolean;
  }> = [];
  if (values !== undefined) {
    for (const value of values) {
      if (value.kind !== "path" || value.globPattern === true) continue;
      // A path outside the workspace was not walked: how its volume compares
      // names is not known, and folding it only widens what the floor catches.
      const fold = value.caseInsensitive === true || value.outsideWorkspace === true;
      const gitName = value.relocates === true ? "none" : "workspace";
      for (const path of [...value.canonical, ...(value.spellings ?? [])]) {
        candidates.push({ path, fold, gitName });
      }
      for (const prefix of value.beneath ?? []) {
        const key = floorKey(prefix, fold);
        if (insideWorkspace(key)) {
          walked.push({ key, fold, opensHidden: value.beneathSkipsHidden !== true });
        }
      }
    }
  } else {
    // Text as written: nothing says how the volume it lands on compares names.
    for (const path of inputStrings(input)) {
      candidates.push({
        path,
        fold: true,
        text: true,
        gitName: NOT_A_PATH.test(path) ? "none" : "text",
      });
    }
  }
  // Each spelling read once, however many roots there are. A drive path is
  // also read as written, relative: on POSIX `C:/../.crewhaus/sessions/x`
  // is a path into the logs (a tool read from its input strings carries no
  // canonical spelling), and on Windows the second reading only denies more.
  const keys: Array<{ readonly key: string; readonly fold: boolean; readonly named: boolean }> = [];
  for (const { path, fold, text, gitName } of candidates) {
    if (path === "") continue;
    if (names !== undefined && text === true && readsAsText(path)) {
      keys.push({ key: floorKey(path, false).toLowerCase(), fold, named: false });
      continue;
    }
    const key = floorKey(path, fold);
    if (
      names === undefined &&
      ((gitName === "text" && namesInsideGitDirectory(key)) ||
        (gitName === "workspace" && insideWorkspace(key) && namesGitDirectory(key)))
    ) {
      return { root: GIT_DIRECTORY };
    }
    keys.push({ key, fold, named: true });
    if (DRIVE_PATH.test(path)) keys.push({ key: floorKey(path, fold, false), fold, named: true });
  }
  if (names !== undefined) {
    for (const { key, named } of keys) {
      if (named && names(key.slice(key.lastIndexOf("/") + 1))) return { root: key };
    }
  }
  for (const root of roots) {
    if (root.trim() === "") continue;
    const plain = floorKey(root, false);
    if (values === undefined && NAMES_IN_TEXT.has(plain)) continue;
    const folded = floorKey(root, true);
    for (const { key, fold } of keys) {
      if (liesUnder(key, fold ? folded : plain)) return { root };
    }
    if (insideOnly || !insideWorkspace(plain)) continue;
    for (const { key, fold, opensHidden } of walked) {
      const rootKey = fold ? folded : plain;
      if (!rootKey.startsWith(`${key}/`)) continue;
      // A walk that skips hidden names never opens a root behind one.
      const below = rootKey.slice(key.length + 1).split("/");
      if (opensHidden || !below.some((name) => name.startsWith("."))) return { root, above: key };
    }
  }
  return undefined;
}

/**
 * Decide allow/deny/ask for one tool call. Pure.
 */
export function evaluate(
  call: ToolCallContext,
  mode: PermissionMode,
  rules: RuleSet,
  opts: EvaluateOptions = {},
): Decision {
  return evaluateWithReason(call, mode, rules, opts).decision;
}

/**
 * Section 18 — full structured form. Returns `decision` plus an optional
 * `reason` (always populated on a `requiresSandbox` denial). Pure.
 */
export function evaluateWithReason(
  call: ToolCallContext,
  mode: PermissionMode,
  rules: RuleSet,
  opts: EvaluateOptions = {},
): DecisionDetails {
  if (mode === "bypass") return { decision: "allow" };
  // 0.8.0 — the runtime-state floor (`EvaluateOptions.protectedRoots`): no
  // rule, in any source, lets the agent's own tools write the record the
  // gates read as evidence, or the files that decide what the agent may do
  // next. The reason says what the floor saw — a path inside a root, or a
  // directory the call acts beneath that holds one — and that the tool is
  // not read-only; it does not guess whether the call reads or writes there.
  const floorHit = protectedRootHit(call, opts);
  if (floorHit?.root === GIT_DIRECTORY) {
    return {
      decision: "deny",
      reason: `\`${call.toolName}\` is not read-only and names a path inside a repository's git directory, which belongs to git and to the person running it — no rule can allow that`,
    };
  }
  if (floorHit !== undefined) {
    const RECORD =
      "the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles) or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory)";
    return {
      decision: "deny",
      reason:
        floorHit.above !== undefined
          ? `\`${call.toolName}\` is not read-only and acts on everything beneath \`${floorHit.above}\`, where ${RECORD} — no rule can allow that`
          : `\`${call.toolName}\` is not read-only and names a path where ${RECORD} — no rule can allow that`,
    };
  }
  // A store's own files (`EvaluateOptions.protectedFiles`): only its own tools
  // write them, so a path one names is refused whatever a rule says.
  if (protectedFileHit(call, opts) !== undefined) {
    return {
      decision: "deny",
      reason: `\`${call.toolName}\` is not read-only and names a file a store keeps for itself (the continuity store's focus, goals, plans and handoff), which only that store's own tools write — no rule can allow that`,
    };
  }
  // A run that answers people other than its operator keeps these files from
  // its tools (`EvaluateOptions.credentialRoots`), read-only calls included.
  if (credentialHit(call, opts) !== undefined) {
    return {
      decision: "deny",
      reason: `\`${call.toolName}\` names a credential file this run keeps from its tools — no rule can allow that`,
    };
  }
  if (mode === "plan") {
    // permission-integration#6 — plan mode used to consult no rule at all,
    // so an operator's explicit deny on a read-only egress tool (HttpPaginate,
    // SseRead, …) did nothing there. Deny and ask rules are read first, and
    // both deny (plan mode has no one to ask). Allow rules are still ignored:
    // plan mode can never be widened, only narrowed.
    const guard = firstMatchingRule(call, rules, (type) => type !== "alwaysAllow");
    if (guard !== undefined) {
      return {
        decision: "deny",
        reason:
          guard.type === "alwaysDeny"
            ? `plan mode: the rule alwaysDeny ${guard.pattern} (${guard.source}) denies \`${call.toolName}\``
            : `plan mode: the rule alwaysAsk ${guard.pattern} (${guard.source}) needs a person to approve \`${call.toolName}\`, and plan mode cannot ask, so it is denied`,
      };
    }
    if (!call.readOnly) return { decision: "deny" };
    // The sandbox floor holds here too. A read-only tool that runs in a
    // sandbox is refused in auto mode when there is none, so plan mode —
    // which must never be wider than auto — refuses it as well.
    if (call.requiresSandbox === true && opts.sandboxAvailable !== true) {
      return { decision: "deny", reason: noSandboxReason(call.toolName) };
    }
    return { decision: "allow" };
  }

  // Section 18 production safety floor: a tool that declared
  // `requiresSandbox` cannot be allowed unless (a) a rule explicitly
  // matched AND (b) a non-noop sandbox is available. We compute the
  // base decision first so ruleHit is already known.
  const hit = firstMatchingRule(call, rules, () => true);
  let baseDecision: Decision | undefined =
    hit !== undefined ? ruleTypeToDecision(hit.type) : undefined;

  if (baseDecision === undefined) {
    // No rule matched: mode-specific fallback.
    if (mode === "auto") {
      if (call.readOnly) baseDecision = "allow";
      else if (call.destructive) baseDecision = "ask";
      else baseDecision = "allow";
    } else {
      // mode === "default"
      baseDecision = "ask";
    }
  }

  if (call.requiresSandbox === true) {
    if (opts.sandboxAvailable !== true) {
      return { decision: "deny", reason: noSandboxReason(call.toolName) };
    }
    if (baseDecision !== "allow") {
      return {
        decision: "deny",
        reason: `tool "${call.toolName}" requires an explicit alwaysAllow rule (sandbox-floor — default mode does not auto-grant requiresSandbox tools)`,
      };
    }
  }
  return { decision: baseDecision };
}

/**
 * Pillar 3 intent gate — verdict from a justification judge.
 */
export type JustificationVerdict = {
  /** True if the justification is consistent with the session's stated goal. */
  readonly allow: boolean;
  /** Short human-readable rationale. Always present; lands in audit-log. */
  readonly reason: string;
  /** Confidence in [0, 1] when the judge supplies it; undefined for binary judges. */
  readonly confidence?: number;
  /** Judge model identifier — `"rule-based"` for the default, otherwise the
   *  LLM model name supplied by the runtime. */
  readonly judgeModel: string;
};

/**
 * Pillar 3 intent gate — interface a judge function implements. Sync OR
 * async; runtime-core awaits the return. Implementations:
 *   - `ruleBasedJustificationJudge` (default; deterministic for tests)
 *   - LLM-backed judge supplied by runtime-core when the spec opts in
 *
 * The session-goal string is the agent's declared task (typically the user
 * message that started the run, or a planner-emitted summary). The judge
 * compares the justification to the goal; deciding factors are
 * implementation-specific.
 */
export type JustificationJudge = (input: {
  readonly toolName: string;
  readonly justification: string;
  readonly sessionGoal: string;
  readonly input: unknown;
}) => Promise<JustificationVerdict> | JustificationVerdict;

/**
 * Default rule-based judge. Deterministic, no LLM call, suitable for tests
 * and for low-stakes deployments where rough intent checking is enough.
 *
 * Heuristics (intentionally simple — production should override with an
 * LLM-backed judge):
 *   - Justification length < 16 chars → deny ("too brief to be meaningful")
 *   - Goal not provided → allow with low confidence (no signal to check
 *     against; the audit trail still captures the justification verbatim)
 *   - Otherwise: token overlap. The justification's lowercase token set
 *     must share ≥ 1 non-stopword token with the session goal's set.
 *     Tightens too easily under polysemy; an LLM judge replaces this
 *     entirely when wired.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "for",
  "on",
  "at",
  "by",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "i",
  "you",
  "we",
  "they",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "my",
  "your",
  "our",
  "their",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "would",
  "should",
  "could",
  "may",
  "might",
  "can",
  "will",
  "shall",
  "must",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export const ruleBasedJustificationJudge: JustificationJudge = (input) => {
  if (input.justification.length < 16) {
    return {
      allow: false,
      reason: `justification too brief (${input.justification.length} chars); supply at least 16 characters of explanation`,
      confidence: 1.0,
      judgeModel: "rule-based",
    };
  }
  if (input.sessionGoal.length === 0) {
    return {
      allow: true,
      reason: "no session goal supplied to compare against; justification captured verbatim",
      confidence: 0.0,
      judgeModel: "rule-based",
    };
  }
  const justTokens = tokenize(input.justification);
  const goalTokens = tokenize(input.sessionGoal);
  let overlap = 0;
  for (const t of justTokens) if (goalTokens.has(t)) overlap += 1;
  if (overlap === 0) {
    return {
      allow: false,
      reason: `justification shares no salient tokens with session goal (justification: ${justTokens.size} tokens, goal: ${goalTokens.size} tokens, overlap: 0)`,
      confidence: 0.7,
      judgeModel: "rule-based",
    };
  }
  return {
    allow: true,
    reason: `${overlap} token(s) overlap between justification and session goal`,
    confidence: Math.min(1, overlap / 3),
    judgeModel: "rule-based",
  };
};

/**
 * Model id reported by `ruleBasedJustificationJudge`. The verdict that the
 * default judge emits is tagged with this so the evaluation site can tell a
 * rule-based verdict apart from an LLM-backed one after the fact.
 */
export const RULE_BASED_JUDGE_MODEL = "rule-based";

/**
 * One-time guard so the rule-based-judge weakness warning fires at most once
 * per process. Module-level (mirrors `adapter-anthropic`'s
 * `warnedAboutCliFallback`) so repeated tool calls in a long run don't spam.
 */
let warnedAboutRuleBasedJudge = false;

/**
 * Test-only: reset the one-time warning guard. The warning latches for the
 * lifetime of the process, which is correct in production but makes
 * order-independent assertions in the test suite impossible. Not part of the
 * supported runtime surface — callers other than tests should never need it.
 */
export function __resetRuleBasedJudgeWarningForTests(): void {
  warnedAboutRuleBasedJudge = false;
}

/**
 * CWE-807 (#161) — the rule-based judge scores a justification by token
 * overlap against the spec instructions. That text is attacker-influenceable:
 * the SAME (possibly prompt-injected) model that picked the tool also writes
 * the justification, so it can trivially echo a salient goal token and pass.
 * In the default crewhaus run config this judge therefore provides no real
 * protection. We can't safely re-wire the default judge from here (that's a
 * cross-package decision), so instead we make the weakness LOUD: a prominent
 * one-time runtime warning at the evaluation site whenever a rule-based
 * verdict gates a real (non-test) run. An LLM-backed judge reports a different
 * `judgeModel` and does not trip this.
 */
function warnRuleBasedJudgeOnce(toolName: string): void {
  if (warnedAboutRuleBasedJudge) return;
  // `bun test` exercises the rule-based judge constantly; only surface the
  // warning for real runs so test output stays clean.
  if (underTestRunner()) return;
  warnedAboutRuleBasedJudge = true;
  console.warn(
    `[permission-engine] SECURITY: the rule-based justification judge is gating a justification-required tool (first seen: \`${toolName}\`). It only checks token overlap between the justification and the spec instructions, so the SAME (potentially prompt-injected) model that chose the tool can also write a passing justification — this offers NO protection against an injected justification. Production MUST set \`security.justification.judge: claude\` in the spec (or pass an LLM-backed \`justificationJudge\` to the runtime). This warning fires once per process.`,
  );
}

/** A file `bun test` runs: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether this process is the test runner: `bun test` sets `NODE_ENV=test`
 * AND its entry is a test file.
 *
 * `NODE_ENV=test` alone used to be enough. It is an ambient variable — a
 * staging host or a CI job may export it — and a compiled bundle is a
 * distributed artifact that runs wherever it is copied, so a bundle started
 * under it accepted the rule-based judge's gameable `allow` on every
 * justification-gated call (0.7.1 review). A bundle's entry is its
 * `agent.ts`, and `crewhaus run`'s is the CLI, so neither is ever the test
 * runner whatever NODE_ENV says; an operator who wants the rule-based judge
 * sets CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1.
 */
function underTestRunner(): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  const bun = (globalThis as { readonly Bun?: { readonly main?: unknown } }).Bun;
  const entry = typeof bun?.main === "string" ? bun.main : process.argv?.[1];
  return typeof entry === "string" && TEST_FILE.test(entry);
}

/**
 * Evaluate a justification under the supplied judge. Convenience wrapper
 * so runtime-core does not have to handle the sync-or-async ambiguity.
 *
 * Side effect (#161): when the resolved verdict came from the rule-based judge
 * and this is a real (non-test) run, emit a prominent one-time warning that the
 * rule-based judge is no defence against a justification written by the same
 * model. See `warnRuleBasedJudgeOnce`.
 */
/**
 * Whether a rule-based `allow` verdict should be overridden to deny. The
 * rule-based judge scores a justification by token overlap with the goal, but
 * the SAME (prompt-injectable) model that picked the tool also writes the
 * justification, so an `allow` from it is no real authorization. We therefore
 * fail CLOSED in production: a justification-required tool is denied unless an
 * LLM-backed judge is configured (it reports a different judgeModel and is
 * never overridden). Two escape hatches keep this from being a hard break:
 *   - the test runner (see {@link underTestRunner}) keeps the judge
 *     deterministic for the test suite;
 *   - `CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1` lets an operator explicitly
 *     accept the rule-based judge's weakness in production.
 */
function ruleBasedShouldFailClosed(): boolean {
  if (underTestRunner()) return false;
  if (process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] === "1") return false;
  return true;
}

export async function evaluateJustification(
  input: {
    readonly toolName: string;
    readonly justification: string;
    readonly sessionGoal: string;
    readonly input: unknown;
  },
  judge: JustificationJudge = ruleBasedJustificationJudge,
): Promise<JustificationVerdict> {
  const verdict = await Promise.resolve(judge(input));
  if (verdict.judgeModel === RULE_BASED_JUDGE_MODEL) {
    warnRuleBasedJudgeOnce(input.toolName);
    if (verdict.allow && ruleBasedShouldFailClosed()) {
      return {
        allow: false,
        reason:
          "justification denied (fail-closed): the default rule-based judge is gameable by the same model that wrote the justification, so its `allow` is not trustworthy. Configure security.justification.judge: claude (an LLM-backed judge), or set CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1 to explicitly accept the rule-based judge.",
        judgeModel: RULE_BASED_JUDGE_MODEL,
      };
    }
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Config parsing — security-critical. Bypass is excluded from the parser.
// ---------------------------------------------------------------------------

const ruleSchema = z
  .object({
    type: z.enum(["alwaysAllow", "alwaysDeny", "alwaysAsk"]),
    pattern: z.string().min(1),
  })
  .strict();

const configSchema = z
  .object({
    mode: z.enum(["default", "plan", "auto"]).optional(), // bypass intentionally absent
    rules: z.array(ruleSchema).optional(),
  })
  .strict();

export type ParsedPermissionsConfig = {
  readonly mode?: Exclude<PermissionMode, "bypass">;
  readonly rules: ReadonlyArray<{ readonly type: RuleType; readonly pattern: string }>;
};

/**
 * Parse a permissions config from a YAML or JSON config file.
 *
 * SECURITY: an explicit string check on `mode === "bypass"` runs *before* Zod
 * so the error message is friendly regardless of the bytestream's structure.
 * Defense in depth: even if that check were missing, the Zod schema doesn't
 * include "bypass" in its enum and would reject it on its own.
 */
export function parsePermissionsConfig(
  raw: unknown,
  source: "yaml" | "settings",
): ParsedPermissionsConfig {
  if (raw === null || raw === undefined) return { rules: [] };

  if (typeof raw === "object" && "mode" in raw) {
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === "bypass") {
      throw new PermissionConfigError(
        `bypass mode cannot be set from ${source}: only the --permission-mode bypass CLI flag is permitted`,
      );
    }
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermissionConfigError(
      `permissions config (${source}) failed validation:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
      parsed.error,
    );
  }

  return {
    mode: parsed.data.mode,
    rules: parsed.data.rules ?? [],
  };
}

/**
 * Convenience: tag parsed rules with a source for use in a RuleSet. The CLI
 * uses this after `parsePermissionsConfig`.
 */
export function tagRules(
  rules: ReadonlyArray<{ type: RuleType; pattern: string }>,
  source: RuleSource,
): ReadonlyArray<PermissionRule> {
  return rules.map((r) => ({ type: r.type, pattern: r.pattern, source }));
}

// ---------------------------------------------------------------------------
// #383 — the `settings`-source file. `<harnessDir>/.crewhaus/settings.json`'s
// `permissions` sub-object is the operator-owned rule layer that outranks the
// spec's `yaml` rules without touching the spec: the CLI has always read it
// for `crewhaus run`/`serve`, runtime-core now loads it for every surface
// (so compiled daemons honor it too), and the approval surfaces persist
// standing allows into it (`crewhaus approvals grant --always`, the Slack
// "Always allow" button).
// ---------------------------------------------------------------------------

/** The settings file's path relative to a harness root. */
export const SETTINGS_RELATIVE_PATH = join(".crewhaus", "settings.json");

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Absolute settings path for a harness root. */
export function settingsFilePath(dir: string): string {
  return join(dir, SETTINGS_RELATIVE_PATH);
}

/**
 * Parse the top-level JSON of a settings file, keeping the whole root so
 * unrelated keys (`hooks`, …) survive a write-back. Throws
 * {@link PermissionConfigError} on malformed JSON or a non-object root —
 * fail closed: a file that cannot be read must not silently drop an
 * operator's `alwaysDeny`, and a write-back must never clobber a file it
 * could not understand.
 */
function readSettingsRoot(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PermissionConfigError(`cannot read settings file ${path}`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PermissionConfigError(`settings file ${path} is not valid JSON`, err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PermissionConfigError(`settings file ${path} must hold a JSON object at the root`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Load the `settings`-source permission rules from
 * `<dir>/.crewhaus/settings.json`. Missing file → `[]`. Only the
 * `permissions` sub-object is consulted (so `hooks` and other settings keys
 * never trip the strict validator); its shape is the same
 * `{ mode?, rules? }` the spec's `permissions:` block uses, and
 * `mode: bypass` is rejected here exactly as it is for yaml. Malformed JSON
 * or an invalid permissions config THROWS {@link PermissionConfigError} —
 * fail closed, matching the CLI's behavior when it reads the same file.
 */
export function loadSettingsRules(dir: string): ReadonlyArray<PermissionRule> {
  const root = readSettingsRoot(settingsFilePath(dir));
  if (root === undefined) return [];
  const parsed = parsePermissionsConfig(root["permissions"], "settings");
  return tagRules(parsed.rules, "settings");
}

/**
 * Append one permission rule to `<dir>/.crewhaus/settings.json`'s
 * `permissions.rules`, creating the file (and `.crewhaus/`) when absent and
 * preserving every unrelated key on write-back. Deduped on
 * `(type, pattern)` — re-appending an existing rule is a no-op. The write is
 * atomic (tmp + rename) so a concurrently-booting run never reads a torn
 * file. This is the persistence half of a standing allow: the approval
 * surfaces call it with `{ type: "alwaysAllow", pattern: <toolName> }` when
 * an operator grants an approval with `--always`.
 *
 * Throws {@link PermissionConfigError} when the existing file is malformed —
 * never overwrite a file we could not parse.
 */
export function appendSettingsRule(
  dir: string,
  rule: { readonly type: RuleType; readonly pattern: string },
): { readonly added: boolean; readonly path: string } {
  const path = settingsFilePath(dir);
  const root = readSettingsRoot(path) ?? {};
  // Validate what is already there before writing next to it.
  const existing = parsePermissionsConfig(root["permissions"], "settings");
  if (existing.rules.some((r) => r.type === rule.type && r.pattern === rule.pattern)) {
    return { added: false, path };
  }
  const permissionsRoot =
    typeof root["permissions"] === "object" && root["permissions"] !== null
      ? (root["permissions"] as Record<string, unknown>)
      : {};
  const next = {
    ...root,
    permissions: {
      ...permissionsRoot,
      rules: [
        ...existing.rules.map((r) => ({ type: r.type, pattern: r.pattern })),
        { type: rule.type, pattern: rule.pattern },
      ],
    },
  };
  // 0.7.1 — a random O_EXCL|O_NOFOLLOW temp beside the file, never the fixed
  // `settings.json.tmp`, which was opened through any link a model had
  // planted there. A settings.json that links elsewhere in the workspace is
  // written where it leads; one that leads out of it is refused.
  //
  // `.crewhaus` itself may be a link an operator made to keep a harness's
  // state elsewhere; rules are read through it, so they are written through
  // it too: it is then the root, as it is for the session and routing stores.
  mkdirSync(dir, { recursive: true });
  const crewhausDir = join(dir, ".crewhaus");
  const linkedStateDir = isSymlink(crewhausDir);
  const written = writeFileSafe(
    linkedStateDir ? crewhausDir : dir,
    linkedStateDir ? "settings.json" : SETTINGS_RELATIVE_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    {
      overwrite: true,
      createParents: true,
      leafSymlink: "follow-contained",
    },
  );
  if (!written.ok) {
    throw new PermissionConfigError(`cannot write settings file ${path}: ${written.reason}`);
  }
  return { added: true, path };
}
