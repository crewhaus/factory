/**
 * Working out which toolchain a project uses, from the project.
 *
 * Detection reads files — a manifest, a lockfile, a config — and never runs
 * anything to find out. Every answer carries a `reason` naming the file that
 * decided it, so a caller can see that the tool did not guess, and correct it
 * with an explicit `command` when the guess is wrong anyway.
 *
 * One rule shapes all of this: a NODE tool is only ever used from the
 * project's own `node_modules/.bin`. `bunx`/`npx` without a local install
 * would DOWNLOAD a package from the registry, which is an outbound network
 * call these tools do not declare and a caller did not ask for. Missing tool,
 * clear refusal. The toolchains that are installed system-wide by convention
 * rather than per project — `go`, `cargo`, `python3`, `ruff` — come from PATH,
 * because there is nowhere else for them to come from.
 */
import * as path from "node:path";
import { parsePackageJson } from "./lib/deps";
import { fileExists, readTextFile } from "./walk";

export type Toolchain = {
  readonly argv: readonly string[];
  /** Which program this is: `vitest`, `tsc`, `biome`, `pytest`, … */
  readonly tool: string;
  /** The file that decided it. */
  readonly reason: string;
  /**
   * Whether the command takes file or directory arguments at all. False for
   * the cargo subcommands, which take their targets from the manifest and
   * fail outright on a trailing path — appending one would turn "lint this
   * project" into an argument error.
   */
  readonly acceptsPaths?: boolean;
};

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** The lockfile in the directory, or the nearest ancestor's, decides. */
export function detectPackageManager(dir: string, root: string): PackageManager {
  for (const candidate of ancestors(dir, root)) {
    if (
      fileExists(path.join(candidate, "bun.lock")) ||
      fileExists(path.join(candidate, "bun.lockb"))
    ) {
      return "bun";
    }
    if (fileExists(path.join(candidate, "pnpm-lock.yaml"))) return "pnpm";
    if (fileExists(path.join(candidate, "yarn.lock"))) return "yarn";
    if (fileExists(path.join(candidate, "package-lock.json"))) return "npm";
  }
  return "npm";
}

