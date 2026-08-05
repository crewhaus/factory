/**
 * Generated-bundle README renderer (AUTOMATION-OPPORTUNITIES.md item 42).
 *
 * Every target emitter drops a `README.md` into its compiled bundle so a
 * user who cd's into an out-dir can see — without reading generated code —
 * what the harness is, which tools/MCP servers it wires, WHICH ENV VARS it
 * needs, and how to launch it. The renderer lives here in `@crewhaus/ir`
 * because it is a pure function over the lowered IR and this is the one
 * package every `target-*` emitter already depends on (adding it here
 * creates zero new dependency edges; `packages/compiler` sits *downstream*
 * of the emitters, so it cannot be the seam).
 *
 * Security invariant: secret refs lowered to `{ kind: "literal" }` are
 * NEVER printed — the README only names `{ kind: "env" }` variables. A
 * literal credential is already a spec smell (see `lowerCredential` in
 * `packages/compiler`), and the README must not widen the blast radius by
 * copying the value into a second, more-readable artifact.
 */
import type { IrMcpServers, IrNode } from "./index";
import { OPAQUE_TOKEN_RE, maskCredentialTokens } from "./redact";

/**
 * Common emitter option controlling README.md emission. Default ON;
 * `crewhaus compile --no-readme` threads `readme: false` through
 * `CompileOptions` to every target emitter.
 */
export type EmitReadmeOptions = {
  readonly readme?: boolean;
};

/**
 * Machine-checkable marker embedded in every generated README. The CLI's
 * `compile` write path uses it to distinguish a previously-generated
 * README (safe to overwrite on recompile) from a user-authored one
 * (kept, with a notice).
 */
export const GENERATED_README_MARKER = "<!-- crewhaus:generated-readme -->";

/** A README section: markdown heading text + markdown body. */
export type BundleReadmeSection = {
  readonly heading: string;
  readonly body: string;
};

export type BundleReadmeOptions = {
  /** One-line description under the title. Defaults to a generated line. */
  readonly description?: string;
  /**
   * Replace the default per-target Run section (e.g. the cf-worker
   * emitters substitute a `wrangler deploy` flow, the claude-plugin
   * emitter an Install note).
   */
  readonly usage?: BundleReadmeSection;
  /** Include the `.crewhaus/` runtime-data note. Default true. */
  readonly includeWorkspaceNote?: boolean;
  /** Extra sections appended at the end (e.g. claude-plugin's Origin). */
  readonly extraSections?: readonly BundleReadmeSection[];
};

/**
 * Every env var / redacted-literal count referenced by a lowered IR's
 * secret-shaped fields (`IrSecretRef`), gathered via a recursive walk so
 * variant-specific nesting (channel credentials, chain `rpcUrls`, wallet
 * `keyRef`, pipeline `retrieve.apiKey`, …) is covered without coupling to
 * each variant's shape — the same discipline as `collectToolNames` in
 * `packages/compiler`.
 */
export type CollectedSecretRefs = {
  /** Deduped, sorted `{ kind: "env" }` variable names. */
  readonly envNames: readonly string[];
  /** How many `{ kind: "literal" }` refs were found. Values are REDACTED. */
  readonly literalCount: number;
};

/**
 * Literal refs under these keys are COMPILER-SYNTHESIZED configuration
 * knobs (v0.3.0 `thredz:` lowering — visibility enforcement + self-hosted
 * base URL), not user-supplied secrets: counting them would print the
 * "supplied as literals in the spec" warning on every one-knob
 * `thredz: true` spec whose author supplied nothing literal at all. Scoped
 * to exactly these names so every user-declared literal keeps warning.
 */
const SYNTHESIZED_LITERAL_KEYS: ReadonlySet<string> = new Set([
  "THREDZ_DEFAULT_VISIBILITY",
  "THREDZ_DEFAULT_SPACE",
  "THREDZ_API_BASE",
]);

export function collectSecretRefs(ir: unknown): CollectedSecretRefs {
  const envNames = new Set<string>();
  let literalCount = 0;
  const visit = (node: unknown, parentKey?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentKey);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // Match the IrSecretRef discriminants exactly. Other IR unions also
    // carry a `kind` key (`IrChainFinality`, `IrSchemaRef`, triggers) but
    // none uses the values "env"/"literal", so this cannot misfire.
    if (record["kind"] === "env" && typeof record["name"] === "string") {
      envNames.add(record["name"]);
    } else if (record["kind"] === "literal" && typeof record["value"] === "string") {
      if (parentKey === undefined || !SYNTHESIZED_LITERAL_KEYS.has(parentKey)) {
        literalCount += 1;
      }
    }
    for (const [key, value] of Object.entries(record)) visit(value, key);
  };
  visit(ir);
  return { envNames: [...envNames].sort(), literalCount };
}

