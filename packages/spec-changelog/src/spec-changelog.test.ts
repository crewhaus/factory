import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWriteBackHeader } from "@crewhaus/spec-patch";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import {
  appendChangelogEntry,
  autoRegisterSpecVersion,
  extractOptimizeMetadata,
  insertNewestFirst,
  nextVersion,
  registrySpecName,
  renderChangelogEntry,
} from "./spec-changelog";

const NOW = new Date("2026-07-01T12:00:00.000Z");

const YAML_V1 = [
  "target: cli",
  "name: hello",
  "agent:",
  "  model: claude-sonnet-4-5",
  "  instructions: Be helpful.",
  "",
].join("\n");

const YAML_V2 = YAML_V1.replace("Be helpful.", "Be concise and helpful.");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-spec-changelog-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRegistry() {
  const rootDir = join(tmp, "specs");
  return { registry: createFileBackedRegistry({ rootDir }), rootDir };
}

describe("nextVersion", () => {
  test("starts at v1 on an empty registry", () => {
    expect(nextVersion([])).toBe("v1");
  });
  test("increments the max vN numerically (v10 beats v2)", () => {
    expect(nextVersion(["v1", "v2"])).toBe("v3");
    expect(nextVersion(["v9", "v10"])).toBe("v11");
  });
  test("ignores manually-put versions outside the vN grammar", () => {
    expect(nextVersion(["2.0", "release-1"])).toBe("v1");
    expect(nextVersion(["2.0", "v2"])).toBe("v3");
  });
});

describe("registrySpecName", () => {
  test("keeps registry-safe names as-is", () => {
    expect(registrySpecName("hello")).toBe("hello");
    expect(registrySpecName("hello-cli_2.0")).toBe("hello-cli_2.0");
  });
  test("collapses spec-legal but registry-illegal characters to '-'", () => {
    // Spec `safeName` allows spaces and ':'; the registry does not.
    expect(registrySpecName("My Agent")).toBe("My-Agent");
    expect(registrySpecName("ns: prod agent")).toBe("ns-prod-agent");
  });
  test("strips leading dots and never returns an empty name", () => {
    expect(registrySpecName("..hidden")).toBe("hidden");
    expect(registrySpecName("")).toBe("spec");
  });
});

describe("autoRegisterSpecVersion", () => {
  test("registers v1 with an 'initial version' changelog entry", async () => {
    const { registry, rootDir } = makeRegistry();
    const result = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: YAML_V1,
      now: NOW,
    });
    expect(result).toEqual({ status: "registered", name: "hello", version: "v1" });
    expect(await registry.get("hello", "v1")).toBe(YAML_V1);
    const changelog = readFileSync(join(rootDir, "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("# Changelog — hello");
    expect(changelog).toContain("## v1 — 2026-07-01");
    expect(changelog).toContain("- initial version");
  });

  test("hash-unchanged re-register is a no-op (no new version, no new entry)", async () => {
    const { registry, rootDir } = makeRegistry();
    await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: YAML_V1,
      now: NOW,
    });
    const again = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: YAML_V1,
      now: NOW,
    });
    expect(again).toEqual({ status: "unchanged", name: "hello", version: "v1" });
    expect(await registry.list("hello")).toEqual(["v1"]);
    const changelog = readFileSync(join(rootDir, "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog.match(/^## /gm)).toHaveLength(1);
  });

  test("changed content registers the next vN with a field-level diff, newest first", async () => {
    const { registry, rootDir } = makeRegistry();
    await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: YAML_V1,
      now: NOW,
    });
    const result = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: YAML_V2,
      now: NOW,
    });
    expect(result).toEqual({ status: "registered", name: "hello", version: "v2" });
    const changelog = readFileSync(join(rootDir, "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain(
      '- changed `agent.instructions`: "Be helpful." → "Be concise and helpful."',
    );
    // Newest first: v2's heading appears above v1's.
    expect(changelog.indexOf("## v2")).toBeLessThan(changelog.indexOf("## v1"));
  });

  test("content matching ANY stored version (not just latest) reports unchanged", async () => {
    const { registry, rootDir } = makeRegistry();
    const opts = { registry, registryRootDir: rootDir, specName: "hello", now: NOW };
    await autoRegisterSpecVersion({ ...opts, yaml: YAML_V1 });
    await autoRegisterSpecVersion({ ...opts, yaml: YAML_V2 });
    const rollback = await autoRegisterSpecVersion({ ...opts, yaml: YAML_V1 });
    expect(rollback).toEqual({ status: "unchanged", name: "hello", version: "v1" });
    expect(await registry.list("hello")).toEqual(["v1", "v2"]);
  });

  test("write-back stamped content lands optimizer metadata + patch.json rationale in the changelog", async () => {
    const { registry, rootDir } = makeRegistry();
    await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: YAML_V1,
      now: NOW,
    });
    // A REAL header from spec-patch's own API — not a hand-typed imitation.
    const header = formatWriteBackHeader({
      runId: "opt_cafe01",
      mutator: "claude",
      scoreBefore: 0.3,
      scoreAfter: 1,
      iterations: 10,
      timestamp: "2026-07-01T00:00:00.000Z",
    });
    const stamped = `${header}${YAML_V2}`;
    const optimizeRootDir = join(tmp, "optimize");
    mkdirSync(join(optimizeRootDir, "opt_cafe01"), { recursive: true });
    writeFileSync(
      join(optimizeRootDir, "opt_cafe01", "patch.json"),
      JSON.stringify({
        target: "cli",
        path: ["agent", "instructions"],
        op: "replace",
        value: "Be concise and helpful.",
        rationale: "claude mutator improved fitness by 0.700 over 10 iterations",
      }),
    );
    const result = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "hello",
      yaml: stamped,
      optimizeRootDir,
      now: NOW,
    });
    expect(result.status).toBe("registered");
    expect(result.version).toBe("v2");
    const changelog = readFileSync(join(rootDir, "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain(
      "- optimizer: runId opt_cafe01 (mutator claude, 10 iteration(s), score 0.300 → 1.000)",
    );
    expect(changelog).toContain(
      "- rationale: claude mutator improved fitness by 0.700 over 10 iterations",
    );
    // The header is a comment — invisible to the structural differ, so the
    // instructions change is still the only field-level diff line.
    expect(changelog).toContain("- changed `agent.instructions`");
  });

  test("a spec name with spaces registers under its sanitized registry name", async () => {
    const { registry, rootDir } = makeRegistry();
    const yaml = YAML_V1.replace("name: hello", "name: My Agent");
    const result = await autoRegisterSpecVersion({
      registry,
      registryRootDir: rootDir,
      specName: "My Agent",
      yaml,
      now: NOW,
    });
    expect(result.name).toBe("My-Agent");
    expect(existsSync(join(rootDir, "My-Agent", "CHANGELOG.md"))).toBe(true);
  });
});

