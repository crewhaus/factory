import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DatasetLoadError, SampleSchema, loadDataset, parseCsv } from "./index";

// `tsc -b` compiles this file into `dist/`, so `bun test` (with no path filter)
// picks up both `src/index.test.ts` and `dist/index.test.js`. The compiled copy
// resolves `import.meta.dir` to `dist/`, but `__fixtures__/` only exists under
// `src/`. Map back to the source tree so both copies find the fixtures.
const FIX = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "__fixtures__");

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("loadDataset — JSONL loader (T1)", () => {
  test("parses well-formed JSONL with all field shapes", async () => {
    const ds = await loadDataset(join(FIX, "ok.jsonl"));
    expect(ds.name).toBe("ok");
    const samples = await collect(ds.samples);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ id: "q1", input: "hello" });
    expect(samples[1]?.expected_output).toBe("bye");
    expect(samples[2]?.expected_tools).toEqual(["bash", "read"]);
    expect(samples[2]?.metadata).toEqual({ difficulty: "easy" });
  });

  test("yields zero samples for empty file", async () => {
    const ds = await loadDataset(join(FIX, "empty.jsonl"));
    expect(await collect(ds.samples)).toEqual([]);
  });

  test("rejects malformed JSON with line number", async () => {
    const tmp = `${FIX}/__tmp_malformed.jsonl`;
    await Bun.write(tmp, '{"id":"q1","input":"ok"}\nnot json\n');
    try {
      const ds = await loadDataset(tmp);
      await expect(collect(ds.samples)).rejects.toThrow(/malformed JSON on line 2/);
    } finally {
      await Bun.file(tmp).delete();
    }
  });

  test("rejects sample missing required fields", async () => {
    const tmp = `${FIX}/__tmp_invalid.jsonl`;
    await Bun.write(tmp, '{"input":"no id"}\n');
    try {
      const ds = await loadDataset(tmp);
      await expect(collect(ds.samples)).rejects.toThrow(DatasetLoadError);
    } finally {
      await Bun.file(tmp).delete();
    }
  });

  test("rejects missing file", async () => {
    await expect(loadDataset(`${FIX}/does-not-exist.jsonl`)).rejects.toThrow(DatasetLoadError);
  });

  test("parses CRLF line endings and a final line with no trailing newline (B24 streaming path)", async () => {
    // Local `.jsonl` now streams off `Bun.file().stream()` through the shared
    // incremental parser — pin the two line-splitting edges the old buffered
    // `split(/\r?\n/)` handled implicitly.
    const tmp = `${FIX}/__tmp_crlf.jsonl`;
    await Bun.write(tmp, '{"id":"q1","input":"a"}\r\n{"id":"q2","input":"b"}');
    try {
      const ds = await loadDataset(tmp);
      expect(await collect(ds.samples)).toEqual([
        { id: "q1", input: "a" },
        { id: "q2", input: "b" },
      ]);
    } finally {
      await Bun.file(tmp).delete();
    }
  });
});

describe("loadDataset — CSV loader (T1)", () => {
  test("parses CSV with quoted fields, embedded newlines, and multi-tool column", async () => {
    const ds = await loadDataset(join(FIX, "ok.csv"));
    const samples = await collect(ds.samples);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ id: "q1", input: "hello" });
    expect(samples[1]).toEqual({
      id: "q2",
      input: "hello, world",
      expected_output: "greeting",
      expected_tools: ["bash", "read"],
    });
    expect(samples[2]?.input).toBe("line1\nline2");
  });
});

