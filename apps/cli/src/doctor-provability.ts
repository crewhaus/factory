/**
 * 0.8.0 (design/0.8.0-provability-release.md §10) — the three findings the
 * provability release adds to `crewhaus doctor --philosophy-alignment`.
 * Side-effect-free and handed its repo root, so each finding is unit-tested
 * with a seeded failure in a temp tree (the entry file runs an argv switch on
 * import and cannot be).
 *
 *   1. The citation-marker regex has exactly ONE definition in the tree, and
 *      it lives in `@crewhaus/claim-ledger` (design §4.1). Three packages each
 *      carried a copy before 0.8.0; "two copies of this drift, and then one
 *      tool checks a claim the other never saw" is the rule claim-ledger's own
 *      docblock states.
 *   2. `@crewhaus/provability` imports no model adapter (design §6): every
 *      rung's verifier is deterministic, and the one model-backed step — the
 *      paraphrase-waiver judge — is a callback its caller injects.
 *   3. `provability.level` is not optimizable (design §9.2): an optimizer that
 *      can lower the bar it is graded against learns to blind its critic.
 *
 * Each finding has a stable `(class, file, symbol)` identity, so the
 * drift-watch baseline (`scope-audit-drift.ts`) keeps its id across runs and
 * a NEW copy of the regex — a new file — is a NEW finding the `--baseline`
 * gate fails on.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPTIMIZABLE_PATHS, isOptimizable } from "@crewhaus/spec-patch";
import type { PhilosophyFinding } from "./scope-audit-drift";

/** Where the one definition lives. */
export const CITATION_MARKER_OWNER = "packages/claim-ledger/src/citations.ts";
const OWNER_PACKAGE_SRC = "packages/claim-ledger/src/";
/** The constant's name: a declaration of it anywhere else is a copy. */
export const CITATION_MARKER_NAME = "CITATION_MARKER";

/**
 * The marker pattern's STRUCTURE, matched over a line {@link foldRegexSource}
 * has normalised: an escaped `[`, an optional escaped `^?`, a label, an
 * escaped `]`, and the negative lookahead after it that keeps definitions
 * and links out (claim-ledger's `citations.ts` has the pattern whole). The
 * label is any run of what can match a label character — a character class,
 * a class escape (`\w`, `\d`, `\S`, …), a Unicode property (`\p{L}`) or the
 * `.` wildcard — each quantified or not (`+`, `*`, `?`, `{1,64}`), and
 * alternated or not (folding drops the group around an alternation). Matching
 * the structure, not one spelling, is what catches a copy whose class was
 * reordered (`[\w\-.]`), spelled out (`[A-Za-z0-9_.-]`), narrowed to the
 * numeric `[n]` the provability skill teaches (`\d+`), widened (`\S+?`), or
 * whose group moved before the `^?`. Assembled from pieces, and never spelled
 * out in this file — not even in a comment — because this file's own source
 * would otherwise be the second definition it looks for.
 */
const MARKER_LABEL_ATOM = [
  "C", // a character class, folded
  "\\\\[dwsDWS]", // a class escape
  "\\\\[pP]\\{[\\w=]+\\}", // a Unicode property escape
  "\\.", // the wildcard
].join("|");
const MARKER_QUANTIFIER = "(?:[+*?]|\\{\\d+(?:,\\d*)?\\})";
const MARKER_STRUCTURE = new RegExp(
  [
    "\\\\\\[", // an escaped [
    "(?:\\\\\\^\\?)?", // an optional escaped ^ and its ?
    `(?:(?:${MARKER_LABEL_ATOM})${MARKER_QUANTIFIER}*\\|?)+`, // the label: atoms, quantified, alternated
    "\\\\\\]\\(\\?!", // an escaped ] and a negative lookahead
  ].join(""),
);
const MARKER_DECLARATION = new RegExp(`\\b(?:const|let|var)\\s+${CITATION_MARKER_NAME}\\b`);

