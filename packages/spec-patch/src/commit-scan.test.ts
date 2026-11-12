/**
 * Every spec write goes through the commit helper. This guard reads the
 * sources of every package that writes a harness's spec and finds each raw
 * file write whose target names a spec; the only ones allowed are files that
 * are not a harness's spec, each with its reason. A new raw spec write fails
 * here, and so does a scan that stops finding the allowed ones.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const REPO = resolve(import.meta.dir, "../../..");

const SCANNED = [
  "apps/cli/src",
  "packages/hangar-server/src",
  "packages/eval-optimizer-orchestrator/src",
  "packages/tool-specops/src",
  "packages/service-setup/src",
  "packages/harness-advice/src",
];

/** The writes the scan finds that are not a harness's spec, keyed by file and first argument. */
const ALLOWED: ReadonlyArray<{ file: string; target: string; reason: string }> = [
  {
    file: "apps/cli/src/index.ts",
    target: "optimizeSpecPath",
    reason: "the few-shot run's scratch copy under the optimize output directory",
  },
  {
    file: "packages/hangar-server/src/fixture.ts",
    target: 'join(dir, "crewhaus.yaml")',
    reason: "the test-fixture synthesizer creates a fixture harness",
  },
  {
    file: "packages/hangar-server/src/fixture.ts",
    target: 'join(specDir, "state.json")',
    reason: "the test-fixture synthesizer's continuity state",
  },
  {
    file: "packages/hangar-server/src/fixture.ts",
    target: 'join(specDir, "manifest.json")',
    reason: "the test-fixture synthesizer's version registry",
  },
  {
    file: "packages/hangar-server/src/fixture.ts",
    target: "join(specDir, `${version}.yaml`)",
    reason: "the test-fixture synthesizer's archived versions",
  },
  {
    file: "packages/hangar-server/src/fixture.ts",
    target: 'join(ch, "specs", name, "CHANGELOG.md")',
    reason: "the test-fixture synthesizer's version changelog",
  },
];

const WRITE_CALL = /\b(writeFileSync|renameSync|writeFileSafe|Bun\.write)\s*\(/g;
const SPEC_TARGET = /spec|crewhaus\.yaml|targetFile/i;

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const dir of SCANNED) {
    for (const file of new Glob(`${dir}/**/*.ts`).scanSync(REPO)) {
      if (file.endsWith(".test.ts") || file.includes("/__")) continue;
      out.push({ file, text: readFileSync(join(REPO, file), "utf8") });
    }
  }
  return out;
}

/** The whole first argument of the call opening at `start`, across lines. */
function firstArgument(text: string, start: number): string {
  let depth = 0;
  let arg = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (depth === 0 && (ch === "," || ch === ")")) break;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    arg += ch;
  }
  return arg.replace(/\s+/g, " ").trim();
}

describe("every spec write goes through the commit helper", () => {
  const files = sources();

  test("the scan reads every writer package", () => {
    for (const dir of SCANNED) {
      expect(`${dir}:${files.some((f) => f.file.startsWith(dir))}`).toBe(`${dir}:true`);
    }
  });

  test("the only raw writes to a spec-named target are the allowed ones", () => {
    const found: Array<{ file: string; target: string }> = [];
    for (const { file, text } of files) {
      for (const m of text.matchAll(WRITE_CALL)) {
        const target = firstArgument(text, (m.index ?? 0) + m[0].length);
        if (SPEC_TARGET.test(target)) found.push({ file, target });
      }
    }
    expect(found).toHaveLength(ALLOWED.length);
    expect(found.map((f) => `${f.file} ${f.target}`).sort()).toEqual(
      ALLOWED.map((a) => `${a.file} ${a.target}`).sort(),
    );
  });

  test("no module keeps a spec writer of its own", () => {
    for (const { file, text } of files) {
      expect(`${file}:${/\bfunction writeSpecFile\b/.test(text)}`).toBe(`${file}:false`);
    }
    const watchme = files.find((f) => f.file === "packages/hangar-server/src/watchme-ops.ts");
    expect(watchme).toBeDefined();
    expect(/\bfunction writeSpec\b/.test(watchme?.text ?? "")).toBe(false);
  });

  test("each writer module writes through the helper", () => {
    const writers: Record<string, RegExp> = {
      "apps/cli/src/index.ts": /\b(commitCliSpec|createSpecFile)\b/,
      "apps/cli/src/optimize-stages.ts": /\bcommitCliSpec\b/,
      "apps/cli/src/spec-commit.ts": /\bcommitSpec\b/,
      "packages/hangar-server/src/spec-edit.ts": /\bcommitSpec\b/,
      "packages/hangar-server/src/builders.ts": /\b(createSpecFile|commitSpecEdits)\b/,
      "packages/hangar-server/src/feedback-ops.ts": /\bcommitHomeEdits\b/,
      "packages/hangar-server/src/watchme-ops.ts": /\bcommitHomeEdits\b/,
      "packages/eval-optimizer-orchestrator/src/index.ts": /\bcommitSpec\b/,
      "packages/tool-specops/src/index.ts": /\bcommitSpec\b/,
      // DoctorFix's overlay writes through a bare `abs`, which a name scan cannot see.
      "packages/tool-specops/src/lib/overlay-fs.ts": /\bcommitSpec\b/,
      "packages/service-setup/src/spec-edit.ts": /\bcommitSpec\b/,
    };
    const byFile = new Map(files.map((f) => [f.file, f.text]));
    for (const [file, pattern] of Object.entries(writers)) {
      const text = byFile.get(file);
      expect(`${file}:${text !== undefined}`).toBe(`${file}:true`);
      expect(`${file}:${pattern.test(text ?? "")}`).toBe(`${file}:true`);
    }
  });
});