describe("parseCsv — RFC 4180 subset (T1)", () => {
  test("empty input yields no rows", () => {
    expect(parseCsv("")).toEqual([]);
  });

  test("escaped double-quotes inside quoted field", () => {
    expect(parseCsv('a,"b ""quoted"" c"')).toEqual([["a", 'b "quoted" c']]);
  });

  test("CRLF line endings", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("trailing newline is not a synthetic empty row", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  test("missing final newline still yields the last row", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("loadDataset — YAML loader (T1)", () => {
  test("parses Dataset wrapper shape", async () => {
    const ds = await loadDataset(join(FIX, "ok.yaml"));
    expect(ds.name).toBe("yaml-fixture");
    const samples = await collect(ds.samples);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({ id: "q1", input: "hello" });
  });

  test("parses bare-array shape and derives name from filename", async () => {
    const ds = await loadDataset(join(FIX, "bare-array.yaml"));
    expect(ds.name).toBe("bare-array");
    const samples = await collect(ds.samples);
    expect(samples).toHaveLength(2);
    expect(samples[1]?.expected_output).toBe("ok");
  });

  test("supports .yml extension", async () => {
    const tmp = `${FIX}/__tmp.yml`;
    await Bun.write(tmp, "- id: x\n  input: y\n");
    try {
      const ds = await loadDataset(tmp);
      const samples = await collect(ds.samples);
      expect(samples).toHaveLength(1);
    } finally {
      await Bun.file(tmp).delete();
    }
  });
});

describe("SampleSchema — multi-turn history (B14)", () => {
  test("accepts a sample with history turns, kept verbatim", () => {
    const sample = {
      id: "mt1",
      input: "and what about Japan?",
      history: [
        { role: "user", content: "What is the capital of Brazil?" },
        { role: "assistant", content: "Brasília." },
      ],
      expected_output: "Tokyo",
    };
    const parsed = SampleSchema.parse(sample);
    expect(parsed.history).toEqual(sample.history);
    expect(parsed.input).toBe("and what about Japan?");
  });

  test("history may end on an assistant turn — `input` is always the final user message", () => {
    const parsed = SampleSchema.parse({
      id: "mt2",
      input: "next",
      history: [{ role: "assistant", content: "opening greeting" }],
    });
    expect(parsed.history).toHaveLength(1);
  });

  test("rejects an empty history array (min 1 when present)", () => {
    expect(SampleSchema.safeParse({ id: "x", input: "q", history: [] }).success).toBe(false);
  });

  test("rejects invalid roles, unknown keys, and non-string content (strict items)", () => {
    // role outside user|assistant
    expect(
      SampleSchema.safeParse({
        id: "x",
        input: "q",
        history: [{ role: "system", content: "no" }],
      }).success,
    ).toBe(false);
    // strict item shape — extra keys are authoring mistakes
    expect(
      SampleSchema.safeParse({
        id: "x",
        input: "q",
        history: [{ role: "user", content: "hi", name: "alice" }],
      }).success,
    ).toBe(false);
    // content must be a string
    expect(
      SampleSchema.safeParse({
        id: "x",
        input: "q",
        history: [{ role: "user", content: 42 }],
      }).success,
    ).toBe(false);
    // history must be an array
    expect(SampleSchema.safeParse({ id: "x", input: "q", history: "not-an-array" }).success).toBe(
      false,
    );
  });

  test("history-less samples parse byte-identically (back-compat)", () => {
    const legacy = {
      id: "q1",
      input: "hello",
      expected_output: "world",
      expected_tools: ["bash"],
      metadata: { difficulty: "easy" },
    };
    // Same keys, same order, no injected `history` — so dataset-registry
    // sample hashes (JSON.stringify-based) are unchanged for every existing
    // dataset.
    expect(JSON.stringify(SampleSchema.parse(legacy))).toBe(JSON.stringify(legacy));
  });

  test("JSONL loader round-trips history", async () => {
    const tmp = `${FIX}/__tmp_history.jsonl`;
    const line = {
      id: "mt1",
      input: "final",
      history: [{ role: "user", content: "first" }],
    };
    await Bun.write(tmp, `${JSON.stringify(line)}\n`);
    try {
      const ds = await loadDataset(tmp);
      const samples = await collect(ds.samples);
      expect(samples).toEqual([line]);
    } finally {
      await Bun.file(tmp).delete();
    }
  });

  test("a legacy free-form `history` value hard-fails the load (DELIBERATE break)", async () => {
    // Before B14 `history` was an unknown key — Zod strip mode silently
    // dropped it, so a hand-authored dataset carrying a free-form history
    // field loaded fine. Now the key is schema-known: a value that isn't a
    // non-empty [{role, content}] array rejects loudly instead of being
    // ignored. Pinned so the break stays intentional, not accidental.
    const tmp = `${FIX}/__tmp_legacy_history.jsonl`;
    await Bun.write(tmp, '{"id":"q1","input":"final","history":"free-form note"}\n');
    try {
      const ds = await loadDataset(tmp);
      await expect(collect(ds.samples)).rejects.toThrow(/invalid sample on line 1/);
    } finally {
      await Bun.file(tmp).delete();
    }
  });
});

describe("loadDataset — dispatch", () => {
  test("rejects unknown extension", async () => {
    await expect(loadDataset("/tmp/something.xyz")).rejects.toThrow(/unrecognized dataset source/);
  });

  test("HTTP scheme dispatches to http loader (rejects offline lookups gracefully)", async () => {
    // Simply verifies dispatch — actual fetch is exercised in __test__/http.test.ts
    // when CREWHAUS_TEST_HTTP=1 is set.
    await expect(loadDataset("http://127.0.0.1:1/never-listens.jsonl")).rejects.toThrow();
  });
});
