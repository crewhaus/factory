import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Loop contract 0.4 (Batch E, G22) — unit tests for `knowledge:` RAG
 * ingestion on the interpreter path. The embedder/fetch/glob seams are
 * injected (a `mock/` embedder + fixture loaders), so the full
 * load → chunk → embed → index → Retrieve flow runs without a provider key or
 * the network. End-to-end retrieval is exercised against the real
 * `@crewhaus/tool-retrieve` engine, not a hand-built fixture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder } from "@crewhaus/embedder";
import { ConfigError } from "@crewhaus/errors";
import type { IrKnowledge } from "@crewhaus/ir";
import { _resetRetrieveConfig, getRetrieveConfig } from "@crewhaus/tool-retrieve";
import {
  DEFAULT_KNOWLEDGE_EMBEDDER_MODEL,
  ingestKnowledge,
  loadKnowledgeSources,
  resolveKnowledgeEmbedderModel,
} from "./knowledge-ingest";

const mockEmbedder = createEmbedder({ model: "mock/test" });

function knowledge(overrides: Partial<IrKnowledge> = {}): IrKnowledge {
  return {
    vectorBackend: "in-memory",
    defaultK: 5,
    chunkSize: 400,
    chunkOverlap: 0,
    sources: [],
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ch-knowledge-"));
  _resetRetrieveConfig();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _resetRetrieveConfig();
});

describe("resolveKnowledgeEmbedderModel (G76 ladder)", () => {
  test("knowledge.embedder wins over every fallback", () => {
    expect(
      resolveKnowledgeEmbedderModel(knowledge({ embedder: "voyage/v3" }), "openai/m", "cohere/w"),
    ).toBe("voyage/v3");
  });

  test("falls back to memory.embedder, then wiki.embedder, then the default", () => {
    expect(resolveKnowledgeEmbedderModel(knowledge(), "openai/mem", "cohere/wiki")).toBe(
      "openai/mem",
    );
    expect(resolveKnowledgeEmbedderModel(knowledge(), undefined, "cohere/wiki")).toBe(
      "cohere/wiki",
    );
    expect(resolveKnowledgeEmbedderModel(knowledge())).toBe(DEFAULT_KNOWLEDGE_EMBEDDER_MODEL);
  });
});

describe("loadKnowledgeSources", () => {
  test("reads a path source relative to cwd", async () => {
    writeFileSync(join(dir, "guide.md"), "hello from the guide");
    const docs = await loadKnowledgeSources([{ kind: "path", path: "guide.md" }], { cwd: dir });
    expect(docs).toEqual([{ id: "guide.md", text: "hello from the guide" }]);
  });

  test("expands a glob source into one sorted document per match", async () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "a.md"), "alpha");
    writeFileSync(join(dir, "docs", "b.md"), "bravo");
    // globScan is injected (unsorted); the loader sorts and reads each match.
    const docs = await loadKnowledgeSources([{ kind: "glob", glob: "docs/**/*.md" }], {
      cwd: dir,
      globScan: () => ["docs/b.md", "docs/a.md"],
    });
    expect(docs.map((d) => d.id)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(docs.map((d) => d.text)).toEqual(["alpha", "bravo"]);
  });

  test("fetches a url source as text via the injected fetch", async () => {
    const docs = await loadKnowledgeSources([{ kind: "url", url: "https://x/faq" }], {
      cwd: dir,
      fetchImpl: (async () => new Response("faq body", { status: 200 })) as unknown as typeof fetch,
    });
    expect(docs).toEqual([{ id: "https://x/faq", text: "faq body" }]);
  });

  test("throws ConfigError naming a missing path source", async () => {
    await expect(
      loadKnowledgeSources([{ kind: "path", path: "nope.md" }], { cwd: dir }),
    ).rejects.toThrow(ConfigError);
  });

  test("throws ConfigError on a non-2xx url source", async () => {
    await expect(
      loadKnowledgeSources([{ kind: "url", url: "https://x/gone" }], {
        cwd: dir,
        fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("ingestKnowledge", () => {
  test("indexes sources and returns a Retrieve tool that answers from the corpus", async () => {
    writeFileSync(join(dir, "cats.md"), "Cats are small domesticated feline mammals.");
    writeFileSync(join(dir, "boats.md"), "Boats are watercraft that float on rivers and seas.");
    const logs: string[] = [];
    const tool = await ingestKnowledge(
      knowledge({
        defaultK: 2,
        sources: [
          { kind: "path", path: "cats.md" },
          { kind: "path", path: "boats.md" },
        ],
      }),
      { cwd: dir, embedder: mockEmbedder, log: (l) => logs.push(l) },
    );

    expect(tool.name).toBe("Retrieve");
    // The config the tool reads was registered with the resolved defaultK.
    expect(getRetrieveConfig()?.defaultK).toBe(2);
    expect(logs.join("")).toContain("indexed");
    expect(logs.join("")).toContain("2 source document(s)");

    const hits = await tool.execute({ query: "tell me about feline mammals" });
    expect(typeof hits).toBe("string");
    expect(hits as string).toContain("cats.md");
  });

  test("chunks with the resolved size/overlap so a long doc yields multiple hits", async () => {
    const long = `${"para one ".repeat(30)}\n\n${"para two ".repeat(30)}`;
    writeFileSync(join(dir, "long.md"), long);
    const tool = await ingestKnowledge(
      knowledge({ chunkSize: 80, chunkOverlap: 10, sources: [{ kind: "path", path: "long.md" }] }),
      { cwd: dir, embedder: mockEmbedder },
    );
    const hits = (await tool.execute({ query: "para one" })) as string;
    expect(hits).toContain("long.md");
  });

  test("registers config even when the corpus is empty (Retrieve returns no hits)", async () => {
    writeFileSync(join(dir, "empty.md"), "");
    const tool = await ingestKnowledge(
      knowledge({ sources: [{ kind: "path", path: "empty.md" }] }),
      { cwd: dir, embedder: mockEmbedder },
    );
    expect(getRetrieveConfig()).toBeDefined();
    const hits = (await tool.execute({ query: "anything" })) as string;
    expect(hits).toBe("no hits");
  });
});
