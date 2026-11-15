/**
 * `crewhaus retire` as a command: a live daemon is refused without `--stop`, a dry run
 * changes nothing, and a retirement stops, disables, records and archives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type Dirent,
  appendFileSync,
  cpSync,
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
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalIdentity, ensureAccessSetUp, localActorOf } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import {
  append,
  casAppend,
  delegationsLedger,
  foldStates,
  readOperatorRecord,
  writeHarnessIdentity,
} from "@crewhaus/control-records";
import { commandsLedgerOf, retireSteps, workspaceCommandsLedger } from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { ProcessOps, SpawnedProcess } from "@crewhaus/harness-supervisor";
import {
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { directControl, harnessIdOf, runDaemonCommand } from "./daemon-cmd";
import { type HeavyRetireSteps, retireCommand } from "./retire-cmd";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Child = { pid: number; signals: string[]; exit: () => void };

/** Process ops whose children are records: nothing is spawned. */
function fakeOps(): ProcessOps & { children: Child[] } {
  let nextPid = 7_001;
  const live = new Map<number, { startTimeMs: number; commandLine: string }>();
  const children: Child[] = [];
  const signal = (pid: number, name: string): void => {
    const child = children.find((c) => c.pid === pid);
    child?.signals.push(name);
    child?.exit();
  };
  return {
    children,
    spawn: (request) => {
      const pid = nextPid++;
      let settle: (v: { code: number | null; signal: string | null }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
        settle = r;
      });
      children.push({
        pid,
        signals: [],
        exit: () => {
          live.delete(pid);
          settle({ code: null, signal: "SIGTERM" });
        },
      });
      live.set(pid, { startTimeMs: Date.now(), commandLine: request.argv.join(" ") });
      return {
        pid,
        exited,
        write: () => {},
        closeStdin: () => {},
        unref: () => {},
      } as SpawnedProcess;
    },
    isAlive: (pid) => live.has(pid),
    startTimeMs: (pid) => live.get(pid)?.startTimeMs,
    commandLine: (pid) => live.get(pid)?.commandLine,
    terminate: (pid) => signal(pid, "SIGTERM"),
    forceKill: (pid) => signal(pid, "SIGKILL"),
  } as ProcessOps & { children: Child[] };
}

/** Every path under `dir` with its bytes: what "nothing changed" compares. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        out.set(path, "dir");
        walk(path);
      } else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

type StepAnswer = { step: string; ok: boolean; detail: string };

function setUp(
  over: {
    /** Replaces the last step before the archive. */
    readonly tombstoneRegistry?: (at: {
      readonly root: string;
      readonly dir: string;
    }) => Promise<StepAnswer>;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retire-cmd-")));
  roots.push(root);
  const dir = join(root, "harness");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "daemon.ts"), "// compiled bundle\n");
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    "name: concierge\ntarget: channel\nagent:\n  model: anthropic/claude-sonnet-4\n  instructions: hi\n",
  );
  const registryRoot = join(root, "registry");
  const hangarRoot = join(root, "hangar");
  const row = openHangarRegistry({ root: registryRoot, env: {} }).upsert({
    dir,
    specName: "concierge",
    target: "channel",
  });
  const ops = fakeOps();
  const opts = {
    env: { CREWHAUS_REGISTRY_ROOT: registryRoot, CREWHAUS_HANGAR_ROOT: hangarRoot },
    ops,
    cwd: dir,
  };
  const calls: string[] = [];
  const ok = (step: string) => async () => {
    calls.push(step);
    return { step, ok: true, detail: "ok" };
  };
  const heavy: HeavyRetireSteps = {
    backupState: ok("backupState"),
    complianceEvidence: ok("complianceEvidence"),
    auditVerify: ok("auditVerify"),
    pushKnowledge: ok("pushKnowledge"),
    tombstoneRegistry:
      over.tombstoneRegistry !== undefined
        ? async () => {
            calls.push("tombstoneRegistry");
            return (over.tombstoneRegistry as NonNullable<typeof over.tombstoneRegistry>)({
              root,
              dir,
            });
          }
        : ok("tombstoneRegistry"),
  };
  const retire = (
    run: {
      stop?: boolean;
      dryRun?: boolean;
      harnessDir?: string;
      cwd?: string;
      opts?: Parameters<typeof retireCommand>[0]["opts"];
    } = {},
  ) =>
    retireCommand({
      harnessDir: run.harnessDir ?? dir,
      specName: "concierge",
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
      stop: run.stop ?? false,
      dryRun: run.dryRun ?? false,
      forceUnverified: false,
      heavy,
      opts: run.cwd !== undefined ? { ...(run.opts ?? opts), cwd: run.cwd } : (run.opts ?? opts),
    });
  return { root, dir, hangarRoot, registryRoot, row, ops, opts, calls, retire };
}

