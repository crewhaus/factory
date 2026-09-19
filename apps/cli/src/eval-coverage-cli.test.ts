/**
 * Item 6 — CLI integration for `crewhaus eval coverage`. Split out of the
 * unit tests when the coverage core moved to `@crewhaus/eval-ops`: these
 * spawn the CLI, so they stay with the app.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  // D44 — the flag used to parse and do nothing; it now produces a report.
  it("--graders reports gold-needing graders vs gold-less samples", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sess_00000000000000b1.jsonl"), sessionJsonl([["Read"]]));
    const evalDir = join(root, "eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(
      join(evalDir, "dataset.jsonl"),
      `${JSON.stringify({ id: "s1", input: "read the file" })}\n${JSON.stringify({
        id: "s2",
        input: "read the other file",
        expected_output: "done",
      })}\n`,
    );
    writeFileSync(
      join(evalDir, "graders.yaml"),
      "graders:\n" +
        "  - name: exact\n" +
        "    type: exact_match\n" +
        "  - name: sub\n" +
        "    type: contains\n" +
        "    substring: done\n",
    );

    const got = await runCli(
      ["eval", "coverage", "--graders", "eval/graders.yaml", "--format", "json", "-o", "cov"],
      root,
    );
    expect(got.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(join(root, "cov", "coverage.json"), "utf-8"));
    expect(json.graderCoverage.graderCount).toBe(2);
    expect(json.graderCoverage.goldlessSampleIds).toEqual(["s1"]);
    const exact = json.graderCoverage.perGrader.find(
      (g: { grader: string }) => g.grader === "exact",
    );
    expect(exact.needsGold).toBe(true);
    expect(exact.scorable).toBe(1);
    expect(exact.unscorableSampleIds).toEqual(["s1"]);
    const sub = json.graderCoverage.perGrader.find((g: { grader: string }) => g.grader === "sub");
    expect(sub.needsGold).toBe(false);
    expect(sub.scorable).toBe(2);
  });

  it("without --graders the JSON report carries no graderCoverage key", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CLI_SPEC);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sess_00000000000000b2.jsonl"), sessionJsonl([["Read"]]));
    const got = await runCli(["eval", "coverage", "--format", "json", "-o", "cov"], root);
    expect(got.exitCode).toBe(0);
    const text = readFileSync(join(root, "cov", "coverage.json"), "utf-8");
    expect(text).not.toContain("graderCoverage");
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
