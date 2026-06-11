import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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

// ---------------------------------------------------------------------------
// createEmbedder — provider branch coverage (env + explicit key).
// ---------------------------------------------------------------------------

/** Save/restore a single env var around a callback. */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

describe("createEmbedder — provider construction branches", () => {
  test("openai reads OPENAI_API_KEY from env when no explicit key", () => {
    withEnv("OPENAI_API_KEY", "sk-env", () => {
      const e = createEmbedder({ model: "openai/text-embedding-3-small" });
      expect(e.provider).toBe("openai");
      expect(e.model).toBe("text-embedding-3-small");
    });
  });

  test("openai accepts an explicit apiKey override", () => {
    withEnv("OPENAI_API_KEY", undefined, () => {
      const e = createEmbedder({ model: "openai/text-embedding-3-small", apiKey: "sk-explicit" });
      expect(e.provider).toBe("openai");
    });
  });

  test("voyage reads VOYAGE_API_KEY from env", () => {
    withEnv("VOYAGE_API_KEY", "voyage-env", () => {
      const e = createEmbedder({ model: "voyage/voyage-3" });
      expect(e.provider).toBe("voyage");
    });
  });

  test("voyage throws fail-loud when VOYAGE_API_KEY is empty", () => {
    withEnv("VOYAGE_API_KEY", "", () => {
      expect(() => createEmbedder({ model: "voyage/voyage-3" })).toThrow(/VOYAGE_API_KEY/);
    });
  });

  test("cohere reads COHERE_API_KEY from env", () => {
    withEnv("COHERE_API_KEY", "cohere-env", () => {
      const e = createEmbedder({ model: "cohere/embed-v3" });
      expect(e.provider).toBe("cohere");
    });
  });

  test("cohere throws fail-loud when COHERE_API_KEY is empty", () => {
    withEnv("COHERE_API_KEY", "", () => {
      expect(() => createEmbedder({ model: "cohere/embed-v3" })).toThrow(/COHERE_API_KEY/);
    });
  });

  test("local/ honors an explicit baseUrl override over the parsed one", () => {
    const e = createEmbedder({
      model: "local/x@http://parsed:1234",
      baseUrl: "http://override:5678",
    });
    expect(e.provider).toBe("local");
    expect(e.model).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// OpenAILikeEmbedder.embed — network path (fetch mocked, fully deterministic).
// ---------------------------------------------------------------------------

describe("OpenAILikeEmbedder.embed (mocked fetch)", () => {
  afterEach(() => {
    // spyOn(globalThis, "fetch") registers with bun's mock registry; restore
    // the real implementation after every test so nothing leaks across files.
    mock.restore();
  });

  test("empty input short-circuits without a network call", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const e = createEmbedder({ model: "openai/text-embedding-3-small", apiKey: "sk-x" });
    expect(await e.embed([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("posts to /v1/embeddings with an Authorization header and parses data", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "openai/text-embedding-3-small", apiKey: "sk-secret" });
    const out = await e.embed(["hello"]);

    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(capturedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-secret");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(capturedInit?.body)) as { model: string; input: string[] };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["hello"]);
    // No signal provided → fetch init must not carry one.
    expect(capturedInit?.signal ?? null).toBeNull();
  });

  test("local provider without an API key omits the Authorization header", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "local/nomic@http://localhost:11434" });
    const out = await e.embed(["x"]);

    expect(out).toEqual([[1, 0]]);
    const headers = capturedInit?.headers as Record<string, string>;
    expect("authorization" in headers).toBe(false);
  });

  test("respects a custom batchSize and concatenates batches in order", async () => {
    const batches: string[][] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { input: string[] };
      batches.push(parsed.input);
      // Echo one embedding per input text so we can verify ordering.
      const data = parsed.input.map((t) => ({ embedding: [t.length] }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "local/m@http://localhost:1234" });
    const out = await e.embed(["a", "bb", "ccc", "dddd", "eeeee"], { batchSize: 2 });

    // 5 texts / batchSize 2 → batches of [2, 2, 1].
    expect(batches).toEqual([["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
    expect(out).toEqual([[1], [2], [3], [4], [5]]);
  });

  test("forwards an AbortSignal to fetch", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const controller = new AbortController();
    const e = createEmbedder({ model: "local/m@http://localhost:1234" });
    await e.embed(["x"], { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  test("throws EmbedderError with status + body on a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      })) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "openai/text-embedding-3-small", apiKey: "sk-x" });
    await expect(e.embed(["x"])).rejects.toThrow(EmbedderError);
    await expect(e.embed(["x"])).rejects.toThrow(/429 rate limited/);
  });

  test("non-ok response with an unreadable body still throws (text() rejects)", async () => {
    // A Response whose .text() rejects exercises the `.catch(() => "")` arm.
    const brokenResponse = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("stream broken")),
    } as unknown as Response;
    const fetchImpl = (async () => brokenResponse) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "openai/text-embedding-3-small", apiKey: "sk-x" });
    // Body coerces to empty string → message ends at the status, no trailing text.
    await expect(e.embed(["x"])).rejects.toThrow(/500 $/);
  });

  test("a baseUrl already carrying /v1 is not doubled (URL-shape tolerance)", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "local/nomic@http://localhost:11434/v1" });
    await e.embed(["x"]);
    expect(capturedUrl).toBe("http://localhost:11434/v1/embeddings");
  });

  test("a baseUrl with a trailing slash + /v1/ also normalises", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "local/nomic@http://localhost:11434/v1/" });
    await e.embed(["x"]);
    expect(capturedUrl).toBe("http://localhost:11434/v1/embeddings");
  });

  test("cohere defaults to the /compatibility OpenAI-compat endpoint (bare host 404s)", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "cohere/embed-v4.0", apiKey: "co-x" });
    const out = await e.embed(["x"]);
    expect(out).toEqual([[0.5]]);
    expect(capturedUrl).toBe("https://api.cohere.ai/compatibility/v1/embeddings");
  });
});

