/**
 * This package stays out of every bundle. Nothing that emits a bundle may name it, runtime-core
 * may not, and no package a bundle can come to contain may depend on it: not one an emitter
 * names, and not one of theirs. Home and the CLI are its only readers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SELF = "@crewhaus/knowledge-index";
const SOURCE_RE = /\.(?:ts|tsx|js|mjs)$/;
const NAME_RE = /@crewhaus\/([a-z0-9-]+)/g;
const SELF_RE = /@crewhaus\/knowledge-index\b/;
/** Where an item of work is done in a running harness, whatever an emitter names. */
const RUNTIME = ["runtime-core", "memory-service", "agent-context-isolation"];

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (SOURCE_RE.test(name)) out.push(path);
  }
  return out;
}

const relOf = (root: string, file: string): string =>
  file
    .slice(root.length + 1)
    .split("\\")
    .join("/");

type Manifest = Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;

function dependencies(packages: string, name: string): string[] {
  const path = join(packages, name, "package.json");
  if (!existsSync(path)) return [];
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.keys(manifest[field] ?? {}),
  );
}

type GuardReport = {
  readonly problems: readonly string[];
  readonly files: number;
  /** The packages a bundle can come to contain. */
  readonly reachable: ReadonlySet<string>;
};

/** What breaks the rule under `root`, a repository checkout or a planted copy. */
function bundleGuard(root: string): GuardReport {
  const problems: string[] = [];
  const packages = join(root, "packages");
  const emitters = [
    "compiler",
    ...readdirSync(packages).filter((name) => name.startsWith("target-")),
  ];
  const named = new Set<string>(RUNTIME);
  let files = 0;
  for (const name of [...emitters, ...RUNTIME]) {
    for (const file of sources(join(packages, name, "src"))) {
      files++;
      const text = readFileSync(file, "utf8");
      if (SELF_RE.test(text)) problems.push(`${relOf(root, file)} names ${SELF}`);
      if (emitters.includes(name))
        for (const [, dep] of text.matchAll(NAME_RE)) named.add(dep ?? "");
    }
  }
  const reachable = new Set<string>();
  const queue = [...named, ...emitters];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const dep of dependencies(packages, name)) {
      if (dep === SELF) problems.push(`${name}'s package.json depends on ${SELF}`);
      if (dep.startsWith("@crewhaus/")) queue.push(dep.slice("@crewhaus/".length));
    }
  }
  return { problems, files, reachable };
}

const planted: string[] = [];
afterAll(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true });
});

function plantedTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-bundle-guard-"));
  planted.push(root);
  const base: Record<string, string> = {
    "packages/compiler/src/index.ts": "export const a = 1;\n",
    "packages/target-cli/src/index.ts": 'export const imports = "@crewhaus/memory-service";\n',
    "packages/runtime-core/src/index.ts": "export const b = 2;\n",
    "packages/memory-service/package.json":
      '{"dependencies":{"@crewhaus/memory-store":"workspace:*"}}\n',
  };
  for (const [rel, text] of Object.entries({ ...base, ...files })) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

describe("the bundle guard", () => {
  test("this repository is clean, over every emitter and every package they reach", () => {
    const report = bundleGuard(REPO);
    expect(report.problems).toEqual([]);
    expect(report.files).toBeGreaterThan(80);
    expect(report.reachable.size).toBeGreaterThan(60);
    expect(report.reachable.has("memory-store")).toBe(true);
    expect(report.reachable.has("knowledge-index")).toBe(false);
  });

  test("a planted tree with nothing wrong is clean, so the plants below are what fail", () => {
    const report = bundleGuard(plantedTree({}));
    expect([report.problems, report.files]).toEqual([[], 3]);
    expect(report.reachable.has("memory-store")).toBe(true);
  });

  test("an emitter or the runtime that names it fails", () => {
    const root = plantedTree({
      "packages/target-channel-bot/src/emit.ts": `lines.push('import { x } from "${SELF}";');\n`,
      "packages/runtime-core/src/seam.ts": `await import("${SELF}/erasure");\n`,
    });
    expect(bundleGuard(root).problems).toContain(
      `packages/target-channel-bot/src/emit.ts names ${SELF}`,
    );
    expect(bundleGuard(root).problems).toContain(`packages/runtime-core/src/seam.ts names ${SELF}`);
  });

  test("a package a bundle contains that depends on it fails, however far down", () => {
    const root = plantedTree({
      "packages/memory-store/package.json": '{"dependencies":{"@crewhaus/deep":"workspace:*"}}\n',
      "packages/deep/package.json": `{"dependencies":{"${SELF}":"workspace:*"}}\n`,
    });
    expect(bundleGuard(root).problems).toEqual([`deep's package.json depends on ${SELF}`]);
  });
});
