import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  casAppend,
  controlPaths,
  deploymentsLedger,
  readDeployments,
  readHarnessIdentity,
} from "@crewhaus/control-records";
import { HARNESS_IDENTITY_REL } from "@crewhaus/harness-registry";
import {
  NO_ACTIVE_BUILD_ACTIVATE_MESSAGE,
  buildDigest,
  verifyActiveBuild,
} from "@crewhaus/harness-supervisor";
import { AREA_RUNTIMES, activationGates } from "./areas";
import {
  ROOT_BUNDLE_UNRECORDED_MESSAGE,
  activateDeployment,
  admitExplicitStart,
  ensureHarnessIdentity,
  reconcileActivation,
  supersedeEarlier,
} from "./deployments";
import type { ActivationGate } from "./executor";
import { removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const HRN = "hrn_00000000000000aa";
const ACTOR = `local:#${"a".repeat(64)}`;
const CMD = "cmd_01aaaaaaaaaaaaaaaaaaaaaaaa";
const SPEC = "name: demo\ntarget: channel\n";

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function harness(): string {
  const dir = tempDir();
  put(dir, "crewhaus.yaml", SPEC);
  put(dir, "dist/daemon.ts", "// bundle\n");
  return dir;
}

let seq = 0;
async function prepare(dir: string, specHash = `sha256:${"b".repeat(64)}`): Promise<string> {
  seq += 1;
  const id = `dep_01${String(seq).padStart(24, "0")}`;
  const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
  if ("unreadable" in taken) throw new Error(taken.unreadable);
  await casAppend(deploymentsLedger(dir), id, null, {
    id,
    state: "prepared",
    artifact: {
      digest: taken.digest,
      specHash,
      compiledWith: "0.9.0",
      shape: "channel",
      entry: "dist/daemon.ts",
      bootInputs: [],
    },
  });
  return id;
}

const gates = activationGates(AREA_RUNTIMES);

function stateOf(dir: string, id: string): unknown {
  const read = readDeployments(dir);
  return read.state === "present" ? read.records.find((r) => r["id"] === id)?.["state"] : undefined;
}

describe("activateDeployment", () => {
  test("two activations of one deployment at once: exactly one applies", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    const answers = await Promise.all([
      activateDeployment({ harnessDir: dir, dep, actor: ACTOR, cmd: CMD, gates }),
      activateDeployment({ harnessDir: dir, dep, actor: ACTOR, cmd: CMD, gates }),
    ]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(stateOf(dir, dep)).toBe("active");
  });

  test("a failed gate refuses with conflict and the current record; nothing moves", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    const refuse: ActivationGate = {
      name: "never",
      check: async () => ({ ok: false, reason: "not today", verb: "crewhaus x" }),
    };
    const answer = await activateDeployment({
      harnessDir: dir,
      dep,
      actor: ACTOR,
      cmd: CMD,
      gates: [...gates, refuse],
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "conflict",
      message: "not today",
      verb: "crewhaus x",
    });
    expect(!answer.ok && answer.current?.["state"]).toBe("prepared");
    expect(stateOf(dir, dep)).toBe("prepared");
  });

  test("a protected environment without a quorum refuses through the core gate", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    put(
      dir,
      ".crewhaus/environments.json",
      JSON.stringify({ environments: { prod: { requireApproval: true } } }),
    );
    const answer = await activateDeployment({
      harnessDir: dir,
      dep,
      actor: ACTOR,
      cmd: CMD,
      gates,
      environment: "prod",
    });
    expect(answer).toMatchObject({ ok: false, code: "conflict" });
    expect(!answer.ok && answer.message).toContain("protected environment");
    expect(stateOf(dir, dep)).toBe("prepared");
  });

  test("a service principal cannot activate", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    const answer = await activateDeployment({
      harnessDir: dir,
      dep,
      actor: "prn_01aaaaaaaaaaaaaaaaaaaaaaaa",
      actorIsService: true,
      cmd: CMD,
      gates,
    });
    expect(answer).toMatchObject({ ok: false, code: "forbidden" });
    expect(stateOf(dir, dep)).toBe("prepared");
  });

  test("activating a second deployment supersedes the first, each row whole", async () => {
    const dir = harness();
    const first = await prepare(dir);
    const second = await prepare(dir);
    await activateDeployment({ harnessDir: dir, dep: first, actor: ACTOR, cmd: CMD, gates });
    const answer = await activateDeployment({
      harnessDir: dir,
      dep: second,
      actor: ACTOR,
      cmd: CMD,
      gates,
      autostart: false,
    });
    expect(answer.ok && answer.superseded).toEqual([first]);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.active?.["id"]).toBe(second);
    expect(read.active?.["autostart"]).toBe(false);
    expect(read.active?.["gates"]).toEqual(["protected-environment"]);
    expect(read.active?.["envChain"]).toMatchObject({ files: [] });
    const old = read.records.find((r) => r["id"] === first);
    expect(old?.["state"]).toBe("superseded");
    expect(old?.["artifact"]).toBeDefined();
  });

  test("two activations of different deployments that land together leave exactly one active", async () => {
    const dir = harness();
    const first = await prepare(dir);
    const second = await prepare(dir);
    // Both compare-and-sets land before either supersede pass runs.
    const ledger = deploymentsLedger(dir);
    const activeRow = async (dep: string, at: string) => {
      const read = readDeployments(dir);
      if (read.state !== "present") throw new Error("absent");
      const prepared = read.records.find((r) => r["id"] === dep) ?? {};
      const rest = { ...prepared, state: "active", activatedAt: at, cmd: CMD };
      Reflect.deleteProperty(rest, "gen");
      Reflect.deleteProperty(rest, "claim");
      const moved = await casAppend(ledger, dep, "prepared", rest);
      expect(moved.ok && moved.applied).toBe(true);
    };
    await activeRow(first, "2026-11-12T00:00:01.000Z");
    await activeRow(second, "2026-11-12T00:00:02.000Z");
    // The later one's pass finishes first, then the earlier one's.
    expect(await supersedeEarlier(dir, second, "2026-11-12T00:00:02.000Z")).toEqual([first]);
    expect(await supersedeEarlier(dir, first, "2026-11-12T00:00:01.000Z")).toEqual([]);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.records.filter((r) => r["state"] === "active").map((r) => r["id"])).toEqual([
      second,
    ]);
    expect(read.active?.["id"]).toBe(second);
  });

  test("an activation that names no environment takes the active build's protected one", async () => {
    const dir = harness();
    put(
      dir,
      ".crewhaus/environments.json",
      JSON.stringify({ environments: { prod: { requireApproval: true } } }),
    );
    put(
      dir,
      ".crewhaus/approvals/demo__prod.json",
      JSON.stringify([{ approver: "a", ts: "t", specHash: `sha256:${"b".repeat(64)}` }]),
    );
    const inProd = await prepare(dir);
    const into = await activateDeployment({
      harnessDir: dir,
      dep: inProd,
      actor: ACTOR,
      cmd: CMD,
      gates,
      environment: "prod",
    });
    expect(into.ok).toBe(true);
    const unapproved = await prepare(dir, `sha256:${"c".repeat(64)}`);
    for (const environment of [undefined, "staging"]) {
      const answer = await activateDeployment({
        harnessDir: dir,
        dep: unapproved,
        actor: ACTOR,
        cmd: CMD,
        gates,
        ...(environment !== undefined ? { environment } : {}),
      });
      expect(answer).toMatchObject({ ok: false, code: "conflict" });
      expect(!answer.ok && answer.message).toContain('"prod" is a protected environment');
      expect(stateOf(dir, inProd)).toBe("active");
      expect(stateOf(dir, unapproved)).toBe("prepared");
    }
    // A start that activates what it found never takes over prod either.
    const started = await activateDeployment({
      harnessDir: dir,
      dep: unapproved,
      actor: ACTOR,
      cmd: CMD,
      gates: "not-run",
    });
    expect(started.ok).toBe(false);
    expect(stateOf(dir, inProd)).toBe("active");
    // With a quorum for its content, the unnamed activation replaces prod's build in prod.
    put(
      dir,
      ".crewhaus/approvals/demo__prod.json",
      JSON.stringify([{ approver: "a", ts: "t", specHash: `sha256:${"c".repeat(64)}` }]),
    );
    const approved = await activateDeployment({
      harnessDir: dir,
      dep: unapproved,
      actor: ACTOR,
      cmd: CMD,
      gates,
    });
    expect(approved.ok && approved.record["environment"]).toBe("prod");
    expect(stateOf(dir, inProd)).toBe("superseded");
  });

  test("harness.json is written once, taking the registry's id", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    const answer = await activateDeployment({
      harnessDir: dir,
      dep,
      actor: ACTOR,
      cmd: CMD,
      gates,
      registryId: HRN,
    });
    expect(answer.ok && answer.record["harness"]).toBe(HRN);
    const identity = readHarnessIdentity(dir);
    expect(identity.state === "present" && identity.identity.id).toBe(HRN);
    expect(ensureHarnessIdentity(dir, "hrn_00000000000000bb")).toEqual({ ok: true, id: HRN });
  });

  test("the env chain is recorded as names and a keyed digest, never a value", async () => {
    const dir = harness();
    const secret = ["sk", "-", "x".repeat(20)].join("");
    put(dir, ".env", `TOKEN=${secret}\n`);
    const dep = await prepare(dir);
    const answer = await activateDeployment({
      harnessDir: dir,
      dep,
      actor: ACTOR,
      cmd: CMD,
      gates,
    });
    expect(answer.ok && answer.record["envChain"]).toMatchObject({ files: [".env"] });
    expect(JSON.stringify(readDeployments(dir))).not.toContain(secret);
  });
});

