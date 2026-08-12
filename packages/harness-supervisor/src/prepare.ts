/**
 * The seam between "decide to start" and "spawn": an opt-in recompile of a
 * stale bundle, and the operator's own hooks around it.
 *
 * ```
 * plan → claim the slot → [compile if stale] → [postCompile hook]
 *      → preflight → [preSpawn hook] → spawn
 * ```
 *
 * Both steps exist because a supervised fleet lost something the standalone
 * `run.sh` wrappers it replaced already had:
 *
 *   - **Nothing recompiles for you** (HANGAR.md is explicit about it), and a
 *     stale bundle was only ever REPORTED. Forget one recompile after a spec
 *     edit and the daemon restarts on the OLD bundle with no error — silent
 *     staleness, the worst failure mode there is. `--compile` /
 *     `manager.autoCompile` closes it without changing the default: the
 *     manager still never mutates a bundle unless asked.
 *   - **There was no hook point.** Operators sometimes need a deterministic
 *     step between compile and spawn — patching the emitted bundle,
 *     pre-warming an asset, generating a config artifact. `daemon start`
 *     spawned the existing bundle directly, a console compile job silently
 *     discarded whatever the operator had patched in, and `restart` rebuilt
 *     the spawn plan but never re-ran operator prep. That left convention
 *     ("always run prep.sh from the terminal first") where a contract
 *     belongs — and one forgotten prep after a spec edit quietly broke every
 *     write until the next manual pass.
 *
 * **Refusals are refusals.** A hook that exits non-zero refuses the start
 * exactly like a blocking preflight finding, carrying its own captured
 * output rather than a generic "hook failed" — a prep step that cannot run
 * must not be waved past into a spawn that will misbehave in a way nobody
 * connects back to it.
 *
 * **Hooks run operator-authored code with the harness's own environment** —
 * the merged spawn env, exactly what `run.sh` gets today. The harness
 * directory is already the supervision trust boundary: whoever can write
 * `.crewhaus/settings.json` can already write the spec, the `.env` chain and
 * `run.sh`. (This is a different contract from `@crewhaus/hooks-engine`,
 * whose RUNTIME hooks fire on model-driven moments and therefore get a
 * deliberately restricted env.) Nothing extra is needed for the console's
 * `--read-only` posture: that mode refuses every mutating request, so no
 * start and no compile job reaches this module at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type BundleFreshness, bundleFreshness } from "./bundle-freshness";
import {
  type ManagerHook,
  type ManagerHookName,
  type ManagerSettings,
  readManagerSettings,
} from "./manager-settings";
import type { ProcessOps } from "./process-ops";
import { runDir } from "./runfiles";
import { type Scrubber, createEnvScrubber } from "./scrub";
import { findSpecPath, resolveBundle } from "./spawn-contracts";
import { type Clock, systemClock } from "./types";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Which step refused. Named, because the three have different remedies. */
export type PrepareStage = "compile" | ManagerHookName;

export type PrepareRefusal = {
  readonly stage: PrepareStage;
  /** One line an operator can act on. */
  readonly message: string;
  readonly exitCode?: number;
  /** The step's own last words — its stderr/stdout tail, ALREADY SCRUBBED.
   *  A prep step runs with the merged spawn env, so `set -x` or a chatty
   *  installer can echo a credential; scrubbing happens once here, at the
   *  capture, exactly like the run-log pump, so no caller can forget.
   *  Empty when it produced none. */
  readonly output: readonly string[];
};

export type PrepareOutcome =
  | {
      readonly ok: true;
      /** True when the bundle changed under the plan, so the caller must
       *  rebuild it before spawning. */
      readonly replan: boolean;
      /** What happened, for the operator ("recompiled", "postCompile ok"). */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

const NOTHING_HAPPENED: PrepareOutcome = { ok: true, replan: false, notes: [] };

/** How much of a step's output is kept for the refusal. Bounded: a hook that
 *  prints a megabyte must not be the reason a manager runs out of memory. */
export const HOOK_OUTPUT_LINES = 40;
const HOOK_OUTPUT_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Running one command
// ---------------------------------------------------------------------------

export type CommandOutcome = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: readonly string[];
  /** True when the timeout fired and the child was killed. */
  readonly timedOut: boolean;
};

