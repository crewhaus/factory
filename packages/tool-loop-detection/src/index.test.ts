import { describe, expect, test } from "bun:test";
import type { ToolUseBlock } from "@crewhaus/turn-state-machine";
import { detectLoop, toolCallSignature } from "./index";

function call(name: string, input: unknown = {}, id = `tu_${Math.random()}`): ToolUseBlock {
  return { id, name, input };
}

describe("toolCallSignature", () => {
  test("primitives, arrays, and nested objects are canonical", () => {
    expect(toolCallSignature("X", 1)).toBe("X:1");
    expect(toolCallSignature("X", "y")).toBe('X:"y"');
    expect(toolCallSignature("X", true)).toBe("X:true");
    expect(toolCallSignature("X", null)).toBe("X:null");
    expect(toolCallSignature("X", [1, 2, 3])).toBe("X:[1,2,3]");
  });

  test("object key order does not affect signature", () => {
    expect(toolCallSignature("X", { a: 1, b: 2 })).toBe(toolCallSignature("X", { b: 2, a: 1 }));
  });

  test("nested object key order does not affect signature", () => {
    const a = { outer: { a: 1, b: 2 }, list: [{ x: 1, y: 2 }] };
    const b = { list: [{ y: 2, x: 1 }], outer: { b: 2, a: 1 } };
    expect(toolCallSignature("X", a)).toBe(toolCallSignature("X", b));
  });

  test("escaping handles quotes and newlines", () => {
    const sig = toolCallSignature("X", { msg: 'he said "hi"\nthen left' });
    expect(sig).toContain("X:");
    // Round-trip the JSON portion to ensure it parses cleanly.
    const json = sig.slice(2);
    expect(JSON.parse(json)).toEqual({ msg: 'he said "hi"\nthen left' });
  });

  test("name vs input separation", () => {
    expect(toolCallSignature("Foo", { a: 1 })).not.toBe(toolCallSignature("Bar", { a: 1 }));
  });

  test("undefined values collapse to null in canonical form", () => {
    expect(toolCallSignature("X", undefined)).toBe("X:null");
  });
});

describe("detectLoop — basic shapes", () => {
  test("empty history returns null", () => {
    expect(detectLoop([])).toBeNull();
  });

  test("single occurrence with threshold 3 returns null", () => {
    expect(detectLoop([call("A")])).toBeNull();
  });

  test("threshold 3, three identical calls in window → detected", () => {
    const out = detectLoop([
      call("Bash", { command: "date" }),
      call("Bash", { command: "date" }),
      call("Bash", { command: "date" }),
    ]);
    expect(out).not.toBeNull();
    expect(out?.toolName).toBe("Bash");
    expect(out?.count).toBe(3);
    expect(out?.signature).toBe('Bash:{"command":"date"}');
  });

  test("threshold 3, two identical and one different → null", () => {
    const out = detectLoop([call("A"), call("B"), call("A")]);
    expect(out).toBeNull();
  });

  test("interleaved A/B/A/B/A with threshold 3 → detects A", () => {
    const out = detectLoop([call("A"), call("B"), call("A"), call("B"), call("A")]);
    expect(out?.toolName).toBe("A");
    expect(out?.count).toBe(3);
  });

  test("different inputs do not collapse", () => {
    const out = detectLoop([
      call("Read", { path: "a" }),
      call("Read", { path: "b" }),
      call("Read", { path: "c" }),
    ]);
    expect(out).toBeNull();
  });

  test("same call but different object key order → still collapses", () => {
    const out = detectLoop([
      call("Read", { path: "a", limit: 10 }),
      call("Read", { limit: 10, path: "a" }),
      call("Read", { path: "a", limit: 10 }),
    ]);
    expect(out?.count).toBe(3);
    expect(out?.toolName).toBe("Read");
  });
});

describe("detectLoop — window slicing", () => {
  test("only the last windowSize entries count", () => {
    // Three As at the head, then 10 Bs. windowSize 10 should NOT see the As.
    const head = [call("A"), call("A"), call("A")];
    const tail = Array.from({ length: 10 }, () => call("B"));
    const out = detectLoop([...head, ...tail], 10, 3);
    expect(out?.toolName).toBe("B");
  });

  test("threshold can be tuned", () => {
    expect(detectLoop([call("A"), call("A")], 10, 2)?.count).toBe(2);
  });

  test("threshold larger than window length → null", () => {
    expect(detectLoop([call("A"), call("A")], 10, 5)).toBeNull();
  });

  test("threshold 0 or negative is a no-op", () => {
    expect(detectLoop([call("A")], 10, 0)).toBeNull();
    expect(detectLoop([call("A")], 10, -1)).toBeNull();
  });
});

describe("detectLoop — early-exit on first hit", () => {
  test("returns the FIRST signature to hit threshold while scanning the window", () => {
    // Two competing loops in window: A and B. A's third occurrence should
    // arrive first and be reported.
    const out = detectLoop(
      [call("A"), call("B"), call("A"), call("B"), call("A"), call("B"), call("B")],
      10,
      3,
    );
    expect(out?.toolName).toBe("A");
  });
});