/**
 * Per-shape launch one-liner, derived from each emitter's output layout:
 * shapes that emit a `daemon.ts` entrypoint (channel / managed / crew /
 * voice) launch that; every other shape's entrypoint is `agent.ts`.
 */
const RUN_COMMANDS: Record<IrNode["target"], string> = {
  cli: "bun agent.ts",
  workflow: "bun agent.ts",
  channel: "bun daemon.ts",
  graph: "bun agent.ts",
  managed: "bun daemon.ts",
  pipeline: "bun agent.ts",
  crew: "bun daemon.ts",
  research: "bun agent.ts",
  batch: "bun agent.ts",
  voice: "bun daemon.ts",
  browser: "bun agent.ts",
  eval: "bun agent.ts",
  onchain: "bun agent.ts",
  "onchain-game": "bun agent.ts",
};

/**
 * Definitionally outward-reaching tool names, in both the spec-key
 * (camelCase) and registered (PascalCase) forms the IR can carry. Mirrors
 * `OUTWARD_TOOL_NAMES` in `@crewhaus/tool-builder` — the canonical rule —
 * but kept inline (exactly as `IrVectorBackend` mirrors `vector-store`)
 * so the runtime-agnostic IR keeps its zero package dependencies. Keep in
 * sync when a name is added or removed.
 */
const OUTWARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "fetch",
  "Fetch",
  "webFetch",
  "WebFetch",
  "webSearch",
  "WebSearch",
  "sendMessage",
  "SendMessage",
  "evmSendTransaction",
  "EvmSendTransaction",
  "imageGenerate",
  "ImageGenerate",
]);

/** Tools executed inside the §18 sandbox (see `target-cli`'s sandbox gate). */
const SANDBOXED_TOOL_NAMES: ReadonlySet<string> = new Set(["python", "javascript", "shell"]);

/**
 * Tools that `requireJustification: true` by default (the Pillar 3 intent
 * gate — see AGENTS.md). Both name forms, same mirroring caveat as above.
 */
const JUSTIFICATION_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sendMessage",
  "SendMessage",
  "evmSendTransaction",
  "EvmSendTransaction",
  "imageGenerate",
  "ImageGenerate",
]);

/** Keys whose array items scope the `tools` lists nested beneath them. */
const NESTED_TOOL_CONTEXTS: Record<string, string> = {
  steps: "step",
  nodes: "node",
  roles: "role",
  subAgents: "sub-agent",
};

/**
 * Recursive walk gathering every string under a `tools` key together with
 * the context that declares it ("agent" at the top level; `step \`x\`` /
 * `node \`x\`` / `role \`x\`` / `sub-agent \`x\`` when nested). Mirrors
 * `collectToolNames` in `packages/compiler`, with context tracking added.
 */
function collectToolUsage(ir: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  const usage = new Map<string, Set<string>>();
  const add = (tool: string, context: string): void => {
    const contexts = usage.get(tool) ?? new Set<string>();
    contexts.add(context);
    usage.set(tool, contexts);
  };
  const visit = (node: unknown, context: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, context);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "tools" && Array.isArray(value)) {
        for (const v of value) if (typeof v === "string") add(v, context);
        continue;
      }
      const label = NESTED_TOOL_CONTEXTS[key];
      if (label !== undefined && Array.isArray(value)) {
        for (const item of value) {
          const name = (item as { readonly name?: unknown } | null)?.name;
          // The context label lands in a table cell verbatim — escape the
          // interpolated name (F5) but not the intentional backticks here.
          visit(item, typeof name === "string" ? `${label} \`${escapeCell(name)}\`` : label);
        }
        continue;
      }
      visit(value, context);
    }
  };
  visit(ir, "agent");
  return usage;
}

/** Every tool name carrying a `tool_config` blob, across nested variants. */
function collectConfiguredToolNames(ir: unknown): ReadonlySet<string> {
  const configured = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "toolConfigs" && value !== null && typeof value === "object") {
        for (const name of Object.keys(value as Record<string, unknown>)) configured.add(name);
        continue;
      }
      visit(value);
    }
  };
  visit(ir);
  return configured;
}

