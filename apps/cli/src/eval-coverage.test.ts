/**
 * Item 6 — unit tests for the eval-coverage core: production-behavior
 * distribution from seeded session events (tool/MCP frequencies, bigrams,
 * compaction, input clustering), the eval-coverage distribution from
 * expected_tools + eval-run events, deterministic clustering, gap
 * computation + ranking, and the three renderers.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoverageReport,
  EvalCoverageError,
  assistantToolNames,
  buildEvalCoverage,
  buildProdBehavior,
  clusterInputs,
  computeCoverage,
  coverageFileName,
  isMcpTool,
  parseCoverageFormat,
  parseSessionsFlag,
  renderCoverage,
  renderCoverageHtml,
  renderCoverageJson,
  renderCoverageText,
  splitBigram,
} from "./eval-coverage";
import type { LoggedEvent } from "./feedback";

/** Seed an assistant_message event that called the given tools. */
function assistant(...tools: string[]): LoggedEvent {
  return {
    kind: "assistant_message",
    payload: {
      content: [
        { type: "text", text: "working on it" },
        ...tools.map((name) => ({ type: "tool_use", name, input: {} })),
      ],
    },
  };
}

/** Seed a user_message (string content) event. */
function user(text: string): LoggedEvent {
  return { kind: "user_message", payload: { content: text } };
}

const compaction: LoggedEvent = { kind: "compaction", payload: { before: 40, after: 12 } };

describe("flag parsing", () => {
  it("parseCoverageFormat defaults to text and validates", () => {
    expect(parseCoverageFormat(undefined)).toBe("text");
    expect(parseCoverageFormat("html")).toBe("html");
    expect(parseCoverageFormat("json")).toBe("json");
    expect(() => parseCoverageFormat("pdf")).toThrow(EvalCoverageError);
  });

  it("parseSessionsFlag accepts N or all", () => {
    expect(parseSessionsFlag(undefined)).toBe(50);
    expect(parseSessionsFlag("10")).toBe(10);
    expect(parseSessionsFlag("ALL")).toBe("all");
    expect(() => parseSessionsFlag("0")).toThrow(EvalCoverageError);
    expect(() => parseSessionsFlag("-3")).toThrow(EvalCoverageError);
    expect(() => parseSessionsFlag("lots")).toThrow(EvalCoverageError);
  });
});

describe("assistantToolNames / isMcpTool", () => {
  it("extracts verbatim tool names including mcp__ prefixes", () => {
    expect(assistantToolNames(assistant("Read", "mcp__jira__CreateIssue").payload)).toEqual([
      "Read",
      "mcp__jira__CreateIssue",
    ]);
    expect(assistantToolNames({ content: "just text" })).toEqual([]);
  });

  it("classifies mcp tools by prefix", () => {
    expect(isMcpTool("mcp__jira__CreateIssue")).toBe(true);
    expect(isMcpTool("Read")).toBe(false);
  });
});

describe("buildProdBehavior", () => {
  it("counts per-session tool usage, raw calls, bigrams, and compaction", () => {
    const sessions = [
      {
        sessionId: "sess_0000000000000001",
        events: [
          user("do the thing"),
          assistant("Read", "Read"), // Read twice in one message
          assistant("mcp__jira__CreateIssue"),
          compaction,
        ],
      },
      {
        sessionId: "sess_0000000000000002",
        events: [user("do the other thing"), assistant("Read"), assistant("Grep")],
      },
    ];
    const prod = buildProdBehavior(sessions);
    expect(prod.sessionCount).toBe(2);
    // Read appeared in BOTH sessions (session frequency), 3 raw calls total.
    expect(prod.toolSessions.get("Read")).toBe(2);
    expect(prod.toolCalls.get("Read")).toBe(3);
    expect(prod.toolSessions.get("mcp__jira__CreateIssue")).toBe(1);
    // Bigrams: session 1 has Read→Read, Read→mcp__jira__CreateIssue; session 2 Read→Grep.
    expect(prod.bigramSessions.get("Read Read")).toBe(1);
    expect(prod.bigramSessions.get("Read mcp__jira__CreateIssue")).toBe(1);
    expect(prod.bigramSessions.get("Read Grep")).toBe(1);
    expect(prod.compactionSessions).toBe(1);
  });

  it("counts a tool once per session even when it fires many times", () => {
    const prod = buildProdBehavior([
      {
        sessionId: "sess_0000000000000003",
        events: [assistant("Bash"), assistant("Bash"), assistant("Bash")],
      },
    ]);
    expect(prod.toolSessions.get("Bash")).toBe(1);
    expect(prod.toolCalls.get("Bash")).toBe(3);
  });
});

