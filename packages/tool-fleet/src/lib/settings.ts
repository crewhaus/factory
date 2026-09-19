/**
 * The `manager` block of `<harness>/.crewhaus/settings.json`: reading what
 * is declared, reporting what it PARSES to, and replacing one hook without
 * losing the rest of the file.
 *
 * The parse rules are `@crewhaus/harness-supervisor`'s and are not repeated
 * here: `parseManagerHook` decides what a declaration means,
 * `readManagerSettings` fills in the defaults, `resolveHookCommand` decides
 * what a command resolves against, `DEFAULT_HOOK_TIMEOUT_MS` is the timeout
 * a hook gets when none is declared. This module adds the two things a
 * supervisor's tolerant reader deliberately does not have.
 *
 * FIRST, THE FILE'S CONDITION. `readManagerSettings` answers a file that is
 * missing, malformed, or carrying a `manager` key of the wrong type with the
 * same empty defaults — correct for a spawn path that must not die on a
 * typo, useless for an operator asking "are my hooks set up?", and dangerous
 * for a WRITE: re-serializing the defaults over a file that failed to parse
 * would throw away the operator's own JSON, and the file is shared with the
 * runtime's `hooks` and `permissions` blocks.
 *
 * SECOND, THE GAP BETWEEN A DECLARATION AND ITS ARGV. A STRING declaration
 * is ONE command name — the supervisor does not word-split it, on purpose
 * (`"splitting is the first half of implementing a shell"`). So
 * `"bun run prep.ts"` declares a command whose FILENAME is `bun run prep.ts`,
 * which no `spawn` will ever find; the hook then refuses every start with an
 * ENOENT nobody connects back to the settings file. Every report here shows
 * the parsed `argv`, not the spelling, and a write that would create that
 * shape is refused with the array form spelled out.
 */
import {
  constants,
  accessSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type ManagerHook,
  type ManagerHookName,
  parseManagerHook,
  resolveHookCommand,
} from "@crewhaus/harness-supervisor";
import { MANAGER_SETTINGS_SEGMENTS } from "@crewhaus/harness-supervisor";
import { type Loaded, fail, probeName, renderPath, renderStorePath, renderText } from "./result";

/** `<harness>/.crewhaus/settings.json`, from the supervisor's own segments. */
export function settingsRelPath(): string {
  return MANAGER_SETTINGS_SEGMENTS.join("/");
}

export function settingsAbsPath(harnessRoot: string): string {
  return join(harnessRoot, ...MANAGER_SETTINGS_SEGMENTS);
}

/** A settings file a human owns; anything past this is not one. */
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024;

export type SettingsState = "absent" | "ok" | "unparseable" | "not-a-file" | "unreadable";

export type SettingsProbe = {
  readonly state: SettingsState;
  readonly path: string;
  readonly detail?: string;
  /** The whole document, when it parsed — every key, including the ones
   *  this package knows nothing about. */
  readonly doc?: Record<string, unknown>;
  /** The file's current mode, so a rewrite can preserve it. */
  readonly mode?: number;
};

export function probeSettings(abs: string, shown: string): SettingsProbe {
  const kind = probeName(shown, abs);
  if (!kind.ok) return { state: "unreadable", path: shown, detail: kind.reason };
  if (kind.value === undefined) return { state: "absent", path: shown };
  if (kind.value === "directory" || kind.value === "other") {
    return { state: "not-a-file", path: shown, detail: `it is a ${kind.value}, not a file` };
  }
  let text: string;
  let mode: number | undefined;
  try {
    const stat = statSync(abs);
    if (stat.size > MAX_SETTINGS_BYTES) {
      return {
        state: "unreadable",
        path: shown,
        detail: `larger than ${MAX_SETTINGS_BYTES} bytes`,
      };
    }
    mode = stat.mode & 0o777;
    text = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      state: "unreadable",
      path: shown,
      detail: `could not be read (${code ?? "unknown error"})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      state: "unparseable",
      path: shown,
      detail: `not valid JSON (${err instanceof Error ? err.message : "parse error"})`,
      ...(mode !== undefined ? { mode } : {}),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      state: "unparseable",
      path: shown,
      detail: "the document is not a JSON object",
      ...(mode !== undefined ? { mode } : {}),
    };
  }
  return {
    state: "ok",
    path: shown,
    doc: parsed as Record<string, unknown>,
    ...(mode !== undefined ? { mode } : {}),
  };
}

/** A settings file a write may proceed against: absent, or parsed. */
export function writeBlockedBy(probe: SettingsProbe): Loaded<undefined> {
  if (probe.state === "ok" || probe.state === "absent") return { ok: true, value: undefined };
  return fail(
    probe.state === "unparseable" ? "refused" : "unreadable",
    `"${probe.path}" ${probe.detail ?? probe.state} — refusing to rewrite it. The file is shared with the runtime's own hooks and permissions blocks, and a rewrite of a document this tool could not read would discard them. A settings file that could not be parsed is not an empty one.`,
  );
}

