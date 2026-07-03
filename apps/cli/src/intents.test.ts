import { describe, expect, test } from "bun:test";
import type { FeedbackRecord } from "./feedback";
import {
  type OrderedTurn,
  type TurnSignal,
  clusterIntents,
  redactDigest,
  renderIntentsHtml,
  renderIntentsJson,
  renderIntentsText,
} from "./intents";

function turn(sessionId: string, turnNumber: number, input: string, order: number): OrderedTurn {
  return { sessionId, turnNumber, input, output: "", toolNames: [], order };
}

function rating(sessionId: string, turnNumber: number, thumbs: "up" | "down"): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: `${sessionId}_${turnNumber}`,
    sessionId,
    turnNumber,
    modality: "binary",
    rating: { thumbs },
    source: "user",
    ts: `2026-07-02T00:00:0${turnNumber}.000Z`,
  };
}

describe("clusterIntents (#67)", () => {
  test("clusters near-duplicate questions and counts frequency + sessions", () => {
    const turns: OrderedTurn[] = [
      turn("sess_a", 1, "how do I deploy my agent", 0),
      turn("sess_b", 1, "how do i deploy the agent", 1),
      turn("sess_c", 1, "what is the weather today", 2),
    ];
    const digest = clusterIntents(turns, [], []);
    expect(digest.totalTurns).toBe(3);
    expect(digest.totalSessions).toBe(3);
    const deploy = digest.intents.find((i) => i.representative.includes("deploy"));
    expect(deploy?.occurrences).toBe(2);
    expect(deploy?.sessionCount).toBe(2);
    expect(digest.topIntents[0]?.representative).toContain("deploy");
  });

  test("ranks low-satisfaction intents from down-ratings", () => {
    const turns: OrderedTurn[] = [
      turn("sess_a", 1, "reset my password please", 0),
      turn("sess_b", 1, "reset the password now", 1),
    ];
    const feedback = [rating("sess_a", 1, "down"), rating("sess_b", 1, "down")];
    const digest = clusterIntents(turns, feedback, []);
    expect(digest.lowSatisfactionIntents).toHaveLength(1);
    expect(digest.lowSatisfactionIntents[0]?.meanRating).toBe(0);
    expect(digest.lowSatisfactionIntents[0]?.representative).toContain("password");
  });

  test("flags unmet intents from struggle signals", () => {
    const turns: OrderedTurn[] = [
      turn("sess_a", 1, "connect to the database", 0),
      turn("sess_b", 1, "connect to my database", 1),
    ];
    const failed: TurnSignal[] = [
      { sessionId: "sess_a", turnNumber: 1 },
      { sessionId: "sess_b", turnNumber: 1 },
    ];
    const digest = clusterIntents(turns, [], failed);
    expect(digest.unmetIntents).toHaveLength(1);
    expect(digest.unmetIntents[0]?.failureRate).toBe(1);
    expect(digest.unmetIntents[0]?.failedTurns).toBe(2);
  });

  test("detects rising intents by recency (median-order split)", () => {
    // 6 turns: "billing" asked once early, three times recent → rising.
    const turns: OrderedTurn[] = [
      turn("s1", 1, "billing question about invoice", 0),
      turn("s2", 1, "how do I export data", 1),
      turn("s3", 1, "how do I export data now", 2),
      turn("s4", 1, "billing question about invoice", 3),
      turn("s5", 1, "billing question about invoice", 4),
      turn("s6", 1, "billing question about invoice", 5),
    ];
    const digest = clusterIntents(turns, [], []);
    const billing = digest.risingIntents.find((i) => i.representative.includes("billing"));
    expect(billing).toBeDefined();
    expect((billing?.recentCount ?? 0) > (billing?.earlyCount ?? 0)).toBe(true);
  });

  test("honors --top (topN) limits", () => {
    const turns: OrderedTurn[] = Array.from({ length: 8 }, (_, i) =>
      turn(`s${i}`, 1, `unique intent number ${i}`, i),
    );
    const digest = clusterIntents(turns, [], [], { topN: 3 });
    expect(digest.topIntents.length).toBeLessThanOrEqual(3);
  });
});

describe("redactDigest (#67)", () => {
  test("applies the redactor to representative + examples", () => {
    const turns: OrderedTurn[] = [
      turn("s1", 1, "my email is alice@example.com help", 0),
      turn("s2", 1, "my email is bob@example.com help", 1),
    ];
    const digest = clusterIntents(turns, [], []);
    const redacted = redactDigest(digest, (s) => s.replace(/\S+@\S+/g, "[EMAIL]"));
    const rep = redacted.intents[0]?.representative ?? "";
    expect(rep).toContain("[EMAIL]");
    expect(rep).not.toContain("@example.com");
    expect(redacted.intents[0]?.examples.join(" ")).not.toContain("@example.com");
  });
});

describe("renderers (#67)", () => {
  const turns: OrderedTurn[] = [
    turn("s1", 1, "how do I deploy", 0),
    turn("s2", 1, "how do i deploy", 1),
  ];
  const digest = clusterIntents(turns, [], []);

  test("text render lists all four views", () => {
    const out = renderIntentsText(digest);
    expect(out).toContain("TOP INTENTS");
    expect(out).toContain("RISING INTENTS");
    expect(out).toContain("LOW SATISFACTION");
    expect(out).toContain("UNMET");
  });

  test("json render round-trips", () => {
    const parsed = JSON.parse(renderIntentsJson(digest));
    expect(parsed.totalTurns).toBe(2);
    expect(Array.isArray(parsed.intents)).toBe(true);
  });

  test("html render escapes + is self-contained", () => {
    const withAngle: OrderedTurn[] = [turn("s1", 1, "handle <script> tags", 0)];
    const d = clusterIntents(withAngle, [], []);
    const html = renderIntentsHtml(d);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script> tags");
  });
});
