/**
 * HM-12 — first-boot onboarding and demo mode.
 *
 * An empty Library is the worst first impression the console can make: it
 * looks broken, and it teaches nothing. Two answers, both here.
 *
 * **The scan-root picker.** `suggestScanRoots` proposes the directories a
 * harness is most likely to be under — the conventional `~/harnesses`, the
 * directory the manager was started from, and anything `CREWHAUS_*` already
 * points at — each with the reason it is being suggested and whether it
 * actually exists. Suggesting is all it does; adding a root is a registry
 * write the operator makes.
 *
 * **Demo mode.** `installStarter` copies one starter out of a local checkout
 * of the demos repo and registers it, so a machine with nothing on it has a
 * live console in a minute. Deliberately a COPY of a local checkout and not
 * a network clone: this server has no business fetching and executing code
 * from the internet on an operator's machine, the compiled binary would have
 * to carry git, and the refusal when no checkout is present is a better
 * teacher than a progress bar — it names the repo, the env var, and the CLI
 * verb that does the same job.
 *
 * Everything the copy touches is containment-checked per FILE, in both
 * directions (a starter's own tree can hold a symlink, and so can the
 * destination), and the copy is capped by file count and byte total so a
 * mis-aimed source cannot walk a whole home directory into a new harness.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SAFE_SEGMENT_RE } from "./constants";
import { resolveContained, resolveInside } from "./safety";

/** Where the demos checkout is looked for, when not passed explicitly. */
export const DEMOS_DIR_ENV = "CREWHAUS_DEMOS_DIR";

/** Caps on a starter copy — a starter is a handful of small files. */
export const MAX_DEMO_FILES = 400;
export const MAX_DEMO_BYTES = 8 * 1024 * 1024;

/** Never copied: build output, dependency trees, VCS metadata, and any
 *  state a previous run left behind (a demo starts clean). */
const SKIP_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".crewhaus",
  ".env",
  ".env.local",
  ".DS_Store",
]);

/**
 * Names the copy will consider. Wider than `SAFE_SEGMENT_RE` by exactly one
 * thing — a leading dot — because `.env.example` and `.gitignore` are part
 * of what makes a starter a working example, and narrower than the
 * filesystem by refusing `..` and any separator. It is a SHAPE guard only:
 * the realpath containment in `resolveInside`/`resolveContained` is what
 * actually keeps the copy inside both trees.
 */
const COPYABLE_NAME_RE = /^\.?[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export type ScanRootSuggestion = {
  readonly dir: string;
  readonly exists: boolean;
  /** Why this directory is being suggested. */
  readonly why: string;
};

/**
 * Directories worth offering as scan roots, most conventional first.
 * De-duplicated, and never more than a handful — a picker with twenty rows
 * is a file browser, which is not what first boot needs.
 */
export function suggestScanRoots(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
  cwd: string,
  existsFn: (dir: string) => boolean = existsSync,
): readonly ScanRootSuggestion[] {
  const out: ScanRootSuggestion[] = [];
  const seen = new Set<string>();
  const add = (dir: string, why: string): void => {
    if (dir === "" || !isAbsolute(dir)) return;
    const key = resolve(dir);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ dir: key, exists: existsFn(key), why });
  };
  add(join(homeDir, "harnesses"), "the conventional home for harnesses");
  add(cwd, "the directory this manager was started from");
  const demos = env[DEMOS_DIR_ENV];
  if (typeof demos === "string" && demos !== "") {
    add(join(demos, "starters"), `starters in the demos checkout ${DEMOS_DIR_ENV} points at`);
  }
  const projects = env["CREWHAUS_HARNESS_ROOT"];
  if (typeof projects === "string" && projects !== "") {
    add(projects, "CREWHAUS_HARNESS_ROOT is set in this manager's environment");
  }
  return out;
}

export type DemoAvailability = {
  readonly available: boolean;
  /** The resolved demos checkout, when one was found. */
  readonly source: string | null;
  /** Starter directory names, sorted. Empty when unavailable. */
  readonly starters: readonly string[];
  /** Why demo mode cannot run, when it cannot. */
  readonly reason: string | null;
  /** What the operator can do about it — always populated when unavailable. */
  readonly remedy: string | null;
};

