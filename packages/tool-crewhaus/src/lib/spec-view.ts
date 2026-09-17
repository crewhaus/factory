/**
 * The SPEC VIEW: one shape-agnostic, sorted projection of a parsed spec, and
 * a semantic diff over two of them.
 *
 * Why a projection rather than reading the `Spec` union directly: a spec has
 * fourteen target shapes and the fleet questions ("what tools does this
 * harness have, what does it talk to, what may it do") are the same for all
 * of them. So the view is built by WALKING the parsed document — the same
 * walk `expandSpecToolCategories` uses, with the same load-bearing guard
 * (`tools` counts only when its value is an array of strings, because
 * `expose.mcp.tools` is a bare string) — and a new shape inherits it for
 * free.
 *
 * Everything here is pure: input is an already-parsed spec object, output is
 * plain data with every list sorted by plain string comparison. No clock, no
 * filesystem, no locale.
 *
 * SECRET HYGIENE. The view names MCP `env` and `headers` KEYS but never
 * their values (a literal secret pasted into a spec is exactly what those
 * values may hold), an `sse` server's endpoint is reduced to origin + path
 * so a token in a query string (or a `user:pass@` in its authority) is not
 * echoed into a report, and a stdio server's ARGV — which is the third place
 * an operator pastes a credential, `["--api-key", "sk-…"]` being the usual
 * shape — is redacted by `redactArgs` before it is shown.
 */

import { ENV_REF_RE } from "@crewhaus/preflight";

export type LooseRecord = Record<string, unknown>;

/** One `tools:` array found in the document, with the path that owns it. */
export type ToolSite = {
  /** Dot/bracket path from the document root, e.g. `agent` or `steps[1]`. */
  readonly path: string;
  readonly tools: readonly string[];
};

/** A model slot: which model, and the spec paths that select it. */
export type ModelSlot = { readonly model: string; readonly sources: readonly string[] };

export type McpServerView = {
  readonly name: string;
  readonly transport: string;
  /** stdio: the command that is spawned. */
  readonly command?: string;
  /** stdio: argv after the command, with credential-shaped values redacted. */
  readonly args?: readonly string[];
  /** How many argv entries `redactArgs` replaced. Absent when none were. */
  readonly redactedArgs?: number;
  /** sse: `scheme://host/path` — query string dropped (it can carry a token). */
  readonly endpoint?: string;
  /** Absent `required` means required — the fail-fast default. */
  readonly required: boolean;
  /** Names only. Values are withheld: they may be literal credentials. */
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
  /** Tool names the spec narrows trust flags for (`tool_flags.per_tool`). */
  readonly flaggedTools?: readonly string[];
};

export type PermissionRuleView = { readonly type: string; readonly pattern: string };

export type PermissionsView = {
  /** `default` when the spec declares no mode — the schema's own default. */
  readonly mode: string;
  /** What an unresolved `ask` does on a non-interactive surface. */
  readonly askMode: string;
  readonly rules: readonly PermissionRuleView[];
};

export type SpecView = {
  readonly name: string;
  readonly version?: string;
  readonly target: string;
  /** Top-level keys the spec declares, sorted — the "what is wired" list. */
  readonly blocks: readonly string[];
  readonly models: readonly ModelSlot[];
  readonly toolSites: readonly ToolSite[];
  /** Every tool granted anywhere in the document, de-duplicated and sorted. */
  readonly tools: readonly string[];
  readonly mcpServers: readonly McpServerView[];
  readonly permissions: PermissionsView;
  /** Shape sizes a fleet table wants: step/role/node counts and so on. */
  readonly counts: Readonly<Record<string, number>>;
};

export function asRecord(value: unknown): LooseRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Plain byte-order comparison — never `localeCompare`, which is locale-dependent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every `tools:` array in the document, in path order.
 *
 * The array-of-strings guard is load-bearing and is copied from the
 * compiler's category expansion: `expose.mcp.tools` is the string
 * `"chat" | "per-subagent"`, not a tool list.
 */
