/**
 * Unit tests for the pure layer: the spec projection and its diff, the
 * permission matcher, the eval gate, the session-log arithmetic and the
 * lenient identity reader. No filesystem, no clock — every case here is a
 * value in and a value out.
 */
import { describe, expect, test } from "bun:test";
import { collectSpecModels } from "@crewhaus/preflight";
import { parseSpec } from "@crewhaus/spec";
import { DEFAULT_SCORE_EPSILON, compareEvalRuns, readEvalRun } from "./lib/eval-gate";
import { readSpecIdentity } from "./lib/identity";
import {
  auditPermissions,
  compileToolGlob,
  isExternalTool,
  patternCoverage,
  splitPattern,
  toRegisteredName,
} from "./lib/permissions";
import {
  type SessionEvent,
  filterEvents,
  parseSessionLog,
  summarizeCost,
  summarizeEvents,
} from "./lib/sessions";
import { buildSpecView, collectToolSites, diffSpecViews, redactArgs } from "./lib/spec-view";

const CLI_SPEC = [
  "name: demo",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: Be useful.",
  "tools: [read, write, bash]",
  "permissions:",
  "  mode: default",
  "  rules:",
  "    - type: alwaysAllow",
  "      pattern: Read",
  "    - type: alwaysDeny",
  "      pattern: Bash(rm *)",
  "mcp_servers:",
  "  thredz:",
  "    transport: stdio",
  "    command: bunx",
  '    args: ["thredz-mcp@0.3.0"]',
  "    env:",
  "      THREDZ_TOKEN: $THREDZ_TOKEN",
].join("\n");

function view(yaml: string) {
  const spec = parseSpec(yaml);
  return buildSpecView(spec, collectSpecModels(spec));
}

describe("spec view", () => {
  test("projects name, shape, models, tools and permissions", () => {
    const v = view(CLI_SPEC);
    expect(v.name).toBe("demo");
    expect(v.target).toBe("cli");
    expect(v.models).toEqual([{ model: "claude-sonnet-4-6", sources: ["agent.model"] }]);
    expect(v.tools).toEqual(["bash", "read", "write"]);
    expect(v.permissions.mode).toBe("default");
    expect(v.permissions.rules).toEqual([
      { type: "alwaysAllow", pattern: "Read" },
      { type: "alwaysDeny", pattern: "Bash(rm *)" },
    ]);
  });

  test("an absent permissions block still reports the schema's own defaults", () => {
    const v = view(
      ["name: bare", "target: cli", "agent:", "  model: m", "  instructions: go"].join("\n"),
    );
    expect(v.permissions).toEqual({ mode: "default", askMode: "pause", rules: [] });
  });

  test("MCP servers report env KEYS, never values", () => {
    const v = view(CLI_SPEC);
    expect(v.mcpServers).toEqual([
      {
        name: "thredz",
        transport: "stdio",
        command: "bunx",
        args: ["thredz-mcp@0.3.0"],
        required: true,
        envKeys: ["THREDZ_TOKEN"],
      },
    ]);
    expect(JSON.stringify(v.mcpServers)).not.toContain("$THREDZ_TOKEN");
  });

  test("an sse endpoint is reduced to origin and path, dropping any query", () => {
    const v = view(
      [
        "name: sse",
        "target: cli",
        "agent:",
        "  model: m",
        "  instructions: go",
        "mcp_servers:",
        "  remote:",
        "    transport: sse",
        "    url: https://peer.example.com/mcp?token=supersecret",
      ].join("\n"),
    );
    expect(v.mcpServers[0]?.endpoint).toBe("https://peer.example.com/mcp");
    expect(JSON.stringify(v.mcpServers)).not.toContain("supersecret");
  });

  test("counts the shape's containers", () => {
    const v = view(CLI_SPEC);
    expect(v.counts["mcpServers"]).toBe(1);
    expect(v.counts["permissionRules"]).toBe(2);
  });

  test("tool sites are found at every depth and sorted by path", () => {
    const sites = collectToolSites({
      tools: ["a"],
      steps: [{ name: "one", tools: ["c"] }, { name: "two" }],
      agent: { tools: ["b"] },
    });
    expect(sites).toEqual([
      { path: "<root>", tools: ["a"] },
      { path: "agent", tools: ["b"] },
      { path: "steps[0]", tools: ["c"] },
    ]);
  });

  test("a `tools` key whose value is not a string array is left alone (expose.mcp.tools)", () => {
    expect(collectToolSites({ expose: { mcp: { tools: "chat" } } })).toEqual([]);
  });
});

