/**
 * CLI integration tests for `crewhaus advise` (item 14).
 *
 * Follows datasets-cli.test.ts's posture: stdout assertions are avoided
 * (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`) — assert on
 * exit codes and the on-disk artifacts (suggestions.json + report.html)
 * instead. No model/credentials needed anywhere in this file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SuggestionsFile } from "./advise-rules";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-advise-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

const SESSION = "sess_00000000000000ad";

function jsonl(lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

function line(kind: string, payload: unknown): unknown {
  return { ts: 1, version: 1, kind, payload };
}

/** Seed a session whose signals trip the failure + truncation rules. */
function seedNoisySession(root: string, sessionId = SESSION): void {
  const dir = join(root, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    jsonl([
      line("user_message", { content: "q" }),
      line("assistant_message", { content: [{ type: "text", text: "a" }] }),
      ...Array.from({ length: 5 }, () =>
        line("tool_stats", { toolName: "Fetch", durationMs: 10, isError: true }),
      ),
      line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
      line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }),
    ]),
  );
}

function seedSpec(root: string): void {
  writeFileSync(
    join(root, "crewhaus.yaml"),
    [
      "name: hello",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: help",
      "",
    ].join("\n"),
  );
}

describe("crewhaus advise CLI (item 14)", () => {
  test("advise --help exits 0; --session with --all exits 1", async () => {
    const root = newTempRoot();
    expect((await runCli(["advise", "--help"], root)).exitCode).toBe(0);
    expect((await runCli(["advise", "--session", SESSION, "--all"], root)).exitCode).toBe(1);
  });

  test("missing session / empty sessions dir exit 1", async () => {
    const root = newTempRoot();
    expect((await runCli(["advise", "--session", "sess_beef000000000000"], root)).exitCode).toBe(1);
    expect((await runCli(["advise"], root)).exitCode).toBe(1);
  });

  test("mines a noisy session and writes validated patch suggestions + report", async () => {
    const root = newTempRoot();
    seedNoisySession(root);
    seedSpec(root);
    const out = join(root, "advice-out");
    const result = await runCli(["advise", "--session", SESSION, "-o", out], root);
    expect(result.exitCode).toBe(0);

    const suggestions = JSON.parse(
      readFileSync(join(out, "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    expect(suggestions.sessionIds).toEqual([SESSION]);
    expect(suggestions.suggestions).toHaveLength(1);
    expect(suggestions.suggestions[0]?.findingId).toBe("truncation-pressure");
    expect(suggestions.suggestions[0]?.patch).toMatchObject({
      target: "cli",
      path: ["agent", "max_tokens"],
      op: "add",
      value: 16384,
    });

    const html = readFileSync(join(out, "report.html"), "utf-8");
    expect(html).toContain("repeated-tool-failures:Fetch");
    expect(html).toContain("truncation-pressure");
  });

  test("--all default out dir is .crewhaus/advice; --json exits 0", async () => {
    const root = newTempRoot();
    seedNoisySession(root);
    seedSpec(root);
    expect((await runCli(["advise", "--all", "--json"], root)).exitCode).toBe(0);
    expect(existsSync(join(root, ".crewhaus", "advice", "suggestions.json"))).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "advice", "report.html"))).toBe(true);
  });

  test("without a cwd spec, patch suggestions degrade to advice (empty suggestions list)", async () => {
    const root = newTempRoot();
    seedNoisySession(root);
    const out = join(root, "advice-out");
    expect((await runCli(["advise", "-o", out], root)).exitCode).toBe(0);
    const suggestions = JSON.parse(
      readFileSync(join(out, "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    expect(suggestions.suggestions).toEqual([]);
    // The findings still land in the report as advice.
    expect(readFileSync(join(out, "report.html"), "utf-8")).toContain("truncation-pressure");
  });

  test("old-vintage sessions (no advisor kinds) mine cleanly with zero findings", async () => {
    const root = newTempRoot();
    const dir = join(root, ".crewhaus", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      jsonl([
        line("user_message", { content: "q" }),
        line("assistant_message", { content: [{ type: "text", text: "a" }] }),
        line("tool_use", { id: "tu_1", name: "Fetch", input: {} }),
        line("tool_result", { toolUseId: "tu_1", content: "ok", isError: false }),
      ]),
    );
    const out = join(root, "advice-out");
    expect((await runCli(["advise", "-o", out], root)).exitCode).toBe(0);
    const suggestions = JSON.parse(
      readFileSync(join(out, "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    expect(suggestions.suggestions).toEqual([]);
    expect(readFileSync(join(out, "report.html"), "utf-8")).toContain("No findings");
  });
});
