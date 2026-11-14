/**
 * `crewhaus runs`: a harness's runs read from its ledger, `runs cancel` of a run parked
 * on a decision with no daemon and no Home running (what it waits on is withdrawn, and
 * nothing resumes it after), `runs create` through a stub job starter, and the input
 * record `crewhaus run --input-file` reads.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { append, controlPaths, runsLedger } from "@crewhaus/control-records";
import type { ApiRunInput } from "@crewhaus/harness-supervisor";
import {
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { RUNS_SCHEMA } from "./arg-schemas";
import { directControl } from "./daemon-cmd";
import { readRunInputRecord, resolveRunsResumeTarget } from "./runs";
import { CLI_FAMILY, runRunsCommand } from "./runs-cmd";

let base: string;
let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-runs-cmd-")));
  dir = join(base, "alpha");
  mkdirSync(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), "name: alpha\ntarget: workflow\n");
  env = {
    CREWHAUS_HANGAR_ROOT: join(base, "hangar"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_NO_REGISTRY: "1",
  };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function plant(row: Record<string, unknown>): void {
  const written = append(runsLedger(dir), {
    at: new Date().toISOString(),
    trigger: { kind: "api" },
    ...row,
  });
  if (!written.ok) throw new Error(written.reason);
}

/** Every row of the harness's run ledger, oldest first. */
function ledgerRows(): Record<string, unknown>[] {
  const runs = join(dir, ".crewhaus", "run", "control", "runs");
  const rows: Record<string, unknown>[] = [];
  for (const file of readdirSync(runs)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(runs, file), "utf8").split("\n")) {
      if (line !== "") rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

const statesOf = (runId: string) =>
  ledgerRows()
    .filter((row) => row["id"] === runId)
    .map((row) => row["state"]);

const sessionRoot = () => join(dir, ".crewhaus", "sessions");

const PARKED_SESSION = "sess_00000000000000aa";

/**
 * An API run parked as the runtime leaves one: the root's rows, its top-level loop's
 * own run (`parent` the root) that parked, and the request bound to that loop run.
 */
async function parked(): Promise<{ runId: string; child: string; approval: string }> {
  const runId = mintRunId();
  const child = mintRunId();
  const execution = "run_00000000000000aa";
  plant({ id: runId, state: "queued", by: "sys:reconcile", cmd: mintId("cmd") });
  plant({ id: runId, state: "preparing", execution });
  plant({ id: runId, state: "running", execution });
  plant({
    id: child,
    state: "running",
    parent: runId,
    session: PARKED_SESSION,
    resumeScope: `run:${runId}`,
    execution,
  });
  plant({ id: child, state: "waiting-for-approval" });
  plant({ id: runId, state: "waiting-for-approval" });
  const inputs = join(dir, controlPaths(dir).inputsDir);
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, `${runId}.txt`), "Summarise.", { mode: 0o600 });
  const approval = generateApprovalId();
  await createPendingApprovalStore({ rootDir: sessionRoot() }).persist({
    id: approval,
    toolName: "Bash",
    inputHash: hashApprovalInput("Bash", { command: "ls" }),
    input: { command: "ls" },
    runId: child,
    sessionId: PARKED_SESSION,
    surface: "single-turn",
    createdAt: new Date().toISOString(),
    binding: { runId: child, resumeScope: `run:${runId}` },
  } as Parameters<ReturnType<typeof createPendingApprovalStore>["persist"]>[0]);
  return { runId, child, approval };
}

