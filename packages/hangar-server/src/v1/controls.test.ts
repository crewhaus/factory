/**
 * Home's operator controls ask a running harness to apply them and report what it
 * answered, in the same words the CLI uses: a harness that confirms the record's revision
 * is "confirmed", a runfile whose process is gone "applies it when it starts", and a build
 * without the reload route "Recorded, not enforced … Recompile to apply it.", with the
 * daemon's effect skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createControlClient } from "@crewhaus/gateway-protocol/control-client";
import { writeRunfile } from "@crewhaus/harness-supervisor";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { makeFixtureHarness } from "../fixture";

const TOKEN = ["stub", "control", "bearer", "for", "tests"].join("-");

/** What the stubbed control port answers, and every address it was asked at. */
const stub = {
  answer: (): Response => new Response("{}", { status: 200 }),
  seen: [] as string[],
};

let home: V1Home;

beforeAll(async () => {
  const fetch = (async (input: string | URL | Request) => {
    stub.seen.push(String(input instanceof Request ? input.url : input));
    return stub.answer();
  }) as typeof globalThis.fetch;
  home = await v1Home({ controlClient: createControlClient({ fetch }) });
}, 30_000);

afterAll(async () => {
  await home?.t.stop();
});

/** A daemon-shaped harness Home started, whose daemon announced its control port. */
async function started(name: string, port: number): Promise<{ id: string; dir: string }> {
  const dir = makeFixtureHarness(join(home.t.harnessesRoot, name), {
    specName: name,
    target: "channel",
    controlToken: TOKEN,
    bundle: { entry: "daemon.ts" },
  });
  const res = await home.t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (res.body["entry"] as { id: string }).id;
  const start = await home.t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
  expect(start.status).toBeLessThan(300);
  home.t.ops
    ?.last()
    ?.writeLog(
      `[control] crewhaus.control.v1 listening on http://127.0.0.1:${port} (token: .crewhaus/run/control-token)\n`,
    );
  home.t.clock?.advance(300); // one pump tick
  return { id, dir };
}

const daemonEffect = (body: Record<string, unknown>) =>
  ((body["receipt"] as Record<string, unknown>)["effects"] as Record<string, unknown>[]).find(
    (effect) => effect["kind"] === "daemon",
  );

describe("Home's controls report what the running harness answered", () => {
  test("a harness that confirms the record's revision answers 'the daemon confirmed'", async () => {
    const h = await started("confirms", 41801);
    stub.seen.length = 0;
    stub.answer = () =>
      new Response(JSON.stringify({ operator: { rev: 99, paused: true, disabled: false } }), {
        status: 200,
      });
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/controls/pause`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.body["line"]).toBe("Paused new work; the daemon confirmed");
    expect(stub.seen).toEqual(["http://127.0.0.1:41801/control/v1/operator/reload"]);
    expect(daemonEffect(res.body)?.["status"]).toBe("done");
  });

  test("a runfile whose process is gone answers 'applies it when it starts', asking no port", async () => {
    const dir = makeFixtureHarness(join(home.t.harnessesRoot, "gone"), {
      specName: "gone",
      target: "channel",
      controlToken: TOKEN,
      bundle: { entry: "daemon.ts" },
    });
    const registered = await home.t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (registered.body["entry"] as { id: string }).id;
    // A pid no process holds: the fake process table knows only the daemons Home started.
    writeRunfile(dir, {
      v: 1,
      pid: 3_999_999,
      pidStartTimeMs: Date.now() - 60_000,
      argvFingerprint: "gone",
      controlPort: 41802,
      entry: "daemon.ts",
      bundleDir: join(dir, "dist"),
      runId: "run_00000000000000a1",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      managerVersion: "0.0.0",
    });
    stub.seen.length = 0;
    const res = await home.call("POST", `/api/v1/harnesses/${id}/controls/pause`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.body["line"]).toBe(
      "Recorded; the daemon isn't running and applies it when it starts",
    );
    expect(stub.seen).toEqual([]);
    expect(daemonEffect(res.body)?.["status"]).toBe("skipped");
  });

  test("a runfile whose process is gone answers 'applies it when it starts' even where it is not adopted", async () => {
    // Adoption that leaves every runfile where it is: only the process probe can tell.
    const kept = await v1Home({
      wrapProcessLayer: (layer) => ({
        ...layer,
        get: (entry) => {
          const handle = layer.get(entry);
          return {
            ...handle,
            supervisor: { ...handle.supervisor, adoptIfRunfile: async () => "none" as never },
          };
        },
      }),
    });
    try {
      const dir = makeFixtureHarness(join(kept.t.harnessesRoot, "gone-kept"), {
        specName: "gone-kept",
        target: "channel",
        controlToken: TOKEN,
        bundle: { entry: "daemon.ts" },
      });
      const registered = await kept.t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (registered.body["entry"] as { id: string }).id;
      writeRunfile(dir, {
        v: 1,
        pid: 3_999_998,
        pidStartTimeMs: Date.now() - 60_000,
        argvFingerprint: "gone-kept",
        entry: "daemon.ts",
        bundleDir: join(dir, "dist"),
        runId: "run_00000000000000a2",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        managerVersion: "0.0.0",
      });
      const res = await kept.call("POST", `/api/v1/harnesses/${id}/controls/disable`, { body: {} });
      expect(res.status).toBe(200);
      expect(res.body["line"]).toBe(
        "Recorded; the daemon isn't running and applies it when it starts",
      );
    } finally {
      await kept.t.stop();
    }
  }, 30_000); // a second Home and its sign-in
});
