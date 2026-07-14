/**
 * Catalog F2 `target-research-bundle` — Section 23 RES.
 *
 * Codegen for the research target. Emits a single self-contained
 * daemon (`agent.ts`) that:
 *
 *   1. Parses CLI args:
 *        --goal "<override>"      override the spec goal
 *        --resume <runId>          resume a partially-completed run
 *        --branching <n>           override branchingFactor
 *   2. Mints a runId (or reuses the resumed one) and opens a citation
 *      tracker under `.crewhaus/research/<runId>/`.
 *   3. If the run-state checkpoint doesn't exist (or `--resume` was
 *      omitted), calls planner.decompose to produce N sub-questions.
 *      Persists the plan + initial state to
 *      `.crewhaus/research/<runId>/state.json`.
 *   4. For each not-yet-completed sub-question:
 *        - emits `branch_start { branchId, question }` to stdout
 *        - runs `runChatLoop({ singleTurn: true, tools: [Source, CiteFact, ...spec.tools] })`
 *        - captures the assistant's terminal text as the branch answer
 *        - extends `state.completedBranches` and persists the checkpoint
 *        - emits `branch_end { branchId, citationCount }`
 *      The branch loop respects `maxDurationMs` — exceeding it stops at
 *      the next branch boundary and the daemon writes a partial report.
 *   5. After all branches (or budget exit), assembles the final markdown
 *      + JSON report via `report-writer.writeReport` and writes them to
 *      `report.md` / `report.json` under the run dir. Emits `run_done`.
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrResearchV0,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr } from "@crewhaus/memory-service";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    initSymbol: "registerWebFetchConfig",
  },
  webSearch: { package: "@crewhaus/tool-web", export: "webSearch" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    initSymbol: "registerFetchConfig",
  },
};

function resolveTools(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): {
  imports: string[];
  inits: string[];
  registrations: string[];
} {
  if (toolNames.length === 0) return { imports: [], inits: [], registrations: [] };
  const byPackage = new Map<string, Set<string>>();
  const inits: string[] = [];
  const registrations: string[] = [];
  for (const name of toolNames) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const set = byPackage.get(entry.package) ?? new Set<string>();
    set.add(entry.export);
    byPackage.set(entry.package, set);
    if (entry.initSymbol !== undefined) {
      const cfg = toolConfigs[name];
      if (cfg !== undefined) {
        set.add(entry.initSymbol);
        inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
      }
    }
    registrations.push(`defaultCatalog.register(${entry.export});`);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

function renderPermissionsField(ir: IrResearchV0): string {
  // Source/CiteFact MUST be allowed for the daemon to function. We
  // always emit them at the flag layer regardless of what the spec
  // declared. Spec-supplied rules go under `yaml`; spec mode (if any)
  // sets `permissionMode`.
  const { mode, rules } = ir.permissions;
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`        permissionMode: ${escapeJsonString(mode)},`);
  }
  const yamlRuleLits =
    rules.length > 0
      ? rules
          .map(
            (r) =>
              `            { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
          )
          .join("\n")
      : "";
  lines.push(
    [
      "        permissionRules: {",
      "          flag: [",
      '            { type: "alwaysAllow", pattern: "Source", source: "flag" },',
      '            { type: "alwaysAllow", pattern: "CiteFact", source: "flag" },',
      "          ],",
      "          settings: [],",
      yamlRuleLits.length > 0
        ? `          yaml: [\n${yamlRuleLits}\n          ],`
        : "          yaml: [],",
      "          hooks: [],",
      "          builtin: BUILTIN_DEFAULT_RULES,",
      "        },",
    ].join("\n"),
  );
  return `\n${lines.join("\n")}`;
}

/**
 * Adaptive model routing — render the `modelPool` runChatLoop field.
 * JSON.stringify safely quotes the validated pool object (mirroring
 * target-cli's renderModelFailoverFields; keep the pipeline/research/batch/
 * browser copies in sync). Empty when the spec omits `model_pool`, keeping
 * bundles byte-identical.
 */