/**
 * One source line with a regex's incidental spelling folded away: `\\` →
 * `\` (a `new RegExp("…")` string's doubled backslashes), every character
 * class → `C` (so equivalent classes are one token), and group openers —
 * capturing, `(?:` and named — and every `)` dropped (so a group may sit
 * anywhere). Lookaround openers are kept: the lookahead after the closing
 * bracket is what makes a pattern the MARKER rather than the definition
 * grammar. Applied to code that is not a regex it produces nonsense the
 * structure never matches.
 */
export function foldRegexSource(line: string): string {
  const src = line.replace(/\\\\/g, "\\");
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "\\") {
      out += src.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (c === "[") {
      // To the first unescaped `]` (a leading `]` or `^]` is a literal `]`).
      let j = i + 1;
      if (src[j] === "^") j += 1;
      if (src[j] === "]") j += 1;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) {
        out += src.slice(i);
        break;
      }
      out += "C";
      i = j;
      continue;
    }
    if (c === "(") {
      if (src.startsWith("(?:", i)) {
        i += 2;
        continue;
      }
      if (src.startsWith("(?<", i) && src[i + 3] !== "=" && src[i + 3] !== "!") {
        const close = src.indexOf(">", i);
        if (close !== -1) {
          i = close;
          continue;
        }
      }
      if (src[i + 1] !== "?") continue;
      out += c;
      continue;
    }
    if (c === ")") continue;
    out += c;
  }
  return out;
}

/** Directories under a package that are never source: build output, deps, fixtures. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "__test__",
  "__tests__",
  "__fixtures__",
  "fixtures",
]);

/**
 * A test file: it may quote the pattern to test against it (tool-verify's
 * linear-citations test does). Only `*.test.*`: a `test-helpers.ts` is
 * imported by the suite, and a definition there is a second definition the
 * tests then check claims with.
 */
