/**
 * Reads change nothing. Over a fleet holding everything a read could be tempted to act
 * on (a daemon started from a terminal that Home has not attached, a runfile whose daemon
 * is gone, a parked approval, OS and webhook rules turned on, access records with a
 * member), every GET row of the route table, every GET operation of the versioned API and
 * `/healthz` leave every harness directory and Home's directory byte-identical, fire no
 * sink and attach nothing; the terminal-started daemon still shows as running and the
 * stale runfile stays where it is. Home's tick does that work instead.
 */
import { describe, expect, test } from "bun:test";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { OPERATIONS, mintId, mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import { type HangarHarnessEntry, openHangarRegistry } from "@crewhaus/harness-registry";
import { signInFromBootLink } from "./__test__/browser";
import { makeFixtureHarness } from "./fixture";
import { type ProcessLayer, createProcessLayer } from "./process";
import { OFF_MAP_OUTSIDE_API, ROUTE_TABLE } from "./route-table";
import { type TestServer, bootTestServer } from "./testkit";
import { V1_NOT_SERVED } from "./v1/areas";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

/** GET rows not driven here, each with why. */
const EXCLUDED: ReadonlyArray<readonly [string, string]> = [
  ["/boot/:nonce", "a single-use sign-in exchange: spending it is its purpose"],
];

/** GET operations of the versioned API not driven here, each with why. */
const EXCLUDED_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ["auth.challenge", "a sign-in row, driven above as the route-table row `authChallenge`"],
];