function poolField(ir: IrResearchV0, indent: string): string {
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
function taxonomyField(ir: IrResearchV0, indent: string): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n${indent}failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

export function emitResearchBundle(ir: IrResearchV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [{ path: "agent.ts", content: renderAgent(ir) }];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

/**
 * v0.3.0 PR 11 — the research shape's memory-fabric wiring state. `wired`
 * when the IR carries an enabled `memory` block and/or a `continuity` block
 * (DEFAULT-ON in 0.3.0 — only `continuity: false` removes it). Scope is
 * `spec`: every branch of every run shares the daemon's stores (§2.7).
 */
function memoryFabric(ir: IrResearchV0): { wired: boolean; fragmentJson: string } {
  const memoryOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const continuityOn = ir.continuity !== undefined;
  const wired = memoryOn || continuityOn;
  const fragmentJson = wired
    ? JSON.stringify(
        memoryFragmentFromIr({
          name: ir.name,
          ...(memoryOn ? { memory: ir.memory } : {}),
          ...(continuityOn ? { continuity: ir.continuity } : {}),
          // v0.3.0 Goal 2 (PR 17) — learning rides the fragment: wireMemory
          // renders the learning-loop skill + gates in /study /reflect.
          ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
        }),
      )
    : "";
  return { wired, fragmentJson };
}

function renderAgent(ir: IrResearchV0): string {
  const { imports: builtinImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const importBlock = builtinImports.length > 0 ? `${builtinImports.join("\n")}\n` : "";
  const initLines = inits.length > 0 ? `${inits.join("\n")}\n` : "";
  const registrationBlock =
    registrations.length > 0
      ? `\n// Spec-supplied tools registered at module load.\n${registrations.join("\n")}\n`
      : "";
  const permField = renderPermissionsField(ir);
  const fabric = memoryFabric(ir);
  const memImportBlock = fabric.wired
    ? `import { wireMemory } from "@crewhaus/memory-service";
import { createSkillTool } from "@crewhaus/skills-registry";
`
    : "";
  const memBootBlock = fabric.wired
    ? `
// v0.3.0 — the memory fabric, wired ONCE through the stable composition-root
// call (design §1 principle 1). Tools land on the shared defaultCatalog so
// every research branch carries them; the seams/skills thread into each
// branch's runChatLoop below.
const __memWired = await wireMemory(${fabric.fragmentJson}, { catalog: defaultCatalog, cwd: process.cwd() });
const __skills = __memWired.options.skills ?? [];
if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));
`
    : "";
  const memRunFields = fabric.wired
    ? `
    ...__memWired.options,`
    : "";
  // v0.3.0 Goal 3 — thredz is spec-carried on this shape but not emit-wired
  // in this release (the one-knob backend flip ships on cli). Surface it,
  // 0.2.3-style, so nobody wonders why their wiki stayed local.
  const thredzWarning =
    ir.thredz !== undefined
      ? "// note: thredz configured but ignored on research in 0.3.0 — the Thredz backend flip is wired on the cli shape (design §4)\n"
      : "";
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: research, ir version: ${ir.version})
${thredzWarning}import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createCitationTracker, newRunId } from "@crewhaus/citation-tracker";
import { createCrawler, createSourceTool, createCiteFactTool } from "@crewhaus/crawler";
import { formatRunFailure, toFailureReport } from "@crewhaus/errors";
import { decompose, type Plan } from "@crewhaus/planner";
import { writeReport, type BranchAnswer } from "@crewhaus/report-writer";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${memImportBlock}${importBlock}
${initLines}${registrationBlock}${memBootBlock}
type ResearchState = {
  readonly version: 1;
  readonly runId: string;
  readonly goal: string;
  readonly branchingFactor: number;
  plan: Plan;
  completedBranches: BranchAnswer[];
  status: "in_progress" | "done";
};

const SPEC_GOAL = ${escapeJsonString(ir.goal)};
const SPEC_BRANCHING = ${ir.branchingFactor};
const SPEC_MAX_DURATION_MS = ${ir.maxDurationMs};
const SPEC_MODEL = ${escapeJsonString(ir.agent.model)};
const SPEC_INSTRUCTIONS = ${escapeJsonString(ir.agent.instructions)};
const ALLOWED_ORIGINS = ${JSON.stringify(ir.retrieve.allowedOrigins)};
const ALLOWED_FILE_ROOTS = ${JSON.stringify(ir.retrieve.allowedFileRoots)};
const RESEARCH_ROOT = ".crewhaus/research";

function parseArgs(): { goal: string; resumeRunId: string | undefined; branchingFactor: number } {
  const args = process.argv.slice(2);
  let goal = SPEC_GOAL;
  let resumeRunId: string | undefined;
  let branchingFactor = SPEC_BRANCHING;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--goal" && i + 1 < args.length) {
      goal = String(args[++i]);
    } else if (a === "--resume" && i + 1 < args.length) {
      resumeRunId = String(args[++i]);
    } else if (a === "--branching" && i + 1 < args.length) {
      branchingFactor = Number(args[++i]);
    }
  }
  return { goal, resumeRunId, branchingFactor };
}