describe("crewhaus retire", () => {
  test("a live daemon without --stop is refused and nothing changes, here or in Home", async () => {
    const s = setUp();
    expect((await runDaemonCommand(["start", "--no-preflight"], s.opts)).exitCode).toBe(0);
    const harnessBefore = tree(s.dir);
    const homeBefore = tree(s.hangarRoot);
    const out = await s.retire();
    expect(out.exitCode).not.toBe(0);
    expect(out.lines.join("\n")).toContain("Stop it first, or run `crewhaus retire --stop`");
    expect(tree(s.dir)).toEqual(harnessBefore);
    expect(tree(s.hangarRoot)).toEqual(homeBefore);
    expect(s.calls).toEqual([]);
    expect(s.ops.children[0]?.signals).toEqual([]);
    await runDaemonCommand(["stop"], s.opts);
  }, 20_000); // an adopted daemon's exit is noticed on the pump's real-time poll

  test("a dry run writes no receipt, no key and no lease, and lists every step", async () => {
    const s = setUp();
    const harnessBefore = tree(s.dir);
    const homeBefore = tree(s.hangarRoot);
    const out = await s.retire({ dryRun: true });
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("disable the harness so nothing starts it");
    expect(text).toContain("Connections: none are registered here.");
    expect(tree(s.dir)).toEqual(harnessBefore);
    expect(tree(s.hangarRoot)).toEqual(homeBefore);
    expect(existsSync(join(s.hangarRoot, "control"))).toBe(false);
  });

  test("a dry run lists the delegation rules that end, and still says to revoke connections", async () => {
    const s = setUp();
    const id = mintId("rule");
    const planted = await casAppend(delegationsLedger(s.dir), id, null, {
      v: 1,
      at: new Date().toISOString(),
      id,
      state: "enabled",
      kind: "delegate",
      action: "merge",
      revision: 1,
      scope: { harness: "hrn_0123456789abcdef" },
      terms: { days: 14 },
      termsDigest: "a".repeat(64),
      ceilingDigest: `sha256:${"b".repeat(64)}`,
      policyRevision: `sha256:${"c".repeat(64)}`,
      consequencesDigest: "d".repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      owner: `local:#${"e".repeat(64)}`,
      cmd: mintId("cmd"),
    });
    expect(planted.ok && planted.applied).toBe(true);
    const out = await s.retire({ dryRun: true });
    expect(out.exitCode).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("retire.delegations — 1 delegation rule(s) end");
    expect(text).toContain(
      "channel and service credentials — none are registered here; revoke them where they were issued (do this by hand)",
    );
  });

  test("--stop stops it, disables it, records the retirement and archives the row", async () => {
    const s = setUp();
    expect((await runDaemonCommand(["start", "--no-preflight"], s.opts)).exitCode).toBe(0);
    const out = await s.retire({ stop: true });
    expect(out.exitCode).toBe(0);
    expect(s.ops.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(s.calls).toEqual([
      "backupState",
      "complianceEvidence",
      "auditVerify",
      "tombstoneRegistry",
    ]);

    // The harness's state moved into the archive, disabled and recorded stopped.
    const operator = JSON.parse(
      readFileSync(
        join(s.root, "archive", "crewhaus-state", "run", "control", "operator.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(operator["deployment"]).toMatchObject({ disabled: true });
    expect(operator["desired"]).toBe("stopped");
    // Where it lives, only its control directory is left, and it says disabled again.
    const live = [...tree(join(s.dir, ".crewhaus")).keys()];
    const controlDir = join(s.dir, ".crewhaus", "run", "control");
    expect(live.length).toBeGreaterThan(0);
    expect(
      live.filter((p) => p !== join(s.dir, ".crewhaus", "run") && !p.startsWith(controlDir)),
    ).toEqual([]);
    const kept = JSON.parse(readFileSync(join(controlDir, "operator.json"), "utf8")) as Record<
      string,
      unknown
    >;

    // One receipt in Home's own ledger, one lifecycle line naming it, the row archived.
    const fold = foldStates(workspaceCommandsLedger(s.hangarRoot));
    if (!fold.ok) throw new Error(fold.reason);
    const receipts = [...fold.objects.values()].map((o) => o.record as Record<string, unknown>);
    expect(receipts.map((r) => [r["kind"], r["state"]])).toEqual([
      ["controls.retire", "succeeded"],
    ]);
    const receipt = receipts[0] as Record<string, unknown>;
    expect(receipt["target"]).toBe(`home/harness/${s.row.id}`);
    expect(out.lines.at(-1)).toBe(`Done (${receipt["id"]})`);
    const lines = readFileSync(join(s.hangarRoot, "control", "lifecycle.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "harness.retired",
      harness: s.row.id,
      cmd: receipt["id"],
      by: receipt["actor"],
    });
    expect(kept["deployment"]).toMatchObject({
      disabled: true,
      cmd: receipt["id"],
      by: receipt["actor"],
    });
    expect(kept["desired"]).toBe("stopped");
    const row = openHangarRegistry({ root: s.registryRoot, env: {} }).get(s.row.id);
    expect(row?.archived).toMatchObject({ cmd: receipt["id"], by: receipt["actor"] });
    const kinds = (receipt["effects"] as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds.indexOf("retire.stop")).toBe(0);
    expect(kinds.indexOf("retire.archive")).toBeGreaterThan(-1);
    expect(kinds.indexOf("retire.archive")).toBeLessThan(kinds.indexOf("retire.keep-disabled"));
    expect(kinds.indexOf("retire.keep-disabled")).toBeLessThan(kinds.indexOf("retire.lifecycle"));
  }, 20_000); // an adopted daemon's exit is noticed on the pump's real-time poll

  test("a retired harness is not started again from where it lives", async () => {
    const s = setUp();
    expect((await runDaemonCommand(["start", "--no-preflight"], s.opts)).exitCode).toBe(0);
    expect((await s.retire({ stop: true })).exitCode).toBe(0);
    expect(s.ops.children).toHaveLength(1);
    const again = await runDaemonCommand(["start", "--no-preflight"], s.opts);
    expect(again.exitCode).toBe(38);
    expect(again.lines.join("\n")).toContain("crewhaus daemon enable");
    expect(s.ops.children).toHaveLength(1);
  }, 20_000); // an adopted daemon's exit is noticed on the pump's real-time poll
});

describe("who a retirement of a governed harness is recorded as", () => {
  const OWNER: LocalIdentity = { username: "owner", hostname: "laptop" };

  /** Plant an active `local` link from `identity` to `principal` in `hangarRoot`'s access records. */
  function linkTo(hangarRoot: string, identity: LocalIdentity, principal: string, by: string) {
    const link = mintId("lnk");
    const at = new Date().toISOString();
    const dir = join(hangarRoot, "access");
    appendFileSync(
      join(dir, "principals.jsonl"),
      `${JSON.stringify({ id: principal, kind: "member", state: "active", at, by })}\n`,
    );
    appendFileSync(
      join(dir, "links.jsonl"),
      `${JSON.stringify({
        id: link,
        principal,
        provider: "local",
        subjectRef: "e".repeat(64),
        verifiedVia: "owner",
        state: "active",
        at,
        by,
      })}\n`,
    );
    const file = join(dir, "subjects.json");
    const subjects = JSON.parse(readFileSync(file, "utf8")) as { links: Record<string, string> };
    subjects.links[link] = localActorOf(identity);
    writeFileSync(file, `${JSON.stringify(subjects, null, 2)}\n`);
  }

  /**
   * Retire a harness whose approver list Home A wrote: from A itself, or, when `foreign`, from
   * another Home root whose records link the same user to A's owner.
   */
  async function retiredFrom(foreign: boolean) {
    const s = setUp();
    const a = await ensureAccessSetUp(s.hangarRoot, { localActor: localActorOf(OWNER) });
    if (!a.ok) throw new Error(a.reason);
    const control = join(s.dir, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(
      join(control, "approvers.json"),
      `${JSON.stringify({
        v: 1,
        epoch: 1,
        generatedAt: new Date().toISOString(),
        harness: "hrn_00000000000000d1",
        owner: a.result.owner,
        governedSince: new Date(Date.now() - 86_400_000).toISOString(),
        members: [],
        links: [],
        accessRoot: realpathSync(s.hangarRoot),
      })}\n`,
    );
    let runFrom = s.hangarRoot;
    if (foreign) {
      runFrom = join(s.root, "other-home");
      const b = await ensureAccessSetUp(runFrom, {
        localActor: localActorOf({ username: "eve", hostname: "laptop" }),
      });
      if (!b.ok) throw new Error(b.reason);
      linkTo(runFrom, OWNER, a.result.owner, b.result.owner);
    }
    const env = { ...s.opts.env, CREWHAUS_HANGAR_ROOT: runFrom };
    const out = await s.retire({ opts: { ...s.opts, env, identity: OWNER } });
    expect(out.exitCode).toBe(0);
    const fold = foldStates(workspaceCommandsLedger(runFrom));
    if (!fold.ok) throw new Error(fold.reason);
    const receipt = [...fold.objects.values()][0]?.record as Record<string, unknown>;
    const kept = JSON.parse(readFileSync(join(control, "operator.json"), "utf8")) as {
      deployment?: { by?: string };
    };
    return { owner: a.result.owner, actor: receipt["actor"], by: kept.deployment?.by };
  }

  test("run from another Home root, it is the keyed local actor", async () => {
    const { actor, by } = await retiredFrom(true);
    expect(actor).toMatch(/^local:#[0-9a-f]{64}$/);
    expect(by).toBe(actor as string);
  }, 20_000); // two Homes' access records are set up

  test("run from the Home root the list names, it is the owner", async () => {
    const { owner, actor, by } = await retiredFrom(false);
    expect(actor).toBe(owner);
    expect(by).toBe(owner);
  }, 20_000); // the Home's access records are set up
});

/** The workspace ledger's receipts, as written. */
function workspaceReceipts(hangarRoot: string): Record<string, unknown>[] {
  const fold = foldStates(workspaceCommandsLedger(hangarRoot));
  if (!fold.ok) throw new Error(fold.reason);
  return [...fold.objects.values()].map((o) => o.record as Record<string, unknown>);
}

/** Home's lifecycle lines. */
function lifecycleLines(hangarRoot: string): Record<string, unknown>[] {
  return readFileSync(join(hangarRoot, "control", "lifecycle.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("crewhaus retire is done only when every step after the archive did its part", () => {
  test("a harness it cannot keep disabled where it lives is Not done, and the line names daemon disable", async () => {
    // The last step before the archive leaves `.crewhaus` a link out of the harness, so
    // the operator record can't be written where the harness lives.
    const s = setUp({
      tombstoneRegistry: async ({ root, dir }) => {
        rmSync(join(dir, ".crewhaus"), { recursive: true, force: true });
        symlinkSync(join(root, "absent"), join(dir, ".crewhaus"));
        return { step: "tombstoneRegistry", ok: true, detail: "ok" };
      },
    });
    const out = await s.retire();
    expect(out.exitCode).not.toBe(0);
    const receipts = workspaceReceipts(s.hangarRoot);
    expect(receipts.map((r) => [r["kind"], r["state"]])).toEqual([["controls.retire", "failed"]]);
    const receipt = receipts[0] as Record<string, unknown>;
    expect(out.lines.at(-1)).toBe(`Not done (${receipt["id"]})`);
    const text = out.lines.join("\n");
    expect(text).toContain("✗ keepDisabled");
    expect(out.lines.some((l) => l.includes("crewhaus daemon disable") && l.includes(s.dir))).toBe(
      true,
    );
    expect((receipt["outcome"] as { code?: string } | undefined)?.code).toBe("internal");
    expect(receipt["effects"]).toContainEqual({ kind: "retire.keep-disabled", status: "failed" });
    // The steps after it still ran: the lifecycle line and the registry row landed.
    expect(lifecycleLines(s.hangarRoot)).toContainEqual(
      expect.objectContaining({ type: "harness.retired", cmd: receipt["id"] }),
    );
    const row = openHangarRegistry({ root: s.registryRoot, env: {} }).get(s.row.id);
    expect(row?.archived).toMatchObject({ cmd: receipt["id"] });
  });
});

describe("retire marks only the registry row of its own directory", () => {
  test("a copy of a registered harness retires as itself: no row archived, no harness named", async () => {
    const s = setUp();
    expect(writeHarnessIdentity(s.dir, { id: s.row.id }).ok).toBe(true);
    const copy = join(s.root, "copy");
    cpSync(s.dir, copy, { recursive: true });
    const out = await s.retire({ harnessDir: copy, cwd: copy });
    expect(out.exitCode).toBe(0);
    const registry = openHangarRegistry({ root: s.registryRoot, env: {} });
    expect(registry.get(s.row.id)?.archived).toBeUndefined();
    const receipts = workspaceReceipts(s.hangarRoot);
    expect(receipts.map((r) => [r["kind"], r["state"]])).toEqual([
      ["controls.retire", "succeeded"],
    ]);
    const receipt = receipts[0] as Record<string, unknown>;
    // Given no target, the receipt names itself.
    expect(receipt["target"]).toBe(`home/cmd/${receipt["id"]}`);
    expect(out.lines.at(-1)).toBe(`Done (${receipt["id"]})`);
    const lines = lifecycleLines(s.hangarRoot);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "harness.retired", harness: null, cmd: receipt["id"] });
  });

  test("a harness retired through a link to its directory archives its own row", async () => {
    const s = setUp();
    expect(writeHarnessIdentity(s.dir, { id: s.row.id }).ok).toBe(true);
    const link = join(s.root, "link");
    symlinkSync(s.dir, link);
    const out = await s.retire({ harnessDir: link, cwd: link });
    expect(out.exitCode).toBe(0);
    const receipt = workspaceReceipts(s.hangarRoot)[0] as Record<string, unknown>;
    expect(receipt["target"]).toBe(`home/harness/${s.row.id}`);
    const row = openHangarRegistry({ root: s.registryRoot, env: {} }).get(s.row.id);
    expect(row?.archived).toMatchObject({ cmd: receipt["id"] });
  });
});

describe.skipIf(process.platform === "win32")(
  "retiring a harness whose sessions folder lies outside it",
  () => {
    test("expires no approval there, says so in its receipt, and leaves that folder as it was", async () => {
      const s = setUp();
      const outside = join(s.root, "other", ".crewhaus", "sessions");
      mkdirSync(outside, { recursive: true });
      const id = generateApprovalId();
      await createPendingApprovalStore({ rootDir: outside }).persist({
        id,
        toolName: "Write",
        inputHash: hashApprovalInput("Write", { path: "a.md" }),
        input: { path: "a.md" },
        runId: "run_1",
        sessionId: "sess_00000000deadbeef",
        surface: "single-turn",
        createdAt: new Date().toISOString(),
      });
      mkdirSync(join(s.dir, ".crewhaus"), { recursive: true });
      symlinkSync(outside, join(s.dir, ".crewhaus", "sessions"), "dir");
      const pendingIds = () =>
        foldReadOnly(outside)
          .records.filter((record) => record.decision === undefined)
          .map((record) => record.id);
      expect(pendingIds()).toEqual([id]);
      const before = tree(outside);
      const out = await s.retire();
      expect(out.exitCode).toBe(0);
      const receipt = workspaceReceipts(s.hangarRoot)[0] as Record<string, unknown>;
      expect(receipt["state"]).toBe("succeeded");
      expect(receipt["effects"]).toContainEqual({
        kind: "retire.approvals",
        status: "skipped",
        observed: "sessions folder outside the harness",
      });
      expect(tree(outside)).toEqual(before);
      expect(pendingIds()).toEqual([id]);
    });
  },
);

describe("a harness directory's id", () => {
  test("a copy whose harness.json names another directory's row has no id", () => {
    const s = setUp();
    expect(writeHarnessIdentity(s.dir, { id: s.row.id }).ok).toBe(true);
    const copy = join(s.root, "copy");
    cpSync(s.dir, copy, { recursive: true });
    expect(harnessIdOf(copy, s.opts)).toBeUndefined();
    expect(harnessIdOf(s.dir, s.opts)).toBe(s.row.id);
  });

  test("an unregistered harness answers its own harness.json id", () => {
    const s = setUp();
    const other = join(s.root, "other");
    mkdirSync(other, { recursive: true });
    const id = "hrn_0123456789abcdef";
    expect(writeHarnessIdentity(other, { id }).ok).toBe(true);
    expect(harnessIdOf(other, s.opts)).toBe(id);
  });

  test("a registered harness reached through a link answers its row's id", () => {
    const s = setUp();
    const link = join(s.root, "link");
    symlinkSync(s.dir, link);
    expect(harnessIdOf(link, s.opts)).toBe(s.row.id);
  });
});

describe("a retire's disable outranks an earlier enable that never finished", () => {
  test("after Home's retire disables the harness, crewhaus daemon start exits 38", async () => {
    const s = setUp();
    // A dead CLI's enable, accepted an hour ago and never finished.
    const enable = mintId("cmd");
    const planted = append(commandsLedgerOf(s.dir), {
      id: enable,
      v: 1,
      kind: "controls.enable",
      target: `home/harness/${s.row.id}`,
      actor: `local:#${"a".repeat(64)}`,
      via: "cli",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: new Date(Date.now() - 3_600_000).toISOString(),
      executor: {
        pid: 999_999,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        host: hostname(),
        head: "cli",
      },
      effects: [],
      retry: { retryable: true, safety: "idempotent" },
    });
    expect(planted.ok).toBe(true);
    // Home's retire: stop and disable, then disable again where it lives, under its receipt.
    const answer = await directControl(s.opts).commands.submit(
      {
        kind: "controls.retire",
        target: `home/harness/${s.row.id}`,
        ledger: "workspace",
        via: "cli",
        body: {},
      },
      async (receipt) => {
        const steps = retireSteps({
          harnessDir: s.dir,
          harnessId: s.row.id,
          hangarRoot: s.hangarRoot,
          receipt,
          stop: false,
          now: () => Date.now(),
          probe: s.ops,
        });
        const disabled = await steps.stopAndDisable();
        const kept = await steps.keepDisabled();
        return {
          settle: {
            state: disabled.ok && kept.ok ? "succeeded" : "failed",
            effects: [...steps.effects()],
          },
          value: undefined,
        };
      },
    );
    expect(answer.ok && answer.receipt.state).toBe("succeeded");
    const started = await runDaemonCommand(["start", "--no-preflight"], s.opts);
    expect(started.exitCode).toBe(38);
    expect(s.ops.children).toEqual([]);
    const read = readOperatorRecord.refresh(s.dir);
    expect(read.state === "present" && read.record.deployment?.disabled).toBe(true);
    const fold = foldStates(commandsLedgerOf(s.dir));
    if (!fold.ok) throw new Error(fold.reason);
    const settled = fold.objects.get(enable);
    expect(settled?.state).toBe("unknown");
    expect(settled?.record["outcome"]).toMatchObject({ code: "interrupted" });
  });
});