export function collectToolSites(spec: unknown): ToolSite[] {
  const sites: ToolSite[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    const record = asRecord(node);
    if (record === undefined) return;
    for (const [key, value] of Object.entries(record)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (key === "tools" && isStringArray(value)) {
        // The OWNER of the list reads better than the `tools` key itself:
        // `steps[1]`, not `steps[1].tools`.
        sites.push({ path: path === "" ? "<root>" : path, tools: [...value] });
        continue;
      }
      visit(value, childPath);
    }
  };
  visit(spec, "");
  sites.sort((a, b) => compareStrings(a.path, b.path));
  return sites;
}

/** `scheme://host/path` — the query string is dropped, it can carry a token. */
function safeEndpoint(raw: unknown): string | undefined {
  const url = asString(raw);
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    // `host` is authority WITHOUT userinfo, so a `https://user:token@h/p`
    // loses the credential here as well as in the query string.
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // The schema requires a valid URL, so this is unreachable for a parsed
    // spec; withhold rather than echo an unparsed string that may be a secret.
    return "(unparseable url withheld)";
  }
}

// ---------------------------------------------------------------------------
// argv redaction
// ---------------------------------------------------------------------------

/** What a redacted argv entry is replaced with. */
export const REDACTED = "(redacted)";

/**
 * A flag name (dashes already stripped) whose VALUE is a credential.
 * Deliberately narrow: over-redacting an argv makes the report useless, so
 * only the words operators actually use for a secret are matched.
 */
const CREDENTIAL_FLAG_RE =
  /(^|[-_.])(api[-_.]?key|key|token|secret|password|passwd|auth|bearer|credentials?|pat)s?$/i;

/**
 * A value that is a credential on its own evidence: a vendor-prefixed key, a
 * JWT, or a long opaque run of token characters. Path-like and URL-like
 * strings are excluded — `/usr/local/bin/server` and `https://host/x` are
 * long and opaque too, and redacting them would hide what the server IS.
 */
const CREDENTIAL_VALUE_RE =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abperst]-|xapp-|glpat-|npm_|hf_|dop_v1_|shp(at|ss|ca|pa)_|AKIA|ASIA|AIza|Bearer\s)/;
const JWT_RE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,}$/;

