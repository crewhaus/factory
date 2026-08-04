/**
 * Hangar F-1 — integration proof that the CLI self-registers the harness it
 * touches. `compile --emit-loop` is the cheapest of the four hooked command
 * paths (parse → lower → print, no emission, no model), so it drives the
 * real entry file end-to-end: a run must create a registry entry under the
 * injected CREWHAUS_REGISTRY_ROOT, and CREWHAUS_NO_REGISTRY=1 must prevent
 * it. Follows datasets-cli.test.ts's posture: assert exit codes + on-disk
 * artifacts, not stdout.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-registry-hook-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

type RegistryDoc = {
  harnesses: Array<{
    dir: string;
    specName: string;
    target: string;
    origin: string;
    originDetail: string;
  }>;
};

async function runCompile(
  cwd: string,
  extraEnv: Record<string, string>,
  specArg = "crewhaus.yaml",
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, "compile", specArg, "--emit-loop"], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

function seedHarness(root: string): string {
  writeFileSync(
    join(root, "crewhaus.yaml"),
    "name: hook-probe\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: help\n",
  );
  return root;
}

describe("Hangar F-1 — command-path self-registration", () => {
  test("compile creates a run-hook registry entry for the cwd", async () => {
    const harnessDir = seedHarness(newTempRoot());
    const regRoot = newTempRoot();
    const watchmeRoot = newTempRoot();
    const result = await runCompile(harnessDir, {
      CREWHAUS_REGISTRY_ROOT: regRoot,
      CREWHAUS_WATCHME_ROOT: watchmeRoot,
    });
    expect(result.exitCode).toBe(0);

    const registryPath = join(regRoot, "harnesses.json");
    expect(existsSync(registryPath)).toBe(true);
    const doc = JSON.parse(readFileSync(registryPath, "utf-8")) as RegistryDoc;
    expect(doc.harnesses).toHaveLength(1);
    const entry = doc.harnesses[0];
    // The child's process.cwd() is the physical path (macOS tmpdir is a
    // /var → /private/var symlink), so compare realpaths.
    expect(entry?.dir).toBe(realpathSync(harnessDir));
    expect(entry?.specName).toBe("hook-probe");
    expect(entry?.target).toBe("cli");
    expect(entry?.origin).toBe("run-hook");
    expect(entry?.originDetail).toBe("compile");
  }, 60000);

  test("compile from OUTSIDE the harness dir registers the spec's dir, not the cwd", async () => {
    // `crewhaus compile starters/x/crewhaus.yaml -o …` from a workspace root
    // is a routine invocation (the demos verify scripts do exactly this).
    // The registered row must be the harness (dirname of the resolved spec),
    // never the invoker's cwd — a workspace root is not a harness, and one
    // row there would churn its specName to whatever compiled last.
    const harnessDir = seedHarness(newTempRoot());
    const invokerCwd = newTempRoot(); // deliberately NOT the harness
    const regRoot = newTempRoot();
    const watchmeRoot = newTempRoot();
    const result = await runCompile(
      invokerCwd,
      { CREWHAUS_REGISTRY_ROOT: regRoot, CREWHAUS_WATCHME_ROOT: watchmeRoot },
      join(harnessDir, "crewhaus.yaml"),
    );
    expect(result.exitCode).toBe(0);

    const doc = JSON.parse(readFileSync(join(regRoot, "harnesses.json"), "utf-8")) as RegistryDoc;
    expect(doc.harnesses).toHaveLength(1);
    const entry = doc.harnesses[0];
    expect(entry?.dir).toBe(realpathSync(harnessDir));
    expect(entry?.dir).not.toBe(realpathSync(invokerCwd));
    expect(entry?.specName).toBe("hook-probe");
    expect(entry?.originDetail).toBe("compile");
  }, 60000);

  test("a temp-dir cwd under the DEFAULT registry root is skipped", async () => {
    // The ephemeral-cwd guard: without an explicit CREWHAUS_REGISTRY_ROOT,
    // a harness rooted inside the OS temp dir (exactly what every fixture-
    // spawning test does) must NOT be recorded — otherwise each `bun test`
    // run would fill the real ~/.crewhaus with guaranteed-dead rows. HOME is
    // pointed at a throwaway dir so even a guard regression could never
    // touch the real registry.
    const harnessDir = seedHarness(newTempRoot());
    const fakeHome = newTempRoot();
    const result = await runCompile(harnessDir, { HOME: fakeHome });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fakeHome, ".crewhaus", "harnesses.json"))).toBe(false);
  }, 60000);

  test("CREWHAUS_NO_REGISTRY=1 prevents the registration", async () => {
    const harnessDir = seedHarness(newTempRoot());
    const regRoot = newTempRoot();
    const watchmeRoot = newTempRoot();
    const result = await runCompile(harnessDir, {
      CREWHAUS_REGISTRY_ROOT: regRoot,
      CREWHAUS_WATCHME_ROOT: watchmeRoot,
      CREWHAUS_NO_REGISTRY: "1",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(regRoot, "harnesses.json"))).toBe(false);
  }, 60000);
});

// ---------------------------------------------------------------------------
// The sibling-suite guard (F-11)
// ---------------------------------------------------------------------------

/**
 * The ephemeral-cwd guard above protects the COMMON case: a fixture harness
 * synthesized into the OS temp dir. It cannot protect the other one — a spec
 * that lives IN THE REPO, passed by path. The hook records the SPEC's
 * directory for those, so `apps/cli/test-fixtures/minimal-*` is what lands in
 * the registry, and `.../.worktrees/<branch>/apps/cli/test-fixtures/minimal-*`
 * rows really did accumulate in developers' real `~/.crewhaus/harnesses.json`.
 *
 * The fix is one line per suite (`CREWHAUS_REGISTRY_ROOT` in the spawn env);
 * this test is what stops the next suite from forgetting it.
 */
describe("F-11 — no suite registers an in-repo fixture into the real machine registry", () => {
  test("every CLI test that spawns the entry file against an in-repo fixture pins a registry root", () => {
    const spawnsCli = /Bun\.spawn\(\s*\[\s*process\.execPath/;
    const unguarded: string[] = [];
    for (const name of readdirSync(SRC_DIR).sort()) {
      if (!name.endsWith(".test.ts")) continue;
      const body = readFileSync(join(SRC_DIR, name), "utf8");
      if (!body.includes("test-fixtures") || !spawnsCli.test(body)) continue;
      if (body.includes("CREWHAUS_REGISTRY_ROOT") || body.includes("CREWHAUS_NO_REGISTRY")) {
        continue;
      }
      unguarded.push(name);
    }
    expect(unguarded).toEqual([]);
  });
});
