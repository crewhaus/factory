/**
 * `crewhaus runs resume <grun_…> --decision`: a paused graph run's build is started once
 * with the decision, under a receipt and a run of its own; every refusal is made before
 * anything is written or started; and asking whether a run waits creates nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESUME_CHECKPOINT_ENV, createCheckpointStore } from "@crewhaus/checkpoint-store";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import { readPage, runsLedger } from "@crewhaus/control-records";
import {
  type ApiRunInput,
  GRAPH_RESUME_CHECKPOINT_ENV,
  type StartResult,
} from "@crewhaus/harness-supervisor";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { directControl } from "./daemon-cmd";
import {
  GRAPH_DECISION_MAX_BYTES,
  GRAPH_RESUME_AGENT_REFUSAL,
  graphDecisionProblem,
  graphRunWaiting,
} from "./graph-resume";
import { runRunsCommand } from "./runs-cmd";

const GRUN = "grun_0123456789abcdef";

let base: string;
let dir: string;
let env: Record<string, string>;
let starts: ApiRunInput[];

function build(compiledWith: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "agent.ts"), "// bundle\n");
  writeFileSync(
    join(dir, "dist", "package.json"),
    JSON.stringify({
      name: "crewhaus-compiled-bundle",
      crewhaus: { specHash: "x", compiledWith },
    }),
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-graph-resume-")));
  dir = join(base, "alpha");
  mkdirSync(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), "name: alpha\ntarget: graph\n");
  build("0.9.0");
  env = {
    CREWHAUS_HANGAR_ROOT: join(base, "hangar"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_NO_REGISTRY: "1",
  };
  starts = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const store = () => createCheckpointStore({ rootDir: join(dir, ".crewhaus", "graphs") });

/** A run paused at its one checkpoint, as graph-engine leaves it. */
async function paused(): Promise<string> {
  const saved = await store().save({ graphRunId: GRUN, nodeName: "review", state: {} });
  await store().markWaiting(GRUN, {
    checkpointId: saved.id,
    nodeName: "review",
    prompt: "Ship it?",
  });
  return saved.id;
}

const resume = (
  argv: readonly string[],
  over: { env?: Record<string, string>; start?: StartResult } = {},
) =>
  runRunsCommand(["resume", ...argv], {
    env: over.env ?? env,
    cwd: dir,
    control: () => directControl({ env, cwd: dir }),
    home: () => ({
      startRunJob: async (_dir, apiRun) => {
        starts.push(apiRun);
        return over.start ?? { ok: true, runId: "run_0000000000000001", pid: 1 };
      },
    }),
  });

/** Every path under `root` with its bytes, for a no-write check. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        out[`${path}/`] = "";
        walk(path);
      } else out[path] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

const runRows = () =>
  readPage(runsLedger(dir), { limit: 100 })
    .items.map((item) => item.record)
    .reverse();

/** The receipts the harness's own command ledger holds, newest state per command. */
function receipts(): Array<Record<string, unknown>> {
  const at = join(dir, ".crewhaus", "run", "control", "commands");
  const newest = new Map<string, Record<string, unknown>>();
  for (const name of readdirSync(at)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(at, name), "utf8").split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      newest.set(String(row["id"]), { ...newest.get(String(row["id"])), ...row });
    }
  }
  return [...newest.values()];
}

