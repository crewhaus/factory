#!/usr/bin/env bun
/**
 * Section 40 example-corpus smoke — local mirror of the CI matrix gate.
 *
 * Walks every examples/<name>/crewhaus.yaml, compiles via the CLI, and
 * asserts:
 *   - exit code 0 within 60s
 *   - at least one .ts file in the output directory
 *
 * The .github/workflows/example-corpus.yml job runs the same loop in CI;
 * this smoke gives contributors a local pre-push gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const log = (s: string) => process.stdout.write(`[section-40-corpus] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const repoRoot = resolve(import.meta.dir, "..", "..");
const examplesDir = join(repoRoot, "examples");
const cliEntry = join(repoRoot, "apps", "cli", "src", "index.ts");

const tmp = mkdtempSync(join(tmpdir(), "section-40-corpus-smoke-"));

const exampleNames = readdirSync(examplesDir)
  .filter((name) => existsSync(join(examplesDir, name, "crewhaus.yaml")))
  .sort();

log(`enumerated ${exampleNames.length} examples/*/crewhaus.yaml`);
check(`found ≥10 examples (got ${exampleNames.length})`, exampleNames.length >= 10);

let succeeded = 0;
for (const name of exampleNames) {
  const spec = join(examplesDir, name, "crewhaus.yaml");
  const out = join(tmp, name);
  mkdirSync(out, { recursive: true });
  const result = spawnSync("bun", [cliEntry, "compile", spec, "-o", out], {
    cwd: repoRoot,
    timeout: 60_000,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    check(
      `${name} compiled`,
      false,
      `exit=${result.status} stderr=${(result.stderr ?? "").slice(0, 256)}`,
    );
    continue;
  }
  const tsFiles = readdirSync(out).filter((f) => f.endsWith(".ts"));
  if (tsFiles.length === 0) {
    check(`${name} emitted ≥1 .ts`, false, `outDir=${out}`);
    continue;
  }
  succeeded += 1;
}

check(
  `compile-matrix: ${succeeded}/${exampleNames.length} examples compiled`,
  succeeded === exampleNames.length,
);

rmSync(tmp, { recursive: true, force: true });

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