export type RunCommandInput = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly ops: ProcessOps;
  readonly clock?: Clock;
  readonly timeoutMs: number;
  /** Applied to every captured line. Defaults to a scrubber over `env` —
   *  the same construction the run-log pump uses. */
  readonly scrub?: Scrubber;
};

/**
 * Run one command to completion, capturing a bounded tail of its combined
 * output.
 *
 * PIPED, not redirected to the run log: this runs BEFORE the run exists (a
 * hook that refuses means there is no run to attach the output to), and the
 * output has to come back as data so a refusal can quote it.
 */
export async function runPrepareCommand(input: RunCommandInput): Promise<CommandOutcome> {
  const clock = input.clock ?? systemClock;
  const scrub = input.scrub ?? createEnvScrubber(input.env);
  const child = input.ops.spawn({
    argv: input.argv,
    cwd: input.cwd,
    env: input.env,
    stdio: { mode: "pipe" },
    // Its own process group: a prep step is a TREE (a `bun run` that spawns
    // a compiler), and killing a wedged one has to reach the whole group.
    detached: true,
  });

  let bytes = 0;
  const lines: string[] = [];
  let partial = "";
  const absorb = (chunk: string): void => {
    if (bytes >= HOOK_OUTPUT_MAX_BYTES) return;
    bytes += chunk.length;
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) {
      // Scrubbed per line, like the run-log pump: the scrubber is the
      // read-side gate and a credential never spans a newline.
      lines.push(scrub(line).trimEnd());
      // A ring buffer, so a chatty step costs a bounded amount of memory
      // however long it runs.
      if (lines.length > HOOK_OUTPUT_LINES) lines.shift();
    }
  };
  const pump = async (stream: AsyncIterable<Uint8Array> | undefined): Promise<void> => {
    if (stream === undefined) return;
    const decoder = new TextDecoder("utf-8");
    try {
      for await (const chunk of stream) absorb(decoder.decode(chunk, { stream: true }));
    } catch {
      // A stream that dies with the child is not a failure of the step; the
      // exit code is the verdict.
    }
  };
  const drained = Promise.all([pump(child.stdout), pump(child.stderr)]);

  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      try {
        input.ops.forceKill(child.pid);
      } catch {
        // Already gone.
      }
    }
  }, input.timeoutMs);
  const { code, signal } = await child.exited;
  clock.clearTimeout(timer);
  await drained;
  if (partial.trim() !== "") {
    lines.push(scrub(partial).trimEnd());
    if (lines.length > HOOK_OUTPUT_LINES) lines.shift();
  }
  return { exitCode: code, signal, output: lines, timedOut };
}

/** Resolve a hook's command against the harness root when it is written as a
 *  path (`./prep.sh`, `../tools/prep.sh`, or absolute); a bare name is left
 *  alone so the OS resolves it on PATH, like any other command. */
export function resolveHookCommand(harnessRoot: string, command: string): string {
  if (isAbsolute(command)) return command;
  if (command.startsWith("./") || command.startsWith("../")) return resolve(harnessRoot, command);
  return command;
}

// ---------------------------------------------------------------------------
// The last-run record
// ---------------------------------------------------------------------------

/** What `harness show` / `daemon status` report about a hook's last run. */
export type HookRunRecord = {
  readonly at: string;
  readonly ok: boolean;
  readonly exitCode?: number;
  /** The declaration that ran, so a record from a since-edited hook is not
   *  mistaken for the current one. */
  readonly declaredAs: string;
};

export type HookRunLog = Partial<Record<ManagerHookName, HookRunRecord>>;

