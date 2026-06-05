import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetLoadError } from "../errors";
import { loadCsv } from "./csv";
import { loadHttp } from "./http";
import { loadYaml } from "./yaml";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

let tmpCounter = 0;
async function withTmp(name: string, contents: string): Promise<string> {
  const path = join(tmpdir(), `eval-dataset-${process.pid}-${tmpCounter++}-${name}`);
  await Bun.write(path, contents);
  return path;
}

/** Build a minimal Response stub the http loader understands. */
function httpResponse(
  body: string,
  init: { status?: number; ok?: boolean; contentType?: string } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers();
  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    headers,
    text: async () => body,
  } as unknown as Response;
}

describe("loadCsv — file-level branches", () => {
  test("throws DatasetLoadError when the file does not exist", async () => {
    await expect(loadCsv(join(tmpdir(), "eval-dataset-absent.csv"))).rejects.toThrow(
      DatasetLoadError,
    );
    await expect(loadCsv(join(tmpdir(), "eval-dataset-absent.csv"))).rejects.toThrow(
      /file not found/,
    );
  });

  test("empty CSV file yields zero samples (no header row)", async () => {
    const path = await withTmp("empty.csv", "");
    try {
      const ds = await loadCsv(path);
      expect(ds.name).toBe(`eval-dataset-${process.pid}-${tmpCounter - 1}-empty`);
      expect(await collect(ds.samples)).toEqual([]);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("skips blank in-body rows but parses real rows", async () => {
    // A blank line between data rows parses to a single empty field `[""]`,
    // which rowsToSamples must skip rather than validate.
    const path = await withTmp("blank.csv", "id,input\nq1,hello\n\nq2,world\n");
    try {
      const samples = await collect((await loadCsv(path)).samples);
      expect(samples).toEqual([
        { id: "q1", input: "hello" },
        { id: "q2", input: "world" },
      ]);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("rejects a row that fails schema validation with the row number", async () => {
    // Missing `id` (empty cell) — `id` is required and min-length 1.
    const path = await withTmp("bad.csv", "id,input\n,orphan\n");
    try {
      const ds = await loadCsv(path);
      await expect(collect(ds.samples)).rejects.toThrow(DatasetLoadError);
      await expect(collect((await loadCsv(path)).samples)).rejects.toThrow(
        /invalid sample on row 2/,
      );
    } finally {
      await Bun.file(path).delete();
    }
  });
});

describe("loadYaml — file-level and validation branches", () => {
  test("throws DatasetLoadError when the file does not exist", async () => {
    await expect(loadYaml(join(tmpdir(), "eval-dataset-absent.yaml"))).rejects.toThrow(
      /file not found/,
    );
  });

  test("rejects malformed YAML", async () => {
    // Unbalanced flow mapping is a parse error in the `yaml` library.
    const path = await withTmp("broken.yaml", "name: x\nsamples: [a: 1, : :\n");
    try {
      await expect(loadYaml(path)).rejects.toThrow(/malformed YAML/);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("rejects a non-array document that fails the Dataset schema", async () => {
    // Object shape, but `samples` is missing → DatasetSchema fails.
    const path = await withTmp("notdataset.yaml", "name: only-a-name\n");
    try {
      await expect(loadYaml(path)).rejects.toThrow(/invalid dataset/);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("rejects an invalid sample inside a bare array with its index", async () => {
    const path = await withTmp("badsample.yaml", "- id: ok\n  input: fine\n- input: no-id\n");
    try {
      const ds = await loadYaml(path);
      await expect(collect(ds.samples)).rejects.toThrow(/invalid sample at index 1/);
    } finally {
      await Bun.file(path).delete();
    }
  });
});

describe("loadHttp — dispatch and parsing", () => {
  afterEach(() => {
    // Restore any fetch spy installed inside a test.
    (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("throws on non-OK responses", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(httpResponse("nope", { status: 404, ok: false }));
    await expect(loadHttp("https://example.test/data.jsonl")).rejects.toThrow(/HTTP 404/);
  });

  test("parses JSONL by extension", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse('{"id":"q1","input":"hi"}\n\n{"id":"q2","input":"yo"}\n'),
    );
    const ds = await loadHttp("https://example.test/path/remote.jsonl");
    expect(ds.name).toBe("remote");
    expect(await collect(ds.samples)).toEqual([
      { id: "q1", input: "hi" },
      { id: "q2", input: "yo" },
    ]);
  });

  test("parses JSONL by content-type when extension is absent", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse('{"id":"q1","input":"hi"}\n', {
        contentType: "application/x-ndjson; charset=utf-8",
      }),
    );
    const ds = await loadHttp("https://example.test/download");
    expect(await collect(ds.samples)).toEqual([{ id: "q1", input: "hi" }]);
  });

  test("rejects malformed JSON over HTTP with the line number", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(httpResponse('{"id":"q1","input":"ok"}\nnope\n'));
    const ds = await loadHttp("https://example.test/data.jsonl");
    await expect(collect(ds.samples)).rejects.toThrow(/malformed JSON on line 2/);
  });

  test("rejects an invalid JSONL sample over HTTP", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(httpResponse('{"input":"no id"}\n'));
    const ds = await loadHttp("https://example.test/data.jsonl");
    await expect(collect(ds.samples)).rejects.toThrow(/invalid sample on line 1/);
  });

  test("parses CSV by content-type", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse('id,input,expected_tools\nq1,hi,\nq2,yo,"bash, read"\n', {
        contentType: "text/csv",
      }),
    );
    const ds = await loadHttp("https://example.test/data");
    const samples = await collect(ds.samples);
    expect(samples[0]).toEqual({ id: "q1", input: "hi" });
    expect(samples[1]).toEqual({ id: "q2", input: "yo", expected_tools: ["bash", "read"] });
  });

  test("CSV with only a header (no data) yields zero samples", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("id,input\n", { contentType: "text/csv" }),
    );
    const ds = await loadHttp("https://example.test/data.csv");
    expect(await collect(ds.samples)).toEqual([]);
  });

  test("empty CSV body yields zero samples (no header)", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(httpResponse("", { contentType: "text/csv" }));
    const ds = await loadHttp("https://example.test/data.csv");
    expect(await collect(ds.samples)).toEqual([]);
  });

  test("skips blank in-body CSV rows over HTTP", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("id,input\nq1,a\n\nq2,b\n", { contentType: "text/csv" }),
    );
    const ds = await loadHttp("https://example.test/data.csv");
    expect(await collect(ds.samples)).toEqual([
      { id: "q1", input: "a" },
      { id: "q2", input: "b" },
    ]);
  });

  test("rejects an invalid CSV sample over HTTP with the row number", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("id,input\n,missing-id\n", { contentType: "text/csv" }),
    );
    const ds = await loadHttp("https://example.test/data.csv");
    await expect(collect(ds.samples)).rejects.toThrow(/invalid sample on row 2/);
  });

  test("parses YAML Dataset wrapper by extension", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("name: remote-yaml\nsamples:\n  - id: q1\n    input: hi\n"),
    );
    const ds = await loadHttp("https://example.test/path/data.yaml");
    expect(ds.name).toBe("remote-yaml");
    expect(await collect(ds.samples)).toEqual([{ id: "q1", input: "hi" }]);
  });

  test("parses YAML bare array by content-type and derives name", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("- id: q1\n  input: hi\n", { contentType: "application/yaml" }),
    );
    const ds = await loadHttp("https://example.test/path/bare.yml?ref=main");
    expect(ds.name).toBe("bare");
    expect(await collect(ds.samples)).toEqual([{ id: "q1", input: "hi" }]);
  });

  test("rejects malformed YAML over HTTP", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("name: x\nsamples: [a: 1, : :\n", { contentType: "text/yaml" }),
    );
    await expect(loadHttp("https://example.test/data.yaml")).rejects.toThrow(/malformed YAML/);
  });

  test("rejects a non-array YAML document that fails the Dataset schema", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("name: only-a-name\n", { contentType: "application/yaml" }),
    );
    await expect(loadHttp("https://example.test/data.yaml")).rejects.toThrow(/invalid dataset/);
  });

  test("rejects an invalid sample inside an HTTP YAML payload", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("- id: ok\n  input: fine\n- input: no-id\n", { contentType: "text/yaml" }),
    );
    const ds = await loadHttp("https://example.test/data.yaml");
    await expect(collect(ds.samples)).rejects.toThrow(/invalid sample at index 1/);
  });

  test("rejects an unrecognized HTTP dataset format", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse("plain", { contentType: "text/plain" }),
    );
    await expect(loadHttp("https://example.test/data")).rejects.toThrow(
      /unrecognized HTTP dataset format/,
    );
  });

  test("reports content-type 'unknown' when the header is absent", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(httpResponse("plain"));
    await expect(loadHttp("https://example.test/data")).rejects.toThrow(/content-type: unknown/);
  });

  test("deriveName falls back to 'remote-dataset' for a path with no segments", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse('{"id":"q1","input":"hi"}\n', { contentType: "application/x-jsonlines" }),
    );
    // Root path: no trailing segment to derive a name from.
    const ds = await loadHttp("https://example.test/");
    expect(ds.name).toBe("remote-dataset");
  });

  test("deriveName catch-branch returns 'remote-dataset' when URL parsing throws", async () => {
    // fetch is stubbed, so an unparseable URL string still reaches deriveName,
    // where `new URL(...)` throws and the catch returns the fallback name.
    spyOn(globalThis, "fetch").mockResolvedValue(
      httpResponse('{"id":"q1","input":"hi"}\n', { contentType: "application/x-ndjson" }),
    );
    const ds = await loadHttp("not a parseable url");
    expect(ds.name).toBe("remote-dataset");
    expect(await collect(ds.samples)).toEqual([{ id: "q1", input: "hi" }]);
  });
});
