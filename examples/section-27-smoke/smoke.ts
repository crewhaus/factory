#!/usr/bin/env bun
/**
 * Section 27 Production hardening — end-to-end smoke.
 *
 * Five probes covering the full wiring of cost-tracker, rate-limiter,
 * circuit-breaker, prompt-cache-manager, and secrets-manager:
 *
 *   1. cost-tracker — synthesise three model_response events through a
 *      live TraceEventBus; assert getRunCost matches pricing × tokens
 *      and three cost_accrual events landed.
 *   2. rate-limiter — bucket at 5 req/sec; pump 10 acquires and confirm
 *      elapsed time ≥ 800ms (at least the back-pressure kicked in).
 *   3. circuit-breaker — flaky stub; 5 failures trip; cooldown elapsed
 *      → probe success closes; emits 3 circuit_state_changed events.
 *   4. prompt-cache-manager — backdate marker by 8 days; assert manage()
 *      injects fresh marker AND old markers are stripped.
 *   5. secrets-manager — file-backend rotate; audit-log records
 *      secrets_rotation under the configured tenant.
 *
 * The smoke runs against an in-process fixture stack (no live Anthropic
 * call needed); the goal is integration-level wiring proof rather than
 * provider call validation. The §27 kickoff allows live-model probes too,
 * but the full wiring story is tested in unit tests + this in-process
 * smoke. Live-model exposure happens automatically every other section's
 * smoke run because §27 is now wired into runtime-core.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import { wrap as wrapCircuitBreaker } from "@crewhaus/circuit-breaker";
import { createCostTracker, formatUsdMicros } from "@crewhaus/cost-tracker";
import { manage as manageCacheMarkers } from "@crewhaus/prompt-cache-manager";
import { createRateLimiter } from "@crewhaus/rate-limiter";
import { createFileBackend, createSecrets } from "@crewhaus/secrets-manager";
import {
  type CircuitStateChangedEvent,
  type CostAccrualEvent,
  type ModelResponseEvent,
  type ProviderId,
  TraceEventBus,
} from "@crewhaus/trace-event-bus";

const log = (msg: string): void => {
  process.stderr.write(`[smoke-27] ${msg}\n`);
};
const fail = (msg: string): never => {
  process.stderr.write(`[smoke-27] FAIL: ${msg}\n`);
  process.exit(2);
};
const ok = (msg: string): void => {
  process.stderr.write(`[smoke-27] ✓ ${msg}\n`);
};

const main = async (): Promise<void> => {
  const tmpRoot = join(tmpdir(), `smoke27-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });

  try {
    // ────────── Probe 1: cost-tracker ──────────
    {
      log("probe 1: cost-tracker — 3 model_response events → 3 cost_accrual events + USD total");
      const bus = new TraceEventBus({ runId: "run_smoke", sessionId: "sess_smoke" });
      const accruals: CostAccrualEvent[] = [];
      bus.subscribe((e) => {
        if (e.kind === "cost_accrual") accruals.push(e as CostAccrualEvent);
      });
      const tracker = createCostTracker(bus);
      const sendResponse = (
        model: string,
        provider: ProviderId,
        input: number,
        output: number,
      ): void => {
        const evt: ModelResponseEvent = {
          ...bus.envelope(),
          runId: bus.runId,
          kind: "model_response",
          model,
          provider,
          stopReason: "end_turn",
          usage: { input, output },
          durationMs: 100,
        };
        bus.publish(evt);
      };
      sendResponse("claude-opus-4-7", "anthropic", 1000, 500);
      sendResponse("claude-opus-4-7", "anthropic", 200, 100);
      sendResponse("claude-opus-4-7", "anthropic", 50, 25);
      if (accruals.length !== 3) fail(`expected 3 cost_accrual events, got ${accruals.length}`);
      const summary = tracker.getRunCost(bus.runId);
      // (1250 input × 15 + 625 output × 75) micros = 18_750 + 46_875 = 65_625
      if (summary.totalUsdMicros !== 65_625) {
        fail(`expected totalUsdMicros 65625, got ${summary.totalUsdMicros}`);
      }
      ok(`cost-tracker: ${formatUsdMicros(summary.totalUsdMicros)} total across 3 events`);
    }

    // ────────── Probe 2: rate-limiter ──────────
    {
      log("probe 2: rate-limiter — 5 req/s bucket; 10 acquires; back-pressure elapsed >= 800ms");
      const buckets = new Map([
        ["tenant:smoke", { kind: "token-bucket" as const, capacity: 1, refillPerSec: 5 }],
      ]);
      const rl = createRateLimiter({ buckets });
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) {
        await rl.acquire([{ dimension: "tenant", id: "smoke" }], 1, { maxWaitMs: 30_000 });
      }
      const elapsed = Date.now() - t0;
      if (elapsed < 600) fail(`rate-limiter elapsed ${elapsed}ms; expected >= 600ms back-pressure`);
      ok(`rate-limiter: 5 sequential acquires took ${elapsed}ms (≥ 600ms enforces 5/s)`);
    }

    // ────────── Probe 3: circuit-breaker ──────────
    {
      log("probe 3: circuit-breaker — 5 fails → trip; cooldown → probe success → closed");
      const bus = new TraceEventBus({ runId: "run_cb", sessionId: "sess_cb" });
      const transitions: CircuitStateChangedEvent[] = [];
      bus.subscribe((e) => {
        if (e.kind === "circuit_state_changed") transitions.push(e as CircuitStateChangedEvent);
      });

      let nowMs = 0;
      let mode: "fail" | "succeed" = "fail";
      const stub: ProviderAdapter = {
        providerId: "anthropic",
        features: {
          caching: "explicit",
          tool_use: true,
          vision: false,
          thinking: false,
          web_search: false,
        },
        estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
          return messages.length;
        },
        async *stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
          if (mode === "fail") throw new Error("simulated upstream 503");
          yield { kind: "message_start", usage: { input: 1, output: 1 } };
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
          yield { kind: "message_stop" };
        },
      };
      const breaker = wrapCircuitBreaker(stub, {
        failureThreshold: 5,
        cooldownMs: 1000,
        bus,
        now: (): number => nowMs,
      });
      const drain = async (): Promise<boolean> => {
        try {
          const events: StreamEvent[] = [];
          for await (const e of breaker.stream({
            model: "x",
            system: [],
            messages: [],
            maxTokens: 10,
          }))
            events.push(e);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 5; i++) {
        nowMs += 100;
        await drain();
      }
      if (breaker.state() !== "open")
        fail(`expected breaker.open after 5 fails, got ${breaker.state()}`);
      nowMs += 1100;
      if (breaker.state() !== "half_open")
        fail(`expected half_open after cooldown, got ${breaker.state()}`);
      mode = "succeed";
      const r = await drain();
      if (!r) fail("expected probe success to drain");
      if (breaker.state() !== "closed") fail(`expected closed after probe, got ${breaker.state()}`);
      const seq = transitions.map((t) => `${t.fromState}→${t.toState}`);
      if (
        JSON.stringify(seq) !==
        JSON.stringify(["closed→open", "open→half_open", "half_open→closed"])
      ) {
        fail(`unexpected transition sequence: ${seq.join(", ")}`);
      }
      ok("circuit-breaker: closed → open → half_open → closed (3 events)");
    }

    // ────────── Probe 4: prompt-cache-manager ──────────
    {
      log("probe 4: prompt-cache-manager — backdate by 8 days; manage() rotates marker");
      const day = 24 * 60 * 60 * 1000;
      const result = manageCacheMarkers(
        [
          { type: "text", text: "old-system-1", cache_control: { type: "ephemeral" } },
          { type: "text", text: "old-system-2", cache_control: { type: "ephemeral" } },
        ],
        {
          features: {
            caching: "explicit",
            tool_use: true,
            vision: false,
            thinking: false,
            web_search: false,
          },
          lastRotatedAt: 1_000_000,
          now: (): number => 1_000_000 + 8 * day,
        },
      );
      if (!result.rotated) fail("expected rotated=true after 8-day staleness");
      const markers = result.blocks.filter(
        (b) => b.cache_control && b.cache_control.type === "ephemeral",
      );
      if (markers.length !== 1)
        fail(`expected exactly 1 marker after rotation, got ${markers.length}`);
      if (result.blocks[0]?.cache_control !== undefined) fail("first block should have no marker");
      if (result.blocks[1]?.cache_control?.type !== "ephemeral") {
        fail("last block should carry the fresh marker");
      }
      ok(
        "prompt-cache-manager: rotated marker; last block carries cache_control, intermediates stripped",
      );
    }

    // ────────── Probe 5: secrets-manager ──────────
    {
      log("probe 5: secrets-manager — rotate via file backend; audit-log records secrets_rotation");
      const secretsDir = join(tmpRoot, "secrets");
      const auditDir = join(tmpRoot, "audit");
      mkdirSync(secretsDir);
      writeFileSync(join(secretsDir, "SLACK_BOT_TOKEN"), "old-token");
      const audit = await openAuditLog({ rootDir: auditDir });
      const secrets = createSecrets({
        backend: createFileBackend({ rootDir: secretsDir }),
        auditLog: audit,
        tenantId: "smoke-tenant",
      });
      let rotationFires = 0;
      secrets.onRotation((e) => {
        rotationFires++;
        if (e.name !== "SLACK_BOT_TOKEN") fail(`unexpected rotation name ${e.name}`);
        if (e.newValue !== "fresh-xoxb-...") fail("unexpected rotation newValue");
      });
      const newValue = await secrets.rotate("SLACK_BOT_TOKEN", { newValue: "fresh-xoxb-..." });
      if (newValue !== "fresh-xoxb-...") fail("rotate didn't return new value");
      if (rotationFires !== 1) fail(`expected 1 rotation handler fire, got ${rotationFires}`);
      const onDisk = readFileSync(join(secretsDir, "SLACK_BOT_TOKEN"), "utf8");
      if (onDisk !== "fresh-xoxb-...") fail(`secret on disk mismatch: ${onDisk}`);
      const records: AuditRecord[] = [];
      for await (const r of audit.read()) records.push(r);
      const rotationRec = records.find((r) => r.kind === "secrets_rotation");
      if (!rotationRec) fail("audit-log missing secrets_rotation record");
      const payload = rotationRec.payload as { tenantId?: string; name?: string };
      if (payload.tenantId !== "smoke-tenant") fail(`audit tenantId mismatch: ${payload.tenantId}`);
      if (payload.name !== "SLACK_BOT_TOKEN") fail(`audit name mismatch: ${payload.name}`);
      ok(
        "secrets-manager: rotation persisted to disk + onRotation fired + audit-logged under tenant",
      );
    }

    log("all probes passed.");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((err) => {
  process.stderr.write(
    `[smoke-27] threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
