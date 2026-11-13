/**
 * `crewhaus retire` as a command: a live daemon is refused without `--stop`, a dry run
 * changes nothing, and a retirement stops, disables, records and archives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldStates } from "@crewhaus/control-records";
import { workspaceCommandsLedger } from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { ProcessOps, SpawnedProcess } from "@crewhaus/harness-supervisor";
import { runDaemonCommand } from "./daemon-cmd";
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

function setUp() {
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
    tombstoneRegistry: ok("tombstoneRegistry"),
  };
  const retire = (over: { stop?: boolean; dryRun?: boolean } = {}) =>
    retireCommand({
      harnessDir: dir,
      specName: "concierge",
      archiveDir: join(root, "archive"),
      pins: {},
      force: false,
      pushKnowledge: false,
      stop: over.stop ?? false,
      dryRun: over.dryRun ?? false,
      forceUnverified: false,
      heavy,
      opts,
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
    expect(existsSync(join(s.dir, ".crewhaus"))).toBe(false);
    const operator = JSON.parse(
      readFileSync(
        join(s.root, "archive", "crewhaus-state", "run", "control", "operator.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(operator["deployment"]).toMatchObject({ disabled: true });
    expect(operator["desired"]).toBe("stopped");

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
    const row = openHangarRegistry({ root: s.registryRoot, env: {} }).get(s.row.id);
    expect(row?.archived).toMatchObject({ cmd: receipt["id"], by: receipt["actor"] });
    const kinds = (receipt["effects"] as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds.indexOf("retire.stop")).toBe(0);
    expect(kinds.indexOf("retire.archive")).toBeLessThan(kinds.indexOf("retire.lifecycle"));
    expect(kinds.indexOf("retire.archive")).toBeGreaterThan(-1);
  }, 20_000); // an adopted daemon's exit is noticed on the pump's real-time poll
});
