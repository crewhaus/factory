import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  buildLinkMessage,
  verifyActiveBuild,
} from "@crewhaus/harness-supervisor";
import { specRevision } from "@crewhaus/ir/policy";
import { AREA_RUNTIMES, activationGates } from "./areas";
import {
  ACTIVATION_RACED_MESSAGE,
  ROOT_BUNDLE_UNRECORDED_MESSAGE,
  activateDeployment,
  admitExplicitStart,
  ensureHarnessIdentity,
  noSpecRevisionMessage,
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
async function prepare(
  dir: string,
  specHash: string | null = `sha256:${"b".repeat(64)}`,
): Promise<string> {
  seq += 1;
  const id = `dep_01${String(seq).padStart(24, "0")}`;
  const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
  if ("unreadable" in taken) throw new Error(taken.unreadable);
  await casAppend(deploymentsLedger(dir), id, null, {
    id,
    state: "prepared",
    artifact: {
      digest: taken.digest,
      ...(specHash !== null ? { specHash } : {}),
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

function protectProd(dir: string, approvedFor: readonly string[]): void {
  put(
    dir,
    ".crewhaus/environments.json",
    JSON.stringify({ environments: { prod: { requireApproval: true } } }),
  );
  put(
    dir,
    ".crewhaus/approvals/demo__prod.json",
    JSON.stringify(approvedFor.map((specHash) => ({ approver: "a", ts: "t", specHash }))),
  );
}

describe("an activation acts only on the records it decided from", () => {
  const B_HASH = `sha256:${"b".repeat(64)}`;
  const A_HASH = `sha256:${"c".repeat(64)}`;

  test("another activation landing after the read refuses this one, and running it again is gated", async () => {
    const dir = harness();
    protectProd(dir, [B_HASH]);
    const a = await prepare(dir, A_HASH);
    const b = await prepare(dir, B_HASH);
    // A reads the records (nothing active, so no environment and no protected gate), then
    // B activates into prod with its quorum before A's compare-and-set.
    const landB: ActivationGate = {
      name: "land-b-first",
      check: async () => {
        const landed = await activateDeployment({
          harnessDir: dir,
          dep: b,
          actor: ACTOR,
          cmd: CMD,
          gates,
          environment: "prod",
        });
        expect(landed.ok).toBe(true);
        return { ok: true };
      },
    };
    const answer = await activateDeployment({
      harnessDir: dir,
      dep: a,
      actor: ACTOR,
      cmd: CMD,
      gates: [...gates, landB],
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "conflict",
      message: "another activation landed first; run it again",
    });
    expect(ACTIVATION_RACED_MESSAGE).toBe("another activation landed first; run it again");
    expect(stateOf(dir, b)).toBe("active");
    expect(stateOf(dir, a)).toBe("prepared");
    // Run again, it decides from the records as they are: prod's quorum is needed.
    const again = await activateDeployment({
      harnessDir: dir,
      dep: a,
      actor: ACTOR,
      cmd: CMD,
      gates,
    });
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    expect(!again.ok && again.message).toContain('"prod" is a protected environment');
    expect(stateOf(dir, b)).toBe("active");
    expect(stateOf(dir, a)).toBe("prepared");
  });

  test("two activations that both read before either lands: one lands, the other refuses", async () => {
    const dir = harness();
    const first = await prepare(dir);
    const second = await prepare(dir);
    let arrived = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier: ActivationGate = {
      name: "barrier",
      check: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothRead;
        return { ok: true };
      },
    };
    const answers = await Promise.all(
      [first, second].map((dep) =>
        activateDeployment({
          harnessDir: dir,
          dep,
          actor: ACTOR,
          cmd: CMD,
          gates: [...gates, barrier],
        }),
      ),
    );
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.find((answer) => !answer.ok)).toMatchObject({
      code: "conflict",
      message: ACTIVATION_RACED_MESSAGE,
    });
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.records.filter((r) => r["state"] === "active")).toHaveLength(1);
  });
});

describe("a protected activation binds to the spec revision the build names", () => {
  for (const [name, specHash] of [
    ["no spec revision", null],
    ["an empty spec revision", ""],
  ] as const) {
    test(`a build with ${name} is refused for a protected environment; nothing moves`, async () => {
      const dir = harness();
      // An approval recorded for an empty revision counts for nothing.
      protectProd(dir, [""]);
      const dep = await prepare(dir, specHash);
      const before = readDeployments(dir);
      const answer = await activateDeployment({
        harnessDir: dir,
        dep,
        actor: ACTOR,
        cmd: CMD,
        gates,
        environment: "prod",
      });
      expect(answer).toMatchObject({
        ok: false,
        code: "conflict",
        message: noSpecRevisionMessage("prod"),
        verb: "crewhaus compile",
      });
      expect(noSpecRevisionMessage("prod")).toBe(
        'This build names no spec revision, so an approval for "prod" can\'t bind to it. Run crewhaus compile, then crewhaus deploy activate.',
      );
      expect(readDeployments(dir)).toEqual(before);
    });
  }

  test("replacing a protected environment's build, and a start into it, refuse the same way", async () => {
    const dir = harness();
    protectProd(dir, [`sha256:${"b".repeat(64)}`]);
    const inProd = await prepare(dir);
    expect(
      (
        await activateDeployment({
          harnessDir: dir,
          dep: inProd,
          actor: ACTOR,
          cmd: CMD,
          gates,
          environment: "prod",
        })
      ).ok,
    ).toBe(true);
    const unnamed = await prepare(dir, null);
    const elsewhere = await activateDeployment({
      harnessDir: dir,
      dep: unnamed,
      actor: ACTOR,
      cmd: CMD,
      gates,
      environment: "staging",
    });
    expect(elsewhere).toMatchObject({ ok: false, message: noSpecRevisionMessage("prod") });
    const started = await activateDeployment({
      harnessDir: dir,
      dep: unnamed,
      actor: ACTOR,
      cmd: CMD,
      gates: "not-run",
    });
    expect(started).toMatchObject({ ok: false, message: noSpecRevisionMessage("prod") });
    expect(stateOf(dir, inProd)).toBe("active");
    expect(stateOf(dir, unnamed)).toBe("prepared");
  });

  test("an unprotected environment takes a build with no spec revision", async () => {
    const dir = harness();
    const dep = await prepare(dir, null);
    expect(
      (
        await activateDeployment({
          harnessDir: dir,
          dep,
          actor: ACTOR,
          cmd: CMD,
          gates,
          environment: "staging",
        })
      ).ok,
    ).toBe(true);
  });
});

describe("a start's record names only the spec revision its build came from", () => {
  function artifactOfActive(dir: string): Record<string, unknown> {
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    return read.active?.["artifact"] as Record<string, unknown>;
  }
  const stamp = (specHash: string) =>
    JSON.stringify({ name: "crewhaus-compiled-bundle", crewhaus: { specHash } });

  test("a bundle stamped with the saved spec's revision: the record names it", async () => {
    const dir = harness();
    put(dir, "dist/package.json", stamp(specRevision(SPEC)));
    expect((await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR })).ok).toBe(
      true,
    );
    expect(artifactOfActive(dir)["specHash"]).toBe(specRevision(SPEC));
  });

  test("a bundle stamped from another spec, or not stamped: the record names none", async () => {
    for (const manifest of [stamp(specRevision("name: other\n")), undefined]) {
      const dir = harness();
      if (manifest !== undefined) put(dir, "dist/package.json", manifest);
      expect((await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR })).ok).toBe(
        true,
      );
      expect(artifactOfActive(dir)["specHash"]).toBeUndefined();
      expect(artifactOfActive(dir)["digest"]).toMatch(/^sha256:/);
    }
  });
});

