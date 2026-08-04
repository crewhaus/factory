/**
 * The ONE compile-and-boot smoke for `crewhaus.control.v1`.
 *
 * Everything else about control.v1 is covered without a process — the router
 * in `@crewhaus/gateway-protocol`, the emitted text in `index.test.ts`. This
 * test exists for the one claim neither can make: that a REAL emitted daemon,
 * booted the way a supervisor boots it (detached-style, cwd = harness root,
 * `CREWHAUS_CONTROL_PORT` stamped into the env), actually serves the surface
 * and honours it end to end — healthz → status → wake → drain, including the
 * synthetic-tick session marker and the 409-while-in-flight rule.
 *
 * No credential here is real: every value is assembled from parts at runtime,
 * and the model endpoint points at a closed loopback port so the poked tick
 * fails instantly instead of reaching the network.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IrChannelV0 } from "@crewhaus/ir";
import { emitChannelBot } from "./index";

/** Generous but bounded: a cold `bun` boot of the emitted daemon. */
const BOOT_TIMEOUT_MS = 60_000;

const IR: IrChannelV0 = {
  version: 0,
  name: "control-smoke",
  target: "channel",
  agent: { model: "claude-sonnet-4-6", instructions: "be brief" },
  tools: [],
  toolConfigs: {},
  channels: {
    slack: {
      botToken: { kind: "env", name: "SLACK_BOT_TOKEN" },
      signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
    },
  },
  routing: { sessionKey: "thread" },
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
  subAgents: [],
  // An hour apart, so nothing fires organically inside the test window: every
  // tick observed here is one an operator asked for.
  heartbeat: { everyMs: 3_600_000, instructions: "Wake and check." },
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Repo root (…/packages/target-channel-bot/src → …). */
const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

/**
 * Stand up a harness dir the emitted daemon can actually run in: the bundle
 * under `dist/`, plus a `node_modules/@crewhaus/*` link farm standing in for
 * the `bun install` a standalone bundle would do against the pinned manifest.
 */
function makeHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-control-smoke-"));
  dirs.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const file of emitChannelBot(IR, { readme: false }).files) {
    const full = join(dist, file.path);
    mkdirSync(dirname(full), { recursive: true });
    Bun.write(full, file.content);
  }
  const scope = join(root, "node_modules", "@crewhaus");
  mkdirSync(scope, { recursive: true });
  const packagesDir = join(REPO_ROOT, "packages");
  for (const name of readdirSync(packagesDir)) {
    try {
      symlinkSync(join(packagesDir, name), join(scope, name), "dir");
    } catch {
      // Already linked — the farm is idempotent.
    }
  }
  return root;
}

/** Read lines off a stream until `match` appears (or the deadline passes). */
async function waitForLine(
  stream: ReadableStream<Uint8Array>,
  match: RegExp,
  deadlineMs: number,
  sink: string[],
): Promise<RegExpMatchArray> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const started = Date.now();
  try {
    let buffered = "";
    while (Date.now() - started < deadlineMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      sink.push(buffered.slice(sink.join("").length));
      const found = buffered.match(match);
      if (found !== null) return found;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`never saw ${match} in daemon output:\n${sink.join("")}`);
}

