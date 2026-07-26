/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * purely ADDITIVE `eval-entry.ts` (agent/session-router/gateway/daemon stay
 * byte-identical) that loopback-delivers one inbound message through the
 * bot's REAL `createAgent().runTurn` path, pre-seeding sample history into
 * the session transcript.
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
  test("adds eval-entry.ts WITHOUT touching the other files (additive)", () => {
    const plain = new Map(emitChannelBot(MIN_IR).files.map((f) => [f.path, f.content]));
    const withEntry = new Map(
      emitChannelBot(MIN_IR, { evalEntry: true }).files.map((f) => [f.path, f.content]),
    );
    expect(withEntry.has("eval-entry.ts")).toBe(true);
    for (const [path, content] of plain) {
      expect(withEntry.get(path)).toBe(content);
    }
  });

  test("the loopback drives the REAL runTurn path (fresh session per sample)", () => {
    const entry = entryOf(MIN_IR);
    expect(entry).toContain('import { createAgent } from "./agent.ts";');
    expect(entry).toContain("export async function runForEval(");
    expect(entry).toContain("agent.runTurn({");
    expect(entry).toContain("isNew: __history.length === 0,");
    // The prompt-cache stamp is a no-op store for one-shot eval turns.
    expect(entry).toContain("promptCacheStore: { read: async () => undefined,");
  });

  test("sample history pre-seeds the session transcript in runtime-core's replay shape", () => {
    const entry = entryOf(MIN_IR);
    expect(entry).toContain('kind: __m.role === "user" ? "user_message" : "assistant_message",');
    expect(entry).toContain("payload: { content: __m.content },");
    expect(entry).toContain('import { openEventLog } from "@crewhaus/event-log";');
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
