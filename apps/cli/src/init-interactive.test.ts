import { describe, expect, test } from "bun:test";
import { compile, lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import {
  ASK_USER_TOOL,
  EMIT_SPEC_TOOL,
  HYBRID_INTERVIEW_QUESTION,
  INIT_PROVABILITY_LEVELS,
  InitProvabilityError,
  PROVABILITY_LEVEL_LINES,
  RESEARCH_DEFAULT_PROVABILITY,
  SCRIPTED_SHAPES,
  SHAPE_GUIDANCE,
  askProvability,
  buildHybridSpec,
  buildInterviewSystemPrompt,
  buildScriptedSpec,
  carriesProvability,
  isHybridYes,
  isScriptedShape,
  parseProvabilityAnswer,
  parseProvabilityFlag,
  provabilityAnswer,
  provabilityQuestion,
  provabilityScaffoldNotes,
  provabilityScaffoldTools,
  provabilityShapeRefusal,
  renderProvabilityBlock,
  renderProvabilityToolsBlock,
  setProvability,
} from "./init-interactive";
import { auditProvability } from "./lint";

describe("SHAPE_GUIDANCE + buildInterviewSystemPrompt", () => {
  test("covers the fourteen target shapes", () => {
    expect(SHAPE_GUIDANCE).toHaveLength(14);
    const targets = SHAPE_GUIDANCE.map((s) => s.target);
    expect(targets).toContain("cli");
    expect(targets).toContain("onchain-game");
  });

  test("system prompt bundles the shape catalog + hard rules (no demos dep)", () => {
    const prompt = buildInterviewSystemPrompt();
    expect(prompt).toContain("emit_spec");
    expect(prompt).toContain("$UPPER_SNAKE_CASE");
    expect(prompt).toContain("permissions.mode: bypass");
    // Every shape name appears in the prompt.
    for (const { target } of SHAPE_GUIDANCE) expect(prompt).toContain(target);
  });

  test("prompt carries the v0.3.0 §2.9 interview discipline (focused continuity variant)", () => {
    const prompt = buildInterviewSystemPrompt();
    // Two conversation tools, no forced toolChoice — the model is TOLD how
    // ask_user turns work instead of being forced into emit_spec.
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("end your");
    // Turn-1 extraction + echo of verbatim REQ entries.
    expect(prompt).toContain("REQ-001");
    expect(prompt).toContain("Requirements so far");
    // Never re-ask a confirmed REQ; the ledger is the check.
    expect(prompt).toContain("NEVER re-ask");
    expect(prompt).toContain("<requirements_ledger>");
    // Pre-emit REQ → spec-field mapping, listed in the reply.
    expect(prompt).toContain("→");
    expect(prompt).toContain("maps to a spec");
    // Resumed sessions lead with the resume summary.
    expect(prompt).toContain("Resuming: N");
    // In-context revision on validation errors — no interview restart.
    expect(prompt).toContain("do not restart the interview");
  });

  test("EMIT_SPEC_TOOL keeps the pre-0.3.0 contract: a required yaml string input", () => {
    expect(EMIT_SPEC_TOOL.name).toBe("emit_spec");
    expect(EMIT_SPEC_TOOL.input_schema.required).toEqual(["yaml"]);
  });

  test("ASK_USER_TOOL declares a required question string input", () => {
    expect(ASK_USER_TOOL.name).toBe("ask_user");
    expect(ASK_USER_TOOL.input_schema.required).toEqual(["question"]);
  });
});

describe("isScriptedShape", () => {
  test("accepts the scriptable shapes only", () => {
    expect(isScriptedShape("cli")).toBe(true);
    expect(isScriptedShape("workflow")).toBe(true);
    expect(isScriptedShape("research")).toBe(true);
    expect(isScriptedShape("channel")).toBe(false);
    expect(isScriptedShape("graph")).toBe(false);
  });
});

describe("buildScriptedSpec — every draft is parseSpec-validated", () => {
  test("cli with tools", () => {
    const { yaml, spec } = buildScriptedSpec({
      name: "my-agent",
      shape: "cli",
      model: "claude-opus-4-7",
      instructions: "You are helpful.\nBe concise.",
      tools: ["read", "webSearch"],
    });
    expect(spec.target).toBe("cli");
    // Re-parse the returned YAML independently to prove it round-trips.
    expect(parseSpec(yaml).name).toBe("my-agent");
    if (spec.target === "cli") expect(spec.tools).toEqual(["read", "webSearch"]);
  });

  test("workflow emits a single step", () => {
    const { spec } = buildScriptedSpec({
      name: "flow",
      shape: "workflow",
      model: "claude-opus-4-7",
      instructions: "do the thing",
    });
    expect(spec.target).toBe("workflow");
    if (spec.target === "workflow") {
      expect(spec.steps).toHaveLength(1);
      expect(spec.steps[0]?.name).toBe("flow-step");
    }
  });

  test("research carries the goal", () => {
    const { spec } = buildScriptedSpec({
      name: "res",
      shape: "research",
      model: "claude-opus-4-7",
      instructions: "investigate",
      goal: "find the best framework",
    });
    expect(spec.target).toBe("research");
    if (spec.target === "research") expect(spec.goal).toBe("find the best framework");
  });

  test("multiline instructions survive as a literal block scalar", () => {
    const { spec } = buildScriptedSpec({
      name: "x",
      shape: "cli",
      model: "claude-opus-4-7",
      instructions: "line one\nline two\nline three",
    });
    if (spec.target === "cli") {
      expect(spec.agent.instructions).toBe("line one\nline two\nline three\n");
    }
  });

  test("a value with YAML-significant chars is quoted so it still parses", () => {
    const { spec } = buildScriptedSpec({
      name: "x",
      shape: "cli",
      model: "openai/gpt-4o: latest",
      instructions: "hi",
    });
    if (spec.target === "cli") expect(spec.agent.model).toBe("openai/gpt-4o: latest");
  });

  test("an unsafe name throws SpecParseError (the safeName floor)", () => {
    expect(() =>
      buildScriptedSpec({
        name: "bad/name",
        shape: "cli",
        model: "claude-opus-4-7",
        instructions: "hi",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — `init --hybrid` and the ONE interview question.
// ---------------------------------------------------------------------------

describe("buildHybridSpec", () => {
  const pair = { fast: "claude-haiku-4-5", strong: "claude-opus-5" };
  const built = buildHybridSpec({
    name: "support",
    shape: "cli",
    model: pair.fast,
    instructions: "Answer support questions.",
    pair,
  });

  test("the scaffolded hybrid spec COMPILES — the whole point of a scaffold", () => {
    const ir = lower(built.spec);
    expect(ir.target).toBe("cli");
    // The registry lowered, so `$fast` resolved rather than reaching runtime.
    const models = (ir as { models?: Record<string, { model: string }> }).models;
    expect(models?.["fast"]?.model).toBe("claude-haiku-4-5");
    expect(models?.["strong"]?.model).toBe("claude-opus-5");
    expect((ir as { agent: { model: string } }).agent.model).toBe("claude-haiku-4-5");
  });

  test("writes §1's motivating topology: cheap drafts, a strong checker, escalate on failure", () => {
    const ir = lower(built.spec) as {
      agent: { modelPool?: { candidates: ReadonlyArray<{ model: string }>; strategy?: unknown } };
      evaluation?: { onFail: string };
    };
    expect(ir.agent.modelPool?.candidates.map((c) => c.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-5",
    ]);
    expect(ir.agent.modelPool?.strategy).toMatchObject({
      cascade: { draft: "cheap", escalateTo: "strong" },
    });
    expect(ir.evaluation?.onFail).toBe("escalate");
  });

  /**
   * §9.2 — the flagship scaffold must not ship a configuration the compiler
   * itself calls a hazard. The two-arm cascade's judge IS the strong serving
   * arm, so `model-plan-self-judge` fires unless the template says it meant
   * it; `allow_self_judge` (with the comment explaining the trade-off) is
   * that statement. A future template edit that reintroduces a model-plan
   * warning fails here.
   */
  test("the scaffold compiles with NO model-plan warning — not even the self-judge one", () => {
    const warnings = compile(built.yaml).warnings ?? [];
    expect(warnings.filter((w) => w.code.startsWith("model-plan"))).toEqual([]);
  });

  test("the self-judge waiver is DECLARED, and the comment says why", () => {
    expect(built.yaml).toContain("allow_self_judge: true");
    expect(built.yaml).toContain("the checker IS");
  });

  test("every block it writes carries the comment that explains it", () => {
    expect(built.yaml).toContain("# The model registry");
    expect(built.yaml).toContain("# The roster.");
    expect(built.yaml).toContain("# The cascade:");
    expect(built.yaml).toContain("# The judge that grades each draft.");
    expect(built.yaml).toContain("crewhaus route propose");
  });

  test("the pair stays within ONE provider — a cross-provider default is not the scaffold's call", () => {
    expect(built.yaml).not.toContain("openai/");
    expect(built.yaml).not.toContain("gemini/");
  });

  test("tools ride along when the interview collected any", () => {
    const withTools = buildHybridSpec({
      name: "support",
      shape: "cli",
      model: pair.fast,
      instructions: "Answer support questions.",
      tools: ["read", "grep"],
      pair,
    });
    expect(withTools.yaml).toContain("tools:");
    expect(() => lower(withTools.spec)).not.toThrow();
  });
});

describe("the hybrid interview question", () => {
  test("is exactly one question, and reads as a yes/no", () => {
    expect(HYBRID_INTERVIEW_QUESTION).toContain("[y/N]");
    expect(HYBRID_INTERVIEW_QUESTION.split("?").length).toBe(2);
  });

  test("only an explicit yes counts — the default is the single-model spec", () => {
    for (const yes of ["y", "Y", "yes", " YES "]) expect(isHybridYes(yes)).toBe(true);
    for (const no of ["", "n", "no", "maybe", "yep"]) expect(isHybridYes(no)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0.8.0 §11 — `init --provability`, the ONE proof question, and the
// researcher template's `cited` floor.
// ---------------------------------------------------------------------------

/** The lowered provability block of a scaffold, or undefined when it lowers to none. */
const loweredProvability = (yaml: string): { level: string } | undefined =>
  (lower(parseSpec(yaml)) as { provability?: { level: string } }).provability;

describe("the proof rungs init accepts", () => {
  test("are the spec's rungs, lowest first, each explained in one line", () => {
    expect([...INIT_PROVABILITY_LEVELS]).toEqual(["off", "cited", "grounded", "checked", "proven"]);
    expect(PROVABILITY_LEVEL_LINES.map((l) => l.level)).toEqual([...INIT_PROVABILITY_LEVELS]);
    for (const { line } of PROVABILITY_LEVEL_LINES) {
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain("\n");
    }
  });

  test("--provability validates the rung (any case) and names every rung when it is not one", () => {
    expect(parseProvabilityFlag("grounded")).toBe("grounded");
    expect(parseProvabilityFlag(" Proven ")).toBe("proven");
    expect(() => parseProvabilityFlag("verified")).toThrow(InitProvabilityError);
    expect(() => parseProvabilityFlag("verified")).toThrow(
      '--provability must be one of off | cited | grounded | checked | proven (got "verified")',
    );
    expect(() => parseProvabilityFlag("")).toThrow(InitProvabilityError);
  });

  test("only the cli and research scaffolds carry the block", () => {
    expect(carriesProvability("cli")).toBe(true);
    expect(carriesProvability("research")).toBe(true);
    expect(carriesProvability("workflow")).toBe(false);
  });
});

describe("the proof question", () => {
  test("is ONE question listing the five rungs one line each, with the default in brackets", () => {
    const q = provabilityQuestion("off");
    expect(q.startsWith("How much proof should answers carry?\n")).toBe(true);
    expect(q.split("?").length).toBe(2);
    const listed = q.split("\n").slice(1, -1);
    expect(listed.map((l) => l.trim().split(/\s+/)[0])).toEqual([...INIT_PROVABILITY_LEVELS]);
    expect(q.endsWith("proof level [off]: ")).toBe(true);
    expect(provabilityQuestion("cited").endsWith("proof level [cited]: ")).toBe(true);
  });

  test("blank takes the default; a rung in any case is that rung; anything else is no answer", () => {
    expect(parseProvabilityAnswer("", "off")).toBe("off");
    expect(parseProvabilityAnswer("  ", "cited")).toBe("cited");
    expect(parseProvabilityAnswer("GROUNDED", "off")).toBe("grounded");
    expect(parseProvabilityAnswer("yes", "off")).toBeUndefined();
  });

  test("a wrong answer is asked again; end of input (a blank) settles on the default", async () => {
    const answers = ["prove it", "checked"];
    const prompts: string[] = [];
    const ask = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return answers.shift() ?? "";
    };
    expect(await askProvability(ask, "off")).toBe("checked");
    expect(prompts[0]).toBe(provabilityQuestion("off"));
    expect(prompts[1]).toContain("not a proof level");
    expect(await askProvability(async () => "", "cited")).toBe("cited");
  });

  test("off is no block on cli (absent is off), but a written block on research", () => {
    expect(provabilityAnswer("cli", "off")).toBeUndefined();
    expect(provabilityAnswer("cli", "grounded")).toBe("grounded");
    expect(provabilityAnswer("research", "off")).toBe("off");
  });

  test("the interviewer is told to ask it, with the same one-line rungs and research's default", () => {
    const prompt = buildInterviewSystemPrompt();
    expect(prompt).toContain("ask how much");
    for (const { level, line } of PROVABILITY_LEVEL_LINES) {
      expect(prompt).toContain(`  - ${level}: ${line}`);
    }
    expect(prompt).toContain("A research target defaults to `provability: cited`.");
  });

  test("with --provability, the interviewer is told the answer and not to ask", () => {
    const prompt = buildInterviewSystemPrompt({ provability: "grounded" });
    // The question itself is gone (its rung list with it).
    expect(prompt).not.toContain("Proof (ONE question");
    expect(prompt).not.toContain("  - proven: ");
    expect(prompt).toContain("Do NOT ask how much proof answers should carry.");
    expect(prompt).toContain(
      "Proof: the user already chose `grounded` (the cited source was read this session and holds the claim) with --provability.",
    );
    expect(prompt).toContain("write `provability: grounded` at the top level");
    const off = buildInterviewSystemPrompt({ provability: "off" });
    expect(off).toContain("Write no `provability:` key (absent is off).");
    expect(off).not.toContain("Proof (ONE question");
    // Everything before the proof paragraph is the same prompt.
    const head = (p: string): string => p.slice(0, p.indexOf("\nProof"));
    expect(head(prompt)).toBe(head(buildInterviewSystemPrompt()));
  });
});

describe("scaffolds with a proof floor — every one validated and compiled", () => {
  test("the researcher template ships with provability: cited, and compiles without a warning", () => {
    expect(RESEARCH_DEFAULT_PROVABILITY).toBe("cited");
    const { yaml, spec } = buildScriptedSpec({
      name: "res",
      shape: "research",
      model: "claude-opus-4-7",
      instructions: "investigate",
      goal: "find the best framework",
    });
    expect(yaml).toContain("\nprovability: cited");
    expect((spec as { provability?: unknown }).provability).toBe("cited");
    expect(loweredProvability(yaml)?.level).toBe("cited");
    // Research's report gate takes note by default — no degraded-on_fail warning.
    expect(compile(yaml).warnings ?? []).toEqual([]);
  });

  test("research answered off says so in the spec (the template's default needs turning off)", () => {
    const { yaml } = buildScriptedSpec({
      name: "res",
      shape: "research",
      model: "claude-opus-4-7",
      instructions: "investigate",
      provability: "off",
    });
    expect(yaml).toContain("\nprovability: off");
    expect(loweredProvability(yaml)).toBeUndefined();
  });

  test("a cli scaffold with a floor carries the commented block and lowers to that floor", () => {
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      const { yaml } = buildScriptedSpec({
        name: "agent",
        shape: "cli",
        model: "claude-opus-4-7",
        instructions: "hi",
        provability: level,
      });
      expect(yaml).toContain(renderProvabilityBlock(level).trimEnd());
      expect(loweredProvability(yaml)?.level).toBe(level);
    }
  });

  test("a cli scaffold without a floor is the pre-0.8.0 spec, byte for byte", () => {
    const answers = { name: "agent", shape: "cli" as const, model: "m", instructions: "hi" };
    expect(buildScriptedSpec(answers).yaml).not.toContain("provability");
    expect(buildScriptedSpec({ ...answers, tools: ["read"] }).yaml).toBe(
      "name: agent\ntarget: cli\nagent:\n  model: m\n  instructions: |\n    hi\ntools:\n  - read",
    );
  });

  test("the block says what the knob is and what the chosen rung asks", () => {
    expect(renderProvabilityBlock("grounded")).toBe(
      "# The proof gate: off | cited | grounded | checked | proven.\n" +
        "# grounded — the cited source was read this session and holds the claim.\n" +
        "provability: grounded\n",
    );
  });

  test("a workflow cannot take a floor, and says why plainly", () => {
    expect(() =>
      buildScriptedSpec({
        name: "flow",
        shape: "workflow",
        model: "m",
        instructions: "do it",
        provability: "cited",
      }),
    ).toThrow("a workflow spec does not carry provability:");
  });

  test("the hybrid scaffold takes a floor too, and still compiles with no model-plan warning", () => {
    const { yaml } = buildHybridSpec({
      name: "support",
      shape: "cli",
      model: "claude-haiku-4-5",
      instructions: "Answer support questions.",
      pair: { fast: "claude-haiku-4-5", strong: "claude-opus-5" },
      provability: "grounded",
    });
    expect(loweredProvability(yaml)?.level).toBe("grounded");
    expect((compile(yaml).warnings ?? []).filter((w) => w.code.startsWith("model-plan"))).toEqual(
      [],
    );
  });
});

describe("every scripted template compiles, at every floor its shape carries", () => {
  test("cli, workflow and research × off and each rung (where carried)", () => {
    for (const shape of SCRIPTED_SHAPES) {
      const floors = carriesProvability(shape) ? INIT_PROVABILITY_LEVELS : [undefined];
      for (const level of floors) {
        const answer = level !== undefined ? provabilityAnswer(shape, level) : undefined;
        const { yaml } = buildScriptedSpec({
          name: `t-${shape}`,
          shape,
          model: "claude-opus-4-7",
          instructions: "do the work",
          ...(answer !== undefined ? { provability: answer } : {}),
        });
        expect(() => compile(yaml)).not.toThrow();
        // `off` lowers to no block, like an absent one (the workflow row).
        expect(loweredProvability(yaml)?.level).toBe(level === "off" ? undefined : level);
      }
    }
  });
});

describe("setProvability — the flag over the interview's spec", () => {
  const INTERVIEWED =
    "# from the interview\nname: x\ntarget: cli\nagent:\n  model: m\n  instructions: hi # keep me\nprovability: cited\n";

  test("replaces the rung and nothing else — the text around it is untouched", () => {
    const { yaml, spec } = setProvability(INTERVIEWED, "proven");
    expect(yaml).toBe(INTERVIEWED.replace("provability: cited", "provability: proven"));
    expect((spec as { provability?: unknown }).provability).toBe("proven");
  });

  test("adds it when the interview wrote none; off then writes nothing", () => {
    const bare = "name: x\ntarget: research\nagent:\n  model: m\n  instructions: hi\ngoal: g\n";
    expect(setProvability(bare, "grounded").yaml).toBe(`${bare}provability: grounded\n`);
    expect(setProvability(bare.trimEnd(), "cited").yaml).toBe(`${bare}provability: cited\n`);
    expect(setProvability(bare, "off").yaml).toBe(bare);
  });

  test("off over the shorthand writes off — absent and off lower the same, and the choice shows", () => {
    const { yaml } = setProvability(INTERVIEWED, "off");
    expect(yaml).toBe(INTERVIEWED.replace("provability: cited", "provability: off"));
    expect((lower(parseSpec(yaml)) as { provability?: unknown }).provability).toBeUndefined();
  });

  // The interview's object form carries settings the user asked for — a host
  // allowlist is security config. The flag sets the floor; it never drops them.
  const OBJECT_FORM = [
    "name: x",
    "target: cli",
    "agent:",
    "  model: m",
    "  instructions: hi",
    "tools: [read, webFetch]",
    "provability:",
    '  level: "cited" # the interview\'s pick',
    "  sources:",
    '    allow: ["*.gov"]',
    "  max_assumptions: 1",
    "",
  ].join("\n");

  test("the object form keeps every sub-key; only its level changes", () => {
    const { yaml, spec } = setProvability(OBJECT_FORM, "grounded");
    expect(yaml).toBe(OBJECT_FORM.replace('level: "cited"', "level: grounded"));
    expect((spec as { provability?: unknown }).provability).toEqual({
      level: "grounded",
      sources: { allow: ["*.gov"] },
      max_assumptions: 1,
    });
    // Flow style and comments survive (a re-serialized document pads `[ … ]`).
    expect(yaml).toContain("tools: [read, webFetch]\n");
    expect(yaml).toContain("# the interview's pick");
    const lowered = (lower(parseSpec(yaml)) as { provability?: { sources: { allow: string[] } } })
      .provability;
    expect(lowered?.sources.allow).toEqual(["*.gov"]);
  });

  test("off over the object form writes level: off — inert, the settings kept", () => {
    const { yaml, spec } = setProvability(OBJECT_FORM, "off");
    expect(yaml).toBe(OBJECT_FORM.replace('level: "cited"', "level: off"));
    expect((spec as { provability?: { level?: string } }).provability?.level).toBe("off");
    expect((lower(parseSpec(yaml)) as { provability?: unknown }).provability).toBeUndefined();
  });

  test("a flow-mapping block gets its level set in place", () => {
    const yaml =
      "name: x\ntarget: cli\nagent: { model: m, instructions: hi }\nprovability: { level: cited, max_assumptions: 2 }\n";
    expect(setProvability(yaml, "checked").yaml).toBe(
      yaml.replace("level: cited", "level: checked"),
    );
  });

  test("no block after a `...` end marker, or in a flow mapping: a document edit, never invalid YAML", () => {
    // An appended line would start a second document after `...`, and is not
    // YAML at all after a top-level flow mapping. Both are valid interview
    // output, so the rung is set by editing the document instead.
    const ended =
      "---\nname: x\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\n...\n";
    const flow = "{name: x, target: cli, agent: {model: claude-sonnet-4-6, instructions: hi}}";
    for (const yaml of [ended, flow, `${flow}\n`]) {
      const out = setProvability(yaml, "grounded");
      expect((out.spec as { provability?: unknown }).provability).toBe("grounded");
      // Everything else the interview wrote stands.
      const { provability: _p, ...rest } = parseSpec(out.yaml) as Record<string, unknown>;
      expect(rest).toEqual(parseSpec(yaml) as Record<string, unknown>);
      expect(
        (lower(parseSpec(out.yaml)) as { provability?: { level: string } }).provability?.level,
      ).toBe("grounded");
    }
    // off still writes nothing.
    expect(setProvability(ended, "off").yaml).toBe(ended);
    // A trailing comment is no obstacle: the plain append, text untouched.
    const commented = "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n# the end\n";
    expect(setProvability(commented, "cited").yaml).toBe(`${commented}provability: cited\n`);
  });

  test("refuses a target that cannot carry the block", () => {
    const flow = "name: f\ntarget: workflow\nmodel: m\nsteps:\n  - name: s\n    instructions: go\n";
    expect(() => setProvability(flow, "cited")).toThrow(InitProvabilityError);
    expect(() => setProvability(flow, "cited")).toThrow(
      "a workflow spec does not carry provability:",
    );
  });

  test("crew accepts the key without gating on it, and the refusal says exactly that", () => {
    expect(provabilityShapeRefusal("crew")).toBe(
      "a crew spec accepts provability: but does not gate on it yet (crewhaus compile warns accepted-but-unwired) — the proof gate runs on cli, channel, managed and research harnesses",
    );
    expect(provabilityShapeRefusal("graph")).toStartWith(
      "a graph spec does not carry provability:",
    );
  });
});

describe("provabilityScaffoldNotes — what the rung still needs, in lint's words", () => {
  const cli = (provability: "cited" | "grounded" | "checked", tools?: string[]) =>
    buildScriptedSpec({
      name: "agent",
      shape: "cli",
      model: "m",
      instructions: "hi",
      provability,
      ...(tools !== undefined ? { tools } : {}),
    }).spec;

  test("grounded with nothing to read a source names the missing tool", () => {
    const [note, ...rest] = provabilityScaffoldNotes(cli("grounded"));
    expect(rest).toEqual([]);
    expect(note).toContain("Add a source-reading tool");
  });

  test("grounded with a reading tool, and cited, need nothing more", () => {
    expect(provabilityScaffoldNotes(cli("grounded", ["read"]))).toEqual([]);
    expect(provabilityScaffoldNotes(cli("cited"))).toEqual([]);
  });

  test("checked with no allowlisted tool says so", () => {
    expect(provabilityScaffoldNotes(cli("checked")).join("\n")).toContain(
      "provability.level: checked needs claims bound to tool:<toolUseId> results",
    );
    expect(provabilityScaffoldNotes(cli("checked", ["evaluate"]))).toEqual([]);
  });

  test("a spec that does not lower gets one advisory note — never a throw", () => {
    // parseSpec accepts the token; lower refuses it. init writes the spec
    // first, so the notes must not turn a written spec into a failed init.
    const spec = cli("grounded", ["all-nonsense"]);
    expect(() => lower(spec)).toThrow();
    const notes = provabilityScaffoldNotes(spec);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("could not check what this proof level needs");
    expect(notes[0]).toContain("all-nonsense");
    expect(notes[0]).toContain("run `crewhaus lint`");
  });

  test("YAML text: parsed inside the guard, so a spec that does not parse is a note too", () => {
    // The plain scaffold is written unvalidated: `init ./bot` writes
    // `name: ./bot`, which parseSpec refuses. The notes run after the write,
    // so that must not turn a written spec into a crashed init.
    const yaml =
      "name: ./bot\ntarget: cli\nagent:\n  model: m\n  instructions: hi\nprovability: cited\n";
    expect(() => parseSpec(yaml)).toThrow();
    const notes = provabilityScaffoldNotes(yaml);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("could not check what this proof level needs");
    expect(notes[0]).toContain("name may contain only");
    expect(notes[0]).toContain("run `crewhaus lint`");
    // Text that parses reads exactly as its parsed spec does.
    const grounded = buildScriptedSpec({
      name: "agent",
      shape: "cli",
      model: "m",
      instructions: "hi",
      provability: "grounded",
    });
    expect(provabilityScaffoldNotes(grounded.yaml)).toEqual(
      provabilityScaffoldNotes(grounded.spec),
    );
    expect(provabilityScaffoldNotes(grounded.yaml)).toHaveLength(1);
  });
});

describe("provabilityScaffoldTools — a scaffold never declares a floor its tools cannot meet", () => {
  test("grounded reads a source, checked has an allowlisted tool, cited and proven need none", () => {
    expect(provabilityScaffoldTools("grounded")).toEqual(["read", "webFetch"]);
    expect(provabilityScaffoldTools("checked")).toEqual(["evaluate"]);
    for (const level of ["off", "cited", "proven"] as const) {
      expect(provabilityScaffoldTools(level)).toEqual([]);
      expect(renderProvabilityToolsBlock(level)).toBe("");
    }
  });

  test("with its tools, every rung's scaffold lints clean and compiles", () => {
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      const yaml = `name: agent\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n\n${renderProvabilityToolsBlock(level)}${renderProvabilityBlock(level)}`;
      const ir = lower(parseSpec(yaml));
      expect([level, auditProvability(ir).map((f) => f.rule)]).toEqual([level, []]);
      expect(() => compile(yaml)).not.toThrow();
    }
    // Without them, the two rungs that need a tool are exactly lint's findings.
    const bare = (level: string): string[] =>
      auditProvability(
        lower(
          parseSpec(
            `name: a\ntarget: cli\nagent:\n  model: m\n  instructions: hi\nprovability: ${level}\n`,
          ),
        ),
      ).map((f) => f.rule);
    expect(bare("grounded")).toEqual(["provability-no-source-tool"]);
    expect(bare("checked")).toEqual(["provability-no-execution-tool"]);
  });

  test("the hybrid scaffold with a floor's tools lints clean too", () => {
    for (const level of ["grounded", "checked"] as const) {
      const { yaml } = buildHybridSpec({
        name: "support",
        shape: "cli",
        model: "claude-haiku-4-5",
        instructions: "Answer support questions.",
        pair: { fast: "claude-haiku-4-5", strong: "claude-opus-5" },
        provability: level,
        tools: provabilityScaffoldTools(level),
      });
      expect(auditProvability(lower(parseSpec(yaml)))).toEqual([]);
    }
  });
});
