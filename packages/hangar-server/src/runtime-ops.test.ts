/**
 * The two remaining run classes: the `serve --mcp` projection and the dev
 * watch loop.
 *
 * What is pinned here:
 *   - the argv vocabulary is CLOSED — a request body cannot append a flag;
 *   - the spawn goes through the process layer's job queue with
 *     `harnessDir` as the job's directory, which is what makes the child's
 *     cwd the harness rather than `crewhaus dev`'s throwaway temp dir;
 *   - a start opens a run-ledger row, so the run is addressable by the
 *     EXISTING run routes (and therefore by the one SSE feed) — M3 adds no
 *     second streaming mechanism;
 *   - dev refuses to race a supervised daemon, with the reason;
 *   - a stop that signalled nothing never reports `stopped`;
 *   - a shape that cannot project says so instead of offering a dead button.
 *
 * No test here spawns anything: the server suite drives the REAL queue over a
 * fake job runner, exactly as the M2 process tests drive the real supervisor
 * over fake process ops.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { JobRecord } from "@crewhaus/harness-supervisor";
import { makeFixtureHarness } from "./fixture";
import {
  declaredExpose,
  devArgv,
  mcpArgv,
  projectionFor,
  runIdForJob,
  specTarget,
} from "./runtime-ops";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-04T00:00:00.000Z");

/** A job runner that parks forever and records what it was handed — the
 *  observable seam for "the manager owns the spawn, in the harness dir". */
function parkingRunner(seen: JobRecord[]): (job: JobRecord) => Promise<{ exitCode?: number }> {
  return (job) => {
    seen.push(job);
    return new Promise<{ exitCode?: number }>(() => {});
  };
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  return (body["entry"] as { id: string }).id;
}

/** A `cli` harness — the one shape `crewhaus serve --mcp` projects. */
function cliHarness(t: TestServer, name = "runtime", specExtra?: string): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: `${name}-harness`,
    target: "cli",
    ...(specExtra !== undefined ? { specExtra } : {}),
  });
}

describe("runtime — pure helpers", () => {
  test("expose.mcp is read off the spec TEXT, tolerantly", () => {
    const spec = ["name: x", "target: cli", "expose:", "  mcp:", "    transport: sse", ""].join(
      "\n",
    );
    expect(declaredExpose(spec)).toEqual({ declared: true, transport: "sse", tools: null });
    expect(declaredExpose("name: x\ntarget: cli\n")).toEqual({
      declared: false,
      transport: null,
      tools: null,
    });
    // A spec a version ahead of this manager must still render.
    const ahead = [
      "name: x",
      "target: cli",
      "expose:",
      "  mcp:",
      "    transport: stdio",
      "    tools: per-subagent",
      "    somethingNew: true",
      "",
    ].join("\n");
    expect(declaredExpose(ahead).tools).toBe("per-subagent");
    expect(specTarget(ahead)).toBe("cli");
  });

  test("the three projection answers are distinguished, because conflating them is the bug", () => {
    const declared = { declared: true, transport: "sse", tools: null };
    const none = { declared: false, transport: null, tools: null };
    expect(projectionFor("cli", none)).toBe("serve");
    // A daemon shape self-exposes from its own bundle — nothing separate to
    // start, so offering a Start button would be a dead button.
    expect(projectionFor("channel", declared)).toBe("self");
    expect(projectionFor("managed", declared)).toBe("self");
    expect(projectionFor("channel", none)).toBe("none");
    expect(projectionFor("workflow", declared)).toBe("none");
  });

  test("the argv vocabulary is closed and shape-checked", () => {
    expect(mcpArgv("crewhaus.yaml", "stdio", 8000)).toEqual(["serve", "--mcp", "crewhaus.yaml"]);
    expect(mcpArgv("crewhaus.yaml", "http", 8123)).toEqual([
      "serve",
      "--mcp",
      "crewhaus.yaml",
      "--sse",
      "--port",
      "8123",
    ]);
    expect(devArgv("crewhaus.yaml", false)).toEqual(["dev", "crewhaus.yaml"]);
    expect(devArgv("crewhaus.yaml", true)).toEqual([
      "compile",
      "crewhaus.yaml",
      "--check",
      "--watch",
    ]);
    // A spec name that is really a flag (or a second command) is a 400, never
    // a spawn.
    expect(() => mcpArgv("--sse", "stdio", 8000)).toThrow();
    expect(() => devArgv("/etc/passwd", false)).toThrow();
  });

  test("a run id is derived from the job id only when it is really addressable", () => {
    expect(runIdForJob("job_00000000000000aa")).toBe("run_00000000000000aa");
    expect(runIdForJob("job_NOT-HEX")).toBeNull();
  });
});

