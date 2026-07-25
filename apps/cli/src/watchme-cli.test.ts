/**
 * CLI integration tests for `crewhaus watchme` (design/watch-me.md §11/§14).
 * Bun.spawn against the real entry file with a MINIMAL env ({PATH, HOME=tmp})
 * and mkdtemp cwds; `--root` is always passed (CI sandboxes / multi-user
 * machines never touch the real ~/.crewhaus/watchme). Everything here is
 * fully offline: reports are deterministic-only (no judge budget), and the
 * `run` capture test uses a `local/` model whose localhost endpoint fails
 * fast without credentials or external network.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_SECTION_TITLES } from "./watchme-report";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-cli-watchme-${label}-`));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  home: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const SESSION_ID = "sess_00000000000000a1";

/** A minimal watchable harness: a cli spec + one seeded session whose durable
 *  mirrors (cost_accrual / tool events) drive the ordered-attribution path —
 *  the fully offline retro-analysis grade. */
function writeHarness(dir: string): void {
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    [
      "name: watched",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: |",
      "    You are a helpful assistant.",
      "",
    ].join("\n"),
  );
  const sessionsDir = join(dir, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const events = [
    { kind: "user_message", payload: { content: "what is the weather in paris" } },
    { kind: "model_meta", payload: { model: "claude-sonnet-4-6" } },
    {
      kind: "cost_accrual",
      payload: {
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
        specModel: "claude-sonnet-4-6",
        inputTokens: 120,
        outputTokens: 40,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
        costUsdMicros: 900,
      },
    },
    { kind: "tool_use", payload: { id: "tu_1", name: "WebSearch" } },
    {
      kind: "tool_result",
      payload: { toolUseId: "tu_1", isError: false, content: "sunny in paris today" },
    },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "It is sunny in Paris today." }] },
    },
  ];
  writeFileSync(
    join(sessionsDir, `${SESSION_ID}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

function reportDirs(dir: string): string[] {
  const reportsRoot = join(dir, ".crewhaus", "watchme", "reports");
  if (!existsSync(reportsRoot)) return [];
  return readdirSync(reportsRoot)
    .sort()
    .map((name) => join(reportsRoot, name));
}

describe("crewhaus watchme (design/watch-me.md §11)", () => {
  test("top-level usage mentions the watchme subcommand", async () => {
    const home = newTempDir("home");
    const result = await runCli(["--help"], home, home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("watchme start|stop|status");
    expect(result.stdout).toContain("watchme report [--all]");
    expect(result.stdout).toContain("watchme synthesize");
    expect(result.stdout).toContain("watchme publish");
  });

  test("an unknown action dies with the exact negative-space message", async () => {
    const home = newTempDir("home");
    const result = await runCli(["watchme", "bogus"], home, home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'crewhaus: watchme action must be one of: start, stop, status, report, intents, synthesize, publish (got "bogus")',
    );
  });

  test("-h in the action slot routes to help (stdout, exit 0)", async () => {
    const home = newTempDir("home");
    const result = await runCli(["watchme", "-h"], home, home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: crewhaus watchme start");
    // Help routes to stdout, not stderr. Don't assert stderr is empty — the
    // anthropic adapter emits a benign fallback-version warning to stderr when
    // no `claude` CLI is installed (e.g. on CI runners).
    expect(result.stderr).not.toContain("usage:");
  });

  test("start flips state, registers the harness, and backfills a report", async () => {
    const harness = newTempDir("start");
    const home = newTempDir("home");
    const globalRoot = newTempDir("root");
    writeHarness(harness);

    const result = await runCli(["watchme", "start", "--root", globalRoot], harness, home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("watching watched (capture: full)");

    // state.json flipped.
    const state = JSON.parse(
      readFileSync(join(harness, ".crewhaus", "watchme", "state.json"), "utf-8"),
    );
    expect(state.watching).toBe(true);
    // Registered in the global (--root) registry.
    const registry = JSON.parse(readFileSync(join(globalRoot, "harnesses.json"), "utf-8"));
    expect(registry.harnesses.map((h: { specName: string }) => h.specName)).toContain("watched");
    // The immediate deterministic backfill wrote its artifacts.
    const dirs = reportDirs(harness);
    expect(dirs.length).toBe(1);
    expect(existsSync(join(dirs[0] as string, "report.json"))).toBe(true);
    expect(
      readFileSync(join(harness, ".crewhaus", "watchme", "observations.jsonl"), "utf-8")
        .trim()
        .split("\n").length,
    ).toBe(1);
  }, 120_000);

  test("report writes the five sections + suggestions + fewshot pool, fully offline, window-idempotent", async () => {
    const harness = newTempDir("report");
    const home = newTempDir("home");
    const globalRoot = newTempDir("root");
    writeHarness(harness);

    const first = await runCli(["watchme", "report", "--root", globalRoot], harness, home);
    expect(first.exitCode).toBe(0);
    const dirs = reportDirs(harness);
    expect(dirs.length).toBe(1);
    const outDir = dirs[0] as string;
    for (const name of [
      "report.json",
      "report.md",
      "suggestions.json",
      "fewshot-candidates.json",
    ]) {
      expect(existsSync(join(outDir, name))).toBe(true);
    }
    // The abs report path is printed (eval-report gotcha).
    expect(first.stdout).toContain(join(outDir, "report.json"));
    const md = readFileSync(join(outDir, "report.md"), "utf-8");
    for (const title of REPORT_SECTION_TITLES) {
      expect(md).toContain(`## ${title}`);
    }
    const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf-8"));
    expect(report.window.sessionsAnalyzed).toBe(1);
    expect(report.models.length).toBeGreaterThan(0);

    // Second report: the watermark makes the window idempotent — nothing is
    // re-analyzed and the observation store does not double-append.
    const second = await runCli(
      ["watchme", "report", "--root", globalRoot, "--json"],
      harness,
      home,
    );
    expect(second.exitCode).toBe(0);
    const secondReport = JSON.parse(second.stdout);
    expect(secondReport.window.sessionsAnalyzed).toBe(0);
    expect(secondReport.totals.observations).toBe(1);
    expect(
      readFileSync(join(harness, ".crewhaus", "watchme", "observations.jsonl"), "utf-8")
        .trim()
        .split("\n").length,
    ).toBe(1);
  }, 120_000);

  test("report with no sessions dies with the one-liner", async () => {
    const harness = newTempDir("empty");
    const home = newTempDir("home");
    const globalRoot = newTempDir("root");
    writeFileSync(
      join(harness, "crewhaus.yaml"),
      "name: watched\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\n",
    );
    const result = await runCli(["watchme", "report", "--root", globalRoot], harness, home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no sessions to analyze — run the harness first");
  }, 120_000);

  test("publish --dry-run prints the co-learning articles without writing", async () => {
    const harness = newTempDir("publish");
    const home = newTempDir("home");
    const globalRoot = newTempDir("root");
    writeHarness(harness);
    // A report first, so the long-horizon store has observations to distill.
    const report = await runCli(["watchme", "report", "--root", globalRoot], harness, home);
    expect(report.exitCode).toBe(0);

    const result = await runCli(["watchme", "publish", "--dry-run"], harness, home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would publish watchme-intents");
    expect(result.stdout).toContain("would publish watchme-model-fit");
    expect(result.stdout).toContain("would publish watchme-pitfalls");
    expect(result.stdout).toContain("never auto-applied");
    // Dry-run writes nothing.
    expect(existsSync(join(harness, ".crewhaus", "wiki"))).toBe(false);
  }, 120_000);

  test("budgeted judge sessions are isolated from .crewhaus/sessions and never re-ingested (design/watch-me.md §7)", async () => {
    const harness = newTempDir("judge-isolation");
    const home = newTempDir("home");
    const globalRoot = newTempDir("root");
    writeHarness(harness);
    // Add a PRICED, budgeted judge. Offline its model call fails fast, but the
    // judge SESSION must be created in the isolated judge-sessions root — never
    // in .crewhaus/sessions, where the next report would re-ingest it as
    // harness traffic (polluting model tables + leaking judged-turn text).
    writeFileSync(
      join(harness, "crewhaus.yaml"),
      [
        "name: watched",
        "target: cli",
        "watchme:",
        "  enabled: true",
        "  judge:",
        "    model: claude-haiku-4-5",
        "    sample_rate: 1",
        "    budget_usd: 0.01",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: |",
        "    You are a helpful assistant.",
        "",
      ].join("\n"),
    );
    const sessionsDir = join(harness, ".crewhaus", "sessions");
    const sessionLogs = (): string[] =>
      readdirSync(sessionsDir)
        .filter((f) => /^sess_[0-9a-f]{16}\.jsonl$/.test(f))
        .sort();
    expect(sessionLogs()).toEqual([`${SESSION_ID}.jsonl`]);

    const first = await runCli(
      ["watchme", "report", "--root", globalRoot, "--json"],
      harness,
      home,
    );
    expect(first.exitCode).toBe(0);
    const firstReport = JSON.parse(first.stdout);
    // The judge was ENGAGED (priced model attempted, then failed offline), so a
    // judge session was really created — not skipped/refused into a no-op.
    expect(firstReport.judge?.model).toBe("claude-haiku-4-5");
    expect(firstReport.judge?.outcome).toBe("failed");

    // .crewhaus/sessions STILL holds only the original session — no judge
    // sess_*.jsonl leaked in (the isolated root is the whole point).
    expect(sessionLogs()).toEqual([`${SESSION_ID}.jsonl`]);
    const judgeDir = join(harness, ".crewhaus", "watchme", "judge-sessions");
    if (existsSync(judgeDir)) {
      for (const f of readdirSync(judgeDir).filter((n) => n.endsWith(".jsonl"))) {
        expect(sessionLogs()).not.toContain(f);
      }
    }

    // A second report ingests ZERO judge sessions: the observation store
    // references only the original harness session.
    const second = await runCli(
      ["watchme", "report", "--root", globalRoot, "--json"],
      harness,
      home,
    );
    expect(second.exitCode).toBe(0);
    const obsIds = new Set(
      readFileSync(join(harness, ".crewhaus", "watchme", "observations.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => (JSON.parse(l) as { sessionId: string }).sessionId),
    );
    expect([...obsIds]).toEqual([SESSION_ID]);
  }, 120_000);

  test("report --all recalls co-learning findings ONLY from peers that opted into sharing", async () => {
    const alpha = newTempDir("alpha");
    const beta = newTempDir("beta");
    const consumer = newTempDir("consumer");
    const home = newTempDir("home");
    const globalRoot = newTempDir("root");
    const writeSharingHarness = (dir: string, name: string, share: boolean): void => {
      writeHarness(dir); // seeds crewhaus.yaml + one session
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          `name: ${name}`,
          "target: cli",
          "watchme:",
          "  enabled: true",
          `  share: ${share}`,
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: |",
          "    You are a helpful assistant.",
          "",
        ].join("\n"),
      );
    };
    writeSharingHarness(alpha, "alpha", true);
    writeSharingHarness(beta, "beta", false);

    // start registers each harness (capturing watchme.share) + backfills
    // observations; publish distills them into the LOCAL wiki.
    expect((await runCli(["watchme", "start", "--root", globalRoot], alpha, home)).exitCode).toBe(
      0,
    );
    const pubA = await runCli(["watchme", "publish"], alpha, home);
    expect(pubA.stdout).toContain("published watchme-intents");
    expect((await runCli(["watchme", "start", "--root", globalRoot], beta, home)).exitCode).toBe(0);
    const pubB = await runCli(["watchme", "publish"], beta, home);
    expect(pubB.stdout).toContain("published watchme-intents");

    // Both registered; the share flag persisted per harness.
    const registry = JSON.parse(readFileSync(join(globalRoot, "harnesses.json"), "utf-8")) as {
      harnesses: Array<{ specName: string; share?: boolean }>;
    };
    const byName = new Map(registry.harnesses.map((h) => [h.specName, h]));
    expect(byName.get("alpha")?.share).toBe(true);
    expect(byName.get("beta")?.share).toBe(false);

    // Cross-harness roll-up + recall from a third dir: only the opted-in peer's
    // articles come back; the share:false peer is NOT recalled.
    const all = await runCli(
      ["watchme", "report", "--all", "--root", globalRoot, "--json"],
      consumer,
      home,
    );
    expect(all.exitCode).toBe(0);
    const report = JSON.parse(all.stdout) as {
      peers: Array<{ agentName: string }>;
    };
    expect(report.peers.length).toBeGreaterThan(0);
    expect(report.peers.every((p) => p.agentName === "alpha")).toBe(true);
    expect(report.peers.some((p) => p.agentName === "beta")).toBe(false);

    // intents --all is harness-tagged (design §1(b)): the combined digest
    // gains a per-harness attribution section in both output modes.
    const intentsJson = await runCli(
      ["watchme", "intents", "--all", "--root", globalRoot, "--json"],
      consumer,
      home,
    );
    expect(intentsJson.exitCode).toBe(0);
    const tagged = JSON.parse(intentsJson.stdout) as {
      totalTurns: number;
      harnesses: Array<{ specName: string; turns: number; sessions: number }>;
    };
    const taggedByName = new Map(tagged.harnesses.map((h) => [h.specName, h]));
    expect(taggedByName.get("alpha")?.turns).toBeGreaterThan(0);
    expect(taggedByName.get("beta")?.turns).toBeGreaterThan(0);

    const intentsText = await runCli(
      ["watchme", "intents", "--all", "--root", globalRoot],
      consumer,
      home,
    );
    expect(intentsText.exitCode).toBe(0);
    expect(intentsText.stdout).toContain("PER-HARNESS");
    expect(intentsText.stdout).toContain("- alpha — ");
    expect(intentsText.stdout).toContain("- beta — ");
  }, 120_000);

  test("run with a watchme-enabled spec writes the .events.jsonl sibling", async () => {
    const harness = newTempDir("run");
    const home = newTempDir("home");
    // A `local/` model resolves without credentials; its localhost endpoint
    // fails fast (connection refused / unknown model), which still exercises
    // the capture tap — bus-only kinds flow before/around the model call.
    writeFileSync(
      join(harness, "crewhaus.yaml"),
      [
        "name: watched-run",
        "target: cli",
        "watchme:",
        "  enabled: true",
        "agent:",
        "  model: local/llama3.2",
        "  instructions: |",
        "    You are a test agent.",
        "",
      ].join("\n"),
    );
    // The run fails at the model call (offline) — the capture artifact is the
    // assertion, not the exit code.
    await runCli(["run", "crewhaus.yaml", "--prompt", "hi"], harness, home);
    const sessionsDir = join(harness, ".crewhaus", "sessions");
    const siblings = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter((f) => f.endsWith(".events.jsonl"))
      : [];
    expect(siblings.length).toBeGreaterThan(0);
    const firstLine = readFileSync(join(sessionsDir, siblings[0] as string), "utf-8")
      .split("\n")
      .find((l) => l.trim() !== "");
    expect(firstLine).toBeDefined();
    const parsed = JSON.parse(firstLine as string);
    expect(typeof parsed.kind).toBe("string");
    // Envelope fields ride every captured line (exact-attribution join keys).
    expect(typeof parsed.sessionId).toBe("string");
  }, 120_000);
});
