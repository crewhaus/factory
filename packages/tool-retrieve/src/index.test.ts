import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder } from "@crewhaus/embedder";
import { createVectorStore } from "@crewhaus/vector-store";
import {
  DEFAULT_KNOWLEDGE_EMBEDDER_MODEL,
  type KnowledgeFetch,
  RetrieveConfigError,
  _resetRetrieveConfig,
  getRetrieveConfig,
  knowledgeRetrieve,
  loadKnowledgeSources,
  registerRetrieveConfig,
  resolveKnowledgeEmbedder,
  retrieve,
} from "./index";

afterEach(() => {
  _resetRetrieveConfig();
});

async function seedStore(): Promise<{
  embedder: ReturnType<typeof createEmbedder>;
  vectorStore: ReturnType<typeof createVectorStore>;
}> {
  const embedder = createEmbedder({ model: "mock/det" });
  const vectorStore = createVectorStore({ backend: "in-memory" });
  const docs = [
    { id: "1", text: "the quick brown fox jumps over the lazy dog" },
    { id: "2", text: "lorem ipsum dolor sit amet" },
    { id: "3", text: "fox in socks on box" },
  ];
  const vectors = await embedder.embed(docs.map((d) => d.text));
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    const vec = vectors[i];
    if (doc === undefined) continue;
    await vectorStore.upsert(doc.id, vec ?? [], { docId: doc.id, text: doc.text });
  }
  return { embedder, vectorStore };
}

describe("Retrieve tool", () => {
  test("flags: readOnly + concurrencySafe", () => {
    expect(retrieve.readOnly).toBe(true);
    expect(retrieve.concurrencySafe).toBe(true);
    expect(retrieve.destructive).toBe(false);
  });

  test("rejects calls before registerRetrieveConfig", async () => {
    await expect(retrieve.execute({ query: "fox" })).rejects.toBeInstanceOf(RetrieveConfigError);
  });

  test("returns top-k hits as a numbered list with ids and previews", async () => {
    const { embedder, vectorStore } = await seedStore();
    registerRetrieveConfig({ embedder, vectorStore });
    const out = (await retrieve.execute({ query: "fox", k: 2 })) as string;
    expect(out).toContain("[1]");
    expect(out).toContain("[2]");
    expect(out).toContain("id=");
    expect(out).toContain("score=");
  });

  test("most relevant doc ranks first (mock embedder cosine sanity)", async () => {
    const { embedder, vectorStore } = await seedStore();
    registerRetrieveConfig({ embedder, vectorStore });
    const out = (await retrieve.execute({ query: "fox jumps lazy dog", k: 1 })) as string;
    // Expect the first-doc (closest match for the fox sentence) to win.
    expect(out).toContain("doc=1");
  });

  test("filter narrows to matching metadata", async () => {
    const { embedder, vectorStore } = await seedStore();
    // Add a tag.
    const v = (await embedder.embed(["the quick brown fox"]))[0] ?? [];
    await vectorStore.upsert("1", v, { docId: "1", text: "fox doc", tag: "alpha" });
    registerRetrieveConfig({ embedder, vectorStore });
    const out = (await retrieve.execute({
      query: "fox",
      k: 5,
      filter: { tag: "alpha" },
    })) as string;
    expect(out).toContain("doc=1");
  });

  test("filter injection rejected by vector-store's guard (T8)", async () => {
    const { embedder, vectorStore } = await seedStore();
    registerRetrieveConfig({ embedder, vectorStore });
    await expect(
      retrieve.execute({ query: "fox", filter: { "1=1; DROP TABLE": "x" } }),
    ).rejects.toThrow(/injection probe/);
  });

  test("default k=5 when no override is given", async () => {
    const { embedder, vectorStore } = await seedStore();
    registerRetrieveConfig({ embedder, vectorStore });
    const out = (await retrieve.execute({ query: "fox" })) as string;
    // Three docs in the store → still works without an explicit k
    expect(out).toContain("[3]");
  });
});

