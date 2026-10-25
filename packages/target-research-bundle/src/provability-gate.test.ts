/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.4, §8) — the research
 * shape's provability report gate.
 *
 * Two layers. The emitted TEXT: what the daemon imports, the branch
 * guidance, the numbered `CiteFact`, the gated report block, `halt`'s
 * classified stop, the HEAD resolver only under `sources.resolve: head`, and
 * the pre-0.8.0 bytes when the block is absent. And the emitted daemon RUN:
 * booted against a loopback fake of the Messages API that plans one
 * sub-question, loads a workspace source with `Source`, records a fact with
 * `CiteFact`, reads the citation number `CiteFact` told it, and answers with
 * that marker — so the whole loop the gate depends on (guidance in the
 * system prompt, the number at `CiteFact` time, the definitions the report
 * renders, the tracker's cache as evidence, the section, the JSON, the
 * bundle file, the trace line, the exit code) is exercised end to end, at a
 * passing `note` and a failing `halt`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IrResearchV0 } from "@crewhaus/ir";
import { emitResearchBundle } from "./index.js";

const PROVABILITY: NonNullable<IrResearchV0["provability"]> = {
  level: "grounded",
  onFail: "note",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["evaluate"], replay: true, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: ["sorry"], timeoutMs: 30_000 },
};

