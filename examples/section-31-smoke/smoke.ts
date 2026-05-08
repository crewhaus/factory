#!/usr/bin/env bun
/**
 * Section 31 Studio v1 — end-to-end smoke.
 *
 * Five probes:
 *   1. studio-server: runDispatcher routes through caller's runtime
 *   2. studio-server: /api/runs/:runId/cancel signals abort
 *   3. studio-server: /api/cost-summary uses configured source
 *   4. trace-viewer: replay yields events deterministically
 *   5. graph-visualizer: live state machine + plugin-sdk content sandbox
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEvent,
  initialLiveState,
  layoutGraph,
  renderLiveSvg,
} from "@crewhaus/graph-visualizer";
import type { IrGraphV0 } from "@crewhaus/ir";
import { PluginSdkError, definePlugin, isFsAllowed, isNetAllowed } from "@crewhaus/plugin-sdk";
import { startStudioServer } from "@crewhaus/studio-server";
import { renderMultiSpecDashboard } from "@crewhaus/studio-ui";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { drilldownSpan, replay } from "@crewhaus/trace-viewer";

const log = (m: string): void => {
  process.stderr.write(`[smoke-31] ${m}\n`);
};
const fail = (m: string): never => {
  process.stderr.write(`[smoke-31] FAIL: ${m}\n`);
  process.exit(2);
};
const ok = (m: string): void => {
  process.stderr.write(`[smoke-31] ✓ ${m}\n`);
};

const main = async (): Promise<void> => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "smoke31-"));

  try {
    // ────────── Probe 1: studio-server runDispatcher ──────────
    {
      log("probe 1: studio-server — runDispatcher injection routes events through caller");
      const dispatched: string[] = [];
      const server = await startStudioServer({
        port: 0,
        workspaceDir: join(tmpRoot, "specs"),
        runDispatcher: async ({ specName, prompt, publish, finish }) => {
          dispatched.push(`${specName}|${prompt}`);
          publish({ kind: "test_event", source: "dispatcher" });
          finish("(real-runtime-output)");
        },
      });
      try {
        const yaml = "name: test\ntarget: cli\nagent:\n  model: m\n  instructions: i\n";
        await fetch(`http://localhost:${server.port}/api/specs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "test", yaml }),
        });
        const runRes = await fetch(`http://localhost:${server.port}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ specName: "test", prompt: "hello" }),
        });
        const { runId } = (await runRes.json()) as { runId: string };
        await new Promise((r) => setTimeout(r, 50));
        if (dispatched.length !== 1) fail(`expected 1 dispatch, got ${dispatched.length}`);
        if (dispatched[0] !== "test|hello") fail(`dispatch payload wrong: ${dispatched[0]}`);
        const events = await fetch(`http://localhost:${server.port}/api/runs/${runId}/events`);
        const text = await events.text();
        if (!text.includes("test_event")) fail("missing test_event in SSE");
        if (!text.includes("real-runtime-output")) fail("missing finish payload");
        ok("studio-server: runDispatcher routes spec/prompt + publish/finish round-trip");
      } finally {
        await server.stop();
      }
    }

    // ────────── Probe 2: cancel endpoint ──────────
    {
      log("probe 2: studio-server — /api/runs/:runId/cancel signals abort");
      let signalSeen: AbortSignal | undefined;
      const server = await startStudioServer({
        port: 0,
        workspaceDir: join(tmpRoot, "specs2"),
        runDispatcher: async ({ signal, finish }) => {
          signalSeen = signal;
          await new Promise((r) => setTimeout(r, 100));
          finish("done");
        },
      });
      try {
        const yaml = "name: test\ntarget: cli\nagent:\n  model: m\n  instructions: i\n";
        await fetch(`http://localhost:${server.port}/api/specs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "test", yaml }),
        });
        const runRes = await fetch(`http://localhost:${server.port}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ specName: "test", prompt: "hi" }),
        });
        const { runId } = (await runRes.json()) as { runId: string };
        await new Promise((r) => setTimeout(r, 10));
        await fetch(`http://localhost:${server.port}/api/runs/${runId}/cancel`, {
          method: "POST",
        });
        if (!signalSeen?.aborted) fail("expected abort signal to be aborted");
        ok("studio-server: cancel propagates AbortSignal to dispatcher");
      } finally {
        await server.stop();
      }
    }

    // ────────── Probe 3: cost summary ──────────
    {
      log("probe 3: studio-server — /api/cost-summary uses configured source");
      const server = await startStudioServer({
        port: 0,
        workspaceDir: join(tmpRoot, "specs3"),
        costSummarySource: async () => ({
          totalUsdMicros: 42_000,
          byProvider: { anthropic: 42_000 },
        }),
      });
      try {
        const res = await fetch(`http://localhost:${server.port}/api/cost-summary?tenant=x`);
        const body = (await res.json()) as { totalUsdMicros: number };
        if (body.totalUsdMicros !== 42_000) fail(`expected 42_000, got ${body.totalUsdMicros}`);
        ok("studio-server: /api/cost-summary returns source's payload");
      } finally {
        await server.stop();
      }
    }

    // ────────── Probe 4: trace-viewer replay + drilldown ──────────
    {
      log(
        "probe 4: trace-viewer — replay yields deterministically; drilldown finds related events",
      );
      const events: TraceEvent[] = [
        {
          runId: "run_test",
          sessionId: "sess_test",
          turnNumber: 0,
          traceId: "0".repeat(32),
          spanId: "a",
          timestamp: "2026-05-08T00:00:00.000Z",
          kind: "model_request",
          model: "m",
          messageCount: 1,
          toolCount: 0,
          streaming: false,
        },
        {
          runId: "run_test",
          sessionId: "sess_test",
          turnNumber: 0,
          traceId: "0".repeat(32),
          spanId: "a",
          timestamp: "2026-05-08T00:00:00.500Z",
          kind: "model_response",
          model: "m",
          stopReason: "end_turn",
          usage: { input: 5, output: 5 },
          durationMs: 500,
        },
      ];
      const out: TraceEvent[] = [];
      const stubSetTimeout = (cb: () => void): void => cb();
      for await (const e of replay(events, { speed: "raw", setTimeoutImpl: stubSetTimeout })) {
        out.push(e);
      }
      if (out.length !== 2) fail(`expected 2 events from replay, got ${out.length}`);
      // Drilldown: build a timeline first.
      const { buildTimeline } = await import("@crewhaus/trace-viewer");
      const tl = buildTimeline(events);
      const dd = drilldownSpan(tl, events, "a");
      if (!dd || dd.events.length !== 2) fail("drilldown failed to surface 2 events for span a");
      ok("trace-viewer: replay + drilldown deterministic");
    }

    // ────────── Probe 5: graph-visualizer + plugin-sdk ──────────
    {
      log("probe 5: graph-visualizer live mode + plugin-sdk content sandbox");
      const ir: IrGraphV0 = {
        version: 0,
        name: "g",
        target: "graph",
        entry: "plan",
        nodes: [
          {
            name: "plan",
            instructions: "p",
            model: "m",
            tools: [],
            toolConfigs: Object.freeze({}),
          },
          {
            name: "execute",
            instructions: "e",
            model: "m",
            tools: [],
            toolConfigs: Object.freeze({}),
          },
        ],
        edges: [{ from: "plan", to: "execute" }],
      };
      const layout = layoutGraph(ir);
      let state = initialLiveState(layout);
      state = applyEvent(state, { kind: "node_start", node: "plan", ts: "t1" });
      state = applyEvent(state, { kind: "node_end", node: "plan", ts: "t2" });
      state = applyEvent(state, { kind: "node_start", node: "execute", ts: "t3" });
      const svg = renderLiveSvg(layout, state);
      if (!svg.includes('data-state="done"')) fail("svg missing done state for plan");
      if (!svg.includes('data-state="running"')) fail("svg missing running state for execute");

      // plugin-sdk content sandbox check
      const plugin = definePlugin({
        name: "sandbox-test",
        version: "1",
        permissions: {
          fs: ["read:/sandbox/data/**"],
          net: ["fetch:https://api.example.com/**"],
        },
      });
      if (!isFsAllowed(plugin.permissions, "/sandbox/data/file.json")) {
        fail("expected fs allow inside sandbox");
      }
      if (isFsAllowed(plugin.permissions, "/etc/passwd")) {
        fail("expected fs deny for /etc/passwd");
      }
      if (!isNetAllowed(plugin.permissions, "https://api.example.com/v1")) {
        fail("expected net allow for matching url");
      }
      if (isNetAllowed(plugin.permissions, "https://exfil.example.com/")) {
        fail("expected net deny for non-matching url");
      }
      // Malformed permissions throw.
      try {
        definePlugin({
          name: "bad",
          version: "1",
          permissions: { fs: ["wrong-prefix"] },
        });
        fail("expected definePlugin to throw on malformed permissions");
      } catch (err) {
        if (!(err instanceof PluginSdkError)) {
          fail(`expected PluginSdkError, got ${(err as Error).constructor.name}`);
        }
      }
      ok("graph-visualizer + plugin-sdk: live state animation + content-sandbox enforcement");
    }

    // ────────── Probe 6 (bonus): studio-ui dashboard renderer ──────────
    {
      log("probe 6: studio-ui — multi-spec dashboard renderer");
      const html = renderMultiSpecDashboard([
        { specName: "alpha", costUsdMicros: 12_345, passRate: 0.95, runCount: 10 },
        { specName: "beta", costUsdMicros: 6_789, runCount: 3 },
      ]);
      if (!html.includes("alpha")) fail("dashboard missing alpha");
      if (!html.includes("$0.0123")) fail("dashboard missing cost");
      if (!html.includes("95.0%")) fail("dashboard missing pass-rate");
      ok("studio-ui: multi-spec dashboard renders cost + pass-rate + sorted rows");
    }

    log("all probes passed.");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((err) => {
  process.stderr.write(
    `[smoke-31] threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
