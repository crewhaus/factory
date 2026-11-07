import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectionCheckStatus } from "./doctor-screening";

describe("doctor's prompt-injection check line", () => {
  test("variable unset: the built-in check runs, the model-backed one is not available", () => {
    expect(injectionCheckStatus({})).toEqual({
      label: "Prompt-injection check",
      pass: true,
      warn: true,
      reason: "built-in check on; the model-backed check is not available in this version",
    });
  });

  test("variable set: the line says it has no effect", () => {
    const status = injectionCheckStatus({ CREWHAUS_PI_CLASSIFIER_MODEL: "claude-haiku-4-5" });
    expect(status.pass).toBe(true);
    expect(status.warn).toBe(true);
    expect(status.reason).toBe(
      "built-in check on; CREWHAUS_PI_CLASSIFIER_MODEL is set but has no effect in this version",
    );
  });

  test("a whitespace-only value counts as unset", () => {
    expect(injectionCheckStatus({ CREWHAUS_PI_CLASSIFIER_MODEL: "   " }).reason).toBe(
      "built-in check on; the model-backed check is not available in this version",
    );
  });
});

describe("crewhaus doctor prints it", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crewhaus-doctor-screening-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function doctor(env: Record<string, string>): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), "doctor"], {
      cwd: dir,
      env: {
        PATH: process.env["PATH"] ?? "",
        CREWHAUS_REGISTRY_ROOT: join(dir, ".registry"),
        CREWHAUS_WATCHME_ROOT: join(dir, ".watchme"),
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out };
  }

  // Each case spawns the CLI: slow by construction on a loaded runner.
  test("as an informational line that never fails doctor", async () => {
    writeFileSync(join(dir, "crewhaus.yaml"), "name: t\ntarget: cli\n");
    const plain = await doctor({ ANTHROPIC_API_KEY: "test" });
    expect(plain.out).toContain(
      "~ Prompt-injection check: built-in check on; the model-backed check is not available in this version\n",
    );
    expect(plain.out).toContain("all checks passed");
    expect(plain.code).toBe(0);
    const set = await doctor({ ANTHROPIC_API_KEY: "test", CREWHAUS_PI_CLASSIFIER_MODEL: "m" });
    expect(set.out).toContain(
      "~ Prompt-injection check: built-in check on; CREWHAUS_PI_CLASSIFIER_MODEL is set but has no effect in this version\n",
    );
    expect(set.code).toBe(0);
  }, 20_000);
});