export function isTestFile(name: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(name);
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;

/** True when one source line defines the citation-marker regex. */
export function markerLine(line: string): boolean {
  if (MARKER_DECLARATION.test(line)) return true;
  return MARKER_STRUCTURE.test(foldRegexSource(line));
}

/** Every non-test source file under the tree's package and app `src/` dirs (and `scripts/`). */
function sourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(repoRoot, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const childRel = `${rel}/${name}`;
      let isDir = false;
      try {
        isDir = statSync(join(repoRoot, childRel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(childRel);
      } else if (SOURCE_FILE.test(name) && !name.endsWith(".d.ts") && !isTestFile(name)) {
        out.push(childRel);
      }
    }
  };
  for (const group of ["packages", "apps"]) {
    let units: string[];
    try {
      units = readdirSync(join(repoRoot, group)).sort();
    } catch {
      continue;
    }
    for (const unit of units) {
      if (existsSync(join(repoRoot, group, unit, "src"))) walk(`${group}/${unit}/src`);
    }
  }
  if (existsSync(join(repoRoot, "scripts"))) walk("scripts");
  return out;
}

export type MarkerDefinition = {
  readonly file: string;
  /** The first defining line. */
  readonly line: number;
  /** Every defining line, in order — a second one in the same file is a copy too. */
  readonly lines: readonly number[];
};

/** Every file that defines the citation-marker regex, with each defining line. */
export function findCitationMarkerDefinitions(repoRoot: string): MarkerDefinition[] {
  const found: MarkerDefinition[] = [];
  for (const file of sourceFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    // Cheap pre-filter: a definition names the constant or has a lookahead.
    if (!text.includes(CITATION_MARKER_NAME) && !text.includes("(?!")) continue;
    const lines: number[] = [];
    text.split("\n").forEach((line, i) => {
      if (markerLine(line)) lines.push(i + 1);
    });
    if (lines.length > 0) found.push({ file, line: lines[0] as number, lines });
  }
  return found;
}

/** The whole audit runs against a factory checkout; anywhere else it says so and passes. */
function notACheckout(
  cls: PhilosophyFinding["class"],
  symbol: string,
  label: string,
): PhilosophyFinding {
  return {
    class: cls,
    file: "",
    symbol,
    label,
    pass: true,
    warn: true,
    reason: "not a factory checkout (no packages/ here) — run from the factory repo root",
  };
}

const MARKER_LABEL =
  "Pillar 2 — the citation-marker regex has exactly one definition (claim-ledger)";

/** Finding 1: one definition, in claim-ledger. */
export function citationMarkerFindings(repoRoot: string): PhilosophyFinding[] {
  if (!existsSync(join(repoRoot, "packages"))) {
    return [notACheckout("single-definition", CITATION_MARKER_NAME, MARKER_LABEL)];
  }
  const defs = findCitationMarkerDefinitions(repoRoot);
  const owner = defs.find((d) => d.file.startsWith(OWNER_PACKAGE_SRC));
  const copies = defs.filter((d) => d !== owner);
  const findings: PhilosophyFinding[] = [];
  if (owner === undefined) {
    findings.push({
      class: "single-definition",
      file: CITATION_MARKER_OWNER,
      symbol: CITATION_MARKER_NAME,
      label: MARKER_LABEL,
      pass: false,
      reason: `${CITATION_MARKER_NAME} is not defined in @crewhaus/claim-ledger — the citation grammar's one owner (design §4.1)${
        copies.length > 0
          ? `; it is defined in ${copies.map((c) => `${c.file}:${c.line}`).join(", ")}`
          : ""
      }`,
    });
  }
  if (owner !== undefined && owner.lines.length > 1) {
    findings.push({
      class: "single-definition",
      file: owner.file,
      symbol: `${CITATION_MARKER_NAME} (second definition)`,
      label: `Pillar 2 — a second citation-marker regex in ${owner.file}`,
      pass: false,
      reason: `${owner.file}:${owner.lines.slice(1).join(", ")} defines the citation-marker pattern again beside line ${owner.line} — derive it from the one constant: two copies drift`,
    });
  }
  for (const copy of copies) {
    findings.push({
      class: "single-definition",
      file: copy.file,
      symbol: CITATION_MARKER_NAME,
      label: `Pillar 2 — a second citation-marker regex at ${copy.file}`,
      pass: false,
      reason: `${copy.file}:${copy.lines.join(", ")} defines the citation-marker pattern again — import the grammar from @crewhaus/claim-ledger instead: two copies drift, and then one tool checks a claim the other never saw`,
    });
  }
  if (findings.length === 0) {
    findings.push({
      class: "single-definition",
      file: CITATION_MARKER_OWNER,
      symbol: CITATION_MARKER_NAME,
      label: MARKER_LABEL,
      pass: true,
    });
  }
  return findings;
}

/**
 * Packages that put a model behind a call: the provider adapters, the eval
 * judge, the model router and model service, the justification judges — and
 * the provider SDKs underneath them. A package that merely DEPENDS on one of
 * these reaches a model too; {@link provabilityModelImportFindings} walks the
 * workspace dependency closure for that, so this list names only the leaves.
 */
const MODEL_PACKAGE =
  /^(?:@crewhaus\/(?:adapter-[\w.-]+|eval-judge|model-router|model-service|justification-judge(?:-[\w.-]+)?)|@anthropic-ai\/[\w.-]+|openai|@google\/genai|@google\/generative-ai|@aws-sdk\/client-bedrock[\w-]*)(?:\/|$)/;

/** True when an import specifier names a model adapter package. */
export function isModelPackage(specifier: string): boolean {
  return MODEL_PACKAGE.test(specifier);
}

/** Import specifiers in a module: static `import … from`, bare `import "…"`, `import()`, `require()`. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1] as string);
  return out;
}

const PROVABILITY_DIR = "packages/provability";
const IMPORT_LABEL = "Pillar 2 — @crewhaus/provability imports no model adapter";
/** The dependency fields that ship: a devDependency is the test suite's business. */
const SHIPPED_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

type WorkspacePackage = { readonly file: string; readonly deps: readonly string[] };

/** Shipped dependency names in a parsed package.json. */
function shippedDeps(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of SHIPPED_FIELDS) {
    const deps = pkg[field];
    if (typeof deps === "object" && deps !== null) out.push(...Object.keys(deps));
  }
  return out;
}

