/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.4, §8) — the channel bot's
 * proof footer, compiled and RUN.
 *
 * `index.test.ts` pins that the emitted `runTurn` wires the gate with
 * `footerTarget: "reply"`; this runs that emitted `createAgent().runTurn`
 * for real — the generated `agent.ts` beside a `node_modules/@crewhaus/*`
 * link farm, driven in a subprocess against a loopback fake of the Messages
 * API — and checks the one claim the text cannot make: the reply the bot
 * would SEND carries the gate's one-line footer after the answer, a failing
 * `note` verdict carries its ✗, and `provability.render: none` sends the
 * answer alone while the bundle is still graded and persisted. Two more
 * claims only a run can make: a thread's later messages (resumed runs) each
 * file their own bundle and footer (§5.3), and the eval bridge entry hands
 * the runner the answer alone — the text graders score (§9.1).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IrChannelV0 } from "@crewhaus/ir";
import { emitChannelBot } from "./index.js";

const RUN_TIMEOUT_MS = 90_000;
const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

const PROVABILITY: NonNullable<IrChannelV0["provability"]> = {
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

const irWith = (provability: IrChannelV0["provability"]): IrChannelV0 => ({
  version: 0,
  name: "footer-bot",
  target: "channel",
  agent: { model: "claude-sonnet-4-6", instructions: "Answer with a cited sentence." },
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
  subAgents: [],
  compaction: {},
  ...(provability !== undefined ? { provability } : {}),
});

const CITED =
  "Refunds are accepted within 14 days of purchase [1].\n\n[1]: https://acme.example/policy";
const UNCITED = "Refunds are accepted within 14 days of purchase at every Acme store.";

/** Runs the emitted agent's runTurn twice — a cited and an uncited answer — and prints the replies. */
const DRIVER = `
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createPendingApprovalStore } from "@crewhaus/runtime-core";
import { createAgent } from "./agent.ts";

const root = process.cwd();
const agent = createAgent({
  hooks: [],
  skills: [],
  slashCommands: new Map(),
  tools: [],
  sessionRootDir: join(root, "sessions"),
  promptCacheStore: { read: async () => undefined, write: async () => {} },
  runtimeApprovals: createPendingApprovalStore({ rootDir: join(root, "approvals") }),
});
const cited = await agent.runTurn({ sessionId: "sess_00000000000000a1", isNew: true, message: "refunds?" });
const uncited = await agent.runTurn({ sessionId: "sess_00000000000000a2", isNew: true, message: "uncited please" });
const proofs = join(root, ".crewhaus", "proofs", "footer-bot");
let bundles = 0;
try {
  for (const session of readdirSync(proofs)) bundles += readdirSync(join(proofs, session)).length;
} catch {}
// The turn streams the answer to stdout as it runs; the result goes after a marker.
process.stdout.write(\`\\n@@result@@\${JSON.stringify({ cited, uncited, bundles })}\`);
`;

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

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

function startModel(): number {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages"))
        return new Response("", { status: 404 });
      const body = JSON.stringify(await req.json());
      return new Response(sseText(body.includes("uncited") ? UNCITED : CITED), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return server.port as number;
}

/** Runs `driver` beside the emitted bot (every file of it) and returns what it printed. */
async function runDriver<T>(
  ir: IrChannelV0,
  driver: string,
  emitOpts: { readonly evalEntry?: boolean } = {},
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-channel-footer-"));
  dirs.push(root);
  const files = emitChannelBot(ir, emitOpts).files;
  if (!files.some((f) => f.path === "agent.ts")) throw new Error("no agent.ts emitted");
  for (const file of files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  writeFileSync(join(root, "driver.ts"), driver);
  const scope = join(root, "node_modules", "@crewhaus");
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(join(REPO_ROOT, "packages"))) {
    try {
      symlinkSync(join(REPO_ROOT, "packages", name), join(scope, name), "dir");
    } catch {
      // Already linked.
    }
  }
  const port = startModel();
  const proc = Bun.spawn({
    cmd: [process.execPath, join(root, "driver.ts")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      ANTHROPIC_API_KEY: ["sk", "ant", "e2e", "0".repeat(12)].join("-"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CREWHAUS_NO_REGISTRY: "1",
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
    },
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const at = out.lastIndexOf("@@result@@");
  if (at === -1) throw new Error(`driver produced no result; stderr:\n${err}\nstdout:\n${out}`);
  return JSON.parse(out.slice(at + "@@result@@".length)) as T;
}

function runTurns(
  ir: IrChannelV0,
): Promise<{ readonly cited: string; readonly uncited: string; readonly bundles: number }> {
  return runDriver(ir, DRIVER);
}

/** Two messages in ONE thread: the second resumes the session, with a fresh run context. */
const THREAD_DRIVER = `
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createPendingApprovalStore } from "@crewhaus/runtime-core";
import { createAgent } from "./agent.ts";

const root = process.cwd();
const agent = createAgent({
  hooks: [],
  skills: [],
  slashCommands: new Map(),
  tools: [],
  sessionRootDir: join(root, "sessions"),
  promptCacheStore: { read: async () => undefined, write: async () => {} },
  runtimeApprovals: createPendingApprovalStore({ rootDir: join(root, "approvals") }),
});
const first = await agent.runTurn({ sessionId: "sess_00000000000000a1", isNew: true, message: "refunds?" });
const second = await agent.runTurn({ sessionId: "sess_00000000000000a1", isNew: false, message: "uncited please" });
let files = [];
try {
  files = readdirSync(join(root, ".crewhaus", "proofs", "footer-bot", "sess_00000000000000a1")).sort();
} catch {}
process.stdout.write(\`\\n@@result@@\${JSON.stringify({ first, second, files })}\`);
`;

/** The eval bridge entry, as the runner drives it: one sample, its own directory. */
const EVAL_DRIVER = `
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runForEval } from "./eval-entry.ts";

const sample = join(process.cwd(), "samples", "s1");
const output = await runForEval("refunds?", { sessionRootDir: sample });
let bundles = 0;
try {
  const proofs = join(sample, ".crewhaus", "proofs", "footer-bot");
  for (const session of readdirSync(proofs)) bundles += readdirSync(join(proofs, session)).length;
} catch {}
process.stdout.write(\`\\n@@result@@\${JSON.stringify({ output, bundles })}\`);
`;

describe("channel — the proof footer rides the reply the bot sends (0.8.0 §5.4)", () => {
  test(
    "render: footer — the ✓ line after a passing answer, the ✗ line after a failing note",
    async () => {
      const r = await runTurns(irWith(PROVABILITY));
      expect(r.cited.startsWith(`${CITED}\n\n── provability · cited ✓ · 1/1 claim`)).toBe(true);
      // One line, after a blank line, naming the persisted bundle.
      expect(r.cited.slice(CITED.length).split("\n")).toHaveLength(3);
      expect(r.cited).toContain("footer-bot/sess_00000000000000a1/turn-");
      expect(r.uncited.startsWith(`${UNCITED}\n\n── provability · cited ✗ · 0/1 claim`)).toBe(true);
      expect(r.uncited).toContain("1 uncited");
      expect(r.bundles).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "render: none — the answer alone, the bundles still graded and persisted",
    async () => {
      const r = await runTurns(irWith({ ...PROVABILITY, render: "none" }));
      expect(r.cited).toBe(CITED);
      expect(r.uncited).toBe(UNCITED);
      expect(r.bundles).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "no provability: block — the reply is the answer, and nothing is persisted",
    async () => {
      const r = await runTurns(irWith(undefined));
      expect(r.cited).toBe(CITED);
      expect(r.bundles).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("channel — a thread's later messages and the eval bridge (0.8.0 §5.3, §9.1)", () => {
  test(
    "two messages in one thread: each files its own bundle, and each footer names its own turn",
    async () => {
      const r = await runDriver<{ first: string; second: string; files: string[] }>(
        irWith(PROVABILITY),
        THREAD_DRIVER,
      );
      expect(r.first).toContain("cited ✓");
      expect(r.first).toEndWith("footer-bot/sess_00000000000000a1/turn-1.json");
      expect(r.second).toContain("cited ✗");
      expect(r.second).toEndWith("footer-bot/sess_00000000000000a1/turn-2.json");
      expect(r.files).toEqual(["turn-1.json", "turn-2.json"]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "the eval bridge entry hands the runner the answer alone — no footer for a grader to score — while the bundle is still graded",
    async () => {
      const r = await runDriver<{ output: string; bundles: number }>(
        irWith(PROVABILITY),
        EVAL_DRIVER,
        { evalEntry: true },
      );
      expect(r.output).toBe(CITED);
      expect(r.bundles).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );
});
