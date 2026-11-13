/**
 * Admission at loop start: in a process that serves a control plane (an intake root is
 * registered), a loop starts new work only while the operator record lets it. A refused
 * loop records nothing: no run row, no session log and no model call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import {
  type IntakeVerdict,
  registerIntakeRoot,
  unregisterIntakeRoot,
} from "@crewhaus/control-records";
import { EXIT_CODES, RunFailedError, isRunFailedError } from "@crewhaus/errors";
import type { LogFields, Logger } from "@crewhaus/logging";
import { createRunContext, retainRun } from "@crewhaus/run-context";
import { generateApprovalId } from "@crewhaus/session-store";
import { admitLoop, loopAdmission } from "./admission";
import { type RunChatLoopOptions, runChatLoop } from "./index";

const FEATURES = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
} as const;

const PAUSED_TEXT = "Paused by its operator; this message was not processed.";
const DISABLED_TEXT = "Disabled by its operator; this message was not processed.";

/** A model that answers "done" and counts its calls. */
function countingAdapter(): { adapter: ProviderAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      providerId: "anthropic",
      features: FEATURES,
      estimateTokens: () => 0,
      stream: () => {
        calls += 1;
        return (async function* () {
          yield { kind: "message_start" } as const;
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 10, output: 1 },
          } as const;
          yield { kind: "message_stop" } as const;
        })();
      },
    },
  };
}

const dirs: string[] = [];
const registered: string[] = [];

function harnessDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-admission-"));
  dirs.push(dir);
  return dir;
}

function serve(dir: string): void {
  registerIntakeRoot(dir);
  registered.push(dir);
}

afterEach(() => {
  for (const dir of registered.splice(0)) unregisterIntakeRoot(dir);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeOperator(dir: string, body: Record<string, unknown>): void {
  mkdirSync(join(dir, ".crewhaus", "run", "control"), { recursive: true });
  writeFileSync(
    join(dir, ".crewhaus", "run", "control", "operator.json"),
    `${JSON.stringify({ v: 1, rev: 1, desired: "running", ...body })}\n`,
  );
}

/** A logger that records each info line. */
function recordingLogger(): { logger: Logger; infos: Array<{ msg: string; fields?: LogFields }> } {
  const infos: Array<{ msg: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: () => {},
    info: (msg, fields) => {
      infos.push({ msg, ...(fields !== undefined ? { fields } : {}) });
    },
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return { logger, infos };
}

/** One single-turn loop in `dir`, its sessions and run rows kept inside it. */
async function loop(
  dir: string,
  model: ProviderAdapter,
  over: Partial<RunChatLoopOptions> = {},
): Promise<{ result?: string; caught?: unknown }> {
  try {
    const result = await runChatLoop({
      model: "test-model",
      instructions: "admission test",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "a message from a person" }],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
      sessionRootDir: join(dir, "sessions"),
      runLedgerDir: dir,
      _adapter: model,
      ...over,
    });
    return { result };
  } catch (caught) {
    return { caught };
  }
}

const runLedgerPath = (dir: string): string => join(dir, ".crewhaus", "run", "control", "runs");

describe("a process that serves no control plane", () => {
  test("runs a loop whatever the record says: the entry point decides there", async () => {
    const dir = harnessDir();
    writeOperator(dir, { intake: { paused: true } });
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, { sessionTarget: "channel" });
    expect(result).toBe("done");
    expect(model.calls()).toBe(1);
  });
});

