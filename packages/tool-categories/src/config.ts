/**
 * How a spec's `tool_config` reaches the tools that read it — the one rule
 * every emitter renders, `crewhaus run` and `crewhaus eval` call, and a model
 * pool candidate's per-call lookup follows.
 *
 * A configurable package has ONE boot registrar (`registerHttpConfig`), and a
 * spec may write that package's block three ways: under the package's
 * documented key (`tool_config.http`), under a tool's own key
 * (`tool_config.httpRequest`), or under its registered name
 * (`tool_config.HttpRequest`, the spelling permission rules use). All three
 * reach the same registrar. Two DIFFERENT blocks for one registrar are an
 * error that names both keys — the registrar holds one process-wide setting,
 * so one of them would be silently dropped.
 *
 * A string value written as `$UPPER_SNAKE` is read from the environment when
 * the bundle starts, never compiled in, the way `mcp_servers` env values
 * work. A value read that way is never repeated in an error.
 *
 * Pure functions over data, except {@link applyToolConfig}, which calls the
 * registrar it is handed. Nothing here imports a tool package.
 */
import {
  BUILTIN_TOOLS,
  type BuiltinToolEntry,
  type ChainBootConfig,
  TOOL_BOOT_REGISTRARS,
} from "./builtins";
import { distance } from "./distance";
import { BuiltinToolError } from "./error";

/** One list of tools a bundle registers together, with the config that list carries. */
export type ToolSite = {
  readonly tools: ReadonlyArray<string>;
  readonly toolConfigs?: Readonly<Record<string, unknown>>;
  /** Where the site's block sits in the spec, for messages. Defaults to `tool_config`. */
  readonly path?: string;
};

/** One boot registration: call `initSymbol(config)` from `package`. */
export type ToolConfigInit = {
  /** The spec key the block was written under (`http`, `httpRequest`), or `chains`. */
  readonly key: string;
  readonly package: string;
  readonly initSymbol: string;
  readonly config: unknown;
  /**
   * Where the block sits in the spec: `tool_config.http`,
   * `steps[1].tool_config.fetch`; empty for the chain blocks, whose paths
   * start at the top of the spec.
   */
  readonly where: string;
};

/** A problem with one key: where it is and what to do about it. */
export type ToolConfigNotice = { readonly path: string; readonly message: string };

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

function entryOf(key: string): BuiltinToolEntry | undefined {
  return Object.hasOwn(BUILTIN_TOOLS, key) ? BUILTIN_TOOLS[key] : undefined;
}

/** The builtin a key or registered name names, compared without case. */
function builtinFor(keyOrName: string): { key: string; entry: BuiltinToolEntry } | undefined {
  const lower = keyOrName.toLowerCase();
  for (const [key, entry] of Object.entries(BUILTIN_TOOLS)) {
    if (key.toLowerCase() === lower || entry.name.toLowerCase() === lower) return { key, entry };
  }
  return undefined;
}

/** The tool_config registrar whose package-level keys include `key`, compared without case. */
function registrarForFamilyKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const [symbol, reg] of Object.entries(TOOL_BOOT_REGISTRARS)) {
    if (reg.source !== "tool_config") continue;
    if ((reg.keys ?? []).some((k) => k.toLowerCase() === lower)) return symbol;
  }
  return undefined;
}

function documentedKey(initSymbol: string): string {
  return TOOL_BOOT_REGISTRARS[initSymbol]?.keys?.[0] ?? initSymbol;
}

function labelOf(initSymbol: string): string {
  return TOOL_BOOT_REGISTRARS[initSymbol]?.label ?? initSymbol;
}

/**
 * The keys that reach `initSymbol` at a site whose tools are `tools`: the
 * registrar's package-level keys, and the own key and registered name of each
 * listed tool that names it. Lower-cased, because every comparison is.
 */
function acceptedKeys(initSymbol: string, tools: ReadonlyArray<string>): Set<string> {
  const keys = new Set((TOOL_BOOT_REGISTRARS[initSymbol]?.keys ?? []).map((k) => k.toLowerCase()));
  for (const key of tools) {
    const entry = entryOf(key);
    if (entry?.initSymbol !== initSymbol) continue;
    keys.add(key.toLowerCase());
    keys.add(entry.name.toLowerCase());
  }
  return keys;
}

