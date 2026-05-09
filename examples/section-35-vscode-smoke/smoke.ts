#!/usr/bin/env bun
/**
 * Section 35 VS Code extension smoke.
 *
 * Probes:
 *   A) the extension's spec JSON Schema covers every TARGET_SHAPES entry
 *      (drift catch — if a new target shape lands the extension's
 *      autocomplete/lint won't go stale)
 *   B) on-disk schemas/spec.json is parseable JSON Schema Draft-07
 *   C) the package.json manifest declares the right contributes block
 *      (yamlValidation, languages, commands, configuration)
 *   D) buildRunSpecArgv emits the documented CLI argv shape
 *   E) sub-agent definition resolver round-trips a fixture file
 *   F) live VS Code: skipped — requires the VS Code Extension Test
 *      Runner (vscode-test) and a windowed display, never on CI
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRunSpecArgv,
  resolveSubAgentDefinition,
  studioWebviewUrl,
} from "@crewhaus/vscode-extension/run-spec";
import {
  TARGET_SHAPES,
  getSpecJsonSchema,
  schemaCoversAllTargetShapes,
} from "@crewhaus/vscode-extension/schema";

const log = (s: string) => process.stdout.write(`[section-35-vscode] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

// ── Probe A: schema covers every shape ──────────────────────────────────────
log("probe A: spec JSON Schema covers every target shape");
check("schemaCoversAllTargetShapes() === true", schemaCoversAllTargetShapes());
const schema = getSpecJsonSchema();
check("12 oneOf entries (one per shape)", schema.oneOf.length === TARGET_SHAPES.length);

// ── Probe B: on-disk schemas/spec.json ─────────────────────────────────────
log("probe B: on-disk schemas/spec.json");
const schemasPath = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "vscode-extension",
  "schemas",
  "spec.json",
);
const onDisk = JSON.parse(readFileSync(schemasPath, "utf8")) as {
  $schema?: string;
  oneOf?: ReadonlyArray<{ properties?: { target?: { const?: string } } }>;
};
check("declares draft-07", onDisk.$schema === "http://json-schema.org/draft-07/schema#");
check("on-disk has 12 shapes", (onDisk.oneOf?.length ?? 0) === 12);

// ── Probe C: package.json manifest ─────────────────────────────────────────
log("probe C: package.json manifest");
const manifestPath = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "vscode-extension",
  "package.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const contributes = manifest["contributes"] as Record<string, unknown>;
const cmds = (contributes?.["commands"] as ReadonlyArray<{ command?: string }>) ?? [];
check(
  "registers crewhaus.runSpec command",
  cmds.some((c) => c.command === "crewhaus.runSpec"),
);
check(
  "registers crewhaus.openTrace command",
  cmds.some((c) => c.command === "crewhaus.openTrace"),
);
const yv = contributes?.["yamlValidation"] as ReadonlyArray<{ url?: string }>;
check("yamlValidation points at schemas/spec.json", yv?.[0]?.url === "./schemas/spec.json");

// ── Probe D: buildRunSpecArgv ──────────────────────────────────────────────
log("probe D: buildRunSpecArgv argv shape");
{
  const argv = buildRunSpecArgv({
    cliPath: "crewhaus",
    specPath: "/path/to/crewhaus.yaml",
    modelOverride: "claude-opus-4-7",
  });
  check("argv head is crewhaus run <spec>", argv[0] === "crewhaus" && argv[1] === "run");
  check("argv carries --model override", argv.includes("--model"));
}
const url = studioWebviewUrl({
  studioUrl: "http://localhost:4242/",
  specPath: "/repo/examples/hello-cli/crewhaus.yaml",
  workspaceRoot: "/repo",
});
check(
  "studio webview URL contains spec path",
  url.includes("examples%2Fhello-cli%2Fcrewhaus.yaml"),
);

// ── Probe E: sub-agent resolution ──────────────────────────────────────────
log("probe E: sub-agent definition resolver");
{
  const dir = mkdtempSync(join(tmpdir(), "section-35-vscode-"));
  try {
    mkdirSync(join(dir, ".crewhaus", "sub-agents"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "sub-agents", "code-reviewer.md"),
      `---
name: code-reviewer
description: Reviews diffs
---
You review code.
`,
    );
    const r = resolveSubAgentDefinition({ workspaceRoot: dir, subAgentName: "code-reviewer" });
    check("resolver finds the file", r !== null);
    check("frontmatter.name parsed", r?.frontmatter["name"] === "code-reviewer");
    check("body parsed", (r?.body ?? "").includes("review code"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Probe F: live VS Code (gated, never on CI) ─────────────────────────────
log("probe F: skipped (live VS Code requires vscode-test + windowed display)");

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");

// Avoid lint warning about unused import.
void existsSync;