// ---------------------------------------------------------------------------
// what a declaration parses to
// ---------------------------------------------------------------------------

export type CommandState =
  | "executable" // the resolved file exists and has the execute bit
  | "not-executable" // it is there, but a spawn will fail with EACCES
  | "absent" // the path resolves to nothing — every start will refuse
  | "unreadable" // could not be determined
  | "path-lookup"; // a bare name: the OS resolves it at spawn time

export type HookView = {
  readonly name: ManagerHookName;
  /** The declaration verbatim. */
  readonly declaredAs: string;
  /** What the supervisor will actually spawn. */
  readonly argv: readonly string[];
  /** argv[0] resolved the way the supervisor resolves it. */
  readonly command: string;
  readonly commandState: CommandState;
  readonly detail?: string;
  /** Set when the declaration parses to something the operator did not mean. */
  readonly warning?: string;
};

/**
 * Whether the command a hook declares can be run — WITHOUT running it.
 *
 * A bare name is left to the OS: `resolveHookCommand` does not touch it, so
 * the answer depends on the PATH of whatever process spawns the hook, which
 * is not this one. Reporting "absent" for it would be a guess; `path-lookup`
 * is the honest answer.
 */
export function probeCommand(command: string): { state: CommandState; detail?: string } {
  if (!isAbsolute(command)) return { state: "path-lookup" };
  const kind = probeName(command, command);
  if (!kind.ok) return { state: "unreadable", detail: kind.reason };
  if (kind.value === undefined) {
    return { state: "absent", detail: "nothing exists at that path" };
  }
  // WHAT THE NAME IS, before asking whether it can be executed. `access(…,
  // X_OK)` on a DIRECTORY succeeds — the execute bit on a directory means
  // "may be traversed" — so a hook declared as `./prep.sh` when `prep.sh` is
  // a directory reads back `executable` here and then refuses every start of
  // the harness with EACCES. The probe exists to catch exactly that before
  // it is written.
  if (kind.value === "directory" || kind.value === "other") {
    return {
      state: "not-executable",
      detail: `it is a ${kind.value}, not a file — a spawn of it fails with EACCES`,
    };
  }
  if (kind.value === "symlink") {
    // `lstat` answered about the LINK. A dangling one is `absent`, not a
    // permission problem, and a link to a directory is the case above.
    let through: ReturnType<typeof statSync>;
    try {
      through = statSync(command);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { state: "absent", detail: "a symlink whose target does not exist" }
        : {
            state: "unreadable",
            detail: `the symlink could not be followed (${code ?? "unknown"})`,
          };
    }
    if (!through.isFile()) {
      return {
        state: "not-executable",
        detail: "a symlink to something that is not a file — a spawn of it fails with EACCES",
      };
    }
  }
  try {
    accessSync(command, constants.X_OK);
    return { state: "executable" };
  } catch {
    return { state: "not-executable", detail: "the file has no execute permission for this user" };
  }
}

/**
 * A string declaration containing whitespace is a single command NAME.
 *
 * This is the shape that reads as working and never runs: the operator
 * writes `"bun run prep.ts"`, the supervisor spawns a file called
 * `bun run prep.ts`, the spawn fails with ENOENT and the start is refused.
 * The check is on the PARSED argv, not on the spelling — a one-element argv
 * whose single element contains whitespace — so it cannot be fooled by how
 * the value was written.
 */
export function splitWarning(argv: readonly string[]): string | undefined {
  const only = argv.length === 1 ? argv[0] : undefined;
  if (only === undefined || !/\s/.test(only)) return undefined;
  return `declared as ONE command whose name contains whitespace ("${renderPath(only)}"). The supervisor never word-splits a string declaration, so it will spawn a file with that exact name and the start will be refused. Declare the array form instead, e.g. ["${renderPath(only).split(/\s+/).join('", "')}"].`;
}

/**
 * One hook, parsed, resolved and probed.
 *
 * The declaration is operator-authored JSON this package did not write, so
 * the strings it reports are bounded and stripped of control characters. The
 * PROBE and the resolution run on the raw `command` — the rendered copy is
 * for the result only, never for a decision.
 */
