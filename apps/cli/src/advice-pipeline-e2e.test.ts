/**
 * Item 17 (completion) — ONE integration test for the whole telemetry-driven
 * tuning chain, at the CLI subprocess boundary:
 *
 *   seeded session with truncation recoveries
 *     → `crewhaus advise` emits the agent.max_tokens SpecPatch
 *     → `crewhaus optimize --from-advice` accepts it against a
 *       trivially-passing contains-grader eval
 *     → `--write-back` produces a spec with the bumped max_tokens and the
 *       provenance header.
 *
 * NO live model calls: the spec's model is `local/<m>@<url>` (credential-
 * free through the OpenAI-compatible adapter) pointed at an in-test
 * Bun.serve stub that answers every chat/completions call with a fixed
 * "PONG" SSE stream — deterministic, offline, and exercising the REAL
 * eval path (wireRunOnce → runChatLoop → adapter → grader).
 *
 * Follows advise-cli.test.ts's posture: stdout assertions are avoided
 * (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`) — assert
 * on exit codes and on-disk artifacts instead.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdviceDecisionsFile } from "./advice-apply";
import type { SuggestionsFile } from "./advise-rules";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-advice-e2e-"));
  TMP_ROOTS.push(dir);
  return dir;
}

// -------- the deterministic OpenAI-compatible SSE stub --------

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A fixed one-text-block completion ("PONG") in OpenAI chunk-stream wire
 *  format, terminated by a usage chunk + [DONE]. */
