/**
 * What a harness IS (its spec, its shape), what its bundle's freshness
 * verdict MEANS, and which `crewhaus` binary would run for it.
 *
 * None of the three questions is answered here. The spec is parsed by
 * `@crewhaus/spec`, the freshness verdict comes from
 * `@crewhaus/harness-supervisor`'s `bundleStaleness` — the spec-hash stamp
 * comparison the manager itself gates a daemon start on — and the binary
 * comes from the supervisor's `resolveCrewhausBin`. This module CLASSIFIES
 * those answers, which is a different job and the one the tools need:
 *
 *   FRESH means the bundle was compiled from this exact spec.
 *   STALE means it was compiled from a different one.
 *   UNDETERMINED means neither could be established.
 *
 * The third is the whole point. `bundleStaleness` has six states, and two of
 * them — `unstamped` (no spec-hash stamp and no usable mtime pair) and
 * `unknown` (no bundle found, or a spec that could not be read) — are not
 * verdicts at all. `compileIfStale` recompiles on `stale`/`approximate-stale`
 * and carries on for everything else with `{ ok: true, replan: false }`, so a
 * caller that reports its success as "the bundle is current" reports an
 * undetermined bundle as a fresh one. That is how a fleet ends up running
 * last month's CLI with every status line green.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type BundleFreshness,
  bundleStaleness,
  findSpecPath,
  resolveBundle,
  resolveCrewhausBin,
} from "@crewhaus/harness-supervisor";
import { parseSpec, parseSpecIssues } from "@crewhaus/spec";
import type { SafePath } from "../paths";
import { type Loaded, containUnder, fail, isInside, renderPath, renderText } from "./result";

/** A spec is YAML a human wrote; anything past this is not one. */
const MAX_SPEC_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// the spec, and the target that decides which entry file a bundle has
// ---------------------------------------------------------------------------

export type SpecFacts = {
  /** Absolute path of the spec file that was read. */
  readonly specPath: string;
  readonly name?: string;
  /** The shape. `resolveBundle` needs it to know whether the bundle's entry
   *  is `daemon.ts` or `agent.ts`. */
  readonly target: string;
};

/**
 * The harness's spec file, CONTAINED.
 *
 * `findSpecPath` is the supervisor's own discovery (which of the two
 * filenames, in which order) and is kept. What is added is the gate: the
 * path it hands back is a path a STORE produced, not one a caller passed
 * containment for, and `existsSync` follows a symlink — so
 * `<harness>/crewhaus.yaml -> /elsewhere/secret.yaml` resolves, parses, and
 * comes back as this harness's identity. Contained here, once, so every
 * caller of this module gets the same answer.
 *
 * `{ ok: true, value: undefined }` means there is no spec — a fact, not a
 * failure. A refusal means there is one and it leads out of the workspace.
 */
export function containedSpecPath(tool: string, harness: SafePath): Loaded<SafePath | undefined> {
  const found = findSpecPath(harness.real);
  if (found === undefined) return { ok: true, value: undefined };
  const safe = containUnder(tool, harness, toRel(harness, found));
  if (!safe.ok) return safe;
  return { ok: true, value: safe.value };
}

/** A path under the harness, as the containment gate wants it. */
function toRel(harness: SafePath, abs: string): string {
  const rel = relative(harness.real, abs);
  return rel === "" ? "." : rel.split(/[\\/]/).join("/");
}

/**
 * Read a harness's spec and take its `target` from the PARSED document.
 *
 * Never from a line scan of the text. The supervisor picks the bundle entry
 * file from `target`, so a target read out of a spec that does not parse
 * would send the freshness check looking for the wrong file and report
 * "no compiled bundle found" for a bundle that is sitting right there. A
 * spec that will not parse is its own answer, with the parser's first issue
 * attached.
 */