describe("clusterInputs", () => {
  it("is deterministic and groups similar inputs", () => {
    const inputs = [
      "summarize the weekly sales report for the team",
      "please summarize the weekly sales report",
      "deploy the service to production now",
    ];
    const a = clusterInputs(inputs);
    const b = clusterInputs(inputs);
    expect(a).toEqual(b);
    // Two summarize-inputs cluster together; deploy is its own theme.
    const summarize = a.find((t) => t.label.includes("summarize") || t.label.includes("report"));
    expect(summarize?.count).toBe(2);
    expect(a.some((t) => t.label.includes("deploy") || t.label.includes("production"))).toBe(true);
  });

  it("drops inputs with no clusterable tokens (all < 3 chars)", () => {
    expect(clusterInputs(["ok", "hi", "no"])).toEqual([]);
  });
});

describe("buildEvalCoverage", () => {
  it("collects tools + bigrams from expected_tools and run events", () => {
    const cov = buildEvalCoverage(
      [{ expected_tools: ["Read", "Grep"] }, { expected_tools: ["Read"] }, {}],
      // Eval run per-sample events.jsonl (tool_call_end trace shape).
      [
        `${JSON.stringify({ kind: "tool_call_end", toolName: "Bash" })}\n${JSON.stringify({
          kind: "tool_call_end",
          toolName: "Write",
        })}`,
      ],
    );
    expect([...cov.toolsExercised].sort()).toEqual(["Bash", "Grep", "Read", "Write"]);
    expect(cov.bigramsExercised.has("Read Grep")).toBe(true);
    expect(cov.bigramsExercised.has("Bash Write")).toBe(true);
    expect(cov.hasExpectedTools).toBe(true);
    expect(cov.hasRunEvents).toBe(true);
    expect(cov.sampleCount).toBe(3);
  });

  it("marks hasExpectedTools false and hasRunEvents false appropriately", () => {
    const cov = buildEvalCoverage([{}, {}], []);
    expect(cov.hasExpectedTools).toBe(false);
    expect(cov.hasRunEvents).toBe(false);
    expect(cov.toolsExercised.size).toBe(0);
  });
});

describe("computeCoverage", () => {
  const prod = buildProdBehavior([
    {
      sessionId: "sess_0000000000000001",
      events: [user("file a ticket"), assistant("Read"), assistant("mcp__jira__CreateIssue")],
    },
    {
      sessionId: "sess_0000000000000002",
      events: [user("file another ticket"), assistant("mcp__jira__CreateIssue")],
      // compaction below
    },
    {
      sessionId: "sess_0000000000000003",
      events: [user("read a file"), assistant("Read"), compaction],
    },
  ]);

  it("flags prod tools/bigrams/compaction absent from the eval as ranked gaps", () => {
    const evalCov = buildEvalCoverage([{ expected_tools: ["Read"] }], []);
    const report = computeCoverage({ prod, evalCov, specName: "helper", datasetName: "smoke@v1" });
    // Read IS covered, so it's not a gap. mcp__jira__CreateIssue is a gap.
    const subjects = report.gaps.map((g) => g.subject);
    expect(subjects).not.toContain("Read");
    expect(subjects).toContain("mcp__jira__CreateIssue");
    expect(subjects).toContain("compaction");
    expect(subjects).toContain("Read → mcp__jira__CreateIssue");

    // mcp gap in 2/3 sessions ranks above compaction (1/3) — session freq desc.
    const mcpGap = report.gaps.find((g) => g.subject === "mcp__jira__CreateIssue");
    expect(mcpGap?.kind).toBe("mcp-tool");
    expect(mcpGap?.sessions).toBe(2);
    expect(report.gaps[0]?.subject).toBe("mcp__jira__CreateIssue");
    // Ranking is by session count desc.
    for (let i = 1; i < report.gaps.length; i += 1) {
      expect((report.gaps[i - 1] as { sessions: number }).sessions).toBeGreaterThanOrEqual(
        (report.gaps[i] as { sessions: number }).sessions,
      );
    }
  });

  it("reports zero gaps when the eval exercises everything", () => {
    const evalCov = buildEvalCoverage(
      [{ expected_tools: ["Read", "mcp__jira__CreateIssue"] }],
      // Provide the bigram + a compaction-covering run (compaction can't be
      // covered by tools, but with no compaction in prod this stays clean).
      [],
    );
    const cleanProd = buildProdBehavior([
      {
        sessionId: "sess_0000000000000009",
        events: [assistant("Read"), assistant("mcp__jira__CreateIssue")],
      },
    ]);
    const report = computeCoverage({ prod: cleanProd, evalCov });
    expect(report.gaps).toEqual([]);
  });
});