describe("runtime — the mcp-server projection", () => {
  test("a cli shape reports the serve projection, its declared transport, and an honest empty state", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(
        t,
        cliHarness(t, "mcp", ["expose:", "  mcp:", "    transport: stdio"].join("\n")),
      );
      const { status, body } = await t.api(`/api/h/${id}/mcp-servers`);
      expect(status).toBe(200);
      expect(body["present"]).toBe(true);
      expect(body["projection"]).toBe("serve");
      expect(body["running"]).toBe(false);
      expect(body["transport"]).toBe("stdio");
      expect(body["verb"]).toBe("crewhaus serve --mcp crewhaus.yaml");
      // stdio has no port, and the payload says so rather than inventing one.
      expect((body["health"] as Record<string, unknown>)["checked"]).toBe(false);
      expect(body["port"]).toBeNull();
    } finally {
      await t.stop();
    }
  });

  test("a daemon shape that self-exposes is not offered a separate start", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "chan"), {
        specName: "chan-harness",
        target: "channel",
        specExtra: ["expose:", "  mcp:", "    transport: sse"].join("\n"),
      });
      const id = await register(t, dir);
      const view = await t.api(`/api/h/${id}/mcp-servers`);
      expect(view.body["projection"]).toBe("self");
      expect(view.body["verb"]).toBeNull();

      const start = await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(start.status).toBe(200);
      expect(start.body["ok"]).toBe(false);
      expect(start.body["code"]).toBe("not-projectable");
      expect(String(start.body["reason"])).toContain("self-exposes");
    } finally {
      await t.stop();
    }
  });

  test("a shape that does not project at all refuses with the reason", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "wf"), {
        specName: "wf-harness",
        target: "workflow",
      });
      const id = await register(t, dir);
      const view = await t.api(`/api/h/${id}/mcp-servers`);
      expect(view.body["present"]).toBe(false);
      expect(String(view.body["note"])).toContain("does not project");
    } finally {
      await t.stop();
    }
  });

  test("start goes through the queue in the HARNESS dir, opens a ledger row, and hands back a watchable runId", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = cliHarness(t, "mcp2");
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "stdio" }),
      });
      expect(status).toBe(200);
      expect(body["started"]).toBe(true);
      expect(body["argv"]).toEqual(["serve", "--mcp", "crewhaus.yaml"]);
      expect(body["ledgerError"]).toBeNull();
      // Nothing is claimed in the port ledger, and the payload says so
      // instead of implying a reservation this layer cannot honour.
      expect(body["portClaimed"]).toBe(false);

      // The job the layer will spawn runs in the harness directory. That IS
      // the dev/mcp cwd fix: the layer's runner spawns with `cwd =
      // job.harnessDir`, so state stays in this harness's own `.crewhaus/`.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.harnessDir).toBe(dir);
      expect(seen[0]?.kind).toBe("mcp-server");

      // The run is addressable by the EXISTING run routes, which is how the
      // one SSE feed can show it — M3 adds no second streaming mechanism.
      const runId = body["runId"] as string;
      const runs = await t.api(`/api/h/${id}/runs`);
      expect((runs.body["runs"] as Array<{ runId: string; kind: string }>)[0]).toMatchObject({
        runId,
        kind: "mcp-server",
      });
      expect((await t.api(`/api/h/${id}/runs/${runId}`)).status).toBe(200);

      const after = await t.api(`/api/h/${id}/mcp-servers`);
      expect(after.body["running"]).toBe(true);
      expect(after.body["runId"]).toBe(runId);
      expect((after.body["ledger"] as unknown[]).length).toBe(1);
    } finally {
      await t.stop();
    }
  });

  test("the projection is a singleton, and an http start probes the port it was given", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    // A real listener, so the loopback bind probe has something to find.
    const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const id = await register(t, cliHarness(t, "mcp3"));
      const first = await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "http", port: listener.port }),
      });
      expect(first.body["started"]).toBe(true);
      expect(first.body["port"]).toBe(listener.port);

      const second = await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "http" }),
      });
      expect(second.status).toBe(200);
      expect(second.body["ok"]).toBe(false);
      expect(second.body["code"]).toBe("already-running");

      const view = await t.api(`/api/h/${id}/mcp-servers`);
      const health = view.body["health"] as Record<string, unknown>;
      expect(health["checked"]).toBe(true);
      expect(health["listening"]).toBe(true);
      expect(String(health["note"])).toContain("not an MCP handshake");
    } finally {
      await listener.stop(true);
      await t.stop();
    }
  });

  test("a bad transport or port is a 400, never a spawn", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const id = await register(t, cliHarness(t, "mcp4"));
      const badTransport = await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "carrier-pigeon" }),
      });
      expect(badTransport.status).toBe(400);
      const badPort = await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "http", port: "8000; rm -rf /" }),
      });
      expect(badPort.status).toBe(400);
      expect(seen).toHaveLength(0);
    } finally {
      await t.stop();
    }
  });

  test("stopping a run that already started reports `not-adopted`, never `stopped`", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const id = await register(t, cliHarness(t, "mcp5"));
      const idle = await t.api(`/api/h/${id}/mcp-servers/stop`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(idle.body["stopped"]).toBe(false);
      expect(idle.body["reason"]).toBe("nothing-running");

      await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "stdio" }),
      });
      const stop = await t.api(`/api/h/${id}/mcp-servers/stop`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(stop.status).toBe(200);
      expect(stop.body["stopped"]).toBe(false);
      expect(stop.body["reason"]).toBe("not-adopted");
      expect((stop.body["running"] as string[]).length).toBe(1);
    } finally {
      await t.stop();
    }
  });
});

