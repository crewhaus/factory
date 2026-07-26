/**
 * Item 13 — unit tests for the scaffold-evals core (template-mode
 * determinism, task-phrase parsing, tool implication, grader synthesis,
 * model-response parsing, the no-overwrite guard) plus CLI integration for
 * `crewhaus scaffold-evals` and `init --with-evals`.
 *
 * CLI tests follow datasets-cli.test.ts's posture: stdout assertions are
 * avoided (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`) —
 * assert on exit codes and on-disk artifacts instead, which is why the
 * rubric-card cases pass `-o` and read the written file rather than reading
 * the pipe. `runCli` still DRAINS both pipes: a child that fills a pipe
 * buffer nobody reads blocks forever. The spawned env carries only PATH, so
 * every CLI run here exercises the OFFLINE template path (no credentials, no
 * model calls).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SampleSchema } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import {
  FIRST_PARTY_GRADER_TEMPLATES,
  GRADER_TEMPLATE_FAMILIES,
  graderTemplateCatalog,
} from "@crewhaus/template-registry";
import { providerCredentialsSatisfied } from "./doctor-checks";
import { gradersConfigToYaml } from "./feedback";
import {
  DEFAULT_SCAFFOLD_SAMPLES,
  SCAFFOLD_GENERATION_SYSTEM,
  SCAFFOLD_GRADERS_HEADER,
  type ScaffoldInfo,
  applyEvalTemplate,
  buildSampleGenerationPrompt,
  buildScaffoldGraders,
  buildScaffoldSamples,
  checkNoOverwrite,
  extractScaffoldInfo,
  feedbackBlockSuggestion,
  goldCapNote,
  mergeInputs,
  parseModelSampleInputs,
  taskPhrasesFromInstructions,
  templateSampleInputs,
  unknownTemplateMessage,
} from "./scaffold-evals";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-scaffold-evals-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain both pipes: a child that fills a pipe buffer nobody reads blocks.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function info(overrides: Partial<ScaffoldInfo> = {}): ScaffoldInfo {
  return {
    name: "helper",
    target: "cli",
    instructions:
      "You are a research assistant. You answer questions about the codebase, citing file paths. " +
      "Always search the web for recent developments when asked about news. " +
      "Never reveal internal secrets.",
    tools: ["webSearch", "read"],
    model: "claude-sonnet-4-6",
    hasFeedback: false,
    ...overrides,
  };
}

const CLI_SPEC = `name: helper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a research assistant. You answer questions about the codebase,
    citing file paths. Always search the web for recent developments.
tools: [webSearch, read]
`;

describe("extractScaffoldInfo", () => {
  it("extracts agent-block specs (cli)", () => {
    const got = extractScaffoldInfo(CLI_SPEC);
    expect(got.name).toBe("helper");
    expect(got.target).toBe("cli");
    expect(got.model).toBe("claude-sonnet-4-6");
    expect(got.tools).toEqual(["webSearch", "read"]);
    expect(got.instructions).toContain("research assistant");
    expect(got.hasFeedback).toBe(false);
  });

  it("detects a feedback: block", () => {
    const got = extractScaffoldInfo(`${CLI_SPEC}feedback:\n  modality: binary\n`);
    expect(got.hasFeedback).toBe(true);
  });

  it("joins workflow step instructions and unions step tools", () => {
    const yaml = [
      "name: pipeline",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: gather",
      "    instructions: Collect the raw notes from the docs directory.",
      "    tools: [read]",
      "  - name: summarize",
      "    instructions: Summarize the notes into three bullet points.",
      "    tools: [read, write]",
    ].join("\n");
    const got = extractScaffoldInfo(yaml);
    expect(got.instructions).toContain("Collect the raw notes");
    expect(got.instructions).toContain("Summarize the notes");
    expect(got.tools).toEqual(["read", "write"]);
    expect(got.model).toBe("claude-sonnet-4-6");
  });
});

describe("taskPhrasesFromInstructions", () => {
  it("drops persona/placeholder sentences and negative constraints", () => {
    const phrases = taskPhrasesFromInstructions(
      "You are a helpful assistant. Never reveal secrets. Do not answer in French. " +
        "Replace these instructions with your agent's actual behavior, persona, and constraints.",
    );
    expect(phrases).toEqual([]);
  });

  it("collapses modal prefixes and strips trailing punctuation", () => {
    const phrases = taskPhrasesFromInstructions(
      "You must answer questions about the codebase, citing file paths. " +
        "Always search the web for recent developments!",
    );
    expect(phrases).toEqual([
      "answer questions about the codebase, citing file paths",
      "search the web for recent developments",
    ]);
  });

  it("drops short fragments and dedupes case-insensitively", () => {
    const phrases = taskPhrasesFromInstructions(
      "Fix bugs. Summarize the weekly report for the team. summarize the weekly report for the team.",
    );
    expect(phrases).toEqual(["Summarize the weekly report for the team"]);
  });
});

describe("templateSampleInputs", () => {
  it("is deterministic (same info + n → identical list)", () => {
    const a = templateSampleInputs(info(), 8);
    const b = templateSampleInputs(info(), 8);
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
  });

  it("produces n unique task-shaped prompts derived from the instructions", () => {
    const inputs = templateSampleInputs(info(), 8);
    expect(new Set(inputs).size).toBe(8);
    expect(inputs.some((i) => i.includes("answer questions about the codebase"))).toBe(true);
    // The persona sentence and the negative constraint never surface.
    for (const input of inputs) {
      expect(input).not.toContain("You are a research assistant");
      expect(input.toLowerCase()).not.toContain("never reveal");
    }
  });

  it("falls back to generic stubs for the bare `init` placeholder spec", () => {
    const placeholder = info({
      name: "fresh",
      instructions:
        "You are a helpful assistant. Replace these instructions with your\n" +
        "agent's actual behavior, persona, and constraints.\n",
    });
    const inputs = templateSampleInputs(placeholder, 6);
    expect(inputs).toHaveLength(6);
    expect(new Set(inputs).size).toBe(6);
    expect(inputs.some((i) => i.includes("fresh"))).toBe(true);
    expect(inputs.some((i) => i.includes("Replace these instructions"))).toBe(false);
  });
});

describe("tool implication (via buildScaffoldSamples)", () => {
  it("maps implied spec tools to runtime PascalCase names", () => {
    const samples = buildScaffoldSamples(
      info(),
      ["Search the web for the latest news about Bun releases."],
      "template",
    );
    expect(samples[0]?.expected_tools).toEqual(["WebSearch"]);
  });

  it("never implies tools the spec does not declare", () => {
    const samples = buildScaffoldSamples(
      info({ tools: ["read"] }),
      ["Search the web for the latest news about Bun releases."],
      "template",
    );
    expect(samples[0]?.expected_tools).toBeUndefined();
  });

  it("implies custom (non-builtin) tools only on a verbatim mention", () => {
    const samples = buildScaffoldSamples(
      info({ tools: ["mcp__jira__createTicket"] }),
      ["Use mcp__jira__createTicket to file the bug.", "File a bug for the crash in the parser."],
      "template",
    );
    expect(samples[0]?.expected_tools).toEqual(["mcp__jira__createTicket"]);
    expect(samples[1]?.expected_tools).toBeUndefined();
  });

  it("does not fire on substrings inside words", () => {
    const samples = buildScaffoldSamples(
      info({ tools: ["read"] }),
      ["The results were already computed; summarize them."],
      "template",
    );
    expect(samples[0]?.expected_tools).toBeUndefined();
  });
});

describe("buildScaffoldSamples", () => {
  it("emits SampleSchema-valid stubs with stable zero-padded ids", () => {
    const samples = buildScaffoldSamples(info(), templateSampleInputs(info(), 8), "template");
    expect(samples).toHaveLength(8);
    expect(samples[0]?.id).toBe("scaffold_01");
    expect(samples[7]?.id).toBe("scaffold_08");
    for (const s of samples) {
      const parsed = SampleSchema.safeParse(s);
      expect(parsed.success).toBe(true);
      expect(s.metadata?.["source"]).toBe("scaffold-evals");
      expect(s.metadata?.["generator"]).toBe("template");
    }
  });
});

describe("buildScaffoldGraders", () => {
  it("online mode: one llm_judge rubric with all five anchors from the spec's goals", () => {
    const config = buildScaffoldGraders(info(), { online: true });
    expect(config.graders).toHaveLength(1);
    const g = config.graders[0];
    if (g?.type !== "llm_judge") throw new Error(`expected llm_judge, got ${g?.type}`);
    expect(g.name).toBe("spec_goal_alignment");
    const criterion = g.rubric.criteria[0];
    expect(criterion?.description).toContain("answer questions about the codebase");
    for (const k of ["1", "2", "3", "4", "5"] as const) {
      expect((criterion?.anchors[k] ?? "").length).toBeGreaterThan(0);
    }
    expect(g.rubric.passing_score).toBe(3);
    expect(g.model).toBeUndefined();
    // Round-trips through the real graders.yaml parser.
    const { compiled } = parseGradersConfig(gradersConfigToYaml(config, SCAFFOLD_GRADERS_HEADER));
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.judgeSpec).toBeDefined();
  });

  it("online mode bakes an explicit judge model into the grader", () => {
    const config = buildScaffoldGraders(info(), { online: true, model: "openai/gpt-4o" });
    const g = config.graders[0];
    if (g?.type !== "llm_judge") throw new Error("expected llm_judge");
    expect(g.model).toBe("openai/gpt-4o");
  });

  it("offline mode: exactly distill's non-empty-answer floor grader", () => {
    const config = buildScaffoldGraders(info(), { online: false });
    expect(config.graders).toEqual([{ name: "non_empty_answer", type: "regex", pattern: "\\S" }]);
    const { compiled } = parseGradersConfig(gradersConfigToYaml(config, SCAFFOLD_GRADERS_HEADER));
    expect(compiled).toHaveLength(1);
  });

  it("the scaffolded graders.yaml carries the scaffold header, not distill's", () => {
    const yaml = gradersConfigToYaml(
      buildScaffoldGraders(info(), { online: false }),
      SCAFFOLD_GRADERS_HEADER,
    );
    expect(yaml).toContain("Scaffolded by `crewhaus scaffold-evals`");
    expect(yaml).toContain("hard-ANDs");
    expect(yaml).not.toContain("crewhaus distill");
  });
});

describe("model-mode pure halves", () => {
  it("buildSampleGenerationPrompt folds instructions, tools, and the count", () => {
    const prompt = buildSampleGenerationPrompt(info(), 8);
    expect(prompt).toContain("research assistant");
    expect(prompt).toContain("webSearch, read");
    expect(prompt).toContain("exactly 8 eval input prompts");
    expect(SCAFFOLD_GENERATION_SYSTEM).toContain('{"inputs":');
  });

  it("parseModelSampleInputs parses fenced JSON, trims, dedupes, clips", () => {
    const raw = 'Here you go:\n```json\n{"inputs": [" a task ", "a task", "b", "", "c", "d"]}\n```';
    expect(parseModelSampleInputs(raw, 3)).toEqual(["a task", "b", "c"]);
  });

  it("parseModelSampleInputs returns [] on any failure", () => {
    expect(parseModelSampleInputs("no json here", 5)).toEqual([]);
    expect(parseModelSampleInputs('{"inputs": "not an array"}', 5)).toEqual([]);
    expect(parseModelSampleInputs('{"nope": []}', 5)).toEqual([]);
    expect(parseModelSampleInputs('{"inputs": [1, 2]}', 5)).toEqual([]);
  });

  it("mergeInputs tops a short model response up from the template", () => {
    expect(mergeInputs(["m1", "m2"], ["t1", "m2", "t2", "t3"], 4)).toEqual([
      "m1",
      "m2",
      "t1",
      "t2",
    ]);
    expect(mergeInputs(["m1", "m2", "m3"], ["t1"], 2)).toEqual(["m1", "m2"]);
  });
});

describe("checkNoOverwrite", () => {
  const paths = ["/x/eval/dataset.jsonl", "/x/eval/graders.yaml"];

  it("passes when nothing exists", () => {
    expect(checkNoOverwrite(paths, () => false, false)).toBeUndefined();
  });

  it("blocks and names the existing assets", () => {
    const msg = checkNoOverwrite(paths, (p) => p.endsWith("dataset.jsonl"), false);
    expect(msg).toContain("/x/eval/dataset.jsonl");
    expect(msg).not.toContain("graders.yaml");
    expect(msg).toContain("--force");
  });

  it("--force bypasses the guard", () => {
    expect(checkNoOverwrite(paths, () => true, true)).toBeUndefined();
  });
});

describe("providerCredentialsSatisfied (scaffold mode selection)", () => {
  it("is false for a claude model without Anthropic env", () => {
    expect(providerCredentialsSatisfied("claude-sonnet-4-6", {})).toBe(false);
  });

  it("is true when the matching provider env is set", () => {
    expect(
      providerCredentialsSatisfied("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "sk-test" }),
    ).toBe(true);
    expect(providerCredentialsSatisfied("openai/gpt-4o", { OPENAI_API_KEY: "sk" })).toBe(true);
  });

  it("is true for credential-free local endpoints and false for junk", () => {
    expect(providerCredentialsSatisfied("local/llama-3@http://localhost:8080/v1", {})).toBe(true);
    expect(providerCredentialsSatisfied("not/a/real/provider//", {})).toBe(false);
  });
});

describe("feedbackBlockSuggestion", () => {
  it("suggests a parseable feedback block", () => {
    const s = feedbackBlockSuggestion();
    expect(s).toContain("feedback:");
    expect(s).toContain("autoDistill: true");
  });
});

// -------- CLI integration (offline template mode only — env carries no creds) --------

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("crewhaus scaffold-evals (CLI, offline)", () => {
  it("writes dataset.jsonl + graders.yaml next to the spec and guards overwrites", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);

    const first = await runCli(["scaffold-evals", "crewhaus.yaml", "--samples", "5"], root);
    expect(first.exitCode).toBe(0);

    const datasetPath = join(root, "eval", "dataset.jsonl");
    const gradersPath = join(root, "eval", "graders.yaml");
    expect(existsSync(datasetPath)).toBe(true);
    expect(existsSync(gradersPath)).toBe(true);

    const samples = readJsonl(datasetPath);
    expect(samples).toHaveLength(5);
    for (const s of samples) {
      expect(SampleSchema.safeParse(s).success).toBe(true);
    }
    // Offline (env has no credentials) → the floor grader.
    const gradersYaml = readFileSync(gradersPath, "utf-8");
    const { config } = parseGradersConfig(gradersYaml);
    expect(config.graders).toHaveLength(1);
    expect(config.graders[0]?.name).toBe("non_empty_answer");

    // No --force → refuse to overwrite; --force → replace.
    const blocked = await runCli(["scaffold-evals", "crewhaus.yaml"], root);
    expect(blocked.exitCode).toBe(1);
    const forced = await runCli(["scaffold-evals", "crewhaus.yaml", "--force"], root);
    expect(forced.exitCode).toBe(0);
    expect(readJsonl(datasetPath)).toHaveLength(DEFAULT_SCAFFOLD_SAMPLES);
  });

  it("template mode is deterministic across runs", async () => {
    const rootA = newTempRoot();
    const rootB = newTempRoot();
    writeFileSync(join(rootA, "crewhaus.yaml"), CLI_SPEC);
    writeFileSync(join(rootB, "crewhaus.yaml"), CLI_SPEC);
    expect((await runCli(["scaffold-evals", "crewhaus.yaml"], rootA)).exitCode).toBe(0);
    expect((await runCli(["scaffold-evals", "crewhaus.yaml"], rootB)).exitCode).toBe(0);
    expect(readFileSync(join(rootA, "eval", "dataset.jsonl"), "utf-8")).toBe(
      readFileSync(join(rootB, "eval", "dataset.jsonl"), "utf-8"),
    );
    expect(readFileSync(join(rootA, "eval", "graders.yaml"), "utf-8")).toBe(
      readFileSync(join(rootB, "eval", "graders.yaml"), "utf-8"),
    );
  });

  it("rejects a missing spec and a bad --samples", async () => {
    const root = newTempRoot();
    expect((await runCli(["scaffold-evals"], root)).exitCode).toBe(1);
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    expect(
      (await runCli(["scaffold-evals", "crewhaus.yaml", "--samples", "0"], root)).exitCode,
    ).toBe(1);
  });
});

// -------- E47: the eval-template family library --------

describe("applyEvalTemplate (pure)", () => {
  const assets = {
    gradersYaml: "graders:\n  - name: g\n    type: contains\n    substring: x\n",
    notes: "review the anchors",
    seedDataset: [
      { id: "seed_a", input: "first seeded task", metadata: { family: "rag" } },
      { id: "seed_b", input: "second seeded task", expected_output: "gold" },
    ],
  };

  it("uses the family's seeds first, then tops up from the spec", () => {
    const applied = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets,
      samples: 5,
    });
    expect(applied.seedCount).toBe(2);
    expect(applied.stubCount).toBe(3);
    expect(applied.samples).toHaveLength(5);
    expect(applied.samples.slice(0, 2).map((s) => s.id)).toEqual(["seed_a", "seed_b"]);
    // Seed provenance survives, plus the template stamp on every sample.
    expect(applied.samples[0]?.metadata?.["family"]).toBe("rag");
    for (const s of applied.samples) expect(s.metadata?.["template"]).toBe("rag");
    expect(applied.samples[0]?.metadata?.["template_version"]).toBe("1.0.0");
    expect(applied.samples[1]?.expected_output).toBe("gold");
    for (const s of applied.samples) expect(SampleSchema.safeParse(s).success).toBe(true);
  });

  it("copies the family graders.yaml verbatim under a provenance header", () => {
    const applied = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets,
      samples: 2,
    });
    expect(applied.gradersYaml).toContain('# Copied from the eval-template family "rag"@1.0.0');
    expect(applied.gradersYaml.endsWith(assets.gradersYaml)).toBe(true);
    expect(parseGradersConfig(applied.gradersYaml).config.graders).toHaveLength(1);
  });

  it("truncates to --samples when the family ships more seeds than asked for", () => {
    const applied = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets,
      samples: 1,
    });
    expect(applied.samples.map((s) => s.id)).toEqual(["seed_a"]);
    expect(applied.stubCount).toBe(0);
  });

  it("is deterministic — same inputs, byte-identical output", () => {
    const once = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets,
      samples: 6,
    });
    const twice = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets,
      samples: 6,
    });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it("never lets a seed id collide with a topped-up stub id", () => {
    const applied = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets: { gradersYaml: assets.gradersYaml, seedDataset: [{ id: "scaffold_1", input: "x" }] },
      samples: 4,
    });
    expect(new Set(applied.samples.map((s) => s.id)).size).toBe(applied.samples.length);
  });

  it("requiresGold caps at the seeds instead of writing stubs that auto-fail", () => {
    // A gold-needing family (classify's `expected_contains`) grades a
    // gold-less sample as an automatic FAIL, and the eval preflight only
    // REFUSES a wholly gold-less dataset — so topping up would ship a dataset
    // whose ceiling is seeds/--samples.
    const golden = {
      gradersYaml: "graders:\n  - name: g\n    type: expected_contains\n",
      seedDataset: [
        { id: "seed_a", input: "one", expected_output: "billing" },
        { id: "seed_b", input: "two", expected_output: "bug" },
      ],
    };
    const capped = applyEvalTemplate({
      info: info(),
      family: "classify",
      version: "1.0.0",
      assets: golden,
      samples: 8,
      requiresGold: true,
    });
    expect(capped.samples).toHaveLength(2);
    expect(capped.stubCount).toBe(0);
    expect(capped.goldCapped).toBe(true);
    for (const s of capped.samples) expect(s.expected_output).toBeDefined();
    // No cap when the request already fits inside the seeds.
    expect(
      applyEvalTemplate({
        info: info(),
        family: "classify",
        version: "1.0.0",
        assets: golden,
        samples: 2,
        requiresGold: true,
      }).goldCapped,
    ).toBe(false);
    // …and a judge family still tops up exactly as before.
    const toppedUp = applyEvalTemplate({
      info: info(),
      family: "rag",
      version: "1.0.0",
      assets,
      samples: 5,
    });
    expect(toppedUp.goldCapped).toBe(false);
    expect(toppedUp.stubCount).toBe(3);
  });

  it("goldCapNote says WHY the dataset is shorter than --samples", () => {
    // "I asked for 8 and got 3" reads as a bug unless the reason is printed.
    const note = goldCapNote("classify", 3, 8);
    expect(note).toContain("--samples 8");
    expect(note).toContain("3 gold-carrying seed");
    expect(note).toContain("classify");
    expect(note).toContain("expected_output");
  });
});

describe("the shipped eval-template families", () => {
  it("every family's graders.yaml parses against the REAL grader schema", () => {
    expect(FIRST_PARTY_GRADER_TEMPLATES.length).toBeGreaterThan(0);
    for (const manifest of FIRST_PARTY_GRADER_TEMPLATES) {
      const yaml = manifest.evalAssets?.gradersYaml ?? "";
      const { compiled, config } = parseGradersConfig(yaml);
      // One grader per family: stacking hard-ANDs (eval-grader `all`).
      expect(config.graders).toHaveLength(1);
      expect(compiled).toHaveLength(1);
    }
  });

  it("every family's seed samples are SampleSchema-valid", () => {
    for (const manifest of FIRST_PARTY_GRADER_TEMPLATES) {
      for (const sample of manifest.evalAssets?.seedDataset ?? []) {
        expect(SampleSchema.safeParse(sample).success).toBe(true);
      }
    }
  });

  it("unknownTemplateMessage lists every family instead of guessing", () => {
    const message = unknownTemplateMessage("rga", graderTemplateCatalog());
    expect(message).toContain('unknown --template "rga"');
    for (const family of GRADER_TEMPLATE_FAMILIES) expect(message).toContain(family);
  });
});

describe("crewhaus scaffold-evals --template (CLI, offline)", () => {
  it("writes the family's assets, refuses an unknown family, and refuses --model", async () => {
    const root = newTempRoot();
    const unknownRoot = newTempRoot();
    const modelRoot = newTempRoot();
    for (const dir of [root, unknownRoot, modelRoot]) {
      writeFileSync(join(dir, "crewhaus.yaml"), CLI_SPEC);
    }
    // Independent cases → spawn concurrently (CI-time discipline).
    const [applied, unknown, withModel] = await Promise.all([
      runCli(["scaffold-evals", "crewhaus.yaml", "--template", "classify"], root),
      runCli(["scaffold-evals", "crewhaus.yaml", "--template", "not-a-family"], unknownRoot),
      runCli(
        ["scaffold-evals", "crewhaus.yaml", "--template", "rag", "--model", "claude-sonnet-4-5"],
        modelRoot,
      ),
    ]);
    expect(applied.exitCode).toBe(0);
    expect(unknown.exitCode).toBe(1);
    expect(withModel.exitCode).toBe(1);
    // The unknown/refused runs wrote nothing.
    expect(existsSync(join(unknownRoot, "eval", "graders.yaml"))).toBe(false);
    expect(existsSync(join(modelRoot, "eval", "graders.yaml"))).toBe(false);

    const gradersYaml = readFileSync(join(root, "eval", "graders.yaml"), "utf-8");
    expect(parseGradersConfig(gradersYaml).config.graders[0]?.type).toBe("expected_contains");
    const samples = readJsonl(join(root, "eval", "dataset.jsonl"));
    // `classify`'s only grader is `expected_contains`, so the dataset stops
    // at the family's GOLD-CARRYING seeds rather than being topped up to
    // --samples with gold-less stubs (which would auto-fail, capping the
    // scaffolded suite at 3/8 out of the box).
    expect(samples.length).toBeLessThan(DEFAULT_SCAFFOLD_SAMPLES);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(s.expected_output).toBeTruthy();
    expect(samples[0]?.metadata?.template).toBe("classify");
    for (const s of samples) expect(SampleSchema.safeParse(s).success).toBe(true);

    // A judge family has no gold requirement and still tops up to --samples.
    const ragRoot = newTempRoot();
    writeFileSync(join(ragRoot, "crewhaus.yaml"), CLI_SPEC);
    const rag = await runCli(["scaffold-evals", "crewhaus.yaml", "--template", "rag"], ragRoot);
    expect(rag.exitCode).toBe(0);
    expect(readJsonl(join(ragRoot, "eval", "dataset.jsonl"))).toHaveLength(
      DEFAULT_SCAFFOLD_SAMPLES,
    );
  }, 60_000);

  it("graders card --template renders a family's rubric without scaffolding it", async () => {
    // The gallery is the discovery surface: reading what `rag` measures must
    // not require writing a graders.yaml into a harness first. Cards are
    // written with -o so the assertions read FILES, not spawn pipes (this
    // file's posture).
    const root = newTempRoot();
    const unknownRoot = newTempRoot();
    const scaffoldRoot = newTempRoot();
    writeFileSync(join(scaffoldRoot, "crewhaus.yaml"), CLI_SPEC);
    const [carded, unknown] = await Promise.all([
      runCli(["graders", "card", "--template", "rag", "-o", "family-card.md"], root),
      runCli(["graders", "card", "--template", "not-a-family", "-o", "nope.md"], unknownRoot),
    ]);
    expect(carded.exitCode).toBe(0);
    expect(unknown.exitCode).toBe(1);
    expect(existsSync(join(unknownRoot, "nope.md"))).toBe(false);
    const familyCard = readFileSync(join(root, "family-card.md"), "utf-8");
    expect(familyCard).toContain("Grader rubric card — eval-template rag@");
    expect(familyCard).toContain("groundedness");

    // The card's hash is the family's own instrument identity: carding the
    // SCAFFOLDED copy of the same family must produce the same hash, which is
    // what proves the copy is unedited.
    await runCli(["scaffold-evals", "crewhaus.yaml", "--template", "rag"], scaffoldRoot);
    const fromFile = await runCli(
      ["graders", "card", "--graders", join("eval", "graders.yaml"), "-o", "scaffolded-card.md"],
      scaffoldRoot,
    );
    expect(fromFile.exitCode).toBe(0);
    const hashOf = (text: string): string =>
      text.match(/gradersHash\*\*: `([a-f0-9]+)`/)?.[1] ?? "";
    const familyHash = hashOf(familyCard);
    expect(familyHash).not.toBe("");
    expect(hashOf(readFileSync(join(scaffoldRoot, "scaffolded-card.md"), "utf-8"))).toBe(
      familyHash,
    );

    // --graders and --template are mutually exclusive; neither is optional.
    const [both, neither] = await Promise.all([
      runCli(["graders", "card", "--template", "rag", "--graders", "g.yaml"], newTempRoot()),
      runCli(["graders", "card"], newTempRoot()),
    ]);
    expect(both.exitCode).toBe(1);
    expect(neither.exitCode).toBe(1);
  }, 60_000);

  it("template mode is byte-identical across machines/runs", async () => {
    const rootA = newTempRoot();
    const rootB = newTempRoot();
    writeFileSync(join(rootA, "crewhaus.yaml"), CLI_SPEC);
    writeFileSync(join(rootB, "crewhaus.yaml"), CLI_SPEC);
    const [a, b] = await Promise.all([
      runCli(["scaffold-evals", "crewhaus.yaml", "--template", "safety"], rootA),
      runCli(["scaffold-evals", "crewhaus.yaml", "--template", "safety"], rootB),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    for (const file of ["dataset.jsonl", "graders.yaml"]) {
      expect(readFileSync(join(rootA, "eval", file), "utf-8")).toBe(
        readFileSync(join(rootB, "eval", file), "utf-8"),
      );
    }
  }, 60_000);
});

describe("crewhaus init --with-evals (CLI, always offline)", () => {
  it("scaffolds spec + eval assets at the flywheel's conventional paths", async () => {
    const root = newTempRoot();
    const got = await runCli(["init", "--with-evals"], root);
    expect(got.exitCode).toBe(0);
    expect(existsSync(join(root, "crewhaus.yaml"))).toBe(true);

    const datasetPath = join(root, "eval", "dataset.jsonl");
    const gradersPath = join(root, "eval", "graders.yaml");
    const samples = readJsonl(datasetPath);
    expect(samples).toHaveLength(DEFAULT_SCAFFOLD_SAMPLES);
    for (const s of samples) {
      expect(SampleSchema.safeParse(s).success).toBe(true);
    }
    // init never requires credentials → always the floor grader.
    const { config } = parseGradersConfig(readFileSync(gradersPath, "utf-8"));
    expect(config.graders[0]?.name).toBe("non_empty_answer");
    expect(config.graders[0]?.type).toBe("regex");
  });

  it("composes with an existing harness and keeps existing eval assets", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const datasetPath = join(root, "eval", "dataset.jsonl");

    expect((await runCli(["init", "--with-evals"], root)).exitCode).toBe(0);
    const firstDataset = readFileSync(datasetPath, "utf-8");
    // The existing spec is untouched.
    expect(readFileSync(join(root, "crewhaus.yaml"), "utf-8")).toBe(CLI_SPEC);

    // Second run keeps the existing assets (exit 0, byte-identical).
    writeFileSync(datasetPath, `${firstDataset}{"id":"user_added","input":"my own sample"}\n`);
    expect((await runCli(["init", "--with-evals"], root)).exitCode).toBe(0);
    expect(readFileSync(datasetPath, "utf-8")).toContain("user_added");
  });
});