/**
 * Every key, lower-cased, whose `tool_config` block can reach `initSymbol` at
 * boot: the registrar's package keys and the own key and registered name of
 * every tool that names it. The spec layer guards the code-execution block by
 * this set, so a spelling the boot rule accepts cannot slip past the guard.
 */
export function toolConfigKeysReaching(initSymbol: string): ReadonlySet<string> {
  return acceptedKeys(initSymbol, Object.keys(BUILTIN_TOOLS));
}

/** JSON with object keys sorted, so two equal blocks compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sitePath(site: ToolSite): string {
  return site.path ?? "tool_config";
}

// ---------------------------------------------------------------------------
// the boot rule
// ---------------------------------------------------------------------------

export type ToolConfigCheck = {
  /** One registration per registrar, in the order the tools name them. */
  readonly inits: ReadonlyArray<ToolConfigInit>;
  /** Two different blocks for one registrar. Each is a compile error. */
  readonly conflicts: ReadonlyArray<ToolConfigNotice>;
  /** Keys no listed tool reads. Each is a compile warning. */
  readonly unused: ReadonlyArray<ToolConfigNotice>;
};

/**
 * Apply the boot rule to every site of a bundle.
 *
 * Sites share one process, so a registrar configured by two sites must get
 * the same block from both; a different block is a conflict naming both.
 */
export function checkToolConfigs(sites: ReadonlyArray<ToolSite>): ToolConfigCheck {
  const inits: ToolConfigInit[] = [];
  const conflicts: ToolConfigNotice[] = [];
  const unused: ToolConfigNotice[] = [];
  const planned = new Map<string, { init: ToolConfigInit; canon: string }>();

  for (const site of sites) {
    const base = sitePath(site);
    const entries = Object.entries(site.toolConfigs ?? {}).filter(([, v]) => v !== undefined);
    const symbols: string[] = [];
    for (const key of site.tools) {
      const symbol = entryOf(key)?.initSymbol;
      if (symbol !== undefined && !symbols.includes(symbol)) symbols.push(symbol);
    }
    const consumed = new Set<string>();
    for (const symbol of symbols) {
      const accepted = acceptedKeys(symbol, site.tools);
      const matches = entries.filter(([k]) => accepted.has(k.toLowerCase()));
      for (const [k] of matches) consumed.add(k);
      const first = matches[0];
      if (first === undefined) continue;
      const canon = canonical(first[1]);
      const other = matches.find(([, v]) => canonical(v) !== canon);
      if (other !== undefined) {
        conflicts.push({
          path: `${base}.${other[0]}`,
          message: `${base}.${first[0]} and ${base}.${other[0]} both configure ${labelOf(symbol)}, and they differ. Keep one block, under ${base}.${documentedKey(symbol)}.`,
        });
        continue;
      }
      const init: ToolConfigInit = {
        key: first[0],
        package: TOOL_BOOT_REGISTRARS[symbol]?.package ?? "",
        initSymbol: symbol,
        config: first[1],
        where: `${base}.${first[0]}`,
      };
      const earlier = planned.get(symbol);
      if (earlier === undefined) {
        planned.set(symbol, { init, canon });
        inits.push(init);
      } else if (earlier.canon !== canon) {
        conflicts.push({
          path: init.where,
          message: `${earlier.init.where} and ${init.where} both configure ${labelOf(symbol)}, and they differ. A tool_config block applies to the whole process, so write the same block in both places, or keep it in one.`,
        });
      }
    }
    for (const [key] of entries) {
      if (consumed.has(key)) continue;
      unused.push({ path: `${base}.${key}`, message: unusedMessage(key, site) });
    }
  }
  return { inits, conflicts, unused };
}

/**
 * Why a key is ignored and what to write instead. The path is not repeated:
 * every caller prints it in front of the message.
 */
