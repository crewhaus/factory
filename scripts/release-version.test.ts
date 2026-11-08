/**
 * scripts/release-version.ts: which versions a release takes, which of them are
 * release candidates, and the stamp rule for a final version, through the pure
 * functions and through the CLI the release workflow runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseReleaseVersion, stampMismatches } from "./release-version";

const SCRIPT = join(import.meta.dir, "release-version.ts");
const HOMEPAGE = "https://github.com/crewhaus/factory";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A workspace whose packages are `name → version` (plus any extra manifest fields). */
function workspace(
  pkgs: ReadonlyArray<{ name: string; version: string; dir?: string; private?: boolean }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "release-version-"));
  temps.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "factory",
      private: true,
      version: "0.0.0",
      workspaces: ["packages/*", "apps/*"],
    }),
  );
  for (const p of pkgs) {
    const dir = join(root, p.dir ?? join("packages", p.name.replace(/^@crewhaus\//, "")));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: p.name, version: p.version, ...(p.private ? { private: true } : {}) }),
    );
  }
  return root;
}

describe("parseReleaseVersion", () => {
  test.each([
    ["0.9.0", false],
    ["10.20.30", false],
    ["0.0.0", false],
    ["0.9.0-rc.0", true],
    ["0.9.0-rc.1", true],
    ["1.0.0-rc.12", true],
  ])("%s is accepted (prerelease: %p)", (raw, prerelease) => {
    expect(parseReleaseVersion(raw)).toEqual({
      ok: true,
      version: raw,
      prerelease,
      distTag: prerelease ? "next" : undefined,
    });
  });

  test.each([
    ["0.9.0x", "is not a release version"],
    ["v0.9.0", 'starts with "v"'],
    ["0.9", "is not a release version"],
    ["0.9.0-beta.1", "prerelease part other than -rc.N"],
    ["0.9.0-rc.", "is not a release version"],
    ["0.9.0-rc.01", "is not a release version"],
    ["01.9.0", "is not a release version"],
    ["", "no version was given"],
    ["0.9.0-rc.1 ", "is not a release version"],
    ["0.9.0\n", "is not a release version"],
  ])("%j is refused: %s", (raw, reason) => {
    const parsed = parseReleaseVersion(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain(reason);
      expect(parsed.reason).toContain("X.Y.Z or X.Y.Z-rc.N");
    }
  });
});

describe("stampMismatches", () => {
  test("names the one publishable manifest that is not at the version", () => {
    const root = workspace([
      { name: "@crewhaus/a", version: "0.9.0" },
      { name: "crewhaus", version: "0.9.0", dir: "apps/cli" },
      { name: "@crewhaus/b", version: "0.8.0" },
    ]);
    expect(stampMismatches(root, "0.9.0")).toEqual([
      { dir: join("packages", "b"), name: "@crewhaus/b", version: "0.8.0" },
    ]);
    expect(
      stampMismatches(root, "0.8.0")
        .map((m) => m.name)
        .sort(),
    ).toEqual(["@crewhaus/a", "crewhaus"]);
  });

  test("a private @crewhaus/ name is published by the release, so it is checked too", () => {
    const root = workspace([
      { name: "@crewhaus/a", version: "0.9.0" },
      { name: "@crewhaus/x", version: "0.8.0", private: true },
    ]);
    expect(stampMismatches(root, "0.9.0")).toEqual([
      { dir: join("packages", "x"), name: "@crewhaus/x", version: "0.8.0" },
    ]);
  });

  test("names release-prep never stamps are not its business", () => {
    const root = workspace([
      { name: "@crewhaus/a", version: "0.9.0" },
      { name: "service-fakes", version: "0.0.0", dir: "packages/service-fakes", private: true },
      { name: "crewhaus-client", version: "0.0.0", dir: "packages/crewhaus-client" },
      { name: "@crewhaus-labs/x", version: "0.0.0", dir: "packages/labs-x" },
    ]);
    expect(stampMismatches(root, "0.9.0")).toEqual([]);
  });
});

describe("the CLI", () => {
  function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(
      argv,
      (l) => out.push(l),
      (l) => err.push(l),
    );
    return { code, out, err };
  }

  test("a final version from a tree stamped with it writes the four outputs, appended", () => {
    const root = workspace([{ name: "@crewhaus/a", version: "0.9.0" }]);
    const output = join(root, "github-output");
    writeFileSync(output, "earlier=1\n");
    const r = run([
      "--version",
      "0.9.0",
      "--homepage",
      HOMEPAGE,
      "--dry-run",
      "",
      "--github-output",
      output,
      "--root",
      root,
    ]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      [
        "earlier=1",
        "version=0.9.0",
        "prerelease=false",
        "dry_run=false",
        `download_base_url=${HOMEPAGE}/releases/download/v0.9.0`,
        "",
      ].join("\n"),
    );
  });

  test("a final version from a mis-stamped tree exits 1, naming the manifests and the fix, and writes nothing", () => {
    const pkgs = Array.from({ length: 12 }, (_, i) => ({
      name: `@crewhaus/p${String(i).padStart(2, "0")}`,
      version: "0.8.0",
    }));
    const root = workspace([...pkgs, { name: "@crewhaus/ok", version: "0.9.0" }]);
    const output = join(root, "github-output");
    writeFileSync(output, "");
    const r = run([
      "--version",
      "0.9.0",
      "--homepage",
      HOMEPAGE,
      "--github-output",
      output,
      "--root",
      root,
    ]);
    expect(r.code).toBe(1);
    const text = r.err.join("\n");
    expect(text).toContain("12 publishable manifest(s) are not stamped 0.9.0");
    expect(text).toContain(`${join("packages", "p00")} (@crewhaus/p00) is 0.8.0`);
    expect(text).toContain(`${join("packages", "p09")} (@crewhaus/p09) is 0.8.0`);
    expect(text).not.toContain("@crewhaus/p10");
    expect(text).toContain("… and 2 more");
    expect(text).toContain("bun scripts/release-prep.ts --version 0.9.0");
    expect(text).toContain("land the bump on main through a PR");
    expect(readFileSync(output, "utf8")).toBe("");
  });

  test("a dry run of a final version is held to the same stamp rule", () => {
    const root = workspace([{ name: "@crewhaus/a", version: "0.8.0" }]);
    const r = run([
      "--version",
      "0.9.0",
      "--homepage",
      HOMEPAGE,
      "--dry-run",
      "true",
      "--root",
      root,
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("not stamped 0.9.0");
  });

  test("a release candidate skips the stamp check, says so, and is a prerelease", () => {
    const root = workspace([{ name: "@crewhaus/a", version: "0.8.0" }]);
    const output = join(root, "github-output");
    writeFileSync(output, "");
    const r = run([
      "--version",
      "0.9.0-rc.1",
      "--homepage",
      HOMEPAGE,
      "--dry-run",
      "true",
      "--github-output",
      output,
      "--root",
      root,
    ]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain(
      "0.9.0-rc.1 is a release candidate: the tree's stamped version is not checked",
    );
    expect(readFileSync(output, "utf8").split("\n")).toEqual([
      "version=0.9.0-rc.1",
      "prerelease=true",
      "dry_run=true",
      `download_base_url=${HOMEPAGE}/releases/download/v0.9.0-rc.1`,
      "",
    ]);
  });

  test("an invalid version or --dry-run value exits 1 and writes nothing", () => {
    const root = workspace([{ name: "@crewhaus/a", version: "0.9.0" }]);
    const output = join(root, "github-output");
    writeFileSync(output, "");
    const bad = run([
      "--version",
      "0.9.0x",
      "--homepage",
      HOMEPAGE,
      "--github-output",
      output,
      "--root",
      root,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(
      '::error::"0.9.0x" is not a release version: a release version is X.Y.Z or X.Y.Z-rc.N, with no leading zeros',
    );
    const dry = run([
      "--version",
      "0.9.0",
      "--homepage",
      HOMEPAGE,
      "--dry-run",
      "yes",
      "--root",
      root,
    ]);
    expect(dry.code).toBe(1);
    expect(dry.err.join("\n")).toContain('--dry-run is "yes"');
    const noHome = run(["--version", "0.9.0", "--root", root]);
    expect(noHome.code).toBe(1);
    expect(noHome.err.join("\n")).toContain("--homepage");
    expect(readFileSync(output, "utf8")).toBe("");
  });

  test("runs as a script, before any install: its exit code is the verdict", () => {
    const root = workspace([{ name: "@crewhaus/a", version: "0.8.0" }]);
    const spawn = (version: string) =>
      Bun.spawnSync(["bun", SCRIPT, "--version", version, "--homepage", HOMEPAGE, "--root", root], {
        env: { PATH: process.env["PATH"] ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
    const stale = spawn("0.9.0");
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.toString()).toContain("packages/a (@crewhaus/a) is 0.8.0");
    const rc = spawn("0.9.0-rc.0");
    expect(rc.exitCode).toBe(0);
    expect(rc.stdout.toString()).toContain("prerelease=true");
    // Only node: builtins and the import-free predicate: nothing to install first.
    const source = readFileSync(SCRIPT, "utf8");
    const specifiers = [...source.matchAll(/^import [^;]*? from "([^"]+)";$/gms)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(1);
    for (const s of specifiers)
      expect(s === "./publishable.ts" || s?.startsWith("node:")).toBe(true);
    const predicate = readFileSync(join(import.meta.dir, "publishable.ts"), "utf8");
    expect(predicate).not.toMatch(/^import /m);
  });
});
