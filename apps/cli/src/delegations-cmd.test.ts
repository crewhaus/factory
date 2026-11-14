/**
 * `crewhaus delegations`: every write refuses under an agent's tool, `enable` prints the
 * consequences page before it writes and refuses a wrong name, `apply` runs one pass, and
 * the page the CLI prints is the page Home's API answers, byte for byte.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AREA_MODULES, COMMAND_KINDS, OPERATIONS, mintId } from "@crewhaus/control-contract";
import {
  casAppend,
  controlPaths,
  deploymentsLedger,
  ensureDigestKey,
  openActionDecision,
  readActionDecisions,
  readDelegations,
  writeHarnessIdentity,
} from "@crewhaus/control-records";
import {
  AREA_RUNTIMES,
  type AreaRuntime,
  type ControlService,
  type DelegatedAction,
  delegatedExecutor,
  delegatedRollbackExecutor,
  wireControl,
} from "@crewhaus/control-service";
import { CLI_FAMILY, runDelegationsCommand } from "./delegations-cmd";

const HRN = "hrn_00000000000000d1";
const IDENTITY = { username: "sam", hostname: "laptop" } as const;
const REV = `sha256:${"a".repeat(64)}`;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** Two kinds of one area module that no shipped runtime serves. */
function borrowed(): { area: string; execute: string; rollback: string } {
  const served = new Set(
    AREA_RUNTIMES.flatMap((r) => [
      ...Object.keys(r.executors ?? {}),
      ...Object.keys(r.reconcilers ?? {}),
    ]),
  );
  for (const module of AREA_MODULES.filter((m) => m.area !== "core")) {
    const free = module.commandKinds
      .map((k) => k.id as string)
      .filter((id) => !served.has(id) && Object.hasOwn(COMMAND_KINDS, id));
    if (free.length >= 2)
      return { area: module.area, execute: free[0] as string, rollback: free[1] as string };
  }
  throw new Error("no free kinds");
}

async function world() {
  const hangarRoot = tmp("delegations-cmd-home-");
  const harness = tmp("delegations-cmd-harness-");
  const written = writeHarnessIdentity(harness, { id: HRN, slug: "support" });
  if (!written.ok) throw new Error(written.reason);
  const dep = mintId("dep");
  const row = {
    id: dep,
    harness: HRN,
    artifact: { digest: "d".repeat(64), shape: "cli", entry: "dist/agent.ts" },
    policyRevision: `sha256:${"1".repeat(64)}`,
    delegation: { maxDays: 30, merge: {} },
  };
  await casAppend(deploymentsLedger(harness), dep, null, { ...row, state: "prepared" });
  await casAppend(deploymentsLedger(harness), dep, "prepared", {
    ...row,
    state: "active",
    activatedAt: new Date().toISOString(),
  });
  const counts = { effects: 0 };
  const kinds = borrowed();
  const action: DelegatedAction = {
    action: "merge",
    decisionKind: "merge",
    gates: {},
    requiredGates: [],
    scopeOf: (ceiling) =>
      typeof ceiling["merge"] === "object" ? { fields: {}, ceiling: {} } : undefined,
    inScope: () => true,
    oneAtATime: () => true,
    planRollback: async () => ({
      kind: "revert",
      binding: "app",
      pr: 1,
      base: "main",
      method: "squash",
    }),
    currentRevision: async () => REV,
    signals: async () => "healthy",
    signalIds: ["base-checks"],
    watchMs: () => 60_000,
    previewTerms: async () => [],
    executeKind: kinds.execute,
    rollbackKind: kinds.rollback,
  };
  const runtime: AreaRuntime = {
    area: kinds.area,
    executors: {
      [kinds.execute]: delegatedExecutor(action, async () => {
        counts.effects += 1;
        return { state: "succeeded" };
      }),
      [kinds.rollback]: delegatedRollbackExecutor(async () => ({ state: "succeeded" })),
    },
    reconcilers: { [kinds.execute]: () => "unknown", [kinds.rollback]: () => "unknown" },
    unsupervised: [kinds.execute, kinds.rollback],
    delegatedActions: [action],
  };
  const service: ControlService = wireControl(
    {
      hangarRoot,
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: IDENTITY,
      probe: { isAlive: () => true, startTimeMs: () => Date.now() - 1000 },
    },
    { mode: "direct", areas: [...AREA_RUNTIMES, runtime] },
  );
  const env = {
    CREWHAUS_REGISTRY_ROOT: join(hangarRoot, "registry"),
    CREWHAUS_HANGAR_ROOT: hangarRoot,
    HOME: hangarRoot,
  };
  const run = (argv: readonly string[], extra: Record<string, string> = {}) =>
    runDelegationsCommand(argv, {
      env: { ...env, ...extra },
      control: () => service,
      identity: IDENTITY,
    });
  return { harness, service, run, counts };
}

