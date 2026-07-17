import { describe, expect, test } from "bun:test";
import type { ToolUseBlock } from "@crewhaus/turn-state-machine";
import { detectLoop, nearToolCallSignature, stripVolatile, toolCallSignature } from "./index";

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

  test("bigint / symbol / function leaves fall through to a stable string tag", () => {
    // These typeof branches (bigint, symbol, function) hit the final
    // `JSON.stringify(String(value))` fall-through in canonicalJson.
    expect(toolCallSignature("X", 10n)).toBe('X:"10"');
    const sym = Symbol("loop");
    expect(toolCallSignature("X", sym)).toBe(`X:${JSON.stringify(String(sym))}`);
    const fn = function namedFn() {};
    expect(toolCallSignature("X", fn)).toBe(`X:${JSON.stringify(String(fn))}`);
    // Same bigint value always yields the same signature (determinism).
    expect(toolCallSignature("X", 10n)).toBe(toolCallSignature("X", 10n));
  });

  test("bigint inside a nested object still produces a canonical signature", () => {
    expect(toolCallSignature("X", { n: 5n })).toBe('X:{"n":"5"}');
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

describe("detectLoop — threshold 1 (every new signature is an instant hit)", () => {
  test("a single call with threshold 1 is detected immediately", () => {
    // threshold === 1 takes the `counts.set` branch and returns on first sight.
    const out = detectLoop([call("A", { k: "v" })], 10, 1);
    expect(out).not.toBeNull();
    expect(out?.toolName).toBe("A");
    expect(out?.count).toBe(1);
    expect(out?.threshold).toBe(1);
    expect(out?.windowSize).toBe(10);
    expect(out?.signature).toBe('A:{"k":"v"}');
  });

  test("with threshold 1 the FIRST call in the window wins", () => {
    const out = detectLoop([call("First"), call("Second"), call("First")], 10, 1);
    expect(out?.toolName).toBe("First");
    expect(out?.count).toBe(1);
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

// ---------------------------------------------------------------------------
// Loop contract 0.4 (G27) — near-duplicate tier.
// ---------------------------------------------------------------------------

describe("stripVolatile / nearToolCallSignature", () => {
  test("digit runs, UUIDs, long hex ids, and whitespace runs collapse", () => {
    expect(stripVolatile("page 12 of 90")).toBe("page «n» of «n»");
    expect(stripVolatile("id=3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe("id=«uuid»");
    expect(stripVolatile("sha deadbeefdeadbeefdeadbeef done")).toBe("sha «hex» done");
    expect(stripVolatile("a  \t b\n c")).toBe("a b c");
  });

  test("near signatures collapse volatile-only differences (numbers as values too)", () => {
    expect(nearToolCallSignature("Fetch", { url: "https://x.test/items?page=1" })).toBe(
      nearToolCallSignature("Fetch", { url: "https://x.test/items?page=2" }),
    );
    expect(nearToolCallSignature("Read", { offset: 100 })).toBe(
      nearToolCallSignature("Read", { offset: 200 }),
    );
  });

  test("near signatures keep genuinely different inputs apart, and never collide with exact ones", () => {
    expect(nearToolCallSignature("Read", { path: "a.ts" })).not.toBe(
      nearToolCallSignature("Read", { path: "b.ts" }),
    );
    // `~` separator vs `:` — a caller's dedup set can hold both kinds safely.
    expect(nearToolCallSignature("X", {})).not.toBe(toolCallSignature("X", {}));
  });
});

describe("detectLoop — near-duplicate tier (G27)", () => {
  const page = (n: number): ToolUseBlock => call("Fetch", { url: `https://x.test/i?page=${n}` });

  test("exact repeats keep reporting tier 'exact' (pre-0.4 behaviour intact)", () => {
    const out = detectLoop([call("A", { k: 1 }), call("A", { k: 1 }), call("A", { k: 1 })]);
    expect(out?.tier).toBe("exact");
    expect(out?.signature).toBe('A:{"k":1}');
  });

  test("three near-duplicates do NOT trip the default threshold (reduced weight)", () => {
    // Weighted score 1 + 2×0.5 = 2 < 3.
    expect(detectLoop([page(1), page(2), page(3)])).toBeNull();
  });

  test("five near-duplicates trip the default threshold with tier 'near'", () => {
    // Weighted score 1 + 4×0.5 = 3 >= 3.
    const out = detectLoop([page(1), page(2), page(3), page(4), page(5)]);
    expect(out).not.toBeNull();
    expect(out?.tier).toBe("near");
    expect(out?.toolName).toBe("Fetch");
    expect(out?.count).toBe(5);
    expect(out?.signature).toBe(nearToolCallSignature("Fetch", { url: "https://x.test/i?page=1" }));
  });

  test("a mixed exact+near group scores exact repeats at full weight", () => {
    // 2 exact repeats of page(1) + 2 near variants: 2 + 2×0.5 = 3 >= 3,
    // while no single exact signature reached 3 on its own.
    const out = detectLoop([page(1), page(1), page(2), page(3)]);
    expect(out?.tier).toBe("near");
    expect(out?.count).toBe(4);
  });

  test("near matching never crosses tool names", () => {
    const out = detectLoop([
      call("A", { q: "x 1" }),
      call("B", { q: "x 2" }),
      call("A", { q: "x 3" }),
      call("B", { q: "x 4" }),
      call("A", { q: "x 5" }),
    ]);
    expect(out).toBeNull();
  });

  test("near detection respects the window slice", () => {
    // Five near-duplicates followed by 10 distinct calls: window 10 only
    // sees the distinct tail → null.
    const churn = [page(1), page(2), page(3), page(4), page(5)];
    const tail = Array.from({ length: 10 }, (_, i) =>
      call("Other", { p: `path-${String.fromCharCode(97 + i)}.ts` }),
    );
    expect(detectLoop([...churn, ...tail], 10, 3)).toBeNull();
  });
});