describe("registerRetrieveConfig variants", () => {
  test("can construct embedder + vectorStore from primitives", () => {
    registerRetrieveConfig({
      embedderModel: "mock/det",
      vectorBackend: "in-memory",
    });
    // No throw — config built lazily.
  });

  test("constructs a lance store from vectorBackend + url (on-disk index path)", () => {
    // Pass an explicit temp path so the test never writes the default
    // `.crewhaus/vectors/lance` dir into the working tree.
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-retrieve-lance-"));
    try {
      registerRetrieveConfig({ embedderModel: "mock/det", vectorBackend: "lance", url: dir });
      expect(getRetrieveConfig()?.vectorStore.backend).toBe("lance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("constructs an http (qdrant) store from vectorBackend + url + collection + apiKey", () => {
    registerRetrieveConfig({
      embedderModel: "mock/det",
      vectorBackend: "qdrant",
      url: "https://qdrant.example",
      collection: "docs",
      apiKey: "test-key",
    });
    expect(getRetrieveConfig()?.vectorStore.backend).toBe("qdrant");
  });

  test("an http backend missing url throws (config reaches the factory guard)", () => {
    expect(() =>
      registerRetrieveConfig({
        embedderModel: "mock/det",
        vectorBackend: "qdrant",
        collection: "docs",
      }),
    ).toThrow(/requires url/);
  });

  test("an http backend missing collection throws", () => {
    expect(() =>
      registerRetrieveConfig({
        embedderModel: "mock/det",
        vectorBackend: "weaviate",
        url: "https://weaviate.example",
      }),
    ).toThrow(/requires collection/);
  });
});

// ---------------------------------------------------------------------------
// Agent-shape RAG — knowledge: block (Batch E item 3/6, G22/G76)
// ---------------------------------------------------------------------------

describe("resolveKnowledgeEmbedder (G76 order)", () => {
  test("knowledge.embedder wins over everything", () => {
    expect(
      resolveKnowledgeEmbedder({
        knowledgeEmbedder: "openai/a",
        memoryEmbedder: "openai/b",
        wikiEmbedder: "openai/c",
        targetDefault: "openai/d",
      }),
    ).toBe("openai/a");
  });

  test("falls through knowledge → memory → wiki → targetDefault", () => {
    expect(resolveKnowledgeEmbedder({ memoryEmbedder: "openai/b", wikiEmbedder: "openai/c" })).toBe(
      "openai/b",
    );
    expect(resolveKnowledgeEmbedder({ wikiEmbedder: "openai/c" })).toBe("openai/c");
    expect(resolveKnowledgeEmbedder({ targetDefault: "openai/d" })).toBe("openai/d");
  });

  test("never degrades to BM25 — lands on the package default when all absent", () => {
    expect(resolveKnowledgeEmbedder({})).toBe(DEFAULT_KNOWLEDGE_EMBEDDER_MODEL);
  });

  test("blank/whitespace strings are skipped (not treated as declared)", () => {
    expect(resolveKnowledgeEmbedder({ knowledgeEmbedder: "  ", memoryEmbedder: "openai/b" })).toBe(
      "openai/b",
    );
    expect(resolveKnowledgeEmbedder({ knowledgeEmbedder: "" })).toBe(
      DEFAULT_KNOWLEDGE_EMBEDDER_MODEL,
    );
  });
});

describe("loadKnowledgeSources", () => {
  test("reads path + glob (sorted) + url sources into documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      writeFileSync(join(dir, "a.md"), "alpha content", "utf-8");
      writeFileSync(join(dir, "b.md"), "beta content", "utf-8");
      writeFileSync(join(dir, "note.txt"), "single file", "utf-8");
      const fetchStub: KnowledgeFetch = async (url) => ({
        ok: true,
        status: 200,
        text: async () => `remote body for ${url}`,
      });
      const docs = await loadKnowledgeSources(
        [
          { kind: "path", path: "note.txt" },
          { kind: "glob", glob: "*.md" },
          { kind: "url", url: "https://example.com/doc" },
        ],
        { cwd: dir, fetch: fetchStub },
      );
      expect(docs.map((d) => d.id)).toEqual([
        "note.txt",
        "a.md",
        "b.md",
        "https://example.com/doc",
      ]);
      expect(docs[0]?.text).toBe("single file");
      expect(docs[3]?.text).toBe("remote body for https://example.com/doc");
      // Each doc carries docId metadata for citations.
      expect(docs[1]?.metadata?.["docId"]).toBe("a.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing explicit path throws loudly (named)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      await expect(
        loadKnowledgeSources([{ kind: "path", path: "nope.md" }], { cwd: dir }),
      ).rejects.toThrow(/nope\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-ok url response throws with the status", async () => {
    const fetchStub: KnowledgeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => "",
    });
    await expect(
      loadKnowledgeSources([{ kind: "url", url: "https://x/y" }], { fetch: fetchStub }),
    ).rejects.toThrow(/503/);
  });

  test("a zero-match glob contributes nothing (not an error)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      const docs = await loadKnowledgeSources([{ kind: "glob", glob: "*.nomatch" }], { cwd: dir });
      expect(docs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("knowledgeRetrieve builder", () => {
  test("ingests sources and returns a working, self-contained Retrieve tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      writeFileSync(join(dir, "fox.md"), "the quick brown fox jumps over the lazy dog", "utf-8");
      writeFileSync(join(dir, "lorem.md"), "lorem ipsum dolor sit amet", "utf-8");
      const tool = await knowledgeRetrieve({
        sources: [{ kind: "glob", glob: "*.md" }],
        embedder: createEmbedder({ model: "mock/det" }),
        vectorStore: createVectorStore({ backend: "in-memory" }),
        cwd: dir,
      });
      expect(tool.name).toBe("Retrieve");
      expect(tool.readOnly).toBe(true);
      const out = (await tool.execute({ query: "fox jumps lazy dog", k: 1 })) as string;
      expect(out).toContain("[1]");
      expect(out).toContain("doc=fox.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT touch the pipeline activeConfig singleton", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      writeFileSync(join(dir, "x.md"), "some knowledge body", "utf-8");
      await knowledgeRetrieve({
        sources: [{ kind: "path", path: "x.md" }],
        embedder: createEmbedder({ model: "mock/det" }),
        vectorStore: createVectorStore({ backend: "in-memory" }),
        cwd: dir,
      });
      // The module singleton the pipeline shape uses is untouched.
      expect(getRetrieveConfig()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an empty sources list", async () => {
    await expect(
      knowledgeRetrieve({
        sources: [],
        embedder: createEmbedder({ model: "mock/det" }),
        vectorStore: createVectorStore({ backend: "in-memory" }),
      }),
    ).rejects.toBeInstanceOf(RetrieveConfigError);
  });

  test("throws when no embedder instance and no embedderModel is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      writeFileSync(join(dir, "x.md"), "body", "utf-8");
      await expect(
        knowledgeRetrieve({
          sources: [{ kind: "path", path: "x.md" }],
          vectorStore: createVectorStore({ backend: "in-memory" }),
          cwd: dir,
        }),
      ).rejects.toThrow(/embedder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honors defaultK when the model omits k", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-"));
    try {
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(join(dir, `d${i}.md`), `document number ${i} about foxes`, "utf-8");
      }
      const tool = await knowledgeRetrieve({
        sources: [{ kind: "glob", glob: "*.md" }],
        embedder: createEmbedder({ model: "mock/det" }),
        vectorStore: createVectorStore({ backend: "in-memory" }),
        defaultK: 2,
        cwd: dir,
      });
      const out = (await tool.execute({ query: "foxes" })) as string;
      expect(out).toContain("[2]");
      expect(out).not.toContain("[3]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
