/**
 * 0.6.0 §6.3 / §7.8 (PR 14) — `promoteLanes`: folding the observe-only `q:` /
 * `shadow:` lanes into the live arms they audited.
 *
 * The properties that make promotion safe to expose as a CLI verb:
 *   - the live arm's statistics move by exactly the lane's evidence;
 *   - the lane keeps its own history (a promoted audition is still visible);
 *   - it is IDEMPOTENT — a second promotion folds nothing, and folds only the
 *     delta once the lane has accumulated more;
 *   - non-lane lines are untouched, byte for byte; and
 *   - a shadow MEMBER arm never reaches a live arm on its own — only through
 *     this call (PR 9d/PR 10).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shadowRouteKey } from "./lanes";
import { liveRouteKeyOf, promoteLanes } from "./promote";
import { openScoreboard } from "./scoreboard";

function seed(lines: ReadonlyArray<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-promote-"));
  mkdirSync(join(root, "routing"), { recursive: true });
  writeFileSync(
    join(root, "routing", "arms.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : ""),
    { mode: 0o600 },
  );
  return root;
}

/** Every PARSEABLE line of the store (a deliberately torn line is skipped). */
const rawLines = (root: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(join(root, "routing", "arms.jsonl"), "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // torn line — the point of the tolerance test
    }
  }
  return out;
};

const delta = (k: string, m: string, r: number, q?: number): Record<string, unknown> => ({
  v: q === undefined ? 1 : 2,
  k,
  m,
  r,
  s: 1,
  l: 1000,
  c: 0.001,
  t: 1,
  ...(q !== undefined ? { q } : {}),
});

describe("liveRouteKeyOf", () => {
  test("strips the lane prefix, and only a lane prefix", () => {
    expect(liveRouteKeyOf("q:hard")).toBe("hard");
    expect(liveRouteKeyOf(shadowRouteKey("hard", "main"))).toBe("main/hard");
    expect(liveRouteKeyOf("shadow:easy")).toBe("easy");
    expect(liveRouteKeyOf("hard")).toBeUndefined();
    expect(liveRouteKeyOf("main/hard")).toBeUndefined();
  });
});