function looksLikeSecretValue(value: string): boolean {
  if (ENV_REF_RE.test(value)) return false; // a reference, not a secret
  if (CREDENTIAL_VALUE_RE.test(value)) return true;
  if (JWT_RE.test(value)) return true;
  // A long opaque run only counts when it mixes letters and digits: a
  // 40-character all-lowercase word is a package name, not a key.
  return OPAQUE_TOKEN_RE.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function isCredentialFlag(arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  return CREDENTIAL_FLAG_RE.test(arg.replace(/^-+/, ""));
}

/**
 * Redact the credential-shaped entries of an MCP server's argv.
 *
 * Three shapes are caught, and only these: `--api-key VALUE` (the entry
 * AFTER a credential-named flag), `--api-key=VALUE` (the half after the
 * `=`), and a bare value that is a credential on its own evidence. Exported
 * because the honest thing to do with a redaction rule is test it directly.
 */
export function redactArgs(args: readonly string[]): { args: string[]; redacted: number } {
  const out: string[] = [];
  let redacted = 0;
  let previousWasCredentialFlag = false;
  for (const arg of args) {
    const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
    // A `$UPPER_SNAKE` value is an env REFERENCE, not a credential: hiding it
    // costs the reader the variable name and protects nothing.
    if (previousWasCredentialFlag && !arg.startsWith("-") && !ENV_REF_RE.test(arg)) {
      out.push(REDACTED);
      redacted += 1;
      previousWasCredentialFlag = false;
      continue;
    }
    if (
      eq > 0 &&
      isCredentialFlag(arg.slice(0, eq)) &&
      arg.length > eq + 1 &&
      !ENV_REF_RE.test(arg.slice(eq + 1))
    ) {
      out.push(`${arg.slice(0, eq)}=${REDACTED}`);
      redacted += 1;
      previousWasCredentialFlag = false;
      continue;
    }
    if (!arg.startsWith("-") && looksLikeSecretValue(arg)) {
      out.push(REDACTED);
      redacted += 1;
      previousWasCredentialFlag = false;
      continue;
    }
    out.push(arg);
    previousWasCredentialFlag = isCredentialFlag(arg) && eq === -1;
  }
  return { args: out, redacted };
}

function mcpServerViews(block: unknown): McpServerView[] {
  const servers = asRecord(block);
  if (servers === undefined) return [];
  const out: McpServerView[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const config = asRecord(raw);
    if (config === undefined) continue;
    const env = asRecord(config["env"]);
    const headers = asRecord(config["headers"]);
    const perTool = asRecord(asRecord(config["tool_flags"])?.["per_tool"]);
    const rawArgs = config["args"];
    const args = isStringArray(rawArgs) ? redactArgs(rawArgs) : undefined;
    out.push({
      name,
      transport: asString(config["transport"]) ?? "unknown",
      ...(asString(config["command"]) !== undefined
        ? { command: asString(config["command"]) as string }
        : {}),
      ...(args !== undefined ? { args: args.args } : {}),
      ...(args !== undefined && args.redacted > 0 ? { redactedArgs: args.redacted } : {}),
      ...(safeEndpoint(config["url"]) !== undefined
        ? { endpoint: safeEndpoint(config["url"]) as string }
        : {}),
      required: config["required"] !== false,
      ...(env !== undefined ? { envKeys: Object.keys(env).sort(compareStrings) } : {}),
      ...(headers !== undefined ? { headerKeys: Object.keys(headers).sort(compareStrings) } : {}),
      ...(perTool !== undefined ? { flaggedTools: Object.keys(perTool).sort(compareStrings) } : {}),
    });
  }
  out.sort((a, b) => compareStrings(a.name, b.name));
  return out;
}

function permissionsView(block: unknown): PermissionsView {
  const permissions = asRecord(block);
  const rawRules = permissions?.["rules"];
  const rules: PermissionRuleView[] = [];
  if (Array.isArray(rawRules)) {
    for (const raw of rawRules) {
      const rule = asRecord(raw);
      const type = asString(rule?.["type"]);
      const pattern = asString(rule?.["pattern"]);
      if (type !== undefined && pattern !== undefined) rules.push({ type, pattern });
    }
  }
  return {
    // The schema's own defaults, made explicit so a diff sees the real
    // posture rather than "absent".
    mode: asString(permissions?.["mode"]) ?? "default",
    askMode: asString(permissions?.["ask_mode"]) ?? "pause",
    rules,
  };
}

/** Container sizes worth a column in a fleet table. */
const COUNTED_PATHS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["steps", ["steps"]],
  ["roles", ["roles"]],
  ["nodes", ["nodes"]],
  ["edges", ["edges"]],
  ["channels", ["channels"]],
  ["hooks", ["hooks"]],
  ["subAgents", ["agent", "sub_agents"]],
  ["modelProfiles", ["models"]],
];

function sizeOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  const record = asRecord(value);
  return record !== undefined ? Object.keys(record).length : undefined;
}

function counts(spec: LooseRecord, mcpCount: number, ruleCount: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, path] of COUNTED_PATHS) {
    let node: unknown = spec;
    for (const segment of path) {
      node = asRecord(node)?.[segment];
    }
    const size = sizeOf(node);
    if (size !== undefined) out[label] = size;
  }
  out["mcpServers"] = mcpCount;
  out["permissionRules"] = ruleCount;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareStrings(a, b)));
}

/**
 * Project a parsed spec into the view. `models` comes from the caller
 * (`collectSpecModels` in `@crewhaus/preflight` already resolves `$profile`
 * references against the `models:` registry, and re-implementing that would
 * be a second source of truth).
 */
