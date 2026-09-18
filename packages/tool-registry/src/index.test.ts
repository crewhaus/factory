/**
 * Every tool this package registers, against a real temporary workspace and a
 * stubbed registry. No test here reaches the network: the fetch seam is
 * replaced in `beforeEach` and restored in `afterEach`, and several tests
 * assert that the seam was never called at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  REGISTRY_TOOLS,
  _setRegistryFetch,
  manifestDependencySet,
  registryOutdated,
  registryPackageInfo,
  registrySearch,
} from "./index";
import { ToolPermissionError } from "./paths";

const originalCwd = process.cwd();
let workspace: string;
let calls: string[];

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and these tools read only its signal.
const ctx = {} as any;

/** Answer from a table of URLs, and record everything that was asked for. */
function serve(
  routes: Record<string, unknown | { status: number; headers?: Record<string, string> }>,
): void {
  _setRegistryFetch(async (req) => {
    calls.push(req.url);
    const route = routes[req.url];
    if (route === undefined) return new Response(`{"message":"not found"}`, { status: 404 });
    const asStatus = route as { status?: number; headers?: Record<string, string> };
    if (typeof asStatus?.status === "number") {
      return new Response("", { status: asStatus.status, headers: asStatus.headers ?? {} });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  });
}

async function raw(tool: RegisteredTool, input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return (await tool.execute(parsed.data, ctx)) as string;
}

async function call<T = Record<string, unknown>>(tool: RegisteredTool, input: unknown): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

/** An npm packument with one deprecated latest. */
function packument(name: string, versions: string[], extra: Record<string, unknown> = {}): unknown {
  const latest = versions[versions.length - 1] as string;
  return {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map((v) => [v, { version: v, license: "MIT" }])),
    time: Object.fromEntries(versions.map((v) => [v, "2026-01-01T00:00:00.000Z"])),
    ...extra,
  };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-registry-"));
  process.chdir(workspace);
  calls = [];
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setRegistryFetch(undefined);
});

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("every tool is exported in REGISTRY_TOOLS, with a unique PascalCase name", () => {
    expect(REGISTRY_TOOLS.length).toBe(4);
    const names = REGISTRY_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of REGISTRY_TOOLS) expect(tool.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("the outdated tool is RegistryOutdated, not DependencyOutdated", () => {
    // @crewhaus/tool-code already registers DependencyOutdated, which compares
    // a manifest against its LOCKFILE and never leaves the machine. Registering
    // that name twice throws at catalog registration; answering a different
    // question under it would be worse.
    expect(registryOutdated.name).toBe("RegistryOutdated");
    expect(names()).not.toContain("DependencyOutdated");
    expect(registryOutdated.description).toContain("DependencyOutdated");
    expect(registryOutdated.ioCapability).toBe("network");
  });

  test("the three reading tools declare the network they cross", () => {
    for (const tool of [registryPackageInfo, registrySearch, registryOutdated]) {
      expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name: tool.name,
        scope: "external",
        io: "network",
      });
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: true,
      });
    }
  });

  test("the writer is the only destructive tool, and it asks for a justification", () => {
    expect(manifestDependencySet).toMatchObject({
      readOnly: false,
      destructive: true,
      requireJustification: true,
      concurrencySafe: false,
    });
    // It edits a file, not a socket: no network capability, no external scope.
    expect(manifestDependencySet.ioCapability).toBeUndefined();
    expect(manifestDependencySet.scope).toBe("internal");
    for (const tool of REGISTRY_TOOLS) {
      if (tool.name === "ManifestDependencySet") continue;
      expect({ name: tool.name, destructive: tool.destructive }).toEqual({
        name: tool.name,
        destructive: false,
      });
    }
  });

  test("every schema is strict, so a misspelled argument is an error not a silent default", async () => {
    for (const tool of REGISTRY_TOOLS) {
      const parsed = tool.inputSchema.safeParse({ nonsense: true });
      expect({ name: tool.name, ok: parsed.success }).toEqual({ name: tool.name, ok: false });
    }
  });
});

function names(): string[] {
  return REGISTRY_TOOLS.map((t) => t.name);
}

// ---------------------------------------------------------------------------