describe("promoteLanes", () => {
  test("folds q: and shadow: evidence into the live arm, and the live arm's stats move by exactly that evidence", () => {
    const root = seed([
      delta("hard", "fast", 0.4),
      delta("q:hard", "fast", 0.9, 0.9),
      delta(shadowRouteKey("hard"), "strong", 0.8, 0.8),
    ]);
    // Before: the live `hard` bucket knows only its own line.
    const before = openScoreboard(root).snapshot();
    expect(before.find((a) => a.routeKey === "hard" && a.model === "fast")?.n).toBe(1);
    expect(before.find((a) => a.routeKey === "hard" && a.model === "strong")).toBeUndefined();

    const result = promoteLanes(root, { now: () => 42 });
    expect(result.lines).toBe(2);
    expect(result.alreadyPromoted).toBe(0);
    expect(result.promotions).toEqual([
      { from: "q:hard", to: "hard", model: "fast", lines: 1, observations: 1, meanQuality: 0.9 },
      {
        from: "shadow:hard",
        to: "hard",
        model: "strong",
        lines: 1,
        observations: 1,
        meanQuality: 0.8,
      },
    ]);

    const after = openScoreboard(root).snapshot();
    const fast = after.find((a) => a.routeKey === "hard" && a.model === "fast");
    expect(fast?.n).toBe(2);
    expect(fast?.meanReward).toBeCloseTo((0.4 + 0.9) / 2, 12);
    expect(fast?.qualityCount).toBe(1);
    expect(fast?.meanQuality).toBeCloseTo(0.9, 12);
    // The shadow member arm reaches the LIVE bucket only through promotion.
    const strong = after.find((a) => a.routeKey === "hard" && a.model === "strong");
    expect(strong?.n).toBe(1);
    expect(strong?.meanQuality).toBeCloseTo(0.8, 12);
    // …and the lane keeps its own history, so the audition stays inspectable.
    expect(after.find((a) => a.routeKey === "q:hard" && a.model === "fast")?.n).toBe(1);
    expect(after.find((a) => a.routeKey === "shadow:hard" && a.model === "strong")?.n).toBe(1);
  });

  test("is idempotent — a second promotion folds nothing, a third folds only new lane evidence", () => {
    const root = seed([delta("q:hard", "fast", 0.9, 0.9)]);
    expect(promoteLanes(root).lines).toBe(1);

    const second = promoteLanes(root);
    expect(second.lines).toBe(0);
    expect(second.alreadyPromoted).toBe(1);
    expect(second.promotions).toEqual([]);
    expect(openScoreboard(root).score("hard", "fast")?.n).toBe(1);

    // New lane evidence arrives (the offline join records another turn).
    openScoreboard(root).record("q:hard", "fast", 0.5, {
      success: true,
      latencyMs: 10,
      quality: 0.5,
    });
    const third = promoteLanes(root);
    expect(third.lines).toBe(1);
    expect(third.alreadyPromoted).toBe(1);
    expect(openScoreboard(root).score("hard", "fast")?.n).toBe(2);
  });

  test("carries an aggregate lane line (a compacted lane, or an `ungraded` increment) through", () => {
    const root = seed([
      {
        v: 2,
        agg: 1,
        k: "q:easy",
        m: "fast",
        n: 4,
        mr: 0.8,
        m2: 0.2,
        ls: 40,
        cs: 0.4,
        cn: 4,
        qs: 3.2,
        qn: 4,
        qm2: 0.1,
      },
      { v: 2, agg: 1, k: "q:easy", m: "fast", n: 0, ug: 3, t: 1 },
    ]);
    const result = promoteLanes(root);
    expect(result.lines).toBe(2);
    expect(result.promotions[0]).toMatchObject({
      from: "q:easy",
      to: "easy",
      model: "fast",
      lines: 2,
      observations: 4,
    });
    expect(result.promotions[0]?.meanQuality).toBeCloseTo(0.8, 12);
    const live = openScoreboard(root).score("easy", "fast");
    expect(live?.n).toBe(4);
    expect(live?.meanReward).toBeCloseTo(0.8, 12);
    expect(live?.qualityCount).toBe(4);
    expect(live?.ungraded).toBe(3);
  });

  test("--dry-run reports the fold and writes nothing", () => {
    const root = seed([delta("q:hard", "fast", 0.9, 0.9)]);
    const before = readFileSync(join(root, "routing", "arms.jsonl"), "utf8");
    const result = promoteLanes(root, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.lines).toBe(1);
    expect(readFileSync(join(root, "routing", "arms.jsonl"), "utf8")).toBe(before);
    expect(openScoreboard(root).score("hard", "fast")).toBeUndefined();
  });

  test("leaves non-lane lines byte-identical and tolerates a torn line", () => {
    const live = JSON.stringify(delta("hard", "fast", 0.4));
    const root = seed([]);
    writeFileSync(
      join(root, "routing", "arms.jsonl"),
      `${live}\n{"v":1,"k":"q:hard","m":"fast"\n${JSON.stringify(delta("q:hard", "fast", 0.9, 0.9))}\n`,
      { mode: 0o600 },
    );
    const result = promoteLanes(root, { now: () => 7 });
    expect(result.lines).toBe(1);
    const text = readFileSync(join(root, "routing", "arms.jsonl"), "utf8");
    expect(text.split("\n")[0]).toBe(live);
    expect(text).toContain('{"v":1,"k":"q:hard","m":"fast"\n'); // torn line survives verbatim
    // The fold names where it came from, and the source is stamped promoted.
    const parsed = rawLines(root);
    expect(parsed.find((l) => l["k"] === "hard" && l["pr"] === "q:hard")).toMatchObject({
      m: "fast",
      q: 0.9,
      t: 7,
    });
    expect(parsed.find((l) => l["k"] === "q:hard" && l["r"] !== undefined)?.["pm"]).toBe(1);
  });

  test("a missing store, and a lane prefix naming no live arm, are both no-ops", () => {
    const empty = mkdtempSync(join(tmpdir(), "crewhaus-promote-none-"));
    expect(promoteLanes(empty).lines).toBe(0);
    expect(promoteLanes(empty).promotions).toEqual([]);

    const degenerate = seed([delta("q:", "fast", 0.9, 0.9)]);
    const result = promoteLanes(degenerate);
    expect(result.lines).toBe(0);
    expect(rawLines(degenerate)).toHaveLength(1);
  });
});