describe("a channel turn while paused", () => {
  test("answers the fixed notice and records nothing: no model call, no session, no run row", async () => {
    const dir = harnessDir();
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const { logger, infos } = recordingLogger();
    const { result, caught } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      runContext: createRunContext({ logger }),
    });
    expect(caught).toBeUndefined();
    expect(result).toBe(PAUSED_TEXT);
    expect(model.calls()).toBe(0);
    expect(existsSync(join(dir, "sessions"))).toBe(false);
    expect(existsSync(runLedgerPath(dir))).toBe(false);
    expect(infos).toHaveLength(1);
    expect(infos[0]?.fields).toMatchObject({ code: "paused", sessionTarget: "channel" });
    expect(JSON.stringify(infos)).not.toContain("a message from a person");
  });

  test("a quiet pause answers an empty reply, which the router does not send", async () => {
    const dir = harnessDir();
    writeOperator(dir, { intake: { paused: true, notice: null } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, { sessionTarget: "channel" });
    expect(result).toBe("");
    expect(model.calls()).toBe(0);
  });

  test("an operator's own notice is the reply", async () => {
    const dir = harnessDir();
    writeOperator(dir, { intake: { paused: true, notice: "Back at noon." } });
    serve(dir);
    const { result } = await loop(dir, countingAdapter().adapter, { sessionTarget: "channel" });
    expect(result).toBe("Back at noon.");
  });
});

describe("any other loop while closed fails with the verdict's exit", () => {
  for (const sessionTarget of ["managed", undefined] as const) {
    test(`${sessionTarget ?? "an unset target"}: paused is class paused, exit 39; disabled is class disabled, exit 38`, async () => {
      for (const [block, cls, exit, text] of [
        [{ intake: { paused: true } }, "paused", EXIT_CODES.paused, PAUSED_TEXT],
        [{ deployment: { disabled: true } }, "disabled", EXIT_CODES.disabled, DISABLED_TEXT],
      ] as const) {
        const dir = harnessDir();
        writeOperator(dir, block);
        serve(dir);
        const model = countingAdapter();
        const { caught } = await loop(dir, model.adapter, {
          ...(sessionTarget !== undefined ? { sessionTarget } : {}),
        });
        expect(caught).toBeInstanceOf(RunFailedError);
        if (!isRunFailedError(caught)) throw new Error("not a RunFailedError");
        expect(caught.report).toEqual({
          class: cls,
          title: `${cls} by its operator`,
          detail: text,
          exitCode: exit,
        });
        expect(model.calls()).toBe(0);
        expect(existsSync(runLedgerPath(dir))).toBe(false);
        unregisterIntakeRoot(dir);
      }
    });
  }

  test("a quiet pause's failure carries the title as its detail", async () => {
    const dir = harnessDir();
    writeOperator(dir, { intake: { paused: true, notice: null } });
    serve(dir);
    const { caught } = await loop(dir, countingAdapter().adapter, { sessionTarget: "managed" });
    if (!isRunFailedError(caught)) throw new Error("not a RunFailedError");
    expect(caught.report.detail).toBe("paused by its operator");
    expect(caught.report.remediation).toBeUndefined();
  });
});