describe("RegistryPackageInfo", () => {
  test("it reports what the registry publishes, and nothing it does not", async () => {
    serve({
      "https://registry.npmjs.org/left-pad": packument("left-pad", ["1.0.0", "1.3.0"], {
        versions: {
          "1.0.0": { version: "1.0.0" },
          "1.3.0": {
            version: "1.3.0",
            license: "WTFPL",
            description: "pads",
            deprecated: "use String.prototype.padStart",
            repository: { url: "git+https://github.com/x/left-pad.git" },
          },
        },
      }),
    });
    const info = await call(registryPackageInfo, { ecosystem: "npm", name: "left-pad" });
    expect(info).toMatchObject({
      exists: true,
      latest: "1.3.0",
      license: "WTFPL",
      deprecated: "use String.prototype.padStart",
      versionCount: 2,
    });
    // No versions array was asked for, so none is returned.
    expect(info["versions"]).toBeUndefined();
  });

  test("a package that is not published is an answer, not an error", async () => {
    serve({});
    const info = await call(registryPackageInfo, { ecosystem: "npm", name: "definitely-not-real" });
    expect(info).toEqual({ ecosystem: "npm", name: "definitely-not-real", exists: false });
  });

  test("a name that is really a path is refused before anything is dialled", async () => {
    serve({});
    const text = await raw(registryPackageInfo, { ecosystem: "npm", name: "../-/user/me" });
    expect(text).toContain("not a valid npm package name");
    expect(calls).toEqual([]);
  });

  test("it resolves a range against what is actually published", async () => {
    serve({
      "https://registry.npmjs.org/zod": packument("zod", ["3.22.0", "3.23.8", "4.0.0"]),
    });
    const info = await call(registryPackageInfo, {
      ecosystem: "npm",
      name: "zod",
      range: "^3.22.0",
      version: "3.23.8",
      includeVersions: true,
      maxVersions: 2,
    });
    expect(info["resolved"]).toMatchObject({ range: "^3.22.0", resolved: "3.23.8" });
    expect(info["requestedVersion"]).toMatchObject({ version: "3.23.8", published: true });
    expect(info["versions"]).toEqual(["4.0.0", "3.23.8"]);
    expect(info["versionsTruncated"]).toBe(true);
  });

  test("the version list comes back in version order, not string order", async () => {
    serve({
      "https://registry.npmjs.org/wide": packument("wide", ["1.2.0", "1.9.0", "1.10.0"]),
    });
    const info = await call(registryPackageInfo, {
      ecosystem: "npm",
      name: "wide",
      includeVersions: true,
    });
    expect(info["versions"]).toEqual(["1.10.0", "1.9.0", "1.2.0"]);
  });

  test("a range the grammar cannot evaluate says so instead of resolving to null quietly", async () => {
    serve({ "https://registry.npmjs.org/zod": packument("zod", ["3.23.8"]) });
    const info = await call(registryPackageInfo, {
      ecosystem: "npm",
      name: "zod",
      range: "workspace:*",
    });
    expect(info["resolved"]).toMatchObject({ resolved: null });
    expect(String((info["resolved"] as Record<string, unknown>)["note"])).toContain("location");
  });

  test("a deadline that has already elapsed is reported as a deadline", async () => {
    // Not a sleep race: the run's own signal is aborted before the call, so
    // the stub sees an aborted request on its first and only invocation.
    _setRegistryFetch(async (req) => {
      if (req.signal.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return new Response("{}");
    });
    const parsed = registryPackageInfo.inputSchema.safeParse({ ecosystem: "npm", name: "zod" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const text = (await registryPackageInfo.execute(parsed.data, {
      signal: AbortSignal.abort(),
    })) as string;
    // "ok === false" is what an abort returns too, so the REASON is asserted.
    expect(text).toContain("deadline elapsed");
  });

  test("a rate-limited registry is reported as such, with what it asked for", async () => {
    serve({
      "https://crates.io/api/v1/crates/serde": { status: 429, headers: { "retry-after": "30" } },
    });
    const text = await raw(registryPackageInfo, { ecosystem: "crates", name: "serde" });
    expect(text).toContain("rate-limited");
    expect(text).toContain("30");
  });
});

describe("RegistrySearch", () => {
  test("PyPI is refused with the reason and nothing is dialled", async () => {
    serve({});
    const text = await raw(registrySearch, { ecosystem: "pypi", query: "http client" });
    expect(text).toContain("no search API");
    expect(calls).toEqual([]);
  });

  test("a sort npm cannot do is declined rather than faked", async () => {
    serve({
      "https://registry.npmjs.org/-/v1/search?text=router&size=10": {
        total: 5,
        objects: [{ package: { name: "router", version: "2.0.0", links: {} } }],
      },
    });
    const result = await call(registrySearch, {
      ecosystem: "npm",
      query: "router",
      sort: "downloads",
    });
    expect(result).toMatchObject({ sortRequested: "downloads", sortApplied: false, count: 1 });
    expect(String(result["sortNote"])).toContain("relevance");
  });
});

// ---------------------------------------------------------------------------

describe("RegistryOutdated", () => {
  test("it reads a package.json and separates current, outdated and unknowable", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify(
        {
          dependencies: { current: "^2.0.0", behind: "^1.0.0", local: "workspace:*" },
          devDependencies: { gone: "^1.0.0" },
        },
        null,
        2,
      ),
    );
    serve({
      "https://registry.npmjs.org/current": packument("current", ["2.0.0", "2.4.1"]),
      "https://registry.npmjs.org/behind": packument("behind", ["1.0.0", "2.0.0"]),
    });
    const report = await call(registryOutdated, {});
    expect(report).toMatchObject({ ecosystem: "npm", checked: 2, outdatedCount: 1 });
    const rows = report["rows"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["name"])).toEqual(["behind", "current"]);
    expect(rows[0]).toMatchObject({
      current: "^1.0.0",
      wanted: "1.0.0",
      latest: "2.0.0",
      delta: "major",
      upToDate: false,
    });
    expect(rows[1]).toMatchObject({ upToDate: true, wanted: "2.4.1" });
    const unchecked = report["unchecked"] as Array<Record<string, unknown>>;
    expect(unchecked.map((r) => r["name"]).sort()).toEqual(["gone", "local"]);
    // A dependency the registry has never heard of is unchecked, NOT up to date.
    expect(unchecked.find((r) => r["name"] === "gone")?.["reason"]).toContain("not published");
  });

  test("a bare Cargo requirement is read as Cargo means it", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), `[dependencies]\nserde = "1"\n`);
    serve({
      "https://crates.io/api/v1/crates/serde": {
        crate: { name: "serde", max_stable_version: "1.9.0" },
        versions: [
          { num: "1.9.0", yanked: false },
          { num: "1.0.0", yanked: false },
        ],
      },
    });
    const report = await call(registryOutdated, {});
    // Read with npm's rules, `1` would mean exactly 1.0.0 and this row would
    // read as outdated. Cargo means ^1, and 1.9.0 satisfies it.
    expect((report["rows"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      upToDate: true,
      wanted: "1.9.0",
    });
  });

  test("a directory holding two different manifests is refused, not guessed at", async () => {
    writeFileSync(join(workspace, "package.json"), "{}");
    writeFileSync(join(workspace, "Cargo.toml"), "[dependencies]\n");
    const text = await raw(registryOutdated, {});
    expect(text).toContain("name the one to read");
  });

  test("an explicit dependency list needs an ecosystem, because a name is not unique", async () => {
    serve({});
    const text = await raw(registryOutdated, { dependencies: [{ name: "requests", spec: ">=2" }] });
    expect(text).toContain("needs an ecosystem");
    expect(calls).toEqual([]);
  });

  test("Poetry's interpreter constraint is skipped rather than looked up on PyPI", async () => {
    writeFileSync(
      join(workspace, "pyproject.toml"),
      `[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\n`,
    );
    serve({
      "https://pypi.org/pypi/requests/json": {
        info: { version: "2.32.3" },
        releases: { "2.31.0": [{ yanked: false }], "2.32.3": [{ yanked: false }] },
      },
    });
    const report = await call(registryOutdated, {});
    expect(calls).toEqual(["https://pypi.org/pypi/requests/json"]);
    expect((report["skipped"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "python",
    });
  });

  test("a Poetry project produces rows, not a table of unevaluable pins", async () => {
    // `^2.31`, `~0.27`, a bare `2.31` and `*` are what a [tool.poetry…] table
    // holds, and none of them is a PEP 440 specifier. Read as PEP 440 every
    // row lands in "unchecked" and outdatedCount stays 0, which reads as
    // "nothing to upgrade" for a project that is three minors behind.
    writeFileSync(
      join(workspace, "pyproject.toml"),
      `[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\nhttpx = { version = "~0.27", extras = ["http2"] }\npinned = "1.0"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n`,
    );
    const release = (latest: string, versions: string[]): unknown => ({
      info: { version: latest },
      releases: Object.fromEntries(versions.map((v) => [v, [{ yanked: false }]])),
    });
    serve({
      "https://pypi.org/pypi/requests/json": release("2.32.3", ["2.31.0", "2.32.3"]),
      "https://pypi.org/pypi/httpx/json": release("0.28.1", ["0.27.0", "0.27.2", "0.28.1"]),
      "https://pypi.org/pypi/pinned/json": release("1.1.0", ["1.0", "1.1.0"]),
      "https://pypi.org/pypi/pytest/json": release("8.3.0", ["8.0.0", "8.3.0"]),
    });
    const report = await call(registryOutdated, {});
    expect(report).toMatchObject({ checked: 4, outdatedCount: 2 });
    expect(report["unchecked"]).toBeUndefined();
    const rows = Object.fromEntries(
      (report["rows"] as Array<Record<string, unknown>>).map((row) => [row["name"], row]),
    );
    // `^2.31` still admits 2.32.3, so it is current; `~0.27` does not admit
    // 0.28.1, and a bare Poetry version is an exact pin that 1.1.0 breaks.
    expect(rows["requests"]).toMatchObject({ upToDate: true, wanted: "2.32.3" });
    expect(rows["httpx"]).toMatchObject({ upToDate: false, wanted: "0.27.2", delta: "minor" });
    expect(rows["pinned"]).toMatchObject({ current: "1.0", upToDate: false, latest: "1.1.0" });
    expect(rows["pytest"]).toMatchObject({ upToDate: true });
  });

  test("a PEP 621 array in the same file is still read as PEP 508", async () => {
    writeFileSync(
      join(workspace, "pyproject.toml"),
      `[project]\ndependencies = ["requests>=2.31,<3"]\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n`,
    );
    serve({
      "https://pypi.org/pypi/requests/json": {
        info: { version: "3.1.0" },
        releases: { "2.31.0": [{ yanked: false }], "3.1.0": [{ yanked: false }] },
      },
      "https://pypi.org/pypi/pytest/json": {
        info: { version: "8.3.0" },
        releases: { "8.0.0": [{ yanked: false }], "8.3.0": [{ yanked: false }] },
      },
    });
    const report = await call(registryOutdated, {});
    const rows = Object.fromEntries(
      (report["rows"] as Array<Record<string, unknown>>).map((row) => [row["name"], row]),
    );
    expect(rows["requests"]).toMatchObject({ upToDate: false, latest: "3.1.0" });
    expect(rows["pytest"]).toMatchObject({ upToDate: true });
  });

  test("a manifest whose declarations it could not locate says so, rather than reporting zero", async () => {
    // `outdatedCount: 0` over an empty table is the answer a tool gives when
    // it compared nothing at all, and it reads exactly like "all current".
    writeFileSync(
      join(workspace, "Cargo.toml"),
      `[package]\nname = "demo"\ndependencies.serde = "1"\n`,
    );
    const report = await call(registryOutdated, {});
    expect(report).toMatchObject({ checked: 0, outdatedCount: 0 });
    expect(String(report["note"])).toContain("no dependency declaration was located");
    expect(calls).toEqual([]);
  });

  test("a table where every row is unevaluable says that too", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { a: "workspace:*", b: "file:../b" } }),
    );
    const report = await call(registryOutdated, {});
    expect(report).toMatchObject({ checked: 0, outdatedCount: 0 });
    expect(String(report["note"])).toContain("could be compared against the registry");
  });

  test("a PyPI version that does not order as semver is unchecked, with the reason", async () => {
    writeFileSync(join(workspace, "pyproject.toml"), `[project]\ndependencies = ["odd>=1"]\n`);
    serve({
      "https://pypi.org/pypi/odd/json": {
        info: { version: "2024.1rc1" },
        releases: { "2024.1rc1": [{ yanked: false }] },
      },
    });
    const report = await call(registryOutdated, {});
    expect(report["checked"]).toBe(0);
    const unchecked = (report["unchecked"] as Array<Record<string, unknown>>)[0];
    expect(String(unchecked?.["reason"])).toContain("does not order as semver");
  });

  test("a section filter that matches nothing says which sections exist", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { a: "^1.0.0" }, devDependencies: { b: "^1.0.0" } }),
    );
    const text = await raw(registryOutdated, { sections: ["peerDependencies"] });
    expect(text).toContain("dependencies, devDependencies");
    expect(calls).toEqual([]);
  });

  test("the package cap is reported rather than silently applied", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { a: "^1.0.0", b: "^1.0.0", c: "^1.0.0" } }),
    );
    serve({ "https://registry.npmjs.org/a": packument("a", ["1.0.0"]) });
    const report = await call(registryOutdated, { maxPackages: 1 });
    expect(report).toMatchObject({ truncated: true, packagesSeen: 3 });
    expect(calls).toEqual(["https://registry.npmjs.org/a"]);
  });

  test("a scoped package is asked for as one path segment, with the scope literal", async () => {
    // `@scope%2Fpkg` is the form npm's own client sends. Encoding the `@` as
    // well relies on the registry decoding a sub-delimiter it never has to,
    // and a 404 there would be reported as "this package does not exist".
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { "@scope/pkg": "^1.0.0" } }),
    );
    serve({
      "https://registry.npmjs.org/@scope%2Fpkg": packument("@scope/pkg", ["1.0.0", "1.2.0"]),
    });
    const report = await call(registryOutdated, {});
    expect(calls).toEqual(["https://registry.npmjs.org/@scope%2Fpkg"]);
    expect(report).toMatchObject({ checked: 1 });
  });

  test("it asks npm for the install-sized document, not the full packument", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { a: "^1.0.0" } }),
    );
    const accepts: Array<string | null> = [];
    _setRegistryFetch(async (req) => {
      accepts.push(req.headers.get("accept"));
      return new Response(JSON.stringify(packument("a", ["1.0.0"])));
    });
    await call(registryOutdated, {});
    expect(accepts[0]).toBe("application/vnd.npm.install-v1+json");
  });
});