function unusedMessage(key: string, site: ToolSite): string {
  const tools = site.tools;
  const named = builtinFor(key);
  if (named !== undefined) {
    const symbol = named.entry.initSymbol;
    if (tools.includes(named.key)) {
      return `ignored, because ${named.key} takes no tool_config. Remove the block.`;
    }
    const sibling =
      symbol !== undefined ? tools.find((t) => entryOf(t)?.initSymbol === symbol) : undefined;
    if (sibling !== undefined && symbol !== undefined) {
      return `ignored, because ${named.key} is not in tools. To configure ${labelOf(symbol)} you use, write the block under ${sitePath(site)}.${documentedKey(symbol)}.`;
    }
    return `ignored, because ${named.key} is not in tools. Add ${named.key} to tools, or remove the block.`;
  }
  const family = registrarForFamilyKey(key);
  if (family !== undefined) {
    return `ignored, because no tool in tools reads it: it configures ${labelOf(family)}. Add one of them to tools, or remove the block.`;
  }
  const near = nearestConsumableKey(key, site);
  if (near !== undefined) {
    return `ignored, because no builtin reads this key. Did you mean ${sitePath(site)}.${near}?`;
  }
  if (key.toLowerCase() === "mcp" || key.startsWith("mcp__")) {
    return "ignored, because MCP tools do not read tool_config: an MCP server's tools take their settings from the server. Remove the block.";
  }
  const readable = consumableKeys(site);
  if (readable.length === 0) {
    return `ignored, because no builtin is called ${key}, and no tool in tools takes a tool_config block. Remove the block.`;
  }
  return `ignored, because no builtin is called ${key}. The tools here read ${readable.join(", ")}: write the block under one of those, or remove it.`;
}

/** The documented key of each registrar this site's tools name, sorted. */
function consumableKeys(site: ToolSite): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const tool of site.tools) {
    const symbol = entryOf(tool)?.initSymbol;
    if (symbol !== undefined) keys.add(documentedKey(symbol));
  }
  return [...keys].sort();
}

/**
 * The key closest to a misspelled one among those this site would read: the
 * own key of each listed tool that takes a block, and its package's keys.
 */
function nearestConsumableKey(key: string, site: ToolSite): string | undefined {
  const candidates = new Set<string>();
  for (const tool of site.tools) {
    const symbol = entryOf(tool)?.initSymbol;
    if (symbol === undefined) continue;
    candidates.add(tool);
    for (const k of TOOL_BOOT_REGISTRARS[symbol]?.keys ?? []) candidates.add(k);
  }
  let best: { key: string; d: number } | undefined;
  for (const candidate of [...candidates].sort()) {
    const d = distance(key, candidate);
    if (d > 2 || d >= key.length) continue;
    if (best === undefined || d < best.d) best = { key: candidate, d };
  }
  return best?.key;
}

/**
 * The registrations a bundle makes at boot. Throws `BuiltinToolError` when
 * two blocks for one registrar differ — the compiler reports the same text
 * with the spec path before it gets here.
 */
export function planToolConfigInits(sites: ReadonlyArray<ToolSite>): ReadonlyArray<ToolConfigInit> {
  const check = checkToolConfigs(sites);
  if (check.conflicts.length > 0) {
    throw new BuiltinToolError(check.conflicts.map((c) => c.message).join("\n"));
  }
  return check.inits;
}

/**
 * A model pool candidate's block is looked up per call (see
 * {@link toolConfigBlockFor}), so a candidate conflicts only when one tool's
 * own key, registered name and package key disagree. A key that names a
 * builtin or a package no listed tool reads is unused; any other key may be
 * meant for an MCP or plugin tool, which reads its block per call too.
 */
export function checkCandidateToolConfigs(
  tools: ReadonlyArray<string>,
  toolConfigs: Readonly<Record<string, unknown>>,
  path: string,
): {
  readonly conflicts: ReadonlyArray<ToolConfigNotice>;
  readonly unused: ReadonlyArray<ToolConfigNotice>;
} {
  const conflicts: ToolConfigNotice[] = [];
  const unused: ToolConfigNotice[] = [];
  const entries = Object.entries(toolConfigs).filter(([, v]) => v !== undefined);
  const consumed = new Set<string>();
  for (const key of tools) {
    const entry = entryOf(key);
    if (entry === undefined) continue;
    const accepted = new Set([key.toLowerCase(), entry.name.toLowerCase()]);
    if (entry.initSymbol !== undefined) {
      for (const k of TOOL_BOOT_REGISTRARS[entry.initSymbol]?.keys ?? []) {
        accepted.add(k.toLowerCase());
      }
    }
    const matches = entries.filter(([k]) => accepted.has(k.toLowerCase()));
    for (const [k] of matches) consumed.add(k);
    const first = matches[0];
    if (first === undefined) continue;
    const other = matches.find(([, v]) => canonical(v) !== canonical(first[1]));
    if (other === undefined) continue;
    const notice = {
      path: `${path}.${other[0]}`,
      message: `${path}.${first[0]} and ${path}.${other[0]} both configure ${key}, and they differ. Keep one block.`,
    };
    if (!conflicts.some((c) => c.path === notice.path)) conflicts.push(notice);
  }
  for (const [key] of entries) {
    if (consumed.has(key)) continue;
    if (builtinFor(key) === undefined && registrarForFamilyKey(key) === undefined) continue;
    unused.push({
      path: `${path}.${key}`,
      message: unusedMessage(key, { tools, path }),
    });
  }
  return { conflicts, unused };
}

