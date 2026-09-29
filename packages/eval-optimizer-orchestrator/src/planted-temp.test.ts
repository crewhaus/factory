/**
 * 0.7.1 — `optimize --write-back` replaces the operator's spec through a random
 * O_EXCL|O_NOFOLLOW temp. 0.7.0 wrote the stamped spec to the fixed
 * `<spec>.optimize.tmp` through any link planted there, then truncated it, so
 * a link planted beside the spec overwrote (and emptied) its target.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimizeSpec } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const CLI_YAML = `target: cli
name: hello-cli
agent:
  model: claude-sonnet-4-5
  instructions: You are a helpful assistant.
tools:
  - Read
`;

async function optimize(specPath: string, outDir: string) {
  return optimizeSpec({
    specPath,
    fitness: async (prompt: string) => prompt.length / 100,
    trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
    devSet: [{ id: "d1", input: "x", expected_output: "y" }],
    iterations: 3,
    seed: 42,
    outDir,
    writeBack: true,
  });
}

describe("optimize write-back never goes through a planted link (0.7.1)", () => {
  test("a link at <spec>.optimize.tmp is neither written nor truncated", async () => {
    const base = mkdtempSync(join(tmpdir(), "optimize-links-"));
    ROOTS.push(base);
    mkdirSync(join(base, "ws"));
    mkdirSync(join(base, "outside"));
    const victim = join(base, "outside", "victim");
    writeFileSync(victim, "ORIGINAL\n");
    const specPath = join(base, "ws", "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML, { mode: 0o640 });
    symlinkSync(victim, `${specPath}.optimize.tmp`);

    const result = await optimize(specPath, join(base, "ws", "out"));
    expect(result.writtenTo).toBe(specPath);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(readFileSync(specPath, "utf8")).toContain("# crewhaus optimize: runId");
    // Replaced, not rewritten in place: still a file, and its mode is kept.
    expect(lstatSync(specPath).isSymbolicLink()).toBe(false);
    expect(statSync(specPath).mode & 0o777).toBe(0o640);
  });

  test("a spec path that is the operator's own link is written where it leads, as before", async () => {
    const base = mkdtempSync(join(tmpdir(), "optimize-links-"));
    ROOTS.push(base);
    mkdirSync(join(base, "specs"));
    const real = join(base, "specs", "v2.yaml");
    writeFileSync(real, CLI_YAML);
    const specPath = join(base, "crewhaus.yaml");
    symlinkSync(real, specPath);
    await optimize(specPath, join(base, "out"));
    expect(lstatSync(specPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("# crewhaus optimize: runId");
  });
});