function sseBody(text: string): string {
  const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "stub" };
  const chunks = [
    sseChunk({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }),
    sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({
      ...base,
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    "data: [DONE]\n\n",
  ];
  return chunks.join("");
}

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname.endsWith("/chat/completions")) {
      return new Response(sseBody("PONG"), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  stub.stop(true);
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

// -------- fixtures --------

const SESSION = "sess_00000000000000ad";

function jsonl(lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

function line(kind: string, payload: unknown): unknown {
  return { ts: 1, version: 1, kind, payload };
}

/** Seed a root: a session with truncation recoveries, a spec on the stub
 *  model, and a contains-grader dataset the stub trivially passes. */
function seedHarness(root: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${SESSION}.jsonl`),
    jsonl([
      line("user_message", { content: "q" }),
      line("assistant_message", { content: [{ type: "text", text: "a" }] }),
      line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
      line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }),
    ]),
  );
  writeFileSync(
    join(root, "crewhaus.yaml"),
    [
      "name: hello",
      "target: cli",
      "agent:",
      `  model: local/stub@http://127.0.0.1:${stub.port}/v1`,
      "  instructions: reply PONG",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "dataset.jsonl"),
    [
      '{"id":"s1","input":"ping one","expected_output":"PONG"}',
      '{"id":"s2","input":"ping two","expected_output":"PONG"}',
    ].join("\n"),
  );
  writeFileSync(
    join(root, "graders.yaml"),
    "graders:\n  - name: pong\n    type: contains\n    substring: PONG\n",
  );
}

const OPTIMIZE_ARGS = [
  "optimize",
  "crewhaus.yaml",
  "--from-advice",
  "suggestions.json",
  "--dataset",
  "dataset.jsonl",
  "--graders",
  "graders.yaml",
  "--concurrency",
  "1",
];

describe("advisor pipeline end-to-end (items 15 + 17)", () => {
  test("seeded truncations → advise patch → from-advice accept → write-back with provenance", async () => {
    const root = newTempRoot();
    seedHarness(root);

    // 1. advise mines the truncation recoveries into a max_tokens patch
    //    (the nightly composition's `advise --all -o .`).
    expect((await runCli(["advise", "--all", "-o", "."], root)).exitCode).toBe(0);
    const suggestions = JSON.parse(
      readFileSync(join(root, "suggestions.json"), "utf-8"),
    ) as SuggestionsFile;
    expect(suggestions.suggestions).toHaveLength(1);
    expect(suggestions.suggestions[0]?.findingId).toBe("truncation-pressure");
    expect(suggestions.suggestions[0]?.patch).toMatchObject({
      target: "cli",
      path: ["agent", "max_tokens"],
      op: "add",
      value: 16384,
    });

    // 2. optimize --from-advice WITHOUT --write-back: the patch is
    //    accepted (equal pass rate, zero regressions) but the source spec
    //    is untouched — accept-then-write gating.
    const dryOut = join(root, "out-dry");
    expect((await runCli([...OPTIMIZE_ARGS, "-o", dryOut], root)).exitCode).toBe(0);
    expect(readFileSync(join(root, "crewhaus.yaml"), "utf-8")).not.toContain("max_tokens");

    const decisions = JSON.parse(
      readFileSync(join(dryOut, "advice", "decisions.json"), "utf-8"),
    ) as AdviceDecisionsFile;
    expect(decisions.evaluated).toBe(1);
    expect(decisions.accepted).toBe(1);
    expect(decisions.baseline.passRate).toBe(1);
    expect(decisions.decisions[0]).toMatchObject({
      index: 1,
      findingId: "truncation-pressure",
      status: "accepted",
      passRateBefore: 1,
      passRateAfter: 1,
    });
    // Per-patch eval dirs: one baseline + one candidate, both real runs.
    expect(existsSync(join(dryOut, "advice", "baseline", "results.json"))).toBe(true);
    expect(existsSync(join(dryOut, "advice", "patch-001", "results.json"))).toBe(true);
    // The composed accepted spec is saved as an artifact, already stamped.
    const patchedArtifact = readFileSync(join(dryOut, "advice", "patched.yaml"), "utf-8");
    expect(patchedArtifact).toContain("max_tokens: 16384");
    expect(patchedArtifact).toContain("# crewhaus optimize: runId opt_");

    // 3. Re-run WITH --write-back: the source spec now carries the bumped
    //    max_tokens and the advisor provenance header.
    const wbOut = join(root, "out-wb");
    expect((await runCli([...OPTIMIZE_ARGS, "--write-back", "-o", wbOut], root)).exitCode).toBe(0);
    const written = readFileSync(join(root, "crewhaus.yaml"), "utf-8");
    expect(written).toContain("max_tokens: 16384");
    expect(written).toContain("# crewhaus optimize: runId opt_");
    expect(written).toContain("# - mutator: advisor");
    // Comments/keys preserved by the CST round-trip: the rest of the spec
    // is intact and still parseable-by-name.
    expect(written).toContain("name: hello");
    expect(written).toContain("instructions: reply PONG");
    // Same accept-then-write conventions as the search path: the write-
    // back auto-registered the spec in the local registry.
    expect(existsSync(join(root, ".crewhaus", "specs"))).toBe(true);
  }, 120_000);

  test("doctor --context-pressure exits 0 on a pressured harness AND an empty dir", async () => {
    const root = newTempRoot();
    seedHarness(root);
    expect((await runCli(["doctor", "--context-pressure"], root)).exitCode).toBe(0);
    expect((await runCli(["doctor", "--context-pressure", "--sessions", "5"], root)).exitCode).toBe(
      0,
    );
    // Report, not gate: an empty dir (no sessions, no spec) still exits 0.
    const empty = newTempRoot();
    expect((await runCli(["doctor", "--context-pressure"], empty)).exitCode).toBe(0);
    // …but a malformed --sessions is a usage error.
    expect(
      (await runCli(["doctor", "--context-pressure", "--sessions", "0"], empty)).exitCode,
    ).toBe(1);
  });

  test("from-advice flag/file validation dies cleanly", async () => {
    const root = newTempRoot();
    seedHarness(root);
    // Mutually exclusive with the search knobs (checked before any eval).
    expect((await runCli([...OPTIMIZE_ARGS, "--mutator", "claude"], root)).exitCode).toBe(1);
    expect((await runCli([...OPTIMIZE_ARGS, "--iterations", "3"], root)).exitCode).toBe(1);
    // Missing and malformed suggestion files.
    expect((await runCli([...OPTIMIZE_ARGS], root)).exitCode).toBe(1); // no suggestions.json yet
    writeFileSync(join(root, "suggestions.json"), "not json {");
    expect((await runCli([...OPTIMIZE_ARGS], root)).exitCode).toBe(1);
    // A patch outside OPTIMIZABLE_PATHS is rejected per-patch (exit 0 —
    // the run completes with 0 accepted and records the rejection).
    writeFileSync(
      join(root, "suggestions.json"),
      JSON.stringify({
        generatedAt: "2026-07-02T00:00:00Z",
        sessionIds: [SESSION],
        suggestions: [
          {
            findingId: "sneaky",
            severity: "warn",
            summary: "widen permissions",
            patch: { target: "cli", path: ["permissions", "mode"], op: "add", value: "auto" },
          },
        ],
      }),
    );
    const out = join(root, "out-rejected");
    expect((await runCli([...OPTIMIZE_ARGS, "--write-back", "-o", out], root)).exitCode).toBe(0);
    const decisions = JSON.parse(
      readFileSync(join(out, "advice", "decisions.json"), "utf-8"),
    ) as AdviceDecisionsFile;
    expect(decisions.accepted).toBe(0);
    expect(decisions.decisions[0]?.status).toBe("rejected");
    expect(decisions.decisions[0]?.reason).toContain("OPTIMIZABLE_PATHS");
    // Even with --write-back, a 0-accepted run leaves the spec untouched.
    expect(readFileSync(join(root, "crewhaus.yaml"), "utf-8")).not.toContain("permissions");
  }, 120_000);
});