/**
 * The block ONE call of `toolName` runs under, from a model pool candidate's
 * `tool_config`: the tool's own entry (its registered name or its spec key,
 * without regard to case), else its package's documented key. `undefined`
 * when the candidate declares nothing for the tool, so it keeps its boot
 * registration.
 */
export function toolConfigBlockFor(
  toolConfigs: Readonly<Record<string, unknown>> | undefined,
  toolName: string,
): unknown {
  if (toolConfigs === undefined) return undefined;
  if (toolConfigs[toolName] !== undefined) return toolConfigs[toolName];
  const builtin = builtinFor(toolName);
  const own = new Set([toolName.toLowerCase()]);
  if (builtin !== undefined) {
    own.add(builtin.key.toLowerCase());
    own.add(builtin.entry.name.toLowerCase());
  }
  for (const [key, value] of Object.entries(toolConfigs)) {
    if (value !== undefined && own.has(key.toLowerCase())) return value;
  }
  const symbol = builtin?.entry.initSymbol;
  if (symbol === undefined) return undefined;
  for (const family of TOOL_BOOT_REGISTRARS[symbol]?.keys ?? []) {
    for (const [key, value] of Object.entries(toolConfigs)) {
      if (value !== undefined && key.toLowerCase() === family.toLowerCase()) return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// $VAR references
// ---------------------------------------------------------------------------

/** A whole string value `$UPPER_SNAKE` — the same grammar `mcp_servers` accepts. */
const ENV_REF_RE = /^\$([A-Z_][A-Z0-9_]*)$/;

/** Keys whose value is a credential; a `$` value there must be a valid reference. */
const CREDENTIAL_KEY_RE = /(key|token|secret|password)$/i;

function envRefName(value: string): string | undefined {
  return value.match(ENV_REF_RE)?.[1];
}

function pathJoin(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${base}[${JSON.stringify(key)}]`;
  return base === "" ? key : `${base}.${key}`;
}

/** Every `$VAR` reference in a block, with where it sits. */
export function toolConfigEnvRefs(
  value: unknown,
  where: string,
): ReadonlyArray<{ readonly path: string; readonly name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      const name = envRefName(node);
      if (name !== undefined) out.push({ path, name });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, pathJoin(path, i)));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, pathJoin(path, k));
      }
    }
  };
  visit(value, where);
  return out;
}

/**
 * A `$` and one word, braced or not: `$slack_token`, `${API_KEY}`, `$1KEY`.
 * Only a value of this form reads as a reference; `$2b$10$…` (a bcrypt hash)
 * or `$ecret!` does not, and ships as the literal it is.
 */
const REF_LOOKALIKE_RE = /^\$(?:\{[^}]*\}|[A-Za-z0-9_]+)$/;

/**
 * A credential-shaped key (`api_key`, `token`) whose value looks like an
 * environment reference but is not a valid one is almost always a typo —
 * `$slack_token`, `${API_KEY}` — that would ship as a literal string. One
 * notice per value. The message does not repeat the path: every caller prints
 * it in front.
 */
export function malformedToolConfigRefs(
  value: unknown,
  where: string,
): ReadonlyArray<ToolConfigNotice> {
  const out: ToolConfigNotice[] = [];
  const visit = (node: unknown, path: string, key: string | undefined): void => {
    if (typeof node === "string") {
      if (
        key !== undefined &&
        CREDENTIAL_KEY_RE.test(key) &&
        REF_LOOKALIKE_RE.test(node) &&
        envRefName(node) === undefined
      ) {
        out.push({
          path,
          message:
            "looks like an environment reference, but is not one. Write $UPPER_SNAKE_CASE, for example $API_KEY — no lowercase, no leading digit, no braces. If it is the value itself, set it in an environment variable and write that variable's name here.",
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, pathJoin(path, i), key));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, pathJoin(path, k), k);
      }
    }
  };
  visit(value, where, undefined);
  return out;
}

/**
 * What a registrar would refuse in its block at boot, found at compile time:
 * the checks its row in `TOOL_BOOT_REGISTRARS` declares. A `$VAR` value is
 * skipped — it is read, and checked, when the harness starts. Each notice's
 * path is where the problem sits and its message what to write instead.
 */
export function toolConfigProblems(init: ToolConfigInit): ReadonlyArray<ToolConfigNotice> {
  const checks = TOOL_BOOT_REGISTRARS[init.initSymbol]?.checks;
  const block = init.config;
  if (checks === undefined || block === null || typeof block !== "object" || Array.isArray(block)) {
    return [];
  }
  const rec = block as Record<string, unknown>;
  const out: ToolConfigNotice[] = [];
  for (const key of checks.refused?.keys ?? []) {
    if (Object.hasOwn(rec, key)) {
      out.push({
        path: pathJoin(init.where, key),
        message: `is not accepted: ${checks.refused?.fix}.`,
      });
    }
  }
  const origins = checks.origins;
  if (origins === undefined) return out;
  const [first, ...rest] = origins.keys;
  if (first === undefined) return out;
  const both = rest.find((k) => Object.hasOwn(rec, k));
  if (origins.onlyOne === true && Object.hasOwn(rec, first) && both !== undefined) {
    out.push({
      path: init.where,
      message: `sets both ${first} and ${both}. Write the list once, as ${first}.`,
    });
    return out;
  }
  // Read the list as the registrar does, `a ?? b`: the first spelling that is
  // set wins, and with none set the last one's value (`null` included) is
  // what a registrar with `onlyOne` checks; the others default to empty.
  const key =
    origins.keys.find((k) => rec[k] !== undefined && rec[k] !== null) ??
    origins.keys[origins.keys.length - 1] ??
    first;
  const value = rec[key];
  if (value === undefined || (value === null && origins.onlyOne !== true)) return out;
  const listPath = pathJoin(init.where, key);
  const example = origins.httpsOnly === true ? "https://ipfs.io" : "https://api.example.com";
  // A registrar that iterates its list (`for … of`) takes "" as empty.
  if (value === "" && origins.onlyOne !== true) return out;
  if (!Array.isArray(value)) {
    out.push({
      path: listPath,
      message: `must be a list of origins, for example ["${example}"].`,
    });
    return out;
  }
  value.forEach((entry, i) => {
    const at = pathJoin(listPath, i);
    if (typeof entry === "string" && envRefName(entry) !== undefined) return;
    const problem = originProblem(entry, origins.httpsOnly === true);
    if (problem !== undefined) out.push({ path: at, message: problem });
  });
  return out;
}

/** Why one allow-list entry is not an origin the registrar accepts, or undefined. */
function originProblem(entry: unknown, httpsOnly: boolean): string | undefined {
  const scheme = httpsOnly ? "https" : "http or https";
  if (typeof entry !== "string") {
    return `must be an origin written as a string, such as "https://api.example.com".`;
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    const bare = /^[A-Za-z0-9.-]+(:\d+)?$/.test(entry);
    return bare
      ? `"${entry}" is not an origin: it has no scheme. Write "https://${entry}".`
      : `"${entry}" is not an origin. Write it as https://host[:port].`;
  }
  const ok = httpsOnly
    ? url.protocol === "https:"
    : url.protocol === "https:" || url.protocol === "http:";
  if (!ok) {
    return `"${url.protocol}//${url.host}" is not ${scheme}. Write it as https://host[:port].`;
  }
  return undefined;
}

/** An environment to read references from: `process.env`, or a test's map. */
export type ToolConfigEnv = Readonly<Record<string, string | undefined>>;

/**
 * Replace every `$VAR` string in a block with the variable's value. Throws
 * `BuiltinToolError` naming the variable (never a value) when one is unset or
 * empty. Returns the values read, so a caller can keep them out of messages.
 */
export function resolveToolConfigEnv(
  value: unknown,
  where: string,
  env: ToolConfigEnv,
): {
  readonly value: unknown;
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
} {
  const secrets: Array<{ name: string; value: string }> = [];
  const visit = (node: unknown, path: string): unknown => {
    if (typeof node === "string") {
      const name = envRefName(node);
      if (name === undefined) return node;
      const read = env[name];
      if (read === undefined || read === "") {
        throw new BuiltinToolError(
          `${path} reads $${name}, but ${name} is not set. Set ${name} in the environment the harness starts in.`,
        );
      }
      secrets.push({ name, value: read });
      return read;
    }
    if (Array.isArray(node)) return node.map((item, i) => visit(item, pathJoin(path, i)));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = visit(v, pathJoin(path, k));
      }
      return out;
    }
    return node;
  };
  return { value: visit(value, where), secrets };
}

