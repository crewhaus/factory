/**
 * 0.7.1 — `model-plan-tool-config-widens` prints, and never fails
 * `compile --strict`: a pool candidate's tool_config REPLACES the
 * agent-level block by design, a wider list there may be intended, and the
 * same spec compiled under --strict on 0.7.0.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `tsc -b` also compiles this file into `dist/`; spawn the source entrypoint.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-widens-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("compile --strict prints the widening notice and still writes the bundle", async () => {
  const specPath = join(tmp, "crewhaus.yaml");
  writeFileSync(
    specPath,
    [
      "name: pooled",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: read the docs",
      "  model_pool:",
      "    candidates:",
      "      - model: claude-haiku-4-5",
      "        tool_config: { webFetch: { allowed_domains: [] } }",
      "      - model: claude-opus-4-8",
      "tools: [webFetch]",
      "tool_config:",
      "  webFetch: { allowed_domains: [docs.example.com] }",
      "",
    ].join("\n"),
  );
  const outDir = join(tmp, "out");
  const proc = Bun.spawn(
    [process.execPath, CLI_PATH, "compile", specPath, "--strict", "--no-register", "-o", outDir],
    {
      cwd: tmp,
      env: {
        PATH: process.env["PATH"] ?? "",
        CREWHAUS_REGISTRY_ROOT: join(tmp, "registry"),
        CREWHAUS_WATCHME_ROOT: join(tmp, "watchme"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toContain(
    "crewhaus: warning[model-plan-tool-config-widens] agent.model_pool.candidates[0].tool_config.webFetch.allowed_domains:",
  );
  expect(stderr).not.toContain("escalated to errors");
  expect(exitCode).toBe(0);
  expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
}, 30_000);