// ---------------------------------------------------------------------------
// Gemini backend — REST embedContent (fetch mocked, fully deterministic).
// ---------------------------------------------------------------------------

describe("gemini embedder (mocked fetch)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("parses gemini/<model>", () => {
    expect(parseEmbedderModel("gemini/gemini-embedding-001")).toEqual({
      providerId: "gemini",
      modelId: "gemini-embedding-001",
    });
  });

  test("requires GEMINI_API_KEY or GOOGLE_API_KEY", () => {
    const prevGemini = process.env["GEMINI_API_KEY"];
    const prevGoogle = process.env["GOOGLE_API_KEY"];
    process.env["GEMINI_API_KEY"] = "";
    process.env["GOOGLE_API_KEY"] = "";
    try {
      expect(() => createEmbedder({ model: "gemini/gemini-embedding-001" })).toThrow(
        /GEMINI_API_KEY/,
      );
    } finally {
      process.env["GEMINI_API_KEY"] = prevGemini;
      process.env["GOOGLE_API_KEY"] = prevGoogle;
    }
  });

  test("falls back to GOOGLE_API_KEY when GEMINI_API_KEY is unset", () => {
    const prevGemini = process.env["GEMINI_API_KEY"];
    const prevGoogle = process.env["GOOGLE_API_KEY"];
    process.env["GEMINI_API_KEY"] = "";
    process.env["GOOGLE_API_KEY"] = "g-key";
    try {
      const e = createEmbedder({ model: "gemini/gemini-embedding-001" });
      expect(e.provider).toBe("gemini");
    } finally {
      process.env["GEMINI_API_KEY"] = prevGemini;
      process.env["GOOGLE_API_KEY"] = prevGoogle;
    }
  });

  test("POSTs models/<model>:embedContent with key query param + {content:{parts:[{text}]}} body and reads embedding.values", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "gemini/gemini-embedding-001", apiKey: "g-secret" });
    const out = await e.embed(["alpha", "beta"]);

    // One request per text (the endpoint takes a single content body).
    expect(calls.length).toBe(2);
    expect(out).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=g-secret",
    );
    expect(calls[0]?.body).toEqual({ content: { parts: [{ text: "alpha" }] } });
    expect(calls[1]?.body).toEqual({ content: { parts: [{ text: "beta" }] } });
  });

  test("empty input short-circuits without a network call", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const e = createEmbedder({ model: "gemini/gemini-embedding-001", apiKey: "g-x" });
    expect(await e.embed([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws EmbedderError on a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("permission denied", { status: 403 })) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "gemini/gemini-embedding-001", apiKey: "g-x" });
    await expect(e.embed(["x"])).rejects.toThrow(EmbedderError);
    await expect(e.embed(["x"])).rejects.toThrow(/403 permission denied/);
  });

  test("throws EmbedderError when the response carries no embedding.values", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ embedding: {} }), { status: 200 })) as unknown as typeof fetch;
    spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const e = createEmbedder({ model: "gemini/gemini-embedding-001", apiKey: "g-x" });
    await expect(e.embed(["x"])).rejects.toThrow(/embedding\.values/);
  });
});

// ---------------------------------------------------------------------------
// hashedBow — zero-norm branch (no alphanumeric tokens → all-zero vector).
// ---------------------------------------------------------------------------

describe("mock embedder — zero vector edge case", () => {
  test("punctuation/whitespace-only text yields an all-zero, non-normalised vector", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const [vec] = await e.embed(["   !!! ??? ---   "]);
    expect(vec?.length).toBe(256);
    // norm === 0 → returns the raw zero vector unchanged (no divide-by-zero).
    expect(vec?.every((x) => x === 0)).toBe(true);
  });

  test("empty string also yields an all-zero vector", async () => {
    const e = createEmbedder({ model: "mock/det" });
    const [vec] = await e.embed([""]);
    expect(vec?.every((x) => x === 0)).toBe(true);
  });
});