describe("a build runs from regular files only", () => {
  function linked(dir: string): void {
    const outside = mkdtempSync(join(tmpdir(), "cs-link-"));
    put(outside, "lib.ts", "// elsewhere\n");
    symlinkSync(join(outside, "lib.ts"), join(dir, "dist/lib.ts"));
  }

  test("a start does not record a build holding a link; it names the link", async () => {
    const dir = harness();
    linked(dir);
    const answer = await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR });
    expect(answer).toEqual({ ok: false, message: buildLinkMessage("dist/lib.ts") });
    expect(readDeployments(dir).state).toBe("absent");
  });

  test("a prepared record of a build holding a link is never activated by a start", async () => {
    const dir = harness();
    linked(dir);
    const compiled = await prepare(dir);
    const answer = await admitExplicitStart(dir, "channel", {
      head: "home",
      actor: ACTOR,
      ledgerAbsent: true,
    });
    expect(answer).toEqual({ ok: false, message: buildLinkMessage("dist/lib.ts") });
    expect(stateOf(dir, compiled)).toBe("prepared");
  });

  test("an active build holding a link: Home's start is told which link", async () => {
    const dir = harness();
    linked(dir);
    const dep = await prepare(dir);
    expect(
      (await activateDeployment({ harnessDir: dir, dep, actor: ACTOR, cmd: CMD, gates })).ok,
    ).toBe(true);
    const answer = await admitExplicitStart(dir, "channel", { head: "home", actor: ACTOR });
    expect(answer).toEqual({ ok: false, message: buildLinkMessage("dist/lib.ts") });
  });
});

