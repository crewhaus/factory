/**
 * `checkBuild` runs `compile --check`'s three steps over a bundle held in
 * memory: written into a fresh directory under `tmpRoot`, every subprocess
 * through the injected runner, and a credential-free child environment.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { compile } from "@crewhaus/compiler";
import { CompilerError } from "@crewhaus/errors";
import { ABSENT_CORPUS } from "../../compiler/src/absent-corpus";
import { collectCrewhausDeps } from "./bundle-stamp";
import { type CheckStepRunner, bootArgvFor, checkBuild, scrubbedEnv } from "./check-build";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-check-build-test-")));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const FILES = [
  { path: "agent.ts", content: 'import "@crewhaus/runtime-core";\nconsole.log("hi");\n' },
  { path: "lib/util.ts", content: "export const x = 1;\n" },
];

describe("checkBuild", () => {
  test("installs then boots through the runner, inside a fresh directory, with a scrubbed env", async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string; env?: Record<string, string> }> = [];
    const runner: CheckStepRunner = async ({ argv, cwd, env }) => {
      calls.push({ argv, cwd, ...(env !== undefined ? { env: { ...env } } : {}) });
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    };
    const planted = ["sk", "ant", "api03", "checkbuildfixture"].join("-");
    const before = { ...process.env };
    const files = compile(ABSENT_CORPUS.cli).files;
    const result = await checkBuild(files, {
      target: "cli",
      runner,
      tmpRoot,
      compiledWith: "9.8.7",
      env: { PATH: "/usr/bin", HOME: "/nowhere", ANTHROPIC_API_KEY: planted },
    });
    expect(result.steps.map((s) => [s.step, s.status])).toEqual([
      ["assertion", "ok"],
      ["install", "ok"],
      ["boot", "ok"],
    ]);
    expect(calls.map((c) => c.argv)).toEqual([["bun", "install"], bootArgvFor("agent.ts")]);
    expect(calls[1]?.argv.some((a) => a.startsWith("--env-file="))).toBe(true);
    const dirs = readdirSync(tmpRoot);
    expect(dirs.length).toBe(1);
    const outDir = join(tmpRoot, dirs[0] as string);
    for (const call of calls) {
      expect(call.cwd).toBe(outDir);
      expect(inside(tmpRoot, call.cwd)).toBe(true);
      expect(call.env).toEqual(scrubbedEnv({ PATH: "/usr/bin", HOME: "/nowhere" }));
      expect(JSON.stringify(call.env)).not.toContain(planted);
    }
    expect(process.env).toEqual(before);
    // The bundle was written, with the pinned manifest beside it.
    for (const f of files) expect(readFileSync(join(outDir, f.path), "utf8")).toBe(f.content);
    const manifest = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const deps = collectCrewhausDeps(files);
    expect(deps.length).toBeGreaterThan(0);
    expect(manifest.dependencies).toEqual(Object.fromEntries(deps.map((d) => [d, "9.8.7"])));
    // The nested write lands inside too.
    await checkBuild(FILES, { target: "none", runner, tmpRoot });
    const nested = readdirSync(tmpRoot).find((d) => join(tmpRoot, d) !== outDir) as string;
    expect(readFileSync(join(tmpRoot, nested, "lib", "util.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
  });

  test("a path that leaves the build directory, or an absolute one, is refused before any write", async () => {
    let runs = 0;
    const runner: CheckStepRunner = async () => {
      runs += 1;
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    };
    for (const [path, reason] of [
      ["../x", 'bundle file "../x" resolves outside the build directory'],
      ["lib/../../x", 'bundle file "lib/../../x" resolves outside the build directory'],
      [join(tmpRoot, "abs.ts"), "is not a relative path"],
    ] as const) {
      let refusal: unknown;
      try {
        await checkBuild([...FILES, { path, content: "x" }], { target: "cli", runner, tmpRoot });
      } catch (err) {
        refusal = err;
      }
      expect(refusal, path).toBeInstanceOf(CompilerError);
      expect((refusal as Error).message, path).toContain(reason);
    }
    expect(runs).toBe(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  test("a bundle that ships its own package.json keeps it", async () => {
    const own = '{"name":"edge"}\n';
    const runner: CheckStepRunner = async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    });
    await checkBuild([...FILES, { path: "package.json", content: own }], {
      target: "cli",
      runner,
      tmpRoot,
    });
    const [dir] = readdirSync(tmpRoot);
    expect(readFileSync(join(tmpRoot, dir as string, "package.json"), "utf8")).toBe(own);
  });
});
