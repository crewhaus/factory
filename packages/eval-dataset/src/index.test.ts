import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DatasetLoadError, loadDataset, parseCsv } from "./index";

const FIX = join(import.meta.dir, "__fixtures__");

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