describe("a start asked to decide only writes nothing", () => {
  test("no records: it would record and activate, and nothing is written", async () => {
    const dir = harness();
    const answer = await admitExplicitStart(dir, "channel", {
      head: "home",
      actor: ACTOR,
      decideOnly: true,
    });
    expect(answer).toEqual({ ok: true });
    expect(readDeployments(dir).state).toBe("absent");
    expect(existsSync(join(dir, ".crewhaus"))).toBe(false);
  });

  test("its refusals are the start's: a link, a root bundle, a changed build from Home", async () => {
    const linkedDir = harness();
    const outside = mkdtempSync(join(tmpdir(), "cs-link-"));
    put(outside, "lib.ts", "x\n");
    symlinkSync(join(outside, "lib.ts"), join(linkedDir, "dist/lib.ts"));
    expect(
      await admitExplicitStart(linkedDir, "channel", {
        head: "home",
        actor: ACTOR,
        decideOnly: true,
      }),
    ).toEqual({ ok: false, message: buildLinkMessage("dist/lib.ts") });

    const root = tempDir();
    put(root, "crewhaus.yaml", "name: demo\ntarget: cli\n");
    put(root, "agent.ts", "// compiled with -o .\n");
    put(root, "package.json", JSON.stringify({ name: "crewhaus-compiled-bundle" }));
    expect(
      await admitExplicitStart(root, "cli", { head: "cli-direct", actor: ACTOR, decideOnly: true }),
    ).toEqual({ ok: false, message: ROOT_BUNDLE_UNRECORDED_MESSAGE });

    const changed = harness();
    const dep = await prepare(changed);
    await activateDeployment({ harnessDir: changed, dep, actor: ACTOR, cmd: CMD, gates });
    put(changed, "dist/daemon.ts", "// recompiled\n");
    const before = readDeployments(changed);
    expect(
      (
        await admitExplicitStart(changed, "channel", {
          head: "home",
          actor: ACTOR,
          decideOnly: true,
        })
      ).ok,
    ).toBe(false);
    // The CLI would record and activate it: decided, not done.
    expect(
      await admitExplicitStart(changed, "channel", {
        head: "cli-direct",
        actor: ACTOR,
        decideOnly: true,
      }),
    ).toEqual({ ok: true });
    expect(readDeployments(changed)).toEqual(before);
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
    expect(reconcileActivation(receipt(target), { harnessDir: undefined })).toBe("unknown");
  });

  test("a receipt that names only the harness: every row of the table", async () => {
    const byHarness = receipt(`home/harness/${HRN}`);
    // No deployment recorded at all: it did not happen.
    const empty = harness();
    expect(reconcileActivation(byHarness, { harnessDir: empty })).toBe("not-done");
    // Records that cannot be read: nobody can say.
    const broken = harness();
    mkdirSync(join(broken, ".crewhaus", "run", "control", "deployments.jsonl"), {
      recursive: true,
    });
    expect(reconcileActivation(byHarness, { harnessDir: broken })).toBe("unknown");
    // Prepared, but no record carries this command: not done.
    const dir = harness();
    const first = await prepare(dir);
    expect(reconcileActivation(byHarness, { harnessDir: dir })).toBe("not-done");
    // Activated by this command: done, and still done once a later activation supersedes it.
    await activateDeployment({ harnessDir: dir, dep: first, actor: ACTOR, cmd: CMD, gates });
    expect(reconcileActivation(byHarness, { harnessDir: dir })).toBe("done");
    const second = await prepare(dir);
    const later = "cmd_01cccccccccccccccccccccccc";
    await activateDeployment({ harnessDir: dir, dep: second, actor: ACTOR, cmd: later, gates });
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.records.find((r) => r["id"] === first)?.["state"]).toBe("superseded");
    expect(reconcileActivation(byHarness, { harnessDir: dir })).toBe("done");
    expect(reconcileActivation(receipt(`home/harness/${HRN}`, later), { harnessDir: dir })).toBe(
      "done",
    );
    expect(
      reconcileActivation(receipt(`home/harness/${HRN}`, "cmd_01bbbbbbbbbbbbbbbbbbbbbbbb"), {
        harnessDir: dir,
      }),
    ).toBe("not-done");
    // A harness with no live directory, and a target that is neither: nobody can say.
    expect(reconcileActivation(byHarness, { harnessDir: undefined })).toBe("unknown");
    expect(reconcileActivation(receipt(`home/cmd/${CMD}`), { harnessDir: dir })).toBe("unknown");
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