/** Every file under `dir`, relative path to bytes; `skip` names top-level entries left out. */
function treeBytes(dir: string, skip: readonly string[] = []): Map<string, string> {
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
      if (at === dir && skip.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.set(relative(dir, path), readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

/** The registry, without the `missingSince` stamp a read may write. */
function registryView(root: string): unknown {
  try {
    const doc = JSON.parse(readFileSync(join(root, "harnesses.json"), "utf8")) as {
      harnesses?: Array<Record<string, unknown>>;
    };
    return {
      ...doc,
      harnesses: (doc.harnesses ?? []).map(({ missingSince: _m, ...rest }) => rest),
    };
  } catch {
    return undefined;
  }
}

function terminalManager(t: TestServer): ProcessLayer {
  return createProcessLayer({
    registry: openHangarRegistry({
      root: t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
      now: () => NOW,
      onWarn: () => {},
    }),
    env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
    now: () => NOW,
    onWarn: () => {},
    hangarRoot: t.hangarRoot,
    managerVersion: "terminal",
    ...(t.ops !== undefined ? { ops: t.ops } : {}),
    ...(t.clock !== undefined ? { clock: t.clock } : {}),
    noPreflight: true,
    runJob: () => new Promise<{ exitCode?: number }>(() => {}),
  });
}

describe("GET routes change nothing", () => {
  test("every GET row, every v1 GET operation and /healthz leave the fleet and Home byte-identical", async () => {
    let adoptions = 0;
    const t = bootTestServer({
      now: () => NOW,
      prepare: ({ hangarRoot }) => {
        // OS and webhook delivery turned on for parked approvals, before Home boots.
        writeFileSync(
          join(hangarRoot, "settings.json"),
          `${JSON.stringify({
            notifications: {
              rules: [
                { kind: "approval-parked", enabled: true, sinks: ["in-app", "os", "webhook"] },
              ],
              webhookUrl: "https://hooks.example.test/hangar",
            },
          })}\n`,
        );
      },
      wrapProcessLayer: (layer) => ({
        ...layer,
        get: (entry) => {
          const handle = layer.get(entry);
          const supervisor = handle.supervisor;
          return {
            ...handle,
            supervisor: {
              ...supervisor,
              adoptIfRunfile: () => {
                adoptions += 1;
                return supervisor.adoptIfRunfile();
              },
            },
          };
        },
      }),
    });
    try {
      await t.server.ready;
      await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
      const add = async (name: string, extra = {}): Promise<{ id: string; dir: string }> => {
        const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
          specName: name,
          target: "channel",
          bundle: { entry: "daemon.ts" },
          ...extra,
        });
        const res = await t.api("/api/harnesses", {
          method: "POST",
          body: JSON.stringify({ dir }),
        });
        return { id: (res.body["entry"] as { id: string }).id, dir };
      };
      const live = await add("live", {
        approvals: [
          {
            id: "appr_00000000000000d1",
            toolName: "SendMessage",
            inputHash: "hash-d1",
            input: { channel: "ops", text: "ship it" },
            runId: "run_00000000000000d0",
            sessionId: "sess_00000000000000dd",
            surface: "daemon",
            createdAt: new Date(NOW - 60_000).toISOString(),
          },
        ],
      });
      const stale = await add("stale");
      // A member, so access records exist.
      const read = loadAccessSnapshot(t.hangarRoot);
      if (read.state !== "present") throw new Error("no access records");
      const granted = await openAccess(t.hangarRoot, {
        harnesses: () => [
          { id: live.id, dir: live.dir, groups: [] },
          { id: stale.id, dir: stale.dir, groups: [] },
        ],
      }).grant(
        { principal: read.snapshot.owner as string },
        { member: "Ana", create: true, role: "operator", scope: `harness:${live.id}` },
      );
      if (!granted.ok) throw new Error(granted.reason);
      // The other head starts `live` after Home booted; `stale` keeps a runfile whose daemon is gone.
      const reg = openHangarRegistry({
        root: t.registryRoot,
        env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
        now: () => NOW,
        onWarn: () => {},
      });
      const terminal = terminalManager(t);
      const started = await terminal.get(reg.get(live.id) as HangarHarnessEntry).supervisor.start();
      expect(started).toMatchObject({ ok: true });
      terminal.close();
      const runfile = JSON.parse(
        readFileSync(join(live.dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      ) as { runId: string };
      const runId = runfile.runId;
      // An evaluation run and an archive, so the export reads reach real files.
      mkdirSync(join(live.dir, ".crewhaus", "evals", runId), { recursive: true });
      writeFileSync(
        join(live.dir, ".crewhaus", "evals", runId, "results.json"),
        JSON.stringify({
          runId,
          endedAt: new Date(NOW).toISOString(),
          config: { specHash: "h", datasetName: "d", model: "m" },
          samples: [],
        }),
      );
      mkdirSync(join(t.hangarRoot, "exports", live.id), { recursive: true });
      writeFileSync(join(t.hangarRoot, "exports", live.id, "01J.tar.gz"), "archive");
      // The same runfile in `stale`, for a pid no process holds.
      mkdirSync(join(stale.dir, ".crewhaus", "run"), { recursive: true });
      writeFileSync(
        join(stale.dir, ".crewhaus", "run", "daemon.json"),
        `${JSON.stringify({ ...runfile, pid: 2_147_483_000, bundleDir: join(stale.dir, "dist") }, null, 2)}\n`,
      );

      const snapshot = () => ({
        live: treeBytes(live.dir),
        stale: treeBytes(stale.dir),
        home: treeBytes(t.hangarRoot, ["cache"]),
        registry: registryView(t.registryRoot),
      });
      const before = snapshot();
      adoptions = 0;
      const sinksBefore = (t.sinks?.os.length ?? 0) + (t.sinks?.webhook.length ?? 0);

      const values: Readonly<Record<string, string>> = {
        id: live.id,
        runId,
        optRunId: runId,
        sess: "sess_00000000000000dd",
        sessionId: "sess_00000000000000dd",
      };
      const excluded = new Set(EXCLUDED.map(([path]) => path));
      // Every GET Home answers: the route table's, and the two outside `/api`.
      const every = [
        ...ROUTE_TABLE.filter((row) => row.method === "GET").map((row) => ({
          key: row.key,
          path: row.path,
        })),
        ...OFF_MAP_OUTSIDE_API.filter((row) => row.method === "GET").map((row) => ({
          key: row.path,
          path: row.path,
        })),
      ];
      for (const path of excluded) expect(every.some((row) => row.path === path)).toBe(true);
      const rows = every.filter((row) => !excluded.has(row.path));
      let driven = 0;
      for (const row of rows) {
        const path = row.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => values[name] ?? "x");
        const controller = new AbortController();
        const res = await t.fetchRaw(path, {
          headers: { authorization: `Bearer ${t.token}` },
          signal: controller.signal,
        });
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          // The stream's first frame, then the client goes away.
          const reader = res.body?.getReader();
          await reader?.read();
          controller.abort();
          await reader?.cancel().catch(() => undefined);
        } else {
          await res.arrayBuffer();
        }
        expect([row.key, res.status < 500]).toEqual([row.key, true]);
        driven += 1;
      }
      // Every GET operation of the versioned API, counted against the operation table.
      const v1Excluded = new Set(EXCLUDED_OPERATIONS.map(([id]) => id));
      const v1Gets = OPERATIONS.filter((op) => op.method === "GET");
      for (const id of v1Excluded) expect(v1Gets.some((op) => op.id === id)).toBe(true);
      const fill: Readonly<Record<string, string>> = {
        h: live.id,
        run: runId,
        cmd: mintId("cmd"),
        dep: mintId("dep"),
        rule: mintId("rule"),
        psn: mintId("psn"),
        plugin: "notes-pane",
      };
      const refFor: Readonly<Record<string, string>> = {
        "refs.resolve": `${live.id}/exec/${runId}`,
        "decisions.get": `${live.id}/decision/appr_00000000000000d1`,
        "attention.get": `home/attention/att_${"0".repeat(26)}`,
        "attention.messages.list": `home/attention/att_${"0".repeat(26)}`,
        "work.get": `${live.id}/work/${mintId("wi")}`,
      };
      const v1Paths: Array<{ key: string; path: string }> = [];
      for (const op of v1Gets.filter((row) => !v1Excluded.has(row.id))) {
        const path = op.path.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => {
          const value = name === "ref" ? refFor[op.id] : fill[name];
          if (value === undefined) throw new Error(`${op.id}: no value for {${name}}`);
          return value;
        });
        v1Paths.push({ key: op.id, path });
        if (["harnesses.get", "harnesses.capabilities", "harnesses.health"].includes(op.id)) {
          v1Paths.push({ key: `${op.id} (stale)`, path: path.replace(live.id, stale.id) });
        }
      }
      let v1Driven = 0;
      for (const row of v1Paths) {
        const controller = new AbortController();
        const res = await t.fetchRaw(row.path, {
          headers: { authorization: `Bearer ${t.token}` },
          signal: controller.signal,
        });
        let text = "";
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          const reader = res.body?.getReader();
          await reader?.read();
          controller.abort();
          await reader?.cancel().catch(() => undefined);
        } else {
          text = await res.text();
        }
        const opId = row.key.replace(" (stale)", "");
        if (Object.hasOwn(V1_NOT_SERVED, opId)) {
          const reason = (JSON.parse(text) as { error?: { reason?: unknown } }).error?.reason;
          expect([row.key, res.status, reason]).toEqual([row.key, 501, "not_served"]);
        } else {
          expect([row.key, res.status < 500]).toEqual([row.key, true]);
        }
        if (!row.key.endsWith("(stale)")) v1Driven += 1;
      }
      expect(v1Driven).toBe(v1Gets.length - EXCLUDED_OPERATIONS.length);
      // The daemon started from the terminal shows as running, unattached.
      const shown = await t.fetchRaw(`/api/v1/harnesses/${live.id}`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      const display = ((await shown.json()) as { display?: { state?: unknown } }).display;
      expect(display?.state).toBe("running");
      // The same reads over the harness whose daemon is gone.
      for (const tail of ["proc", `runs/${runId}`, "control/status", "schedulers"]) {
        await (
          await t.fetchRaw(`/api/h/${stale.id}/${tail}`, {
            headers: { authorization: `Bearer ${t.token}` },
          })
        ).arrayBuffer();
      }
      expect(rows.some((row) => row.path === "/healthz")).toBe(true);
      expect(EXCLUDED).toHaveLength(1);
      expect(driven).toBe(every.length - EXCLUDED.length);
      expect(driven).toBe(ROUTE_TABLE.filter((row) => row.method === "GET").length + 1);
      expect(adoptions).toBe(0);
      expect((t.sinks?.os.length ?? 0) + (t.sinks?.webhook.length ?? 0)).toBe(sinksBefore);
      expect(existsSync(join(stale.dir, ".crewhaus", "run", "daemon.json"))).toBe(true);
      const after = snapshot();
      expect(after.live).toEqual(before.live);
      expect(after.stale).toEqual(before.stale);
      expect(after.home).toEqual(before.home);
      expect(after.registry).toEqual(before.registry);
    } finally {
      await t.stop();
    }
  }, 90_000); // two hundred reads over a live fleet; slow on a loaded runner
});