/** Every workspace package (packages/*, apps/*) by name, with its shipped dependencies. */
function workspacePackages(repoRoot: string): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const group of ["packages", "apps"]) {
    let units: string[];
    try {
      units = readdirSync(join(repoRoot, group)).sort();
    } catch {
      continue;
    }
    for (const unit of units) {
      const file = `${group}/${unit}/package.json`;
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as Record<
          string,
          unknown
        >;
        if (typeof pkg["name"] === "string") out.set(pkg["name"], { file, deps: shippedDeps(pkg) });
      } catch {
        // no package.json, or not JSON: not a workspace package
      }
    }
  }
  return out;
}

/** The package an import specifier names: `@scope/name` or `name`, without a subpath. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

/**
 * The shortest dependency chain from workspace package `start` to a model
 * package, through shipped dependencies only (`[start, …, model]`), or
 * undefined when its closure reaches none. Third-party packages are leaves:
 * only workspace package.json files are read.
 */
function modelChain(
  start: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string[] | undefined {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (name !== start && isModelPackage(name)) {
      const chain = [name];
      for (let at = parent.get(name); at !== null && at !== undefined; at = parent.get(at)) {
        chain.unshift(at);
      }
      return chain;
    }
    for (const dep of packages.get(name)?.deps ?? []) {
      if (parent.has(dep)) continue;
      parent.set(dep, name);
      queue.push(dep);
    }
  }
  return undefined;
}

type Offender = { file: string; specifier: string; via?: readonly string[] };

/**
 * Finding 2: nothing provability ships reaches a model — not its package.json
 * dependencies, not its non-test sources' imports, and not through either:
 * the WHOLE workspace dependency closure is walked, so depending on a package
 * that depends on an adapter (`@crewhaus/compiler` reaches model-service) is
 * the same violation as importing the adapter.
 */
export function provabilityModelImportFindings(repoRoot: string): PhilosophyFinding[] {
  if (!existsSync(join(repoRoot, "packages"))) {
    return [notACheckout("import-boundary", "no-model-adapter", IMPORT_LABEL)];
  }
  const pkgPath = join(repoRoot, PROVABILITY_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    return [
      {
        class: "import-boundary",
        file: PROVABILITY_DIR,
        symbol: "no-model-adapter",
        label: IMPORT_LABEL,
        pass: false,
        reason: "packages/provability is missing — the provability ladder did not land",
      },
    ];
  }
  const packages = workspacePackages(repoRoot);
  const offenders: Offender[] = [];
  /** A model package, or a workspace package whose closure reaches one. */
  const check = (file: string, specifier: string): void => {
    if (isModelPackage(specifier)) {
      offenders.push({ file, specifier });
      return;
    }
    const name = packageOf(specifier);
    if (!packages.has(name)) return;
    const via = modelChain(name, packages);
    if (via !== undefined) offenders.push({ file, specifier, via });
  };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    for (const name of shippedDeps(pkg)) check(`${PROVABILITY_DIR}/package.json`, name);
  } catch {
    offenders.push({
      file: `${PROVABILITY_DIR}/package.json`,
      specifier: "(unreadable package.json)",
    });
  }
  for (const file of sourceFiles(repoRoot).filter((f) => f.startsWith(`${PROVABILITY_DIR}/src/`))) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    for (const specifier of new Set(importSpecifiers(text))) check(file, specifier);
  }
  if (offenders.length === 0) {
    return [
      {
        class: "import-boundary",
        file: PROVABILITY_DIR,
        symbol: "no-model-adapter",
        label: IMPORT_LABEL,
        pass: true,
      },
    ];
  }
  return offenders.map((o) => ({
    class: "import-boundary" as const,
    file: o.file,
    symbol: o.specifier,
    label: `Pillar 2 — @crewhaus/provability ${o.via !== undefined ? "reaches a model through" : "imports"} ${o.specifier}`,
    pass: false,
    reason: `${o.file} names ${o.specifier}${
      o.via !== undefined
        ? `, which reaches ${o.via[o.via.length - 1]} (${["@crewhaus/provability", ...o.via].join(" → ")})`
        : ""
    }: the verifiers are deterministic and the one model-backed step (the waiver judge) is a callback the composition root injects — move the model call to @crewhaus/evaluation-service`,
  }));
}

