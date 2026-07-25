import { describe, expect, test } from "bun:test";
import type { Citation } from "@crewhaus/citation-tracker";
import { writeReport } from "./index.js";

function citation(url: string, snippet: string, branchId?: string): Citation {
  return {
    version: 1,
    url,
    snippet,
    retrievedAt: "2026-05-08T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...(branchId !== undefined ? { branchId } : {}),
  };
}

describe("writeReport", () => {
  test("numbers citations by URL on first appearance", () => {
    const citations: Citation[] = [
      citation("https://a.example.com", "snippet A"),
      citation("https://b.example.com", "snippet B"),
      citation("https://a.example.com", "snippet A again"),
    ];
    const r = writeReport({
      goal: "g",
      branches: [
        {
          question: "q1",
          answer: "answer 1",
          citationUrls: ["https://a.example.com", "https://b.example.com"],
        },
      ],
      citations,
    });
    expect(r.json.citations.map((c) => `${c.number}:${c.url}`)).toEqual([
      "1:https://a.example.com",
      "2:https://b.example.com",
    ]);
    // Branch's citationNumbers are sorted, with same-URL collapsed.
    expect(r.json.subAnswers[0]?.citationNumbers).toEqual([1, 2]);
  });

  test("re-running with identical citation set produces byte-identical citation blocks (deterministic ordering)", () => {
    const citationsA: Citation[] = [
      citation("https://a.example.com", "snip a"),
      citation("https://b.example.com", "snip b"),
      citation("https://c.example.com", "snip c"),
    ];
    const citationsB: Citation[] = [...citationsA];
    const ra = writeReport({
      goal: "g",
      branches: [{ question: "q1", answer: "ans", citationUrls: ["https://a.example.com"] }],
      citations: citationsA,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const rb = writeReport({
      goal: "g",
      branches: [{ question: "q1", answer: "ans", citationUrls: ["https://a.example.com"] }],
      citations: citationsB,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    // Citation block (JSON-side): identical.
    expect(JSON.stringify(ra.json.citations)).toBe(JSON.stringify(rb.json.citations));
    // Markdown citation footer: identical.
    const footer = (s: string): string => s.split("## Citations")[1] ?? "";
    expect(footer(ra.markdown)).toBe(footer(rb.markdown));
  });

  test("markdown structure: goal H1, sub-question H2 per branch, citations footer", () => {
    const r = writeReport({
      goal: "Top risks of crews",
      branches: [
        { question: "What are the technical risks?", answer: "answer 1", citationUrls: [] },
        { question: "What are the operational risks?", answer: "answer 2", citationUrls: [] },
      ],
      citations: [{ ...citation("https://a.example.com", "snip") }],
    });
    expect(r.markdown).toMatch(/^# Top risks of crews\n/);
    expect(r.markdown).toContain("## What are the technical risks?");
    expect(r.markdown).toContain("## What are the operational risks?");
    expect(r.markdown).toContain("## Citations");
    expect(r.markdown).toContain("[1] https://a.example.com");
  });

  // A research report whose whole premise is "must cite" must never look
  // complete when nothing was cited: the section stays, and says so.
  test("zero citations still emits a ## Citations section, with an explicit notice", () => {
    const r = writeReport({
      goal: "Top risks of crews",
      branches: [
        { question: "What are the technical risks?", answer: "answer 1", citationUrls: [] },
      ],
      citations: [],
    });
    expect(r.markdown).toContain("## Citations");
    expect(r.markdown).toContain("No citations were recorded");
    // The notice must not read like a numbered citation.
    expect(r.markdown).not.toMatch(/\[1\]/);
    expect(r.json.citations).toEqual([]);
  });

  test("the empty-citations notice is the last thing in the report", () => {
    const r = writeReport({
      goal: "g",
      branches: [{ question: "q", answer: "a", citationUrls: [] }],
      citations: [],
    });
    const lines = r.markdown.trimEnd().split("\n");
    expect(lines.at(-1)).toContain("No citations were recorded");
    expect(r.markdown.endsWith("\n")).toBe(true);
  });

  test("produces a stable JSON shape (snapshot-friendly)", () => {
    const r = writeReport({
      goal: "G",
      branches: [{ question: "Q", answer: "A", citationUrls: ["https://x"] }],
      citations: [citation("https://x", "snip")],
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(r.json).toEqual({
      version: 1,
      goal: "G",
      subAnswers: [{ question: "Q", answer: "A", citationNumbers: [1] }],
      citations: [
        {
          number: 1,
          url: "https://x",
          snippet: "snip",
          sha256: "0".repeat(64),
          retrievedAt: "2026-05-08T00:00:00.000Z",
        },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