describe("the v1 event streams change nothing", () => {
  test("a run's, a harness's and Home's stream, read to their first chunk, leave Home and the harness byte-identical, cache/index included", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      await t.server.ready;
      const dir = makeFixtureHarness(join(t.harnessesRoot, "streamed"), { specName: "streamed" });
      const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
      const id = (res.body["entry"] as { id: string }).id;
      const run = mintRunId();
      append(runsLedger(dir), { id: run, state: "running", at: new Date(NOW).toISOString() });
      const before = { home: treeBytes(t.hangarRoot), harness: treeBytes(dir) };
      let driven = 0;
      for (const path of [
        `/api/v1/runs/${run}/events`,
        `/api/v1/harnesses/${id}/events`,
        "/api/v1/events",
      ]) {
        const controller = new AbortController();
        const answer = await fetch(`${t.base}${path}`, {
          headers: { authorization: `Bearer ${t.token}` },
          signal: controller.signal,
        });
        expect([path, answer.status]).toEqual([path, 200]);
        expect(answer.headers.get("content-type") ?? "").toContain("text/event-stream");
        const reader = answer.body?.getReader();
        await reader?.read();
        controller.abort();
        await reader?.cancel().catch(() => undefined);
        driven += 1;
      }
      expect(driven).toBe(3);
      expect(treeBytes(t.hangarRoot)).toEqual(before.home);
      expect(treeBytes(dir)).toEqual(before.harness);
      expect(readdirSync(t.hangarRoot)).not.toContain("cache");
    } finally {
      await t.stop();
    }
  }, 30_000); // three streams over a booted Home; slow on a loaded runner
});