/** `dir`, then each ancestor up to and including `root`. */
export function ancestors(dir: string, root: string): string[] {
  const out: string[] = [];
  let current = path.resolve(dir);
  const stop = path.resolve(root);
  while (true) {
    out.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${stop}${path.sep}`)) break;
    current = parent;
  }
  return out;
}

/**
 * A binary in the project's own `node_modules/.bin`, hoisted or not, or
 * `undefined`. Never falls back to PATH for a node tool: a globally installed
 * `tsc` of a different version answering for the project's is exactly the kind
 * of non-reproducible answer these tools exist to avoid.
 */
export function localBinary(dir: string, root: string, name: string): string | undefined {
  for (const candidate of ancestors(dir, root)) {
    const binary = path.join(candidate, "node_modules", ".bin", name);
    if (fileExists(binary)) return binary;
  }
  return undefined;
}

type Manifest = NonNullable<ReturnType<typeof parsePackageJson>>;

/** Read the nearest `package.json` at or above `dir`. */
export function nearestManifest(
  dir: string,
  root: string,
): { manifest: Manifest; dir: string } | undefined {
  for (const candidate of ancestors(dir, root)) {
    const text = readTextFile(path.join(candidate, "package.json"));
    if (text === undefined) continue;
    const manifest = parsePackageJson(text);
    if (manifest !== undefined) return { manifest, dir: candidate };
  }
  return undefined;
}

function hasDependency(manifest: Manifest | undefined, name: string): boolean {
  return manifest?.dependencies.some((d) => d.name === name) ?? false;
}

function anyFile(dir: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (fileExists(path.join(dir, name))) return name;
  }
  return undefined;
}

/** `bun run <script>` / `npm run <script>` and friends. */
export function scriptArgv(manager: PackageManager, script: string): string[] {
  switch (manager) {
    case "bun":
      return ["bun", "run", script];
    case "pnpm":
      return ["pnpm", "run", script];
    case "yarn":
      return ["yarn", "run", script];
    case "npm":
      // `--silent` drops npm's own banner, which otherwise lands in the middle
      // of the JSON a reporter wrote to stdout.
      return ["npm", "run", "--silent", script];
  }
}

// ---------------------------------------------------------------------------
// test runners

/**
 * Which test runner this project uses.
 *
 * Order matters: a project with vitest in its devDependencies and `bun.lock`
 * on disk runs vitest, because the dependency is a statement about the tests
 * and the lockfile is only a statement about the installer.
 */
export function detectTests(
  dir: string,
  root: string,
): Toolchain | { missing: string } | undefined {
  const found = nearestManifest(dir, root);
  const manifest = found?.manifest;

  if (hasDependency(manifest, "vitest") || anyFile(dir, VITEST_CONFIGS) !== undefined) {
    const binary = localBinary(dir, root, "vitest");
    if (binary === undefined) return { missing: "vitest" };
    return {
      argv: [binary, "run", "--reporter=json", "--silent"],
      tool: "vitest",
      reason: hasDependency(manifest, "vitest") ? "vitest in package.json" : "vitest config file",
    };
  }
  if (hasDependency(manifest, "jest") || anyFile(dir, JEST_CONFIGS) !== undefined) {
    const binary = localBinary(dir, root, "jest");
    if (binary === undefined) return { missing: "jest" };
    return {
      argv: [binary, "--json", "--silent"],
      tool: "jest",
      reason: hasDependency(manifest, "jest") ? "jest in package.json" : "jest config file",
    };
  }
  if (fileExists(path.join(dir, "go.mod"))) {
    return { argv: ["go", "test", "-json", "./..."], tool: "go", reason: "go.mod" };
  }
  if (fileExists(path.join(dir, "Cargo.toml"))) {
    return { argv: ["cargo", "test", "--quiet"], tool: "cargo", reason: "Cargo.toml" };
  }
  const pytestMarker = anyFile(dir, ["pytest.ini", "conftest.py", "tox.ini", "setup.cfg"]);
  const pyproject = readTextFile(path.join(dir, "pyproject.toml"));
  if (pytestMarker !== undefined || (pyproject !== undefined && /\[tool\.pytest/.test(pyproject))) {
    return {
      argv: ["python3", "-m", "pytest", "-q", "--no-header", "-rf", "--tb=short"],
      tool: "pytest",
      reason: pytestMarker ?? "pyproject.toml [tool.pytest]",
    };
  }
  if (manifest !== undefined) {
    const script = manifest.scripts["test"];
    if (script !== undefined && /\bbun\s+test\b/.test(script)) {
      return {
        argv: ["bun", "test"],
        tool: "bun",
        reason: "package.json test script runs bun test",
      };
    }
    if (script !== undefined) {
      return {
        argv: scriptArgv(detectPackageManager(dir, root), "test"),
        tool: "script",
        reason: "package.json test script",
      };
    }
  }
  if (fileExists(path.join(dir, "bun.lock")) || fileExists(path.join(dir, "bun.lockb"))) {
    return { argv: ["bun", "test"], tool: "bun", reason: "bun.lock" };
  }
  return undefined;
}

const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
];
const JEST_CONFIGS = ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"];

// ---------------------------------------------------------------------------
// build, typecheck, lint, format

/** The project's build command. */
export function detectBuild(
  dir: string,
  root: string,
): Toolchain | { missing: string } | undefined {
  const found = nearestManifest(dir, root);
  if (found?.manifest.scripts["build"] !== undefined) {
    return {
      argv: scriptArgv(detectPackageManager(dir, root), "build"),
      tool: "script",
      reason: "package.json build script",
    };
  }
  if (fileExists(path.join(dir, "Cargo.toml"))) {
    return { argv: ["cargo", "build", "--quiet"], tool: "cargo", reason: "Cargo.toml" };
  }
  if (fileExists(path.join(dir, "go.mod"))) {
    return { argv: ["go", "build", "./..."], tool: "go", reason: "go.mod" };
  }
  if (fileExists(path.join(dir, "tsconfig.json"))) {
    const binary = localBinary(dir, root, "tsc");
    if (binary === undefined) return { missing: "typescript" };
    return { argv: [binary, "-b", "--pretty", "false"], tool: "tsc", reason: "tsconfig.json" };
  }
  return undefined;
}

/**
 * The project's type checker.
 *
 * `--noEmit` is not optional here and is not a caller's choice: `tsc -b` writes
 * `.tsbuildinfo` and, for a project without `noEmit`, a whole `dist`. A tool
 * that advertises itself as a read gets to stay one. `RunBuild` is where
 * emitting belongs.
 */
export function detectTypecheck(
  dir: string,
  root: string,
): Toolchain | { missing: string } | undefined {
  const tsconfig = anyFile(dir, ["tsconfig.json", "jsconfig.json"]);
  if (tsconfig !== undefined) {
    const binary = localBinary(dir, root, "tsc");
    if (binary === undefined) return { missing: "typescript" };
    return {
      argv: [binary, "--noEmit", "--pretty", "false", "-p", path.join(dir, tsconfig)],
      tool: "tsc",
      reason: tsconfig,
    };
  }
  const mypy = localBinary(dir, root, "mypy");
  if (mypy !== undefined && fileExists(path.join(dir, "pyproject.toml"))) {
    return {
      argv: [mypy, "--no-color-output", "--no-error-summary"],
      tool: "mypy",
      reason: "mypy installed",
    };
  }
  if (fileExists(path.join(dir, "go.mod"))) {
    return { argv: ["go", "vet", "./..."], tool: "go-vet", reason: "go.mod" };
  }
  return undefined;
}

/** The project's linter. */
export function detectLint(dir: string, root: string): Toolchain | { missing: string } | undefined {
  const biomeConfig = anyFile(dir, ["biome.json", "biome.jsonc"]);
  if (biomeConfig !== undefined) {
    const binary = localBinary(dir, root, "biome");
    if (binary === undefined) return { missing: "@biomejs/biome" };
    return { argv: [binary, "lint", "--reporter=json"], tool: "biome", reason: biomeConfig };
  }
  const eslintConfig = anyFile(dir, ESLINT_CONFIGS);
  if (eslintConfig !== undefined) {
    const binary = localBinary(dir, root, "eslint");
    if (binary === undefined) return { missing: "eslint" };
    return { argv: [binary, "-f", "json"], tool: "eslint", reason: eslintConfig };
  }
  const pyproject = readTextFile(path.join(dir, "pyproject.toml"));
  if (
    anyFile(dir, ["ruff.toml", ".ruff.toml"]) !== undefined ||
    /\[tool\.ruff/.test(pyproject ?? "")
  ) {
    const binary = localBinary(dir, root, "ruff") ?? "ruff";
    return {
      argv: [binary, "check", "--output-format", "json"],
      tool: "ruff",
      reason: "ruff configuration",
    };
  }
  if (fileExists(path.join(dir, "Cargo.toml"))) {
    return {
      argv: ["cargo", "clippy", "--quiet"],
      tool: "clippy",
      reason: "Cargo.toml",
      acceptsPaths: false,
    };
  }
  return undefined;
}

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
];

/**
 * The project's formatter, in check or write mode.
 *
 * The two modes are separate tools, not a flag on one, because one of them
 * rewrites files and the other does not — and a safety flag that depends on
 * an input field is a safety flag a permission engine cannot read.
 */
export function detectFormat(
  dir: string,
  root: string,
  write: boolean,
): Toolchain | { missing: string } | undefined {
  const biomeConfig = anyFile(dir, ["biome.json", "biome.jsonc"]);
  if (biomeConfig !== undefined) {
    const binary = localBinary(dir, root, "biome");
    if (binary === undefined) return { missing: "@biomejs/biome" };
    return {
      argv: write ? [binary, "format", "--write"] : [binary, "format", "--reporter=json"],
      tool: "biome",
      reason: biomeConfig,
    };
  }
  const prettierConfig = anyFile(dir, PRETTIER_CONFIGS);
  if (prettierConfig !== undefined) {
    const binary = localBinary(dir, root, "prettier");
    if (binary === undefined) return { missing: "prettier" };
    return {
      argv: write ? [binary, "--write"] : [binary, "--check"],
      tool: "prettier",
      reason: prettierConfig,
    };
  }
  const pyproject = readTextFile(path.join(dir, "pyproject.toml"));
  if (
    anyFile(dir, ["ruff.toml", ".ruff.toml"]) !== undefined ||
    /\[tool\.ruff/.test(pyproject ?? "")
  ) {
    const binary = localBinary(dir, root, "ruff") ?? "ruff";
    return {
      argv: write ? [binary, "format"] : [binary, "format", "--check"],
      tool: "ruff",
      reason: "ruff configuration",
    };
  }
  if (fileExists(path.join(dir, "Cargo.toml"))) {
    return {
      argv: write ? ["cargo", "fmt"] : ["cargo", "fmt", "--check"],
      tool: "rustfmt",
      reason: "Cargo.toml",
      acceptsPaths: false,
    };
  }
  if (fileExists(path.join(dir, "go.mod"))) {
    return {
      // No trailing path here: the caller's paths, or `.`, are appended by
      // whichever tool runs this, so both forms go through one code path.
      argv: write ? ["gofmt", "-w"] : ["gofmt", "-l"],
      tool: "gofmt",
      reason: "go.mod",
    };
  }
  return undefined;
}

const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  "prettier.config.js",
  "prettier.config.mjs",
  "prettier.config.cjs",
];

/** True when a detection result is the "tool not installed" shape. */
export function isMissing(value: unknown): value is { missing: string } {
  return typeof value === "object" && value !== null && "missing" in value;
}
