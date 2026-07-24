import { describe, expect, test } from "bun:test";
import { compile } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import type { WatchmeObservation } from "@crewhaus/watchme-store";
import type { Intent, IntentDigest } from "./intents";
import {
  type SynthesizeFs,
  type WatchmeSynthesisInput,
  WatchmeSynthesizeError,
  buildSynthesisEdits,
  cliTemplateYaml,
  runWatchmeSynthesize,
  synthesizeSpec,
} from "./watchme-synthesize";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function modelRow(
  model: string,
  turns: number,
  costUsdMicros?: number,
  unpriced?: boolean,
): WatchmeObservation["models"][number] {
  return {
    wire: model,
    provider: "test",
    turns,
    usage: { in: 1000, out: 500, cacheRead: 0, cacheCreate: 0 },
    ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
    ...(unpriced === true ? { unpriced: true } : {}),
  };
}

function obs(over: {
  sessionId: string;
  models?: WatchmeObservation["models"];
  toolStats?: WatchmeObservation["toolStats"];
  quality?: WatchmeObservation["quality"];
  feedback?: WatchmeObservation["feedback"];
}): WatchmeObservation {
  return {
    v: 1,
    sessionId: over.sessionId,
    specName: "watched",
    target: "cli",
    ts: 1_700_000_000_000,
    turnCount: 6,
    joinConfidence: "exact",
    models: over.models ?? [],
    toolStats: over.toolStats ?? [],
    intentKeys: [],
    ...(over.quality !== undefined ? { quality: over.quality } : {}),
    ...(over.feedback !== undefined ? { feedback: over.feedback } : {}),
  };
}

function intent(representative: string, over: Partial<Intent> = {}): Intent {
  return {
    representative,
    occurrences: 4,
    sessionCount: 3,
    meanRating: 0.7,
    failedTurns: 0,
    failureRate: 0,
    earlyCount: 2,
    recentCount: 2,
    examples: [],
    ...over,
  };
}

const QUALITY = { ratings: 1, meanRating: 0.75, judged: 1, meanJudge: 0.85 } as const;

function baseInput(over: Partial<WatchmeSynthesisInput> = {}): WatchmeSynthesisInput {
  const observations: WatchmeObservation[] = [
    obs({
      sessionId: "s1",
      models: [modelRow("modelA-strong", 2, 20_000), modelRow("modelB-mid", 1, 2_000)],
      toolStats: [
        { name: "Read", calls: 3, errors: 0 },
        { name: "Bash", calls: 1, errors: 0 },
        { name: "mcp__github__create_issue", calls: 2, errors: 0 },
        { name: "FocusWrite", calls: 5, errors: 0 },
      ],
      quality: QUALITY,
      feedback: { up: 2, down: 1 },
    }),
    obs({
      sessionId: "s2",
      models: [modelRow("modelA-strong", 2, 20_000), modelRow("modelB-mid", 1, 2_000)],
      toolStats: [{ name: "Read", calls: 2, errors: 0 }],
      quality: QUALITY,
    }),
    obs({
      sessionId: "s3",
      models: [modelRow("modelA-strong", 2, 20_000)],
      toolStats: [{ name: "Grep", calls: 1, errors: 0 }],
      quality: QUALITY,
    }),
    obs({
      sessionId: "s4",
      models: [modelRow("modelA-strong", 2, 20_000)],
      quality: QUALITY,
    }),
  ];
  const i1 = intent("summarize the SECRET-TOKEN deploy logs", { occurrences: 9, sessionCount: 4 });
  const i2 = intent("draft the weekly report", { meanRating: 0.4 });
  const intents: IntentDigest = {
    totalTurns: 24,
    totalSessions: 4,
    intents: [i1, i2],
    topIntents: [i1, i2],
    risingIntents: [],
    lowSatisfactionIntents: [i2],
    unmetIntents: [],
  };
  return {
    name: "mimic",
    observations,
    intents,
    counterfactualModels: [{ model: "modelC-cheap", estCostUsdMicrosPerTurn: 500 }],
    mcpServers: { github: { transport: "stdio", command: "bunx", args: ["github-mcp"] } },
    redact: (s) => s.replaceAll("SECRET-TOKEN", "[redacted]"),
    ...over,
  };
}