/** Deduped models across variant shapes (agent / steps / nodes / roles). */
function collectModels(ir: IrNode): readonly string[] {
  switch (ir.target) {
    case "workflow":
      return [...new Set(ir.steps.map((s) => s.model))];
    case "graph":
      return [...new Set(ir.nodes.map((n) => n.model))];
    case "crew":
      return [...new Set(ir.roles.map((r) => r.model))];
    default:
      return [ir.agent.model];
  }
}

/**
 * Adversarial-review F5 — escape an interpolated value for a GFM table
 * cell: `|` would split the cell, a raw newline would end the row, and a
 * stray backtick would terminate the code-span the tables wrap values in.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/\r?\n/g, " ");
}

/**
 * Adversarial-review F2 — words in a CLI flag name that mark its VALUE as a
 * credential (`--token=…`, `--api-key …`). Matched per dash-separated word
 * so `--keyboard-layout` stays visible while `--api-key` masks.
 */
const CREDENTIAL_FLAG_WORDS: ReadonlySet<string> = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "pass",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "bearer",
]);

function isCredentialFlag(arg: string): boolean {
  const m = arg.match(/^--?([A-Za-z][A-Za-z0-9-]*)$/);
  if (m?.[1] === undefined) return false;
  return m[1]
    .toLowerCase()
    .split("-")
    .some((word) => CREDENTIAL_FLAG_WORDS.has(word));
}

/** Render a stdio server's launch line with credential-valued flags masked
 *  (`--token=v` and `--token v` forms) and known token shapes (`sk-…`,
 *  `ghp_…`, …) masked out of every other arg. */
function maskStdioCommand(command: string, args: ReadonlyArray<string>): string {
  const masked: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      masked.push("***");
      maskNext = false;
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("-") && eq > 0 && isCredentialFlag(arg.slice(0, eq))) {
      masked.push(`${arg.slice(0, eq)}=***`);
      continue;
    }
    if (isCredentialFlag(arg)) {
      masked.push(arg);
      maskNext = true;
      continue;
    }
    masked.push(maskCredentialTokens(arg));
  }
  return [command, ...masked].join(" ");
}

/**
 * Mask the credential-bearing parts of an sse URL: userinfo passwords
 * (`https://user:***@`), ALL query-parameter values (`?apikey=***` — key
 * names stay, values never render), and path segments shaped like opaque
 * credentials (Alchemy/Infura-style `/v2/<key>` → `/v2/***`). Regex-based
 * so a not-quite-parseable URL still gets masked rather than printed raw.
 */
