import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, exercised through its own `execute`
 * against a real temporary workspace.
 *
 * Containment is relative to `process.cwd()`, so each test runs inside a
 * temporary directory and the escape tests reach for a path outside it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PKG_TOOLS,
  licenseAggregate,
  lockfileDiff,
  packagePublishPreflight,
  packageTarballInspect,
  semverResolve,
} from "./index";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

async function call<T = Record<string, unknown>>(
  tool: (typeof PKG_TOOLS)[number],
  input: unknown,
): Promise<T> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  const out = await tool.execute(parsed.data, ctx);
  return JSON.parse(out) as T;
}

/** For the tools that answer a problem with a sentence rather than JSON. */
async function callRaw(tool: (typeof PKG_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-pkg-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("package-wide contract", () => {
  test("every tool is exported in PKG_TOOLS", () => {
    expect(PKG_TOOLS.length).toBe(5);
  });

  test("names are unique and PascalCase", () => {
    const names = PKG_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of PKG_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only and non-destructive — this package inspects, it does not change", () => {
    for (const t of PKG_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
    }
  });

  test("no tool declares a network capability, because none reaches a registry", () => {
    for (const t of PKG_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("no tool opts out of output classification", () => {
    // These read third-party package metadata and archive member names,
    // which is exactly the material an injection classifier looks at.
    for (const t of PKG_TOOLS) {
      expect({ name: t.name, off: t.classifyOutput === false }).toEqual({
        name: t.name,
        off: false,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const t of PKG_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of PKG_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });
});

describe("SemverResolve", () => {
  test("answers what an install would pick", async () => {
    const result = await call(semverResolve, {
      range: "^1.2.0",
      versions: ["1.1.0", "1.2.4", "1.9.0", "2.0.0"],
    });
    expect(result).toMatchObject({ best: "1.9.0" });
  });

  test("a non-range specifier gets an explanation, not an empty answer", async () => {
    const out = await callRaw(semverResolve, { range: "workspace:*", versions: ["1.0.0"] });
    expect(out).toContain("not understood");
  });
});

describe("LockfileDiff", () => {
  const before = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/left": { version: "1.0.0" },
      "node_modules/stay": { version: "2.0.0" },
      "node_modules/bump": { version: "1.0.0" },
    },
  });
  const after = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/stay": { version: "2.0.0" },
      "node_modules/bump": { version: "2.0.0" },
      "node_modules/added": { version: "0.1.0" },
    },
  });

  test("reports the four counts a reviewer wants", async () => {
    writeFileSync(join(workspace, "before-package-lock.json"), before);
    writeFileSync(join(workspace, "after-package-lock.json"), after);
    const result = await call<{ counts: Record<string, number> }>(lockfileDiff, {
      before: "before-package-lock.json",
      after: "after-package-lock.json",
    });
    expect(result.counts).toMatchObject({ added: 1, removed: 1, major: 1 });
  });

  test("a lockfile whose format cannot be told is an error naming what it expected", async () => {
    writeFileSync(join(workspace, "mystery.txt"), "{}");
    await expect(
      callRaw(lockfileDiff, { before: "mystery.txt", after: "mystery.txt" }),
    ).rejects.toThrow(/package-lock\.json/);
  });

  test("a path outside the workspace is refused", async () => {
    writeFileSync(join(workspace, "a-package-lock.json"), before);
    await expect(
      callRaw(lockfileDiff, {
        before: "../escape-package-lock.json",
        after: "a-package-lock.json",
      }),
    ).rejects.toThrow(/escapes the workspace/);
  });
});

describe("LicenseAggregate", () => {
  function install(name: string, license: unknown): void {
    const dir = join(workspace, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...(license === undefined ? {} : { license }) }),
    );
  }

  test("counts licenses and separates the ones needing a decision", async () => {
    install("a", "MIT");
    install("b", "MIT");
    install("c", "GPL-3.0");
    install("d", undefined);
    const result = await call<{
      packages: number;
      counts: Array<{ license: string; count: number }>;
      copyleft: Array<{ name: string }>;
      undeclared: Array<{ name: string }>;
    }>(licenseAggregate, {});
    expect(result.packages).toBe(4);
    expect(result.counts[0]).toEqual({ license: "MIT", count: 2 });
    expect(result.copyleft.map((f) => f.name)).toEqual(["c"]);
    expect(result.undeclared.map((f) => f.name)).toEqual(["d"]);
  });

  test("scoped packages are read from inside their scope directory", async () => {
    const dir = join(workspace, "node_modules", "@scope", "pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0", license: "ISC" }),
    );
    const result = await call<{ packages: number }>(licenseAggregate, {});
    expect(result.packages).toBe(1);
  });

  test("a deny rule reports the violation", async () => {
    install("bad", "AGPL-3.0");
    const result = await call<{ violations: Array<{ name: string; rule: string }> }>(
      licenseAggregate,
      { deny: ["AGPL"] },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ name: "bad" });
  });

  test("a node_modules entry linked outside the workspace is skipped and counted", async () => {
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-pkg-outside-"));
    try {
      writeFileSync(
        join(outside, "package.json"),
        '{"name":"leaked","version":"9.9.9","license":"PROPRIETARY"}',
      );
      mkdirSync(join(workspace, "node_modules"), { recursive: true });
      symlinkSync(outside, join(workspace, "node_modules", "linked"));
      install("honest", "MIT");
      const result = await call<{ packages: number; skippedOutsideWorkspace?: number }>(
        licenseAggregate,
        {},
      );
      expect(result.packages).toBe(1);
      expect(result.skippedOutsideWorkspace).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a node_modules entry linked INSIDE the workspace is still read", async () => {
    // Workspace protocols and pnpm are symlinks; refusing all links would
    // make this tool useless on the trees it most needs to read.
    const local = join(workspace, "packages", "local");
    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, "package.json"),
      '{"name":"local","version":"1.0.0","license":"Apache-2.0"}',
    );
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    symlinkSync(join("..", "packages", "local"), join(workspace, "node_modules", "local"));
    const result = await call<{ packages: number; counts: Array<{ license: string }> }>(
      licenseAggregate,
      {},
    );
    expect(result.packages).toBe(1);
    expect(result.counts[0]?.license).toBe("Apache-2.0");
  });

  test("no node_modules is explained rather than reported as a clean tree", async () => {
    // Answering "0 packages, no violations" would read as an all-clear.
    const out = await callRaw(licenseAggregate, {});
    expect(out).toContain("no node_modules");
  });
});

