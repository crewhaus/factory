/**
 * Tests for the Remember + Recall tools. The underlying memory-store
 * is tested in @crewhaus/memory-store; here we focus on the tool
 * surface (schemas, execute outputs, flags).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTools } from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tool-memory-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createMemoryTools — Remember", () => {
  test("returns a destructive tool named 'Remember'", () => {
    const { remember } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(remember.name).toBe("Remember");
    expect(remember.destructive).toBe(true);
    expect(remember.readOnly).toBe(false);
  });

  test("execute persists the memory and returns confirmation", async () => {
    const { remember, store } = createMemoryTools({ specName: "s", rootDir: tmp });
    const result = await remember.execute({
      text: "the user's birthday is March 15",
    });
    expect(result).toContain("remembered (mem_");
    expect(result).toContain("the user's birthday is March 15");
    expect(await store.size()).toBe(1);
  });

  test("execute renders tags as a suffix in the confirmation", async () => {
    const { remember } = createMemoryTools({ specName: "s", rootDir: tmp });
    const result = await remember.execute({
      text: "anniversary on June 1",
      tags: ["personal", "important"],
    });
    expect(result).toContain("[personal, important]");
  });

  test("schema validates text presence (zod rejects empty)", () => {
    const { remember } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(() => remember.inputSchema.parse({ text: "" })).toThrow();
  });
});

describe("createMemoryTools — Recall", () => {
  test("returns a read-only tool named 'Recall'", () => {
    const { recall } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(recall.name).toBe("Recall");
    expect(recall.readOnly).toBe(true);
    expect(recall.destructive).toBe(false);
  });

  test("recall returns 'no memories' message when empty", async () => {
    const { recall } = createMemoryTools({ specName: "s", rootDir: tmp });
    const out = await recall.execute({ query: "anything" });
    expect(out).toContain("no memories matched");
    expect(out).toContain("store size: 0");
  });

  test("recall lists matches ordered by score", async () => {
    const { remember, recall } = createMemoryTools({ specName: "s", rootDir: tmp });
    await remember.execute({ text: "the user prefers TypeScript" });
    await remember.execute({ text: "we discussed Python yesterday" });
    await remember.execute({ text: "TypeScript is the user's daily driver" });
    const out = await recall.execute({ query: "TypeScript" });
    expect(out).toContain("memory match(es)");
    expect(out).toContain("TypeScript");
    expect(out).not.toContain("Python");
  });

  test("k parameter caps the listed matches", async () => {
    const { remember, recall } = createMemoryTools({ specName: "s", rootDir: tmp });
    for (let i = 0; i < 5; i++) {
      await remember.execute({ text: `note ${i} about coffee` });
    }
    const out = await recall.execute({ query: "coffee", k: 2 });
    expect((out.match(/•/g) ?? []).length).toBe(2);
  });

  test("recall schema validates k bounds", () => {
    const { recall } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(() => recall.inputSchema.parse({ query: "q", k: 0 })).toThrow();
    expect(() => recall.inputSchema.parse({ query: "q", k: 51 })).toThrow();
    expect(() => recall.inputSchema.parse({ query: "q", k: 5 })).not.toThrow();
  });
});

describe("createMemoryTools — Remember ttlDays (v2)", () => {
  test("ttlDays sets an expiry and is echoed in the confirmation", async () => {
    const { remember, store } = createMemoryTools({ specName: "s", rootDir: tmp });
    const out = await remember.execute({ text: "conference badge pickup code 4411", ttlDays: 7 });
    expect(out).toContain("expires ");
    const [item] = await store.list();
    expect(item?.entry.expiresAt).toBeGreaterThan(Date.now());
  });

  test("ttlDays schema bounds", () => {
    const { remember } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(() => remember.inputSchema.parse({ text: "t", ttlDays: 0 })).toThrow();
    expect(() => remember.inputSchema.parse({ text: "t", ttlDays: 4000 })).toThrow();
    expect(() => remember.inputSchema.parse({ text: "t", ttlDays: 30 })).not.toThrow();
  });
});

describe("createMemoryTools — MemoryForget (v2)", () => {
  test("is destructive AND justification-gated", () => {
    const { forget } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(forget.name).toBe("MemoryForget");
    expect(forget.destructive).toBe(true);
    expect(forget.requireJustification).toBe(true);
    expect(forget.readOnly).toBe(false);
  });

  test("forgets by exact id and echoes the reason", async () => {
    const { remember, forget, store } = createMemoryTools({ specName: "s", rootDir: tmp });
    const confirmation = await remember.execute({ text: "the office wifi password is rotating" });
    const id = /\((mem_[0-9a-f]{16})\)/.exec(confirmation)?.[1] as string;
    const out = await forget.execute({ id, reason: "password rotated" });
    expect(out).toContain("forgot 1 memory(ies) — password rotated:");
    expect(out).toContain(id);
    expect(await store.size()).toBe(0);
  });

  test("forgets every match of a query", async () => {
    const { remember, forget, store } = createMemoryTools({ specName: "s", rootDir: tmp });
    await remember.execute({ text: "coffee order: flat white" });
    await remember.execute({ text: "coffee budget is $40" });
    await remember.execute({ text: "tea drawer is stocked" });
    const out = await forget.execute({ query: "coffee" });
    expect(out).toContain("forgot 2 memory(ies)");
    expect(await store.size()).toBe(1);
  });

  test("requires exactly one of id/query", async () => {
    const { forget } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(await forget.execute({})).toContain("exactly one of");
    expect(await forget.execute({ id: "mem_0123456789abcdef", query: "also a query" })).toContain(
      "exactly one of",
    );
  });

  test("reports when nothing matched", async () => {
    const { forget } = createMemoryTools({ specName: "s", rootDir: tmp });
    const out = await forget.execute({ id: "mem_ffffffffffffffff" });
    expect(out).toContain("nothing to forget");
  });

  test("id schema rejects non-mem ids", () => {
    const { forget } = createMemoryTools({ specName: "s", rootDir: tmp });
    expect(() => forget.inputSchema.parse({ id: "not-an-id" })).toThrow();
    expect(() => forget.inputSchema.parse({ id: "mem_0123456789abcdef" })).not.toThrow();
  });
});
