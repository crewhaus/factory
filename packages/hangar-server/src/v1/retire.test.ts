/**
 * Retiring through the API: a dry run hands back a nonce bound to this harness and this
 * caller; the real run needs the harness's typed name and that nonce, once; a live daemon
 * needs `stop: true`; and a step that fails stops the retirement there, so the harness is
 * neither recorded as retired nor archived in Home, and its receipt says it failed. Before
 * it acts, a retire settles the harness's unfinished commands, so its disable is the latest
 * word on the harness.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { append, assertRunnable, foldStates, readOperatorRecord } from "@crewhaus/control-records";
import {
  LIFECYCLE_FILE,
  commandsLedgerOf,
  workspaceCommandsLedger,
} from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { foldReadOnly } from "@crewhaus/session-store";
import { type V1Home, v1Home } from "../__test__/v1-home";
import type { ProcessLayer } from "../process";

/** Make every handle report a running daemon, or refuse to stop, as a test asks. */
const fault = { running: false, stopFails: false };

function faulty(layer: ProcessLayer): ProcessLayer {
  const wrap = <T extends object>(target: T, overrides: Record<string, unknown>): T =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop === "string" && Object.hasOwn(overrides, prop)) {
          const value = overrides[prop];
          if (value !== undefined) return value;
        }
        const value = Reflect.get(t, prop, t);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return wrap(layer, {
    get: (entry: Parameters<ProcessLayer["get"]>[0]) => {
      const handle = layer.get(entry);
      return wrap(handle, {
        snapshot: fault.running ? () => ({ ...handle.snapshot(), state: "running" }) : undefined,
        supervisor: fault.stopFails
          ? wrap(handle.supervisor, { stop: async () => ({ stopped: false, forced: false }) })
          : undefined,
      });
    },
  });
}

let home: V1Home;