describe("spec diff", () => {
  const withTool = CLI_SPEC.replace(
    "tools: [read, write, bash]",
    "tools: [read, write, bash, glob]",
  );

  test("a granted tool is a change that WIDENS", () => {
    const changes = diffSpecViews(view(CLI_SPEC), view(withTool));
    expect(changes).toEqual([{ kind: "tool-added", path: "<root>", to: "glob", widens: true }]);
  });

  test("a removed tool is a change that does not widen", () => {
    const changes = diffSpecViews(view(withTool), view(CLI_SPEC));
    expect(changes[0]).toEqual({
      kind: "tool-removed",
      path: "<root>",
      from: "glob",
      widens: false,
    });
  });

  test("dropping an alwaysDeny rule widens; dropping an alwaysAllow does not", () => {
    const noDeny = CLI_SPEC.split("\n")
      .filter((l) => !l.includes("alwaysDeny") && !l.includes("Bash(rm *)"))
      .join("\n");
    const dropDeny = diffSpecViews(view(CLI_SPEC), view(noDeny));
    expect(dropDeny.some((c) => c.kind === "permission-rule-removed" && c.widens)).toBe(true);

    const noAllow = CLI_SPEC.split("\n")
      .filter((l) => !l.includes("alwaysAllow") && !l.trim().endsWith("pattern: Read"))
      .join("\n");
    const dropAllow = diffSpecViews(view(CLI_SPEC), view(noAllow));
    expect(dropAllow.some((c) => c.kind === "permission-rule-removed" && c.widens)).toBe(false);
  });

  test("default → auto widens, default → plan does not", () => {
    const auto = CLI_SPEC.replace("mode: default", "mode: auto");
    const plan = CLI_SPEC.replace("mode: default", "mode: plan");
    expect(
      diffSpecViews(view(CLI_SPEC), view(auto)).find((c) => c.kind === "permission-mode"),
    ).toEqual({
      kind: "permission-mode",
      path: "permissions.mode",
      from: "default",
      to: "auto",
      widens: true,
    });
    expect(
      diffSpecViews(view(CLI_SPEC), view(plan)).find((c) => c.kind === "permission-mode")?.widens,
    ).toBe(false);
  });

  test("a model swap is reported on its slot, and does not widen", () => {
    const swapped = CLI_SPEC.replace("claude-sonnet-4-6", "claude-opus-4-1");
    expect(diffSpecViews(view(CLI_SPEC), view(swapped))).toEqual([
      {
        kind: "model",
        path: "agent.model",
        from: "claude-sonnet-4-6",
        to: "claude-opus-4-1",
        widens: false,
      },
    ]);
  });

  test("an added MCP server widens; removing one does not", () => {
    const noServer = CLI_SPEC.split("\n")
      .slice(0, CLI_SPEC.split("\n").indexOf("mcp_servers:"))
      .join("\n");
    const added = diffSpecViews(view(noServer), view(CLI_SPEC));
    expect(added.some((c) => c.kind === "mcp-server-added" && c.widens)).toBe(true);
    const removed = diffSpecViews(view(CLI_SPEC), view(noServer));
    expect(removed.every((c) => !c.widens)).toBe(true);
  });

  test("identical specs produce no changes at all", () => {
    expect(diffSpecViews(view(CLI_SPEC), view(CLI_SPEC))).toEqual([]);
  });

  test("reformatting is invisible — both sides are parsed first", () => {
    const reordered = [
      "target: cli",
      "# a comment",
      "tools:",
      "  - read",
      "  - write",
      "  - bash",
      "name: demo",
      "agent:",
      "  instructions: Be useful.",
      "  model: claude-sonnet-4-6",
      "permissions:",
      "  rules:",
      "    - pattern: Read",
      "      type: alwaysAllow",
      "    - pattern: Bash(rm *)",
      "      type: alwaysDeny",
      "  mode: default",
      "mcp_servers:",
      "  thredz:",
      "    transport: stdio",
      "    command: bunx",
      '    args: ["thredz-mcp@0.3.0"]',
      "    env:",
      "      THREDZ_TOKEN: $THREDZ_TOKEN",
    ].join("\n");
    expect(diffSpecViews(view(CLI_SPEC), view(reordered))).toEqual([]);
  });
});

