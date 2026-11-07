/**
 * A test package must never reach npm, and nothing that ships may depend on one.
 *
 * Two locks keep a private package out of the publish scripts: release-prep stamps
 * and un-privates only `crewhaus` and `@crewhaus/...`-shaped names, and
 * publish-workspace skips `"private": true` and every other name. These guards hold
 * the rule those locks rely on:
 *
 *  1. Every private workspace package has a name release-prep does not stamp, and
 *     its tests are in the root `test` script, which otherwise runs only the
 *     `@crewhaus/*` and `crewhaus` filters.
 *  2. No publishable package names a private package in `dependencies`,
 *     `peerDependencies` or `optionalDependencies`. Publishing rewrites every
 *     `workspace:` range to the cut version, so such a package would ship pinned to
 *     a name anyone can register.
 *  3. Any workspace manifest, devDependencies included, names a private package
 *     only as exactly `workspace:*`. These names are unclaimed on npm, so any other
 *     range could resolve to whoever registers one.
 *
 * The real scripts are run below, so the guard's idea of a stamped name cannot
 * drift from what release-prep does.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);

type Manifest = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const SHIPPING_BLOCKS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const ALL_BLOCKS = [...SHIPPING_BLOCKS, "devDependencies"] as const;

/** The names release-prep stamps with the release version and un-privates. */
const isStamped = (name: string): boolean => name === "crewhaus" || /^@?crewhaus[-/]/.test(name);

/** The package names in the root test script's `--filter '<name>'` tokens. */
const testFilters = (rootTestScript: string): string[] =>
  [...rootTestScript.matchAll(/--filter '([^']+)'/g)].map((match) => match[1] as string);

/** Everything wrong with these manifests. Each problem names its reason. */
function privatePackageProblems(manifests: readonly Manifest[], rootTestScript: string): string[] {
  const problems: string[] = [];
  const filters = testFilters(rootTestScript);
  const privateNames = new Set(
    manifests.filter((m) => m.private === true && m.name !== undefined).map((m) => m.name),
  );

  for (const manifest of manifests) {
    const name = manifest.name ?? "(unnamed)";
    if (manifest.private === true) {
      if (isStamped(name)) {
        problems.push(`${name}: release-prep would stamp this private name and un-private it`);
      }
      if (!filters.includes(name)) {
        problems.push(`${name}: not in the root test filters, so its tests never run`);
      }
    } else {
      for (const block of SHIPPING_BLOCKS) {
        for (const dep of Object.keys(manifest[block] ?? {})) {
          if (privateNames.has(dep)) {
            problems.push(`${name}: names private ${dep} in ${block}, which ships`);
          }
        }
      }
    }
    for (const block of ALL_BLOCKS) {
      for (const [dep, range] of Object.entries(manifest[block] ?? {})) {
        if (privateNames.has(dep) && range !== "workspace:*") {
          problems.push(`${name}: names private ${dep} as ${range} in ${block}, not workspace:*`);
        }
      }
    }
  }
  return problems;
}

const SCRIPT = "--filter 'service-fakes' --filter 'crewhaus' test";
const PRIVATE_FAKES: Manifest = { name: "service-fakes", private: true };

describe("guard 1: a private package's name and tests", () => {
  test("a private crewhaus- name is one release-prep would stamp", () => {
    const problems = privatePackageProblems(
      [{ name: "crewhaus-x", private: true }],
      "--filter 'crewhaus-x'",
    );
    expect(problems).toEqual([
      "crewhaus-x: release-prep would stamp this private name and un-private it",
    ]);
  });

  test("so is a private @crewhaus-examples/ name", () => {
    const problems = privatePackageProblems(
      [{ name: "@crewhaus-examples/y", private: true }],
      "--filter '@crewhaus-examples/y'",
    );
    expect(problems).toEqual([
      "@crewhaus-examples/y: release-prep would stamp this private name and un-private it",
    ]);
  });

  test("a private package no filter names never has its tests run", () => {
    const problems = privatePackageProblems([{ name: "not-filtered", private: true }], SCRIPT);
    expect(problems).toEqual([
      "not-filtered: not in the root test filters, so its tests never run",
    ]);
  });

  test("a private, filtered, unstamped name is fine", () => {
    expect(privatePackageProblems([PRIVATE_FAKES], SCRIPT)).toEqual([]);
  });
});