describe("runtime — dev mode", () => {
  test("the status route names the cwd fix and the roots it can actually anchor", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await register(t, cliHarness(t, "dev1"));
      const { status, body } = await t.api(`/api/h/${id}/dev`);
      expect(status).toBe(200);
      expect(body["running"]).toBe(false);
      expect(body["verb"]).toBe("crewhaus dev crewhaus.yaml");
      expect(body["watching"]).toEqual([
        "crewhaus.yaml",
        ".crewhaus/commands/",
        ".crewhaus/skills/",
      ]);
      expect(String(body["cwdNote"])).toContain("temp dir");
      expect((body["stateRoots"] as Array<{ name: string }>).map((r) => r.name)).toContain(
        "CREWHAUS_SESSION_DIR",
      );
    } finally {
      await t.stop();
    }
  });

  test("start runs `crewhaus dev` in the harness dir; --check runs the validate-only loop", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = cliHarness(t, "dev2");
      const id = await register(t, dir);
      const started = await t.api(`/api/h/${id}/dev/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(started.body["started"]).toBe(true);
      expect(started.body["mode"]).toBe("watch");
      expect(started.body["cwd"]).toBe(dir);
      expect(seen[0]?.argv).toEqual(["dev", "crewhaus.yaml"]);
      expect(seen[0]?.harnessDir).toBe(dir);

      const view = await t.api(`/api/h/${id}/dev`);
      expect(view.body["running"]).toBe(true);
      expect(view.body["mode"]).toBe("watch");
      expect(view.body["runId"]).toBe(started.body["runId"]);
    } finally {
      await t.stop();
    }
  });

  test("--check starts the validate-only loop and is reported as such", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const id = await register(t, cliHarness(t, "dev3"));
      const started = await t.api(`/api/h/${id}/dev/start`, {
        method: "POST",
        body: JSON.stringify({ checkOnly: true }),
      });
      expect(started.body["mode"]).toBe("check");
      expect(seen[0]?.argv).toEqual(["compile", "crewhaus.yaml", "--check", "--watch"]);
      expect((await t.api(`/api/h/${id}/dev`)).body["mode"]).toBe("check");
    } finally {
      await t.stop();
    }
  });

  test("dev refuses to race a supervised daemon, with the reason", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "dev4"), {
        specName: "dev4-harness",
        target: "channel",
        runfile: {
          v: 1,
          pid: 987_654,
          pidStartTimeMs: NOW - 1000,
          argvFingerprint: "fp",
          entry: "daemon.ts",
          bundleDir: join(t.harnessesRoot, "dev4", "dist"),
          runId: "run_00000000000000cc",
          startedAt: new Date(NOW - 1000).toISOString(),
          managerVersion: "test",
        },
      });
      const id = await register(t, dir);
      const view = await t.api(`/api/h/${id}/dev`);
      expect(view.body["blocked"]).toBe(true);
      expect(String(view.body["blockedReason"])).toContain("runfile");

      const start = await t.api(`/api/h/${id}/dev/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(start.status).toBe(200);
      expect(start.body["ok"]).toBe(false);
      expect(start.body["code"]).toBe("daemon-running");
      expect(seen).toHaveLength(0);
    } finally {
      await t.stop();
    }
  });

  test("a queued loop is cancelled before it starts; a started one is honestly not stopped", async () => {
    // Concurrency 1 with a parked job means the SECOND submission is still
    // queued — the one case the queue really can cancel.
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const id = await register(t, cliHarness(t, "dev5"));
      // The mcp projection takes the harness's mutating mutex first, so the
      // dev loop stays PENDING behind it.
      await t.api(`/api/h/${id}/mcp-servers/start`, {
        method: "POST",
        body: JSON.stringify({ transport: "stdio" }),
      });
      const started = await t.api(`/api/h/${id}/dev/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(started.body["started"]).toBe(true);

      const stop = await t.api(`/api/h/${id}/dev/stop`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(stop.body["stopped"]).toBe(true);
      expect((stop.body["cancelled"] as string[]).length).toBe(1);
      expect((await t.api(`/api/h/${id}/dev`)).body["running"]).toBe(false);
    } finally {
      await t.stop();
    }
  });

  test("a harness with no spec is an empty state, not a spawn", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "dev6"), { noSpec: true });
      const id = await register(t, dir);
      const view = await t.api(`/api/h/${id}/dev`);
      expect(view.status).toBe(200);
      expect(view.body["verb"]).toBeNull();
      expect(String(view.body["note"])).toContain("nothing to watch");
      const start = await t.api(`/api/h/${id}/dev/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(start.body["code"]).toBe("no-spec");
      expect(seen).toHaveLength(0);
    } finally {
      await t.stop();
    }
  });
});