const baseIr: IrResearchV0 = {
  version: 0,
  name: "gated-research",
  target: "research",
  agent: { model: "claude-sonnet-4-6", instructions: "Research one sub-question at a time." },
  goal: "How do Acme refunds work?",
  branchingFactor: 1,
  maxDurationMs: 120_000,
  retrieve: { allowedOrigins: [], allowedFileRoots: ["sources"] },
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

const agentOf = (ir: IrResearchV0): string => emitResearchBundle(ir).files[0]?.content ?? "";

describe("emitResearchBundle — the provability report gate (emitted text)", () => {
  const code = agentOf({ ...baseIr, provability: PROVABILITY });

  test("imports the gate from report-writer and the classified stop from errors", () => {
    expect(code).toContain(
      'import { RunFailedError, formatRunFailure, toFailureReport } from "@crewhaus/errors";',
    );
    expect(code).toContain(`import type { BranchAnswer } from "@crewhaus/report-writer";
import {
  evidenceFromTracker,
  provabilityFailureReport,
  researchProvabilityGuidance,
  withCitationNumbers,
  writeProvableReport,
  type ReportProvabilityConfig,
} from "@crewhaus/report-writer/provability";`);
    expect(code).not.toContain("import { writeReport");
    // No HEAD resolver unless sources.resolve asks for one.
    expect(code).not.toContain("@crewhaus/evaluation-service");
  });

  test("the lowered block rides as a constant; each branch gets the guidance and the numbered CiteFact", () => {
    expect(code).toContain(
      `const PROVABILITY: ReportProvabilityConfig = ${JSON.stringify(PROVABILITY)};`,
    );
    expect(code).toContain(
      "const BRANCH_INSTRUCTIONS = `${SPEC_INSTRUCTIONS}\\n\\n${researchProvabilityGuidance(PROVABILITY)}`;",
    );
    expect(code).toContain("    instructions: BRANCH_INSTRUCTIONS,");
    expect(code).toContain(`  const citeFactTool = withCitationNumbers(
    createCiteFactTool({
      tracker: args.tracker,
      currentBranchId: () => currentBranch,
    }),
    args.tracker,
  );`);
  });

  test("the report is written gated, beside its bundle, with a trace line; halt stops after writing", () => {
    expect(code).toContain("  const report = await writeProvableReport({");
    // The crawler's resolved file roots are the gate's, and the evidence is
    // built inside the gate's fail-open guard (a function, not a value).
    expect(code).toContain(
      "  const __gateRoots = { workspaceRoot: process.cwd(), fileRoots: allowedFileRootsAbs };",
    );
    expect(code).toContain("      evidence: () => evidenceFromTracker(tracker, __gateRoots),");
    expect(code).toContain("      ...__gateRoots,");
    expect(code.indexOf("const allowedFileRootsAbs")).toBeLessThan(code.indexOf("__gateRoots"));
    expect(code).toContain('  const proofPath = join(reportDir, "proof.json");');
    expect(code).toContain('  emit({ kind: "provability_graded", ...report.summary, proofPath });');
    const halt = code.indexOf('PROVABILITY.onFail === "halt"');
    expect(halt).toBeGreaterThan(code.indexOf('join(reportDir, "report.md")'));
    expect(halt).toBeLessThan(code.indexOf('emit({ kind: "run_done"'));
    expect(code).toContain(
      "    throw new RunFailedError(provabilityFailureReport(report.proof, proofPath));",
    );
  });

  test("sources.resolve: head wires the guarded HEAD the in-loop gate uses, each request recorded", () => {
    const head = agentOf({
      ...baseIr,
      provability: { ...PROVABILITY, sources: { ...PROVABILITY.sources, resolve: "head" } },
    });
    expect(head).toContain('import { createHeadResolver } from "@crewhaus/evaluation-service";');
    expect(head).toContain("const __resolveHead = createHeadResolver(PROVABILITY.sources);");
    // Every HEAD the guard decides is an egress_decision on the run's event stream.
    expect(head).toContain(`      resolveHead: (url) =>
        __resolveHead(url, {
          record: (decision) => emit({ kind: "egress_decision", ...decision }),
          screen: __screenHead,
        }),`);
    // Pillar 3 — each HEAD is screened against every branch's lineage (a
    // dynamic sink), with no exemption for a URL that merely appears in a
    // tool result; only a URL this run's crawler already requested passes.
    expect(head).toContain('import { lineageEgressScreen } from "@crewhaus/runtime-core";');
    expect(head).toContain(`const __screenHead = lineageEgressScreen({
  contexts: () => __branchContexts,
  sent: (url) => __fetchedUrls.has(url),
});`);
    expect(head).toContain(`  const runContext = createRunContext();
  __branchContexts.push(runContext);`);
    expect(head).toContain(
      "tracker.listFetches().flatMap((f) => [f.url, normalizeUrl(f.url) ?? f.url]),",
    );
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(head)).not.toThrow();
    expect(head).not.toContain("createWaiverJudge");
    // Without resolve: head, none of it.
    const off = agentOf({ ...baseIr, provability: PROVABILITY });
    for (const marker of ["lineageEgressScreen", "__branchContexts", "__screenHead"]) {
      expect(off).not.toContain(marker);
    }
  });

  test("provability.judge wires the paraphrase-waiver judge into the report gate, metered on its own run bus", () => {
    const judge = { model: "claude-haiku-4-5", allowSelfJudge: true as const };
    const judged = agentOf({ ...baseIr, provability: { ...PROVABILITY, judge } });
    expect(judged).toContain('import { createWaiverJudge } from "@crewhaus/evaluation-service";');
    // Its calls publish as role judge on the report gate's own run bus.
    expect(judged).toContain("const __judgeRun = createRunContext();");
    expect(judged).toContain(
      `const __waiverJudge = createWaiverJudge({ judge: ${JSON.stringify(judge)}, bus: __judgeRun.eventBus });`,
    );
    expect(judged).toContain("      judgeWaiver: __waiverJudge,");
    // No budget: nothing caps it, as in the loop.
    expect(judged).not.toContain("exhausted:");
    expect(judged).not.toContain("@crewhaus/cost-tracker");
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(judged)).not.toThrow();
    // Both at once: one import line.
    const both = agentOf({
      ...baseIr,
      provability: {
        ...PROVABILITY,
        judge,
        sources: { ...PROVABILITY.sources, resolve: "head" },
      },
    });
    expect(both).toContain(
      'import { createHeadResolver, createWaiverJudge } from "@crewhaus/evaluation-service";',
    );
    // Without one, nothing of it.
    expect(code).not.toContain("judgeWaiver");
    expect(code).not.toContain("__judgeRun");
  });

  test("under budget:, the waiver judge stops at budget.judge_share of budget.usd (design §6.2)", () => {
    const judge = { model: "claude-haiku-4-5" };
    const budget = { usdMicros: 2_000_000, onExceed: { kind: "stop" as const } };
    const capped = agentOf({ ...baseIr, budget, provability: { ...PROVABILITY, judge } });
    expect(
      capped,
    ).toContain(`import { createCostTracker, sumRoleCost } from "@crewhaus/cost-tracker";
import { DEFAULT_JUDGE_SHARE } from "@crewhaus/runtime-core";
import { AUXILIARY_MODEL_ROLES } from "@crewhaus/trace-event-bus";
`);
    expect(capped).toContain(
      "const __judgeMeter = createCostTracker(__judgeRun.eventBus, { suppressEvents: true });",
    );
    expect(capped).toContain(
      "const __judgeShareMicros = Math.round(2000000 * DEFAULT_JUDGE_SHARE);",
    );
    expect(capped).toContain(`const __waiverJudge = createWaiverJudge({
  judge: ${JSON.stringify(judge)},
  bus: __judgeRun.eventBus,
  exhausted: __judgeShareExhausted,
});`);
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(capped)).not.toThrow();
    // A declared share is used as written, and the default is not imported.
    const shared = agentOf({
      ...baseIr,
      budget: { ...budget, judgeShare: 0.1 },
      provability: { ...PROVABILITY, judge },
    });
    expect(shared).toContain("const __judgeShareMicros = Math.round(2000000 * 0.1);");
    expect(shared).not.toContain("DEFAULT_JUDGE_SHARE");
    // A budget without a judge adds nothing.
    expect(agentOf({ ...baseIr, budget, provability: PROVABILITY })).not.toContain(
      "@crewhaus/cost-tracker",
    );
  });

  test("a checked / proven floor is warned about at start; cited / grounded are not", () => {
    for (const level of ["checked", "proven"] as const) {
      for (const onFail of ["note", "halt"] as const) {
        const warned = agentOf({ ...baseIr, provability: { ...PROVABILITY, level, onFail } });
        expect(warned).toContain(
          `"[research] WARNING: provability.level is ${level}, and no claim of a research report can meet it in this release`,
        );
        expect(warned.includes("on_fail: halt will stop the run with exit 37")).toBe(
          onFail === "halt",
        );
        expect(warned.indexOf("WARNING: provability.level")).toBeLessThan(
          warned.indexOf("async function main()"),
        );
      }
    }
    expect(code).not.toContain("WARNING: provability.level");
    expect(agentOf({ ...baseIr, provability: { ...PROVABILITY, level: "cited" } })).not.toContain(
      "WARNING: provability.level",
    );
  });

  test("Bun.Transpiler parses the gated agent.ts", () => {
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(code)).not.toThrow();
  });

  test("no provability: block → the pre-0.8.0 text at every place the gate writes (byte-identity guard)", () => {
    const plain = agentOf(baseIr);
    // Each region is the 0.7.x emitter's output for this IR, copied from it
    // (c0fe9529): an edit that changes the ungated text at any of the gate's
    // insertion points fails here, not in a user's diff.
    for (const region of [
      `import { formatRunFailure, toFailureReport } from "@crewhaus/errors";
import { decompose, type Plan } from "@crewhaus/planner";
import { writeReport, type BranchAnswer } from "@crewhaus/report-writer";
import { runChatLoop } from "@crewhaus/runtime-core";`,
      `const SPEC_INSTRUCTIONS = "Research one sub-question at a time.";
const ALLOWED_ORIGINS`,
      `  const citeFactTool = createCiteFactTool({
    tracker: args.tracker,
    currentBranchId: () => currentBranch,
  });
  const tools = [sourceTool, citeFactTool, ...defaultCatalog.list()];`,
      `  saveState(state);

  const report = writeReport({
    goal,
    branches: state.completedBranches,
    citations: tracker.listCitationsOrdered(),
  });
  const reportDir = join(RESEARCH_ROOT, runId);
  writeFileSync(join(reportDir, "report.md"), report.markdown, { mode: 0o600 });
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report.json, null, 2), { mode: 0o600 });
  // A research run that cited nothing is not a success worth reporting
  // silently: the report still ships (with its "no citations" notice), but the
  // operator gets told on stderr, where a scripted caller will actually see it.
  if (report.json.citations.length === 0) {
    process.stderr.write(
      "[research] WARNING: no citations were recorded — the report is not anchored to any fetched source.\\n",
    );
  }
  emit({ kind: "run_done"`,
    ]) {
      expect(plain).toContain(region);
    }
    for (const marker of [
      "PROVABILITY",
      "BRANCH_INSTRUCTIONS",
      "writeProvableReport",
      "withCitationNumbers",
      "proof.json",
      "import { RunFailedError",
    ]) {
      expect(plain).not.toContain(marker);
    }
    expect(plain).toContain(
      'import { writeReport, type BranchAnswer } from "@crewhaus/report-writer";',
    );
    expect(plain).toContain("    instructions: SPEC_INSTRUCTIONS,");
  });
});