// ---------------------------------------------------------------------------

describe("ManifestDependencySet", () => {
  const cargo = `# Kept, along with every blank line and every trailing comment.
[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = { version = "1.0.190", features = ["derive"] }  # why this crate is here
anyhow = "1.0.75"
tokio.version = "1.35.0"

[dependencies.regex]
version = "1.10.2"        # aligned on purpose

[dev-dependencies]
serde = "1.0.190"
`;

  test("a Cargo edit changes the version and NOTHING else", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), cargo);
    const report = await call(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [
        { name: "anyhow", spec: "1.0.86" },
        { name: "regex", spec: "1.11.0" },
        { name: "tokio", spec: "1.40.0" },
        { name: "serde", spec: "1.0.200", section: "dependencies" },
      ],
    });
    expect(report["applied"]).toBe(true);
    const after = readFileSync(join(workspace, "Cargo.toml"), "utf-8");
    expect(after).toBe(
      cargo
        .replace('anyhow = "1.0.75"', 'anyhow = "1.0.86"')
        .replace('version = "1.10.2"', 'version = "1.11.0"')
        .replace('tokio.version = "1.35.0"', 'tokio.version = "1.40.0"')
        .replace('serde = { version = "1.0.190"', 'serde = { version = "1.0.200"'),
    );
    // The comments, the alignment, the blank lines and the dev-dependencies
    // copy of serde are all still there, byte for byte.
    expect(after).toContain("# why this crate is here");
    expect(after).toContain('version = "1.11.0"        # aligned on purpose');
    expect(after).toContain('[dev-dependencies]\nserde = "1.0.190"\n');
  });

  test("package.json keeps its indentation, key order and trailing newline", async () => {
    const before = `{\n    "name": "demo",\n    "dependencies": {\n        "zod": "^3.23.8",\n        "left-pad": "1.3.0"\n    }\n}\n`;
    writeFileSync(join(workspace, "package.json"), before);
    await call(manifestDependencySet, {
      manifest: "package.json",
      edits: [{ name: "zod", spec: "3.24.0" }],
    });
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(
      before.replace('"^3.23.8"', '"^3.24.0"'),
    );
  });

  test("the range style is carried over, or reported as not carried over", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { caret: "^1.0.0", wide: ">=1 <3" } }),
    );
    const report = await call(manifestDependencySet, {
      manifest: "package.json",
      edits: [
        { name: "caret", spec: "1.2.0" },
        { name: "wide", spec: "1.2.0" },
      ],
    });
    const edits = report["edits"] as Array<Record<string, unknown>>;
    expect(edits[0]).toMatchObject({ to: "^1.2.0", stylePreserved: true });
    expect(edits[1]).toMatchObject({ to: "1.2.0", stylePreserved: false });
    expect(String(edits[1]?.["styleNote"])).toContain("single-prefix");
  });

  test("a PEP 621 requirement keeps its extras and its marker", async () => {
    const before = `[project]
name = "demo"
dependencies = [
  "requests>=2.31,<3",          # pinned low on purpose
  "httpx[http2]==0.27.0 ; python_version >= '3.9'",
]
`;
    writeFileSync(join(workspace, "pyproject.toml"), before);
    await call(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [
        { name: "requests", spec: ">=2.32" },
        { name: "httpx", spec: "==0.28.1" },
      ],
    });
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(
      before
        .replace(">=2.31,<3", ">=2.32")
        .replace("==0.27.0 ; python_version", "==0.28.1 ; python_version"),
    );
  });

  test("a bare version is refused for a requirement string, because it would fuse into the name", async () => {
    writeFileSync(join(workspace, "pyproject.toml"), `[project]\ndependencies = ["tomli"]\n`);
    const text = await raw(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [{ name: "tomli", spec: "2.0.1" }],
    });
    expect(text).toContain("needs an operator");
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(
      `[project]\ndependencies = ["tomli"]\n`,
    );
  });

  test("a requirement that pinned nothing gets its specifier inserted, not appended", async () => {
    writeFileSync(
      join(workspace, "pyproject.toml"),
      `[project]\ndependencies = ["tomli ; python_version < '3.11'"]\n`,
    );
    await call(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [{ name: "tomli", spec: ">=2.0.1" }],
    });
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(
      `[project]\ndependencies = ["tomli>=2.0.1 ; python_version < '3.11'"]\n`,
    );
  });

  test("a git dependency is refused by name, and the whole edit is abandoned", async () => {
    const before = `[dependencies]\nserde = "1.0.190"\nmine = { git = "https://example.invalid/mine" }\n`;
    writeFileSync(join(workspace, "Cargo.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [
        { name: "serde", spec: "1.0.200" },
        { name: "mine", spec: "2.0.0" },
      ],
    });
    expect(text).toContain("refused the whole edit");
    expect(text).toContain("no version");
    // The edit it COULD have applied was not applied: a half-done bump is a
    // state nobody asked for.
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(before);
  });

  test("a name in two sections is refused until the section is named", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), cargo);
    const refused = await raw(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "serde", spec: "1.0.200" }],
    });
    expect(refused).toContain("dependencies, dev-dependencies");
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(cargo);

    const applied = await call(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "serde", spec: "1.0.200", section: "dev-dependencies" }],
    });
    expect(applied["applied"]).toBe(true);
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toContain(
      '[dev-dependencies]\nserde = "1.0.200"\n',
    );
  });

  test("one package pinned twice in one list is refused, because naming the section cannot help", async () => {
    const before = `[project]\ndependencies = [\n  "tomli>=1 ; python_version < '3.11'",\n  "tomli>=2 ; python_version >= '3.11'",\n]\n`;
    writeFileSync(join(workspace, "pyproject.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [{ name: "tomli", spec: ">=3" }],
    });
    expect(text).toContain("will not choose between them");
    expect(text).toContain("lines 3, 4");
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(before);
  });

  test("a spec that would break out of its quotes never reaches the file", async () => {
    const before = JSON.stringify({ dependencies: { a: "^1.0.0" } });
    writeFileSync(join(workspace, "package.json"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "package.json",
      edits: [{ name: "a", spec: '1.0.0", "evil": "9' }],
    });
    expect(text).toContain("double quote");
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(before);
  });

  test("it changes a version; it does not add a dependency", async () => {
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ dependencies: { a: "^1" } }));
    const text = await raw(manifestDependencySet, {
      manifest: "package.json",
      edits: [{ name: "brand-new", spec: "^1.0.0" }],
    });
    expect(text).toContain("does not add a dependency");
  });

  test("a dry run reports the same plan and writes nothing", async () => {
    const before = JSON.stringify({ dependencies: { a: "^1.0.0" } });
    writeFileSync(join(workspace, "package.json"), before);
    const report = await call(manifestDependencySet, {
      manifest: "package.json",
      edits: [{ name: "a", spec: "1.1.0" }],
      dryRun: true,
    });
    expect(report).toMatchObject({ applied: false, dryRun: true, changed: 1 });
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(before);
  });

  test("a manifest grammar this package does not write is named and refused", async () => {
    writeFileSync(join(workspace, "go.mod"), "module example.com/x\n\nrequire foo v1.2.3\n");
    const text = await raw(manifestDependencySet, {
      manifest: "go.mod",
      edits: [{ name: "foo", spec: "v1.3.0" }],
    });
    expect(text).toContain("go.mod");
    expect(text).toContain("different grammar");
  });

  test("a manifest outside the workspace is refused by the path resolver", async () => {
    await expect(
      raw(manifestDependencySet, {
        manifest: "../escape/package.json",
        edits: [{ name: "a", spec: "1.0.0" }],
      }),
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });

  test("CRLF line endings and a byte-order mark both survive an edit", async () => {
    const before = `\ufeff[dependencies]\r\nanyhow = "1.0.75"  # windows\r\nserde = "1.0.190"\r\n`;
    writeFileSync(join(workspace, "Cargo.toml"), before);
    const report = await call(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "anyhow", spec: "1.0.86" }],
    });
    expect(report["applied"]).toBe(true);
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(
      before.replace('anyhow = "1.0.75"', 'anyhow = "1.0.86"'),
    );
  });

  test("a package.json written with a byte-order mark is read, not refused", async () => {
    const before = `\ufeff{"dependencies":{"a":"^1.0.0"}}`;
    writeFileSync(join(workspace, "package.json"), before);
    await call(manifestDependencySet, {
      manifest: "package.json",
      edits: [{ name: "a", spec: "1.1.0" }],
    });
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(
      before.replace("^1.0.0", "^1.1.0"),
    );
  });

  test("two edits aimed at the same bytes are refused rather than raced", async () => {
    const before = JSON.stringify({ dependencies: { a: "^1.0.0" } });
    writeFileSync(join(workspace, "package.json"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "package.json",
      edits: [
        { name: "a", spec: "1.1.0" },
        { name: "a", spec: "1.2.0" },
      ],
    });
    expect(text).toContain("same bytes");
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(before);
  });

  test("a target-specific Cargo table is an addressable section", async () => {
    const before = `[dependencies]\nnix = "0.27.0"\n\n[target."cfg(windows)".dependencies]\nnix = "0.26.0"\n`;
    writeFileSync(join(workspace, "Cargo.toml"), before);
    const report = await call(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "nix", spec: "0.29.0", section: "target.cfg(windows).dependencies" }],
    });
    expect(report["applied"]).toBe(true);
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(
      before.replace('nix = "0.26.0"', 'nix = "0.29.0"'),
    );
  });

  test("a scoped npm package is matched exactly, scope and all", async () => {
    const before = `{"dependencies":{"@scope/pkg":"^1.0.0","pkg":"^1.0.0"}}`;
    writeFileSync(join(workspace, "package.json"), before);
    await call(manifestDependencySet, {
      manifest: "package.json",
      edits: [{ name: "@scope/pkg", spec: "2.0.0" }],
    });
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(
      `{"dependencies":{"@scope/pkg":"^2.0.0","pkg":"^1.0.0"}}`,
    );
  });

  test("an exclusive upper bound is not carried onto the version being set", async () => {
    // `<2.0.0` carried onto a bump to 2.5.0 writes `<2.5.0` — a manifest that
    // still cannot install the version that was just requested, reported as a
    // preserved style.
    const before = `{"dependencies":{"capped":"<2.0.0","floored":">1.0.0"}}`;
    writeFileSync(join(workspace, "package.json"), before);
    const report = await call(manifestDependencySet, {
      manifest: "package.json",
      edits: [
        { name: "capped", spec: "2.5.0" },
        { name: "floored", spec: "2.5.0" },
      ],
    });
    expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(
      `{"dependencies":{"capped":"2.5.0","floored":"2.5.0"}}`,
    );
    for (const edit of report["edits"] as Array<Record<string, unknown>>) {
      expect({ name: edit["name"], to: edit["to"], preserved: edit["stylePreserved"] }).toEqual({
        name: edit["name"],
        to: "2.5.0",
        preserved: false,
      });
      expect(String(edit["styleNote"])).toContain("excludes 2.5.0");
    }
  });

  test("a capped PEP 508 requirement is refused rather than capped below the new version", async () => {
    // `requests<3` set to 2.32.3 used to write `requests<2.32.3`. With the
    // bound dropped the new spec is bare, which a requirement cannot take —
    // so the caller is made to say whether they meant >= or ==.
    const before = `[project]\ndependencies = ["requests<3"]\n`;
    writeFileSync(join(workspace, "pyproject.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [{ name: "requests", spec: "2.32.3" }],
    });
    expect(text).toContain("needs an operator");
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(before);
  });

  test("the temp file is created exclusively, so a link at its name cannot carry the write out", async () => {
    // The manifest path goes through `resolveSafe` so a symlink cannot carry
    // a write outside the workspace. The temp name beside it is derived and
    // predictable, so it is opened O_EXCL rather than handed to a plain open.
    const before = JSON.stringify({ dependencies: { a: "^1.0.0" } });
    writeFileSync(join(workspace, "package.json"), before);
    const outside = join(tmpdir(), `crewhaus-registry-outside-${process.pid}`);
    rmSync(outside, { force: true });
    symlinkSync(outside, join(workspace, `package.json.tmp-${process.pid}`));
    try {
      const text = await raw(manifestDependencySet, {
        manifest: "package.json",
        edits: [{ name: "a", spec: "1.1.0" }],
      });
      expect(text).toContain("wrote nothing");
      expect(readFileSync(join(workspace, "package.json"), "utf-8")).toBe(before);
      // Nothing was created through the link.
      expect(() => readFileSync(outside)).toThrow();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("a dependency declared twice in one TOML table is refused, not half-edited", async () => {
    const before = `[dependencies]\nserde = "1.0"\nserde = "2.0"\n`;
    writeFileSync(join(workspace, "Cargo.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "serde", spec: "3.0" }],
    });
    expect(text).toContain("refused the whole edit");
    expect(text).toContain("declared 2 times");
    // Editing the first and leaving the second is how a manifest ends up
    // saying two different things about one crate.
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(before);
  });

  test("a manifest that is not valid UTF-8 is refused rather than silently re-encoded", async () => {
    // The splice happens on the decoded string: a byte the decoder replaced
    // with U+FFFD is written back changed, arbitrarily far from the edit.
    const before = Buffer.from(`# caf\xE9 latin-1\n[dependencies]\nanyhow = "1.0.75"\n`, "latin1");
    writeFileSync(join(workspace, "Cargo.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "anyhow", spec: "1.0.86" }],
    });
    expect(text).toContain("not valid UTF-8");
    expect(Buffer.compare(readFileSync(join(workspace, "Cargo.toml")), before)).toBe(0);
  });

  test("two edits aimed at one unpinned requirement are refused, not spliced twice", async () => {
    // A requirement with no specifier has an EMPTY span, and two empty spans
    // at one offset do not overlap by the interval test — both splices would
    // land at the same point and concatenate.
    const before = `[project]\ndependencies = ["tomli"]\n`;
    writeFileSync(join(workspace, "pyproject.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [
        { name: "tomli", spec: ">=2.0.1" },
        { name: "tomli", spec: ">=2.1.0" },
      ],
    });
    expect(text).toContain("same bytes");
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(before);
  });

  test("a spec that would smuggle in an environment marker is caught by the re-read", async () => {
    // `;` is not a quote or a comment character, so it passes the spec gate —
    // and splicing it would attach a marker the caller never declared. The
    // re-read is what catches it, and it runs before anything is written.
    const before = `[project]\ndependencies = ["requests>=2"]\n`;
    writeFileSync(join(workspace, "pyproject.toml"), before);
    const text = await raw(manifestDependencySet, {
      manifest: "pyproject.toml",
      edits: [{ name: "requests", spec: ">=1 ; sys_platform == 'win32'" }],
    });
    expect(text).toContain("could not verify");
    expect(text).toContain("wrote nothing");
    expect(readFileSync(join(workspace, "pyproject.toml"), "utf-8")).toBe(before);
  });

  test("a file that does not scan as TOML is refused whole, with where it stopped", async () => {
    const broken = `[dependencies]\nserde = "1.0\nanyhow = "1"\n`;
    writeFileSync(join(workspace, "Cargo.toml"), broken);
    const text = await raw(manifestDependencySet, {
      manifest: "Cargo.toml",
      edits: [{ name: "anyhow", spec: "1.1" }],
    });
    expect(text).toContain("does not scan as TOML");
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(broken);
  });
});
