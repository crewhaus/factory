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
import type {
  IrMcpServers,
  IrModelPool,
  IrModelProfile,
  IrModelProfiles,
  IrModelTiers,
  IrNode,
} from "./index";
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
  /**
   * Tools the spec names but this bundle does not carry — every one of them
   * (`"all"`: a shape with no tool catalog, or an export such as a Claude
   * Code plugin) or a named few (a cf-worker leaves out what the edge cannot
   * run). Their row says so instead of calling them built-in.
   */
  readonly unwiredTools?: {
    readonly names: ReadonlySet<string> | "all";
    readonly note: string;
  };
  /**
   * What the Tools table says about each builtin — its scope, and notes such
   * as `configured by \`tool_config.http\`` — by spec key or registered name.
   * Emitters pass `readmeToolFacts` from `@crewhaus/tool-categories`, which
   * reads the builtin table and the registrations the bundle really makes;
   * this package has no dependency to read them itself. A name it does not
   * know is shown as built-in with no notes.
   */
  readonly toolFacts?: (name: string) => ReadmeToolFacts | undefined;
};

/** One builtin's row in the Tools table. */
export type ReadmeToolFacts = {
  readonly scope: string;
  readonly notes: ReadonlyArray<string>;
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

/** A whole `tool_config` string value `$UPPER_SNAKE`: read from the environment at boot. */
const TOOL_CONFIG_ENV_RE = /^\$([A-Z_][A-Z0-9_]*)$/;

/** Every `$VAR` a `tool_config` block (agent, step, node, role or pool candidate) reads. */
function collectToolConfigEnvNames(ir: unknown, into: Set<string>): void {
  const strings = (node: unknown): void => {
    if (typeof node === "string") {
      const name = node.match(TOOL_CONFIG_ENV_RE)?.[1];
      if (name !== undefined) into.add(name);
    } else if (Array.isArray(node)) {
      for (const item of node) strings(item);
    } else if (node !== null && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) strings(value);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "toolConfigs") strings(value);
      else visit(value);
    }
  };
  visit(ir);
}