export function buildSpecView(parsed: unknown, models: readonly ModelSlot[]): SpecView {
  const spec = asRecord(parsed) ?? {};
  const toolSites = collectToolSites(spec);
  const mcpServers = mcpServerViews(spec["mcp_servers"]);
  const permissions = permissionsView(spec["permissions"]);
  const tools = [...new Set(toolSites.flatMap((site) => site.tools))].sort(compareStrings);
  const sortedModels = [...models]
    .map((m) => ({ model: m.model, sources: [...m.sources].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.model, b.model));
  return {
    name: asString(spec["name"]) ?? "(unnamed)",
    ...(asString(spec["version"]) !== undefined
      ? { version: asString(spec["version"]) as string }
      : {}),
    target: asString(spec["target"]) ?? "(unknown)",
    blocks: Object.keys(spec).sort(compareStrings),
    models: sortedModels,
    toolSites,
    tools,
    mcpServers,
    permissions,
    counts: counts(spec, mcpServers.length, permissions.rules.length),
  };
}

// ---------------------------------------------------------------------------
// semantic diff
// ---------------------------------------------------------------------------

/**
 * One semantic difference. `widens` is the field an operator actually reads:
 * true means the harness can now do something it could not before, or a
 * permission guard got looser.
 */
export type SpecChange = {
  readonly kind: string;
  readonly path: string;
  readonly from?: string;
  readonly to?: string;
  readonly widens: boolean;
};

/**
 * Top-level blocks whose ARRIVAL grants the harness a new outward reach, and
 * which therefore count as widening. Every other block change is reported as
 * a plain change: `memory` or `compaction` appearing alters behaviour but
 * grants no new capability.
 */
export const WIDENING_BLOCKS: ReadonlySet<string> = new Set([
  "chains",
  "contracts",
  "expose",
  "hooks",
  "mcp_servers",
  "plugins",
  "thredz",
  "wallets",
]);

/** Permission modes ordered least → most permissive. */
const MODE_RANK: Readonly<Record<string, number>> = { plan: 0, default: 1, auto: 2 };

function diffSets(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((x) => !b.has(x)).sort(compareStrings),
    removed: [...b].filter((x) => !a.has(x)).sort(compareStrings),
  };
}

function sourceToModel(models: readonly ModelSlot[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const slot of models) {
    for (const source of slot.sources) out.set(source, slot.model);
  }
  return out;
}

function toolsByPath(sites: readonly ToolSite[]): Map<string, readonly string[]> {
  return new Map(sites.map((site) => [site.path, site.tools]));
}

/**
 * What changed between two specs, semantically. Textual reordering,
 * comments and whitespace are invisible here by construction: both sides are
 * already-parsed documents.
 *
 * The comparison is deliberately structural, not behavioural — it cannot
 * tell you that an instruction rewrite made an agent bolder, only that a
 * tool was granted, a server added, a rule dropped, a model swapped.
 */
