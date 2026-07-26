import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrPipelineV0,
  type IrSecretRef,
  renderBundleReadme,
} from "@crewhaus/ir";

/**
 * Emit a RAG/pipeline bundle.
 *
 * The IR carries:
 *   - `indexing`: a sequence of components run once at boot to populate
 *     the vector store (e.g. chunk → embed → store).
 *   - `retrieve.embedderModel` + `retrieve.vectorBackend`: the embedder
 *     and vector-store config wired into `tool-retrieve`.
 *   - `agent.{model,instructions}`: the chat agent that uses the
 *     `Retrieve` tool to answer queries.
 *
 * The generated `agent.ts`:
 *   1. Boots the embedder, vector store, and `Retrieve` tool config.
 *   2. Indexes the seed documents listed in the spec
 *      (`indexing.documents`) at process start.
 *   3. Drops into the standard `runChatLoop` REPL with `Retrieve`
 *      registered.
 *
 * Layer F2. Pairs with `pipeline-engine`, `tool-retrieve`, `chunker`,
 * `embedder`, `vector-store`.
 */
/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — `emitPipeline` options.
 * `evalEntry: true` (set only by `crewhaus compile --with-eval-harness`)
 * additionally emits an exported `runForEval(input, opts)` entry: one
 * single-turn query through the SAME indexed pipeline agent + Retrieve tool
 * the REPL serves (module-scope indexing runs once at import — the deployed
 * boot), seeding any sample `history` MT-Bench style, threading the caller's
 * RunContext / `sessionRootDir` / `_adapter` seams — and guards the REPL
 * behind `import.meta.main` so the eval bundle can import the compiled
 * runtime without dropping into it. Absent (every existing caller), the
 * emission is byte-identical to before.
 */
export type EmitPipelineOptions = EmitReadmeOptions & { readonly evalEntry?: boolean };

