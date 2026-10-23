/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.4, §8) — the managed shape's
 * proof surface, compiled and RUN.
 *
 * `index.test.ts` pins the emitted text; this boots the emitted daemon the way
 * an operator does (cwd = harness root, a `node_modules/@crewhaus/*` link farm
 * standing in for `bun install`) against a loopback fake of the Messages API,
 * and drives the gateway over HTTP with a minted tenant JWT. It asserts the
 * claims nothing else can make:
 *
 *   - `runs.create` answers with `proof`, the bundle the gate graded the run's
 *     final turn against, and the result validates against
 *     `@crewhaus/gateway-protocol`'s `RunsCreateResult`;
 *   - the footer rides `reply`, and `provability.render: none` leaves it off
 *     while the envelope still carries the bundle;
 *   - a failing `note` verdict still answers, with `verdict: "fail"` in
 *     `proof` and the ✗ footer;
 *   - a duplicate `runs.continue` (the idempotent resume path) returns the
 *     cached reply WITH its bundle, without a second model call;
 *   - `runs.subscribe` replays the run's `provability_graded` trace event —
 *     the SSE surface was already wired, and this verifies it carries the
 *     gate's line rather than rebuilding it.
 *
 * No credential is real (each is assembled from parts) and nothing leaves
 * the loopback interface.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunsContinueResult, RunsCreateResult } from "@crewhaus/gateway-protocol";
import { signJwt } from "@crewhaus/gateway-server";
import type { IrManagedV0 } from "@crewhaus/ir";
import { emitManaged } from "./index";

/** Generous but bounded: a cold `bun` boot of the emitted daemon under load. */
const BOOT_TIMEOUT_MS = 90_000;

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

const PROVABILITY: NonNullable<IrManagedV0["provability"]> = {
  level: "cited",
  onFail: "note",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["evaluate"], replay: true, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: ["sorry"], timeoutMs: 30_000 },
};

const baseIr = (provability: IrManagedV0["provability"]): IrManagedV0 => ({
  version: 0,
  name: "proof-envelope",
  target: "managed",
  agent: { model: "claude-sonnet-4-6", instructions: "Answer with a cited sentence." },
  tenants: [{ id: "tenant-a", budget: { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 } }],
  permissions: { rules: [] },
  compaction: {},
  // Keep the run to the gate: no memory fabric, so no plan tools or stores.
  continuity: undefined,
  ...(provability !== undefined ? { provability } : {}),
});

const CITED =
  "Refunds are accepted within 14 days of purchase [1].\n\n[1]: https://acme.example/policy";
const UNCITED = "Refunds are accepted within 14 days of purchase, which is the standard window.";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** One streamed assistant text message, in the Messages API's SSE framing. */
function sseText(text: string): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

/** The last user message's text in a Messages API request body. */
function lastUserText(body: { messages?: Array<{ role: string; content: unknown }> }): string {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  if (last === undefined) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content as Array<{ type?: string; text?: string }>)
    .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
    .join("");
}

/**
 * The fake model: an uncited answer when the question says so, else a cited
 * one; a question that says "slow" is answered after a delay, so a run that
 * starts first finishes last. `maxInFlight` is how many answers it was ever
 * writing at once — the proof that two runs overlapped.
 */
function startModel(): {
  readonly port: number;
  readonly calls: () => number;
  readonly maxInFlight: () => number;
} {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const body = (await req.json()) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        const question = lastUserText(body);
        if (question.includes("slow")) await Bun.sleep(SLOW_MS);
        const text = question.includes("uncited") ? UNCITED : CITED;
        return new Response(sseText(text), { headers: { "content-type": "text/event-stream" } });
      } finally {
        inFlight -= 1;
      }
    },
  });
  servers.push(server);
  return { port: server.port as number, calls: () => calls, maxInFlight: () => maxInFlight };
}

/** How long the fake model holds a "slow" answer: long enough for another run to finish. */
const SLOW_MS = 2_000;

/** A harness dir with the emitted bundle under `dist/` and the workspace linked in. */
function makeHarness(ir: IrManagedV0): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-proof-envelope-"));
  dirs.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const file of emitManaged(ir, { readme: false }).files) {
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
      // Already linked.
    }
  }
  return root;
}