describe("renderers", () => {
  const report: CoverageReport = {
    specName: "helper",
    sessionsScanned: 3,
    datasetName: "smoke@v1",
    sampleCount: 5,
    hasRunEvents: false,
    gaps: [
      {
        kind: "mcp-tool",
        subject: "mcp__jira__CreateIssue",
        sessions: 2,
        fraction: 2 / 3,
        detail:
          "mcp__jira__CreateIssue appears in 67% of sessions (2/3, 2 call(s)) but 0 dataset samples exercise it",
      },
      {
        kind: "compaction",
        subject: "compaction",
        sessions: 1,
        fraction: 1 / 3,
        detail:
          "compaction fired in 1 session(s) (33%) but is never exercised in eval — add a long-context sample",
      },
    ],
    inputThemes: [
      { label: "ticket file", tokens: ["ticket", "file"], count: 2, exemplar: "file a ticket" },
    ],
  };

  it("text renders a ranked backlog", () => {
    const txt = renderCoverageText(report);
    expect(txt).toContain('eval coverage for "helper"');
    expect(txt).toContain("mcp__jira__CreateIssue appears in 67%");
    expect(txt).toContain("compaction fired in 1 session");
    expect(txt).toContain("no recent eval run events");
  });

  it("json is a stable, parseable ranked backlog", () => {
    const json = JSON.parse(renderCoverageJson(report));
    expect(json.spec).toBe("helper");
    expect(json.dataset).toBe("smoke@v1");
    expect(json.gapCount).toBe(2);
    expect(json.backlog[0].subject).toBe("mcp__jira__CreateIssue");
    expect(json.backlog[0].kind).toBe("mcp-tool");
    expect(json.backlog[0].fraction).toBeCloseTo(0.6667, 3);
    expect(json.inputThemes[0].label).toBe("ticket file");
  });

  it("html is self-contained and escapes content", () => {
    const html = renderCoverageHtml(report);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("mcp__jira__CreateIssue");
    expect(html).toContain("data-sortable");
    // No external resource references.
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("renderCoverage dispatches by format and coverageFileName maps extensions", () => {
    expect(renderCoverage(report, "json")).toBe(renderCoverageJson(report));
    expect(renderCoverage(report, "html")).toBe(renderCoverageHtml(report));
    expect(renderCoverage(report, "text")).toBe(renderCoverageText(report));
    expect(coverageFileName("html")).toBe("coverage.html");
    expect(coverageFileName("json")).toBe("coverage.json");
    expect(coverageFileName("text")).toBe("coverage.txt");
  });

  it("empty gaps render a clean message", () => {
    const clean = { ...report, gaps: [], inputThemes: [] };
    expect(renderCoverageText(clean)).toContain("no coverage gaps");
    expect(renderCoverageHtml(clean)).toContain("No coverage gaps");
  });
});

describe("splitBigram", () => {
  it("round-trips a bigram key", () => {
    expect(splitBigram("Read mcp__jira__CreateIssue")).toEqual(["Read", "mcp__jira__CreateIssue"]);
  });
});

// -------- CLI integration (offline — env carries only PATH) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-eval-coverage-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(cliArgs: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...cliArgs], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

const CLI_SPEC = `name: helper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a research assistant. You file tickets and read files.
tools: [read]
`;

/** One production session JSONL: user turn + assistant tool_use messages. */
function sessionJsonl(tools: string[][], opts: { compaction?: boolean } = {}): string {
  const lines: string[] = [
    JSON.stringify({
      kind: "user_message",
      payload: { content: "file a ticket about the parser crash" },
    }),
  ];
  for (const group of tools) {
    lines.push(
      JSON.stringify({
        kind: "assistant_message",
        payload: {
          content: [
            { type: "text", text: "on it" },
            ...group.map((name) => ({ type: "tool_use", name, input: {} })),
          ],
        },
      }),
    );
  }
  if (opts.compaction === true) {
    lines.push(JSON.stringify({ kind: "compaction", payload: { before: 40, after: 10 } }));
  }
  return `${lines.join("\n")}\n`;
}

describe("crewhaus eval coverage (CLI, offline)", () => {
  it("writes a ranked json backlog naming the uncovered MCP tool + compaction", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Two sessions call mcp__jira__CreateIssue (uncovered); one uses Read (covered).
    writeFileSync(
      join(sessionsDir, "sess_00000000000000a1.jsonl"),
      sessionJsonl([["Read"], ["mcp__jira__CreateIssue"]], { compaction: true }),
    );
    writeFileSync(
      join(sessionsDir, "sess_00000000000000a2.jsonl"),
      sessionJsonl([["mcp__jira__CreateIssue"]]),
    );
    // Dataset covers only Read.
    const evalDir = join(root, "eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(
      join(evalDir, "dataset.jsonl"),
      `${JSON.stringify({ id: "s1", input: "read the file", expected_tools: ["Read"] })}\n`,
    );

    const got = await runCli(["eval", "coverage", "--format", "json", "-o", "cov"], root);
    expect(got.exitCode).toBe(0);
    const outPath = join(root, "cov", "coverage.json");
    expect(existsSync(outPath)).toBe(true);
    const json = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(json.spec).toBe("helper");
    expect(json.sessionsScanned).toBe(2);
    const subjects = json.backlog.map((g: { subject: string }) => g.subject);
    expect(subjects).toContain("mcp__jira__CreateIssue");
    expect(subjects).toContain("compaction");
    expect(subjects).not.toContain("Read");
    // MCP tool (2 sessions) ranks first.
    expect(json.backlog[0].subject).toBe("mcp__jira__CreateIssue");
    expect(json.backlog[0].kind).toBe("mcp-tool");
  });

  // B16 collateral — coverage is INSPECTION, not consumption: a bare registry
  // ref must stay split-complete (test included), or gap analysis would
  // misreport behaviors that only the held-out split exercises as uncovered.
  it("a bare registry --dataset ref is inspected across ALL splits, test included", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sess_00000000000000c1.jsonl"), sessionJsonl([["Read"]]));

    // 10 samples at the default 70/15/15 → 7 train + 1 dev + 2 test.
    const file = join(root, "seed.jsonl");
    writeFileSync(
      file,
      `${Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `s${i}`, input: `question ${i}` })).join("\n")}\n`,
    );
    expect((await runCli(["datasets", "put", "cov-ds", "--file", file], root)).exitCode).toBe(0);

    const got = await runCli(
      ["eval", "coverage", "--dataset", "registry:cov-ds", "--format", "json", "-o", "cov"],
      root,
    );
    expect(got.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(join(root, "cov", "coverage.json"), "utf-8"));
    // All 10 samples count — the consumption view (train+dev) would see 8.
    expect(json.sampleCount).toBe(10);
    expect(json.dataset).toBe("cov-ds@v1");
  });

  it("html format is self-contained and text is the default", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sess_00000000000000b1.jsonl"), sessionJsonl([["Grep"]]));

    const html = await runCli(["eval", "coverage", "--format", "html", "-o", "out"], root);
    expect(html.exitCode).toBe(0);
    const htmlPath = join(root, "out", "coverage.html");
    expect(existsSync(htmlPath)).toBe(true);
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain("<!doctype html>");
    expect(content).not.toContain("http://");

    // Default (no -o, no --format) prints text and exits 0.
    const text = await runCli(["eval", "coverage"], root);
    expect(text.exitCode).toBe(0);
  });

  it("errors cleanly with no sessions and on a bad --format", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    // No sessions dir → exit 1.
    expect((await runCli(["eval", "coverage"], root)).exitCode).toBe(1);
    // Bad --format → exit 1.
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sess_00000000000000c1.jsonl"), sessionJsonl([["Read"]]));
    expect((await runCli(["eval", "coverage", "--format", "pdf"], root)).exitCode).toBe(1);
  });
});