describe("permission patterns", () => {
  test("splits a bare name and an argument-scoped pattern", () => {
    expect(splitPattern("Read")).toEqual({ toolGlob: "Read", argGlob: null });
    expect(splitPattern("Bash(git *)")).toEqual({ toolGlob: "Bash", argGlob: "git *" });
  });

  test("refuses a malformed pattern rather than guessing", () => {
    expect(splitPattern("")).toBeUndefined();
    expect(splitPattern("Bash(git")).toBeUndefined();
    expect(splitPattern("(x)")).toBeUndefined();
  });

  test("globs match the way the runtime matcher does", () => {
    expect(compileToolGlob("Read").test("Read")).toBe(true);
    expect(compileToolGlob("Read").test("ReadImage")).toBe(false);
    expect(compileToolGlob("*").test("Anything")).toBe(true);
    expect(compileToolGlob("mcp__*").test("mcp__thredz__post")).toBe(true);
    expect(compileToolGlob("Read?").test("Reads")).toBe(true);
  });

  test("an argument-scoped rule covers a tool only conditionally", () => {
    expect(patternCoverage("Bash", "Bash")).toBe("full");
    expect(patternCoverage("Bash(git *)", "Bash")).toBe("conditional");
    expect(patternCoverage("Bash", "Read")).toBe("none");
    expect(patternCoverage("Bash(git", "Bash")).toBe("none");
  });

  test("both legal spellings of a builtin resolve to the registered name", () => {
    expect(toRegisteredName("webFetch")).toBe("WebFetch");
    expect(toRegisteredName("WebFetch")).toBe("WebFetch");
    expect(toRegisteredName("mcp__thredz__post")).toBe("mcp__thredz__post");
    expect(isExternalTool("webFetch")).toBe(true);
    expect(isExternalTool("mcp__thredz__post")).toBe(true);
    expect(isExternalTool("read")).toBe(false);
  });
});

