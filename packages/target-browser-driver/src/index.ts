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
 *   5. Reads user input and runs `runChatLoop`. Two modes (G51):
 *        - ONE-SHOT: a `--prompt <text>` value or piped stdin runs a single
 *          turn and exits (the pre-0.4 behaviour, for CI/scripting). Nobody
 *          is there to answer an `ask` permission, so this branch alone
 *          carries the G11 approval seam (`permissions.ask_mode`, default
 *          `pause`) and PARKS the turn instead of collapsing it to a deny.
 *        - REPL: an interactive TTY with no `--prompt` drops into the
 *          persistent driver REPL — the chromium context stays connected for
 *          the whole `runChatLoop` call, so the agent observes → acts →
 *          re-observes across turns against ONE session (mirror of
 *          `runRunCli`'s session mode).
 *      `--resume <sess_…>` reseats a specific prior session; `--continue`
 *      resolves the most-recently-updated session for this spec's name from
 *      the cwd session store. The resumed run is wrapped in `withIdempotency`
 *      (ITEM 7) so a duplicate re-invocation of an interrupted resumed run
 *      returns the cached reply instead of re-driving the browser. Loop
 *      contract 0.4 (Batch A) threads `agent.max_tokens` (spec value, else the
 *      pinned 4096), `budget:`, the `limits:` ceilings (`deadlineMs`/
 *      `turnTimeoutMs` bound each turn; `modelCallTimeoutMs` is the
 *      hung-stream watchdog) and spec `hooks:` into that call.
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

/**
 * Item 27 (Batch A extends it to this shape) — render the `budget`
 * runChatLoop field. The IR carries a numbers-and-literals object
 * (`usdMicros` + `onExceed`); `JSON.stringify` safely quotes the degrade
 * `model` string. Empty when the spec omits it, keeping pre-existing
 * bundles byte-identical. The browser loop is single-turn, so the cap
 * bounds ONE prompt→answer run. Mirror: target-cli + target-channel-bot +
 * target-managed + target-batch-worker render the same field.
 */
function budgetField(ir: IrBrowserV0, indent: string): string {
  if (ir.budget === undefined) return "";
  return `\n${indent}budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — thread the top-level `limits:` ceilings
 * into the single-turn `runChatLoop` call as the runtime's individual
 * top-level knobs, camelCase-mirroring the IR 1:1. Every knob is emitted
 * only when declared — the runtime owns every default — so existing
 * bundles stay byte-identical. On this shape `deadlineMs` and
 * `turnTimeoutMs` bound the SAME single turn (the run IS one turn); both
 * are still emitted verbatim so whichever is tighter fires first, and
 * `modelCallTimeoutMs` remains the hung-stream watchdog underneath them.
 * `limits.crew` never reaches this shape (crew-only; the spec rejects it
 * everywhere else). Mirror: target-cli + target-channel-bot +
 * target-managed + target-batch-worker render the same fields.
 */
function limitsFields(ir: IrBrowserV0, indent: string): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n${indent}maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n${indent}maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n${indent}contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n${indent}deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n${indent}turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n${indent}modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n${indent}loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
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
  // SECURITY — `driver.allowPrivateTargets` relaxes BOTH SSRF layers together:
  // the chromium backend's DNS-pinning proxy and the Navigate tool's pre-goto
  // guard. Emitted ONLY when the spec opts in, so an ordinary bundle is
  // byte-identical to 0.4.1. Waiving one layer alone would be worse than
  // waiving neither: with only the guard relaxed, the proxy answers loopback
  // with its own 403 body, which RENDERS, so the agent screenshots a block
  // page instead of failing cleanly.
  const allowPrivate = ir.driver.allowPrivateTargets === true;
  const allowPrivateField = allowPrivate ? ", ssrfProxy: false" : "";
  const allowPrivateNavField = allowPrivate ? ", allowPrivateTargets: true" : "";
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
  // Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks (`hooks:`).
  // IrHook is HookDef-shaped by contract (the spec ↔ hooks-engine
  // cross-check test pins the event union), so the JSON literal type-checks
  // against `runChatLoop({ hooks })` and declaration order is preserved
  // (hooks run in registration order). Absent/empty emits nothing so
  // pre-existing bundles stay byte-identical. Mirror: target-batch-worker
  // renders the same pieces.
  const specHooks = ir.hooks !== undefined && ir.hooks.length > 0 ? ir.hooks : undefined;
  const hooksImport =
    specHooks !== undefined ? `import type { HookDef } from "@crewhaus/hooks-engine";\n` : "";
  const hooksConst =
    specHooks !== undefined
      ? `\n// Loop contract 0.4 — spec-declared lifecycle hooks (registration order preserved).\nconst SPEC_HOOKS: ReadonlyArray<HookDef> = ${JSON.stringify(specHooks)};`
      : "";
  const hooksField = specHooks !== undefined ? "\n      hooks: SPEC_HOOKS," : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: browser, ir version: ${ir.version})
${continuityWarning}import { createDriver } from "@crewhaus/computer-use-driver";
import { createNavigateTool } from "@crewhaus/tool-navigate";
import { createScreenshotTool } from "@crewhaus/tool-screen-capture";
import { createAllMouseKeyboardTools } from "@crewhaus/tool-mouse-keyboard";
import { createFindElementTool } from "@crewhaus/tool-vision-grounding";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { defaultCatalog } from "@crewhaus/tool-catalog";
import { createSessionStore } from "@crewhaus/session-store";
import { createInMemoryIdempotencyStore, idempotencyKey, withIdempotency } from "@crewhaus/idempotency-keys";
${toolImportBlock}${hooksImport}${permImport}${toolBootBlock}
// Session ids round-trip through @crewhaus/session-store's path-traversal
// guard, so --resume ids must match its \`sess_<16 hex>\` shape.
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
const SPEC_NAME = ${escapeJsonString(ir.name)};
const SPEC_MODEL = ${escapeJsonString(ir.agent.model)};
const SPEC_INSTRUCTIONS = ${escapeJsonString(ir.agent.instructions)};
const SPEC_GROUNDING_MODEL = ${escapeJsonString(ir.groundingModel)};
const SPEC_BACKEND: "host" | "chromium" | "remote" = ${escapeJsonString(ir.driver.backend)};
const SPEC_VIEWPORT = { width: ${ir.driver.viewport.width}, height: ${ir.driver.viewport.height} };
const SPEC_START_URL = ${startUrl !== undefined ? escapeJsonString(startUrl) : "undefined"};${hooksConst}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(\`\${JSON.stringify(event)}\\n\`);
}

function parseArgs(): {
  prompt: string | undefined;
  resumeId: string | undefined;
  continueSession: boolean;
} {
  const args = process.argv.slice(2);
  const valueOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? String(args[i + 1]) : undefined;
  };
  return {
    prompt: valueOf("--prompt"),
    resumeId: valueOf("--resume"),
    continueSession: args.includes("--continue"),
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main(): Promise<void> {
  const { prompt: argPrompt, resumeId, continueSession } = parseArgs();
  if (resumeId !== undefined && continueSession) {
    process.stderr.write("[browser-driver] --resume and --continue are mutually exclusive\\n");
    process.exit(2);
  }
  if (resumeId !== undefined && !SESSION_ID_REGEX.test(resumeId)) {
    process.stderr.write(
      \`[browser-driver] invalid --resume sessionId "\${resumeId}" — expected sess_<16 hex>\\n\`,
    );
    process.exit(2);
  }

  // Resolve the session to resume: an explicit --resume id, or --continue → the
  // most-recently-updated session for this spec name in the cwd session store
  // (mirror of runRunCli's --continue). Absent → a fresh session.
  const sessionStore = createSessionStore();
  let resume: { sessionId: string } | undefined;
  if (resumeId !== undefined) {
    resume = { sessionId: resumeId };
  } else if (continueSession) {
    const sessions = await sessionStore.list();
    const match = sessions.find((s) => s.name === SPEC_NAME);
    if (match === undefined) {
      process.stderr.write(
        \`[browser-driver] no prior session for "\${SPEC_NAME}" to --continue in \${process.cwd()}/.crewhaus/sessions/\\n\`,
      );
      process.exit(2);
    }
    resume = { sessionId: match.id };
    process.stdout.write(\`[browser-driver] resuming session \${match.id}\\n\`);
  }

  // ONE-SHOT when a --prompt is supplied or stdin is piped (CI/scripting); an
  // interactive TTY with no --prompt drops into the persistent driver REPL, so
  // the agent observes → acts → re-observes across turns against one session.
  const repl = argPrompt === undefined && process.stdin.isTTY === true;
  const oneShotPrompt = repl ? "" : (argPrompt ?? (await readStdin()));
  if (!repl && oneShotPrompt.length === 0) {
    process.stderr.write("[browser-driver] no prompt (pass --prompt <text> or pipe stdin)\\n");
    process.exit(2);
  }

  emit({ kind: "browser_start", backend: SPEC_BACKEND });
  const driver = createDriver({ backend: SPEC_BACKEND, viewport: SPEC_VIEWPORT${allowPrivateField} });
  await driver.connect();
  if (SPEC_START_URL !== undefined) {
    await driver.goto(SPEC_START_URL);
    emit({ kind: "navigated", url: SPEC_START_URL });
  }

  const navigateTool = createNavigateTool({ driver${allowPrivateNavField} });
  const screenshotTool = createScreenshotTool({ driver });
  const mk = createAllMouseKeyboardTools({ driver });
  const findElement = createFindElementTool({ driver, model: SPEC_GROUNDING_MODEL });
  const tools = [navigateTool, screenshotTool, mk.click, mk.type, mk.key, mk.scroll, findElement, ...defaultCatalog.list()];

  // On resume the run context must carry the resumed sessionId (runtime-core
  // asserts they match); a fresh run mints its own.
  const runContext =
    resume !== undefined ? createRunContext({ sessionId: resume.sessionId }) : createRunContext();
  // Session-persist driver state across turns: the driver stays connected for
  // the whole runChatLoop call, so every REPL turn shares one live browser
  // context. limits/budget/max_tokens (Batch A) apply to each turn.
  const runOptions = {
    model: SPEC_MODEL,
    instructions: SPEC_INSTRUCTIONS,${poolField(ir, "    ")}${taxonomyField(ir, "    ")}
    runContext,
    sessionName: SPEC_NAME,
    sessionTarget: "browser" as const,
    tools,
    maxTokens: ${ir.agent.maxTokens ?? 4096},${budgetField(ir, "    ")}${limitsFields(ir, "    ")}${hooksField}${permField}
  };

  // G11 — a compiled bundle is NON-INTERACTIVE: a tool that lands on \`ask\`
  // has nobody to prompt, so without this it collapsed to a deny. Rooted
  // where the run's session files land, so parks live beside them (and
  // inside a tenant's rebased root when one is active). No I/O until a park.
  const __approvalRoot = resolveSessionRootDir(undefined);
  const __approvals = createPendingApprovalStore(
    __approvalRoot !== undefined ? { rootDir: __approvalRoot } : {},
  );

  // The REPL lets runChatLoop drive stdin turn-by-turn (singleTurn omitted);
  // one-shot seeds the single inbound message. \`resume\` + \`seedMessages\` is
  // legal ONLY under singleTurn (the seed is the new inbound, the replayed
  // history is the prefix), so REPL resume passes no seed.
  const drive = async (): Promise<string> => {
    if (repl) {
      return await runChatLoop({
        ...runOptions,
        installSigintHandler: true,
        ...(resume !== undefined ? { resume } : {}),
      });
    }
    return await runChatLoop({
      ...runOptions,
      singleTurn: true,
      installSigintHandler: false,${renderApprovalFields(ir, "      ")}
      seedMessages: [{ role: "user", content: oneShotPrompt }],
      ...(resume !== undefined ? { resume } : {}),
    });
  };

  let finalText = "";
  try {
    if (resume !== undefined) {
      // ITEM 7 — wrap the resume path in withIdempotency so a duplicate
      // re-invocation of an interrupted resumed run returns the cached reply
      // instead of re-driving the browser (at-least-once safety).
      const idemStore = createInMemoryIdempotencyStore<string>();
      const guarded = withIdempotency<undefined, string>(() => drive(), {
        store: idemStore,
        ttlMs: 3_600_000,
      });
      const key = idempotencyKey(\`\${SPEC_NAME}:\${resume.sessionId}:\${oneShotPrompt}\`, 0);
      finalText = (await guarded(undefined, key)).value;
    } else {
      finalText = await drive();
    }
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

/**
 * Loop contract 0.4 (G11) — the `askMode` + `approvals` fields. Unlike the
 * CLI's `approvalRunOptions`, a bundle parses no `--ask-mode`, so the spec
 * value is FIXED here at emit time. Deliberately NOT folded into
 * `renderPermissionsField`: that one early-returns "" when the spec declares
 * no `permissions:` block, which is exactly the case where parking matters
 * most — with no block every unmatched tool resolves to `ask`.
 *
 * The store is rendered UNCONDITIONALLY, including under `"deny"` where it
 * never parks, so runtime-core's diagnostic can honestly say `ask_mode:
 * "deny"` instead of blaming absent plumbing (it branches on `approvals ===
 * undefined`).
 *
 * One-shot ONLY. The REPL branch spreads `runOptions`, and a REPL prompts on
 * stdin — parking a turn that has a human sitting at it would be wrong.
 */
function renderApprovalFields(ir: IrBrowserV0, indent: string): string {
  return (
    `\n${indent}askMode: ${escapeJsonString(ir.permissions.askMode ?? "pause")},` +
    `\n${indent}approvals: { store: __approvals, surface: "browser" },`
  );
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