describe("reconcileActivation", () => {
  const receipt = (target: string, id = CMD): CommandReceipt =>
    ({ id, target }) as unknown as CommandReceipt;

  test("done, not-done and unknown", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    const target = `${HRN}/deployment/${dep}`;
    expect(reconcileActivation(receipt(target), { harnessDir: dir })).toBe("not-done");
    await activateDeployment({ harnessDir: dir, dep, actor: ACTOR, cmd: CMD, gates });
    expect(reconcileActivation(receipt(target), { harnessDir: dir })).toBe("done");
    expect(
      reconcileActivation(receipt(target, "cmd_01bbbbbbbbbbbbbbbbbbbbbbbb"), { harnessDir: dir }),
    ).toBe("unknown");
    expect(reconcileActivation(receipt(`home/harness/${HRN}`), { harnessDir: dir })).toBe(
      "unknown",
    );
  });
});

describe("admitExplicitStart", () => {
  test("a harness with no deployment record is recorded and activated, not autostarted", async () => {
    const dir = harness();
    const answer = await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR });
    expect(answer.ok).toBe(true);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.active?.["autostart"]).toBe(false);
    expect(read.active?.["gates"]).toBe("not-run");
  });

  test("records left only by this start's own compile still count as none", async () => {
    const dir = harness();
    const compiled = await prepare(dir);
    const home = await admitExplicitStart(dir, "channel", {
      head: "home",
      actor: ACTOR,
      ledgerAbsent: true,
    });
    expect(home.ok && home.deployment?.id).toBe(compiled);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.active?.["autostart"]).toBe(false);
  });

  test("a prepared build that no one activated: Home and a group point to activation", async () => {
    const dir = harness();
    const compiled = await prepare(dir);
    for (const head of ["home", "group"] as const) {
      const answer = await admitExplicitStart(dir, "channel", { head, actor: ACTOR });
      expect(answer).toEqual({ ok: false, message: NO_ACTIVE_BUILD_ACTIVATE_MESSAGE });
      expect(!answer.ok && answer.message).not.toContain("Start it once");
    }
    expect(stateOf(dir, compiled)).toBe("prepared");
  });

  test("a start's record covers the local files the spec's stdio MCP servers run", async () => {
    const dir = harness();
    put(
      dir,
      "crewhaus.yaml",
      `${SPEC}mcp_servers:\n  local:\n    transport: stdio\n    command: bun\n    args: ["./tools/server.ts"]\n`,
    );
    put(dir, "tools/server.ts", "// a local server\n");
    const answer = await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR });
    expect(answer.ok).toBe(true);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect((read.active?.["artifact"] as { bootInputs?: unknown }).bootInputs).toEqual([
      "tools/server.ts",
    ]);
    expect(verifyActiveBuild(dir, "channel").ok).toBe(true);
    put(dir, "tools/server.ts", "// edited after the start recorded it\n");
    expect(verifyActiveBuild(dir, "channel")).toMatchObject({ ok: false, reason: "mismatch" });
  });

  test("a start never records a bundle at the harness root; compile does", async () => {
    const dir = tempDir();
    put(dir, "crewhaus.yaml", "name: demo\ntarget: cli\n");
    put(dir, "agent.ts", "// compiled with -o .\n");
    put(dir, "package.json", JSON.stringify({ name: "crewhaus-compiled-bundle" }));
    const answer = await admitExplicitStart(dir, "cli", { head: "cli-direct", actor: ACTOR });
    expect(answer).toEqual({ ok: false, message: ROOT_BUNDLE_UNRECORDED_MESSAGE });
    const read = readDeployments(dir);
    expect(read.state === "present" ? read.records : []).toEqual([]);
  });

  test("the active build runs from any head", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    await activateDeployment({ harnessDir: dir, dep, actor: ACTOR, cmd: CMD, gates });
    const answer = await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR });
    expect(answer.ok && answer.deployment?.id).toBe(dep);
  });

  test("a changed build: Home and a group refuse, the CLI records and activates it", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    await activateDeployment({ harnessDir: dir, dep, actor: ACTOR, cmd: CMD, gates });
    put(dir, "dist/daemon.ts", "// recompiled\n");
    for (const head of ["home", "group", "server", "sdk"] as const) {
      const refused = await admitExplicitStart(dir, "channel", { head, actor: ACTOR });
      expect(refused.ok).toBe(false);
    }
    expect(stateOf(dir, dep)).toBe("active");
    const cli = await admitExplicitStart(dir, "channel", { head: "cli-direct", actor: ACTOR });
    expect(cli.ok).toBe(true);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.active?.["id"]).not.toBe(dep);
    expect(read.active?.["gates"]).toBe("not-run");
    expect(stateOf(dir, dep)).toBe("superseded");
  });

  test("a start activates a compile's prepared record of the same build rather than a new one", async () => {
    const dir = harness();
    const first = await prepare(dir);
    await activateDeployment({ harnessDir: dir, dep: first, actor: ACTOR, cmd: CMD, gates });
    put(dir, "dist/daemon.ts", "// recompiled\n");
    const compiled = await prepare(dir);
    const answer = await admitExplicitStart(dir, "channel", { head: "cli-direct", actor: ACTOR });
    expect(answer.ok && answer.deployment?.id).toBe(compiled);
    const read = readDeployments(dir);
    expect(read.state === "present" && read.records).toHaveLength(2);
  });

  test("a start never activates into a protected environment", async () => {
    const dir = harness();
    const dep = await prepare(dir);
    put(
      dir,
      ".crewhaus/environments.json",
      JSON.stringify({ environments: { prod: { requireApproval: true } } }),
    );
    put(
      dir,
      ".crewhaus/approvals/demo__prod.json",
      JSON.stringify([{ approver: "a", ts: "t", specHash: `sha256:${"b".repeat(64)}` }]),
    );
    const activated = await activateDeployment({
      harnessDir: dir,
      dep,
      actor: ACTOR,
      cmd: CMD,
      gates,
      environment: "prod",
    });
    expect(activated.ok).toBe(true);
    put(dir, "dist/daemon.ts", "// recompiled\n");
    const answer = await admitExplicitStart(dir, "channel", { head: "cli-direct", actor: ACTOR });
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.message).toContain("crewhaus deploy activate --environment prod");
    expect(stateOf(dir, dep)).toBe("active");
  });
});

test("the registry reads harness.json where control-records writes it", () => {
  expect(HARNESS_IDENTITY_REL).toBe(controlPaths("/any").harnessIdentityFile);
});