describe("permission audit", () => {
  test("an outward tool with no rule is a finding", () => {
    const result = auditPermissions({
      tools: ["read", "webFetch"],
      mode: "default",
      askMode: "pause",
      rules: [{ type: "alwaysAllow", pattern: "Read" }],
    });
    expect(result.findings.map((f) => f.tool)).toEqual(["webFetch"]);
    expect(result.tools.find((t) => t.tool === "read")?.decision).toBe("allow");
    expect(result.tools.find((t) => t.tool === "webFetch")?.decision).toBe("ask");
  });

  test("a rule matching the camelCase spelling is found via the registered name", () => {
    const result = auditPermissions({
      tools: ["webFetch"],
      mode: "default",
      askMode: "pause",
      rules: [{ type: "alwaysDeny", pattern: "WebFetch" }],
    });
    expect(result.tools[0]?.decision).toBe("deny");
    expect(result.findings).toEqual([]);
  });

  test("conditional cover on an outward tool is still flagged", () => {
    const result = auditPermissions({
      tools: ["webFetch"],
      mode: "default",
      askMode: "pause",
      rules: [{ type: "alwaysAllow", pattern: "WebFetch(https://docs.*)" }],
    });
    expect(result.tools[0]?.conditional).toBe(true);
    expect(result.findings[0]?.reason).toContain("argument-scoped");
  });

  test("the first matching rule wins, in declaration order", () => {
    const result = auditPermissions({
      tools: ["bash"],
      mode: "default",
      askMode: "pause",
      rules: [
        { type: "alwaysAsk", pattern: "Bash" },
        { type: "alwaysAllow", pattern: "Bash" },
      ],
    });
    expect(result.tools[0]?.decision).toBe("ask");
  });

  test("a rule that matches nothing granted is reported as unused", () => {
    const result = auditPermissions({
      tools: ["read"],
      mode: "default",
      askMode: "pause",
      rules: [{ type: "alwaysDeny", pattern: "Bash" }],
    });
    expect(result.unusedRules).toEqual([{ type: "alwaysDeny", pattern: "Bash" }]);
  });

  test("a declared-destructive tool with no rule is a finding, and is never guessed", () => {
    const flagged = auditPermissions({
      tools: ["mcp__thredz__post"],
      mode: "default",
      askMode: "pause",
      rules: [],
      destructiveTools: new Set(["mcp__thredz__post"]),
    });
    expect(flagged.tools[0]?.destructive).toBe(true);
    const unflagged = auditPermissions({
      tools: ["write"],
      mode: "default",
      askMode: "pause",
      rules: [{ type: "alwaysAllow", pattern: "Write" }],
    });
    expect(unflagged.tools[0]?.destructive).toBeUndefined();
  });

  test("the mode fallback is stated for each mode", () => {
    for (const [mode, expected] of [
      ["default", "ask"],
      ["auto", "allow, except destructive tools which ask"],
      ["plan", "allow for read-only tools, deny for the rest"],
    ] as const) {
      expect(auditPermissions({ tools: [], mode, askMode: "pause", rules: [] }).fallback).toBe(
        expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------

function evalDoc(
  samples: ReadonlyArray<[string, boolean, number]>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: "run_0000000000000001",
    samples: samples.map(([sampleId, passed, score]) => ({
      sampleId,
      grades: { overall: { passed, score, rationale: "" } },
    })),
    aggregates: { passRate: samples.filter(([, p]) => p).length / samples.length },
    config: { datasetName: "golden" },
    ...extra,
  };
}

describe("eval run reader", () => {
  test("reads samples, pass rate and dataset", () => {
    const read = readEvalRun(evalDoc([["a", true, 1]]), "baseline");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.run.sampleCount).toBe(1);
    expect(read.run.datasetName).toBe("golden");
    expect(read.run.passRateDerived).toBe(false);
  });

  test("recomputes the pass rate when the aggregates block is missing", () => {
    const doc = evalDoc([
      ["a", true, 1],
      ["b", false, 0],
    ]);
    doc["aggregates"] = undefined;
    const read = readEvalRun(doc, "baseline");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.run.passRate).toBe(0.5);
    expect(read.run.passRateDerived).toBe(true);
  });

  test("refuses a document that is not an eval run, by name", () => {
    expect(readEvalRun({ hello: 1 }, "candidate")).toEqual({
      ok: false,
      error: 'candidate has no "samples" array — is it an eval results.json?',
    });
    expect(readEvalRun("nope", "baseline")).toEqual({
      ok: false,
      error: "baseline is not a JSON object",
    });
  });

  test("unknown fields are ignored, so a newer results.json still reads", () => {
    const read = readEvalRun(evalDoc([["a", true, 1]], { somethingNew: { deep: [1, 2] } }), "x");
    expect(read.ok).toBe(true);
  });
});

describe("eval gate", () => {
  const baseline = readEvalRun(
    evalDoc([
      ["a", true, 1],
      ["b", true, 1],
      ["c", false, 0],
    ]),
    "baseline",
  );

  function run(doc: Record<string, unknown>) {
    const read = readEvalRun(doc, "candidate");
    if (!read.ok || !baseline.ok) throw new Error("fixture did not read");
    return { base: baseline.run, cand: read.run };
  }

  test("an unchanged run passes", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 1],
        ["b", true, 1],
        ["c", false, 0],
      ]),
    );
    const result = compareEvalRuns(base, cand);
    expect(result.verdict).toBe("pass");
    expect(result.regressions).toEqual([]);
    expect(result.passRate.delta).toBe(0);
  });

  test("a pass → fail on a shared sample fails the gate by default", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 1],
        ["b", false, 0],
        ["c", false, 0],
      ]),
    );
    const result = compareEvalRuns(base, cand);
    expect(result.verdict).toBe("fail");
    expect(result.regressions.map((r) => r.sampleId)).toEqual(["b"]);
    expect(result.reasons[0]).toContain("pass → fail");
  });

  test("a recovery is reported and does not fail the gate", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 1],
        ["b", true, 1],
        ["c", true, 1],
      ]),
    );
    const result = compareEvalRuns(base, cand);
    expect(result.verdict).toBe("pass");
    expect(result.recoveries.map((r) => r.sampleId)).toEqual(["c"]);
  });

  test("an allowed regression budget lets one through", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 1],
        ["b", false, 0],
        ["c", false, 0],
      ]),
    );
    expect(compareEvalRuns(base, cand, { maxRegressions: 1, maxPassRateDrop: 1 }).verdict).toBe(
      "pass",
    );
  });

  test("a pass-rate floor is enforced independently of regressions", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 1],
        ["b", true, 1],
        ["c", false, 0],
      ]),
    );
    const result = compareEvalRuns(base, cand, { minPassRate: 0.9 });
    expect(result.verdict).toBe("fail");
    expect(result.reasons[0]).toContain("below the declared floor");
  });

  test("a verdict-preserving score move over epsilon is a shift, under it is nothing", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 0.5],
        ["b", true, 0.97],
        ["c", false, 0],
      ]),
    );
    const result = compareEvalRuns(base, cand);
    expect(result.scoreShifts.map((s) => s.sampleId)).toEqual(["a"]);
    expect(DEFAULT_SCORE_EPSILON).toBe(0.1);
  });

  test("samples on only one side are reported, never counted as regressions", () => {
    const { base, cand } = run(
      evalDoc([
        ["a", true, 1],
        ["d", false, 0],
      ]),
    );
    const result = compareEvalRuns(base, cand, { maxPassRateDrop: 1 });
    expect(result.samples).toEqual({ shared: 1, baselineOnly: ["b", "c"], candidateOnly: ["d"] });
    expect(result.regressions).toEqual([]);
  });

  test("an abstained or errored candidate sample is listed as inconclusive", () => {
    const doc = evalDoc([
      ["a", true, 1],
      ["b", false, 0],
      ["c", false, 0],
    ]);
    const samples = doc["samples"] as Array<Record<string, unknown>>;
    (samples[1]?.["grades"] as { overall: Record<string, unknown> }).overall["abstained"] = true;
    const { base, cand } = run(doc);
    expect(compareEvalRuns(base, cand).inconclusive).toEqual(["b"]);
  });

  test("comparing runs over different datasets is noted, not silently gated", () => {
    const doc = evalDoc([["a", true, 1]], { config: { datasetName: "other" } });
    const { base, cand } = run(doc);
    const result = compareEvalRuns(base, cand, { maxPassRateDrop: 1 });
    expect(result.notes.some((n) => n.includes("different datasets"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function line(kind: string, payload: unknown, ts?: number): string {
  return JSON.stringify({ ts: ts ?? 1_700_000_000_000, version: 1, kind, payload });
}

describe("session log parsing", () => {
  test("parses the enveloped shape and records the line number", () => {
    const parsed = parseSessionLog("sess_a", [line("user_message", { content: "hi" })].join("\n"));
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.events[0]).toEqual({
      session: "sess_a",
      line: 1,
      kind: "user_message",
      ts: 1_700_000_000_000,
      payload: { content: "hi" },
    });
  });

  test("a flat line (no payload envelope) falls back to the object itself", () => {
    const parsed = parseSessionLog(
      "sess_a",
      `${JSON.stringify({ kind: "cost_accrual", provider: "openai", costUsdMicros: 1000 })}\n`,
    );
    expect(parsed.events[0]?.payload).toEqual({
      kind: "cost_accrual",
      provider: "openai",
      costUsdMicros: 1000,
    });
  });

  test("malformed lines are counted, never thrown on", () => {
    const parsed = parseSessionLog(
      "sess_a",
      ["{ not json", JSON.stringify({ no: "kind" }), line("error", { message: "boom" })].join("\n"),
    );
    expect(parsed.malformedLines).toBe(2);
    expect(parsed.events).toHaveLength(1);
  });

  test("the event cap truncates rather than exhausting memory", () => {
    const text = Array.from({ length: 10 }, () => line("user_message", {})).join("\n");
    const parsed = parseSessionLog("sess_a", text, 3);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });
});

function events(...lines: string[]): SessionEvent[] {
  return parseSessionLog("sess_a", lines.join("\n")).events;
}

describe("session summary", () => {
  test("counts by kind, sorted", () => {
    const summary = summarizeEvents(
      events(line("user_message", {}), line("error", { message: "x" }), line("user_message", {})),
    );
    expect(summary.byKind).toEqual([
      { kind: "error", count: 1 },
      { kind: "user_message", count: 2 },
    ]);
    expect(summary.errors).toEqual([{ message: "x", count: 1 }]);
  });

  test("a tool call is counted once even when tool_stats mirrors it", () => {
    const summary = summarizeEvents(
      events(
        line("tool_use", { id: "tu_1", name: "Read" }),
        line("tool_stats", { toolName: "Read", durationMs: 12, isError: false }),
        line("tool_use", { id: "tu_2", name: "Read" }),
        line("tool_stats", { toolName: "Read", durationMs: 8, isError: true }),
      ),
    );
    expect(summary.tools).toEqual([{ name: "Read", calls: 2, errors: 1, totalDurationMs: 20 }]);
  });

  test("a log with only tool_stats still reports calls", () => {
    const summary = summarizeEvents(
      events(line("tool_stats", { toolName: "Bash", durationMs: 5, isError: false })),
    );
    expect(summary.tools).toEqual([{ name: "Bash", calls: 1, errors: 0, totalDurationMs: 5 }]);
  });

  test("without tool_stats, errors come from joining tool_result back to its tool_use", () => {
    const summary = summarizeEvents(
      events(
        line("tool_use", { id: "tu_1", name: "Bash" }),
        line("tool_result", { toolUseId: "tu_1", isError: true }),
      ),
    );
    expect(summary.tools).toEqual([{ name: "Bash", calls: 1, errors: 1 }]);
  });

  test("MCP calls are tallied per server and tool", () => {
    const summary = summarizeEvents(
      events(
        line("mcp_stats", { server: "thredz", toolName: "post", durationMs: 30, isError: true }),
      ),
    );
    expect(summary.mcpTools).toEqual([
      { name: "thredz/post", calls: 1, errors: 1, totalDurationMs: 30 },
    ]);
  });

  test("unknown kinds are counted and otherwise left alone", () => {
    const summary = summarizeEvents(events(line("some_future_kind", { x: 1 })));
    expect(summary.byKind).toEqual([{ kind: "some_future_kind", count: 1 }]);
  });

  test("the time range comes from the events, not the clock", () => {
    const summary = summarizeEvents(
      events(line("user_message", {}, 1000), line("user_message", {}, 5000)),
    );
    expect(summary.firstTs).toBe(1000);
    expect(summary.lastTs).toBe(5000);
  });
});

describe("event filtering", () => {
  const all = events(
    line("tool_use", { name: "Read" }, 1000),
    line("error", { message: "boom" }, 2000),
    line("tool_use", { name: "Bash" }, 3000),
  );

  test("filters by kind", () => {
    expect(filterEvents(all, { kinds: ["error"] })).toHaveLength(1);
  });

  test("filters by inclusive timestamp bounds", () => {
    expect(filterEvents(all, { sinceTs: 2000, untilTs: 3000 })).toHaveLength(2);
  });

  test("filters by a payload substring", () => {
    expect(filterEvents(all, { contains: "Bash" })).toHaveLength(1);
  });

  test("filters compose", () => {
    expect(filterEvents(all, { kinds: ["tool_use"], contains: "Read" })).toHaveLength(1);
  });
});

describe("cost summary", () => {
  const accrual = (
    model: string,
    micros: number,
    ts: number,
    extra: Record<string, unknown> = {},
  ) =>
    line(
      "cost_accrual",
      {
        provider: "anthropic",
        modelId: model,
        costUsdMicros: micros,
        inputTokens: 10,
        outputTokens: 5,
        ...extra,
      },
      ts,
    );

  test("totals by model, provider and UTC day", () => {
    const summary = summarizeCost(
      events(
        accrual("sonnet", 450, Date.UTC(2026, 0, 1, 10)),
        accrual("sonnet", 300, Date.UTC(2026, 0, 2, 10)),
        accrual("opus", 900, Date.UTC(2026, 0, 2, 11)),
      ),
    );
    expect(summary.totals.costUsdMicros).toBe(1650);
    expect(summary.byModel.map((b) => [b.key, b.costUsdMicros])).toEqual([
      ["opus", 900],
      ["sonnet", 750],
    ]);
    expect(summary.byDay.map((b) => b.key)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(summary.byProvider).toHaveLength(1);
  });

  test("the run's terminal roll-up is skipped so totals are not doubled", () => {
    const summary = summarizeCost(
      events(accrual("sonnet", 100, 1000), accrual("sonnet", 100, 1000, { summary: true })),
    );
    expect(summary.accruals).toBe(1);
    expect(summary.totals.costUsdMicros).toBe(100);
  });

  test("an unpriced accrual keeps its tokens and contributes no cost", () => {
    const summary = summarizeCost(events(accrual("mystery", 0, 1000, { unpriced: true })));
    expect(summary.unpriced).toBe(1);
    expect(summary.totals.costUsdMicros).toBe(0);
    expect(summary.totals.inputTokens).toBe(10);
  });

  test("a log with no accruals reports zero rather than an estimate", () => {
    expect(summarizeCost(events(line("user_message", {}))).accruals).toBe(0);
  });
});

describe("lenient identity", () => {
  test("a valid spec reports name, shape and the agent's model", () => {
    expect(readSpecIdentity(CLI_SPEC)).toEqual({
      name: "demo",
      target: "cli",
      model: "claude-sonnet-4-6",
      valid: true,
      lenient: false,
    });
  });

  test("an invalid spec still yields an identity, flagged lenient, with the first issue", () => {
    const broken = ["name: broken", "target: cli", "agent:", "  model: m"].join("\n");
    const identity = readSpecIdentity(broken);
    expect(identity.valid).toBe(false);
    expect(identity.lenient).toBe(true);
    expect(identity.name).toBe("broken");
    expect(identity.target).toBe("cli");
    // The first issue is the one `parseSpec` would have thrown, and it names
    // the path that owns it — "defined" would pass on an empty string.
    expect(identity.firstIssue).toContain("agent.instructions");
  });

  test("quotes and trailing comments are stripped by the fallback scan", () => {
    const broken = ['name: "quoted"  # why', "target: cli", "nonsense: ["].join("\n");
    expect(readSpecIdentity(broken).name).toBe("quoted");
  });
});

// ---------------------------------------------------------------------------
// the two pure rules that carry a security claim
// ---------------------------------------------------------------------------

describe("redactArgs", () => {
  test("redacts the entry after a credential-named flag", () => {
    expect(redactArgs(["--api-key", "sk-live-0123456789abcdef"])).toEqual({
      args: ["--api-key", "(redacted)"],
      redacted: 1,
    });
  });

  test("redacts the value half of a --flag=value entry", () => {
    expect(redactArgs(["--token=ghp_0123456789abcdefghij"]).args).toEqual(["--token=(redacted)"]);
  });

  test("redacts a bare value that is a credential on its own evidence", () => {
    // Split so the SOURCE never carries a secret-shaped literal: GitHub push
    // protection matches on shape rather than on whether a value is real, and
    // a repo whose own tools scan for these patterns should not ship one. The
    // runtime value is unchanged.
    expect(redactArgs(["serve", `xoxb-${"1111-2222-abcdefabcdef"}`]).args).toEqual([
      "serve",
      "(redacted)",
    ]);
  });

  test("leaves ordinary argv alone — an over-redacted report is a useless one", () => {
    const args = [
      "-y",
      "@vendor/mcp-server",
      "--port",
      "8080",
      "/usr/local/bin/thing",
      "--verbose",
    ];
    expect(redactArgs(args)).toEqual({ args: [...args], redacted: 0 });
  });

  test("an env reference is a reference, not a secret, so it stays readable", () => {
    expect(redactArgs(["--api-key", "$VENDOR_API_KEY"]).args).toEqual([
      "--api-key",
      "$VENDOR_API_KEY",
    ]);
  });

  test("a long lowercase word is a package name, not a token", () => {
    const name = "averyveryverylongpackagenamewithoutdigits";
    expect(redactArgs([name]).args).toEqual([name]);
  });

  test("a long mixed-case run with digits is treated as a token", () => {
    const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    expect(redactArgs([token]).args).toEqual(["(redacted)"]);
  });
});

describe("compileToolGlob mirrors the runtime matcher", () => {
  test("a backslash escapes the next character instead of demanding a literal backslash", () => {
    // `escapeGlobLiteral("Web*Fetch")` emits `Web\*Fetch`, which the runtime
    // matcher compiles to "the literal Web*Fetch". Reading the backslash as
    // an ordinary character made this package disagree with the engine.
    expect(compileToolGlob("Web\\*Fetch").test("Web*Fetch")).toBe(true);
    expect(compileToolGlob("Web\\*Fetch").test("WebSearchFetch")).toBe(false);
  });

  test("an escaped question mark is a literal, not an optional atom", () => {
    expect(compileToolGlob("Bash\\?").test("Bash?")).toBe(true);
    expect(compileToolGlob("Bash\\?").test("Bash")).toBe(false);
  });

  test("the three wildcards still mean what they meant", () => {
    expect(compileToolGlob("*").test("Read")).toBe(true);
    expect(compileToolGlob("**").test("mcp__srv__do")).toBe(true);
    expect(compileToolGlob("Read?").test("Reads")).toBe(true);
    expect(compileToolGlob("Read?").test("Read")).toBe(false);
  });

  test("a run of stars does not backtrack exponentially", () => {
    // `.*.*.*.*…a` against a long name with no `a` is the classic blow-up;
    // folding the run to one `.*` keeps it linear. A wall-clock bound is the
    // only honest assertion here, and it is three orders of magnitude clear.
    const pattern = `${"*".repeat(40)}Z`;
    const name = "M".repeat(200);
    const started = Date.now();
    expect(compileToolGlob(pattern).test(name)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