beforeAll(async () => {
  home = await v1Home({ wrapProcessLayer: faulty });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const path = (id: string) => `/api/v1/harnesses/${id}/controls/retire`;

async function plan(id: string, secret?: string): Promise<string> {
  const res = await home.call("POST", path(id), {
    body: {},
    ...(secret !== undefined ? { secret } : {}),
  });
  expect(res.status).toBe(200);
  expect(res.body["dryRun"]).toBe(true);
  const nonce = res.body["nonce"];
  expect(typeof nonce).toBe("string");
  return nonce as string;
}

function retireReceipts(): Record<string, unknown>[] {
  const fold = foldStates(workspaceCommandsLedger(home.t.hangarRoot));
  if (!fold.ok) return [];
  return [...fold.objects.values()]
    .map((object) => object.record as unknown as Record<string, unknown>)
    .filter((row) => row["kind"] === "controls.retire");
}

function retiredLines(): string[] {
  const file = join(home.t.hangarRoot, LIFECYCLE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes("harness.retired"));
}

function archived(id: string): boolean {
  const registry = openHangarRegistry({ root: home.t.registryRoot, env: {} });
  return registry.get(id)?.archived !== undefined;
}

describe("retiring through the API", () => {
  test("a dry run lists the steps and hands back a nonce, and changes nothing", async () => {
    const h = await home.harness("dry");
    const res = await home.call("POST", path(h.id), { body: {} });
    expect(res.status).toBe(200);
    expect(res.body["dryRun"]).toBe(true);
    expect(typeof res.body["nonce"]).toBe("string");
    const steps = res.body["steps"] as { kind: string; status: string }[];
    expect(steps.map((s) => s.kind).slice(0, 2)).toEqual(["stopAndDisable", "cancelQueuedRuns"]);
    expect(steps.every((s) => s.status === "planned" || s.status === "manual")).toBe(true);
    expect(archived(h.id)).toBe(false);
  });

  test("a name that is not the harness's is 412", async () => {
    const h = await home.harness("named");
    const nonce = await plan(h.id);
    const res = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "not-it", nonce },
    });
    expect(res.status).toBe(412);
    expect((res.body["error"] as Record<string, unknown>)["reason"]).toBe("confirm_name");
    expect(archived(h.id)).toBe(false);
  });

  test("a nonce is spent once, and binds its harness and its caller", async () => {
    const h = await home.harness("bound");
    const other = await home.harness("other");
    const nonceReason = (res: { body: Record<string, unknown> }) =>
      (res.body["error"] as Record<string, unknown>)["reason"];
    // Minted for another harness.
    const forOther = await plan(other.id);
    const wrongHarness = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "bound", nonce: forOther },
    });
    expect(wrongHarness.status).toBe(412);
    expect(nonceReason(wrongHarness)).toBe("nonce");
    // Minted for another caller.
    const member = await home.member("Rita", "owner");
    const forMember = await plan(h.id, member.secret);
    const wrongCaller = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "bound", nonce: forMember },
    });
    expect(wrongCaller.status).toBe(412);
    expect(nonceReason(wrongCaller)).toBe("nonce");
    // Reused: the first real run spends it, the second is refused.
    const nonce = await plan(h.id);
    const first = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "bound", nonce },
    });
    expect(first.status).toBe(200);
    const again = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "bound", nonce },
    });
    expect(again.status).toBe(412);
    expect(nonceReason(again)).toBe("nonce");
  }, 30_000); // a member's device sign-in and a whole retirement

  test("a running daemon is 409 unless the retire stops it", async () => {
    const h = await home.harness("live");
    fault.running = true;
    try {
      const nonce = await plan(h.id);
      const res = await home.call("POST", path(h.id), {
        body: { dryRun: false, confirmName: "live", nonce },
      });
      expect(res.status).toBe(409);
      expect((res.body["error"] as Record<string, unknown>)["reason"]).toBe("daemon_live");
      expect(archived(h.id)).toBe(false);
    } finally {
      fault.running = false;
    }
  });

  test("a step that fails stops the retirement: not archived, not recorded, receipt failed", async () => {
    const h = await home.harness("stuck");
    const before = retireReceipts().length;
    const lines = retiredLines().length;
    fault.stopFails = true;
    try {
      const nonce = await plan(h.id);
      const res = await home.call("POST", path(h.id), {
        body: { dryRun: false, confirmName: "stuck", nonce, stop: true },
      });
      expect(res.status).toBe(200);
      const steps = res.body["steps"] as { kind: string; status: string }[];
      expect(steps[0]).toMatchObject({ kind: "stopAndDisable", status: "failed" });
      expect(steps.slice(1).every((s) => s.status === "skipped")).toBe(true);
      expect(steps.map((s) => s.kind)).toContain("archiveRegistryRow");
      expect(String(res.body["remedy"])).toContain("not retired");
      expect((res.body["receipt"] as Record<string, unknown>)["state"]).toBe("failed");
    } finally {
      fault.stopFails = false;
    }
    expect(archived(h.id)).toBe(false);
    expect(retiredLines()).toHaveLength(lines);
    const receipts = retireReceipts();
    expect(receipts).toHaveLength(before + 1);
    expect(receipts.at(-1)?.["state"]).toBe("failed");
  });

  test("a retire settles the harness's unfinished commands first, and its disable stands", async () => {
    const h = await home.harness("stale");
    // An enable a Home whose process is gone accepted an hour ago and never finished.
    const enable = mintId("cmd");
    const acceptedAt = new Date(Date.now() - 3_600_000).toISOString();
    const planted = append(commandsLedgerOf(h.dir), {
      v: 1,
      id: enable,
      kind: "controls.enable",
      target: `home/harness/${h.id}`,
      actor: home.owner,
      via: "api",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt,
      executor: { pid: 2_147_483_000, startedAt: acceptedAt, host: hostname(), head: "server" },
      effects: [],
      retry: { retryable: true, safety: "idempotent" },
    });
    if (!planted.ok) throw new Error(planted.reason);
    const nonce = await plan(h.id);
    const res = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "stale", nonce },
    });
    expect(res.status).toBe(200);
    const receipt = res.body["receipt"] as Record<string, unknown>;
    expect(receipt["state"]).toBe("succeeded");
    const enableState = () => {
      const fold = foldStates(commandsLedgerOf(h.dir));
      if (!fold.ok) throw new Error(fold.reason);
      return fold.objects.get(enable)?.state;
    };
    // Settled before the retire acted: run again, then overtaken by the retire's disable.
    expect(enableState()).toBe("succeeded");
    const deployment = () => {
      const read = readOperatorRecord.refresh(h.dir);
      return read.state === "present" ? read.record.deployment : undefined;
    };
    expect(deployment()).toMatchObject({ disabled: true, cmd: receipt["id"] });
    await home.t.server.controlService.commands.recover({ harness: h.dir });
    expect(deployment()).toMatchObject({ disabled: true, cmd: receipt["id"] });
    const verdict = assertRunnable(h.dir, { mode: "start", read: readOperatorRecord.refresh });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.exitName).toBe("disabled");
  });

  test("every step done: recorded as retired and archived in Home", async () => {
    const h = await home.harness("done");
    const lines = retiredLines().length;
    const nonce = await plan(h.id);
    const res = await home.call("POST", path(h.id), {
      body: { dryRun: false, confirmName: "done", nonce },
    });
    expect(res.status).toBe(200);
    expect(res.body["remedy"]).toBeUndefined();
    expect((res.body["receipt"] as Record<string, unknown>)["state"]).toBe("succeeded");
    expect(archived(h.id)).toBe(true);
    expect(retiredLines()).toHaveLength(lines + 1);
  });
});