// ---------------------------------------------------------------------------
// The emitted daemon, run.
// ---------------------------------------------------------------------------

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));
const RUN_TIMEOUT_MS = 120_000;
const POLICY_BODY =
  "Acme refund policy.\n\nRefunds are accepted within 14 days of purchase.\nStore credit never expires.\n";
const SNIPPET = "Refunds are accepted within 14 days of purchase.";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type ToolUse = { readonly id: string; readonly name: string; readonly input: unknown };

/** One streamed assistant message (text or one tool call), in the Messages API's SSE framing. */
function sse(block: ToolUse | string): string {
  const content =
    typeof block === "string"
      ? [
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block } },
          ],
        ]
      : [
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            },
          ],
        ];
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    ...(content as Array<[string, unknown]>),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: typeof block === "string" ? "end_turn" : "tool_use",
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

type Body = {
  readonly system?: Array<{ text?: string }> | string;
  readonly messages?: Array<{ role: string; content: unknown }>;
  readonly tools?: Array<{ name?: string }>;
  readonly stream?: boolean;
};

const systemText = (body: Body): string =>
  typeof body.system === "string"
    ? body.system
    : (body.system ?? []).map((b) => b.text ?? "").join("\n");

/** Every tool_result text in the request, in order. */
function toolResults(body: Body): string[] {
  const out: string[] = [];
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; content?: unknown }>) {
      if (b.type !== "tool_result") continue;
      out.push(
        typeof b.content === "string"
          ? b.content
          : (b.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(""),
      );
    }
  }
  return out;
}