test(
  "an emitted channel daemon serves control.v1 end to end",
  async () => {
    const root = makeHarness();
    // Fake credentials, assembled from parts so no realistic-shaped secret
    // literal is ever committed. The model endpoint is a closed loopback port:
    // the poked tick fails immediately, with no network egress.
    const fakeSlackBot = ["xo", "xb", "-", "0".repeat(12)].join("");
    const fakeSlackSigning = ["sig", "-", "0".repeat(16)].join("");
    const fakeAnthropic = ["sk", "-", "ant", "-", "0".repeat(16)].join("");
    const controlToken = ["ctl", "-", "0".repeat(24)].join("");

    const proc = Bun.spawn({
      cmd: ["bun", join(root, "dist", "daemon.ts")],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: fakeSlackBot,
        SLACK_SIGNING_SECRET: fakeSlackSigning,
        ANTHROPIC_API_KEY: fakeAnthropic,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        // 0 asks the kernel for an ephemeral port — the daemon must REPORT it,
        // which is how a supervisor that passed 0 learns where to connect.
        CREWHAUS_CONTROL_PORT: "0",
        CREWHAUS_CONTROL_TOKEN: controlToken,
        PORT: "0",
        CREWHAUS_JANITOR: "0",
        CREWHAUS_DREAM: "0",
      },
    });
    const out: string[] = [];
    try {
      const banner = await waitForLine(
        proc.stdout,
        /\[control\] crewhaus\.control\.v1 listening on (http:\/\/127\.0\.0\.1:\d+)/,
        BOOT_TIMEOUT_MS,
        out,
      );
      const control = banner[1] as string;
      const publicPort = out.join("").match(/\[daemon\] listening on (http:\/\/localhost:\d+)/);
      expect(publicPort).not.toBeNull();
      const publicBase = (publicPort as RegExpMatchArray)[1] as string;

      // The banner reports WHERE, never the bearer.
      expect(out.join("")).not.toContain(controlToken);

      const auth = { authorization: `Bearer ${controlToken}` };

      // --- auth -------------------------------------------------------------
      expect((await fetch(`${control}/control/v1/healthz`)).status).toBe(401);
      const health = await fetch(`${control}/control/v1/healthz`, { headers: auth });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        ok: true,
        name: "control-smoke",
        target: "channel",
      });

      // --- the bare public-port liveness check -------------------------------
      // Unauthenticated on purpose, and state-free: this is the check the
      // deployment scaffolds declare and no daemon used to serve.
      const bare = await fetch(`${publicBase}/healthz`);
      expect(bare.status).toBe(200);
      expect(await bare.json()).toEqual({ ok: true });

      // --- status -----------------------------------------------------------
      const status = (await (
        await fetch(`${control}/control/v1/status`, { headers: auth })
      ).json()) as {
        name: string;
        target: string;
        pid: number;
        counters: Record<string, number>;
        timers: Array<{ lane: string; cadence: string; nextDueAt?: string }>;
        channels: string[];
        pendingApprovals: number;
      };
      expect(status.name).toBe("control-smoke");
      expect(status.target).toBe("channel");
      expect(status.pid).toBe(proc.pid);
      expect(status.channels).toEqual(["slack"]);
      expect(status.pendingApprovals).toBe(0);
      expect(status.counters.heartbeatTicks).toBe(0);
      const heartbeat = status.timers.find((t) => t.lane === "heartbeat");
      // The heartbeat's phase is knowable ONLY in-process — this is the number
      // no offline reader of the spec can produce.
      expect(heartbeat?.cadence).toBe("every 3600000ms");
      expect(Date.parse(heartbeat?.nextDueAt ?? "")).toBeGreaterThan(Date.now());

      // --- wake, and the never-overlap rule ---------------------------------
      const [first, second] = await Promise.all([
        fetch(`${control}/control/v1/wake`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ lane: "heartbeat", reason: "smoke poke", by: "hangar" }),
        }),
        fetch(`${control}/control/v1/wake`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ lane: "heartbeat", reason: "duplicate", by: "hangar" }),
        }),
      ]);
      const accepted = first.status === 202 ? first : second;
      const refused = first.status === 202 ? second : first;
      expect(accepted.status).toBe(202);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("tick_in_flight");
      const { sessionId } = (await accepted.json()) as { sessionId: string };
      expect(sessionId).toMatch(/^sess_[0-9a-f]{16}$/);

      // A lane the bundle never armed is honestly refused, not silently ok'd.
      const noLane = await fetch(`${control}/control/v1/wake`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ lane: "schedule", reason: "x" }),
      });
      expect(noLane.status).toBe(404);
      expect(((await noLane.json()) as { code: string }).code).toBe("lane_not_armed");

      // --- the synthetic marker ---------------------------------------------
      const logPath = join(root, ".crewhaus", "sessions", `${sessionId}.jsonl`);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          readFileSync(logPath, "utf-8");
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      const marker = JSON.parse(readFileSync(logPath, "utf-8").split("\n")[0] as string) as {
        kind: string;
        payload: Record<string, unknown>;
      };
      // `user_message` + `synthetic: true` is the convention every
      // turn-deriving reader already skips, so an operator poke cannot inflate
      // an eval's turn count or land in a training set as a human turn.
      expect(marker.kind).toBe("user_message");
      expect(marker.payload["synthetic"]).toBe(true);
      expect(marker.payload["control"]).toEqual({
        protocol: "crewhaus.control.v1",
        lane: "heartbeat",
        synthetic: true,
        reason: "smoke poke",
        by: "hangar",
      });

      // The counter moved once, for the one accepted poke.
      const after = (await (
        await fetch(`${control}/control/v1/status`, { headers: auth })
      ).json()) as { counters: Record<string, number> };
      expect(after.counters.heartbeatTicks).toBe(1);

      // --- drain -------------------------------------------------------------
      const drain = await fetch(`${control}/control/v1/drain`, { method: "POST", headers: auth });
      expect(drain.status).toBe(202);
      expect(await drain.json()).toEqual({ draining: true, alreadyDraining: false });

      // Intake is refused the moment the drain lands — with a Retry-After, so a
      // sender knows this is backpressure and not a failure.
      const shed = await fetch(`${publicBase}/slack/events`, { method: "POST", body: "{}" });
      expect(shed.status).toBe(503);
      expect(shed.headers.get("retry-after")).toBe("15");
      // …while liveness keeps answering, or a PaaS reaps the process mid-drain.
      expect((await fetch(`${publicBase}/healthz`)).status).toBe(200);

      expect(await proc.exited).toBe(0);

      // --- the audit trail ---------------------------------------------------
      const auditDir = join(root, ".crewhaus", "audit");
      const auditFile = readdirSync(auditDir).find((f) => f.endsWith(".jsonl"));
      expect(auditFile).toBeDefined();
      const audit = readFileSync(join(auditDir, auditFile as string), "utf-8");
      const records = audit
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> })
        .filter((r) => r.kind === "gateway_request");
      // Every control call is evidenced — including the 401 we opened with.
      expect(records.length).toBeGreaterThanOrEqual(6);
      expect(records.some((r) => r.payload["status"] === 401)).toBe(true);
      expect(records.some((r) => r.payload["sessionId"] === sessionId)).toBe(true);
      // The bearer is never part of the record.
      expect(audit).not.toContain(controlToken);
    } finally {
      proc.kill();
      await proc.exited;
    }
  },
  BOOT_TIMEOUT_MS + 30_000,
);