function maskUrlCredentials(url: string): string {
  // Userinfo: keep the user, mask the password.
  const out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:]+):([^/@]+)@/i, "$1:***@");
  const q = out.indexOf("?");
  const query = q === -1 ? "" : out.slice(q).replace(/([?&;][^=&;#]*)=([^&;#]*)/g, "$1=***");
  let base = q === -1 ? out : out.slice(0, q);
  const prefix = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0] ?? "";
  const path = base
    .slice(prefix.length)
    .split("/")
    .map((seg) => (OPAQUE_TOKEN_RE.test(seg) ? "***" : maskCredentialTokens(seg)))
    .join("/");
  base = `${prefix}${path}`;
  return `${base}${query}`;
}

function toolScopeHint(name: string): string {
  if (name.startsWith("mcp__")) return "external (MCP)";
  if (OUTWARD_TOOL_NAMES.has(name)) return "external";
  return "built-in";
}

function toolNotes(name: string, configured: ReadonlySet<string>): string {
  const notes: string[] = [];
  if (SANDBOXED_TOOL_NAMES.has(name)) notes.push("sandboxed");
  if (JUSTIFICATION_GATED_TOOL_NAMES.has(name)) notes.push("justification-gated by default");
  if (configured.has(name)) notes.push("configured via `tool_config`");
  return notes.length > 0 ? notes.join("; ") : "—";
}

function renderToolsSection(ir: IrNode): string | undefined {
  const usage = collectToolUsage(ir);
  if (usage.size === 0) return undefined;
  const configured = collectConfiguredToolNames(ir);
  const rows = [...usage.keys()].sort().map((name) => {
    const contexts = [...(usage.get(name) ?? new Set<string>())].sort().join(", ");
    return `| \`${escapeCell(name)}\` | ${contexts} | ${toolScopeHint(name)} | ${toolNotes(name, configured)} |`;
  });
  return ["| Tool | Used by | Scope | Notes |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function renderMcpSection(ir: IrNode): string | undefined {
  const servers = (ir as { readonly mcp_servers?: IrMcpServers }).mcp_servers;
  if (servers === undefined) return undefined;
  const entries = Object.entries(servers);
  if (entries.length === 0) return undefined;
  // Endpoint column: command for stdio, URL for sse. Env values and sse
  // headers are intentionally NOT rendered — they can carry credentials —
  // and the command/URL themselves are masked (adversarial-review F2):
  // credential-valued flags, known token shapes in args, URL userinfo
  // passwords, ALL query-parameter values, and opaque path segments.
  const rows = entries.map(([name, cfg]) =>
    cfg.transport === "stdio"
      ? `| \`${escapeCell(name)}\` | stdio | \`${escapeCell(maskStdioCommand(cfg.command, cfg.args))}\` |`
      : `| \`${escapeCell(name)}\` | sse | \`${escapeCell(maskUrlCredentials(cfg.url))}\` |`,
  );
  return ["| Server | Transport | Endpoint |", "| --- | --- | --- |", ...rows].join("\n");
}

function renderEnvSection(ir: IrNode): string {
  const { envNames, literalCount } = collectSecretRefs(ir);
  const models = collectModels(ir);
  const lines: string[] = [];
  if (envNames.length > 0) {
    lines.push(
      "Set these before launching — the bundle reads them from `process.env` at runtime:",
      "",
      ...envNames.map((name) => `- \`${name}\``),
    );
  } else {
    lines.push("No spec-declared environment variables.");
  }
  if (literalCount > 0) {
    lines.push(
      "",
      `> ${literalCount} secret-shaped value(s) were supplied as literals in the spec and are compiled into the bundle — they are not shown here. Prefer \`$UPPER_SNAKE_CASE\` env references so credentials stay out of compiled artifacts.`,
    );
  }
  lines.push(
    "",
    `The model provider's API key must also be present (e.g. \`ANTHROPIC_API_KEY\` for Anthropic \`claude-*\` models; model(s) in use: ${models
      .map((m) => `\`${m}\``)
      .join(", ")}).`,
  );
  return lines.join("\n");
}

function defaultUsageSection(ir: IrNode): BundleReadmeSection {
  return {
    heading: "Run",
    body: [
      "```sh",
      "bun install   # first run only — installs the bundle's dependencies",
      RUN_COMMANDS[ir.target],
      "```",
    ].join("\n"),
  };
}

const WORKSPACE_NOTE = [
  "Launch the bundle from inside this directory — it reads and writes workspace state under `.crewhaus/` relative to the working directory:",
  "",
  "- `.crewhaus/sessions/` — session transcripts (one file per session)",
  "- `.crewhaus/feedback/` — response ratings collected by the feedback tooling",
].join("\n");

/**
 * Render the generated bundle README from a lowered IR. Pure; no I/O.
 * Deterministic for a given IR (tables and env lists are sorted) so
 * recompiles diff cleanly.
 */
export function renderBundleReadme(ir: IrNode, opts: BundleReadmeOptions = {}): string {
  const description =
    opts.description ?? `Compiled CrewHaus bundle for the \`${ir.target}\` target shape.`;
  const models = collectModels(ir);
  const harnessRows = [
    "| | |",
    "| --- | --- |",
    `| Name | \`${escapeCell(ir.name)}\` |`,
    `| Target | \`${ir.target}\` |`,
    `| ${models.length > 1 ? "Models" : "Model"} | ${models
      .map((m) => `\`${escapeCell(m)}\``)
      .join(", ")} |`,
  ].join("\n");

  const sections: BundleReadmeSection[] = [{ heading: "Harness", body: harnessRows }];
  const tools = renderToolsSection(ir);
  if (tools !== undefined) sections.push({ heading: "Tools", body: tools });
  const mcp = renderMcpSection(ir);
  if (mcp !== undefined) sections.push({ heading: "MCP servers", body: mcp });
  sections.push({ heading: "Environment variables", body: renderEnvSection(ir) });
  sections.push(opts.usage ?? defaultUsageSection(ir));
  if (opts.includeWorkspaceNote !== false) {
    sections.push({ heading: "Runtime data", body: WORKSPACE_NOTE });
  }
  sections.push(...(opts.extraSections ?? []));

  return [
    GENERATED_README_MARKER,
    "",
    `# ${ir.name}`,
    "",
    description,
    "",
    "Generated by CrewHaus — do not edit by hand; recompile from the spec instead.",
    "",
    ...sections.flatMap((s) => [`## ${s.heading}`, "", s.body, ""]),
  ].join("\n");
}
