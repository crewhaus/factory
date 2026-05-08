import { describe, expect, test } from "bun:test";
import { EmbedderError, createEmbedder, parseEmbedderModel } from "./index";

describe("parseEmbedderModel", () => {
  test("parses openai/<model>", () => {
    expect(parseEmbedderModel("openai/text-embedding-3-small")).toEqual({
      providerId: "openai",
      modelId: "text-embedding-3-small",
    });
  });
  test("parses voyage/<model>", () => {
    expect(parseEmbedderModel("voyage/voyage-3")).toEqual({
      providerId: "voyage",
      modelId: "voyage-3",
    });
  });
  test("parses cohere/<model>", () => {
    expect(parseEmbedderModel("cohere/embed-v3")).toEqual({
      providerId: "cohere",
      modelId: "embed-v3",
    });
  });
  test("parses local/<model>@<url>", () => {
    expect(parseEmbedderModel("local/nomic-embed@http://localhost:11434")).toEqual({
      providerId: "local",
      modelId: "nomic-embed",
      baseUrl: "http://localhost:11434",
    });
  });
  test("parses mock/deterministic", () => {
    expect(parseEmbedderModel("mock/det")).toEqual({
      providerId: "mock",
      modelId: "det",
    });
  });
  test("rejects unknown prefix", () => {
    expect(() => parseEmbedderModel("foo/bar")).toThrow(EmbedderError);
  });
  test("rejects local/ without @<url>", () => {
    expect(() => parseEmbedderModel("local/m")).toThrow(/local\/<model>/);
  });
});

describe("mock embedder (deterministic BoW)", () => {
  test("embed returns the requested number of vectors", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const out = await e.embed(["alpha", "bravo", "charlie"]);
    expect(out.length).toBe(3);
  });
  test("each vector is 256-dim", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const out = await e.embed(["hello world"]);
    expect(out[0]?.length).toBe(256);
  });
  test("identical input → identical output (deterministic)", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const a = await e.embed(["how now brown cow"]);
    const b = await e.embed(["how now brown cow"]);
    expect(a[0]).toEqual(b[0] ?? []);
  });
  test("similar texts have higher cosine similarity than dissimilar ones (sanity)", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const [a, b, c] = await e.embed([
      "the quick brown fox jumps",
      "the brown fox is quick",
      "purple snorkel velocity vortex",
    ]);
    const cos = (x?: number[], y?: number[]): number => {
      if (x === undefined || y === undefined) return 0;
      let s = 0;
      for (let i = 0; i < x.length; i += 1) s += (x[i] ?? 0) * (y[i] ?? 0);
      return s;
    };
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
  });
  test("empty input returns empty array (no network call)", async () => {
    const e = createEmbedder({ model: "mock/det" });
    expect(await e.embed([])).toEqual([]);
  });
});

describe("provider construction", () => {
  test("openai requires OPENAI_API_KEY", () => {
    const original = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "";
    try {
      expect(() => createEmbedder({ model: "openai/text-embedding-3-small" })).toThrow(
        /OPENAI_API_KEY/,
      );
    } finally {
      if (original !== undefined) process.env["OPENAI_API_KEY"] = original;
      else process.env["OPENAI_API_KEY"] = "";
    }
  });

  test("local/ accepts the parsed baseUrl", () => {
    const e = createEmbedder({ model: "local/x@http://localhost:11434" });
    expect(e.provider).toBe("local");
    expect(e.model).toBe("x");
  });
});