export function diffSpecViews(before: SpecView, after: SpecView): SpecChange[] {
  const changes: SpecChange[] = [];
  const push = (c: SpecChange): void => {
    changes.push(c);
  };

  if (before.target !== after.target) {
    push({ kind: "target", path: "target", from: before.target, to: after.target, widens: false });
  }
  if (before.name !== after.name) {
    push({ kind: "name", path: "name", from: before.name, to: after.name, widens: false });
  }
  if (before.version !== after.version) {
    push({
      kind: "version",
      path: "version",
      ...(before.version !== undefined ? { from: before.version } : {}),
      ...(after.version !== undefined ? { to: after.version } : {}),
      widens: false,
    });
  }

  // models — keyed on the SLOT (`agent.model`, `steps[0].model`), so a swap
  // reads as one change rather than one removal plus one addition.
  const beforeModels = sourceToModel(before.models);
  const afterModels = sourceToModel(after.models);
  for (const source of [...new Set([...beforeModels.keys(), ...afterModels.keys()])].sort(
    compareStrings,
  )) {
    const from = beforeModels.get(source);
    const to = afterModels.get(source);
    if (from === to) continue;
    push({
      kind:
        from === undefined ? "model-slot-added" : to === undefined ? "model-slot-removed" : "model",
      path: source,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      widens: false,
    });
  }

  // tools, per site
  const beforeTools = toolsByPath(before.toolSites);
  const afterTools = toolsByPath(after.toolSites);
  for (const site of [...new Set([...beforeTools.keys(), ...afterTools.keys()])].sort(
    compareStrings,
  )) {
    const { added, removed } = diffSets(beforeTools.get(site) ?? [], afterTools.get(site) ?? []);
    for (const tool of added) {
      push({ kind: "tool-added", path: site, to: tool, widens: true });
    }
    for (const tool of removed) {
      push({ kind: "tool-removed", path: site, from: tool, widens: false });
    }
  }

  // mcp servers
  const beforeServers = new Map(before.mcpServers.map((s) => [s.name, s]));
  const afterServers = new Map(after.mcpServers.map((s) => [s.name, s]));
  for (const name of [...new Set([...beforeServers.keys(), ...afterServers.keys()])].sort(
    compareStrings,
  )) {
    const from = beforeServers.get(name);
    const to = afterServers.get(name);
    const path = `mcp_servers.${name}`;
    if (from === undefined && to !== undefined) {
      push({ kind: "mcp-server-added", path, to: describeServer(to), widens: true });
      continue;
    }
    if (to === undefined && from !== undefined) {
      push({ kind: "mcp-server-removed", path, from: describeServer(from), widens: false });
      continue;
    }
    if (from === undefined || to === undefined) continue;
    const fromText = describeServer(from);
    const toText = describeServer(to);
    if (fromText !== toText) {
      push({ kind: "mcp-server", path, from: fromText, to: toText, widens: false });
    }
    if (from.required && !to.required) {
      // A peer that may now be absent is a smaller guarantee, not a wider
      // capability — reported, not flagged.
      push({ kind: "mcp-server-optional", path, from: "required", to: "optional", widens: false });
    }
  }

  // permissions
  if (before.permissions.mode !== after.permissions.mode) {
    const fromRank = MODE_RANK[before.permissions.mode] ?? 1;
    const toRank = MODE_RANK[after.permissions.mode] ?? 1;
    push({
      kind: "permission-mode",
      path: "permissions.mode",
      from: before.permissions.mode,
      to: after.permissions.mode,
      widens: toRank > fromRank,
    });
  }
  if (before.permissions.askMode !== after.permissions.askMode) {
    // Neither direction widens: `pause` parks the turn for a human, `deny`
    // refuses it. Both are stricter than allowing the call.
    push({
      kind: "permission-ask-mode",
      path: "permissions.ask_mode",
      from: before.permissions.askMode,
      to: after.permissions.askMode,
      widens: false,
    });
  }
  const ruleKey = (r: PermissionRuleView): string => `${r.type} ${r.pattern}`;
  const rules = diffSets(
    before.permissions.rules.map(ruleKey),
    after.permissions.rules.map(ruleKey),
  );
  for (const key of rules.added) {
    push({
      kind: "permission-rule-added",
      path: "permissions.rules",
      to: key,
      widens: key.startsWith("alwaysAllow "),
    });
  }
  for (const key of rules.removed) {
    push({
      kind: "permission-rule-removed",
      path: "permissions.rules",
      from: key,
      // Dropping a deny or an ask removes a guard; dropping an allow does not.
      widens: key.startsWith("alwaysDeny ") || key.startsWith("alwaysAsk "),
    });
  }

  // top-level blocks
  const blocks = diffSets(before.blocks, after.blocks);
  for (const block of blocks.added) {
    if (block === "mcp_servers" || block === "permissions" || block === "tools") continue;
    push({ kind: "block-added", path: block, to: block, widens: WIDENING_BLOCKS.has(block) });
  }
  for (const block of blocks.removed) {
    if (block === "mcp_servers" || block === "permissions" || block === "tools") continue;
    push({ kind: "block-removed", path: block, from: block, widens: false });
  }

  changes.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.from ?? "", b.from ?? "") ||
      compareStrings(a.to ?? "", b.to ?? ""),
  );
  return changes;
}

function describeServer(server: McpServerView): string {
  if (server.transport === "stdio") {
    const args =
      server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
    return `stdio:${server.command ?? "?"}${args}`;
  }
  return `${server.transport}:${server.endpoint ?? "?"}`;
}