describe("crewhaus runs cancel, of a parked run with no daemon", () => {
  test("withdraws what it waits on, ends it cancelled, removes its input, and a later grant re-drives nothing", async () => {
    const { runId, child, approval } = await parked();
    const control = directControl({ env, cwd: dir });
    const starts: ApiRunInput[] = [];
    const out = await runRunsCommand(["cancel", runId, "--harness", dir], {
      env,
      cwd: dir,
      control: () => control,
      home: () => ({
        startRunJob: async (_d, apiRun) => {
          starts.push(apiRun);
          return { ok: true, runId: "run_0000000000000001", pid: 1 };
        },
      }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toBe(`run ${runId} cancelled`);
    const record = foldReadOnly(sessionRoot()).records.find((r) => r.id === approval);
    expect(record?.supersededBy).toBe(runId);
    expect(record?.supersededReason).toBe("run-cancelled");
    expect(statesOf(runId).at(-1)).toBe("cancelled");
    expect(existsSync(join(dir, controlPaths(dir).inputsDir, `${runId}.txt`))).toBe(false);
    // The grant decided afterwards finds nothing to decide.
    expect(
      await createPendingApprovalStore({ rootDir: sessionRoot() }).resolve(
        approval,
        "grant",
        "sam",
      ),
    ).toBeNull();
    // `runs resume <run>` refuses it before any spec is read or model is called.
    expect(() => resolveRunsResumeTarget(runId, dir)).toThrow(
      `run ${runId} was cancelled; nothing was resumed`,
    );
    // Nor the loop run that parked, nor its session.
    expect(statesOf(child).at(-1)).toBe("cancelled");
    expect(() => resolveRunsResumeTarget(child, dir)).toThrow(
      `run ${child} was cancelled; nothing was resumed`,
    );
    expect(() => resolveRunsResumeTarget(PARKED_SESSION, dir)).toThrow(
      `session ${PARKED_SESSION}'s run ${child} was cancelled; nothing was resumed`,
    );
    expect(starts).toHaveLength(0);
    // A second cancel is refused: the run ended.
    const again = await runRunsCommand(["cancel", runId, "--harness", dir], {
      env,
      cwd: dir,
      control: () => control,
    });
    expect(again.exitCode).toBe(53);
  });
});

describe("crewhaus runs list, show and create", () => {
  test("list and show read the ledger, content-free; create starts one job through the head", async () => {
    const starts: ApiRunInput[] = [];
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "agent.ts"), "// bundle\n");
    writeFileSync(
      join(dir, "dist", "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith: "0.9.0" },
      }),
    );
    const file = join(base, "input.txt");
    writeFileSync(file, "Summarise the quarterly report.");
    const control = directControl({ env, cwd: dir });
    const created = await runRunsCommand(["create", dir, "--input-file", file, "--json"], {
      env,
      cwd: dir,
      control: () => control,
      home: () => ({
        startRunJob: async (_d, apiRun) => {
          starts.push(apiRun);
          return { ok: true, runId: "run_0000000000000001", pid: 1 };
        },
      }),
    });
    expect(created.exitCode).toBe(0);
    const body = JSON.parse(created.lines.join("\n")) as {
      run: { id: string };
      receipt: { state: string };
    };
    expect(body.receipt.state).toBe("succeeded");
    expect(starts).toEqual([
      {
        runId: body.run.id,
        stdinFile: join(dir, controlPaths(dir).inputsDir, `${body.run.id}.txt`),
      },
    ]);
    const listed = await runRunsCommand(["list", "--harness", dir], { env, cwd: dir });
    expect(listed.lines[0]?.startsWith(body.run.id)).toBe(true);
    const shown = await runRunsCommand(["show", body.run.id, "--harness", dir, "--json"], {
      env,
      cwd: dir,
    });
    const view = JSON.parse(shown.lines.join("\n")) as Record<string, unknown>;
    expect(view).toMatchObject({ id: body.run.id, state: "queued", trigger: "api" });
    expect(shown.lines.join("\n")).not.toContain("quarterly");
  });

  test("refusals exit by their code", async () => {
    const file = join(base, "input.txt");
    writeFileSync(file, "x");
    const control = directControl({ env, cwd: dir });
    // A workflow build older than 0.9.0 (here, none) is refused unsupported.
    const old = await runRunsCommand(["create", dir, "--input-file", file], {
      env,
      cwd: dir,
      control: () => control,
      home: () => ({}),
    });
    expect(old.exitCode).toBe(54);
    expect(old.lines.join("\n")).toContain("crewhaus compile");
    const unknown = await runRunsCommand(["show", mintRunId(), "--harness", dir], {
      env,
      cwd: dir,
    });
    expect(unknown.exitCode).toBe(56);
  });

  test("resume delegates to the CLI's resumed run, and its flags are RUNS_SCHEMA's", async () => {
    const seen: (readonly string[])[] = [];
    await runRunsCommand(["resume", "sess_00000000000000aa", "--prompt", "go"], {
      resume: async (argv) => {
        seen.push(argv);
      },
    });
    expect(seen).toEqual([["sess_00000000000000aa", "--prompt", "go"]]);
    expect(Object.keys(CLI_FAMILY.sub.resume.flags).sort()).toEqual(
      RUNS_SCHEMA.flags.map((f) => f.name).sort(),
    );
    for (const flag of RUNS_SCHEMA.flags) {
      const kind = (CLI_FAMILY.sub.resume.flags as Record<string, string>)[flag.name];
      expect(`${flag.name} ${kind}`).toBe(
        `${flag.name} ${flag.takesValue === true ? "value" : "boolean"}`,
      );
    }
  });
});

describe("crewhaus run --input-file: the input record", () => {
  const EXECUTION = "run_00000000000000cc";
  function record(runId: string, body: Record<string, unknown> = {}): string {
    const inputs = join(dir, controlPaths(dir).inputsDir);
    mkdirSync(inputs, { recursive: true });
    const file = join(inputs, `${runId}.json`);
    writeFileSync(file, JSON.stringify({ v: 1, run: runId, input: "Summarise.", ...body }), {
      mode: 0o600,
    });
    return file;
  }
  function prepared(runId: string): void {
    plant({ id: runId, state: "queued" });
    plant({ id: runId, state: "preparing", execution: EXECUTION });
  }
  const envFor = (runId: string) => ({ CREWHAUS_RUN_ID: runId, CREWHAUS_EXECUTION_ID: EXECUTION });

  test("a good record runs: its input and its subject", () => {
    const runId = mintRunId();
    prepared(runId);
    const file = record(runId, { subject: "app:home:ada" });
    expect(readRunInputRecord(file, dir, envFor(runId))).toEqual({
      run: runId,
      input: "Summarise.",
      subject: "app:home:ada",
    });
  });

  test("outside the inputs folder, a link, another run's record, and a run its records do not hand over are each refused", () => {
    const runId = mintRunId();
    prepared(runId);
    const good = record(runId);
    const outside = join(base, "elsewhere.json");
    writeFileSync(outside, JSON.stringify({ v: 1, run: runId, input: "x" }));
    expect(() => readRunInputRecord(outside, dir, envFor(runId))).toThrow("must lie inside");
    const link = join(dir, controlPaths(dir).inputsDir, "link.json");
    symlinkSync(good, link);
    expect(() => readRunInputRecord(link, dir, envFor(runId))).toThrow("is a link");
    const other = mintRunId();
    expect(() => readRunInputRecord(good, dir, envFor(other))).toThrow("not started for");
    expect(() => readRunInputRecord(good, dir, { CREWHAUS_RUN_ID: runId })).toThrow("do not hand");
    const unqueued = mintRunId();
    const stray = record(unqueued);
    expect(() => readRunInputRecord(stray, dir, envFor(unqueued))).toThrow("do not hand");
  });
});
