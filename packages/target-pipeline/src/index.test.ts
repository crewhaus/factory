import { describe, expect, test } from "bun:test";
import type { IrPipelineV0 } from "@crewhaus/ir";
import { TargetEmitError, emitPipeline } from "./index";

const baseIr: IrPipelineV0 = {
  version: 0,
  name: "hello-rag",
  target: "pipeline",
  agent: {
    model: "claude-sonnet-4-6",
    instructions: "Use Retrieve to ground every answer.",
  },
  retrieve: {
    embedderModel: "mock/det",
    vectorBackend: "in-memory",
    defaultK: 5,
  },
  indexing: {
    chunkStrategy: "fixed",
    chunkSize: 200,
    chunkOverlap: 0,
    documents: [
      { id: "doc-1", text: "the quick brown fox jumps over the lazy dog" },
      { id: "doc-2", text: "lorem ipsum dolor sit amet consectetur adipiscing" },
    ],
  },
  permissions: { rules: [] },
  compaction: {},
};

describe("emitPipeline", () => {
  test("emits a single agent.ts file", () => {
    const bundle = emitPipeline(baseIr);
    expect(bundle.files.length).toBe(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("agent.ts wires the embedder + vector store with the IR-declared config", () => {
    const bundle = emitPipeline(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('createEmbedder({ model: "mock/det" })');
    expect(content).toContain('createVectorStore({ backend: "in-memory" })');
    expect(content).toContain("registerRetrieveConfig");
    expect(content).toContain("defaultCatalog.register(retrieve)");
  });

  test("agent.ts wires the indexing pipeline (chunk → embed → store)", () => {
    const bundle = emitPipeline(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('.addComponent("chunk"');
    expect(content).toContain('.addComponent("embed"');
    expect(content).toContain('.addComponent("store"');
    expect(content).toContain('.connect("chunk", "embed")');
    expect(content).toContain('.connect("embed", "store")');
  });

  test("agent.ts threads the chunk-strategy config through", () => {
    const bundle = emitPipeline(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('strategy: "fixed"');
    expect(content).toContain("size: 200");
  });

  test("includes the standard generated header", () => {
    const bundle = emitPipeline(baseIr);
    expect(bundle.files[0]?.content).toContain("DO NOT EDIT");
    expect(bundle.files[0]?.content).toContain("target: pipeline");
  });

  test("rejects empty indexing.documents", () => {
    const ir: IrPipelineV0 = { ...baseIr, indexing: { ...baseIr.indexing, documents: [] } };
    expect(() => emitPipeline(ir)).toThrow(TargetEmitError);
  });
});
