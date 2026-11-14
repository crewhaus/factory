/**
 * `crewhaus delegations`: every write refuses under an agent's tool, `enable` prints the
 * consequences page and the command that confirms it before anything is written, binds
 * to that page's digest and refuses a wrong name, `apply` runs one pass, and
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
  return { harness, service, run, counts, dep };
}

/** The command a printed page's CLI line names, as argv after `crewhaus`. */
function commandOf(lines: readonly string[]): string[] {
  const line = lines.find((l) => l.startsWith("CLI: crewhaus "));
  if (line === undefined) throw new Error(`no CLI line in:\n${lines.join("\n")}`);
  return line.slice("CLI: crewhaus ".length).split(" ");
}

/** The same argv with `--harness` given as the directory, where no registry knows the id. */
function withDir(argv: readonly string[], dir: string): string[] {
  const out = [...argv];
  const at = out.indexOf("--harness");
  if (at >= 0) out[at + 1] = dir;
  return out;
}

/** Activate another build of the harness, under another policy revision. */
async function deploy(harness: string, previous: string, policyRevision: string): Promise<void> {
  const dep = mintId("dep");
  const row = {
    id: dep,
    harness: HRN,
    artifact: { digest: "e".repeat(64), shape: "cli", entry: "dist/agent.ts" },
    policyRevision,
    delegation: { maxDays: 30, merge: {} },
  };
  await casAppend(deploymentsLedger(harness), dep, null, { ...row, state: "prepared" });
  await casAppend(deploymentsLedger(harness), dep, "prepared", {
    ...row,
    state: "active",
    activatedAt: new Date().toISOString(),
  });
  await casAppend(deploymentsLedger(harness), previous, "active", {
    id: previous,
    harness: HRN,
    state: "superseded",
  });
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

  test("enable prints the page and its command first; the command it prints turns the rule on", async () => {
    const w = await world();
    const first = await w.run(["enable", "merge", "--harness", w.harness, "--days", "7"]);
    expect(first.exitCode).toBe(53);
    expect(first.lines[0]).toBe("Let support merge its own pull requests");
    expect(first.lines.at(-1)).toContain("Nothing changed yet.");
    expect(readDelegations(w.harness)).toEqual({ state: "absent" });
    const argv = commandOf(first.lines);
    expect(argv.slice(0, 4)).toEqual(["delegations", "enable", "merge", "--harness"]);
    expect(argv).toContain("--digest");
    const wrong = await w.run(withDir([...argv.slice(1, -1), "someone-else"], w.harness));
    expect(wrong.exitCode).toBe(55);
    expect(wrong.lines.at(-1)).toBe("delegations enable: Type support to confirm.");
    expect(readDelegations(w.harness)).toEqual({ state: "absent" });
    // The printed line names the harness by id: run here it is given the directory.
    const on = await w.run(withDir(argv.slice(1), w.harness));
    expect(on.exitCode).toBe(0);
    expect(on.lines.join("\n")).toContain("Turned on: rule_");
    const read = readDelegations(w.harness);
    expect(read.state === "present" && read.rows[0]?.terms).toEqual({ days: 7 });
  });

  test("a page that changed after it was printed is refused, with the page as it is now", async () => {
    const w = await world();
    const printed = commandOf((await w.run(["enable", "merge", "--harness", w.harness])).lines);
    const digest = printed[printed.indexOf("--digest") + 1];
    // A new build is activated: another policy revision, so another page.
    await deploy(w.harness, w.dep, `sha256:${"2".repeat(64)}`);
    const stale = await w.run(withDir(printed.slice(1), w.harness));
    expect(stale.exitCode).toBe(53);
    expect(stale.lines.at(-1)).toContain("has changed");
    const now = commandOf(stale.lines);
    expect(now[now.indexOf("--digest") + 1]).not.toBe(digest);
    expect(readDelegations(w.harness)).toEqual({ state: "absent" });
    expect((await w.run(withDir(now.slice(1), w.harness))).exitCode).toBe(0);
  });

  test("apply runs one pass", async () => {
    const w = await world();
    const argv = commandOf((await w.run(["enable", "merge", "--harness", w.harness])).lines);
    expect((await w.run(withDir(argv.slice(1), w.harness))).exitCode).toBe(0);
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