/** Read a stream until `match` appears or the deadline passes. */
async function waitFor(
  stream: ReadableStream<Uint8Array>,
  match: RegExp,
  deadlineMs: number,
): Promise<RegExpMatchArray> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const started = Date.now();
  let buffered = "";
  try {
    while (Date.now() - started < deadlineMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const found = buffered.match(match);
      if (found !== null) return found;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`never saw ${match} in daemon output:\n${buffered}`);
}

type Daemon = {
  readonly call: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  readonly subscribe: (runId: string, until: RegExp) => Promise<string>;
  readonly modelCalls: () => number;
  readonly maxInFlight: () => number;
};

const SECRET = ["proof", "envelope", "0".repeat(16)].join("-");

async function boot(ir: IrManagedV0): Promise<Daemon> {
  const root = makeHarness(ir);
  const model = startModel();
  const proc = Bun.spawn({
    cmd: [process.execPath, join(root, "dist", "daemon.ts")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      ANTHROPIC_API_KEY: ["sk", "ant", "e2e", "0".repeat(12)].join("-"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`,
      CREWHAUS_GATEWAY_JWT_SECRET: SECRET,
      CREWHAUS_TENANTS_ROOT: join(root, "tenants"),
      CREWHAUS_SESSION_DIR: join(root, "sessions"),
      CREWHAUS_NO_REGISTRY: "1",
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_JANITOR: "0",
      PORT: "0",
      HOST: "127.0.0.1",
    },
  });
  procs.push(proc);
  const banner = await waitFor(
    proc.stderr,
    /\[managed\] gateway listening on 127\.0\.0\.1:(\d+)/,
    BOOT_TIMEOUT_MS,
  );
  const base = `http://127.0.0.1:${banner[1]}`;
  const token = signJwt({ tenant_id: "tenant-a", sub: "e2e" }, SECRET);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let id = 0;
  const envelope = (method: string, params: unknown): string =>
    JSON.stringify({ protocol: "crewhaus.v1", id: `req-${++id}`, method, params });
  return {
    call: async (method, params) => {
      const res = await fetch(base, { method: "POST", headers, body: envelope(method, params) });
      const body = (await res.json()) as Record<string, unknown>;
      if (body["error"] !== undefined) throw new Error(JSON.stringify(body["error"]));
      return body["result"] as Record<string, unknown>;
    },
    subscribe: async (runId, until) => {
      const ac = new AbortController();
      const res = await fetch(base, {
        method: "POST",
        headers,
        body: envelope("runs.subscribe", { runId }),
        signal: ac.signal,
      });
      if (res.body === null) throw new Error("runs.subscribe returned no stream");
      try {
        return (await waitFor(res.body, until, 30_000))[0];
      } finally {
        ac.abort();
      }
    },
    modelCalls: model.calls,
    maxInFlight: model.maxInFlight,
  };
}

describe("managed — `proof` on the gateway result envelope (0.8.0 §5.4)", () => {
  test(
    "render: footer — proof on runs.create, the footer on reply, the trace line on runs.subscribe, the bundle on a cached resume",
    async () => {
      const daemon = await boot(baseIr(PROVABILITY));

      // A cited answer: the gate passes it at `cited`.
      const created = await daemon.call("runs.create", {
        spec: "proof-envelope",
        input: "refunds?",
      });
      const parsed = RunsCreateResult.parse(created);
      expect(parsed.proof).toBeDefined();
      expect(parsed.proof?.level).toBe("cited");
      expect(parsed.proof?.verdict).toBe("pass");
      expect(parsed.proof?.claimCount).toBe(1);
      expect(parsed.proof?.claims[0]?.bindings[0]?.origin).toBe("https://acme.example/policy");
      expect(parsed.reply?.startsWith(CITED)).toBe(true);
      expect(parsed.reply).toContain("── provability · cited ✓ · 1/1 claim");
      // The footer names the tenant-fenced bundle file the gate persisted.
      expect(parsed.reply).toContain("turn-");

      // The SSE stream replays the run's trace, the gate's line included.
      const frame = await daemon.subscribe(
        parsed.runId,
        /data: (\{[^\n]*"kind":"provability_graded"[^\n]*\})/,
      );
      const graded = JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>;
      expect(graded["verdict"]).toBe("pass");
      expect(graded["bundleHash"]).toBe(parsed.proof?.bundleHash);

      // An uncited answer under `on_fail: note`: it still answers, failing.
      const failed = RunsCreateResult.parse(
        await daemon.call("runs.create", { spec: "proof-envelope", input: "uncited please" }),
      );
      expect(failed.proof?.verdict).toBe("fail");
      expect(failed.proof?.unmet).toBe(1);
      expect(failed.proof?.claims[0]?.status).toBe("unmet");
      expect(failed.reply).toContain("── provability · cited ✗");

      // The resume path: a second identical `runs.continue` is a duplicate
      // the idempotency store answers — same reply, same bundle, no model call.
      const first = RunsContinueResult.parse(
        await daemon.call("runs.continue", { sessionId: parsed.sessionId, input: "and returns?" }),
      );
      expect(first.proof?.verdict).toBe("pass");
      const callsAfterFirst = daemon.modelCalls();
      const again = RunsContinueResult.parse(
        await daemon.call("runs.continue", { sessionId: parsed.sessionId, input: "and returns?" }),
      );
      expect(daemon.modelCalls()).toBe(callsAfterFirst);
      expect(again.reply).toBe(first.reply);
      expect(again.proof?.bundleHash).toBe(first.proof?.bundleHash);
    },
    BOOT_TIMEOUT_MS + 60_000,
  );

  test(
    "concurrent runs: each envelope carries its OWN run's bundle, not the last one graded",
    async () => {
      const daemon = await boot(baseIr(PROVABILITY));
      // The slow run starts first and is graded last. The gate is wired once
      // for the process, so an observer installed on that shared wiring (the
      // later run's replacing the earlier's) would send the slow run's bundle
      // to the fast run's observer and leave the slow run with none.
      const slowCall = daemon.call("runs.create", {
        spec: "proof-envelope",
        input: "slow, uncited please",
      });
      await Bun.sleep(SLOW_MS / 4);
      const fast = RunsCreateResult.parse(
        await daemon.call("runs.create", { spec: "proof-envelope", input: "refunds?" }),
      );
      const slow = RunsCreateResult.parse(await slowCall);
      expect(daemon.maxInFlight()).toBeGreaterThanOrEqual(2);

      expect(fast.reply?.startsWith(CITED)).toBe(true);
      expect(fast.reply).toContain("── provability · cited ✓");
      expect(fast.proof?.verdict).toBe("pass");
      expect(fast.proof?.claims[0]?.text).toBe("Refunds are accepted within 14 days of purchase.");

      expect(slow.reply?.startsWith(UNCITED)).toBe(true);
      expect(slow.reply).toContain("── provability · cited ✗");
      expect(slow.proof?.verdict).toBe("fail");
      expect(slow.proof?.claims[0]?.text).toBe(UNCITED);
      expect(slow.proof?.bundleHash).not.toBe(fast.proof?.bundleHash);
    },
    BOOT_TIMEOUT_MS + 60_000,
  );

  test(
    "render: none — no footer on reply, the bundle still on the envelope",
    async () => {
      const daemon = await boot(baseIr({ ...PROVABILITY, render: "none" }));
      const created = RunsCreateResult.parse(
        await daemon.call("runs.create", { spec: "proof-envelope", input: "refunds?" }),
      );
      expect(created.reply).toBe(CITED);
      expect(created.proof?.verdict).toBe("pass");
    },
    BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    "no provability: block — the envelope carries no `proof` key at all",
    async () => {
      const daemon = await boot(baseIr(undefined));
      const created = await daemon.call("runs.create", {
        spec: "proof-envelope",
        input: "refunds?",
      });
      expect("proof" in created).toBe(false);
      expect(created["reply"]).toBe(CITED);
      expect(RunsCreateResult.parse(created).proof).toBeUndefined();
    },
    BOOT_TIMEOUT_MS + 30_000,
  );
});