type ModelOptions = {
  /** Mark the answer with the number CiteFact told the branch (else no marker at all). */
  readonly cite: boolean;
  /** The answer's sentence, before its marker (default: the snippet, word for word). */
  readonly sentence?: string;
  /** Several sentences, each marked with the number CiteFact told it (overrides `sentence`). */
  readonly sentences?: ReadonlyArray<string>;
  /** How the waiver judge answers a `submit_label` call. */
  readonly judge?: "supported" | "not_supported";
};

/** One assistant message (one block) as a non-streamed Messages API response. */
function json(block: ToolUse): Response {
  return Response.json({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [{ type: "tool_use", id: block.id, name: block.name, input: block.input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

/**
 * The fake model. The planner asks for one sub-question; a branch loads the
 * one source, records the snippet, and answers with the number CiteFact told
 * it — or, when `cite` is false, without a marker at all. A waiver-judge
 * call (`submit_label`) gets the label `judge` names, and is counted.
 */
function startModel(opts: ModelOptions): {
  readonly port: number;
  readonly systems: string[];
  readonly judgeCalls: () => number;
} {
  const systems: string[] = [];
  let judgeCalls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages"))
        return new Response("", { status: 404 });
      const body = (await req.json()) as Body;
      const headers = { "content-type": "text/event-stream" };
      if ((body.tools ?? []).some((t) => t.name === "submit_label")) {
        judgeCalls += 1;
        const label: ToolUse = {
          id: "toolu_judge",
          name: "submit_label",
          input: { label: opts.judge ?? "not_supported", rationale: "fake judge" },
        };
        return body.stream === true ? new Response(sse(label), { headers }) : json(label);
      }
      const system = systemText(body);
      // The planner's request names the branching factor (planner `userPrompt`).
      if (JSON.stringify(body.messages ?? []).includes("Branching factor:")) {
        return new Response(
          sse('```json\n{"subQuestions": ["How long is the Acme refund window?"]}\n```'),
          { headers },
        );
      }
      systems.push(system);
      const results = toolResults(body);
      const seed = JSON.stringify(body.messages?.[0]?.content ?? "");
      const uri = /file:\/\/[^\s"\\]+/.exec(seed)?.[0] ?? "";
      if (results.length === 0) {
        return new Response(sse({ id: "toolu_src", name: "Source", input: { uri } }), { headers });
      }
      if (results.length === 1) {
        return new Response(
          sse({ id: "toolu_cite", name: "CiteFact", input: { uri, snippet: SNIPPET } }),
          { headers },
        );
      }
      const told = /Cite it as \[(\d+)\]/.exec(results[1] ?? "")?.[1];
      const sentences = opts.sentences ?? [
        opts.sentence ?? "Refunds are accepted within 14 days of purchase",
      ];
      const answer = sentences
        .map((sentence) => (opts.cite ? `${sentence} [${told ?? "?"}].` : `${sentence}.`))
        .join(" ");
      return new Response(sse(answer), { headers });
    },
  });
  servers.push(server);
  return { port: server.port as number, systems, judgeCalls: () => judgeCalls };
}

type RunOutcome = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly runDir: string;
  readonly systems: string[];
  readonly judgeCalls: number;
  /** Where the policy file lives: `sources/` in the harness, or a corpus outside it. */
  readonly corpus: string;
};

async function runDaemon(
  spec: IrResearchV0,
  model: ModelOptions & {
    /** Put the source in a directory OUTSIDE the harness, admitted by `retrieve.allowedFileRoots`. */
    readonly outside?: boolean;
  },
): Promise<RunOutcome> {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-research-gate-"));
  dirs.push(root);
  let corpus = join(root, "sources");
  let ir = spec;
  if (model.outside === true) {
    corpus = mkdtempSync(join(tmpdir(), "crewhaus-research-corpus-"));
    dirs.push(corpus);
    ir = { ...spec, retrieve: { ...spec.retrieve, allowedFileRoots: [corpus] } };
  }
  mkdirSync(corpus, { recursive: true });
  writeFileSync(join(corpus, "policy.md"), POLICY_BODY);
  writeFileSync(join(root, "agent.ts"), agentOf(ir));
  const scope = join(root, "node_modules", "@crewhaus");
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(join(REPO_ROOT, "packages"))) {
    try {
      symlinkSync(join(REPO_ROOT, "packages", name), join(scope, name), "dir");
    } catch {
      // Already linked.
    }
  }
  const fake = startModel(model);
  const proc = Bun.spawn({
    cmd: [process.execPath, join(root, "agent.ts")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      ANTHROPIC_API_KEY: ["sk", "ant", "e2e", "0".repeat(12)].join("-"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
      CREWHAUS_SESSION_DIR: join(root, "sessions"),
      CREWHAUS_NO_REGISTRY: "1",
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const runId = /"kind":"run_start","runId":"(run_[0-9a-f]{16})"/.exec(stdout)?.[1];
  if (runId === undefined) throw new Error(`no run_start; stderr:\n${stderr}\nstdout:\n${stdout}`);
  return {
    code,
    stdout,
    stderr,
    runDir: join(root, ".crewhaus", "research", runId),
    systems: fake.systems,
    judgeCalls: fake.judgeCalls(),
    corpus,
  };
}

const events = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the emitted research daemon, run under provability:", () => {
  test(
    "note, cited from the CiteFact number: the report passes grounded and is served with its section",
    async () => {
      const run = await runDaemon({ ...baseIr, provability: PROVABILITY }, { cite: true });
      expect(run.code).toBe(0);
      // The guidance reached every branch's system prompt.
      expect(run.systems.length).toBeGreaterThan(0);
      for (const system of run.systems) {
        expect(system).toContain(
          "Provability: this run's report is checked at the `grounded` floor",
        );
      }
      const md = readFileSync(join(run.runDir, "report.md"), "utf8");
      expect(md).toContain("Refunds are accepted within 14 days of purchase [1].");
      expect(md).toContain(`[1]: ./sources/policy.md "${SNIPPET}"`);
      expect(md).toContain("## Provability");
      expect(md).toContain("pass ✓");
      expect(md.indexOf("## Provability")).toBeGreaterThan(md.indexOf("## Citations"));
      const json = JSON.parse(readFileSync(join(run.runDir, "report.json"), "utf8")) as {
        proof?: {
          verdict: string;
          bundleHash: string;
          claims: Array<{ bindings: Array<{ origin?: string }> }>;
        };
      };
      expect(json.proof?.verdict).toBe("pass");
      expect(json.proof?.claims[0]?.bindings[0]?.origin).toBe("sources/policy.md");
      const proof = JSON.parse(readFileSync(join(run.runDir, "proof.json"), "utf8")) as {
        bundleHash: string;
      };
      expect(proof.bundleHash).toBe(json.proof?.bundleHash as string);
      const evs = events(run.stdout);
      const graded = evs.find((e) => e["kind"] === "provability_graded");
      expect(graded).toMatchObject({ level: "grounded", verdict: "pass", claims: 1, met: 1 });
      // Relative to the harness root, beside the run's report.
      expect(graded?.["proofPath"]).toBe(
        join(".crewhaus", "research", run.runDir.split("/").pop() as string, "proof.json"),
      );
      expect(evs.some((e) => e["kind"] === "run_done")).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "sources.resolve: head boots with the lineage screen wired; a file source sends no HEAD and passes",
    async () => {
      const run = await runDaemon(
        {
          ...baseIr,
          provability: { ...PROVABILITY, sources: { ...PROVABILITY.sources, resolve: "head" } },
        },
        { cite: true },
      );
      expect(run.code).toBe(0);
      const evs = events(run.stdout);
      expect(evs.find((e) => e["kind"] === "provability_graded")?.["verdict"]).toBe("pass");
      // A path is no URL: nothing was asked, so nothing was decided.
      expect(evs.filter((e) => e["kind"] === "egress_decision")).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "halt, answered without a marker: the report is written with its ✗ section, then the run stops with exit 37",
    async () => {
      const run = await runDaemon(
        { ...baseIr, provability: { ...PROVABILITY, onFail: "halt" } },
        { cite: false },
      );
      expect(run.code).toBe(37);
      expect(run.stderr).toContain("provability gate failed the research report");
      expect(run.stderr).toContain("no_citation");
      const evs = events(run.stdout);
      expect(evs.find((e) => e["kind"] === "provability_graded")?.["verdict"]).toBe("fail");
      expect(evs.some((e) => e["kind"] === "run_done")).toBe(false);
      const md = readFileSync(join(run.runDir, "report.md"), "utf8");
      expect(md).toContain("fail ✗");
      expect(existsSync(join(run.runDir, "proof.json"))).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "halt, the source under an allowedFileRoots dir OUTSIDE the harness: the gate admits what the crawler did, and passes",
    async () => {
      const run = await runDaemon(
        { ...baseIr, provability: { ...PROVABILITY, onFail: "halt" } },
        { cite: true, outside: true },
      );
      expect(run.stderr).not.toContain("provability gate failed");
      expect(run.code).toBe(0);
      const md = readFileSync(join(run.runDir, "report.md"), "utf8");
      expect(md).toContain(`[1]: ${join(run.corpus, "policy.md")} "${SNIPPET}"`);
      expect(md).toContain("pass ✓");
      const proof = JSON.parse(readFileSync(join(run.runDir, "proof.json"), "utf8")) as {
        verdict: string;
        claims: Array<{ bindings: Array<{ origin?: string; rung: string }> }>;
      };
      expect(proof.verdict).toBe("pass");
      expect(proof.claims[0]?.bindings[0]?.rung).toBe("grounded");
      expect(proof.claims[0]?.bindings[0]?.origin?.endsWith("/policy.md")).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "provability.judge: a paraphrase the deterministic check misses is put to the judge, and its yes passes the report",
    async () => {
      const paraphrase = "Acme accepts refund requests for 14 days after a purchase";
      const ir = {
        ...baseIr,
        provability: {
          ...PROVABILITY,
          onFail: "halt" as const,
          judge: { model: "claude-haiku-4-5" },
        },
      };
      const run = await runDaemon(ir, { cite: true, sentence: paraphrase, judge: "supported" });
      expect(run.judgeCalls).toBe(1);
      expect(run.code).toBe(0);
      const json = JSON.parse(readFileSync(join(run.runDir, "report.json"), "utf8")) as {
        proof: { verdict: string; judgeWaived: number; judgeModel?: string };
      };
      expect(json.proof.verdict).toBe("pass");
      expect(json.proof.judgeWaived).toBe(1);
      expect(json.proof.judgeModel).toBeDefined();
      const graded = events(run.stdout).find((e) => e["kind"] === "provability_graded");
      expect(graded?.["judgeModel"]).toBe(json.proof.judgeModel);
      expect(readFileSync(join(run.runDir, "report.md"), "utf8")).toContain(
        "accepted by the paraphrase-waiver judge",
      );

      // The judge's no: the same paraphrase fails, and halt stops the run.
      const refused = await runDaemon(ir, {
        cite: true,
        sentence: paraphrase,
        judge: "not_supported",
      });
      expect(refused.judgeCalls).toBe(1);
      expect(refused.code).toBe(37);
      expect(refused.stderr).toContain("not_found_in_source");
    },
    RUN_TIMEOUT_MS * 2,
  );

  test(
    "provability.judge under budget: past budget.judge_share the waiver is skipped, not called",
    async () => {
      // Two paraphrases of the snippet, each a waivable miss. The fake judge's
      // first call costs more than a share this small, so the second is skipped.
      const sentences = [
        "Acme accepts refund requests for 14 days after a purchase",
        "Acme takes refund requests for 14 days after the purchase date",
      ];
      const judge = { model: "claude-haiku-4-5" };
      const budget = { usdMicros: 1_000, onExceed: { kind: "stop" as const }, judgeShare: 0.001 };
      const uncapped = await runDaemon(
        { ...baseIr, provability: { ...PROVABILITY, judge } },
        { cite: true, sentences, judge: "supported" },
      );
      expect(uncapped.judgeCalls).toBe(2);
      const capped = await runDaemon(
        { ...baseIr, budget, provability: { ...PROVABILITY, judge } },
        { cite: true, sentences, judge: "supported" },
      );
      expect(capped.code).toBe(0);
      expect(capped.judgeCalls).toBe(1);
      expect(capped.stderr).toContain("[research] provability.judge: the waiver judge has spent");
      const proof = JSON.parse(readFileSync(join(capped.runDir, "proof.json"), "utf8")) as {
        verdict: string;
        judgeWaived: number;
        claims: Array<{ status: string }>;
      };
      // The skipped one keeps the miss the deterministic check found.
      expect(proof.judgeWaived).toBe(1);
      expect(proof.claims.map((c) => c.status)).toEqual(["met", "unmet"]);
      expect(proof.verdict).toBe("fail");
    },
    RUN_TIMEOUT_MS * 2,
  );

  test(
    "no provability: block — the pre-0.8.0 report: no section, no proof, no number from CiteFact",
    async () => {
      const run = await runDaemon(baseIr, { cite: true });
      expect(run.code).toBe(0);
      const md = readFileSync(join(run.runDir, "report.md"), "utf8");
      expect(md).not.toContain("## Provability");
      expect(md).toContain("## Citations\n\n[1] file://");
      // CiteFact said nothing about numbers, so the fake answered "[?]".
      expect(md).toContain("[?]");
      expect(existsSync(join(run.runDir, "proof.json"))).toBe(false);
      expect(
        "proof" in (JSON.parse(readFileSync(join(run.runDir, "report.json"), "utf8")) as object),
      ).toBe(false);
      for (const system of run.systems) expect(system).not.toContain("Provability:");
    },
    RUN_TIMEOUT_MS,
  );
});