export function readSpecFacts(tool: string, harness: SafePath): Loaded<SpecFacts> {
  const contained = containedSpecPath(tool, harness);
  if (!contained.ok) return contained;
  if (contained.value === undefined) {
    return fail("missing", "no crewhaus.yaml (or crewhaus.yml) at the harness root");
  }
  const specPath = contained.value.real;
  let size: number;
  try {
    size = statSync(specPath).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail("unreadable", `the spec could not be read (${code ?? "unknown error"})`);
  }
  if (size > MAX_SPEC_BYTES) {
    return fail("unreadable", `the spec is larger than ${MAX_SPEC_BYTES} bytes`);
  }
  let text: string;
  try {
    text = readFileSync(specPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail("unreadable", `the spec could not be read (${code ?? "unknown error"})`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseSpec(text) as unknown as Record<string, unknown>;
  } catch {
    const issue = parseSpecIssues(text)[0];
    const where =
      issue === undefined ? "" : issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return fail(
      "bad-input",
      `the spec does not parse (${where}${issue?.message ?? "unknown issue"}) — its target is unknown, so which file a compiled bundle should have cannot be determined`,
    );
  }
  const target = parsed["target"];
  if (typeof target !== "string" || target === "") {
    return fail("bad-input", "the spec parsed but carries no target");
  }
  const name = parsed["name"];
  // BOUNDED AND PRINTABLE. Both strings are spec text this package did not
  // write: they are reported to a model AND (for `HarnessRegister`) written
  // into the machine-wide registry, where every later reader inherits them.
  // A `name` carrying newlines or a kilobyte of prose is not an identity.
  return {
    ok: true,
    value: {
      specPath,
      ...(typeof name === "string" && name !== "" ? { name: renderText(name) } : {}),
      target: renderText(target),
    },
  };
}

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

export type Verdict = "fresh" | "stale" | "undetermined";

/**
 * Every state the library can return, mapped to a verdict — as a SWITCH, so
 * that a state added upstream fails to compile here.
 *
 * This is the one mapping in the package that must never acquire a default
 * branch: with a `Set` of undetermined states and an `else` meaning "fresh",
 * a seventh state invented next release would land silently in "fresh", and
 * a verdict that defaults to fresh is the exact failure this package exists
 * to prevent. The `never` assignment is what makes a new state a build
 * error instead.
 *
 * `unknown`: no bundle found at all, or a spec that could not be read.
 * `unstamped`: no spec-hash stamp AND no pair of mtimes to fall back on.
 * Neither says anything about whether the bundle matches the spec.
 */
function verdictFor(state: BundleFreshness["state"]): Verdict {
  switch (state) {
    case "fresh":
    case "approximate-fresh":
      return "fresh";
    case "stale":
    case "approximate-stale":
      return "stale";
    case "unstamped":
    case "unknown":
      return "undetermined";
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

/**
 * Verdicts on which `compileIfStale` actually recompiles.
 *
 * MIRRORS `STALE_STATES` in `harness-supervisor/src/prepare.ts`, which is a
 * module-private constant — this package cannot import it. It is used only
 * to PREDICT, and the prediction is checked against what the real call did
 * (see `CompileBundle`: a predicted recompile that produced no `replan` is
 * reported as a disagreement rather than as a success), so a drift shows up
 * as a loud result field instead of a quiet wrong answer.
 */
const RECOMPILE_STATES: ReadonlySet<BundleFreshness["state"]> = new Set([
  "stale",
  "approximate-stale",
]);

export type FreshnessView = {
  /** The library's own state, verbatim. */
  readonly state: BundleFreshness["state"];
  readonly verdict: Verdict;
  /** True only for the two hash-compared states — the library's own flag. */
  readonly exact: boolean;
  readonly label: string;
  /** Would `compileIfStale` recompile on this verdict? */
  readonly wouldRecompile: boolean;
  /** The crewhaus version whose emitters produced the bundle, when stamped. */
  readonly compiledWith?: string;
};

export function classify(freshness: BundleFreshness): FreshnessView {
  const state = freshness.state;
  return {
    state,
    verdict: verdictFor(state),
    exact: freshness.exact,
    label: freshness.label,
    wouldRecompile: RECOMPILE_STATES.has(state),
    // BOUNDED AND PRINTABLE at the source. `compiledWith` is a string the
    // bundle's own `package.json` supplied — anyone who can write a bundle
    // writes it — and it ends up both in a row and as a KEY in
    // `CliVersionPin`'s version roll-up.
    ...(freshness.compiledWith !== undefined
      ? { compiledWith: renderText(freshness.compiledWith, 120) }
      : {}),
  };
}

export type ContainedBundle = {
  /** Absolute bundle dir, contained. */
  readonly bundleDir: string;
  readonly entryPath: string;
  /** The bundle dir relative to the harness, `/`-separated — the `-o` a
   *  recompile is given, and the name a write gate has to contain. */
  readonly outDirRel: string;
};

/**
 * Where the compiled bundle is — with every name a read OR a recompile
 * touches proven to be inside the workspace.
 *
 * `resolveBundle` is the supervisor's own search (`dist`, `build`, then the
 * harness root) and is kept. What is added is the gate on what it hands
 * back: `join` does not resolve symlinks, so `<harness>/dist -> /elsewhere`
 * comes back as `<harness>/dist` and every later step follows the link.
 * That matters twice. The freshness reader OPENS `<bundleDir>/package.json`
 * and the entry. And `compileIfStale` spawns
 * `crewhaus compile <spec> -o dist` with the harness as its cwd, then
 * `bun install --cwd <bundleDir>` — so a symlinked `dist` is a WRITE
 * straight out of the workspace, performed by a child process this tool
 * cannot contain after the fact. Refused here, before either happens.
 *
 * `{ ok: true, value: undefined }` means there is no bundle.
 */
export function containedBundle(
  tool: string,
  harness: SafePath,
  target: string,
): Loaded<ContainedBundle | undefined> {
  const found = resolveBundle(harness.real, target);
  if (found === undefined) return { ok: true, value: undefined };
  const outDirRel = toRel(harness, found.bundleDir);
  const dir = containUnder(tool, harness, outDirRel);
  if (!dir.ok) return dir;
  // The DIRECTORY being contained says nothing about the two names inside it
  // the stamp reader opens and a compile replaces.
  for (const leaf of [found.entry, "package.json"]) {
    const under = outDirRel === "." ? leaf : `${outDirRel}/${leaf}`;
    const safe = containUnder(tool, harness, under);
    if (!safe.ok) return safe;
  }
  return {
    ok: true,
    value: { bundleDir: found.bundleDir, entryPath: found.entryPath, outDirRel },
  };
}

/**
 * The supervisor's stamp comparison for one harness, classified — once every
 * file it will open has been contained.
 *
 * GATE, THEN DELEGATE. `bundleStaleness` re-runs `findSpecPath` and
 * `resolveBundle` itself and opens what they return; re-deriving its verdict
 * here from `bundleFreshness` would be a second copy of the rule this
 * package exists not to have. So the same two locators are run FIRST, purely
 * to contain their answers, and the library is called unchanged only when
 * both stay inside the workspace.
 */
export function freshnessOf(
  tool: string,
  harness: SafePath,
  target: string,
): Loaded<{ readonly freshness: FreshnessView; readonly bundle: ContainedBundle | undefined }> {
  const spec = containedSpecPath(tool, harness);
  if (!spec.ok) return spec;
  const bundle = containedBundle(tool, harness, target);
  if (!bundle.ok) return bundle;
  // The located bundle travels with the verdict so a caller does not run the
  // gate a second time to learn where the bundle is — one gate, one answer.
  return {
    ok: true,
    value: { freshness: classify(bundleStaleness(harness.real, target)), bundle: bundle.value },
  };
}

// ---------------------------------------------------------------------------
// the CLI that would run
// ---------------------------------------------------------------------------

export type CliResolution = {
  /** Absolute path of the binary, as the supervisor's resolver returned it. */
  readonly bin: string;
  /** Which of the resolver's two sources answered. */
  readonly where: "harness-local" | "PATH";
  /** True when the binary (with its symlinks followed) is inside the
   *  workspace this tool is contained to. */
  readonly inWorkspace: boolean;
  /** The path after following symlinks, when it differs. */
  readonly real?: string;
};

/** Follow symlinks where possible; a path that cannot be resolved is its
 *  own answer, not an error — it is about to be reported, not opened. */
function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Which `crewhaus` would run for this harness, and whether executing it
 * stays inside the workspace.
 *
 * The resolution itself is `resolveCrewhausBin`'s — harness-local
 * `node_modules/.bin/crewhaus` first, then PATH — so the binary reported is
 * the binary a `daemon start --compile` would spawn. The `where` label is
 * derived by comparing against the harness-local candidate rather than by
 * re-implementing the search.
 */
export function resolveCli(harnessRoot: string, workspaceRoot: string): CliResolution | undefined {
  const bin = resolveCrewhausBin(harnessRoot);
  if (bin === undefined) return undefined;
  const local = join(harnessRoot, "node_modules", ".bin", "crewhaus");
  const real = realOrSame(bin);
  return {
    bin,
    where: bin === local ? "harness-local" : "PATH",
    inWorkspace: isInside(workspaceRoot, real),
    ...(real !== bin ? { real } : {}),
  };
}

/**
 * Refuse to EXECUTE a binary that sits outside the workspace unless the
 * caller said so.
 *
 * Containment is about the paths a tool opens, and a globally installed
 * `crewhaus` on `PATH` is one this tool did not get from the caller and
 * cannot contain. Rather than pretend (either by refusing every real machine
 * or by quietly running whatever `PATH` resolved), the refusal names the
 * path it would have run and the flag that allows it.
 */
export function externalBinRefusal(
  cli: CliResolution,
  allowExternal: boolean,
): { readonly reason: string } | undefined {
  if (allowExternal || cli.inWorkspace) return undefined;
  return {
    reason: `the crewhaus CLI that would run resolves to "${renderPath(cli.real ?? cli.bin)}", outside the workspace root. Pass allowExternalCli:true to run it; this tool does not execute a binary it cannot contain without being told to.`,
  };
}

// ---------------------------------------------------------------------------
// the environment a spawned step gets
// ---------------------------------------------------------------------------

/**
 * The names forwarded to a compile by default.
 *
 * DELIBERATELY NOT the harness's merged `.env` chain, which is what the
 * manager hands a compile. A compile reads a spec and writes a bundle; it
 * has no business holding the harness's provider keys, and a tool that
 * spawns with them makes every compile a place a credential can leak into a
 * log. The cost is named in the README: a harness whose `bun install` needs
 * a private-registry token has to forward it by name.
 */
const BASE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SHELL"] as const;

export function spawnEnv(
  forward: readonly string[] = [],
  source: Readonly<Record<string, string | undefined>> = process.env,
): { readonly env: Record<string, string>; readonly forwarded: string[] } {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  const forwarded: string[] = [];
  for (const key of forward) {
    const value = source[key];
    if (typeof value !== "string") continue;
    env[key] = value;
    forwarded.push(key);
  }
  return { env, forwarded: forwarded.sort() };
}