export function viewHook(name: ManagerHookName, hook: ManagerHook, harnessRoot: string): HookView {
  const command = resolveHookCommand(harnessRoot, hook.argv[0] as string);
  const probed = probeCommand(command);
  const warning = splitWarning(hook.argv);
  return {
    name,
    declaredAs: renderText(hook.declaredAs, 400),
    argv: hook.argv.map((part) => renderText(part, 400)),
    command: renderStorePath(command),
    commandState: probed.state,
    ...(probed.detail !== undefined ? { detail: probed.detail } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

/** Parse a caller's declaration with the supervisor's own parser. */
export function parseDeclaration(value: string | readonly string[]): Loaded<ManagerHook> {
  const hook = parseManagerHook(Array.isArray(value) ? [...value] : value);
  if (hook === undefined) {
    return fail(
      "bad-input",
      "the declaration parses to no command at all — @crewhaus/harness-supervisor's parseManagerHook drops empty strings and entries that are not non-empty strings, and a hook it cannot parse is silently NO hook",
    );
  }
  return { ok: true, value: hook };
}

// ---------------------------------------------------------------------------
// editing the document
// ---------------------------------------------------------------------------

/** The `manager` object of a parsed document, when it has a usable one. */
export function managerBlock(doc: Record<string, unknown>): Loaded<Record<string, unknown>> {
  const manager = doc["manager"];
  if (manager === undefined) return { ok: true, value: {} };
  if (typeof manager !== "object" || manager === null || Array.isArray(manager)) {
    return fail(
      "refused",
      `the "manager" key is ${Array.isArray(manager) ? "an array" : typeof manager}, not an object — the supervisor ignores it entirely and writing into it would replace whatever it holds`,
    );
  }
  return { ok: true, value: manager as Record<string, unknown> };
}

/**
 * The document with ONE hook set or removed, everything else preserved.
 *
 * Preservation is the point: `settings.json` also carries the runtime's
 * `hooks` and `permissions` blocks and whatever a newer CLI writes, and this
 * package knows nothing about any of it. So the document is spread, the
 * `manager` block is spread, the `hooks` block is spread, and exactly one
 * key changes.
 */
export function withHook(
  doc: Record<string, unknown>,
  manager: Record<string, unknown>,
  name: ManagerHookName,
  value: string | readonly string[] | undefined,
  timeoutMs?: number,
): Record<string, unknown> {
  const rawHooks = manager["hooks"];
  const hooks: Record<string, unknown> =
    typeof rawHooks === "object" && rawHooks !== null && !Array.isArray(rawHooks)
      ? { ...(rawHooks as Record<string, unknown>) }
      : {};
  if (value === undefined) delete hooks[name];
  else hooks[name] = Array.isArray(value) ? [...value] : value;
  if (timeoutMs !== undefined) hooks["timeoutMs"] = timeoutMs;
  return { ...doc, manager: { ...manager, hooks } };
}

/** The timeout a hook will really get, and whether it is the default. */
export function timeoutView(timeoutMs: number): { ms: number; isDefault: boolean } {
  return { ms: timeoutMs, isDefault: timeoutMs === DEFAULT_HOOK_TIMEOUT_MS };
}

/**
 * Write the document atomically: a temp file in the same directory, then a
 * rename.
 *
 * The rename is what makes it atomic, and it is also what makes the
 * containment check on BOTH names load-bearing — a rename replaces whatever
 * the destination name points at. The caller has already contained them.
 *
 * The mode is preserved when the file existed (a rename would otherwise
 * silently re-permission an operator's file), and a new file is created 0600
 * like every other crewhaus-written settings artifact.
 */
export function writeSettingsFile(
  tmpAbs: string,
  finalAbs: string,
  doc: Record<string, unknown>,
  mode: number | undefined,
): Loaded<undefined> {
  try {
    // A harness that has never been supervised has no `.crewhaus` at all —
    // the common case for the FIRST hook anyone declares — and writing the
    // temp file into a directory that does not exist fails with ENOENT. 0700
    // is the mode every other crewhaus state directory is created with.
    mkdirSync(dirname(finalAbs), { recursive: true, mode: 0o700 });
    writeFileSync(tmpAbs, `${JSON.stringify(doc, null, 2)}\n`, { mode: mode ?? 0o600 });
    renameSync(tmpAbs, finalAbs);
    return { ok: true, value: undefined };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(
      "unreadable",
      `the settings file could not be written (${code ?? "unknown error"})`,
    );
  }
}