/** `<harness>/.crewhaus/run/hooks.json` — harness-local like every other
 *  supervision record, so it travels with a backup and a relocation. */
export function hookLogPath(harnessDir: string): string {
  return join(runDir(harnessDir), "hooks.json");
}

/** The last run of each hook, or `{}`. Tolerant: an unreadable record is a
 *  missing record, never an error on the start path. */
export function readHookRunLog(harnessDir: string): HookRunLog {
  try {
    const parsed: unknown = JSON.parse(readFileSync(hookLogPath(harnessDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as HookRunLog;
  } catch {
    return {};
  }
}

/** Record a hook run. Atomic (tmp + rename) so a manager killed mid-write
 *  leaves the previous record, never a truncated one. */
export function recordHookRun(
  harnessDir: string,
  name: ManagerHookName,
  record: HookRunRecord,
): void {
  const path = hookLogPath(harnessDir);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const next: HookRunLog = { ...readHookRunLog(harnessDir), [name]: record };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Bookkeeping. A record we cannot write is not a reason to refuse a
    // start whose hook has already succeeded.
  }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

export type PrepareDeps = {
  readonly harnessDir: string;
  readonly target: string;
  readonly ops: ProcessOps;
  /** The MERGED spawn env — what `run.sh` gets today. */
  readonly env: Record<string, string>;
  /** Resolved `crewhaus` CLI; undefined means no compile is possible. */
  readonly crewhausBin: string | undefined;
  readonly clock?: Clock;
  /** `bun`, for `bun install --cwd <bundle>`. */
  readonly bunBin?: string;
  /** Pre-read settings; read from disk when omitted. */
  readonly settings?: ManagerSettings;
};

/** Run one declared hook. Absent hook ⇒ nothing happened. */
export async function runManagerHook(
  name: ManagerHookName,
  hook: ManagerHook | undefined,
  deps: PrepareDeps,
  timeoutMs: number,
): Promise<PrepareOutcome> {
  if (hook === undefined) return NOTHING_HAPPENED;
  const clock = deps.clock ?? systemClock;
  const argv = [resolveHookCommand(deps.harnessDir, hook.argv[0] as string), ...hook.argv.slice(1)];
  let result: CommandOutcome;
  try {
    result = await runPrepareCommand({
      argv,
      cwd: deps.harnessDir,
      env: deps.env,
      ops: deps.ops,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      timeoutMs,
    });
  } catch (err) {
    // The command could not be launched at all (ENOENT on a mistyped path,
    // EACCES on a file without the exec bit). That is the operator's most
    // likely mistake, so it gets its own sentence rather than a stack trace.
    const message = err instanceof Error ? err.message : String(err);
    const at = new Date(clock.now()).toISOString();
    recordHookRun(deps.harnessDir, name, { at, ok: false, declaredAs: hook.declaredAs });
    return {
      ok: false,
      refusal: {
        stage: name,
        message: `${name} hook could not run: ${message}`,
        output: [],
      },
    };
  }
  const at = new Date(clock.now()).toISOString();
  const ok = result.exitCode === 0 && !result.timedOut;
  recordHookRun(deps.harnessDir, name, {
    at,
    ok,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    declaredAs: hook.declaredAs,
  });
  if (ok) return { ok: true, replan: false, notes: [`${name} hook ok (${hook.declaredAs})`] };
  const how = result.timedOut
    ? `timed out after ${timeoutMs} ms and was killed`
    : result.signal !== null
      ? `was killed by ${result.signal}`
      : `exited ${result.exitCode ?? "unknown"}`;
  return {
    ok: false,
    refusal: {
      stage: name,
      message: `${name} hook \`${hook.declaredAs}\` ${how} — the start was refused`,
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      output: result.output,
    },
  };
}

/** The bundle dir a recompile should write to, relative to the harness root:
 *  wherever the CURRENT bundle lives, so a harness that compiles to `build/`
 *  is not silently given a second bundle in `dist/`. */
export function compileOutDir(harnessRoot: string, target: string): string {
  const bundle = resolveBundle(harnessRoot, target);
  if (bundle === undefined) return "dist";
  const rel = relative(harnessRoot, bundle.bundleDir);
  return rel === "" ? "." : rel;
}

/** Is the compiled bundle stale against `crewhaus.yaml`? */
export function bundleStaleness(harnessRoot: string, target: string): BundleFreshness {
  const specPath = findSpecPath(harnessRoot);
  const bundle = resolveBundle(harnessRoot, target);
  if (specPath === undefined || bundle === undefined) {
    return { state: "unknown", exact: false, label: "no compiled bundle found" };
  }
  let specYaml: string;
  try {
    specYaml = readFileSync(specPath, "utf8");
  } catch {
    return { state: "unknown", exact: false, label: "crewhaus.yaml is unreadable" };
  }
  return bundleFreshness({
    specYaml,
    specPath,
    outDir: bundle.bundleDir,
    entryPath: bundle.entryPath,
  });
}

/** Freshness verdicts that mean "recompile before spawning". `unstamped` and
 *  `unknown` deliberately do NOT: recompiling on an inexact verdict would
 *  make every start of an older bundle a compile, which is the nagging the
 *  stamp exists to avoid. */
const STALE_STATES: ReadonlySet<BundleFreshness["state"]> = new Set(["stale", "approximate-stale"]);

/**
 * Recompile when the spec is newer than the bundle. Opt-in — the caller
 * decides whether to ask — and a no-op when the bundle is already current,
 * so `--compile` is safe to leave on in a wrapper script.
 */
export async function compileIfStale(deps: PrepareDeps): Promise<PrepareOutcome> {
  const freshness = bundleStaleness(deps.harnessDir, deps.target);
  if (!STALE_STATES.has(freshness.state)) {
    return { ok: true, replan: false, notes: [`bundle: ${freshness.label}`] };
  }
  if (deps.crewhausBin === undefined) {
    return {
      ok: false,
      refusal: {
        stage: "compile",
        message:
          "the bundle is stale and --compile was asked for, but no `crewhaus` CLI resolves (harness node_modules/.bin, then PATH)",
        output: [],
      },
    };
  }
  const specPath = findSpecPath(deps.harnessDir);
  if (specPath === undefined) {
    return {
      ok: false,
      refusal: { stage: "compile", message: "no crewhaus.yaml at the harness root", output: [] },
    };
  }
  const outDir = compileOutDir(deps.harnessDir, deps.target);
  const compile = await runPrepareCommand({
    argv: [deps.crewhausBin, "compile", specPath, "-o", outDir],
    cwd: deps.harnessDir,
    env: deps.env,
    ops: deps.ops,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    timeoutMs: deps.settings?.hooks.timeoutMs ?? 120_000,
  });
  if (compile.exitCode !== 0) {
    return {
      ok: false,
      refusal: {
        stage: "compile",
        message: `crewhaus compile failed — the bundle is still the stale one (${freshness.label})`,
        ...(compile.exitCode !== null ? { exitCode: compile.exitCode } : {}),
        output: compile.output,
      },
    };
  }
  const notes = [`recompiled ${outDir}/ (was: ${freshness.label})`];

  // A local bundle carries bare `@crewhaus/*` imports and a synthesized
  // manifest that declares them; without the install the entry dies on its
  // first import. Skipped when the compile emitted no manifest (a bundle
  // that sits in an already-installed tree).
  const bundleDir = outDir === "." ? deps.harnessDir : join(deps.harnessDir, outDir);
  if (existsSync(join(bundleDir, "package.json"))) {
    const install = await runPrepareCommand({
      argv: [deps.bunBin ?? "bun", "install", "--cwd", bundleDir],
      cwd: deps.harnessDir,
      env: deps.env,
      ops: deps.ops,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      timeoutMs: deps.settings?.hooks.timeoutMs ?? 120_000,
    });
    if (install.exitCode !== 0) {
      return {
        ok: false,
        refusal: {
          stage: "compile",
          message: `bun install --cwd ${outDir} failed — the fresh bundle cannot resolve its @crewhaus/* imports`,
          ...(install.exitCode !== null ? { exitCode: install.exitCode } : {}),
          output: install.output,
        },
      };
    }
    notes.push(`installed ${outDir}/ dependencies`);
  }
  // The bundle moved under the plan's feet — whoever asked for this has to
  // rebuild the plan before spawning, or it launches the entry it resolved
  // BEFORE the compile.
  return { ok: true, replan: true, notes };
}

// ---------------------------------------------------------------------------
// The composed runner
// ---------------------------------------------------------------------------

export type PrepareRunnerOptions = PrepareDeps & {
  /** Recompile a stale bundle first. Defaults to `manager.autoCompile`; the
   *  CLI's `--compile` flag forces it on for one start. */
  readonly compile?: boolean;
};

export type PrepareRunner = {
  /** compile-if-stale, then the postCompile hook. Runs after the start slot
   *  is claimed and BEFORE preflight, so preflight sees the fresh bundle. */
  prepare(): Promise<PrepareOutcome>;
  /** The preSpawn hook. Runs after preflight and immediately before the
   *  spawn — the last chance to refuse. */
  preSpawn(): Promise<PrepareOutcome>;
  /** Whether either step would do anything, so a caller can skip the wiring
   *  (and a UI can say "no prep configured") without running it. */
  readonly configured: { readonly compile: boolean; readonly hooks: readonly ManagerHookName[] };
};

/**
 * Compose the two seams the supervisor calls. ONE construction, used by both
 * heads: the console's Restart button and `crewhaus daemon restart` run the
 * same steps in the same order, which is the whole point — a contract, not a
 * convention that only the terminal happens to follow.
 */
export function createPrepareRunner(options: PrepareRunnerOptions): PrepareRunner {
  const settings = options.settings ?? readManagerSettings(options.harnessDir);
  const deps: PrepareDeps = { ...options, settings };
  const wantsCompile = options.compile ?? settings.autoCompile;
  const hooks = settings.hooks;

  return {
    configured: {
      compile: wantsCompile,
      hooks: [
        ...(hooks.postCompile !== undefined ? (["postCompile"] as const) : []),
        ...(hooks.preSpawn !== undefined ? (["preSpawn"] as const) : []),
      ],
    },
    prepare: async () => {
      const notes: string[] = [];
      let replan = false;
      if (wantsCompile) {
        const compiled = await compileIfStale(deps);
        if (!compiled.ok) return compiled;
        notes.push(...compiled.notes);
        replan = compiled.replan;
      }
      // The postCompile hook fires on every prepared start, not only the
      // ones that recompiled: its job is to make the bundle on disk correct,
      // and a bundle a console compile job replaced behind the operator's
      // back needs the patch just as much as one this start produced.
      const hooked = await runManagerHook("postCompile", hooks.postCompile, deps, hooks.timeoutMs);
      if (!hooked.ok) return hooked;
      notes.push(...hooked.notes);
      return { ok: true, replan, notes };
    },
    preSpawn: () => runManagerHook("preSpawn", hooks.preSpawn, deps, hooks.timeoutMs),
  };
}

/** Operator-facing lines for a refusal — the same shape `formatGateRefusal`
 *  produces, so a manager renders both the same way. */
export function formatPrepareRefusal(refusal: PrepareRefusal): string[] {
  const lines = [`${refusal.stage} refused the start:`, `  ✗ ${refusal.message}`];
  if (refusal.output.length > 0) {
    lines.push(`  last ${refusal.output.length} line(s) of its output:`);
    for (const line of refusal.output) lines.push(`    │ ${line}`);
  }
  return lines;
}