describe("crewhaus runs resume <grun_…>", () => {
  test("starts the build once with the decision, under a run and a receipt of its own", async () => {
    const ckpt = await paused();
    const out = await resume([GRUN, "--decision", "approve", "--harness", dir]);
    expect(out.exitCode).toBe(0);
    expect(starts).toHaveLength(1);
    const runId = starts[0]?.runId as string;
    // Bound to the pause it read as waiting: the build resumes there, or nowhere.
    expect(starts[0]).toEqual({
      runId,
      graphResume: { grun: GRUN, ckpt, decision: "approve" },
    });
    expect(out.lines[0]).toBe(`${GRUN} resumes as run ${runId}`);
    const rows = runRows().filter((row) => row["id"] === runId);
    expect(rows.map((row) => row["state"])).toEqual(["queued"]);
    const [receipt, ...others] = receipts();
    expect(others).toEqual([]);
    expect(receipt).toMatchObject({ kind: "graphs.resume", state: "succeeded", via: "cli" });
    expect(rows[0]).toMatchObject({ cmd: receipt?.["id"], by: receipt?.["actor"] });
    // What was decided is the run's own business, not its records'.
    expect(JSON.stringify([rows, receipt])).not.toContain("approve");
  });

  test("a person's own words are a decision on the command line", async () => {
    const ckpt = await paused();
    const out = await resume(["--decision", "approve, but shorter", GRUN]);
    expect(out.exitCode).toBe(0);
    expect(starts.map((s) => s.graphResume)).toEqual([
      { grun: GRUN, ckpt, decision: "approve, but shorter" },
    ]);
  });

  test("a verdict names the pause it was made on, and is carried out only there", async () => {
    const ckpt = await paused();
    const out = await resume([GRUN, "--checkpoint", ckpt, "--decision", "reject"]);
    expect(out.exitCode).toBe(0);
    expect(starts.map((s) => s.graphResume)).toEqual([{ grun: GRUN, ckpt, decision: "reject" }]);
    // The CLI and the build's engine name the pause by one env.
    expect(GRAPH_RESUME_CHECKPOINT_ENV).toBe(RESUME_CHECKPOINT_ENV);
  });

  test("a verdict queued for one pause, after another resume moved the run to the next, is refused with nothing claimed", async () => {
    // Paused at A; someone else resumed A (a reject that loops), and the run waits at A'.
    const a = await paused();
    expect(await store().claimResume(GRUN, a)).toBe("claimed");
    const next = await store().save({ graphRunId: GRUN, nodeName: "review", state: {} });
    await store().markWaiting(GRUN, { checkpointId: next.id, nodeName: "review", prompt: "?" });
    const before = treeOf(base);
    // The job Home queued for A runs now.
    const out = await resume([GRUN, "--checkpoint", a, "--decision", "approve"]);
    expect(out.exitCode).toBe(EXIT_FOR_ERROR.already_decided);
    expect(out.lines[0]).toBe(`runs resume: the pause at ${a} in ${GRUN} was already decided`);
    expect(starts).toEqual([]);
    expect(treeOf(base)).toEqual(before);
    expect(await graphRunWaiting(dir, GRUN)).toEqual({ state: "waiting", ckpt: next.id });
  });

  test("a start that fails ends the run it queued, and says why", async () => {
    await paused();
    const out = await resume([GRUN, "--decision", "reject"], {
      start: { ok: false, reason: "plan-failed", stage: "spawn", error: new Error("no bun here") },
    });
    expect(out.exitCode).toBe(EXIT_FOR_ERROR.unavailable);
    expect(out.lines[0]).toBe(`runs resume: ${GRUN} was not resumed: no bun here`);
    expect(runRows().map((row) => row["state"])).toEqual(["queued", "cancelled"]);
    expect(receipts().map((r) => r["state"])).toEqual(["failed"]);
  });

  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly argv?: readonly string[];
    readonly setUp: () => Promise<unknown> | unknown;
    readonly env?: () => Record<string, string>;
    readonly exit: number;
    readonly says: string;
  }> = [
    {
      name: "a run nobody started",
      setUp: () => undefined,
      exit: EXIT_FOR_ERROR.not_found,
      says: `runs resume: no graph run ${GRUN} in`,
    },
    {
      name: "a run that is not waiting",
      setUp: () => store().save({ graphRunId: GRUN, nodeName: "review", state: {} }),
      exit: EXIT_FOR_ERROR.conflict,
      says: `runs resume: ${GRUN} is not waiting for a decision`,
    },
    {
      name: "a run already decided",
      setUp: async () => store().claimResume(GRUN, await paused()),
      exit: EXIT_FOR_ERROR.already_decided,
      says: `runs resume: ${GRUN} was already decided; it is resumed once`,
    },
    {
      name: "a run already decided, whose pause is cleared",
      setUp: async () => {
        await store().claimResume(GRUN, await paused());
        await store().markWaiting(GRUN, undefined);
      },
      exit: EXIT_FOR_ERROR.already_decided,
      says: `runs resume: ${GRUN} was already decided; it is resumed once`,
    },
    {
      name: "a pause the run does not wait at",
      argv: [GRUN, "--checkpoint", "ckpt_0123456789abcdef", "--decision", "approve"],
      setUp: paused,
      exit: EXIT_FOR_ERROR.conflict,
      says: `runs resume: ${GRUN} is not waiting at ckpt_0123456789abcdef`,
    },
    {
      name: "a checkpoint that is not one",
      argv: [GRUN, "--checkpoint", "ckpt_x;id", "--decision", "approve"],
      setUp: paused,
      exit: EXIT_FOR_ERROR.invalid,
      says: "runs resume: --checkpoint names a pause: ckpt_ and 16 hex",
    },
    {
      name: "no decision",
      argv: [GRUN],
      setUp: paused,
      exit: EXIT_FOR_ERROR.invalid,
      says: "runs resume: name the decision with --decision",
    },
    {
      name: "a decision the build would read as a flag",
      argv: [GRUN, "--decision", "-x"],
      setUp: paused,
      exit: EXIT_FOR_ERROR.invalid,
      says: "runs resume: a decision does not start with a dash",
    },
    {
      name: "a harness of another shape",
      setUp: async () => {
        await paused();
        writeFileSync(join(dir, "crewhaus.yaml"), "name: alpha\ntarget: workflow\n");
      },
      exit: EXIT_FOR_ERROR.unsupported,
      says: "is a workflow harness, not a graph",
    },
    {
      name: "a build from before this",
      setUp: async () => {
        await paused();
        build("0.8.3");
      },
      exit: EXIT_FOR_ERROR.unsupported,
      says: "runs resume: This harness's build is older than 0.9.0",
    },
    {
      name: "a harness its operator paused",
      setUp: async () => {
        await paused();
        const control = join(dir, ".crewhaus", "run", "control");
        mkdirSync(control, { recursive: true });
        writeFileSync(
          join(control, "operator.json"),
          JSON.stringify({
            v: 1,
            rev: 1,
            intake: { paused: true, since: "2026-11-13T00:00:00.000Z" },
            deployment: null,
            desired: "running",
          }),
        );
      },
      exit: EXIT_FOR_ERROR.paused,
      says: "runs resume: This harness is paused",
    },
    {
      name: "a command an agent's tool started",
      setUp: paused,
      env: () => ({ ...env, [AGENT_TOOL_ENV]: "1" }),
      exit: EXIT_FOR_ERROR.forbidden,
      says: GRAPH_RESUME_AGENT_REFUSAL,
    },
  ];
  for (const row of refusals) {
    test(`${row.name} is refused before anything is written or started`, async () => {
      await row.setUp();
      const before = treeOf(base);
      const out = await resume(row.argv ?? [GRUN, "--decision", "approve"], {
        ...(row.env !== undefined ? { env: row.env() } : {}),
      });
      expect(out.lines.join("\n")).toContain(row.says);
      expect(out.exitCode).toBe(row.exit);
      expect(starts).toEqual([]);
      expect(treeOf(base)).toEqual(before);
    });
  }

  test("a session's flags are not a graph run's", async () => {
    await paused();
    await expect(resume([GRUN, "--decision", "approve", "--model", "x"])).rejects.toThrow(
      "a graph run takes --decision, --checkpoint and --harness, not --model",
    );
    expect(starts).toEqual([]);
  });

  test("a decision is short text with something in it", () => {
    expect(graphDecisionProblem("approve")).toBeUndefined();
    expect(graphDecisionProblem("x".repeat(GRAPH_DECISION_MAX_BYTES))).toBeUndefined();
    expect(graphDecisionProblem("x".repeat(GRAPH_DECISION_MAX_BYTES + 1))).toContain("4 KiB");
    expect(graphDecisionProblem("  ")).toContain("--decision");
    expect(graphDecisionProblem("a\u0000b")).toContain("4 KiB");
  });

  test("asking whether a run waits makes no graphs folder", async () => {
    expect(await graphRunWaiting(dir, GRUN)).toEqual({ state: "unknown" });
    expect(existsSync(join(dir, ".crewhaus"))).toBe(false);
    const ckpt = await paused();
    expect(await graphRunWaiting(dir, GRUN)).toEqual({ state: "waiting", ckpt });
  });

  test("a session is still resumed by the CLI's own run, whatever its prompt names", async () => {
    const seen: (readonly string[])[] = [];
    const out = await runRunsCommand(["resume", "sess_00000000000000aa", "--prompt", GRUN], {
      env,
      cwd: dir,
      resume: async (argv) => {
        seen.push(argv);
      },
    });
    expect(out.exitCode).toBe(0);
    expect(seen).toEqual([["sess_00000000000000aa", "--prompt", GRUN]]);
  });
});
