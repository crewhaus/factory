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

  test("emits the IR-declared backend id (lance) verbatim", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      retrieve: { ...baseIr.retrieve, vectorBackend: "lance" },
    };
    const content = emitPipeline(ir).files[0]?.content ?? "";
    expect(content).toContain('createVectorStore({ backend: "lance" })');
  });

  test("surfaces url + collection + env-ref apiKey for an http backend", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      retrieve: {
        ...baseIr.retrieve,
        vectorBackend: "qdrant",
        url: "https://qdrant.example",
        collection: "docs",
        apiKey: { kind: "env", name: "QDRANT_API_KEY" },
      },
    };
    const content = emitPipeline(ir).files[0]?.content ?? "";
    expect(content).toContain(
      'createVectorStore({ backend: "qdrant", url: "https://qdrant.example", apiKey: process.env["QDRANT_API_KEY"], collection: "docs" })',
    );
  });

  test("a literal apiKey is emitted as a string literal (no env indirection)", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      retrieve: {
        ...baseIr.retrieve,
        vectorBackend: "pinecone",
        url: "https://pinecone.example",
        collection: "docs",
        apiKey: { kind: "literal", value: "pc-literal-key" },
      },
    };
    const content = emitPipeline(ir).files[0]?.content ?? "";
    expect(content).toContain(
      'createVectorStore({ backend: "pinecone", url: "https://pinecone.example", apiKey: "pc-literal-key", collection: "docs" })',
    );
  });

  test("an in-memory backend emits only the backend key (no stray config)", () => {
    const content = emitPipeline(baseIr).files[0]?.content ?? "";
    expect(content).toContain('createVectorStore({ backend: "in-memory" })');
    expect(content).not.toContain("apiKey:");
  });

  test("emits permissionMode when the IR carries a mode", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      permissions: { mode: "plan", rules: [] },
    };
    const content = emitPipeline(ir).files[0]?.content ?? "";
    expect(content).toContain('permissionMode: "plan",');
    // No rules → no permission-engine import and no permissionRules block.
    expect(content).not.toContain("BUILTIN_DEFAULT_RULES");
    expect(content).not.toContain("permissionRules:");
  });

  test("emits the permissionRules block + permission-engine import when rules are present", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      permissions: {
        mode: "default",
        rules: [
          { type: "alwaysAllow", pattern: "Read(*)" },
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
        ],
      },
    };
    const content = emitPipeline(ir).files[0]?.content ?? "";
    expect(content).toContain(
      'import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";',
    );
    expect(content).toContain('permissionMode: "default",');
    expect(content).toContain("permissionRules: {");
    expect(content).toContain("builtin: BUILTIN_DEFAULT_RULES,");
    // Each rule is rendered verbatim into the yaml lane with source "yaml".
    expect(content).toContain('{ type: "alwaysAllow", pattern: "Read(*)", source: "yaml" },');
    expect(content).toContain('{ type: "alwaysDeny", pattern: "Bash(rm *)", source: "yaml" },');
  });

  test("rules without an explicit mode emit permissionRules but no permissionMode", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      permissions: {
        rules: [{ type: "alwaysAsk", pattern: "Write(*)" }],
      },
    };
    const content = emitPipeline(ir).files[0]?.content ?? "";
    expect(content).not.toContain("permissionMode:");
    expect(content).toContain('{ type: "alwaysAsk", pattern: "Write(*)", source: "yaml" },');
    expect(content).toContain("flag: [],");
  });
});
