/**
 * `crewhaus dream run|status|init` (v0.3.0 PR 14, design §6.3): the output
 * shape against the design transcript, the model-phase budget threading
 * (item-27 option mapping), and the scaffold verb.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@crewhaus/infra-utils";
import type { DreamRunReport } from "@crewhaus/memory-service";
import {
  DREAM_CLI_SCHEMA,
  type DreamChatLoopOptions,
  buildDreamModelPhase,
  renderDreamRunReport,
  runDreamCommand,
} from "./dream-cli";

let tmp: string;
let prevCwd: string;
let stdoutLines: string[];
let restoreStdout: (() => void) | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dream-cli-"));
  prevCwd = process.cwd();
  process.chdir(tmp);
  stdoutLines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  restoreStdout = () => {
    process.stdout.write = original;
  };
});

afterEach(() => {
  restoreStdout?.();
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const SPEC_YAML = `name: support-bot
target: cli
agent:
  model: claude-haiku-4-5
  instructions: help users
memory:
  dream:
    every: 24h
    mode: deterministic
`;

function stdout(): string {
  return stdoutLines.join("");
}

describe("renderDreamRunReport — the §6.3 output shape", () => {
  const report: DreamRunReport = {
    specName: "support-bot",
    trigger: "cli",
    phase: "full",
    outcome: "full",
    startedAt: "2026-07-13T19:04:12.000Z",
    durationMs: 41_000,
    windowKey: "dream:support-bot:20648",
    cached: false,
    phase1: {
      counts: {
        sessionsIndexed: 12,
        factsBefore: 214,
        factsAfter: 187,
        factsSwept: 4,
        factsSuperseded: 27,
        factsStale: 9,
        wikiStale: 3,
        proofsChecked: 5,
        proofsUnverifiable: 0,
        sessionsPinned: 3,
        openPlans: 2,
        trashPurged: 1,
      },
      findings: [],
    },
    model: {
      model: "claude-haiku-4-5",
      budgetUsd: 0.5,
      ran: true,
      sessionId: "sess_00000000000000dd",
      spentUsd: 0.11,
      actions: [
        { toolUseId: "tu_1", toolName: "wiki_write", detail: '"csv-delimiter-conventions"' },
        { toolUseId: "tu_2", toolName: "wiki_set_signals", detail: '"retry-backoff-defaults"' },
      ],
      evidence: ["tu_1", "tu_2"],
    },
    nextDueAt: "2026-07-14T19:04:12.000Z",
  };

  test("header, deterministic ✓ lines, model section, done-in footer", () => {
    const lines = renderDreamRunReport(report);
    expect(lines[0]).toBe("crewhaus dream — support-bot");
    expect(lines[1]).toBe("  deterministic");
    expect(lines).toContain("    ✓ session summaries  12 sessions → indexed");
    expect(lines).toContain("    ✓ fact dedupe        214 → 187 (27 superseded)");
    expect(lines).toContain("    ✓ fact decay         9 facts >90d flagged stale");
    expect(lines).toContain("    ✓ proof freeze       5 checked · 3 sessions pinned before TTL");
    expect(lines).toContain("    ✓ wiki staleness     3 articles unverified >30d");
    expect(lines).toContain("    ✓ focus refresh      next-actions rebuilt from 2 open plans");
    expect(lines).toContain("    ✓ trash purge        1 snapshot past the 7d undo window");
    expect(lines).toContain("  model (claude-haiku-4-5 · cap $0.50)");
    expect(lines).toContain('    ✓ wiki_write "csv-delimiter-conventions"');
    expect(lines.at(-1)).toBe("  done in 41s · spent $0.11 · next due 2026-07-14T19:04Z");
  });

  test("a refused model phase renders the refusal", () => {
    const refused = {
      ...report,
      outcome: "model_refused_unpriced" as const,
      model: {
        model: "made-up-9000",
        budgetUsd: 0.5,
        ran: false,
        refusal: "dream: unpriced",
        actions: [],
        evidence: [],
      },
    };
    const lines = renderDreamRunReport(refused);
    expect(lines.some((l) => l.includes("REFUSED — dream: unpriced"))).toBe(true);
  });
});

describe("buildDreamModelPhase — item-27 budget threading", () => {
  test("maps budget_usd to usdMicros/stop, singleTurn dream session, capped tool loop", async () => {
    const captured: DreamChatLoopOptions[] = [];
    const phase = buildDreamModelPhase({
      model: "claude-haiku-4-5",
      specName: "support-bot",
      fragment: { specName: "support-bot", memory: {} },
      cwd: tmp,
      chatLoop: async (opts) => {
        captured.push(opts);
        return "consolidated.";
      },
    });
    const result = await phase.run({
      playbook: "the playbook",
      prompt: "the findings",
      budgetUsd: 0.5,
      maxToolIterations: 30,
    });
    expect(captured).toHaveLength(1);
    const opts = captured[0];
    expect(opts?.budget).toEqual({ usdMicros: 500_000, onExceed: { kind: "stop" } });
    expect(opts?.singleTurn).toBe(true);
    expect(opts?.sessionTarget).toBe("dream");
    expect(opts?.maxToolIterations).toBe(30);
    expect(opts?.instructions).toBe("the playbook");
    expect(opts?.seedMessages).toEqual([{ role: "user", content: "the findings" }]);
    // The memory-fabric tools were wired into the session's tool list.
    expect(opts?.tools.map((t) => t.name)).toEqual(["Remember", "Recall", "MemoryForget"]);
    expect(result.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
    expect(result.spentUsd).toBe(0); // no cost events flowed in the fake
    expect(result.summary).toBe("consolidated.");
  });
});

describe("runDreamCommand — verbs end to end (deterministic spec)", () => {
  test("run prints the §6.3 shape and status reflects the run", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), SPEC_YAML);
    await runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "run");
    const out = stdout();
    expect(out).toContain("crewhaus dream — support-bot");
    expect(out).toContain("  deterministic");
    expect(out).toContain("✓ session summaries");
    expect(out).toContain("✓ trash purge");
    expect(out).toContain("(mode deterministic — no model phase)");
    expect(out).toMatch(/ {2}done in \d+(\.\d+)?s · next due \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/);
    // State landed under .crewhaus/dream/<spec>/.
    expect(existsSync(join(tmp, ".crewhaus", "dream", "support-bot", "state.json"))).toBe(true);

    stdoutLines.length = 0;
    await runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "status");
    const statusOut = stdout();
    expect(statusOut).toContain("crewhaus dream — support-bot");
    expect(statusOut).toContain("every 1d · mode deterministic · budget $0.00");
    expect(statusOut).toContain("last run");
    expect(statusOut).toContain("(deterministic)");
  });

  test("a second run in the same window reports the cached window", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), SPEC_YAML);
    await runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "run");
    stdoutLines.length = 0;
    await runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "run");
    expect(stdout()).toContain("already consolidated");
  });

  test("a spec without memory.dream dies with an instructive error", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: plain\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
    );
    await expect(
      runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "run"),
    ).rejects.toThrow(/declares no memory\.dream schedule/);
  });

  test("init scaffolds the cron workflow with the odd-minute convention", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), SPEC_YAML);
    await runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "init");
    const wfPath = join(tmp, ".github", "workflows", "crewhaus-dream.yml");
    expect(existsSync(wfPath)).toBe(true);
    const yaml = readFileSync(wfPath, "utf-8");
    expect(yaml).toContain('- cron: "19 4 * * *"'); // 24h cadence → nightly, odd minute
    expect(yaml).toContain("workflow_dispatch: {}");
    expect(yaml).toContain("crewhaus dream run crewhaus.yaml");
    expect(stdout()).toContain("wrote ");
    // Refuses to overwrite without --force.
    await expect(
      runDreamCommand(parseArgs(["crewhaus.yaml"], DREAM_CLI_SCHEMA), "init"),
    ).rejects.toThrow(/--force/);
    await runDreamCommand(parseArgs(["crewhaus.yaml", "--force"], DREAM_CLI_SCHEMA), "init");
  });
});