describe("PackageTarballInspect", () => {
  function pack(files: Record<string, string>): void {
    const root = join(workspace, "package");
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    }
    execFileSync("tar", ["czf", join(workspace, "pkg.tgz"), "-C", workspace, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  }

  test("lists what is in the archive and what is biggest", async () => {
    pack({ "package.json": "{}", "dist/index.js": "x".repeat(100) });
    const result = await call<{
      files: number;
      totalBytes: number;
      biggest: Array<{ name: string }>;
    }>(packageTarballInspect, { file: "pkg.tgz" });
    expect(result.files).toBe(2);
    expect(result.totalBytes).toBe(102);
    expect(result.biggest[0]?.name).toContain("dist/index.js");
  });

  test("names a path that was expected and is not there", async () => {
    // The published-artifact bug: the source has dist, the tarball does not.
    pack({ "package.json": "{}" });
    const result = await call<{ missing?: string[] }>(packageTarballInspect, {
      file: "pkg.tgz",
      expect: ["package/dist"],
    });
    expect(result.missing).toEqual(["package/dist"]);
  });

  test("a present path is not reported missing", async () => {
    pack({ "package.json": "{}", "dist/index.js": "x" });
    const result = await call<{ missing?: string[] }>(packageTarballInspect, {
      file: "pkg.tgz",
      expect: ["package/dist"],
    });
    expect(result.missing).toBeUndefined();
  });

  test("a link member is reported as suspicious rather than followed", async () => {
    const root = join(workspace, "package");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    symlinkSync("/etc/passwd", join(root, "sneaky"));
    execFileSync("tar", ["czf", join(workspace, "pkg.tgz"), "-C", workspace, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const result = await call<{ suspicious?: Array<{ name: string; linkname: string }> }>(
      packageTarballInspect,
      { file: "pkg.tgz" },
    );
    expect(result.suspicious?.[0]).toMatchObject({ linkname: "/etc/passwd" });
  });

  test("a tarball outside the workspace is refused", async () => {
    await expect(callRaw(packageTarballInspect, { file: "../outside.tgz" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });
});

describe("PackagePublishPreflight", () => {
  function manifest(extra: Record<string, unknown>): void {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "p", version: "1.0.0", ...extra }),
    );
  }

  test("catches a workspace range that would break the published package", async () => {
    manifest({ dependencies: { dep: "workspace:*" } });
    const result = await call<{ ok: boolean; blocking: Array<{ id: string }> }>(
      packagePublishPreflight,
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.map((p) => p.id)).toContain("unpublishable-range");
  });

  test("catches an entry point that the files field would leave out", async () => {
    mkdirSync(join(workspace, "dist"), { recursive: true });
    writeFileSync(join(workspace, "dist", "index.js"), "");
    manifest({ main: "dist/index.js", files: ["src"] });
    const result = await call<{ blocking: Array<{ id: string }> }>(packagePublishPreflight, {});
    expect(result.blocking.map((p) => p.id)).toContain("entry-excluded");
  });

  test("a sound package passes", async () => {
    mkdirSync(join(workspace, "dist"), { recursive: true });
    writeFileSync(join(workspace, "dist", "index.js"), "");
    writeFileSync(join(workspace, "README.md"), "# p");
    writeFileSync(join(workspace, "LICENSE"), "MIT");
    manifest({
      main: "dist/index.js",
      files: ["dist"],
      license: "MIT",
      repository: "git+https://example.invalid/p",
    });
    const result = await call<{ ok: boolean; blocking: unknown[] }>(packagePublishPreflight, {});
    expect(result.blocking).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a missing package.json is explained, not a crash", async () => {
    const out = await callRaw(packagePublishPreflight, {});
    expect(out).toContain("package.json");
  });
});