export function collectSecretRefs(ir: unknown): CollectedSecretRefs {
  const envNames = new Set<string>();
  collectToolConfigEnvNames(ir, envNames);
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
  // A builtin is spelled `read` in a shape's tools: list and `Read` in a
  // sub-agent's (the registered name the child is filtered by). They are one
  // tool, so rows merge without regard to case — no two builtins differ only
  // in case — under the first spelling seen (the agent's own list is visited
  // first).
  const displayName = new Map<string, string>();
  const add = (tool: string, context: string): void => {
    const lower = tool.toLowerCase();
    const shown = displayName.get(lower) ?? tool;
    displayName.set(lower, shown);
    const contexts = usage.get(shown) ?? new Set<string>();
    contexts.add(context);
    usage.set(shown, contexts);
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

/**
 * Deduped models across variant shapes (agent / steps / nodes / roles), in
 * declaration order: the primary slot(s) first, then — 0.6.0 §4.3 — every
 * other model a run can route a call to: pool candidates, the two tiers,
 * failover chains, and the auxiliary slots (compaction, the in-loop judge or
 * judge panel, the budget degrade rung, the security judge, the watchme
 * judge). The README used to list only the primary slot(s), so a pooled or
 * judged harness under-reported the credentials it needs. A registry
 * profile's model appears once like any other string; the profile names
 * themselves render in the "Model profiles" section.
 */
function collectModels(ir: IrNode): readonly string[] {
  const out: string[] = [];
  const add = (model: string | undefined): void => {
    if (model !== undefined && model.length > 0 && !out.includes(model)) out.push(model);
  };
  const addRouted = (block: {
    readonly model: string;
    readonly modelPool?: IrModelPool;
    readonly modelTiers?: IrModelTiers;
    readonly modelFallbacks?: readonly string[];
  }): void => {
    add(block.model);
    for (const c of block.modelPool?.candidates ?? []) {
      add(c.model);
      for (const f of c.fallbacks ?? []) add(f);
    }
    if (block.modelTiers !== undefined) {
      add(block.modelTiers.fast);
      add(block.modelTiers.default);
    }
    for (const f of block.modelFallbacks ?? []) add(f);
  };
  switch (ir.target) {
    case "workflow":
      for (const s of ir.steps) {
        addRouted(s);
        for (const j of s.judge?.judges ?? []) add(j);
      }
      break;
    case "graph":
      for (const n of ir.nodes) {
        addRouted(n);
        for (const j of n.judge?.judges ?? []) add(j);
      }
      break;
    case "crew":
      for (const r of ir.roles) {
        addRouted(r);
        for (const sa of r.subAgents)
          if (sa.model !== undefined) addRouted({ ...sa, model: sa.model });
      }
      add(ir.routing?.model);
      break;
    default:
      addRouted(ir.agent);
      break;
  }
  const aux = ir as {
    readonly subAgents?: ReadonlyArray<{
      readonly model?: string;
      readonly modelPool?: IrModelPool;
      readonly modelTiers?: IrModelTiers;
      readonly modelFallbacks?: readonly string[];
    }>;
    readonly compaction?: { readonly model?: string };
    readonly evaluation?: {
      readonly grader: { readonly model?: string; readonly judges?: readonly string[] };
    };
    readonly budget?: { readonly onExceed: { readonly model?: string } };
    readonly security?: { readonly justification?: { readonly model?: string } };
    readonly watchme?: { readonly judgeModel: string };
    readonly groundingModel?: string;
  };
  for (const sa of aux.subAgents ?? []) {
    if (sa.model !== undefined) addRouted({ ...sa, model: sa.model });
  }
  add(aux.compaction?.model);
  add(aux.evaluation?.grader.model);
  for (const j of aux.evaluation?.grader.judges ?? []) add(j);
  add(aux.budget?.onExceed.model);
  add(aux.security?.justification?.model);
  add(aux.watchme?.judgeModel);
  add(aux.groundingModel);
  return out;
}

/**
 * 0.6.0 §4.3 — the "Model profiles" section: one row per `models:` profile
 * with its model, tags and the settings it pins. Rendered only when the IR
 * carries a registry, so profile-less bundles keep the same README.
 */
function renderModelProfilesSection(ir: IrNode): string | undefined {
  const registry = (ir as { readonly models?: IrModelProfiles }).models;
  if (registry === undefined) return undefined;
  const names = Object.keys(registry).sort();
  if (names.length === 0) return undefined;
  const rows = names.map((name) => {
    const profile = registry[name] as IrModelProfile;
    const tags = (profile.tags ?? []).map((t) => `\`${escapeCell(t)}\``).join(", ") || "—";
    const pinned = Object.keys(profile)
      .filter((k) => k !== "profile" && k !== "model" && k !== "tags")
      .sort();
    return `| \`${escapeCell(name)}\` | \`${escapeCell(profile.model)}\` | ${tags} | ${pinned.length > 0 ? pinned.map((k) => `\`${k}\``).join(", ") : "—"} |`;
  });
  return ["| Profile | Model | Tags | Pins |", "| --- | --- | --- | --- |", ...rows].join("\n");
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

function toolScope(name: string, facts: ReadmeToolFacts | undefined): string {
  if (name.startsWith("mcp__")) return "external (MCP)";
  return facts?.scope ?? "built-in";
}

function renderToolsSection(
  ir: IrNode,
  unwired?: BundleReadmeOptions["unwiredTools"],
  toolFacts?: BundleReadmeOptions["toolFacts"],
): string | undefined {
  const usage = collectToolUsage(ir);
  if (usage.size === 0) return undefined;
  const isUnwired = (name: string): boolean =>
    unwired !== undefined && (unwired.names === "all" || unwired.names.has(name));
  const rows = [...usage.keys()].sort().map((name) => {
    const contexts = [...(usage.get(name) ?? new Set<string>())].sort().join(", ");
    if (isUnwired(name) && unwired !== undefined) {
      return `| \`${escapeCell(name)}\` | ${contexts} | not wired | ${escapeCell(unwired.note)} |`;
    }
    const facts = toolFacts?.(name);
    // Notes keep their code spans; a pipe or newline from a spec key would
    // still split the cell.
    const notes =
      facts !== undefined && facts.notes.length > 0
        ? facts.notes.join("; ").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
        : "—";
    return `| \`${escapeCell(name)}\` | ${contexts} | ${toolScope(name, facts)} | ${notes} |`;
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
  // 0.6.0 §4.3 — the `models:` registry, when the spec declared one.
  const profiles = renderModelProfilesSection(ir);
  if (profiles !== undefined) sections.push({ heading: "Model profiles", body: profiles });
  const tools = renderToolsSection(ir, opts.unwiredTools, opts.toolFacts);
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