function statePath(runId: string): string {
  return join(RESEARCH_ROOT, runId, "state.json");
}

function loadState(runId: string): ResearchState | undefined {
  const p = statePath(runId);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as ResearchState;
}

function saveState(state: ResearchState): void {
  const p = statePath(state.runId);
  mkdirSync(join(RESEARCH_ROOT, state.runId), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(\`\${JSON.stringify(event)}\\n\`);
}

function listFileSources(roots: ReadonlyArray<string>, maxFiles = 50): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack: string[] = [root];
    while (stack.length > 0 && out.length < maxFiles) {
      const dir = stack.pop();
      if (dir === undefined) break;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries.sort()) {
        const abs = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(abs);
        else if (st.isFile()) out.push("file://" + abs);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out.sort();
}

async function runOneBranch(args: {
  branchId: string;
  question: string;
  goal: string;
  availableSources: ReadonlyArray<string>;
  tracker: ReturnType<typeof createCitationTracker>;
  crawler: ReturnType<typeof createCrawler>;
}): Promise<BranchAnswer> {
  let currentBranch: string | undefined = args.branchId;
  const sourceTool = createSourceTool({
    crawler: args.crawler,
    currentBranchId: () => currentBranch,
  });
  const citeFactTool = createCiteFactTool({
    tracker: args.tracker,
    currentBranchId: () => currentBranch,
  });
  const tools = [sourceTool, citeFactTool, ...defaultCatalog.list()];

  const beforeUrls = new Set(args.tracker.listFetches().map((f) => f.url));
  const sourcesBlock =
    args.availableSources.length > 0
      ? "\\n\\nAvailable sources (load each via Source(uri); subsequent calls cache):\\n" +
        args.availableSources.map((u) => "  - " + u).join("\\n")
      : "";
  const seedContent =
    "Research goal: " +
    args.goal +
    "\\n\\nFocus on: " +
    args.question +
    sourcesBlock;

  const runContext = createRunContext();
  const finalText = await runChatLoop({
    model: SPEC_MODEL,
    instructions: SPEC_INSTRUCTIONS,${poolField(ir, "    ")}${taxonomyField(ir, "    ")}
    runContext,
    sessionName: ${escapeJsonString(ir.name)},
    sessionTarget: "research",
    singleTurn: true,
    seedMessages: [{ role: "user", content: seedContent }],
    tools,
    installSigintHandler: false,
    maxTokens: 4096,${permField}${memRunFields}
  });

  // Citations recorded for this branch are append-only, so:
  //   citationUrls = (urls present after - urls present before)
  // is the set the model fetched on this branch. Same-URL cited
  // multiple times within the branch is collapsed by the report-writer
  // when numbering.
  const afterUrls = args.tracker.listFetches().map((f) => f.url);
  const newUrls = afterUrls.filter((u) => !beforeUrls.has(u));
  currentBranch = undefined;
  return {
    question: args.question,
    answer: finalText.trim(),
    citationUrls: newUrls,
  };
}

async function main(): Promise<void> {
  const { goal, resumeRunId, branchingFactor } = parseArgs();

  let state: ResearchState | undefined;
  let runId: string;
  if (resumeRunId !== undefined) {
    state = loadState(resumeRunId);
    if (state === undefined) {
      process.stderr.write(\`[research] no state found for runId \${resumeRunId}\\n\`);
      process.exit(2);
    }
    runId = resumeRunId;
    emit({ kind: "resume", runId, completedBranches: state.completedBranches.length });
  } else {
    runId = newRunId();
    emit({ kind: "run_start", runId, goal });
  }

  const tracker = createCitationTracker({ runId, rootDir: RESEARCH_ROOT });

  const allowedFileRootsAbs = ALLOWED_FILE_ROOTS.map((p) => resolvePath(p));
  const crawler = createCrawler({
    tracker,
    config: {
      allowedOrigins: new Set(ALLOWED_ORIGINS),
      allowedFileRoots: allowedFileRootsAbs,
    },
  });

  // Plan ----------------------------------------------------------------
  let plan: Plan;
  if (state !== undefined) {
    plan = state.plan;
    emit({ kind: "plan_loaded", subQuestions: plan.subQuestions });
  } else {
    emit({ kind: "plan_start", branchingFactor });
    plan = await decompose(goal, { model: SPEC_MODEL, branchingFactor });
    state = {
      version: 1,
      runId,
      goal,
      branchingFactor,
      plan,
      completedBranches: [],
      status: "in_progress",
    };
    saveState(state);
    emit({ kind: "plan_done", subQuestions: plan.subQuestions });
  }

  // Resolve available file sources ONCE — passed into every branch.
  const availableSources = listFileSources(allowedFileRootsAbs);
  if (availableSources.length > 0) {
    emit({ kind: "sources_resolved", count: availableSources.length });
  }

  // Branches ------------------------------------------------------------
  const startMs = Date.now();
  for (let i = state.completedBranches.length; i < plan.subQuestions.length; i++) {
    if (Date.now() - startMs > SPEC_MAX_DURATION_MS) {
      emit({ kind: "budget_exceeded", elapsedMs: Date.now() - startMs });
      break;
    }
    const branchId = "b" + i;
    const question = plan.subQuestions[i];
    if (question === undefined) continue;
    emit({ kind: "branch_start", branchId, question });
    const answer = await runOneBranch({
      branchId,
      question,
      goal,
      availableSources,
      tracker,
      crawler,
    });
    state.completedBranches = [...state.completedBranches, answer];
    saveState(state);
    emit({
      kind: "branch_end",
      branchId,
      citationCount: answer.citationUrls.length,
    });
  }

  // Report --------------------------------------------------------------
  state.status = state.completedBranches.length === plan.subQuestions.length ? "done" : "in_progress";
  saveState(state);

  const report = writeReport({
    goal,
    branches: state.completedBranches,
    citations: tracker.listCitationsOrdered(),
  });
  const reportDir = join(RESEARCH_ROOT, runId);
  writeFileSync(join(reportDir, "report.md"), report.markdown, { mode: 0o600 });
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report.json, null, 2), { mode: 0o600 });
  emit({ kind: "run_done", runId, reportPath: join(reportDir, "report.md"), citations: report.json.citations.length });
}

main().catch((err) => {
  // v0.3.0 Goal 6 — render the one structured failure report (classified
  // for a RunFailedError, generic otherwise) and exit with its coded
  // status instead of the bare "[research] fatal:" line + exit 1.
  const __report = toFailureReport(err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[research]" })}\\n\`);
  process.exit(__report.exitCode);
});
`;
}
