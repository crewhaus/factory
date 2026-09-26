import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder } from "@crewhaus/embedder";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { createVectorStore } from "@crewhaus/vector-store";
import {
  DEFAULT_KNOWLEDGE_EMBEDDER_MODEL,
  type KnowledgeFetch,
  RetrieveConfigError,
  _resetRetrieveConfig,
  getRetrieveConfig,
  knowledgeRetrieve,
  knowledgeSourceLabel,
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

  // 0.7.1 (C042): the query goes to the embedding provider (and to an HTTP
  // vector store), so the egress classifier and the strict audit see it.
  test("flags: the pipeline Retrieve is external with ioCapability network before a config says otherwise", () => {
    expect([retrieve.scope, retrieve.ioCapability, retrieve.readOnly]).toEqual([
      "external",
      "network",
      true,
    ]);
    expect(auditToolScopes([retrieve])).toEqual([]);
  });

  // Review finding: the singleton was built before its config was known, so
  // the RAG starter's mock embedder over an in-memory store (nothing leaves
  // the process) was flagged network. Both hosts register the config first
  // and then read `retrieve` through the live binding.
  test("flags: once a config is registered, the pipeline Retrieve says where those backends are", async () => {
    const { embedder, vectorStore } = await seedStore();
    registerRetrieveConfig({ embedder, vectorStore });
    expect([retrieve.scope, retrieve.ioCapability]).toEqual(["internal", undefined]);
    expect(auditToolScopes([retrieve])).toEqual([]);
    const local = retrieve;
    expect(String(await local.execute({ query: "fox", k: 1 }))).toContain("[1]");

    registerRetrieveConfig({
      embedder: createEmbedder({ model: "openai/text-embedding-3-small", apiKey: "unused" }),
      vectorStore,
    });
    expect([retrieve.scope, retrieve.ioCapability]).toEqual(["external", "network"]);
    // A tool already flagged local keeps the config it was flagged for, so a
    // later registration cannot make it reach the network.
    expect(String(await local.execute({ query: "fox", k: 1 }))).toContain("[1]");

    _resetRetrieveConfig();
    expect([retrieve.scope, retrieve.ioCapability]).toEqual(["external", "network"]);
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

// 0.7.1 (C042) — a knowledge Retrieve says where its query goes. Only the
// in-process mock embedder over an in-memory or lance store stays local.
describe("knowledgeRetrieve flags follow its backends", () => {
  async function build(
    embedder: Parameters<typeof knowledgeRetrieve>[0]["embedder"],
    vectorStore: Parameters<typeof knowledgeRetrieve>[0]["vectorStore"],
  ) {
    return knowledgeRetrieve({
      sources: [{ kind: "url", url: "https://docs.example.com/a.md" }],
      embedder,
      vectorStore,
      fetch: async () => ({ ok: true, status: 200, text: async () => "refund policy body" }),
    });
  }
  const mock = () => createEmbedder({ model: "mock/det" });
  /** A provider outside the process, answering like the mock. */
  const hosted = () => {
    const inner = mock();
    return Object.assign(Object.create(inner) as typeof inner, { provider: "openai" as const });
  };

  test("a hosted embedder: external + network, readOnly kept", async () => {
    const tool = await build(hosted(), createVectorStore({ backend: "in-memory" }));
    expect([tool.scope, tool.ioCapability, tool.readOnly]).toEqual(["external", "network", true]);
    expect(auditToolScopes([tool])).toEqual([]);
  });

  test("an HTTP vector store: external + network even with the mock embedder", async () => {
    const memory = createVectorStore({ backend: "in-memory" });
    const remote = Object.assign(Object.create(memory) as typeof memory, {
      backend: "qdrant" as const,
    });
    const tool = await build(mock(), remote);
    expect([tool.scope, tool.ioCapability]).toEqual(["external", "network"]);
  });

  test("the mock embedder over an in-memory store stays internal", async () => {
    const tool = await build(mock(), createVectorStore({ backend: "in-memory" }));
    expect([tool.scope, tool.ioCapability]).toEqual(["internal", undefined]);
  });
});

// 0.7.1 (C057) — a credential in a knowledge source URL is fetched with, and
// never shown: not in a hit's id or doc, not in a boot error, not in its cause.
describe("knowledge url sources never show a credential", () => {
  // Built from parts at runtime, so the source holds no secret-shaped literal.
  const USER_TOKEN = ["ghp", "CANARY0123456789abcdef"].join("_");
  const QUERY_TOKEN = ["GHSAT0", "CANARYquerytoken"].join("");
  const SLASH_SECRET = ["wJalrXUtnFEMI", "K7MDENGbPx", "RfiCYCANARYKEY"].join("/");
  const CANARIES = [
    USER_TOKEN,
    QUERY_TOKEN,
    "CANARYquerytoken",
    "CANARY0123456789",
    "RfiCYCANARYKEY",
    "K7MDENGbPx",
  ];
  const leaked = (text: string): string[] => CANARIES.filter((c) => text.includes(c));

  const DIRTY = `https://deploy:${USER_TOKEN}@docs.example.com/h.md?token=${QUERY_TOKEN}&ref=main`;

  test("hits name the document by host and path, never its credential", async () => {
    const seen: string[] = [];
    const tool = await knowledgeRetrieve({
      sources: [{ kind: "url", url: DIRTY }],
      embedder: createEmbedder({ model: "mock/det" }),
      vectorStore: createVectorStore({ backend: "in-memory" }),
      fetch: async (url) => {
        seen.push(url);
        return { ok: true, status: 200, text: async () => "refunds are issued within 14 days" };
      },
    });
    // The URL is still fetched exactly as written.
    expect(seen).toEqual([DIRTY]);
    const out = (await tool.execute({ query: "refunds" })) as string;
    expect(leaked(out)).toEqual([]);
    expect(out).toContain("docs.example.com/h.md");
    expect(out).toContain("#src-");
  });

  test("labels: userinfo and credential params go, a clean URL and an npm @scope path stay as written", () => {
    const clean = [
      "https://example.com/doc",
      "https://example.com/doc?ref=main&page=2",
      "https://cdn.jsdelivr.net/npm/@scope/pkg/README.md",
      "https://api.example.com/doc?author=me@example.com",
    ];
    for (const url of clean) expect(knowledgeSourceLabel(url)).toBe(url);

    const dirty = [
      DIRTY,
      `https://docs.example.com/h.md?private_token=${QUERY_TOKEN}`,
      `https://AKIDEXAMPLE:${SLASH_SECRET}@docs.example.com/h.md`,
      // Digits then "/": parses as host AKIDEXAMPLE, port 1234, and a path
      // that holds the rest of the secret.
      `https://AKIDEXAMPLE:1234/${SLASH_SECRET}@docs.example.com/h.md`,
      `https://AKIDEXAMPLE:${USER_TOKEN}#frag@docs.example.com/h.md`,
      // Digits then "?": parses too, with the rest of the secret as a query.
      `https://AKIDEXAMPLE:12?${USER_TOKEN}@docs.example.com/h.md`,
      `not a url ${USER_TOKEN}@docs.example.com`,
    ];
    const labels = dirty.map((url) => ({
      url: url.slice(0, 12),
      label: knowledgeSourceLabel(url),
    }));
    expect(labels.filter((l) => leaked(l.label).length > 0)).toEqual([]);
    expect(knowledgeSourceLabel(DIRTY)).toMatch(
      /^https:\/\/<redacted>@docs\.example\.com\/h\.md\?token=REDACTED&ref=main#src-[0-9a-f]{12}$/,
    );
    expect(knowledgeSourceLabel(dirty[1] as string)).toMatch(
      /^https:\/\/docs\.example\.com\/h\.md\?private_token=.*#src-[0-9a-f]{12}$/,
    );
  });

  test("two sources differing only by a token stay distinct, and a label is the same on every boot", () => {
    const a = knowledgeSourceLabel("https://x.example/a?token=T1abcdefgh");
    const b = knowledgeSourceLabel("https://x.example/a?token=T2abcdefgh");
    expect(a).not.toBe(b);
    expect(knowledgeSourceLabel("https://x.example/a?token=T1abcdefgh")).toBe(a);
  });

  test("boot errors name the label, and the fetch's own error (which quotes the URL) is not carried", async () => {
    const notFound = await loadKnowledgeSources([{ kind: "url", url: DIRTY }], {
      fetch: async () => ({ ok: false, status: 404, text: async () => "" }),
    }).catch((err: unknown) => err as Error);
    expect(notFound).toBeInstanceOf(RetrieveConfigError);
    expect((notFound as Error).message).toContain("404");
    expect(leaked(Bun.inspect(notFound))).toEqual([]);

    const thrown = await loadKnowledgeSources([{ kind: "url", url: DIRTY }], {
      fetch: async (url) => {
        const err = new Error(`Unable to connect. Is the computer able to access the url? ${url}`);
        Object.assign(err, { code: "ConnectionRefused", path: url });
        throw err;
      },
    }).catch((err: unknown) => err as Error);
    expect(thrown).toBeInstanceOf(RetrieveConfigError);
    expect((thrown as Error).message).toContain("ConnectionRefused");
    expect(leaked(Bun.inspect(thrown))).toEqual([]);
    expect(leaked(String((thrown as { cause?: unknown }).cause))).toEqual([]);
  });

  test("a store indexed before 0.7.1, holding raw-URL ids, is shown redacted", async () => {
    const embedder = createEmbedder({ model: "mock/det" });
    const vectorStore = createVectorStore({ backend: "in-memory" });
    const oldDoc = `https://docs.example.com/h.md?token=${QUERY_TOKEN}`;
    const [vec] = await embedder.embed(["refund window"]);
    await vectorStore.upsert(`${oldDoc}:0:0`, vec ?? [], { docId: oldDoc, text: "refund window" });
    registerRetrieveConfig({ embedder, vectorStore });
    const out = (await retrieve.execute({ query: "refund window" })) as string;
    expect(out).toContain("docs.example.com/h.md");
    expect(leaked(out)).toEqual([]);
  });
});