export function emitPipeline(ir: IrPipelineV0, opts: EmitPipelineOptions = {}): Bundle {
  const files = [{ path: "agent.ts", content: renderAgent(ir, opts.evalEntry === true) }];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Render a vector-store API key as a JS expression. Env-refs become
 * `process.env["NAME"]` (resolved in the bundle at runtime, so the secret
 * never lands in the checked-in source); literals become an escaped string.
 */
function renderSecretExpr(ref: IrSecretRef): string {
  if (ref.kind === "env") return `process.env[${escapeJsonString(ref.name)}]`;
  return escapeJsonString(ref.value);
}

/**
 * Adaptive model routing — render the `modelPool` runChatLoop field.
 * JSON.stringify safely quotes the validated pool object (a plain object
 * literal, mirroring target-cli's renderModelFailoverFields; keep the
 * pipeline/research/batch/browser copies in sync). Empty when the spec omits
 * `model_pool`, keeping bundles byte-identical.
 */
function poolField(ir: IrPipelineV0, indent: string): string {
  return ir.agent.modelPool !== undefined
    ? `\n${indent}modelPool: ${JSON.stringify(ir.agent.modelPool)},`
    : "";
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field.
 * Empty when the spec omits the block (mirror: target-cli +
 * target-channel-bot render the same field; keep the pipeline/research/
 * batch/browser copies in sync).
 */
function taxonomyField(ir: IrPipelineV0, indent: string): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n${indent}failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Build the `createVectorStore({ ... })` call. Only the fields the IR
 * carries are emitted, so an `in-memory` pipeline stays byte-identical to
 * `createVectorStore({ backend: "in-memory" })`; remote/file backends add
 * their url/apiKey/collection. (The HTTP backends are guaranteed url +
 * collection by the spec parser, so this never emits an unrunnable call.)
 */
function renderVectorStoreCall(retrieve: IrPipelineV0["retrieve"]): string {
  const opts: string[] = [`backend: ${escapeJsonString(retrieve.vectorBackend)}`];
  if (retrieve.url !== undefined) opts.push(`url: ${escapeJsonString(retrieve.url)}`);
  if (retrieve.apiKey !== undefined) opts.push(`apiKey: ${renderSecretExpr(retrieve.apiKey)}`);
  if (retrieve.collection !== undefined) {
    opts.push(`collection: ${escapeJsonString(retrieve.collection)}`);
  }
  return `createVectorStore({ ${opts.join(", ")} })`;
}

function renderAgent(ir: IrPipelineV0, evalEntry = false): string {
  if (ir.indexing.documents.length === 0) {
    throw new TargetEmitError(
      `pipeline "${ir.name}" has zero indexing documents — supply at least one in indexing.documents`,
    );
  }
  const docsLiteral = JSON.stringify(ir.indexing.documents);
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permFieldLines: string[] = [];
  if (ir.permissions.mode !== undefined) {
    permFieldLines.push(`  permissionMode: ${escapeJsonString(ir.permissions.mode)},`);
  }
  if (hasRules) {
    const ruleLits = ir.permissions.rules
      .map(
        (r) =>
          `      { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    permFieldLines.push(
      [
        "  permissionRules: {",
        "    flag: [],",
        "    settings: [],",
        "    yaml: [",
        ruleLits,
        "    ],",
        "    hooks: [],",
        "    builtin: BUILTIN_DEFAULT_RULES,",
        "  },",
      ].join("\n"),
    );
  }
  const permField = permFieldLines.length > 0 ? `\n${permFieldLines.join("\n")}` : "";
  // Cluster S (D36/NEW-shape-1) — the shared REPL fields, reused verbatim by
  // the eval-entry's single-turn call so the two paths can never drift.
  const replCall = `runChatLoop({
  model: ${escapeJsonString(ir.agent.model)},
  instructions: ${escapeJsonString(ir.agent.instructions)},${poolField(ir, "  ")}${taxonomyField(ir, "  ")}
  sessionName: ${escapeJsonString(ir.name)},
  sessionTarget: "pipeline",
  tools: defaultCatalog.list(),${permField}
  hooks: __hooks,
  skills: __skills,
  slashCommands: __slashCommands,
})`;
  const evalEntryBlock = evalEntry
    ? `
/**
 * Eval bridge (cluster S, D36/NEW-shape-1) — one query through the indexed
 * pipeline: the SAME agent + Retrieve tool the REPL serves, as a single
 * graded turn. Sample \`history\` seeds the conversation MT-Bench style (the
 * pipeline is chat-capable); \`runContext\` threads the caller's trace bus,
 * \`sessionRootDir\` re-roots the session log, \`_adapter\` is the scripted-
 * provider test seam.
 */
export async function runForEval(
  __evalInput: string,
  __evalOpts: {
    runContext?: Parameters<typeof runChatLoop>[0]["runContext"];
    sessionRootDir?: string;
    history?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    _adapter?: Parameters<typeof runChatLoop>[0]["_adapter"];
  } = {},
): Promise<string> {
  return runChatLoop({
    model: ${escapeJsonString(ir.agent.model)},
    instructions: ${escapeJsonString(ir.agent.instructions)},${poolField(ir, "    ")}${taxonomyField(ir, "    ")}
    sessionName: ${escapeJsonString(ir.name)},
    sessionTarget: "pipeline",
    tools: defaultCatalog.list(),${permField
      .split("\n")
      .map((l) => (l.length > 0 ? `  ${l}` : l))
      .join("\n")}
    hooks: __hooks,
    skills: __skills,
    slashCommands: __slashCommands,
    singleTurn: true,
    seedMessages: [...(__evalOpts.history ?? []), { role: "user", content: __evalInput }],
    ...(__evalOpts.runContext !== undefined ? { runContext: __evalOpts.runContext } : {}),
    ...(__evalOpts.sessionRootDir !== undefined ? { sessionRootDir: __evalOpts.sessionRootDir } : {}),
    ...(__evalOpts._adapter !== undefined ? { _adapter: __evalOpts._adapter } : {}),
  });
}
`
    : "";
  const replBlock = evalEntry
    ? `${evalEntryBlock}
if (import.meta.main) {
  await ${replCall
    .split("\n")
    .map((l, i) => (i === 0 || l.length === 0 ? l : `  ${l}`))
    .join("\n")};
}`
    : `await ${replCall};`;
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: pipeline, ir version: ${ir.version})
import { runChatLoop } from "@crewhaus/runtime-core";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${permImport}
import { createPipeline } from "@crewhaus/pipeline-engine";
import { chunk } from "@crewhaus/chunker";
import { createEmbedder } from "@crewhaus/embedder";
import { createVectorStore } from "@crewhaus/vector-store";
import { registerRetrieveConfig, retrieve } from "@crewhaus/tool-retrieve";
import { loadHooks } from "@crewhaus/hooks-engine";
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";

const __embedder = createEmbedder({ model: ${escapeJsonString(ir.retrieve.embedderModel)} });
const __vectorStore = ${renderVectorStoreCall(ir.retrieve)};
registerRetrieveConfig({ embedder: __embedder, vectorStore: __vectorStore, defaultK: ${ir.retrieve.defaultK} });
defaultCatalog.register(retrieve);

const __indexingPipeline = createPipeline()
  .addComponent("chunk", async (inp) => {
    const docs = inp.docs as Array<{ id: string; text: string }>;
    const chunks = docs.flatMap((d) => chunk(d, { strategy: ${escapeJsonString(ir.indexing.chunkStrategy)}, size: ${ir.indexing.chunkSize}, overlap: ${ir.indexing.chunkOverlap} }));
    return { chunks };
  })
  .addComponent("embed", async (inp) => {
    const chunks = inp.chunks as Array<{ id: string; docId: string; text: string }>;
    const vectors = chunks.length === 0 ? [] : await __embedder.embed(chunks.map((c) => c.text));
    return { chunks, vectors };
  })
  .addComponent("store", async (inp) => {
    const chunks = inp.chunks as Array<{ id: string; docId: string; text: string }>;
    const vectors = inp.vectors as number[][];
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      const v = vectors[i];
      if (c === undefined || v === undefined) continue;
      await __vectorStore.upsert(c.id, v, { docId: c.docId, text: c.text });
    }
    return { count: await __vectorStore.count() };
  })
  .connect("chunk", "embed")
  .connect("embed", "store")
  .setOutput("store")
  .compile();

const __indexResult = await __indexingPipeline.run({ docs: ${docsLiteral} }, {
  onEvent: (e) => {
    process.stderr.write(\`[pipeline] \${JSON.stringify(e)}\\n\`);
  },
});
process.stderr.write(\`[pipeline] indexed \${(__indexResult as { count: number }).count} chunks\\n\`);

const __cwd = process.cwd();
const [__hooks, __skills, __slashCommands] = await Promise.all([
  loadHooks({ cwd: __cwd }),
  discoverSkills({ cwd: __cwd }),
  loadCommands({ cwd: __cwd }),
]);
if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));

${replBlock}
`;
}