/**
 * Call a registrar with a block whose `$VAR` references are read from `env`
 * first. What the environment supplied never appears in an error: a message
 * that quotes a value read that way is rewritten to name the variable
 * instead, and loses the original error's stack and cause, which would carry
 * the value too.
 */
export function applyToolConfig(
  registrar: (config: never) => void,
  config: unknown,
  where: string,
  env: ToolConfigEnv,
): void {
  const { value, secrets } = resolveToolConfigEnv(config, where, env);
  try {
    (registrar as (config: unknown) => void)(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const leaked = secrets.filter((s) => message.includes(s.value));
    if (leaked.length === 0) throw err;
    let clean = message;
    for (const s of leaked) clean = clean.split(s.value).join(`$${s.name}`);
    throw new BuiltinToolError(`${where === "" ? "chains" : where}: ${clean}`);
  }
}

/**
 * The source line a bundle runs for one registration. A block with no `$VAR`
 * reference is a plain call, as in every release before; one with a
 * reference goes through {@link applyToolConfig}, so the value is read from
 * the environment at boot and never written into the bundle.
 */
export function renderToolConfigInit(init: ToolConfigInit): {
  readonly line: string;
  readonly readsEnv: boolean;
} {
  const json = JSON.stringify(init.config);
  if (toolConfigEnvRefs(init.config, init.where).length === 0) {
    return { line: `${init.initSymbol}(${json});`, readsEnv: false };
  }
  return {
    line: `applyToolConfig(${init.initSymbol}, ${json}, ${JSON.stringify(init.where)}, process.env);`,
    readsEnv: true,
  };
}

// ---------------------------------------------------------------------------
// the chain blocks
// ---------------------------------------------------------------------------

/** A spec secret as the IR carries it. Structural: this package does not import the IR. */
type SecretRefLike =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "env"; readonly name: string };

