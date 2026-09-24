/**
 * permission-integration#8 — `crewhaus permissions suggest` scopes a proposal
 * on the argument each tool declares, and says BLANKET GRANT out loud when it
 * cannot.
 *
 * The audit's reproduction, driven through the real CLI: three identical
 * approved asks each for RemovePath, HttpRequest, Write and RunCommand used to
 * become bare `alwaysAllow RemovePath` ("delete anything") and
 * `alwaysAllow RunCommand` ("run any command"), with no warning in the output.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";

const CLI_PATH = join(import.meta.dir, "index.ts");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "permissions-suggest-cli-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function line(kind: string, payload: unknown): string {
  return JSON.stringify({ ts: 1, version: 1, kind, payload });
}

/** One session: each call recorded, then asked about and approved three times. */
function seed(calls: ReadonlyArray<{ name: string; input: unknown }>): void {
  const dir = join(cwd, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (const { name, input } of calls) {
    for (let i = 0; i < 3; i++) {
      lines.push(line("tool_use", { id: `toolu_${name}_${i}`, name, input }));
      lines.push(line("permission", { toolName: name, decision: "ask", askOutcome: "approved" }));
    }
  }
  writeFileSync(join(dir, "sess_0123456789abcdef.jsonl"), `${lines.join("\n")}\n`);
}

async function suggest(json: boolean): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(
    [process.execPath, CLI_PATH, "permissions", "suggest", ...(json ? ["--json"] : [])],
    {
      cwd,
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

type Json = {
  suggestions: Array<{ rule: { type: string; pattern: string }; evidence: string[] }>;
  rejected: unknown[];
};

describe("crewhaus permissions suggest", () => {
  test("a repeated approval is scoped on the argument the tool declares", async () => {
    seed([
      { name: "RemovePath", input: { path: "build/cache", recursive: true } },
      { name: "HttpRequest", input: { url: "https://api.example.com/v1/items", method: "GET" } },
      { name: "Write", input: { path: "out/report.md", content: "# report" } },
      { name: "RunCommand", input: { argv: ["git", "status"] } },
    ]);
    const { stdout, exitCode } = await suggest(true);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout) as Json;
    const patterns = out.suggestions.map((s) => s.rule.pattern).sort();
    expect(patterns).toEqual([
      "HttpRequest(https://api.example.com/v1/items)",
      "RemovePath(build/cache)",
      "RunCommand(git status)",
      "Write(out/report.md)",
    ]);
    expect(out.rejected).toEqual([]);
    // And each one means what it says, asked of the real matcher.
    const removePath = compilePattern("RemovePath(build/cache)");
    const operative = (path: string) => ({
      operativeValues: [{ kind: "path" as const, canonical: [path] }],
    });
    expect(matchesPattern(removePath, "RemovePath", {}, operative("build/cache"))).toBe(true);
    expect(matchesPattern(removePath, "RemovePath", {}, operative("src"))).toBe(false);
  }, 30_000);

  test("a proposal that can only be bare says BLANKET GRANT, in the text output too", async () => {
    seed([
      { name: "RemovePath", input: { path: "build/a" } },
      { name: "RemovePath", input: { path: "build/b" } },
      { name: "ClipboardWrite", input: { text: "hello" } },
    ]);
    const { stdout, exitCode } = await suggest(false);
    expect(exitCode).toBe(0);
    // The calls varied: a bare grant, and the reason with a narrower example.
    expect(stdout).toContain("alwaysAllow RemovePath\n");
    expect(stdout).toMatch(
      /BLANKET GRANT: this allows every RemovePath call — the approved calls acted on 2 different places; to allow only those, write one rule per place, e\.g\. RemovePath\(build\/a\)/,
    );
    // A tool with no scoping argument at all.
    expect(stdout).toMatch(
      /BLANKET GRANT: this allows every ClipboardWrite call — ClipboardWrite has no argument that decides where it acts/,
    );
    // And the diff line itself is flagged.
    expect(stdout).toContain(
      '+ { type: alwaysAllow, pattern: "RemovePath" } (⚠ BLANKET GRANT — every call of the tool)',
    );
  }, 30_000);
});

// The engine reads settings before the spec: an allow `--apply` writes to
// .crewhaus/settings.json decides every call it covers before the spec's own
// deny and ask rules are read. A proposal says which of them it overrides.
describe("crewhaus permissions suggest — an allow that would override the spec's guards", () => {
  const spec = (rules: string): void =>
    writeFileSync(
      join(cwd, "crewhaus.yaml"),
      `name: t\ntarget: cli\nagent:\n  model: m\n  instructions: tidy up\ntools: [removePath, bash]\npermissions:\n  rules:\n${rules}`,
    );
  const evidenceOf = (out: Json, pattern: string): string[] =>
    out.suggestions.find((s) => s.rule.pattern === pattern)?.evidence ?? [];

  test("a bare allow names every spec deny and ask on its tool", async () => {
    spec(
      '    - { type: alwaysDeny, pattern: "RemovePath(.git/**)" }\n    - { type: alwaysAsk, pattern: "RemovePath(src/**)" }\n    - { type: alwaysDeny, pattern: "Write(**)" }\n',
    );
    seed([
      { name: "RemovePath", input: { path: "build/a" } },
      { name: "RemovePath", input: { path: "build/b" } },
    ]);
    const out = JSON.parse((await suggest(true)).stdout) as Json;
    const overrides = evidenceOf(out, "RemovePath").filter((e) => e.startsWith("OVERRIDES"));
    expect(overrides).toEqual([
      "OVERRIDES alwaysDeny RemovePath(.git/**) (crewhaus.yaml): settings rules are read first, so the calls this allows would no longer reach that rule",
      "OVERRIDES alwaysAsk RemovePath(src/**) (crewhaus.yaml): settings rules are read first, so the calls this allows would no longer reach that rule",
    ]);
  }, 30_000);

  test("a scoped allow names only the guards that fire on its value", async () => {
    spec(
      '    - { type: alwaysDeny, pattern: "RemovePath(.git/**)" }\n    - { type: alwaysAsk, pattern: "RemovePath(build/**)" }\n',
    );
    seed([{ name: "RemovePath", input: { path: "build/cache", recursive: true } }]);
    const out = JSON.parse((await suggest(true)).stdout) as Json;
    const overrides = evidenceOf(out, "RemovePath(build/cache)").filter((e) =>
      e.startsWith("OVERRIDES"),
    );
    expect(overrides).toEqual([
      "OVERRIDES alwaysAsk RemovePath(build/**) (crewhaus.yaml): settings rules are read first, so the calls this allows would no longer reach that rule",
    ]);
  }, 30_000);

  test("the builtin floor's asks count, and the text output shows the line", async () => {
    seed([
      { name: "Bash", input: { command: "ls build" } },
      { name: "Bash", input: { command: "ls dist" } },
    ]);
    const { stdout } = await suggest(false);
    expect(stdout).toContain(
      "OVERRIDES alwaysAsk Bash(rm**) (the builtin floor): settings rules are read first",
    );
    expect(stdout).toContain("OVERRIDES alwaysAsk Bash(sudo**) (the builtin floor)");
  }, 30_000);

  test("a spec that cannot be read is said so, not treated as having no rules", async () => {
    writeFileSync(join(cwd, "crewhaus.yaml"), "name: t\ntarget: [not a target\n");
    seed([
      { name: "RemovePath", input: { path: "build/a" } },
      { name: "RemovePath", input: { path: "build/b" } },
    ]);
    const { stdout } = await suggest(false);
    expect(stdout).toMatch(
      /note: could not read the permission rules in crewhaus\.yaml \(.+\) — the proposals were not checked against its deny and ask rules/,
    );
    const json = JSON.parse((await suggest(true)).stdout) as { overrideCheck: unknown };
    expect(json.overrideCheck).toMatchObject({ spec: null, unread: expect.any(String) });
  }, 30_000);
});
