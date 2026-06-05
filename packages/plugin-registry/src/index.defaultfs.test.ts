/**
 * Isolated coverage for the private default `node:fs` seams in
 * `plugin-registry` — `defaultReadFile`, `defaultWriteFile`, and
 * `defaultExists`. The main suite always injects in-memory `readFileImpl` /
 * `writeFileImpl` / `existsImpl`, so the real `node:fs` paths never run there.
 *
 * Here we replace `node:fs` with an in-memory fake via `mock.module` and build
 * a registry WITHOUT any seam overrides, so `register` / `list` / `get` route
 * through the genuine default implementations — exercised against the fake, so
 * no disk, network, timers, or real clock are touched, and no handle leaks.
 *
 * `mock.module` mutates the shared module registry, so this lives in its own
 * file: Bun gives each test file a fresh module graph, keeping the fs stub from
 * leaking into `index.test.ts`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

type FsCall = { fn: string; args: unknown[] };
const fsCalls: FsCall[] = [];
const dirs = new Set<string>();
const files = new Map<string, { contents: string; opts: unknown }>();

mock.module("node:fs", () => ({
  existsSync: (p: string) => {
    fsCalls.push({ fn: "existsSync", args: [p] });
    return dirs.has(p) || files.has(p);
  },
  mkdirSync: (p: string, opts: unknown) => {
    fsCalls.push({ fn: "mkdirSync", args: [p, opts] });
    dirs.add(p);
    return undefined;
  },
  writeFileSync: (p: string, contents: string, opts: unknown) => {
    fsCalls.push({ fn: "writeFileSync", args: [p, contents, opts] });
    files.set(p, { contents, opts });
  },
  readFileSync: (p: string, _enc: string) => {
    fsCalls.push({ fn: "readFileSync", args: [p, _enc] });
    const f = files.get(p);
    if (f === undefined) throw new Error(`ENOENT: ${p}`);
    return f.contents;
  },
}));

// Import the unit under test AFTER the fs stub is registered.
const { createPluginRegistry } = await import("./index");

const REG_PATH = "/etc/crewhaus/plugin-registry.json";

afterEach(() => {
  fsCalls.length = 0;
  dirs.clear();
  files.clear();
});

describe("plugin-registry default node:fs seams", () => {
  test("register creates the dir (default writeFile) then list reads it back (default readFile)", async () => {
    const reg = createPluginRegistry({ registryPath: REG_PATH });

    // First write: registry file does not exist -> defaultExists(false) on load,
    // then defaultWriteFile -> existsSync(dir)=false -> mkdirSync -> writeFileSync.
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });

    const mkdir = fsCalls.find((c) => c.fn === "mkdirSync");
    expect(mkdir?.args[0]).toBe("/etc/crewhaus"); // dirname(REG_PATH)
    expect(mkdir?.args[1]).toEqual({ recursive: true });
    const write = files.get(REG_PATH);
    expect(write?.opts).toEqual({ encoding: "utf8", mode: 0o600 });
    expect(write?.contents).toContain('"alpha"');

    // Now the file exists: list() -> defaultExists(true) -> defaultReadFile.
    const list = await reg.list();
    expect(list.length).toBe(1);
    expect(list[0]?.manifest.name).toBe("alpha");
    expect(fsCalls.some((c) => c.fn === "readFileSync")).toBe(true);
  });

  test("get routes through the default read seam", async () => {
    const reg = createPluginRegistry({ registryPath: REG_PATH });
    await reg.register({
      manifest: { name: "beta", version: "2.0.0" },
      sourcePath: "/p/beta/manifest.json",
    });
    fsCalls.length = 0;
    const got = await reg.get("beta");
    expect(got?.manifest.version).toBe("2.0.0");
    expect(fsCalls.some((c) => c.fn === "readFileSync")).toBe(true);
    expect(fsCalls.some((c) => c.fn === "existsSync")).toBe(true);
  });

  test("a subsequent write skips mkdir when the directory already exists", async () => {
    const reg = createPluginRegistry({ registryPath: REG_PATH });
    // First register creates the directory.
    await reg.register({
      manifest: { name: "alpha", version: "1.0.0" },
      sourcePath: "/p/alpha/manifest.json",
    });
    fsCalls.length = 0;
    // Second register: dir now exists -> existsSync(dir)=true -> NO mkdirSync.
    await reg.register({
      manifest: { name: "gamma", version: "1.0.0" },
      sourcePath: "/p/gamma/manifest.json",
    });
    expect(fsCalls.some((c) => c.fn === "mkdirSync")).toBe(false);
    expect(fsCalls.some((c) => c.fn === "writeFileSync")).toBe(true);
  });

  test("load returns an empty registry when the file does not exist (default exists=false)", async () => {
    const reg = createPluginRegistry({ registryPath: REG_PATH });
    // Nothing registered, file absent -> defaultExists(false) short-circuits load.
    const list = await reg.list();
    expect(list).toEqual([]);
    expect(fsCalls.some((c) => c.fn === "existsSync")).toBe(true);
    expect(fsCalls.some((c) => c.fn === "readFileSync")).toBe(false);
  });
});