const NO_CHECKOUT_REMEDY =
  "clone https://github.com/crewhaus/demos and point CREWHAUS_DEMOS_DIR at it, or scaffold a harness directly with `crewhaus init <dir>`";

/**
 * Find the demos checkout and list its starters. Absence is not an error:
 * the answer says what is missing and what to do about it.
 */
export function demoAvailability(
  env: Readonly<Record<string, string | undefined>>,
  explicitDir?: string,
): DemoAvailability {
  const dir = explicitDir ?? env[DEMOS_DIR_ENV];
  if (typeof dir !== "string" || dir === "") {
    return {
      available: false,
      source: null,
      starters: [],
      reason: `no demos checkout configured (${DEMOS_DIR_ENV} is unset)`,
      remedy: NO_CHECKOUT_REMEDY,
    };
  }
  const root = resolve(dir);
  const startersDir = resolveInside(root, ["starters"]);
  if (startersDir === undefined || !existsSync(startersDir)) {
    return {
      available: false,
      source: root,
      starters: [],
      reason: `${root} has no starters/ directory — that is not a demos checkout`,
      remedy: NO_CHECKOUT_REMEDY,
    };
  }
  let names: string[];
  try {
    names = readdirSync(startersDir);
  } catch {
    return {
      available: false,
      source: root,
      starters: [],
      reason: `${startersDir} is unreadable`,
      remedy: NO_CHECKOUT_REMEDY,
    };
  }
  const starters = names
    .filter((n) => SAFE_SEGMENT_RE.test(n))
    .filter((n) => {
      const path = resolveInside(root, ["starters", n, "crewhaus.yaml"]);
      return path !== undefined && existsSync(path);
    })
    .sort();
  if (starters.length === 0) {
    return {
      available: false,
      source: root,
      starters: [],
      reason: `${startersDir} holds no starter with a crewhaus.yaml`,
      remedy: NO_CHECKOUT_REMEDY,
    };
  }
  return { available: true, source: root, starters, reason: null, remedy: null };
}

export type StarterInstall = {
  readonly dir: string;
  readonly starter: string;
  readonly filesCopied: number;
  readonly bytesCopied: number;
};

export class StarterInstallError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "StarterInstallError";
    this.remedy = remedy;
  }
}

const within = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Copy one starter into `destDir`.
 *
 * Refuses rather than merges: a destination that already holds files is an
 * existing harness or an existing project, and quietly overlaying a starter
 * on top of one is the kind of "helpful" write that loses work.
 */
