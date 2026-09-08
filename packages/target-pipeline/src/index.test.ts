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
  test("emits agent.ts plus the generated README.md (item 42)", () => {
    const bundle = emitPipeline(baseIr);
    expect(bundle.files.length).toBe(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitPipeline(baseIr, { readme: false });
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

describe("emitPipeline — failureTaxonomy field (item 23)", () => {
  test("threads failureTaxonomy into the runChatLoop call", () => {
    const ir: IrPipelineV0 = {
      ...baseIr,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const c = emitPipeline(ir).files[0]?.content ?? "";
    expect(c).toContain("failureTaxonomy:");
    expect(c).toContain('"recovery":"retry"');
    expect(c).toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    expect(emitPipeline(baseIr).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrPipelineV0 = { ...baseIr, failureTaxonomy: [] };
    expect(emitPipeline(empty).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
  });
});

describe("emitPipeline — the pool's runtime closures reach the bundle (0.6.0 PR 9f)", () => {
  // Plan §11.3 marks `guide / shadow` **E** on the pipeline row and
  // `Consult / Escalate` **—** — the ONE cell in the four shapes 9f wires that
  // is not emit-wired. The table is the only ground for it: the pair is built
  // from the pool roster and ADDED to the tool list, so the shape could host
  // it. The emitter therefore passes its own §11.3 row and
  // a `model_directed`-only pool renders nothing at all; the compiler reports
  // that key as `model-plan-ignored-on-shape` instead.
  const candidates = [
    { model: "claude-haiku-4-5", tags: ["cheap"] },
    { model: "claude-opus-4-8", tags: ["strong"] },
  ];
  const code = (pool: unknown): string =>
    emitPipeline({
      ...baseIr,
      agent: { ...baseIr.agent, modelPool: pool },
    } as unknown as IrPipelineV0).files[0]?.content ?? "";

  test("guide + shadow: the bundle imports the composition root and spreads wireHybrid", () => {
    const c = code({
      candidates,
      policy: "heuristic",
      strategy: {
        guide: { model: "claude-opus-4-8", every: "first_turn" },
        shadow: { candidate: "claude-opus-4-8", sampleRate: 0.2 },
      },
    });
    expect(c).toContain('import { wireHybrid } from "@crewhaus/model-service";');
    expect(c).toContain("...wireHybrid({");
    // The declined family travels INTO the bundle, so the bundle applies the
    // same §11.3 restriction the interpreter would.
    expect(c).toContain(
      '{ sessionName: "hello-rag", hybridFamilies: ["classifier","sideCalls"] }),',
    );
  });

  test("the REPL call and the eval entry get the same wiring, at their own indents", () => {
    const c =
      emitPipeline(
        {
          ...baseIr,
          agent: {
            ...baseIr.agent,
            modelPool: {
              candidates,
              policy: "heuristic",
              strategy: { guide: { model: "claude-opus-4-8" } },
            },
          },
        } as unknown as IrPipelineV0,
        { evalEntry: true },
      ).files[0]?.content ?? "";
    const calls = c.split("\n").filter((l) => l.trim().startsWith("...wireHybrid("));
    expect(calls).toHaveLength(2);
    // Same call, same declined family, on both paths — they read one gate.
    expect(new Set(calls.map((l) => l.trim())).size).toBe(1);
    expect(calls[0]?.trim()).toContain('hybridFamilies: ["classifier","sideCalls"]');
  });

  test("policy: classifier wires the label call", () => {
    const c = code({
      candidates,
      policy: "classifier",
      classifier: { model: "claude-haiku-4-5", labels: { cheap: "easy", strong: "hard" } },
    });
    expect(c).toContain("...wireHybrid({");
  });

  test("model_directed alone: §11.3 marks the pair — on this shape, so nothing is rendered", () => {
    const c = code({ candidates, policy: "heuristic", strategy: { modelDirected: true } });
    expect(c).toContain('modelPool: {"candidates":');
    expect(c).not.toContain("wireHybrid");
    expect(c).not.toContain("@crewhaus/model-service");
  });

  test("model_directed BESIDE a guide: the call is rendered, the pair still declined", () => {
    const c = code({
      candidates,
      policy: "heuristic",
      strategy: { modelDirected: true, guide: { model: "claude-opus-4-8" } },
    });
    expect(c).toContain("...wireHybrid({");
    // The BLOB is verbatim — the key is lowered and carried, as on every other
    // shape — but the wiring call declines the family, so the bundle builds
    // the guide and no Consult / Escalate pair.
    expect(c).toContain('"strategy":{"modelDirected":true,"guide"');
    expect(c).toContain('hybridFamilies: ["classifier","sideCalls"]');
    expect(c).not.toContain('"modelDirected"]');
  });

  test("byte-identity: a pool with no closure-shaped key renders no call and no import", () => {
    const c = code({ candidates, policy: "heuristic" });
    expect(c).toContain('modelPool: {"candidates":');
    expect(c).not.toContain("wireHybrid");
    expect(c).not.toContain("@crewhaus/model-service");
  });

  test("byte-identity: no pool at all renders no call and no import", () => {
    const c = emitPipeline(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("wireHybrid");
    expect(c).not.toContain("@crewhaus/model-service");
  });
});
