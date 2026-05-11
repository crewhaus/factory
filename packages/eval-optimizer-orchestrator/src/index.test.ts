import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimizeSpec } from "./index";

const CLI_YAML = `# A simple CLI agent
target: cli
name: hello-cli
agent:
  model: claude-sonnet-4-5
  # The system prompt:
  instructions: You are a helpful assistant.
tools:
  - Read
`;

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "optimize-test-"));
});

afterEach(() => {
  // Best-effort cleanup; not critical for correctness.
});

describe("optimizeSpec — end-to-end fitness loop", () => {
  test("identifies improvement via a synthetic fitness function", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Fitness: reward longer prompts (proxy for "rule-based provider
    // adds words"). The mutator appends sentences over time, so the
    // best candidate after N iterations should outscore the base.
    const fitness = async (prompt: string) => prompt.length / 100;

    const outDir = join(tmpRoot, "out");
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 5,
      seed: 42,
      outDir,
    });

    expect(result.improvement).toBeGreaterThan(0);
    expect(result.scoreAfter).toBeGreaterThan(result.scoreBefore);
    expect(result.applied).toBe(true);
    expect(result.patch.target).toBe("cli");
    expect(result.patch.path).toEqual(["agent", "instructions"]);
    expect(result.patch.op).toBe("replace");
    expect(typeof result.patch.value).toBe("string");
    expect(result.trajectory.length).toBe(6); // base + 5 iterations
  });

  test("persists patch.json and report.json regardless of writeBack flag", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (prompt: string) => prompt.length / 100;
    const outDir = join(tmpRoot, "out");
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir,
    });

    expect(existsSync(join(result.outDir, "patch.json"))).toBe(true);
    expect(existsSync(join(result.outDir, "report.json"))).toBe(true);
    // prompt-optimizer persists trajectory + best under its own
    // <runId>/ subdir within the supplied outDir, so the path is
    // outDir/runId/trajectory.json.
    expect(existsSync(join(result.outDir, result.runId, "trajectory.json"))).toBe(true);
    expect(existsSync(join(result.outDir, result.runId, "best.json"))).toBe(true);
  });

  test("writeBack: false leaves the source spec untouched", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (prompt: string) => prompt.length / 100;
    await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
      // writeBack omitted — default false
    });

    const source = readFileSync(specPath, "utf8");
    expect(source).toBe(CLI_YAML);
  });

  test("writeBack: true rewrites the source with a header", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    const fitness = async (prompt: string) => prompt.length / 100;
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
      writeBack: true,
    });

    expect(result.writtenTo).toBe(specPath);
    const source = readFileSync(specPath, "utf8");
    expect(source).toContain("# crewhaus optimize: runId");
    expect(source).toContain("# A simple CLI agent"); // original leading comment preserved
    expect(source).toContain("# The system prompt:"); // structural comment preserved
  });

  test("rejects workflow/graph/crew targets (v0 limitation)", async () => {
    const WORKFLOW_YAML = `target: workflow
name: hello-workflow
model: claude-sonnet-4-5
steps:
  - name: step1
    instructions: Step one.
`;
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, WORKFLOW_YAML);

    const fitness = async (_p: string) => 0.5;
    await expect(
      optimizeSpec({
        specPath,
        fitness,
        trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
        devSet: [{ id: "d1", input: "x", expected_output: "y" }],
        iterations: 1,
        outDir: join(tmpRoot, "out"),
      }),
    ).rejects.toThrow(/multiple prompts/);
  });

  test("rejects an invalid spec path", async () => {
    const fitness = async (_p: string) => 0.5;
    await expect(
      optimizeSpec({
        specPath: join(tmpRoot, "nope.yaml"),
        fitness,
        trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
        devSet: [{ id: "d1", input: "x", expected_output: "y" }],
        iterations: 1,
        outDir: join(tmpRoot, "out"),
      }),
    ).rejects.toThrow(/cannot read spec/);
  });
});

describe("optimizeSpec — applied=false below threshold", () => {
  test("reports applied=false when improvement is below threshold", async () => {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);

    // Constant fitness — every candidate scores the same, so improvement = 0.
    const fitness = async (_p: string) => 0.5;
    const result = await optimizeSpec({
      specPath,
      fitness,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(tmpRoot, "out"),
      improvementThreshold: 0.01,
    });

    expect(result.improvement).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.writtenTo).toBeUndefined();
  });
});