describe("extractOptimizeMetadata", () => {
  test("returns undefined for un-stamped YAML", () => {
    expect(extractOptimizeMetadata({ yaml: YAML_V1 })).toBeUndefined();
  });

  test("explicit patchJsonPath wins over optimizeRootDir resolution", () => {
    const header = formatWriteBackHeader({
      runId: "opt_beef02",
      mutator: "rule-based",
      scoreBefore: 0.5,
      scoreAfter: 0.9,
      iterations: 3,
    });
    const patchJsonPath = join(tmp, "custom-out", "patch.json");
    mkdirSync(join(tmp, "custom-out"), { recursive: true });
    writeFileSync(patchJsonPath, JSON.stringify({ rationale: "custom-out rationale" }));
    const meta = extractOptimizeMetadata({ yaml: `${header}${YAML_V1}`, patchJsonPath });
    expect(meta?.runId).toBe("opt_beef02");
    expect(meta?.rationale).toBe("custom-out rationale");
  });

  test("a path-hostile runId never resolves a patch.json (and does not throw)", () => {
    const header = formatWriteBackHeader({
      runId: "../escape",
      mutator: "claude",
      scoreBefore: 0,
      scoreAfter: 1,
      iterations: 1,
    });
    const meta = extractOptimizeMetadata({
      yaml: `${header}${YAML_V1}`,
      optimizeRootDir: join(tmp, "optimize"),
    });
    expect(meta?.runId).toBe("../escape");
    expect(meta?.rationale).toBeUndefined();
  });

  test("a malformed patch.json keeps the header fields and drops the rationale", () => {
    const header = formatWriteBackHeader({
      runId: "opt_bad",
      mutator: "claude",
      scoreBefore: 0,
      scoreAfter: 1,
      iterations: 1,
    });
    const optimizeRootDir = join(tmp, "optimize");
    mkdirSync(join(optimizeRootDir, "opt_bad"), { recursive: true });
    writeFileSync(join(optimizeRootDir, "opt_bad", "patch.json"), "{not json");
    const meta = extractOptimizeMetadata({ yaml: `${header}${YAML_V1}`, optimizeRootDir });
    expect(meta?.runId).toBe("opt_bad");
    expect(meta?.mutator).toBe("claude");
    expect(meta?.rationale).toBeUndefined();
  });
});

describe("changelog rendering + append", () => {
  test("renderChangelogEntry uses the injected clock and truncates the date to a day", () => {
    const entry = renderChangelogEntry({ version: "v1", yaml: YAML_V1, now: NOW });
    expect(entry.startsWith("## v1 — 2026-07-01\n")).toBe(true);
    expect(entry).toContain("- initial version");
  });

  test("an unparseable previous version renders a diff-unavailable entry instead of throwing", () => {
    const entry = renderChangelogEntry({
      version: "v2",
      yaml: YAML_V1,
      previousYaml: "a: [unclosed",
      now: NOW,
    });
    expect(entry).toContain("- diff unavailable");
  });

  test("insertNewestFirst creates the titled file and stacks entries newest-first", () => {
    const first = insertNewestFirst("", "demo", "## v1 — 2026-07-01\n\n- initial version\n");
    expect(first.startsWith("# Changelog — demo\n")).toBe(true);
    const second = insertNewestFirst(first, "demo", "## v2 — 2026-07-02\n\n- changed `x`\n");
    expect(second.indexOf("## v2")).toBeLessThan(second.indexOf("## v1"));
    expect(second.match(/^# Changelog — demo$/gm)).toHaveLength(1);
  });

  test("appendChangelogEntry writes beside the registry manifest and returns the path", () => {
    const rootDir = join(tmp, "specs");
    const path = appendChangelogEntry({
      registryRootDir: rootDir,
      name: "demo",
      version: "v1",
      yaml: YAML_V1,
      now: NOW,
    });
    expect(path).toBe(join(rootDir, "demo", "CHANGELOG.md"));
    expect(readFileSync(path, "utf-8")).toContain("## v1 — 2026-07-01");
  });
});
