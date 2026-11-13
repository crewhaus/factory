/**
 * The change-record package stays out of every bundle: it is a head's (the CLI's and
 * Home's), never a compiled harness's. Nothing that emits a bundle names
 * `@crewhaus/quality-service`, and runtime-core does not import it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

const SOURCE_RE = /\.(?:ts|tsx|js|mjs)$/;
const SERVICE_RE = /@crewhaus\/quality-service\b/;
const EITHER_RE = /["'`]@crewhaus\/quality-service(?:\/[^"'`]*)?["'`]/;

function sources(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (SOURCE_RE.test(name)) out.push(path);
  }
  return out;
}

/** A path under `root`, with forward slashes on every platform. */
const relOf = (root: string, file: string): string =>
  file
    .slice(root.length + 1)
    .split("\\")
    .join("/");

type GuardReport = {
  readonly problems: readonly string[];
  readonly emitterFiles: number;
  readonly runtimeFiles: number;
};

/** What breaks the two rules under `root`, a repository checkout or a planted copy. */
function bundleGuard(root: string): GuardReport {
  const problems: string[] = [];
  const packages = join(root, "packages");
  const emitterDirs = [
    join(packages, "compiler", "src"),
    ...readdirSync(packages)
      .filter((name) => name.startsWith("target-"))
      .map((name) => join(packages, name, "src")),
  ];
  let emitterFiles = 0;
  for (const dir of emitterDirs) {
    for (const file of sources(dir)) {
      emitterFiles++;
      if (SERVICE_RE.test(readFileSync(file, "utf8"))) {
        problems.push(`${relOf(root, file)} names @crewhaus/quality-service`);
      }
    }
  }
  let runtimeFiles = 0;
  for (const file of sources(join(packages, "runtime-core", "src"))) {
    runtimeFiles++;
    if (EITHER_RE.test(readFileSync(file, "utf8"))) {
      problems.push(`${relOf(root, file)} imports @crewhaus/quality-service`);
    }
  }
  const manifest = JSON.parse(
    readFileSync(join(packages, "runtime-core", "package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name === "@crewhaus/quality-service") {
        problems.push(`runtime-core's package.json names ${name} in ${field}`);
      }
    }
  }
  return { problems, emitterFiles, runtimeFiles };
}

const planted: string[] = [];
afterAll(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true });
});

function plantedTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "quality-bundle-guard-"));
  planted.push(root);
  const base: Record<string, string> = {
    "packages/compiler/src/index.ts": "export const a = 1;\n",
    "packages/target-cli/src/index.ts": 'export const imports = "@crewhaus/memory-service";\n',
    "packages/runtime-core/src/index.ts": "export const b = 2;\n",
    "packages/runtime-core/package.json":
      '{"dependencies":{"@crewhaus/run-context":"workspace:*"}}\n',
  };
  for (const [rel, text] of Object.entries({ ...base, ...files })) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

describe("the bundle guard", () => {
  test("this repository is clean, over every emitter and runtime-core file", () => {
    const report = bundleGuard(REPO);
    expect(report.problems).toEqual([]);
    expect(report.emitterFiles).toBeGreaterThan(50);
    expect(report.runtimeFiles).toBeGreaterThan(20);
  });

  test("a planted tree with nothing wrong is clean, so the plants below are what fail", () => {
    const report = bundleGuard(plantedTree({}));
    expect(report).toEqual({ problems: [], emitterFiles: 2, runtimeFiles: 1 });
  });

  test("an emitter that names the change-record package fails", () => {
    const root = plantedTree({
      "packages/target-channel-bot/src/emit.ts":
        'lines.push(`import { x } from "@crewhaus/quality-service";`);\n',
    });
    expect(bundleGuard(root).problems).toEqual([
      "packages/target-channel-bot/src/emit.ts names @crewhaus/quality-service",
    ]);
  });

  test("runtime-core importing the package, or listing it, fails", () => {
    const root = plantedTree({
      "packages/runtime-core/src/seam.ts":
        'import { readChanges } from "@crewhaus/quality-service";\n',
      "packages/runtime-core/package.json":
        '{"dependencies":{"@crewhaus/quality-service":"workspace:*"}}\n',
    });
    expect(bundleGuard(root).problems).toEqual([
      "packages/runtime-core/src/seam.ts imports @crewhaus/quality-service",
      "runtime-core's package.json names @crewhaus/quality-service in dependencies",
    ]);
  });
});
