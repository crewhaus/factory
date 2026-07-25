/**
 * Item 20 — per-sample stdout for concurrent eval runs. The regression these
 * lock down is the observed `crewhaus eval` line:
 *
 *   "agent> TheThe capital of Brazil is **Brasília**. …capital of Japan is …"
 *
 * three concurrent samples spliced into one sentence on a shared stdout.
 */
import { describe, expect, test } from "bun:test";
import { createSampleOutputWriter } from "./sample-output";

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("createSampleOutputWriter", () => {
  test("interleaved token deltas from concurrent samples never splice", () => {
    const sink = collector();
    const q1 = createSampleOutputWriter({ label: "q1", write: sink.write });
    const q2 = createSampleOutputWriter({ label: "q2", write: sink.write });
    // Exactly the shape that produced the audit's garbled line: two runs
    // pushing partial words into the same sink, turn by turn.
    q1.write("agent> ");
    q2.write("agent> ");
    q1.write("The");
    q2.write("The");
    q1.write(" capital of Brazil is **Brasília**.");
    q2.write(" capital of Japan is **Tokyo**.");
    q1.write("\n");
    q2.write("\n");
    expect(sink.lines).toEqual([
      "[q1] agent> The capital of Brazil is **Brasília**.\n",
      "[q2] agent> The capital of Japan is **Tokyo**.\n",
    ]);
  });

  test("a chunk carrying several newlines emits one tagged line each", () => {
    const sink = collector();
    const w = createSampleOutputWriter({ label: "s1", write: sink.write });
    w.write("first\nsecond\nthird");
    expect(sink.lines).toEqual(["[s1] first\n", "[s1] second\n"]);
    w.end();
    expect(sink.lines).toEqual(["[s1] first\n", "[s1] second\n", "[s1] third\n"]);
  });

  test("nothing is emitted until a line completes", () => {
    const sink = collector();
    const w = createSampleOutputWriter({ label: "s1", write: sink.write });
    w.write("partial answer, still streaming");
    expect(sink.lines).toEqual([]);
    w.write("\n");
    expect(sink.lines).toEqual(["[s1] partial answer, still streaming\n"]);
  });

  test("end() flushes a sample that finished mid-line, and is idempotent", () => {
    const sink = collector();
    const w = createSampleOutputWriter({ label: "s1", write: sink.write });
    w.write("no trailing newline");
    w.end();
    w.end();
    expect(sink.lines).toEqual(["[s1] no trailing newline\n"]);
  });

  test("whitespace-only lines are dropped rather than emitted as a bare tag", () => {
    const sink = collector();
    const w = createSampleOutputWriter({ label: "s1", write: sink.write });
    // The loop writes a lone "\n" after each turn, and model answers carry
    // blank lines between paragraphs.
    w.write("para one\n\n   \npara two\n");
    w.end();
    expect(sink.lines).toEqual(["[s1] para one\n", "[s1] para two\n"]);
  });

  test("CRLF does not leave a stray carriage return inside the line", () => {
    const sink = collector();
    const w = createSampleOutputWriter({ label: "s1", write: sink.write });
    w.write("tool said hi\r\n");
    expect(sink.lines).toEqual(["[s1] tool said hi\n"]);
  });
});