describe("guard 2: nothing that ships depends on a private package", () => {
  test.each(SHIPPING_BLOCKS)("%s", (block) => {
    const problems = privatePackageProblems(
      [PRIVATE_FAKES, { name: "@crewhaus/a", [block]: { "service-fakes": "workspace:*" } }],
      SCRIPT,
    );
    expect(problems).toEqual([`@crewhaus/a: names private service-fakes in ${block}, which ships`]);
  });

  test("devDependencies do not ship to a consumer, so they are allowed", () => {
    const problems = privatePackageProblems(
      [PRIVATE_FAKES, { name: "@crewhaus/a", devDependencies: { "service-fakes": "workspace:*" } }],
      SCRIPT,
    );
    expect(problems).toEqual([]);
  });

  test("another private package may depend on one", () => {
    const problems = privatePackageProblems(
      [
        PRIVATE_FAKES,
        { name: "hangar-e2e", private: true, dependencies: { "service-fakes": "workspace:*" } },
      ],
      "--filter 'service-fakes' --filter 'hangar-e2e'",
    );
    expect(problems).toEqual([]);
  });
});

describe("guard 3: a private name, only as workspace:*", () => {
  test.each(["^0.0.0", "workspace:^", "0.0.0", "*", "workspace:~"])("%s is refused", (range) => {
    const problems = privatePackageProblems(
      [PRIVATE_FAKES, { name: "@crewhaus/a", devDependencies: { "service-fakes": range } }],
      SCRIPT,
    );
    expect(problems).toEqual([
      `@crewhaus/a: names private service-fakes as ${range} in devDependencies, not workspace:*`,
    ]);
  });

  test("a range on a package that is not private is none of this guard's business", () => {
    const problems = privatePackageProblems(
      [PRIVATE_FAKES, { name: "@crewhaus/a", dependencies: { zod: "^3.0.0" } }],
      SCRIPT,
    );
    expect(problems).toEqual([]);
  });
});

function workspaceManifests(): Manifest[] {
  const out: Manifest[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group))) {
      const file = join(ROOT, group, entry, "package.json");
      if (existsSync(file)) out.push(JSON.parse(readFileSync(file, "utf8")) as Manifest);
    }
  }
  return out;
}