/** The spec's chain blocks as the IR carries them. Structural, for the same reason. */
export type SpecChainBlocks = {
  readonly chains?: ReadonlyArray<{
    readonly id: string;
    readonly rpcUrls: ReadonlyArray<SecretRefLike>;
    readonly rpcPolicy: "single" | "quorum" | "fallback";
    readonly finality: ChainBootConfig["chains"][number]["finality"];
    readonly reorgTolerant: boolean;
  }>;
  readonly wallets?: ReadonlyArray<{
    readonly id: string;
    readonly chainId: string;
    readonly custody: "user-controlled" | "kms" | "hsm" | "local";
    readonly signingPolicy: "explicit-user-approval" | "policy-gated" | "automated";
  }>;
  readonly contracts?: ReadonlyArray<{ readonly id: string; readonly address: string }>;
  readonly transactionPolicy?: ChainBootConfig["transactionPolicy"];
};

/**
 * The argument every `chains`-sourced registrar receives, or `undefined` when
 * the spec declares no chain. An `$VAR` RPC URL stays a `$VAR` string here and
 * is read at boot by {@link applyToolConfig}, like any tool_config reference.
 */
export function chainBootConfig(blocks: SpecChainBlocks | undefined): ChainBootConfig | undefined {
  const chains = blocks?.chains ?? [];
  if (chains.length === 0) return undefined;
  const wallets = blocks?.wallets ?? [];
  const contracts = blocks?.contracts ?? [];
  return {
    chains: chains.map((c) => ({
      chainId: c.id,
      rpcUrls: c.rpcUrls.map((r) => (r.kind === "env" ? `$${r.name}` : r.value)),
      rpcPolicy: c.rpcPolicy,
      finality: c.finality,
      reorgTolerant: c.reorgTolerant,
    })),
    ...(wallets.length > 0
      ? {
          wallets: wallets.map((w) => ({
            id: w.id,
            chainId: w.chainId,
            custody: w.custody,
            signingPolicy: w.signingPolicy,
          })),
        }
      : {}),
    ...(contracts.length > 0
      ? { contracts: contracts.map((c) => ({ id: c.id, address: c.address })) }
      : {}),
    ...(blocks?.transactionPolicy !== undefined
      ? { transactionPolicy: blocks.transactionPolicy }
      : {}),
  };
}