/** The path the optimizer must never move (design §9.2). */
export const PROVABILITY_LEVEL_PATH: ReadonlyArray<string> = ["provability", "level"];
const LEVEL_LABEL = "Pillar 2 — provability.level is not optimizable (OPTIMIZABLE_PATHS)";

/** An entry that names the path exactly — a literal or a one-segment wildcard per segment. */
function namesExactly(entry: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return entry.length === path.length && entry.every((seg, i) => seg === "*" || seg === path[i]);
}

/**
 * An entry for a block ABOVE the path — a proper prefix of it, wildcards
 * honoured (`["provability"]`, `["*"]`): it admits a patch that replaces or
 * removes the whole block, and the block carries the level.
 */
function coversByPrefix(entry: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return (
    entry.length > 0 &&
    entry.length < path.length &&
    entry.every((seg, i) => seg === "*" || seg === path[i])
  );
}

/**
 * Finding 3: no target's whitelist lists `provability.level` (literally or
 * through a wildcard), no entry covers the block above it, and no target's
 * admission rule lets the optimizer patch it. `table` and `admits` are the
 * real ones unless a test seeds a failure.
 *
 * The block entry is read off the TABLE, not asked of `admits`: the real
 * rule refuses the level leaf through `OPTIMIZER_REFUSED_LEAVES` before it
 * looks at any entry, so asking it about the leaf answers "no" whatever the
 * table holds — while a wholesale `["provability"]` entry still admits a
 * patch AT the block (a scalar `provability: cited`, or a `remove`), which
 * moves the floor without naming the leaf (design §9.2).
 */
export function provabilityLevelOptimizerFindings(
  table: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = OPTIMIZABLE_PATHS,
  admits: (target: string, path: ReadonlyArray<string>) => boolean = (target, path) =>
    isOptimizable(target as Parameters<typeof isOptimizable>[0], path),
): PhilosophyFinding[] {
  const listed: string[] = [];
  const admitted: string[] = [];
  for (const [target, entries] of Object.entries(table)) {
    if (entries.some((entry) => namesExactly(entry, PROVABILITY_LEVEL_PATH))) listed.push(target);
    if (
      entries.some((entry) => coversByPrefix(entry, PROVABILITY_LEVEL_PATH)) ||
      admits(target, PROVABILITY_LEVEL_PATH)
    ) {
      admitted.push(target);
    }
  }
  const base = {
    class: "optimizer-exclusion" as const,
    file: "packages/spec-patch/src/index.ts",
    symbol: PROVABILITY_LEVEL_PATH.join("."),
    label: LEVEL_LABEL,
  };
  if (listed.length === 0 && admitted.length === 0) return [{ ...base, pass: true }];
  const parts: string[] = [];
  if (listed.length > 0) parts.push(`listed in OPTIMIZABLE_PATHS for ${listed.join(", ")}`);
  const viaPrefix = admitted.filter((t) => !listed.includes(t));
  if (viaPrefix.length > 0) parts.push(`admitted by a broader entry for ${viaPrefix.join(", ")}`);
  return [
    {
      ...base,
      pass: false,
      reason: `provability.level is ${parts.join("; ")} — the optimizer must never lower the bar it is graded against (design §9.2); remove it, or add it to OPTIMIZER_REFUSED_LEAVES`,
    },
  ];
}

/** All three, in the order the doctor prints them. */
export function provabilityPhilosophyFindings(repoRoot: string): PhilosophyFinding[] {
  return [
    ...citationMarkerFindings(repoRoot),
    ...provabilityModelImportFindings(repoRoot),
    ...provabilityLevelOptimizerFindings(),
  ];
}