export function installStarter(args: {
  readonly demosDir: string;
  readonly starter: string;
  readonly destDir: string;
}): StarterInstall {
  const { starter } = args;
  if (!SAFE_SEGMENT_RE.test(starter)) {
    throw new StarterInstallError("invalid starter name", "pick one of the listed starters");
  }
  const demosDir = resolve(args.demosDir);
  const sourceDir = resolveInside(demosDir, ["starters", starter]);
  if (sourceDir === undefined || !existsSync(sourceDir)) {
    throw new StarterInstallError(
      `no starter "${starter}" in ${join(demosDir, "starters")}`,
      "pick one of the listed starters",
    );
  }
  const destDir = resolve(args.destDir);
  if (!isAbsolute(destDir)) {
    throw new StarterInstallError("destination must be an absolute path", "give a full path");
  }
  if (within(demosDir, destDir)) {
    throw new StarterInstallError(
      "destination is inside the demos checkout",
      "install the demo somewhere else — a harness under a git checkout of demos would be committed by accident",
    );
  }
  if (existsSync(destDir)) {
    let entries: string[];
    try {
      entries = readdirSync(destDir);
    } catch {
      throw new StarterInstallError(`${destDir} is unreadable`, "choose another directory");
    }
    if (entries.length > 0) {
      throw new StarterInstallError(
        `${destDir} is not empty`,
        "choose an empty or not-yet-existing directory — demo mode never writes over existing files",
      );
    }
  }

  let filesCopied = 0;
  let bytesCopied = 0;

  const walk = (relSegments: readonly string[]): void => {
    const from = resolveInside(sourceDir, relSegments);
    if (from === undefined) return; // a symlink out of the starter tree
    let names: string[];
    try {
      names = readdirSync(from).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_NAMES.has(name) || !COPYABLE_NAME_RE.test(name)) continue;
      const childRel = [...relSegments, name];
      const childFrom = resolveInside(sourceDir, childRel);
      if (childFrom === undefined) continue;
      // lstat, not stat: a symlink inside the starter is not followed, it is
      // skipped. Copying through one would put a file the operator never saw
      // into a directory they are about to register as a harness.
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(childFrom);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const childTo = resolveContained(destDir, childRel.join("/"));
        if (childTo === undefined) continue;
        mkdirSync(childTo, { recursive: true });
        walk(childRel);
        continue;
      }
      if (!info.isFile()) continue;
      if (filesCopied >= MAX_DEMO_FILES) {
        throw new StarterInstallError(
          `starter "${starter}" holds more than ${MAX_DEMO_FILES} files`,
          "that is not a starter — check CREWHAUS_DEMOS_DIR points at a demos checkout",
        );
      }
      if (bytesCopied + info.size > MAX_DEMO_BYTES) {
        throw new StarterInstallError(
          `starter "${starter}" exceeds ${MAX_DEMO_BYTES} bytes`,
          "that is not a starter — check CREWHAUS_DEMOS_DIR points at a demos checkout",
        );
      }
      const childTo = resolveContained(destDir, childRel.join("/"));
      if (childTo === undefined) continue;
      copyFileSync(childFrom, childTo);
      filesCopied += 1;
      bytesCopied += info.size;
    }
  };

  mkdirSync(destDir, { recursive: true });
  walk([]);
  const spec = join(destDir, "crewhaus.yaml");
  if (!existsSync(spec)) {
    throw new StarterInstallError(
      `copied ${filesCopied} file(s) but no crewhaus.yaml landed in ${destDir}`,
      "the source does not look like a starter — check the demos checkout",
    );
  }
  return { dir: destDir, starter, filesCopied, bytesCopied };
}

export type OnboardingView = {
  /** True when there is nothing to look at yet: no harnesses AND no roots. */
  readonly firstBoot: boolean;
  readonly harnessCount: number;
  readonly scanRootCount: number;
  readonly suggestions: readonly ScanRootSuggestion[];
  readonly demo: DemoAvailability;
  /** ISO-8601 when onboarding was completed/dismissed, or null. */
  readonly completedAt: string | null;
  /** The CLI twins for each step — the console shows the command it runs. */
  readonly cliTwins: Readonly<Record<string, string>>;
};

/** Assemble the first-boot view. Pure given its inputs. */
export function onboardingView(args: {
  readonly harnessCount: number;
  readonly scanRootCount: number;
  readonly suggestions: readonly ScanRootSuggestion[];
  readonly demo: DemoAvailability;
  readonly completedAt: string | null;
}): OnboardingView {
  return {
    firstBoot: args.harnessCount === 0 && args.scanRootCount === 0,
    harnessCount: args.harnessCount,
    scanRootCount: args.scanRootCount,
    suggestions: args.suggestions,
    demo: args.demo,
    completedAt: args.completedAt,
    // Every one of these is shown beside a copy button on the FIRST screen a
    // new operator sees, so every one has to run. `crewhaus harness` has no
    // `scan-root` verb — the dispatch accepts list|show|add|remove|relocate|
    // group|tag|pin|scan|preflight — and `harness scan --root <dir>` is the
    // true equivalent of the button next to it: `harnessScan` remembers the
    // root (`addScanRoot`) before it walks. `cli-twins.test.ts` checks these
    // against the CLI's own dispatch so the pair cannot drift apart again.
    cliTwins: {
      addScanRoot: "crewhaus harness scan --root <dir>",
      scan: "crewhaus harness scan",
      addHarness: "crewhaus harness add <dir>",
      demo: "cp -R <demos>/starters/<starter> <dir> && crewhaus harness add <dir>",
      list: "crewhaus harness list",
    },
  };
}

/** Existence check used by the route layer (kept here so the module owns
 *  every filesystem question onboarding asks). */
export function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