describe("a granted request re-drives its parked call once while paused", () => {
  const SESSION = "sess_00000000000000ab";

  function writeApprovals(dir: string, lines: readonly object[]): string {
    const root = join(dir, "sessions");
    mkdirSync(root, { recursive: true });
    const file = join(root, "approvals.jsonl");
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return file;
  }

  function granted(sessionId: string, over: { parkedAt?: string; always?: true } = {}) {
    const park = {
      id: generateApprovalId(),
      toolName: "Bash",
      inputHash: "h1",
      runId: "run_00000001",
      sessionId,
      surface: "channel",
      createdAt: over.parkedAt ?? new Date().toISOString(),
    };
    const grant = {
      ...park,
      decision: "grant",
      decidedBy: "max",
      decidedAt: new Date().toISOString(),
      ...(over.always === true ? { always: true } : {}),
    };
    return { park, grant };
  }

  /** A first turn while open, so the session exists to resume. */
  async function conversation(dir: string): Promise<string> {
    const first = await loop(dir, countingAdapter().adapter, {
      sessionTarget: "channel",
      runContext: createRunContext({ sessionId: SESSION }),
    });
    expect(first.result).toBe("done");
    return SESSION;
  }

  test("paused and a one-time grant waiting in the resumed session: the re-drive runs", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted(sessionId);
    writeApprovals(dir, [park, grant]);
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
    });
    expect(result).toBe("done");
    expect(model.calls()).toBe(1);
  });

  test("a grant admits one loop: the next message in the conversation is refused while the grant stays unconsumed", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted(sessionId);
    const file = writeApprovals(dir, [park, grant]);
    const before = readFileSync(file, "utf8");
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    // Admission reads the grants without writing them.
    expect(
      admitLoop({ sessionTarget: "channel", resume: { sessionId } }, () => join(dir, "sessions")),
    ).toEqual({ admit: true });
    expect(readFileSync(file, "utf8")).toBe(before);
    const model = countingAdapter();
    for (const content of ["a second message", "a third message"]) {
      const { result } = await loop(dir, model.adapter, {
        sessionTarget: "channel",
        resume: { sessionId },
        seedMessages: [{ role: "user", content }],
      });
      expect(result).toBe(PAUSED_TEXT);
    }
    expect(model.calls()).toBe(0);
    // The grant is still on disk, unconsumed: what refuses is that it already admitted a loop.
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("two one-time grants in the session admit two loops, and no third", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const first = granted(sessionId);
    const second = granted(sessionId);
    writeApprovals(dir, [first.park, first.grant, second.park, second.grant]);
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const results: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { result } = await loop(dir, model.adapter, {
        sessionTarget: "channel",
        resume: { sessionId },
      });
      results.push(result ?? "");
    }
    expect(results).toEqual(["done", "done", PAUSED_TEXT]);
    expect(model.calls()).toBe(2);
  });

  test("a standing (always) grant admits nothing while paused", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted(sessionId, { always: true });
    writeApprovals(dir, [park, grant]);
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
    });
    expect(result).toBe(PAUSED_TEXT);
    expect(model.calls()).toBe(0);
  });

  test("a grant parked before the approval store's retention window admits nothing", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const parkedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const { park, grant } = granted(sessionId, { parkedAt });
    writeApprovals(dir, [park, grant]);
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
    });
    expect(result).toBe(PAUSED_TEXT);
    expect(model.calls()).toBe(0);
  });

  test("a grant asked in another resume scope admits nothing", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted(sessionId);
    writeApprovals(dir, [park, grant]);
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
      runContext: createRunContext({ resumeScope: "session:sess_00000000000000cd" }),
    });
    expect(result).toBe(PAUSED_TEXT);
    expect(model.calls()).toBe(0);
  });

  test("the same grant once consumed: refused", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted(sessionId);
    const file = writeApprovals(dir, [
      park,
      grant,
      { ...grant, consumedAt: new Date().toISOString(), consumedByRun: "run_00000002" },
    ]);
    const before = readFileSync(file, "utf8");
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
    });
    expect(result).toBe(PAUSED_TEXT);
    expect(model.calls()).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a grant in another session does not admit this one", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted("sess_00000000000000cd");
    writeApprovals(dir, [park, grant]);
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const { result } = await loop(dir, countingAdapter().adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
    });
    expect(result).toBe(PAUSED_TEXT);
  });

  test("disabled, even with the granted request: refused", async () => {
    const dir = harnessDir();
    const sessionId = await conversation(dir);
    const { park, grant } = granted(sessionId);
    const file = writeApprovals(dir, [park, grant]);
    const before = readFileSync(file, "utf8");
    writeOperator(dir, { deployment: { disabled: true } });
    serve(dir);
    const model = countingAdapter();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "channel",
      resume: { sessionId },
    });
    expect(result).toBe(DISABLED_TEXT);
    expect(model.calls()).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("work already admitted continues while paused", () => {
  test("a child loop (its context names a parent) runs", async () => {
    const dir = harnessDir();
    writeOperator(dir, { intake: { paused: true } });
    serve(dir);
    const model = countingAdapter();
    const parent = createRunContext();
    const { result } = await loop(dir, model.adapter, {
      sessionTarget: "managed",
      runContext: createRunContext({ parent: parent.runId }),
    });
    expect(result).toBe("done");
    expect(model.calls()).toBe(1);
  });

  test("a later loop on a run this process admitted and still holds runs, paused or disabled", async () => {
    for (const block of [{ intake: { paused: true } }, { deployment: { disabled: true } }]) {
      const dir = harnessDir();
      writeOperator(dir, {});
      serve(dir);
      const model = countingAdapter();
      const ctx = createRunContext();
      // A crew or a graph holds its run across its loops.
      const release = retainRun(ctx);
      try {
        const first = await loop(dir, model.adapter, { sessionTarget: "managed", runContext: ctx });
        expect(first.result).toBe("done");
        writeOperator(dir, block);
        const later = await loop(dir, model.adapter, { sessionTarget: "managed", runContext: ctx });
        expect(later.result).toBe("done");
        expect(model.calls()).toBe(2);
      } finally {
        release();
        unregisterIntakeRoot(dir);
      }
    }
  });

  test("a run held before any of its loops was admitted is new work: its first loop is refused", async () => {
    for (const [block, cls] of [
      [{ intake: { paused: true } }, "paused"],
      [{ deployment: { disabled: true } }, "disabled"],
    ] as const) {
      const dir = harnessDir();
      writeOperator(dir, block);
      serve(dir);
      const model = countingAdapter();
      const ctx = createRunContext();
      // A crew or a graph takes its hold before its first role or node runs.
      const release = retainRun(ctx);
      try {
        const { caught } = await loop(dir, model.adapter, { runContext: ctx });
        if (!isRunFailedError(caught)) throw new Error("not a RunFailedError");
        expect(caught.report.class).toBe(cls);
        expect(model.calls()).toBe(0);
        expect(existsSync(runLedgerPath(dir))).toBe(false);
      } finally {
        release();
        unregisterIntakeRoot(dir);
      }
    }
  });
});