describe("the real tree", () => {
  const manifests = workspaceManifests();
  const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: { test: string };
  };

  test("holds all three guards", () => {
    expect(privatePackageProblems(manifests, rootManifest.scripts.test)).toEqual([]);
  });

  test("has exactly the private packages it should, so a third appears on purpose", () => {
    const names = manifests.filter((m) => m.private === true).map((m) => m.name);
    expect(names.sort()).toEqual(["hangar-e2e", "service-fakes"]);
  });

  test("the guards really read it: the manifests, and the edges they judge", () => {
    expect(manifests.length).toBeGreaterThan(250);
    const edges = manifests.flatMap((m) =>
      Object.entries(m.devDependencies ?? {}).filter(
        ([dep]) => dep === "hangar-e2e" || dep === "service-fakes",
      ),
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  test("the root test script still runs the published packages", () => {
    const filters = testFilters(rootManifest.scripts.test);
    expect(filters).toContain("@crewhaus/*");
    expect(filters).toContain("crewhaus");
  });
});

describe("the real publish scripts", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const manifestOf = (
    name: string,
    fields: Record<string, unknown>,
    dir: string,
  ): Record<string, unknown> => ({
    name,
    version: "0.0.0",
    type: "module",
    license: "Apache-2.0",
    main: "src/index.ts",
    repository: {
      type: "git",
      url: "git+https://github.com/crewhaus/factory.git",
      directory: `packages/${dir}`,
    },
    ...fields,
  });

  test("release-prep leaves a private test package alone, and un-privates a stamped name", () => {
    // release-prep keys repo metadata off a root directory named this.
    const root = join(tempDir("private-packages-prep-"), "factory");
    write(
      join(root, "package.json"),
      JSON.stringify({
        name: "root",
        private: true,
        version: "0.0.0",
        workspaces: ["packages/*"],
        engines: { bun: ">=1.3.14" },
      }),
    );
    write(join(root, "LICENSE"), "LICENSE\n");
    write(join(root, "NOTICE"), "NOTICE\n");
    // Without the pinned biome the script writes everything and then exits 1.
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    symlinkSync(
      join(ROOT, "node_modules", ".bin", "biome"),
      join(root, "node_modules", ".bin", "biome"),
    );
    const add = (dir: string, manifest: Record<string, unknown>): string => {
      const file = join(root, "packages", dir, "package.json");
      write(join(root, "packages", dir, "src", "index.ts"), "export const answer = 42;\n");
      write(file, JSON.stringify(manifest));
      return file;
    };
    const fakes = add(
      "service-fakes",
      manifestOf("service-fakes", { private: true }, "service-fakes"),
    );
    const stamped = add("crewhaus-x", manifestOf("crewhaus-x", { private: true }, "crewhaus-x"));
    const before = readFileSync(fakes, "utf8");

    const run = Bun.spawnSync(
      [
        "bun",
        join(ROOT, "scripts", "release-prep.ts"),
        "--version",
        "0.3.1",
        "--for-publish",
        "--root",
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: expect.any(String),
    });
    expect(readFileSync(fakes, "utf8")).toBe(before);
    expect((JSON.parse(readFileSync(stamped, "utf8")) as Manifest).private).toBeUndefined();
    // The planted name is what the guard calls stamped, and the other is not.
    expect(isStamped("crewhaus-x")).toBe(true);
    expect(isStamped("service-fakes")).toBe(false);
  }, 20_000); // a real script, and the real biome over its output

  const NPM = Bun.which("npm");
  test.skipIf(NPM === null && !process.env["CI"])(
    "publish-workspace plans the publishable package and never names the private one",
    () => {
      const root = tempDir("private-packages-publish-");
      const deadRegistry = "http://127.0.0.1:9/";
      write(
        join(root, "package.json"),
        JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      );
      const add = (dir: string, manifest: Record<string, unknown>): void => {
        write(join(root, "packages", dir, "dist", "index.js"), "export {};\n");
        for (const file of ["README.md", "LICENSE", "NOTICE"]) {
          write(join(root, "packages", dir, file), `${file}\n`);
        }
        write(join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
      };
      add(
        "ok",
        manifestOf(
          "@crewhaus/zz-ok",
          {
            version: "0.7.1",
            main: "dist/index.js",
            files: ["dist", "README.md", "LICENSE", "NOTICE"],
            publishConfig: { access: "public", registry: deadRegistry },
          },
          "ok",
        ),
      );
      add("service-fakes", manifestOf("service-fakes", { private: true }, "service-fakes"));

      write(join(root, "user-npmrc"), "");
      write(join(root, "global-npmrc"), "");
      const run = Bun.spawnSync(
        [
          "bun",
          join(ROOT, "scripts", "publish-workspace.ts"),
          "--root",
          root,
          "--dry-run",
          "--no-registry",
        ],
        {
          cwd: root,
          // Built from scratch: nothing from the developer's npm configuration.
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: root,
            npm_config_userconfig: join(root, "user-npmrc"),
            npm_config_globalconfig: join(root, "global-npmrc"),
            npm_config_cache: join(root, "npm-cache"),
            npm_config_update_notifier: "false",
            npm_config_registry: deadRegistry,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = run.stdout.toString();
      expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: expect.any(String),
      });
      // A run that planned nothing cannot pass: it found exactly the one.
      expect(stdout).toContain("Discovered 1 publishable packages");
      expect(stdout).toContain("@crewhaus/zz-ok");
      expect(stdout).not.toContain("service-fakes");
    },
    90_000, // the script runs the real npm pack
  );
});
