import { afterEach, describe, expect, test } from "bun:test";
import { createEmbedder } from "@crewhaus/embedder";
import { createVectorStore } from "@crewhaus/vector-store";
import {
  RetrieveConfigError,
  _resetRetrieveConfig,
  registerRetrieveConfig,
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
});
