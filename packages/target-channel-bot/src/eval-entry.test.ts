/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * an added `eval-entry.ts` that loopback-delivers one inbound message through
 * the bot's REAL `createAgent().runTurn` path, pre-seeding sample history into
 * the session transcript.
 *
 * The option is INERT when off. session-router/gateway/daemon are untouched in
 * BOTH variants; `agent.ts` gains exactly the two eval-bridge seams
 * (`fabricRoot` + `_adapter` on `AgentConfig`, and the `_adapter` spread into
 * runChatLoop) and nothing else — gated the same way the workflow/graph/
 * pipeline emitters gate theirs, so the plain emission stays byte-identical
 * for the 0.3.0 `continuity: false` byte-restore contract
 * (`packages/compiler/src/continuity-byte-restore.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { IrChannelV0 } from "@crewhaus/ir";
import { emitChannelBot } from "./index";

const MIN_IR: IrChannelV0 = {
  version: 0,
  name: "demo",
  target: "channel",
  agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
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
};

const entryOf = (ir: IrChannelV0): string =>
  emitChannelBot(ir, { evalEntry: true }).files.find((f) => f.path === "eval-entry.ts")?.content ??
  "";

const agentOf = (ir: IrChannelV0, opts: { evalEntry?: boolean } = {}): string =>
  emitChannelBot(ir, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";

/** The EXACT `AgentConfig` seam block the eval-entry variant adds (and the
 *  plain emission must not carry) — pinned here so a drift in either
 *  direction fails loudly rather than silently re-breaking the byte-restore
 *  fixtures. */
const SEAM_FIELDS = `
  // Cluster S (D36/NEW-shape-1) — the per-turn memory/continuity fabric root.
  // The daemon leaves it unset (process.cwd(), the deployed posture); the eval
  // bridge entry pins it to the runner's per-sample directory so a bridged
  // eval keeps the Pillar-2 isolation invariant (no fact/plan/handoff leak
  // between samples, nothing written into the operator's working tree).
  fabricRoot?: string;
  // Cluster S — scripted-provider test seam (the same \`_adapter\` the other
  // bridged entries expose), so bridge smoke tests drive the REAL runTurn
  // credential-free. Never set by the daemon.
  _adapter?: Parameters<typeof runChatLoop>[0]["_adapter"];`;

/** The one runChatLoop spread that forwards the scripted provider. */
const SEAM_SPREAD = `
        ...(config._adapter !== undefined ? { _adapter: config._adapter } : {}),`;

describe("emitChannelBot — evalEntry off is byte-identical (back-compat pin)", () => {
  test("omitted, {} and evalEntry: false all emit the same files", () => {
    const files = (b: ReturnType<typeof emitChannelBot>) =>
      new Map(b.files.map((f) => [f.path, f.content]));
    const a = files(emitChannelBot(MIN_IR));
    const b = files(emitChannelBot(MIN_IR, {}));
    const c = files(emitChannelBot(MIN_IR, { evalEntry: false }));
    expect(a.has("eval-entry.ts")).toBe(false);
    for (const [path, content] of a) {
      expect(b.get(path)).toBe(content);
      expect(c.get(path)).toBe(content);
    }
  });
});

describe("emitChannelBot — evalEntry variant (cluster S)", () => {
  test("adds eval-entry.ts; session-router/gateway/daemon stay byte-identical", () => {
    const plain = new Map(emitChannelBot(MIN_IR).files.map((f) => [f.path, f.content]));
    const withEntry = new Map(
      emitChannelBot(MIN_IR, { evalEntry: true }).files.map((f) => [f.path, f.content]),
    );
    expect(withEntry.has("eval-entry.ts")).toBe(true);
    for (const [path, content] of plain) {
      if (path === "agent.ts") continue; // covered by the seam-delta test below
      expect(withEntry.get(path)).toBe(content);
    }
  });

  test("agent.ts gains ONLY the two eval-bridge seams (plain stays pre-cluster-S)", () => {
    const plain = agentOf(MIN_IR);
    const withEntry = agentOf(MIN_IR, { evalEntry: true });

    // The plain emission carries NO cluster-S plumbing at all — this is what
    // the `continuity: false` byte-restore fixtures pin.
    expect(plain).not.toContain("fabricRoot");
    expect(plain).not.toContain("_adapter");

    // Deleting exactly the two known additions restores the plain bytes —
    // proof the variant changes nothing else in agent.ts.
    expect(withEntry).toContain(SEAM_FIELDS);
    expect(withEntry).toContain(SEAM_SPREAD);
    expect(withEntry.replace(SEAM_FIELDS, "").replace(SEAM_SPREAD, "")).toBe(plain);
  });

  test("the memory fabric roots at fabricRoot ONLY in the eval-entry variant", () => {
    // With continuity on, the per-turn wireMemory call takes a cwd. The
    // deployed daemon posture is process.cwd(); the bridged eval re-roots it
    // per sample — and the plain bundle must not even mention the seam.
    const ir: IrChannelV0 = { ...MIN_IR, continuity: { enabled: true } };
    expect(agentOf(ir)).toContain("cwd: process.cwd(),");
    expect(agentOf(ir)).not.toContain("fabricRoot");
    expect(agentOf(ir, { evalEntry: true })).toContain("cwd: config.fabricRoot ?? process.cwd(),");
  });

  test("the eval-entry agent.ts is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(agentOf(MIN_IR, { evalEntry: true }))).not.toThrow();
    expect(() =>
      t.transformSync(agentOf({ ...MIN_IR, continuity: { enabled: true } }, { evalEntry: true })),
    ).not.toThrow();
  });

  test("the loopback drives the REAL runTurn path (fresh session per sample)", () => {
    const entry = entryOf(MIN_IR);
    expect(entry).toContain('import { createAgent, type AgentConfig } from "./agent.ts";');
    expect(entry).toContain("export async function runForEval(");
    expect(entry).toContain("agent.runTurn({");
    expect(entry).toContain("isNew: __history.length === 0,");
    // The prompt-cache stamp is a no-op store for one-shot eval turns.
    expect(entry).toContain("promptCacheStore: { read: async () => undefined,");
    // Per-sample isolation: the memory/continuity fabric roots at the sample
    // dir, never the operator's cwd (Pillar 2).
    expect(entry).toContain("{ fabricRoot: __evalOpts.sessionRootDir }");
    // The scripted-provider seam every bridged entry exposes.
    expect(entry).toContain('_adapter?: AgentConfig["_adapter"];');
  });

  test("sample history pre-seeds the session transcript in runtime-core's replay shape", () => {
    const entry = entryOf(MIN_IR);
    expect(entry).toContain('kind: __m.role === "user" ? "user_message" : "assistant_message",');
    expect(entry).toContain("payload: { content: __m.content },");
    expect(entry).toContain('import { openEventLog } from "@crewhaus/event-log";');
  });

  test("a seeded history also creates the session RECORD the resume path reads", () => {
    // `isNew: false` makes runChatLoop call sessionStore.get(id) BEFORE it
    // replays the log; an event log without its `<id>.json` record throws
    // `cannot --resume ...: session not found`, killing every history-carrying
    // sample before any model call.
    const entry = entryOf(MIN_IR);
    expect(entry).toContain('import { createSessionStore } from "@crewhaus/session-store";');
    expect(entry).toContain("if ((await __store.get(__sessionId)) === null) {");
    expect(entry).toContain("await __store.create({");
    expect(entry).toContain('target: "channel",');
  });

  test("declared built-in tools register onto the catalog the agent snapshots", () => {
    const ir: IrChannelV0 = { ...MIN_IR, tools: ["read", "grep"] };
    const entry = entryOf(ir);
    expect(entry).toContain('import { grep, read } from "@crewhaus/tool-fs";');
    expect(entry).toContain("defaultCatalog.register(read);");
    expect(entry).toContain("defaultCatalog.register(grep);");
  });

  test("mcp_servers declared ⇒ a generated honesty note (not booted in this slice)", () => {
    const ir: IrChannelV0 = {
      ...MIN_IR,
      mcp_servers: { db: { transport: "stdio", command: "bun", args: ["db.ts"] } },
    };
    expect(entryOf(ir)).toContain("mcp_servers declared but not booted by the eval bridge entry");
    expect(entryOf(MIN_IR)).not.toContain("mcp_servers declared but not booted");
  });

  test("eval-entry.ts is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(entryOf(MIN_IR))).not.toThrow();
  });
});
