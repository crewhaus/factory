/**
 * Catalog F2 `target-browser-driver` — Section 25 BROW.
 *
 * Codegen for the computer-use target. Emits a single `agent.ts` that:
 *
 *   1. Constructs the chromium driver (Playwright-backed).
 *   2. Optionally navigates to `driver.startUrl` before agent input.
 *   3. Registers Navigate + Screenshot + Click + Type + Key + Scroll +
 *      FindElement as runtime tools. Destructive ones (Click, Type,
 *      Key, Scroll) sit at the `flag` rule layer and require explicit
 *      `alwaysAllow` rules — the smoke's permission-floor probe relies
 *      on this (same spec without `alwaysAllow` rules → denial cites
 *      destructive flag). Navigate, Screenshot and FindElement are
 *      default-allowed: Navigate is the agent's bootstrap (gating it
 *      would silently brick every browser spec without explicit rules);
 *      Screenshot and FindElement are read-only by design.
 *   4. Imports + registers every spec-declared built-in tool from
 *      `ir.tools` onto `defaultCatalog`, applying `ir.toolConfigs` for
 *      tools whose registration takes a config (currently `fetch` and
 *      `webFetch`). The interpreter path (`crewhaus run` →
 *      `runRunBrowser` in apps/cli) mirrors this same set — keep them
 *      in sync.
 *   5. Reads a single user prompt from `--prompt <text>` or stdin and
 *      runs `runChatLoop` in single-turn mode.
 *   6. On exit, calls driver.disconnect() so chromium doesn't leak.
 *
 * `ir.mcp_servers` and `ir.compaction` are intentionally not wired here:
 * the browser target is single-turn (`singleTurn: true`), so multi-turn-
 * only features have no surface to attach to. If the run path ever
 * extends these, mirror the change here too.
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrBrowserV0,
  renderBundleReadme,
} from "@crewhaus/ir";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Built-in tool name → package + export. Mirror of `loadToolMap()` in
 * `apps/cli/src/index.ts` — the `crewhaus run` browser path resolves the
 * same names to RegisteredTool instances. `initSymbol` is the optional
 * registration function called with the matching `toolConfigs[name]` blob
 * before the tool is registered (mirrors `applyToolConfigs()` in the run
 * path, which currently handles `fetch` and `webFetch`).
 */
type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
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
  readImage: { package: "@crewhaus/tool-image", export: "readImage" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    initSymbol: "registerFetchConfig",
  },
  imageGenerate: {
    package: "@crewhaus/tool-image-generation",
    export: "imageGenerate",
  },
  ingestDocument: {
    package: "@crewhaus/tool-document-ingest",
    export: "ingestDocument",
  },
  codegraphSearch: { package: "@crewhaus/tool-codegraph", export: "codegraphSearch" },
  codegraphCallers: { package: "@crewhaus/tool-codegraph", export: "codegraphCallers" },
  codegraphCallees: { package: "@crewhaus/tool-codegraph", export: "codegraphCallees" },
  codegraphImpact: { package: "@crewhaus/tool-codegraph", export: "codegraphImpact" },
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
  const registrations: string[] = [];
  const inits: string[] = [];
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

/**
 * Adaptive model routing — render the `modelPool` runChatLoop field.
 * JSON.stringify safely quotes the validated pool object (mirroring
 * target-cli's renderModelFailoverFields; keep the pipeline/research/batch/
 * browser copies in sync). Empty when the spec omits `model_pool`, keeping
 * bundles byte-identical.
 */
