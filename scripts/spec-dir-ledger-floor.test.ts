/**
 * A run of a spec kept in another directory keeps that directory's whole run
 * directory on the runtime-state floor: its spec record, and the period ledger
 * and intake state a declared `budget.period` keeps there. The real `Write` and
 * `Edit` tools are refused there before any rule, as they are at the working
 * directory's own `.crewhaus/run`, while a file beside them stays writable.
 *
 * The run is entered as `crewhaus run <dir>/crewhaus.yaml` started elsewhere
 * enters it: under `runSpecDirScope`, with the ledger rooted at the spec's
 * directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../packages/adapter-anthropic/src/index";
import { openBudgetLedger, periodOf } from "../packages/control-records/src/budget";
import { type RuleSet, emptyRuleSet } from "../packages/permission-engine/src/index";
import { createRunContext } from "../packages/run-context/src/index";
import { runChatLoop, runSpecDirScope } from "../packages/runtime-core/src/index";
import { edit, write } from "../packages/tool-fs/src/index";
import type { TraceEvent } from "../packages/trace-event-bus/src/index";

/** What the floor's reason adds. */
const FLOOR = "no rule can allow that";
const PERIOD = { every: "month" as const, usdMicros: 1_000_000 };
const ALLOW_ALL: RuleSet = {
  ...emptyRuleSet,
  flag: [
    { type: "alwaysAllow", pattern: "Write(**)", source: "flag" },
    { type: "alwaysAllow", pattern: "Edit(**)", source: "flag" },
  ],
};

let home: string;
let base: string;
let workspace: string;
let specDir: string;
beforeEach(() => {
  home = process.cwd();
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-ledger-floor-")));
  workspace = join(base, "workspace");
  specDir = join(workspace, "bots", "bot");
  mkdirSync(specDir, { recursive: true });
  process.chdir(workspace);
});
afterEach(() => {
  process.chdir(home);
  rmSync(base, { recursive: true, force: true });
});

/** One call of `tool` with `input`, then a text turn. */
function adapter(tool: string, input: Record<string, unknown>): ProviderAdapter {
  let n = 0;
  return {
    providerId: "anthropic",
    features: { caching: false, tool_use: true, vision: false, thinking: false, web_search: false },
    estimateTokens: () => 0,
    stream() {
      const first = n++ === 0;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } } as const;
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "t1", name: tool, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 10, output: 5 },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 10, output: 5 },
          } as const;
        }
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

/** The decision the floor or a rule made for the one tool call. */
async function callOnce(
  tool: "Write" | "Edit",
  input: Record<string, unknown>,
): Promise<{ decision?: string; reason?: string }> {
  const runContext = createRunContext();
  let seen: { decision?: string; reason?: string } = {};
  runContext.eventBus.subscribe((e: TraceEvent) => {
    if (e.kind === "permission_decision") {
      const d = e as TraceEvent & { decision: string; reason?: string };
      seen = { decision: d.decision, ...(d.reason !== undefined ? { reason: d.reason } : {}) };
    }
  });
  await runSpecDirScope.run(specDir, () =>
    runChatLoop({
      model: "claude-haiku-4-5",
      instructions: "x",
      runContext,
      sessionRootDir: join(base, "sessions"),
      runLedgerDir: null,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "auto",
      permissionRules: ALLOW_ALL,
      settingsDir: null,
      tools: [write, edit],
      budget: { usdMicros: 900_000, onExceed: { kind: "stop" }, period: PERIOD },
      spendLedgerRoot: specDir,
      maxTokens: 100,
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      _adapter: adapter(tool, input),
    }),
  );
  return seen;
}

describe("a spec kept in another directory", () => {
  test("its period ledger and intake state are refused to Write and Edit before any rule", async () => {
    const periodId = periodOf(PERIOD, Date.now()).periodId;
    const control = join(specDir, ".crewhaus", "run", "control");
    // The run's own ledger exists in the spec's directory.
    await openBudgetLedger(specDir, PERIOD).settle({ id: "earlier", usdMicros: 1 });
    const segment = join(control, "budget", periodId, "000001.jsonl");
    expect(existsSync(segment)).toBe(true);
    const before = readFileSync(segment, "utf8");

    const topup = `${JSON.stringify({ v: 1, at: new Date().toISOString(), op: "topup", usdMicros: 9_000_000 })}\n`;
    for (const path of [
      join("bots", "bot", ".crewhaus", "run", "control", "budget", periodId, "000002.jsonl"),
      join("bots", "bot", ".crewhaus", "run", "control", "budget-state.json"),
    ]) {
      const r = await callOnce("Write", { path, content: topup });
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain(FLOOR);
      expect(existsSync(join(workspace, path))).toBe(false);
    }
    const edited = await callOnce("Edit", {
      path: join("bots", "bot", ".crewhaus", "run", "control", "budget", periodId, "000001.jsonl"),
      oldString: '"earlier"',
      newString: '"later"',
    });
    expect(edited.decision).toBe("deny");
    expect(edited.reason).toContain(FLOOR);
    // The runs' own reserve and settle lines follow; nothing the agent wrote does.
    const after = readFileSync(segment, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).not.toContain('"later"');
    expect(after).not.toContain('"topup"');
  }, 20_000); // three full loops, slow by construction on a loaded runner

  test("a file beside the run directory stays the rules' to decide", async () => {
    const path = join("bots", "bot", "notes.md");
    const r = await callOnce("Write", { path, content: "hello\n" });
    expect(r.decision).toBe("allow");
    expect(readFileSync(join(workspace, path), "utf8")).toBe("hello\n");
  }, 20_000); // a full loop, slow by construction on a loaded runner
});
