import { describe, expect, test } from "bun:test";
import { createLogger } from "@crewhaus/logging";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  type AgentIdentity,
  DATA_LINEAGE_CAP,
  createRunContext,
  formatAgentIdentity,
  pushOrigin,
  tagContent,
} from "./index";

describe("createRunContext defaults", () => {
  test("generates run/session ids with expected prefixes", () => {
    const ctx = createRunContext();
    expect(ctx.runId).toMatch(/^run_[0-9a-f]{8}$/);
    // session-store path-traversal guard requires sess_<16 hex>; the
    // default factory matches that format so runtime-core can hand the
    // id straight to sessionStore.create({ id }).
    expect(ctx.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  test("starts turnNumber at 0", () => {
    const ctx = createRunContext();
    expect(ctx.turnNumber).toBe(0);
  });

  test("turnNumber is mutable in place", () => {
    const ctx = createRunContext();
    ctx.turnNumber += 1;
    expect(ctx.turnNumber).toBe(1);
  });

  test("default abortSignal is not aborted", () => {
    const ctx = createRunContext();
    expect(ctx.abortSignal.aborted).toBe(false);
  });

  test("two contexts get different run/session ids", () => {
    const a = createRunContext();
    const b = createRunContext();
    expect(a.runId).not.toBe(b.runId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("logger child binds runId/sessionId on every log line", () => {
    const lines: string[] = [];
    const logger = createLogger({
      format: "json",
      sink: (line) => {
        lines.push(line);
      },
    });
    const ctx = createRunContext({ logger });
    ctx.logger.info("hello");
    expect(lines.length).toBe(1);
    const line = lines[0];
    if (line === undefined) throw new Error("expected a log line");
    const parsed = JSON.parse(line);
    expect(parsed.runId).toBe(ctx.runId);
    expect(parsed.sessionId).toBe(ctx.sessionId);
    expect(parsed.msg).toBe("hello");
  });
});

describe("createRunContext overrides", () => {
  test("custom runId/sessionId pass through verbatim", () => {
    const ctx = createRunContext({ runId: "run_custom", sessionId: "sess_custom" });
    expect(ctx.runId).toBe("run_custom");
    expect(ctx.sessionId).toBe("sess_custom");
  });

  test("custom abortSignal is exposed", () => {
    const ac = new AbortController();
    const ctx = createRunContext({ abortSignal: ac.signal });
    expect(ctx.abortSignal.aborted).toBe(false);
    ac.abort();
    expect(ctx.abortSignal.aborted).toBe(true);
  });
});

describe("createRunContext eventBus", () => {
  test("default eventBus carries the run/session ids", () => {
    const ctx = createRunContext();
    expect(ctx.eventBus).toBeInstanceOf(TraceEventBus);
    expect(ctx.eventBus.runId).toBe(ctx.runId);
    expect(ctx.eventBus.sessionId).toBe(ctx.sessionId);
  });

  test("custom eventBus is wired through verbatim", () => {
    const bus = new TraceEventBus({ runId: "run_custom", sessionId: "sess_custom" });
    const ctx = createRunContext({ runId: "run_custom", sessionId: "sess_custom", eventBus: bus });
    expect(ctx.eventBus).toBe(bus);
  });
});

describe("pushOrigin", () => {
  test("appends to undefined originStack", () => {
    const ctx = createRunContext();
    const next = pushOrigin(ctx, "subagent");
    expect(next.originStack).toEqual(["subagent"]);
    expect(ctx.originStack).toBeUndefined();
  });

  test("appends to existing originStack without mutating input", () => {
    const ctx = createRunContext({ originStack: ["subagent"] });
    const next = pushOrigin(ctx, "mcp");
    expect(next.originStack).toEqual(["subagent", "mcp"]);
    expect(ctx.originStack).toEqual(["subagent"]);
  });
});

describe("tagContent (Pillar 3 data-lineage)", () => {
  test("lazy-creates dataLineage on first tag", () => {
    const ctx = createRunContext();
    expect(ctx.dataLineage).toBeUndefined();
    tagContent(ctx, "subagent-returned payload of meaningful length", "subagent");
    expect(ctx.dataLineage).toBeInstanceOf(Map);
    expect(ctx.dataLineage?.size).toBe(1);
  });

  test("records origin per tagged string", () => {
    const ctx = createRunContext();
    tagContent(ctx, "first tagged string from a subagent return", "subagent");
    tagContent(ctx, "second tagged string from an MCP tool result", "mcp");
    expect(ctx.dataLineage?.get("first tagged string from a subagent return")).toBe("subagent");
    expect(ctx.dataLineage?.get("second tagged string from an MCP tool result")).toBe("mcp");
  });

  test("ignores content shorter than 16 chars (egress-floor parity)", () => {
    const ctx = createRunContext();
    tagContent(ctx, "tiny", "subagent");
    expect(ctx.dataLineage).toBeUndefined();
  });

  test("re-tagging refreshes recency (most-recent insertion order)", () => {
    const ctx = createRunContext();
    tagContent(ctx, "first string of taggable length here", "subagent");
    tagContent(ctx, "second string of taggable length here", "mcp");
    tagContent(ctx, "first string of taggable length here", "subagent"); // refresh
    const keys = [...(ctx.dataLineage?.keys() ?? [])];
    // After refresh, "first..." should be the most-recent (last in iteration).
    expect(keys[keys.length - 1]).toBe("first string of taggable length here");
  });

  test("evicts oldest beyond DATA_LINEAGE_CAP", () => {
    const ctx = createRunContext();
    for (let i = 0; i < DATA_LINEAGE_CAP + 5; i++) {
      tagContent(ctx, `tagged string number ${i.toString().padStart(4, "0")} payload`, "subagent");
    }
    expect(ctx.dataLineage?.size).toBe(DATA_LINEAGE_CAP);
    // The first 5 should have been evicted.
    expect(ctx.dataLineage?.has("tagged string number 0000 payload")).toBe(false);
    expect(ctx.dataLineage?.has("tagged string number 0004 payload")).toBe(false);
    expect(ctx.dataLineage?.has("tagged string number 0005 payload")).toBe(true);
  });

  test("ignores non-string input gracefully", () => {
    const ctx = createRunContext();
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    tagContent(ctx, 123 as any, "subagent");
    expect(ctx.dataLineage).toBeUndefined();
  });
});

describe("formatAgentIdentity", () => {
  test("undefined identity renders as <top-level>", () => {
    expect(formatAgentIdentity(undefined)).toBe("<top-level>");
  });

  test("empty identity object renders as <top-level>", () => {
    expect(formatAgentIdentity({})).toBe("<top-level>");
  });

  test("renders a single skillId field", () => {
    expect(formatAgentIdentity({ skillId: "code-review" })).toBe("skill=code-review");
  });

  test("renders a single subAgentId field", () => {
    expect(formatAgentIdentity({ subAgentId: "sub-7" })).toBe("subagent=sub-7");
  });

  test("renders a single roleId field", () => {
    expect(formatAgentIdentity({ roleId: "reviewer" })).toBe("role=reviewer");
  });

  test("joins all present fields in skill;subagent;role order", () => {
    const id: AgentIdentity = { skillId: "s1", subAgentId: "a1", roleId: "r1" };
    expect(formatAgentIdentity(id)).toBe("skill=s1;subagent=a1;role=r1");
  });

  test("omits undefined fields while keeping order for the rest", () => {
    expect(formatAgentIdentity({ skillId: "s1", roleId: "r1" })).toBe("skill=s1;role=r1");
  });
});