describe("loopAdmission, the pure decision", () => {
  const CLOSED: IntakeVerdict = {
    state: "closed",
    reasons: [{ kind: "operator", state: "paused" }],
    notice: PAUSED_TEXT,
    code: "paused",
    exitName: "paused",
  };

  test("reads nothing in a process that serves no plane, or for work already admitted", () => {
    let reads = 0;
    const inputs = {
      verdict: () => {
        reads += 1;
        return CLOSED;
      },
      grantWaiting: () => {
        reads += 1;
        return false;
      },
      sessionTarget: "channel",
    };
    expect(loopAdmission({ ...inputs, served: false, continuing: false })).toEqual({ admit: true });
    expect(loopAdmission({ ...inputs, served: true, continuing: true })).toEqual({ admit: true });
    expect(reads).toBe(0);
  });

  test("reads the grants only while paused, never while open or disabled", () => {
    let grantReads = 0;
    const grantWaiting = (): boolean => {
      grantReads += 1;
      return true;
    };
    const base = { served: true, continuing: false, grantWaiting, sessionTarget: "managed" };
    expect(loopAdmission({ ...base, verdict: () => ({ state: "open" }) })).toEqual({
      admit: true,
    });
    expect(grantReads).toBe(0);
    const disabled: IntakeVerdict = {
      ...CLOSED,
      code: "disabled",
      exitName: "disabled",
      notice: DISABLED_TEXT,
    };
    expect(loopAdmission({ ...base, verdict: () => disabled })).toMatchObject({
      admit: false,
      code: "disabled",
    });
    expect(grantReads).toBe(0);
    expect(loopAdmission({ ...base, verdict: () => CLOSED })).toEqual({ admit: true });
    expect(grantReads).toBe(1);
  });
});