function memFs(): SynthesizeFs & { readonly files: Map<string, string>; readonly dirs: string[] } {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    exists: (p) => files.has(p),
    mkdirp: (d) => {
      dirs.push(d);
    },
    write: (p, t) => {
      files.set(p, t);
    },
  };
}

// ---------------------------------------------------------------------------
// §14 synthesize row
// ---------------------------------------------------------------------------

describe("synthesizeSpec (deterministic path)", () => {
  test("SpecEdits round-trip through parseSpec with every learned fact applied", () => {
    const r = synthesizeSpec(baseInput());
    expect(r.spec.target).toBe("cli");
    if (r.spec.target !== "cli") return;
    expect(r.spec.name).toBe("mimic");
    // observed tool vocabulary: builtins by calls desc then name; FocusWrite
    // (a continuity tool, not a builtin) is dropped.
    expect(r.spec.tools).toEqual(["read", "bash", "grep"]);
    // observed MCP server, config copied from the watched spec.
    expect(r.spec.mcp_servers?.["github"]).toMatchObject({ transport: "stdio", command: "bunx" });
    // most-used observed model.
    expect(r.spec.agent.model).toBe("modelA-strong");
    // observed quality bar: (4*0.75 + 4*0.85) / 8 = 0.8.
    expect(r.spec.evaluation?.grader.type).toBe("llm_judge");
    expect(r.spec.evaluation?.threshold).toBe(0.8);
    expect(r.spec.feedback?.enabled).toBe(true);
    // re-ask signals (intents spanning >= 2 sessions) => memory + continuity.
    expect(r.spec.memory?.enabled).toBe(true);
    expect(r.spec.continuity).toBe(true);
    expect(r.spec.watchme?.enabled).toBe(true);
    // instructions distilled from top intents, redacted.
    expect(r.spec.agent.instructions).toContain('"summarize the [redacted] deploy logs"');
    expect(r.yaml).not.toContain("SECRET-TOKEN");
    // an independent parseSpec of the emitted YAML round-trips.
    expect(parseSpec(r.yaml).name).toBe("mimic");
    // the diff vs the template names the learned facts.
    expect(r.diff.length).toBeGreaterThan(0);
    expect(r.baseYaml).toBe(cliTemplateYaml("mimic"));
  });

  test("compile() is green on the emitted YAML", () => {
    const r = synthesizeSpec(baseInput());
    const out = compile(r.yaml);
    expect(out.files.length).toBeGreaterThan(0);
  });

  test("model_pool candidates order cheapest→strongest, unpriced last, policy learned", () => {
    const input = baseInput();
    const observations = [
      ...input.observations,
      obs({ sessionId: "s5", models: [modelRow("modelD-unpriced", 1, undefined, true)] }),
    ];
    const r = synthesizeSpec({ ...input, observations });
    expect(r.spec.target).toBe("cli");
    if (r.spec.target !== "cli") return;
    // mean cost per turn: C=500 (counterfactual) < B=2000 < A=10000; D unpriced
    // is UNKNOWN cost (never free) and orders last.
    expect(r.spec.agent.model_pool?.candidates.map((c) => c.model)).toEqual([
      "modelC-cheap",
      "modelB-mid",
      "modelA-strong",
      "modelD-unpriced",
    ]);
    expect(r.spec.agent.model_pool?.policy).toBe("learned");
  });

  test("a single observed model with no counterfactuals emits no model_pool", () => {
    const input = baseInput({
      counterfactualModels: [],
      observations: [obs({ sessionId: "s1", models: [modelRow("modelA-strong", 3, 30_000)] })],
    });
    const r = synthesizeSpec(input);
    expect(r.spec.target).toBe("cli");
    if (r.spec.target !== "cli") return;
    expect(r.spec.agent.model_pool).toBeUndefined();
    expect(r.spec.agent.model).toBe("modelA-strong");
  });

  test("every edit carries a rationale naming the observed evidence", () => {
    const edits = buildSynthesisEdits(baseInput());
    expect(edits.length).toBeGreaterThanOrEqual(8);
    for (const e of edits) {
      expect(typeof e.rationale).toBe("string");
      expect((e.rationale ?? "").length).toBeGreaterThan(0);
    }
    const instructions = edits.find((e) => e.path.join(".") === "agent.instructions");
    expect(instructions?.rationale).toMatch(/observed intent ".+" across \d+ sessions/);
    // the rationale is redacted too.
    expect(instructions?.rationale).not.toContain("SECRET-TOKEN");
  });

  test("safeName rejection: an unsafe name throws before any spec is built", () => {
    expect(() => synthesizeSpec(baseInput({ name: "../evil" }))).toThrow(WatchmeSynthesizeError);
    expect(() => synthesizeSpec(baseInput({ name: "../evil" }))).toThrow(/not a safe spec name/);
    expect(() => synthesizeSpec(baseInput({ name: "a\nb" }))).toThrow(/not a safe spec name/);
  });
});