/**
 * The `chains`-sourced registrations the listed tools need, in the order the
 * tools name them. Empty when the spec declares no chain: the tools then
 * refuse every call and say what to write.
 */
export function planChainInits(
  tools: ReadonlyArray<string>,
  blocks: SpecChainBlocks | undefined,
): ReadonlyArray<ToolConfigInit> {
  const config = chainBootConfig(blocks);
  if (config === undefined) return [];
  const out: ToolConfigInit[] = [];
  for (const key of tools) {
    const symbol = entryOf(key)?.chainSymbol;
    if (symbol === undefined || out.some((i) => i.initSymbol === symbol)) continue;
    out.push({
      key: "chains",
      package: TOOL_BOOT_REGISTRARS[symbol]?.package ?? "",
      initSymbol: symbol,
      config,
      // Empty, so a path inside the config reads `chains[0].rpcUrls[0]`.
      where: "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// what a bundle README says about a builtin
// ---------------------------------------------------------------------------

/** One README row's facts for a builtin: read off the table, never guessed from its name. */
export type ReadmeToolFact = {
  /** `external` when the tool crosses a network or process boundary. */
  readonly scope: "external" | "built-in";
  readonly notes: ReadonlyArray<string>;
};

/**
 * The facts a bundle README prints for each builtin its sites register, by
 * spec key or registered name. `configured by` appears only when this bundle
 * really calls the tool's registrar — a block the boot rule does not deliver
 * is not reported as configuring anything. Sites whose blocks conflict are
 * the compiler's to refuse; here the first block is reported.
 */
export function readmeToolFacts(
  sites: ReadonlyArray<ToolSite>,
  chains?: SpecChainBlocks,
): (name: string) => ReadmeToolFact | undefined {
  const check = checkToolConfigs(sites);
  const bySymbol = new Map<string, string>();
  for (const init of check.inits) bySymbol.set(init.initSymbol, init.where);
  const chainsDeclared = chainBootConfig(chains) !== undefined;
  return (name) => {
    const builtin = builtinFor(name);
    if (builtin === undefined) return undefined;
    const { entry } = builtin;
    const notes: string[] = [];
    if (entry.sandbox === true) notes.push("sandboxed");
    if (entry.justify === true) notes.push("every call carries a justification");
    const where = entry.initSymbol !== undefined ? bySymbol.get(entry.initSymbol) : undefined;
    if (where !== undefined) notes.push(`configured by \`${where}\``);
    if (entry.chainSymbol !== undefined) {
      notes.push(chainsDeclared ? "chains from the `chains` block" : "needs a `chains` block");
    }
    return { scope: entry.io !== undefined ? "external" : "built-in", notes };
  };
}

/**
 * What a spec writes to configure a builtin, for `crewhaus tools show`: its
 * package's documented `tool_config` key, and a `chains` block for a tool
 * that reads a chain. Undefined for a tool that takes no configuration.
 */
export function toolConfigHint(key: string): string | undefined {
  const entry = entryOf(key);
  if (entry === undefined) return undefined;
  const parts: string[] = [];
  if (entry.initSymbol !== undefined) parts.push(`tool_config.${documentedKey(entry.initSymbol)}`);
  if (entry.chainSymbol !== undefined) parts.push("a chains block");
  return parts.length > 0 ? parts.join(", and ") : undefined;
}