describe("crewhaus delegations", () => {
  test("every write refuses under an agent's tool, and writes nothing", async () => {
    const w = await world();
    const writes = [
      ["enable", "merge", "--harness", w.harness, "--confirm", "support"],
      ["propose", "merge", "--harness", w.harness],
      ["change", mintId("rule"), "--harness", w.harness, "--expect", "1", "--confirm", "support"],
      ["pause", mintId("rule"), "--harness", w.harness],
      ["resume", mintId("rule"), "--harness", w.harness, "--expect", "1", "--confirm", "support"],
      ["revoke", "--all", "--harness", w.harness],
      ["apply", "--harness", w.harness],
    ];
    expect(writes.map((argv) => argv[0]).sort()).toEqual(
      Object.keys(CLI_FAMILY.sub)
        .filter((sub) => !["list", "show", "preview"].includes(sub))
        .sort(),
    );
    for (const argv of writes) {
      const out = await w.run(argv, { CREWHAUS_AGENT_TOOL: "Bash" });
      expect([argv[0], out.exitCode]).toEqual([argv[0], 51]);
      expect(out.lines.join("\n")).toContain("started by an agent's tool");
    }
    expect(existsSync(join(w.harness, controlPaths(w.harness).delegationsFile))).toBe(false);
    expect(existsSync(join(w.harness, controlPaths(w.harness).digestKeyFile))).toBe(false);
  });

  test("enable prints the page before it writes, and refuses a wrong name", async () => {
    const w = await world();
    const wrong = await w.run([
      "enable",
      "merge",
      "--harness",
      w.harness,
      "--confirm",
      "someone-else",
    ]);
    expect(wrong.exitCode).toBe(55);
    expect(wrong.lines[0]).toBe("Let support merge its own pull requests");
    expect(wrong.lines.at(-1)).toBe("delegations enable: Type support to confirm.");
    expect(readDelegations(w.harness)).toEqual({ state: "absent" });
    const on = await w.run([
      "enable",
      "merge",
      "--harness",
      w.harness,
      "--days",
      "7",
      "--confirm",
      "support",
    ]);
    expect(on.exitCode).toBe(0);
    const text = on.lines.join("\n");
    expect(text.indexOf("Let support merge its own pull requests")).toBe(0);
    expect(text.indexOf("Turned on: rule_")).toBeGreaterThan(
      text.indexOf("CLI: crewhaus delegations enable"),
    );
    const read = readDelegations(w.harness);
    expect(read.state === "present" && read.rows[0]?.terms).toEqual({ days: 7 });
  });

  test("apply runs one pass", async () => {
    const w = await world();
    await w.run(["enable", "merge", "--harness", w.harness, "--confirm", "support"]);
    const opened = await openActionDecision(w.harness, {
      kind: "merge",
      subject: { ref: `${HRN}/work/${mintId("wi")}`, revision: REV },
      requiredClass: "maintainer",
      proposedBy: "sys:scheduler",
      now: Date.now(),
    });
    if (!opened.ok) throw new Error(opened.reason);
    const out = await w.run(["apply", "--harness", w.harness]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toContain("1 decided");
    expect(w.counts.effects).toBe(1);
    const decided = readActionDecisions(w.harness);
    expect(decided.state === "present" && decided.rows[0]?.resolvedBy).toBe("delegation");
    const again = await w.run(["apply", "--harness", w.harness, "--json"]);
    expect(JSON.parse(again.lines[0] as string)).toMatchObject({
      harness: HRN,
      summary: { decided: 0 },
    });
  });

  test("preview --json answers the same text and digest as Home's API", async () => {
    const w = await world();
    const key = await ensureDigestKey(w.harness);
    expect(key.state).toBe("present");
    const cli = await w.run(["preview", "merge", "--harness", w.harness, "--days", "9", "--json"]);
    expect(cli.exitCode).toBe(0);
    const printed = JSON.parse(cli.lines.join("\n")) as {
      text: string;
      consequencesDigest: string;
    };
    expect(printed.consequencesDigest).toMatch(/^[0-9a-f]{64}$/);
    const url = new URL("../../../packages/hangar-server/src/v1/delegations.ts", import.meta.url)
      .href;
    const { DELEGATION_HANDLERS } = (await import(url)) as {
      DELEGATION_HANDLERS: Record<
        string,
        (ctx: unknown) => Promise<{ status: number; body: unknown }>
      >;
    };
    const answer = await DELEGATION_HANDLERS["delegations.preview"]?.({
      params: { h: HRN },
      query: {},
      body: { action: "merge", terms: { days: 9 } },
      op: OPERATIONS.find((o) => o.id === "delegations.preview"),
      access: { caller: { principal: "prn_x", actor: null, via: "no-auth" } },
      deps: {
        registry: {
          get: () => ({
            id: HRN,
            dir: w.harness,
            missingSince: null,
            specName: "support",
            slug: "support",
          }),
          list: () => [],
        },
        control: w.service,
      },
      via: "home",
    });
    expect(answer?.status).toBe(200);
    const body = answer?.body as { text: string; consequencesDigest: string };
    expect(body.text).toBe(printed.text);
    expect(body.consequencesDigest).toBe(printed.consequencesDigest);
  });

  test("a harness it cannot find, and arguments it cannot use, are refused", async () => {
    const w = await world();
    expect((await w.run(["show", mintId("rule"), "--harness", "nowhere"])).exitCode).toBe(56);
    expect((await w.run(["preview", "deploy", "--harness", w.harness])).exitCode).toBe(55);
    expect(
      (await w.run(["preview", "merge", "--harness", w.harness, "--days", "1.5"])).exitCode,
    ).toBe(55);
    expect((await w.run(["show", "not-a-rule", "--harness", w.harness])).exitCode).toBe(55);
    expect((await w.run(["show", mintId("rule"), "--harness", w.harness])).exitCode).toBe(56);
    expect(
      (await w.run(["pause", mintId("rule"), "--harness", w.harness, "--reason", "because"]))
        .exitCode,
    ).toBe(55);
  });
});