describe("runWatchmeSynthesize (orchestration)", () => {
  test("writes the NEW file under .crewhaus/watchme/synthesized and summarizes", async () => {
    const fs = memFs();
    const r = await runWatchmeSynthesize(baseInput(), { rootDir: "/harness", fs });
    expect(r.outPath).toBe("/harness/.crewhaus/watchme/synthesized/mimic.yaml");
    expect(fs.files.get(r.outPath)).toBe(r.yaml);
    expect(r.summary).toContain("learned facts:");
    expect(r.summary).toContain("diff vs the init template:");
    expect(r.summary).toContain(r.outPath);
  });

  test("force overwrite refusal: existing output requires --force", async () => {
    const fs = memFs();
    const input = baseInput();
    const first = await runWatchmeSynthesize(input, { rootDir: "/harness", fs });
    await expect(runWatchmeSynthesize(input, { rootDir: "/harness", fs })).rejects.toThrow(
      /refusing to overwrite .*--force/,
    );
    const forced = await runWatchmeSynthesize(input, { rootDir: "/harness", fs, force: true });
    expect(forced.outPath).toBe(first.outPath);
    expect(fs.files.get(forced.outPath)).toBe(forced.yaml);
  });

  test("an unsafe name never reaches the filesystem seam", async () => {
    const fs = memFs();
    await expect(
      runWatchmeSynthesize(baseInput({ name: "bad/name" }), { rootDir: "/harness", fs }),
    ).rejects.toThrow(/not a safe spec name/);
    expect(fs.files.size).toBe(0);
    expect(fs.dirs.length).toBe(0);
  });

  test("interview seam receives the redacted digest; propose hands off with source watchme", async () => {
    const fs = memFs();
    const interviewYaml = cliTemplateYaml("mimic").replace(
      "a helpful assistant",
      "a meticulous concierge",
    );
    let seenSeed = "";
    let seenName = "";
    const proposeCalls: Array<{
      specName: string;
      currentYaml: string;
      proposedYaml: string;
      source: "watchme";
    }> = [];
    const r = await runWatchmeSynthesize(baseInput(), {
      rootDir: "/harness",
      fs,
      interview: async ({ specName, seedDigest }) => {
        seenName = specName;
        seenSeed = seedDigest;
        return { yaml: interviewYaml };
      },
      propose: (p) => {
        proposeCalls.push(p);
      },
    });
    expect(seenName).toBe("mimic");
    expect(seenSeed).toContain("sessions observed: 4");
    expect(seenSeed).toContain("[redacted]");
    expect(seenSeed).not.toContain("SECRET-TOKEN");
    // the interview's YAML is what lands (gated), and edits are empty.
    expect(r.yaml).toBe(interviewYaml);
    expect(r.edits).toEqual([]);
    expect(fs.files.get(r.outPath)).toBe(interviewYaml);
    // propose handoff: template baseline vs proposed, source "watchme".
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0]?.source).toBe("watchme");
    expect(proposeCalls[0]?.currentYaml).toBe(cliTemplateYaml("mimic"));
    expect(proposeCalls[0]?.proposedYaml).toBe(interviewYaml);
  });

  test("an interview that returns an invalid spec fails the gate and writes nothing", async () => {
    const fs = memFs();
    await expect(
      runWatchmeSynthesize(baseInput(), {
        rootDir: "/harness",
        fs,
        interview: async () => ({ yaml: "target: cli\n" }),
      }),
    ).rejects.toThrow(/failed validation/);
    expect(fs.files.size).toBe(0);
  });
});
