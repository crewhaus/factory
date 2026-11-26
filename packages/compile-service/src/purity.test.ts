/**
 * `checkSpec` and `compileDraft` write nothing, start nothing and call
 * nothing: their source holds none of the calls that would, the package
 * imports no registry, and a run over every shape with an empty home and
 * working directory leaves both empty and every process and network spy
 * uncalled.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABSENT_CORPUS } from "../../compiler/src/absent-corpus";
import { checkSpec } from "./check-spec";
import { compileDraft } from "./compile-draft";

const SRC = import.meta.dir;

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

describe("the source holds no write, no process and no network call", () => {
  test("no non-test source file but check-build.ts names one", () => {
    const forbidden = [
      "Bun.spawn",
      "Bun.write",
      "writeFile",
      "appendFile",
      "mkdir",
      "fetch(",
      "node:child_process",
      "node:net",
      "node:http",
    ];
    const files = sourceFiles(SRC).filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith("/check-build.ts"),
    );
    // bundle-stamp, cf-worker-emit, check-spec, compile-draft, compile-warnings,
    // index, model-plan-lint and stages: a new file joins this count.
    expect(files.length).toBe(8);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const token of forbidden) expect(text.includes(token), `${file}: ${token}`).toBe(false);
    }
    // Not vacuous: the one file allowed to write and spawn does.
    const build = readFileSync(join(SRC, "check-build.ts"), "utf8");
    expect(build).toContain("Bun.spawn");
    expect(build).toContain("writeFileSync");
  });

  test("no file in the package imports a registry or the upgrade runner", () => {
    const refused = new Set(
      ["harness-registry", "spec-registry", "spec-changelog", "migration-runner"].map(
        (name) => `@crewhaus/${name}`,
      ),
    );
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const files = sourceFiles(SRC);
    let imports = 0;
    for (const file of files) {
      for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
        imports += 1;
        const pkg = path.split("/").slice(0, 2).join("/");
        expect(refused.has(pkg), `${file} imports ${path}`).toBe(false);
      }
    }
    expect(files.length).toBeGreaterThan(8);
    expect(imports).toBeGreaterThan(30);
    const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        expect(refused.has(dep), `${field}: ${dep}`).toBe(false);
      }
    }
  });
});

describe("a run over every shape touches nothing", () => {
  let home: string;
  let cwd: string;
  const saved: Record<string, string | undefined> = {};
  const spies: Array<{ mockRestore(): void; mock: { calls: unknown[] } }> = [];
  let named: Array<[string, { mock: { calls: unknown[] } }]> = [];

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-compile-service-purity-")));
    cwd = process.cwd();
    for (const key of ["HOME", "CREWHAUS_HANGAR_ROOT"]) saved[key] = process.env[key];
    process.env["HOME"] = home;
    process.env["CREWHAUS_HANGAR_ROOT"] = home;
    process.chdir(home);
    named = [
      ["fetch", spyOn(globalThis, "fetch")],
      ["Bun.spawn", spyOn(Bun, "spawn")],
      ["Bun.spawnSync", spyOn(Bun, "spawnSync")],
      ["execFileSync", spyOn(childProcess, "execFileSync")],
      ["execSync", spyOn(childProcess, "execSync")],
      ["spawn", spyOn(childProcess, "spawn")],
      ["spawnSync", spyOn(childProcess, "spawnSync")],
    ];
    for (const [, spy] of named) spies.push(spy as (typeof spies)[number]);
  });

  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("checkSpec and compileDraft over the corpus, a priced spec and a Worker build", async () => {
    const priced = [
      "name: priced",
      "target: cli",
      "models:",
      "  local:",
      "    model: local/qwen3@http://127.0.0.1:11434/v1",
      "    price: { input_per_1m: 1, output_per_1m: 2 }",
      "agent:",
      "  model: $local",
      "  instructions: hi",
      "",
    ].join("\n");
    let runs = 0;
    for (const text of [...Object.values(ABSENT_CORPUS), priced]) {
      expect(checkSpec(text, { today: "2026-11-25", env: { OPENAI_API_KEY: "x" } }).ok).toBe(true);
      await compileDraft(text, { compiledWith: "9.8.7", today: "2026-11-25" });
      runs += 1;
    }
    expect(checkSpec(ABSENT_CORPUS.cli, { emitAs: "cf-worker" }).ok).toBe(true);
    await compileDraft(ABSENT_CORPUS.cli, { compiledWith: "9.8.7", emitAs: "cf-worker" });
    expect(runs).toBe(15);
    for (const [name, spy] of named) expect(`${name}: ${spy.mock.calls.length}`).toBe(`${name}: 0`);
    expect(readdirSync(home, { recursive: true })).toEqual([]);
  }, 20_000); // compiles every shape
});
