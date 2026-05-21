import { describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { ToolUseBlock } from "@crewhaus/turn-state-machine";
import { isConcurrencySafe, partitionToolCalls } from "./index";

// Minimal RegisteredTool factory for tests. The orchestrator never invokes
// `inputSchema` or `execute`, so we don't pull zod in just to satisfy types.
function makeTool(overrides: Partial<RegisteredTool> & { name: string }): RegisteredTool {
  return {
    description: "test",
    inputSchema: undefined as unknown as RegisteredTool["inputSchema"],
    execute: async () => "ok",
    concurrencySafe: false,
    readOnly: false,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    scope: "internal",
    requireJustification: false,
    ...overrides,
  };
}

function call(
  name: string,
  id = `tu_${name}_${Math.random().toString(36).slice(2, 6)}`,
): ToolUseBlock {
  return { id, name, input: {} };
}

const READ = makeTool({ name: "Read", concurrencySafe: true, readOnly: true });
const GLOB = makeTool({ name: "Glob", concurrencySafe: true, readOnly: true });
const BASH = makeTool({ name: "Bash", destructive: true });
const WRITE = makeTool({ name: "Write", destructive: true });
const READ_BUT_DESTRUCTIVE = makeTool({
  name: "Sketchy",
  concurrencySafe: true,
  readOnly: true,
  destructive: true, // destructive overrides the others
});

const lookup = (name: string): RegisteredTool | undefined =>
  ({ Read: READ, Glob: GLOB, Bash: BASH, Write: WRITE, Sketchy: READ_BUT_DESTRUCTIVE })[name];

describe("isConcurrencySafe", () => {
  test("requires all three flags aligned", () => {
    expect(isConcurrencySafe(READ)).toBe(true);
    expect(isConcurrencySafe(BASH)).toBe(false);
    expect(isConcurrencySafe(READ_BUT_DESTRUCTIVE)).toBe(false);
    expect(isConcurrencySafe(makeTool({ name: "X", concurrencySafe: true }))).toBe(false);
    expect(isConcurrencySafe(makeTool({ name: "X", readOnly: true }))).toBe(false);
  });
});

describe("partitionToolCalls — basic shapes", () => {
  test("empty input returns empty partition", () => {
    const out = partitionToolCalls([], lookup);
    expect(out.concurrent).toEqual([]);
    expect(out.serial).toEqual([]);
  });

  test("all read-only → one concurrent batch", () => {
    const calls = [call("Read", "1"), call("Read", "2"), call("Glob", "3")];
    const out = partitionToolCalls(calls, lookup);
    expect(out.concurrent.length).toBe(1);
    expect(out.concurrent[0]?.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(out.serial).toEqual([]);
  });

  test("all destructive → all serial, zero concurrent batches", () => {
    const calls = [call("Bash", "1"), call("Write", "2"), call("Bash", "3")];
    const out = partitionToolCalls(calls, lookup);
    expect(out.concurrent).toEqual([]);
    expect(out.serial.map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  test("interleaved read/write splits batches", () => {
    const calls = [
      call("Read", "1"),
      call("Read", "2"),
      call("Bash", "3"),
      call("Glob", "4"),
      call("Write", "5"),
      call("Read", "6"),
    ];
    const out = partitionToolCalls(calls, lookup);
    // Three concurrent batches separated by serial calls: [1,2], [4], [6]
    expect(out.concurrent.length).toBe(3);
    expect(out.concurrent[0]?.map((c) => c.id)).toEqual(["1", "2"]);
    expect(out.concurrent[1]?.map((c) => c.id)).toEqual(["4"]);
    expect(out.concurrent[2]?.map((c) => c.id)).toEqual(["6"]);
    expect(out.serial.map((c) => c.id)).toEqual(["3", "5"]);
  });

  test("destructive flag overrides concurrencySafe + readOnly", () => {
    const calls = [call("Sketchy", "1"), call("Read", "2")];
    const out = partitionToolCalls(calls, lookup);
    expect(out.concurrent.length).toBe(1);
    expect(out.concurrent[0]?.map((c) => c.id)).toEqual(["2"]);
    expect(out.serial.map((c) => c.id)).toEqual(["1"]);
  });

  test("unknown tool name routes serial (fail-closed)", () => {
    const calls = [call("Read", "1"), call("Mystery", "2"), call("Read", "3")];
    const out = partitionToolCalls(calls, lookup);
    expect(out.concurrent.length).toBe(2);
    expect(out.concurrent[0]?.map((c) => c.id)).toEqual(["1"]);
    expect(out.concurrent[1]?.map((c) => c.id)).toEqual(["3"]);
    expect(out.serial.map((c) => c.id)).toEqual(["2"]);
  });
});

describe("partitionToolCalls — accepts ToolCatalog", () => {
  test("works with a Map-shaped lookup function", () => {
    const map = new Map<string, RegisteredTool>([["Read", READ]]);
    const calls = [call("Read", "1")];
    const out = partitionToolCalls(calls, (name) => map.get(name));
    expect(out.concurrent.length).toBe(1);
    expect(out.concurrent[0]?.[0]?.id).toBe("1");
  });
});

// T9 property test: invariant — no concurrent batch contains a call whose
// tool is destructive, !readOnly, or !concurrencySafe.
describe("partitionToolCalls — T9 property invariant", () => {
  function randomBool(rand: () => number): boolean {
    return rand() < 0.5;
  }
  function makeRandomTool(name: string, rand: () => number): RegisteredTool {
    return makeTool({
      name,
      concurrencySafe: randomBool(rand),
      readOnly: randomBool(rand),
      destructive: randomBool(rand),
    });
  }
  function mulberry32(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("100 random partitions never paralyze a destructive or non-safe tool", () => {
    for (let seed = 0; seed < 100; seed++) {
      const rand = mulberry32(seed);
      const numTools = 1 + Math.floor(rand() * 8);
      const toolMap = new Map<string, RegisteredTool>();
      for (let i = 0; i < numTools; i++) {
        const name = `T${i}`;
        toolMap.set(name, makeRandomTool(name, rand));
      }
      const numCalls = Math.floor(rand() * 30);
      const calls: ToolUseBlock[] = [];
      for (let i = 0; i < numCalls; i++) {
        const idx = Math.floor(rand() * numTools);
        const name = `T${idx}`;
        calls.push({ id: `c${i}`, name, input: {} });
      }

      const out = partitionToolCalls(calls, (n) => toolMap.get(n));

      for (const batch of out.concurrent) {
        for (const c of batch) {
          const tool = toolMap.get(c.name);
          expect(tool).toBeDefined();
          if (!tool) continue;
          expect(tool.destructive).toBe(false);
          expect(tool.readOnly).toBe(true);
          expect(tool.concurrencySafe).toBe(true);
        }
      }
      // Every input call appears exactly once in either bucket.
      const total = out.concurrent.flat().length + out.serial.length;
      expect(total).toBe(calls.length);
    }
  });
});
