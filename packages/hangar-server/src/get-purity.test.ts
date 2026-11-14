/**
 * Reads change nothing. Over a fleet holding everything a read could be tempted to act
 * on (a daemon started from a terminal that Home has not attached, a runfile whose daemon
 * is gone, a parked approval, OS and webhook rules turned on, access records with a
 * member), every GET row of the route table and `/healthz` leave every harness directory
 * and Home's directory byte-identical, fire no sink and attach nothing. Home's tick does
 * that work instead.
 */
import { describe, expect, test } from "bun:test";
import { type Dirent, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { type HangarHarnessEntry, openHangarRegistry } from "@crewhaus/harness-registry";
import { signInFromBootLink } from "./__test__/browser";
import { makeFixtureHarness } from "./fixture";
import { type ProcessLayer, createProcessLayer } from "./process";
import { OFF_MAP_OUTSIDE_API, ROUTE_TABLE } from "./route-table";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

/** GET rows not driven here, each with why. */
const EXCLUDED: ReadonlyArray<readonly [string, string]> = [
  ["/boot/:nonce", "a single-use sign-in exchange: spending it is its purpose"],
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
  test("every GET row and /healthz leave the fleet and Home byte-identical", async () => {
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
      const after = snapshot();
      expect(after.live).toEqual(before.live);
      expect(after.stale).toEqual(before.stale);
      expect(after.home).toEqual(before.home);
      expect(after.registry).toEqual(before.registry);
    } finally {
      await t.stop();
    }
  }, 60_000); // a hundred and fifty reads over a live fleet; slow on a loaded runner
});