/** Every path under `root`, recursively, with its bytes, its link target, or `dir`. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const key = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
      else if (st.isDirectory()) {
        out[key] = "dir";
        walk(path, key);
      } else out[key] = `file:${readFileSync(path).toString("base64")}`;
    }
  };
  walk(root, "");
  return out;
}

describe.skipIf(process.platform === "win32")(
  "retiring a harness whose sessions folder lies outside it",
  () => {
    test("expires no approval there, says so in its receipt, and leaves that folder as it was", async () => {
      const pending = "appr_00000000000000e9";
      const b = await home.harness("retire-kept-b", {
        approvals: [
          {
            id: pending,
            toolName: "SendMessage",
            inputHash: `hash-${pending}`,
            input: { channel: "ops", text: "kept" },
            runId: "run_00000000000000e0",
            sessionId: "sess_00000000000000ee",
            surface: "daemon",
            createdAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      });
      const a = await home.harness("retire-linked-a");
      const sessionsB = join(b.dir, ".crewhaus", "sessions");
      rmSync(join(a.dir, ".crewhaus", "sessions"), { recursive: true, force: true });
      symlinkSync(sessionsB, join(a.dir, ".crewhaus", "sessions"));
      const pendingIds = () =>
        foldReadOnly(sessionsB)
          .records.filter((record) => record.decision === undefined)
          .map((record) => record.id);
      expect(pendingIds()).toEqual([pending]);
      const before = treeOf(sessionsB);
      const nonce = await plan(a.id);
      const res = await home.call("POST", path(a.id), {
        body: { dryRun: false, confirmName: "retire-linked-a", nonce },
      });
      expect(res.status).toBe(200);
      const receipt = res.body["receipt"] as Record<string, unknown>;
      expect(receipt["state"]).toBe("succeeded");
      expect(receipt["effects"]).toContainEqual({
        kind: "retire.approvals",
        status: "skipped",
        observed: "sessions folder outside the harness",
      });
      expect(treeOf(sessionsB)).toEqual(before);
      expect(pendingIds()).toEqual([pending]);
    }, 30_000); // a whole retirement
  },
);
