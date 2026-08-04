/**
 * The M2 process layer, driven through the HTTP surface with a fake
 * `ProcessOps` + fake clock. Nothing here spawns a real daemon: the
 * supervisor's own suite already proves signals, OS start times, and
 * fd-redirected stdout against real fixture scripts, and a manager suite
 * that re-proved them would be the slowest, flakiest thing in the repo.
 *
 * What this file is for is the WIRING the supervisor cannot test for us:
 * that the gate's refusal reaches the client typed, that the daemon's boot
 * announcement becomes a recorded control port, that a drain marks the
 * imminent exit-0 as an operator stop, and that the live SSE feed carries
 * what the console renders.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { JobArgumentError, jobArgv } from "./process";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function daemonHarness(t: TestServer, name: string): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    target: "channel",
    bundle: { entry: "daemon.ts" },
  });
}

describe("process control", () => {
  test("start writes a runfile, stop clears it, and the ledger records both", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-lifecycle");
      const id = await register(t, dir);

      const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(started.status).toBe(200);
      const runId = started.body["runId"] as string;
      expect(runId).toMatch(/^run_[0-9a-f]{16}$/);
      // The runfile IS the singleton lock — a daemon start must write one.
      const runfile = JSON.parse(
        readFileSync(join(dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      );
      expect(runfile.runId).toBe(runId);

      // A second start is refused by the lock, not turned into a second child.
      const again = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(again.status).toBe(409);
      expect(again.body["reason"]).toBe("already-running");
      expect(t.ops?.children.length).toBe(1);

      const stopped = await t.api(`/api/h/${id}/proc/stop`, { method: "POST", body: "{}" });
      expect(stopped.body["stopped"]).toBe(true);
      expect(t.ops?.last()?.signals).toEqual(["SIGTERM"]);

      const runs = await t.api(`/api/h/${id}/runs`);
      const rows = runs.body["runs"] as Array<{ runId: string; endedAt?: string }>;
      expect(rows[0]?.runId).toBe(runId);
      expect(typeof rows[0]?.endedAt).toBe("string");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the daemon's control-plane announcement becomes a recorded control port", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-controlport");
      const id = await register(t, dir);
      await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });

      // The manager stamps CREWHAUS_CONTROL_PORT=0, so the KERNEL picks the
      // port and this stdout line is the only place it is ever stated.
      expect(t.ops?.last()?.request.env["CREWHAUS_CONTROL_PORT"]).toBe("0");
      // …and the token is never in argv, where every process could read it.
      expect(t.ops?.last()?.request.argv.join(" ")).not.toContain("CONTROL_TOKEN");
      expect(t.ops?.last()?.request.env["CREWHAUS_CONTROL_TOKEN"]).toBeUndefined();

      t.ops
        ?.last()
        ?.writeLog(
          "[control] crewhaus.control.v1 listening on http://127.0.0.1:41234 (token: .crewhaus/run/control-token)\n",
        );
      t.clock?.advance(300); // one pump tick

      const proc = await t.api(`/api/h/${id}/proc`);
      expect((proc.body["control"] as { port: number }).port).toBe(41234);
      // Recorded in the runfile too, so a manager restart adopts wake/drain
      // instead of silently losing them.
      const runfile = JSON.parse(
        readFileSync(join(dir, ".crewhaus", "run", "daemon.json"), "utf8"),
      );
      expect(runfile.controlPort).toBe(41234);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a drain with no control plane degrades to the signal path and says so", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-drain");
      const id = await register(t, dir);
      await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });

      const drained = await t.api(`/api/h/${id}/proc/drain`, { method: "POST", body: "{}" });
      expect(drained.body["stopped"]).toBe(true);
      // Honest: control.v1 was unreachable, so this was SIGTERM, not a drain.
      expect(drained.body["viaSignal"]).toBe(true);
      expect(t.ops?.last()?.signals).toEqual(["SIGTERM"]);
      const proc = await t.api(`/api/h/${id}/proc`);
      expect(proc.body["state"]).toBe("stopped");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the live SSE feed carries state/output frames and always terminates with done", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = daemonHarness(t, "proc-sse");
      const id = await register(t, dir);
      const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      const runId = started.body["runId"] as string;

      const res = await t.fetchRaw(`/api/h/${id}/runs/${runId}/events`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const pump = async (until: (s: string) => boolean): Promise<void> => {
        while (!until(seen)) {
          const { value, done } = await reader.read();
          if (done) return;
          seen += decoder.decode(value, { stream: true });
        }
      };
      await pump((s) => s.includes("event: replay"));

      t.ops?.last()?.writeLog("hello from the daemon\n");
      t.clock?.advance(300);
      await pump((s) => s.includes("event: output"));
      expect(seen).toContain("hello from the daemon");

      // The exit closes the stream with a terminal frame — that is what lets
      // a client tell "finished" from "the connection dropped".
      t.ops?.last()?.exit(0, null);
      await pump((s) => s.includes("event: done"));
      expect(seen).toContain("event: exit");
      expect(seen).toContain("event: done");
      await reader.cancel();
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a preflight refusal answers 409 with the acknowledgeable/unforceable split", async () => {
    // A Slack channel bot with no credentials: the compiled daemon's own
    // boot gate exits 2 on exactly this set, so "start anyway" must NOT be
    // offered for it.
    const t = bootTestServer({ now: () => NOW, preflight: true, env: {} });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "proc-preflight"), {
        specName: "proc-preflight",
        target: "channel",
        // A spec that COMPILES — otherwise the refusal would be a spec lint,
        // not the channel-secret boot gate this test is about.
        noSpec: true,
        bundle: { entry: "daemon.ts" },
      });
      writeFileSync(
        join(dir, "crewhaus.yaml"),
        [
          "name: proc-preflight",
          "target: channel",
          "agent:",
          "  model: anthropic/claude-sonnet-4",
          "  instructions: |",
          "    You are a fixture.",
          "routing:",
          "  sessionKey: channel",
          "channels:",
          "  slack:",
          "    botToken: $PREFLIGHT_SLACK_BOT_TOKEN",
          "    signingSecret: $PREFLIGHT_SLACK_SIGNING_SECRET",
          "",
        ].join("\n"),
      );
      const id = await register(t, dir);

      const refused = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(refused.status).toBe(409);
      expect(refused.body["reason"]).toBe("preflight-blocked");
      const items = refused.body["refused"] as Array<{ area: string; acknowledgeable: boolean }>;
      expect(items.length).toBeGreaterThan(0);
      const channelItems = items.filter((i) => i.area === "channels");
      expect(channelItems.length).toBeGreaterThan(0);
      expect(channelItems.every((i) => i.acknowledgeable === false)).toBe(true);
      expect((refused.body["unforceable"] as string[]).length).toBeGreaterThan(0);
      // Nothing was spawned — the refusal replaced the spawn, not followed it.
      expect(t.ops?.children.length ?? 0).toBe(0);

      // …and `force` cannot clear it either.
      const forced = await t.api(`/api/h/${id}/proc/start`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      expect(forced.status).toBe(409);
      expect((forced.body["unforceable"] as string[]).length).toBeGreaterThan(0);
      expect(t.ops?.children.length ?? 0).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a harness with no bundle answers plan-failed with the remedy the UI turns into a button", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "proc-nobundle"), {
        specName: "proc-nobundle",
        target: "channel",
      });
      const id = await register(t, dir);
      const failed = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
      expect(failed.status).toBe(409);
      expect(failed.body["reason"]).toBe("plan-failed");
      expect(failed.body["remedy"]).toBe("compile");

      const proc = await t.api(`/api/h/${id}/proc`);
      expect((proc.body["bundle"] as { present: boolean }).present).toBe(false);
      expect((proc.body["launch"] as { error: { remedy: string } }).error.remedy).toBe("compile");
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("job argv", () => {
  test("each M2 job kind maps to a fixed command line", () => {
    expect(jobArgv("doctor")).toEqual(["doctor"]);
    expect(jobArgv("compile")).toEqual(["compile", "crewhaus.yaml", "-o", "dist"]);
    expect(jobArgv("dream-run")).toEqual(["dream", "run", "crewhaus.yaml"]);
    expect(jobArgv("eval", { dataset: "smoke", graders: "graders.yaml" })).toEqual([
      "eval",
      "crewhaus.yaml",
      "--dataset",
      "smoke",
      "--graders",
      "graders.yaml",
    ]);
  });

  test("an HTTP body can never append a flag or escape the harness", () => {
    // This is the boundary where a request turns into a command line — the
    // one place a mistake becomes an injection.
    for (const bad of ["--write-back", "../../etc/passwd", "/abs/path", "a b", "a;b", ""]) {
      expect(() => jobArgv("eval", { dataset: bad })).toThrow(JobArgumentError);
    }
  });
});