function poolField(ir: IrBrowserV0, indent: string): string {
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
function taxonomyField(ir: IrBrowserV0, indent: string): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n${indent}failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

export function emitBrowserDriver(ir: IrBrowserV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [{ path: "agent.ts", content: renderAgent(ir) }];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

function renderAgent(ir: IrBrowserV0): string {
  const startUrl = ir.driver.startUrl;
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);

  const { imports: toolImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const toolImportBlock = toolImports.length > 0 ? `${toolImports.join("\n")}\n` : "";
  const toolBootBlock =
    registrations.length > 0
      ? `\n${inits.length > 0 ? `${inits.join("\n")}\n` : ""}${registrations.join("\n")}\n`
      : "";
  // v0.3.0 — continuity is spec-carried on this shape but not emit-wired in
  // 0.3.0 (only the five agent-loop shapes are). Surface it, 0.2.3-style.
  const continuityWarning =
    ir.continuity !== undefined
      ? "// note: continuity configured but ignored on browser in 0.3.0\n"
      : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: browser, ir version: ${ir.version})
${continuityWarning}import { createDriver } from "@crewhaus/computer-use-driver";
import { createNavigateTool } from "@crewhaus/tool-navigate";
import { createScreenshotTool } from "@crewhaus/tool-screen-capture";
import { createAllMouseKeyboardTools } from "@crewhaus/tool-mouse-keyboard";
import { createFindElementTool } from "@crewhaus/tool-vision-grounding";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${toolImportBlock}${permImport}${toolBootBlock}
const SPEC_NAME = ${escapeJsonString(ir.name)};
const SPEC_MODEL = ${escapeJsonString(ir.agent.model)};
const SPEC_INSTRUCTIONS = ${escapeJsonString(ir.agent.instructions)};
const SPEC_GROUNDING_MODEL = ${escapeJsonString(ir.groundingModel)};
const SPEC_BACKEND: "host" | "chromium" | "remote" = ${escapeJsonString(ir.driver.backend)};
const SPEC_VIEWPORT = { width: ${ir.driver.viewport.width}, height: ${ir.driver.viewport.height} };
const SPEC_START_URL = ${startUrl !== undefined ? escapeJsonString(startUrl) : "undefined"};

function emit(event: Record<string, unknown>): void {
  process.stdout.write(\`\${JSON.stringify(event)}\\n\`);
}

function parseArgs(): { prompt: string | undefined } {
  const args = process.argv.slice(2);
  const i = args.indexOf("--prompt");
  if (i !== -1 && i + 1 < args.length) return { prompt: String(args[i + 1]) };
  return { prompt: undefined };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main(): Promise<void> {
  const { prompt: argPrompt } = parseArgs();
  const stdinPrompt = argPrompt ?? (await readStdin());
  if (stdinPrompt.length === 0) {
    process.stderr.write("[browser-driver] no prompt (pass --prompt <text> or pipe stdin)\\n");
    process.exit(2);
  }

  emit({ kind: "browser_start", backend: SPEC_BACKEND });
  const driver = createDriver({ backend: SPEC_BACKEND, viewport: SPEC_VIEWPORT });
  await driver.connect();
  if (SPEC_START_URL !== undefined) {
    await driver.goto(SPEC_START_URL);
    emit({ kind: "navigated", url: SPEC_START_URL });
  }

  const navigateTool = createNavigateTool({ driver });
  const screenshotTool = createScreenshotTool({ driver });
  const mk = createAllMouseKeyboardTools({ driver });
  const findElement = createFindElementTool({ driver, model: SPEC_GROUNDING_MODEL });
  const tools = [navigateTool, screenshotTool, mk.click, mk.type, mk.key, mk.scroll, findElement, ...defaultCatalog.list()];

  const runContext = createRunContext();
  let finalText = "";
  try {
    finalText = await runChatLoop({
      model: SPEC_MODEL,
      instructions: SPEC_INSTRUCTIONS,${poolField(ir, "      ")}${taxonomyField(ir, "      ")}
      runContext,
      sessionName: SPEC_NAME,
      sessionTarget: "browser",
      singleTurn: true,
      seedMessages: [{ role: "user", content: stdinPrompt }],
      tools,
      installSigintHandler: false,
      maxTokens: 4096,${permField}
    });
  } finally {
    await driver.disconnect();
  }
  emit({ kind: "browser_done", finalText });
}

main().catch((err) => {
  process.stderr.write(\`[browser-driver] fatal: \${(err as Error).message}\\n\`);
  process.exit(1);
});
`;
}

function renderPermissionsField(ir: IrBrowserV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`        permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `            { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "        permissionRules: {",
        "          flag: [],",
        "          settings: [],",
        "          yaml: [",
        ruleLits,
        "          ],",
        "          hooks: [],",
        "          builtin: BUILTIN_DEFAULT_RULES,",
        "        },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}
