import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, exercised through its own `execute`
 * against a real temporary workspace.
 *
 * Containment is relative to `process.cwd()`, so each test runs inside a
 * temporary directory and the escape tests reach for a path outside it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  // The bug this guards: `pnpm-lock.yaml` used to be routed to the yarn
  // reader, which collects nothing from any pnpm generation. Nothing threw —
  // the counts came back all zeros, which reads as "this bump changed
  // nothing" rather than as "this file was never read".
  test("pnpm lockfiles are read, not silently counted as empty", async () => {
    const lock = (zod: string, extra: string): string =>
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        `  zod@${zod}:`,
        "    resolution: {integrity: sha512-Abc==}",
        "",
        `  ${extra}:`,
        "    resolution: {integrity: sha512-Def==}",
        "",
      ].join("\n");
    writeFileSync(join(workspace, "before-pnpm-lock.yaml"), lock("3.23.8", "left@1.0.0"));
    writeFileSync(join(workspace, "after-pnpm-lock.yaml"), lock("4.0.0", "added@0.1.0"));
    const result = await call<{ counts: Record<string, number>; changed: unknown[] }>(
      lockfileDiff,
      { before: "before-pnpm-lock.yaml", after: "after-pnpm-lock.yaml" },
    );
    expect(result.counts).toMatchObject({ added: 1, removed: 1, major: 1 });
    expect(result.changed).toEqual([{ name: "zod", from: "3.23.8", to: "4.0.0", bump: "major" }]);
  });

  test("the v5 and v6 key grammars are read too", async () => {
    writeFileSync(
      join(workspace, "v5-pnpm-lock.yaml"),
      "lockfileVersion: 5.4\n\npackages:\n\n  /zod/3.23.8:\n    resolution: {integrity: sha512-A==}\n",
    );
    writeFileSync(
      join(workspace, "v6-pnpm-lock.yaml"),
      "lockfileVersion: '6.0'\n\npackages:\n\n  /zod@4.0.0:\n    resolution: {integrity: sha512-B==}\n",
    );
    const result = await call<{ counts: Record<string, number> }>(lockfileDiff, {
      before: "v5-pnpm-lock.yaml",
      after: "v6-pnpm-lock.yaml",
    });
    expect(result.counts).toMatchObject({ added: 0, removed: 0, major: 1 });
  });

  // The other half of the same drift: `bun.lockb` is binary, and handing it
  // to the `bun.lock` text reader also produced zero entries rather than an
  // error. It is refused by name now.
  test("bun.lockb is refused rather than read as text", async () => {
    writeFileSync(join(workspace, "bun.lockb"), Buffer.from([0x62, 0x00, 0x01, 0xff]));
    await expect(
      callRaw(lockfileDiff, { before: "bun.lockb", after: "bun.lockb" }),
    ).rejects.toThrow(/BINARY/);
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

// ---------------------------------------------------------------------------
// 0.7.1 — the package.json LEAF is contained, not only its directory
// (security-7#1, flag-truth-4#8). Both tools used to realpath/contain the
// directory and then read `<dir>/package.json` through a following read; the
// parser's error quoted a bare token file whole.
// ---------------------------------------------------------------------------

describe("a package.json linked out of the workspace", () => {
  /** A token-shaped sentinel built at run time, clear of push protection. */
  const TOKEN = ["gh", "p_", "LEAKTEST".repeat(4)].join("");
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "crewhaus-pkg-outside-"));
    writeFileSync(
      join(outside, "secret.json"),
      '{"name":"leaked-name","version":"9.9.9","license":"LEAKED-LICENSE"}',
    );
    writeFileSync(join(outside, "token"), `${TOKEN}\n`);
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));

  test("LicenseAggregate skips and counts it, in neither the list nor the counts", async () => {
    mkdirSync(join(workspace, "node_modules", "leaky"), { recursive: true });
    symlinkSync(
      join(outside, "secret.json"),
      join(workspace, "node_modules", "leaky", "package.json"),
    );
    const dir = join(workspace, "node_modules", "honest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"honest","version":"1.0.0","license":"MIT"}');
    const out = await callRaw(licenseAggregate, { listPackages: true });
    const result = JSON.parse(out) as { packages: number; skippedOutsideWorkspace?: number };
    expect(result.packages).toBe(1);
    expect(result.skippedOutsideWorkspace).toBe(1);
    expect(out).not.toContain("LEAKED");
    expect(out).not.toContain("leaked-name");
  });

  test("a pnpm-style manifest link that stays inside is still read", async () => {
    const store = join(workspace, "store", "inner");
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "package.json"),
      '{"name":"inner","version":"1.0.0","license":"ISC"}',
    );
    mkdirSync(join(workspace, "node_modules", "inner"), { recursive: true });
    symlinkSync(
      join("..", "..", "store", "inner", "package.json"),
      join(workspace, "node_modules", "inner", "package.json"),
    );
    const result = await call<{ packages: number; counts: Array<{ license: string }> }>(
      licenseAggregate,
      {},
    );
    expect(result.packages).toBe(1);
    expect(result.counts[0]?.license).toBe("ISC");
  });

  test("an unparseable manifest is counted, not silently dropped", async () => {
    mkdirSync(join(workspace, "node_modules", "torn"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "torn", "package.json"), "{ torn");
    const result = await call<{ packages: number; skippedUnreadableManifests?: number }>(
      licenseAggregate,
      {},
    );
    expect(result.packages).toBe(0);
    expect(result.skippedUnreadableManifests).toBe(1);
  });

  test("PackagePublishPreflight never reads it — JSON or a bare token", async () => {
    for (const target of ["secret.json", "token"]) {
      rmSync(join(workspace, "pkg"), { recursive: true, force: true });
      mkdirSync(join(workspace, "pkg"));
      symlinkSync(join(outside, target), join(workspace, "pkg", "package.json"));
      const out = await callRaw(packagePublishPreflight, { directory: "pkg" }).catch((e) =>
        String(e),
      );
      expect({ target, leaked: out.includes(TOKEN) || out.includes("leaked-name") }).toEqual({
        target,
        leaked: false,
      });
      expect(out).toMatch(/escapes the workspace root/);
    }
  });

  test("a malformed manifest inside the workspace is named without quoting it", async () => {
    writeFileSync(join(workspace, "package.json"), `${TOKEN} not json`);
    const out = await callRaw(packagePublishPreflight, {});
    expect(out).toBe("package.json is not valid JSON");
  });

  // In a child process: before the fix the read BLOCKED on the FIFO, and a
  // blocked test would hang the suite instead of failing.
  test.skipIf(process.platform === "win32")(
    "a FIFO where a lockfile belongs is refused without being opened",
    async () => {
      writeFileSync(join(workspace, "package-lock.json"), "{}");
      execFileSync("mkfifo", [join(workspace, "fifo-lock.json")]);
      const script = `
        process.chdir(${JSON.stringify(workspace)});
        const { lockfileDiff } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        try { console.log(await lockfileDiff.execute({ before: "fifo-lock.json", after: "package-lock.json" }, {})); }
        catch (err) { console.log("threw: " + err.message); }
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const text = await new Response(child.stdout).text();
      clearTimeout(killer);
      expect(await child.exited).toBe(0);
      expect(text).toMatch(/threw: fifo-lock\.json is not a regular file \(it is a fifo\)/);
      expect(readdirSync(workspace).sort()).toEqual(["fifo-lock.json", "package-lock.json"]);
    },
    20_000,
  );
});
