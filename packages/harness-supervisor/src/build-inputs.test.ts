import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildLinkMessage, verifyActiveBuild } from "./active-build";
import {
  bootInputsOf,
  buildDigest,
  collectBuildFiles,
  linkEntriesOf,
  parseJsonc,
} from "./build-inputs";
import { activateBuildForTest } from "./testkit";

const roots: string[] = [];
function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-build-"));
  roots.push(dir);
  put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
  put(dir, "dist/daemon.ts", "// bundle\n");
  put(dir, "dist/package.json", '{"name":"crewhaus-compiled-bundle"}\n');
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function digest(dir: string, artifact: Parameters<typeof buildDigest>[1]): string {
  const taken = buildDigest(dir, artifact);
  if ("unreadable" in taken) throw new Error(taken.unreadable);
  return taken.digest;
}

const DIST = { entry: "dist/daemon.ts" };

describe("collectBuildFiles", () => {
  test("a file added under dist/ changes the digest", () => {
    const dir = harness();
    const before = digest(dir, DIST);
    put(dir, "dist/extra/planted.ts", "x\n");
    expect(digest(dir, DIST)).not.toBe(before);
  });

  test("node_modules and the install's lockfile under the bundle do not", () => {
    const dir = harness();
    const before = digest(dir, DIST);
    put(dir, "dist/node_modules/@crewhaus/x/index.ts", "y\n");
    put(dir, "dist/bun.lock", "{}\n");
    expect(digest(dir, DIST)).toBe(before);
  });

  test("the resolver configuration from the bundle up to the root counts, present or absent", () => {
    const dir = harness();
    const before = digest(dir, DIST);
    put(dir, "tsconfig.json", "{}\n");
    const withRoot = digest(dir, DIST);
    expect(withRoot).not.toBe(before);
    put(dir, "tsconfig.json", '{"compilerOptions":{}}\n');
    expect(digest(dir, DIST)).not.toBe(withRoot);
    put(dir, "dist/bunfig.toml", "preload = []\n");
    expect(digest(dir, DIST)).not.toBe(withRoot);
  });

  test("a tsconfig two levels above a nested bundle counts", () => {
    const dir = harness();
    put(dir, "build/out/agent.ts", "// nested\n");
    const nested = { entry: "build/out/agent.ts" };
    const before = digest(dir, nested);
    put(dir, "tsconfig.json", "{}\n");
    expect(digest(dir, nested)).not.toBe(before);
  });

  test("a file a root tsconfig.json extends counts, followed in turn", () => {
    const dir = harness();
    put(dir, "tsconfig.json", '{ // comment\n "extends": "./config/base",\n}\n');
    put(dir, "config/base.json", '{"extends": "./deeper.json"}\n');
    put(dir, "config/deeper.json", '{"compilerOptions": {"jsx": "react"}}\n');
    const files = collectBuildFiles(dir, DIST);
    expect(Array.isArray(files) && files.map((f) => f.path)).toContain("config/deeper.json");
    const before = digest(dir, DIST);
    put(dir, "config/deeper.json", '{"compilerOptions": {"jsx": "preserve"}}\n');
    expect(digest(dir, DIST)).not.toBe(before);
  });

  test("an extends cycle terminates", () => {
    const dir = harness();
    put(dir, "tsconfig.json", '{"extends": "./a.json"}');
    put(dir, "a.json", '{"extends": "./b.json"}');
    put(dir, "b.json", '{"extends": "./a.json"}');
    const files = collectBuildFiles(dir, DIST);
    expect(Array.isArray(files)).toBe(true);
  });

  test("a package specifier or a path outside the harness is recorded by its text", () => {
    const dir = harness();
    put(dir, "tsconfig.json", '{"extends": ["@tsconfig/bun", "../elsewhere.json"]}');
    const files = collectBuildFiles(dir, DIST);
    const paths = Array.isArray(files) ? files.map((f) => f.path) : [];
    expect(paths).toContain("extends:@tsconfig/bun");
    expect(paths).toContain("extends:../elsewhere.json");
  });

  test("a link replacing a file changes the digest and is never read", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "chsup-build-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.ts"), "never read\n");
    const before = digest(dir, DIST);
    unlinkSync(join(dir, "dist/daemon.ts"));
    symlinkSync(join(outside, "secret.ts"), join(dir, "dist/daemon.ts"));
    const files = collectBuildFiles(dir, DIST);
    const entry = Array.isArray(files) ? files.find((f) => f.path === "dist/daemon.ts") : undefined;
    expect(entry).toEqual({
      path: "dist/daemon.ts",
      sha256: null,
      link: join(outside, "secret.ts"),
    });
    expect(digest(dir, DIST)).not.toBe(before);
  });

  test("a linked bundle directory is recorded as one link, and nothing is read through it", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "chsup-build-outside-"));
    roots.push(outside);
    put(outside, "daemon.ts", "// elsewhere\n");
    put(outside, "tsconfig.json", '{"extends":"./base.json"}\n');
    put(outside, "base.json", "{}\n");
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    symlinkSync(outside, join(dir, "dist"), "dir");
    const files = collectBuildFiles(dir, DIST);
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(files.find((f) => f.path === "dist")).toEqual({
      path: "dist",
      sha256: null,
      link: outside,
    });
    expect(files.filter((f) => f.path.startsWith("dist/"))).toEqual([]);
    expect(linkEntriesOf(files)).toEqual(["dist"]);
  });

  test("a linked directory on the way to a boot input is recorded as the link, not the file", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "chsup-build-outside-"));
    roots.push(outside);
    put(outside, "server.ts", "// elsewhere\n");
    symlinkSync(outside, join(dir, "tools"), "dir");
    const files = collectBuildFiles(dir, { ...DIST, bootInputs: ["tools/server.ts"] });
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(files.find((f) => f.path === "tools")).toEqual({
      path: "tools",
      sha256: null,
      link: outside,
    });
    expect(files.find((f) => f.path === "tools/server.ts")).toBeUndefined();
    expect(linkEntriesOf(files)).toEqual(["tools"]);
  });

  test("a boot input under a directory linked outside the harness is named, then refused as the link", () => {
    const dir = harness();
    put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
    const outside = mkdtempSync(join(tmpdir(), "chsup-build-outside-"));
    roots.push(outside);
    put(outside, "server.ts", "// elsewhere\n");
    symlinkSync(outside, join(dir, "tools"), "dir");
    const ir = {
      mcp_servers: { a: { transport: "stdio", command: "bun", args: ["tools/server.ts"] } },
    };
    const bootInputs = bootInputsOf(dir, ir);
    expect(bootInputs).toEqual(["tools/server.ts"]);
    const files = collectBuildFiles(dir, { ...DIST, bootInputs });
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(linkEntriesOf(files)).toEqual(["tools"]);
    activateBuildForTest(dir, "dist/daemon.ts", { bootInputs });
    expect(verifyActiveBuild(dir, "channel")).toEqual({
      ok: false,
      reason: "link",
      message: buildLinkMessage("tools"),
    });
  });

  test("a tsconfig extends through a directory linked outside the harness is refused as the link", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "chsup-build-outside-"));
    roots.push(outside);
    put(outside, "base.json", "{}\n");
    symlinkSync(outside, join(dir, "cfg"), "dir");
    put(dir, "tsconfig.json", '{ "extends": "./cfg/base.json" }\n');
    const files = collectBuildFiles(dir, DIST);
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(linkEntriesOf(files)).toEqual(["cfg"]);
    expect(files.find((f) => f.path === "cfg")).toEqual({
      path: "cfg",
      sha256: null,
      link: outside,
    });
    expect(files.filter((f) => f.path.startsWith("extends:"))).toEqual([]);
    activateBuildForTest(dir, "dist/daemon.ts");
    expect(verifyActiveBuild(dir, "channel")).toMatchObject({ ok: false, reason: "link" });
  });

  test("a regular file on the way to a name leaves the name recorded absent", () => {
    const dir = harness();
    put(dir, "tools", "a file, not a directory\n");
    const files = collectBuildFiles(dir, { ...DIST, bootInputs: ["tools/server.ts"] });
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(files.find((f) => f.path === "tools/server.ts")).toEqual({
      path: "tools/server.ts",
      sha256: null,
    });
    expect(linkEntriesOf(files)).toEqual([]);
  });

  test("a linked directory inside the bundle is recorded as a link (regression check)", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "chsup-build-outside-"));
    roots.push(outside);
    put(outside, "inner.ts", "x\n");
    symlinkSync(outside, join(dir, "dist/lib"), "dir");
    const files = collectBuildFiles(dir, DIST);
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(linkEntriesOf(files)).toEqual(["dist/lib"]);
    expect(files.filter((f) => f.path.startsWith("dist/lib/"))).toEqual([]);
  });

  test("a build of regular files holds no link entry", () => {
    const dir = harness();
    put(dir, "tools/server.ts", "v1\n");
    const files = collectBuildFiles(dir, { ...DIST, bootInputs: ["tools/server.ts"] });
    if (!Array.isArray(files)) throw new Error(files.unreadable);
    expect(linkEntriesOf(files)).toEqual([]);
    expect(files.find((f) => f.path === "tools/server.ts")?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an edited stdio MCP script named as a boot input changes the digest", () => {
    const dir = harness();
    put(dir, "tools/server.ts", "v1\n");
    const artifact = { ...DIST, bootInputs: ["tools/server.ts"] };
    const before = digest(dir, artifact);
    put(dir, "tools/server.ts", "v2\n");
    expect(digest(dir, artifact)).not.toBe(before);
  });

  test("a root bundle counts only what compile wrote and the root package.json", () => {
    const dir = harness();
    put(dir, "agent.ts", "// root bundle\n");
    put(dir, "package.json", "{}\n");
    const root = { entry: "agent.ts", files: ["agent.ts", "README.md"] };
    const before = digest(dir, root);
    put(dir, "src/unrelated.ts", "x\n");
    expect(digest(dir, root)).toBe(before);
    put(dir, "agent.ts", "// edited after activation\n");
    expect(digest(dir, root)).not.toBe(before);
    put(dir, "agent.ts", "// root bundle\n");
    put(dir, "package.json", '{"scripts":{}}\n');
    expect(digest(dir, root)).not.toBe(before);
  });
});

describe("bootInputsOf", () => {
  test("names the local files a stdio server runs, inside the harness and outside node_modules", () => {
    const dir = harness();
    put(dir, "tools/server.ts", "x\n");
    put(dir, "node_modules/pkg/bin.js", "x\n");
    const ir = {
      target: "channel",
      mcp_servers: {
        local: { transport: "stdio", command: "bun", args: ["tools/server.ts", "--flag"] },
        dep: { transport: "stdio", command: "node", args: ["node_modules/pkg/bin.js"] },
        outside: { transport: "stdio", command: "bun", args: ["../escape.ts"] },
        remote: { transport: "sse", url: "https://example.invalid/sse" },
      },
    };
    expect(bootInputsOf(dir, ir)).toEqual(["tools/server.ts"]);
    expect(bootInputsOf(dir, { target: "graph" })).toEqual([]);
  });
});

describe("parseJsonc", () => {
  test("reads comments and trailing commas, and keeps // inside strings", () => {
    expect(parseJsonc('{"a": "http://x", /* c */ "b": [1, 2,],}')).toEqual({
      a: "http://x",
      b: [1, 2],
    });
    expect(parseJsonc("not json")).toBeUndefined();
  });
});
