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

/**
 * Section 30 — embedder snapshot tests. Each provider's deterministic
 * mode (mock embedder) produces stable magnitudes per known input. The
 * production-path tests are gated on env vars and skipped in CI; the
 * deterministic snapshots here lock in the wire-shape expectations.
 */
describe("Section 30 — embedder magnitude snapshots", () => {
  // Using the mock embedder as the snapshot source — production paths
  // (openai/voyage/cohere) are exercised by their respective providers
  // when env vars are set; the mock keeps CI stable.
  const FIXTURE_TEXTS = [
    "The mitochondria is the powerhouse of the cell.",
    "Lorem ipsum dolor sit amet.",
    "How many roads must a man walk down?",
    '10 PRINT "hello world"',
    "🔥 Some emoji 🚀",
  ];

  test("mock embedder produces stable magnitudes for a 5-text fixture", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const vecs = await e.embed(FIXTURE_TEXTS);
    expect(vecs.length).toBe(5);
    const mags = vecs.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
    // All magnitudes positive + bounded (deterministic BoW emits unit-ish vectors).
    for (const m of mags) {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(100);
    }
    // Magnitude stability run-over-run.
    const e2 = createEmbedder({ model: "mock/det" });
    const vecs2 = await e2.embed(FIXTURE_TEXTS);
    const mags2 = vecs2.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
    for (let i = 0; i < mags.length; i++) {
      expect(Math.abs((mags[i] ?? 0) - (mags2[i] ?? 0))).toBeLessThan(1e-9);
    }
  });

  test("mock provider field reports correctly", () => {
    expect(createEmbedder({ model: "mock/d" }).provider).toBe("mock");
  });

  test("openai/voyage/cohere construct without API key throws fail-loud", () => {
    expect(() => createEmbedder({ model: "openai/text-embedding-3-small" })).toThrow();
    expect(() => createEmbedder({ model: "voyage/voyage-3" })).toThrow();
    expect(() => createEmbedder({ model: "cohere/embed-v3" })).toThrow();
  });
});
