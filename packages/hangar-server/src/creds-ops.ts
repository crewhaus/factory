/**
 * M3 · CREDENTIALS — the per-harness `.env` editor, the fleet credential
 * matrix, set-across, doctor, the secrets backend, and the MCP config lint.
 *
 * ---------------------------------------------------------------------------
 * VALUES ARE WRITE-ONLY. THIS IS THE WHOLE MODULE.
 * ---------------------------------------------------------------------------
 * A credential value may enter through a request body and reach
 * {@link upsertEnvVar}. It may NEVER:
 *   - come back in a response (routes emit KEY PRESENCE BOOLEANS only),
 *   - be stored in manager state (no cache, no registry field, no log line),
 *   - appear in a URL, a query string, or a path segment,
 *   - be echoed in an error message.
 * {@link upsertEnvVar} is the only writer: it enforces 0600, preserves
 * comments and ordering, and understands the `# NAME=` stub grammar that
 * "unset" produces. There is no delete — an unset key becomes a commented
 * stub, so the required name stays visible.
 *
 * A value IS read back into the process in exactly one place here: comparing
 * the merged spawn environment against the harness file's own value to say
 * WHICH layer supplied a key. A label comes out of that comparison, never
 * the value.
 *
 * THE REQUIRED SET is not a guess: it is the union `@crewhaus/preflight`
 * computes — every model the spec can route to (`agent.model`, fallbacks,
 * tiers, pool candidates, the judge, the budget degrade model), every
 * channel secret ref the compiled daemon gates its boot on, and every MCP
 * env-ref a boot would resolve. Cell states:
 *
 *   set             a value is present in the merged spawn environment
 *   missing         the requirement names it and nothing supplies it
 *   commented-stub  a `# NAME=` line is holding its place in `.env`
 *   informational   unset, and that is FINE — a sibling in the same
 *                   either-or group supplies the requirement (the classic
 *                   case: `ANTHROPIC_API_KEY` unset while
 *                   `ANTHROPIC_AUTH_TOKEN` is set)
 *
 * Providers that authenticate through an AMBIENT chain (Bedrock's AWS SDK
 * chain, Vertex ADC, a local endpoint baked into the model string) name no
 * variable at all, so they cannot become grid rows. They are reported as
 * `ambient[]` notes carrying preflight's own sentence, which is the honest
 * shape: there is nothing to set, and "missing" would be a lie.
 *
 * Anthropic precedence is shown, not implied: `ANTHROPIC_AUTH_TOKEN` beats
 * `ANTHROPIC_API_KEY`, and an `sk-ant-oat*` value is an OAuth token —
 * preflight's `anthropicAuthMode` mirrors the adapter's `resolveAuth`
 * contract and is the authority here.
 *
 * SET-ACROSS is the most dangerous affordance in the manager: one typed
 * value written into N harnesses' `.env` files. It is typed-confirm (the
 * operator echoes the KEY name and the SERVER verifies it), it writes each
 * harness through that harness's own `upsertEnvVar`, it reports per-harness
 * outcomes, and it keeps NOTHING.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  CHANNEL_ENV_PLATFORMS,
  type ChannelEnvPlatform,
  type PreflightItem,
  anthropicAuthMode,
  collectSpecModels,
  isEnvSet,
  lowerSpecChannels,
  mcpDryRunItems,
  modelCredentialGroups,
  modelCredentialItems,
  platformSecretRefs,
} from "@crewhaus/preflight";
import { SAFE_SEGMENT_RE } from "./constants";
import { mergedSpawnEnv } from "./env-file";
import { HttpError } from "./http";
import type { M3Context, M3Handler, M3Harness } from "./m3";
import { requireString } from "./m3";
import { maskText } from "./mask";
import { resolveInside } from "./safety";
import { type YamlNode, asRecord, asString, at, readYamlLoose } from "./yaml-scan";

// ---------------------------------------------------------------------------
// The M3 read envelope
// ---------------------------------------------------------------------------

/** The three fields EVERY M3 read answers: is there anything to show, why
 *  not when there is not, and the CLI verb that would create it. The
 *  console's `emptyState(message, verb)` takes exactly these, so a screen
 *  whose normal state is empty renders as "nothing yet" and not as a fault. */
export type M3Base = {
  readonly present: boolean;
  readonly note: string | null;
  readonly verb: string | null;
};

/** Build the envelope. `note`/`verb` default to null (nothing to explain). */
export function m3Base(present: boolean, note?: string | null, verb?: string | null): M3Base {
  return { present, note: note ?? null, verb: verb ?? null };
}

// ---------------------------------------------------------------------------
// The harness's spec, read leniently
// ---------------------------------------------------------------------------

/** The spec text + the leniently-read document. Absence is not an error:
 *  a harness with no readable spec still renders every panel, empty. */
export type HarnessSpec = {
  readonly yaml: string;
  readonly doc: YamlNode;
  readonly specName: string;
  readonly target: string;
};

/** Read `<harness>/crewhaus.yaml` through a containment-checked path. */
export function readHarnessSpec(harnessDir: string): HarnessSpec {
  const path = resolveInside(harnessDir, ["crewhaus.yaml"]);
  let yaml = "";
  if (path !== undefined) {
    try {
      yaml = readFileSync(path, "utf8");
    } catch {
      // absent or unreadable — every caller renders the empty picture
    }
  }
  const doc = readYamlLoose(yaml);
  return {
    yaml,
    doc,
    specName: asString(at(doc, ["name"])) ?? basename(harnessDir),
    target: asString(at(doc, ["target"])) ?? "cli",
  };
}

/** The spec's `mcp_servers:` block, narrowed to the shape preflight's MCP
 *  dry run reads. Entries that are not well-shaped are dropped rather than
 *  guessed at — a lint that invents a transport would report a boot failure
 *  that could never happen. */
export function mcpServersOf(doc: YamlNode): Record<string, never> | undefined {
  const block = asRecord(at(doc, ["mcp_servers"]));
  if (block === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(block)) {
    const config = asRecord(raw);
    if (config === undefined) continue;
    const transport = asString(config["transport"]);
    if (transport === "sse") {
      const url = asString(config["url"]);
      if (url === undefined) continue;
      out[name] = { transport: "sse", url, headers: stringMap(config["headers"]) };
      continue;
    }
    const command = asString(config["command"]);
    if (command === undefined) continue;
    out[name] = {
      transport: "stdio",
      command,
      args: Array.isArray(config["args"]) ? config["args"].map(String) : [],
      env: stringMap(config["env"]),
    };
  }
  return Object.keys(out).length === 0 ? undefined : (out as unknown as Record<string, never>);
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

/** The spec's `channels:` block lowered through the Section-12 secret
 *  grammar — the same lowering the compiler applies, so a boot-gate
 *  prediction here is the boot's own answer. */
export function loweredChannels(doc: YamlNode): ReturnType<typeof lowerSpecChannels> {
  return lowerSpecChannels(asRecord(at(doc, ["channels"])) ?? {});
}

// ---------------------------------------------------------------------------
// `.env` facts — names and presence, never a value on the way out
// ---------------------------------------------------------------------------

/** A syntactically valid environment variable name. Checked before any name
 *  becomes an `.env` line or a grid column. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The harness env-file chain, in precedence order (later wins). Mirrors
 *  `env-file.ts`'s chain so the editor edits the file the reader reads. */
export const ENV_CHAIN = [".env", ".env.local"] as const;

const ENV_ASSIGN_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const ENV_STUB_RE = /^[ \t]*#[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const ENV_EXPORT_PREFIX_RE = /^[ \t]*export[ \t]+/;

/** What the harness's own env files say — the RAW file view, distinct from
 *  the merged spawn environment. Values stay inside this object. */
export type EnvFileFacts = {
  /** Chain files that exist, in read order. */
  readonly files: readonly string[];
  /** Key → the chain file that last assigned it. */
  readonly assignedIn: Readonly<Record<string, string>>;
  /** Key → its value in the file chain. NEVER serialized. */
  readonly values: Readonly<Record<string, string>>;
  /** Keys held open by a `# NAME=` commented stub. */
  readonly stubs: readonly string[];
};

/** Read the harness's env-file chain. Every file is resolved through the
 *  containment helper FIRST — a `.env` symlinked out of the harness is not
 *  this harness's `.env`. */
export function readEnvFileFacts(
  harnessDir: string,
  contain: (segments: readonly string[]) => string | undefined,
): EnvFileFacts {
  const files: string[] = [];
  const assignedIn: Record<string, string> = {};
  const values: Record<string, string> = {};
  const stubs = new Set<string>();
  for (const name of ENV_CHAIN) {
    const path = contain([name]);
    if (path === undefined || !existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // unreadable — presence degrades, never throws
    }
    files.push(name);
    for (const line of text.split("\n")) {
      const stub = line.match(ENV_STUB_RE);
      if (stub?.[1] !== undefined) {
        stubs.add(stub[1]);
        continue;
      }
      const assign = line.match(ENV_ASSIGN_RE);
      if (assign?.[1] === undefined) continue;
      const key = assign[1];
      assignedIn[key] = name;
      values[key] = unquoteEnvValue(line.slice(line.indexOf("=") + 1).trim());
      stubs.delete(key);
    }
  }
  return { files, assignedIn, values, stubs: [...stubs].sort() };
}

function unquoteEnvValue(raw: string): string {
  const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : undefined;
  if (quote !== undefined && raw.length >= 2 && raw.endsWith(quote)) return raw.slice(1, -1);
  const hash = raw.indexOf(" #");
  return hash === -1 ? raw : raw.slice(0, hash).trim();
}

// ---------------------------------------------------------------------------
// The required set
// ---------------------------------------------------------------------------

/** One credential requirement: an either-or group of variable names, and
 *  what asked for it. An EMPTY group means an ambient chain (or an inline
 *  literal) answers it and there is nothing to set. */
export type CredentialRequirement = {
  /** Names that satisfy this requirement; any ONE of them is enough. */
  readonly group: readonly string[];
  /** Spec path / check that produced it (`agent.model`, `channels.slack…`). */
  readonly requiredBy: string;
  /** Human sentence for the row. */
  readonly detail: string;
  /** True when nothing needs setting. */
  readonly informational: boolean;
};

/** Every credential requirement a spec produces, from the three sources the
 *  doctor checks: the model union, the channel boot gate, and MCP env-ref
 *  resolution. Returns the requirements AND preflight's own items, so the
 *  doctor panel can render the sentences without re-deriving them. */
export function requirementsFor(
  spec: HarnessSpec,
  env: Readonly<Record<string, string | undefined>>,
): { requirements: CredentialRequirement[]; items: PreflightItem[] } {
  const requirements: CredentialRequirement[] = [];
  const items: PreflightItem[] = [];

  // 1. Models — the UNION of every model the spec can route a call to.
  // The whole list goes through `modelCredentialItems` ONCE, because it
  // dedups by requirement (five Anthropic models are one credential row, not
  // five). The per-model call below is a CLASSIFICATION probe, not a second
  // source of items.
  const models = collectSpecModels(spec.doc);
  items.push(...modelCredentialItems(models, env));
  for (const ref of models) {
    const groups = modelCredentialGroups(ref.model);
    const source = ref.sources.join(", ");
    if (groups.length > 0) {
      for (const group of groups) {
        requirements.push({
          group,
          requiredBy: source,
          detail: `${ref.model} needs ${group.join(" or ")}`,
          informational: false,
        });
      }
      continue;
    }
    // No named group. That has TWO very different causes and conflating them
    // is a lie either way: a Bedrock/Vertex/local model really does
    // authenticate through an ambient chain, while a model string outside
    // the router grammar simply cannot be reasoned about. Preflight emits an
    // item for the first and nothing for the second, so its own answer is
    // the discriminator.
    const ambient = modelCredentialItems([ref], env);
    const first = ambient[0];
    requirements.push({
      group: [],
      requiredBy: source,
      detail:
        first !== undefined
          ? maskText(first.message)
          : `${ref.model} is outside the model-router grammar, so no credential requirement can be derived from it — \`crewhaus lint\` owns a genuinely bad model string`,
      informational: true,
    });
  }

  // 2. Channels — the exact set the compiled daemon exits 2 on at boot.
  const lowered = loweredChannels(spec.doc);
  // A field the spec never gave a usable value names NO variable, so it can
  // never be a grid row — but "pinned inline in the spec" would be a lie
  // about it, and silence would hide the reason the daemon cannot start. It
  // carries preflight's own sentence, the same shape the ambient-provider
  // notes use.
  const unusable = new Map(lowered.missing.map((entry) => [entry.label, entry.message] as const));
  for (const platform of CHANNEL_ENV_PLATFORMS) {
    for (const entry of platformSecretRefs(platform, lowered.channels)) {
      const absent = unusable.get(entry.label);
      if (absent !== undefined) {
        requirements.push({
          group: [],
          requiredBy: entry.label,
          detail: maskText(absent),
          informational: true,
        });
        continue;
      }
      if (entry.ref.kind === "env") {
        requirements.push({
          group: [entry.ref.name],
          requiredBy: entry.label,
          detail: `${entry.title} — the compiled daemon exits 2 at boot without it`,
          informational: false,
        });
      } else {
        requirements.push({
          group: [],
          requiredBy: entry.label,
          detail: `${entry.title} is pinned inline in the spec — no variable is consulted (prefer a $ENV ref)`,
          informational: true,
        });
      }
    }
  }

  // 3. MCP — the env-refs a boot's `resolveMcpServerConfig` would resolve.
  const mcpItems = mcpDryRunItems(mcpServersOf(spec.doc), env);
  items.push(...mcpItems);
  for (const item of mcpItems) {
    if (item.envVar === undefined) continue;
    requirements.push({
      group: [item.envVar],
      requiredBy: item.id,
      detail: maskText(item.message),
      informational: false,
    });
  }

  return { requirements, items };
}

/** Cell state for one required credential NAME. */
export type CredentialKeyState = "set" | "missing" | "commented-stub" | "informational";

/** One row of the credential checklist. There is no field here that could
 *  hold a value, and there must never be one. */
export type CredentialKey = {
  readonly name: string;
  readonly state: CredentialKeyState;
  /** Where the merged spawn env got it, when it has it. */
  readonly source: "harness .env" | "process environment" | null;
  /** Which chain file assigned it, when a harness file did. */
  readonly sourceFile: string | null;
  /** Spec paths / checks that asked for this name. */
  readonly requiredBy: readonly string[];
  /** Sibling names that satisfy the same requirement. */
  readonly alternatives: readonly string[];
  readonly detail: string;
};

/** Fold requirements + `.env` facts + the merged environment into the
 *  presence checklist. */
export function credentialKeys(
  requirements: readonly CredentialRequirement[],
  facts: EnvFileFacts,
  env: Readonly<Record<string, string | undefined>>,
): CredentialKey[] {
  const byName = new Map<
    string,
    { requiredBy: Set<string>; alternatives: Set<string>; detail: string; satisfied: boolean }
  >();
  for (const requirement of requirements) {
    if (requirement.group.length === 0) continue;
    const satisfied = requirement.group.some((name) => isEnvSet(env, name));
    for (const name of requirement.group) {
      const row = byName.get(name) ?? {
        requiredBy: new Set<string>(),
        alternatives: new Set<string>(),
        detail: requirement.detail,
        satisfied,
      };
      row.requiredBy.add(requirement.requiredBy);
      for (const sibling of requirement.group) {
        if (sibling !== name) row.alternatives.add(sibling);
      }
      row.satisfied = row.satisfied || satisfied;
      byName.set(name, row);
    }
  }

  const stubs = new Set(facts.stubs);
  const keys: CredentialKey[] = [];
  for (const [name, row] of [...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const set = isEnvSet(env, name);
    const state: CredentialKeyState = set
      ? "set"
      : row.satisfied
        ? "informational"
        : stubs.has(name)
          ? "commented-stub"
          : "missing";
    const fromFile = facts.assignedIn[name];
    // Which layer won: the harness chain sits UNDER the process env, so a
    // merged value that differs from the file's value came from the process.
    const source: CredentialKey["source"] = !set
      ? null
      : fromFile !== undefined && env[name] === facts.values[name]
        ? "harness .env"
        : "process environment";
    keys.push({
      name,
      state,
      source,
      sourceFile: source === "harness .env" ? (fromFile ?? null) : null,
      requiredBy: [...row.requiredBy].sort(),
      alternatives: [...row.alternatives].sort(),
      detail:
        state === "informational"
          ? `not set — ${[...row.alternatives].join(" / ")} already satisfies this requirement`
          : row.detail,
    });
  }
  return keys;
}

/** The Anthropic precedence line — shown, never implied. */
export function anthropicPrecedence(env: Readonly<Record<string, string | undefined>>): {
  readonly mode: "oauth" | "api-key" | "none";
  readonly winner: string | null;
  readonly note: string;
} {
  const mode = anthropicAuthMode(env);
  const authTokenSet = isEnvSet(env, "ANTHROPIC_AUTH_TOKEN");
  const apiKeySet = isEnvSet(env, "ANTHROPIC_API_KEY");
  const winner = authTokenSet ? "ANTHROPIC_AUTH_TOKEN" : apiKeySet ? "ANTHROPIC_API_KEY" : null;
  const note =
    mode === "oauth"
      ? "ANTHROPIC_AUTH_TOKEN holds an sk-ant-oat* value — that is an OAuth (Claude subscription) token, not an API key"
      : authTokenSet && apiKeySet
        ? "both are set — ANTHROPIC_AUTH_TOKEN wins; ANTHROPIC_API_KEY is not consulted"
        : mode === "api-key"
          ? "an API key is in play"
          : "neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set";
  return { mode, winner, note };
}

// ---------------------------------------------------------------------------
// The writer — the ONLY path a value takes into a file
// ---------------------------------------------------------------------------

/** Encode a value as one `.env` scalar. Quoted whenever bare text would be
 *  re-read differently (whitespace, `#`, quotes); `\` and `"` escaped. */
function encodeEnvValue(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Result of one env write — presence only, and deliberately so.
 *
 * The field is `variable`, not `key`: `maskDeep` redacts every value under a
 * key literally NAMED `key` (that is what keeps a spec's `api_key` out of a
 * response), so a field called `key` would come back as `[redacted]` and the
 * panel would lose the very NAME it is trying to report.
 */
export type EnvWriteResult = {
  readonly variable: string;
  /** `set` when a live assignment now exists, `commented-stub` after unset. */
  readonly state: "set" | "commented-stub";
  /** How the line got there. */
  readonly how: "replaced" | "uncommented" | "appended" | "commented";
  readonly file: string;
};

/**
 * Write `KEY=value` into `path`, the ONE writer for env values.
 *
 * Ordering and comments are preserved: an existing live assignment is
 * rewritten in place (keeping any `export ` prefix), a `# KEY=` stub is
 * promoted in place so the key stays where the operator left it, and only a
 * genuinely new key is appended. The file is written 0600 AND chmod'ed to
 * 0600 afterwards — `writeFileSync`'s `mode` only applies at CREATION, so an
 * already-loose `.env` would otherwise stay loose.
 *
 * The value is a parameter and a local. It is never returned, never logged,
 * and never stored.
 */
export function upsertEnvVar(path: string, key: string, value: string): EnvWriteResult {
  if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid variable name`);
  if (value.includes("\n") || value.includes("\0")) {
    throw new HttpError(
      400,
      `the value for ${key} contains a newline — .env cannot represent that`,
    );
  }
  const lines = readEnvLines(path);
  const encoded = encodeEnvValue(value);
  let how: EnvWriteResult["how"] = "appended";
  let written = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.match(ENV_ASSIGN_RE)?.[1] === key) {
      const prefix = ENV_EXPORT_PREFIX_RE.test(line) ? "export " : "";
      lines[i] = `${prefix}${key}=${encoded}`;
      how = "replaced";
      written = true;
      break;
    }
    if (line.match(ENV_STUB_RE)?.[1] === key) {
      lines[i] = `${key}=${encoded}`;
      how = "uncommented";
      written = true;
      break;
    }
  }
  if (!written) appendEnvLine(lines, `${key}=${encoded}`);
  writeEnvFile(path, lines);
  return { variable: key, state: "set", how, file: basename(path) };
}

/**
 * Unset `key` by rewriting its line as a `# KEY=` stub.
 *
 * There is no delete. A removed line takes the requirement's NAME with it,
 * and the next doctor run has to rediscover it; a stub keeps the checklist
 * honest and is exactly what `doctor --fix` appends.
 */
export function unsetEnvVar(path: string, key: string): EnvWriteResult {
  if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid variable name`);
  const lines = readEnvLines(path);
  let how: EnvWriteResult["how"] = "appended";
  let written = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.match(ENV_ASSIGN_RE)?.[1] === key) {
      lines[i] = `# ${key}=`;
      how = "commented";
      written = true;
      break;
    }
    if (line.match(ENV_STUB_RE)?.[1] === key) {
      how = "commented";
      written = true;
      break; // already a stub — idempotent
    }
  }
  if (!written) appendEnvLine(lines, `# ${key}=`);
  writeEnvFile(path, lines);
  return { variable: key, state: "commented-stub", how, file: basename(path) };
}

/**
 * The file's lines WITHOUT the empty element a trailing newline produces.
 *
 * `writeEnvFile` re-adds exactly one terminating newline, so carrying that
 * empty element through would append a blank line on every single write —
 * a `.env` that grows a line each time the operator touches a variable.
 */
function readEnvLines(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return [];
  }
}

function appendEnvLine(lines: string[], line: string): void {
  lines.push(line);
}

function writeEnvFile(path: string, lines: readonly string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // a filesystem without POSIX modes — the write itself still succeeded
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The harness dir, or the 400 a fleet-wide call deserves. */
export function harnessDirOf(ctx: M3Context): string {
  const dir = ctx.harnessDir;
  if (dir === null) throw new HttpError(400, "not a per-harness route");
  return dir;
}

/** `ctx.contain` as a non-throwing probe — the shape the tolerant readers
 *  want, with the identical realpath check underneath. */
export function containProbe(ctx: M3Context): (segments: readonly string[]) => string | undefined {
  return (segments) => {
    try {
      return ctx.contain(segments);
    } catch {
      return undefined;
    }
  };
}

/** The per-harness credential picture, presence only. */
function envView(ctx: M3Context): Record<string, unknown> {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const facts = readEnvFileFacts(dir, containProbe(ctx));
  const { requirements } = requirementsFor(spec, ctx.env);
  const keys = credentialKeys(requirements, facts, ctx.env);
  const ambient = requirements
    .filter((requirement) => requirement.informational)
    .map((requirement) => ({ requiredBy: requirement.requiredBy, detail: requirement.detail }));
  return {
    ...m3Base(
      keys.length > 0 || ambient.length > 0,
      keys.length === 0 && ambient.length === 0
        ? "this spec names no credential requirement — no model, channel or MCP server asks for one"
        : null,
      "crewhaus doctor",
    ),
    keys,
    ambient,
    counts: {
      set: keys.filter((key) => key.state === "set").length,
      missing: keys.filter((key) => key.state === "missing").length,
      commentedStub: keys.filter((key) => key.state === "commented-stub").length,
      informational: keys.filter((key) => key.state === "informational").length,
    },
    /** Chain files that exist. The editor writes the FIRST one. */
    files: facts.files,
    editTarget: ENV_CHAIN[0],
    anthropic: anthropicPrecedence(ctx.env),
    /** Stubs no requirement asked for — left over, and still visible. */
    orphanStubs: facts.stubs.filter((name) => !keys.some((key) => key.name === name)),
    valuesNote:
      "every field here is a NAME or a presence state — no route in this group emits a value",
  };
}

export const env: M3Handler = (ctx) => envView(ctx);

/** `POST /api/h/:id/env` — set one key. The value dies with the request. */
export const envSet: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const key = requireString(ctx.body, "key");
  const value = ctx.body["value"];
  if (typeof value !== "string") throw new HttpError(400, 'missing "value" string');
  if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid variable name`);
  const write = upsertEnvVar(ctx.contain([ENV_CHAIN[0]]), key, value);
  // Re-read PRESENCE. The value is already gone from this process.
  return { ...envView(ctx), wrote: write };
};

/** `DELETE /api/h/:id/env/:key` — unset one key as a `# KEY=` stub. */
export const envUnset: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const key = ctx.params["key"] ?? "";
  if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid variable name`);
  const write = unsetEnvVar(ctx.contain([ENV_CHAIN[0]]), key);
  return { ...envView(ctx), wrote: write };
};

function matrixRow(harness: M3Harness, baseEnv: Readonly<Record<string, string | undefined>>) {
  const spec = readHarnessSpec(harness.dir);
  const facts = readEnvFileFacts(harness.dir, (segments) => resolveInside(harness.dir, segments));
  // The merged spawn env for THIS harness — the picture its own boot sees.
  const merged = mergedSpawnEnv(baseEnv, harness.dir).env;
  const { requirements } = requirementsFor(spec, merged);
  return { spec, keys: credentialKeys(requirements, facts, merged) };
}

/**
 * `GET /api/credentials` — the fleet matrix.
 *
 * Harness × credential-NAME grid. Columns are the union of every harness's
 * required set; cells carry the four states and nothing else. This is the
 * screen that answers "which harnesses are one key away from running".
 *
 * Containment here cannot use `ctx.contain` — that closure is bound to a
 * single harness and a fleet fold walks many — so each harness's reads go
 * through `resolveInside(harness.dir, …)`, the same realpath check, applied
 * per file.
 */
export const credentialsMatrix: M3Handler = (ctx) => {
  const harnesses: Array<Record<string, unknown>> = [];
  const allKeys = new Map<string, { requiredBy: number; missing: number }>();
  let unreadable = 0;
  for (const harness of ctx.harnesses()) {
    // A FOLD OVER THE FLEET DEGRADES PER ROW, NEVER AS A WHOLE. One harness
    // whose spec cannot be read — an unfinished channels block, a torn file,
    // a permission error — used to take this shared screen down for every
    // other harness on the manager. The row says what happened; the fleet
    // keeps its answer. The reason is masked: a parse failure can quote the
    // document it choked on.
    let row: { spec: HarnessSpec; keys: CredentialKey[] };
    try {
      row = matrixRow(harness, ctx.env);
    } catch (err) {
      unreadable += 1;
      harnesses.push({
        id: harness.id,
        specName: harness.specName,
        cells: [],
        missing: 0,
        unreadable: maskText(
          err instanceof Error ? err.message : "its credential requirements could not be derived",
        ),
      });
      continue;
    }
    const { spec, keys } = row;
    for (const key of keys) {
      const tally = allKeys.get(key.name) ?? { requiredBy: 0, missing: 0 };
      tally.requiredBy += 1;
      if (key.state === "missing") tally.missing += 1;
      allKeys.set(key.name, tally);
    }
    harnesses.push({
      id: harness.id,
      specName: spec.specName,
      cells: keys.map((key) => ({ name: key.name, state: key.state, source: key.source })),
      missing: keys.filter((key) => key.state === "missing").length,
      unreadable: null,
    });
  }
  const keys = [...allKeys.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, tally]) => ({ name, requiredBy: tally.requiredBy, missing: tally.missing }));
  return {
    ...m3Base(
      harnesses.length > 0,
      harnesses.length === 0
        ? "no harnesses are registered with this manager yet"
        : unreadable > 0
          ? `${unreadable} harness${unreadable === 1 ? "" : "es"} could not be read — those rows say why, and the rest of the fleet is unaffected`
          : null,
      "crewhaus hangar add <dir>",
    ),
    harnesses,
    unreadable,
    keys,
    /** A live fold, computed for this request — not a cached figure. */
    asOf: new Date(ctx.now()).toISOString(),
    valuesNote: "this grid carries NAMES and presence states only — never a value",
  };
};

/**
 * `POST /api/credentials/set` — set one key across selected harnesses.
 *
 * TYPED CONFIRM: the operator echoes the KEY NAME and the server verifies
 * it. A fleet-wide write has no single harness to name, and the key is the
 * thing that is about to change everywhere — so the key is the phrase. With
 * no harnesses selected there is nothing to write, and the request is a
 * reported no-op rather than a refusal.
 *
 * Each harness is written through its OWN `.env`, and a partial failure is
 * reported PER HARNESS — collapsing five successes and one permission error
 * into "failed" is how an operator ends up with a half-configured fleet and
 * no idea which half.
 */
export const credentialsSetAcross: M3Handler = (ctx) => {
  const key = requireString(ctx.body, "key");
  if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `"${key}" is not a valid variable name`);
  const value = ctx.body["value"];
  if (typeof value !== "string") throw new HttpError(400, 'missing "value" string');
  const rawIds = ctx.body["harnessIds"];
  if (!Array.isArray(rawIds)) throw new HttpError(400, 'missing "harnessIds" array');
  const ids = rawIds.map((id) => String(id));
  if (ids.length > 0 && ctx.body["confirmName"] !== key) {
    throw new HttpError(
      409,
      `writing ${key} into ${ids.length} harness${ids.length === 1 ? "" : "es"} needs a typed confirmation: send "confirmName": "${key}"`,
    );
  }
  const live = new Map(ctx.harnesses().map((harness) => [harness.id, harness] as const));
  const results = ids.map((id) => {
    const harness = live.get(id);
    if (harness === undefined) {
      return { harnessId: id, ok: false, reason: "not a registered, live harness" };
    }
    const path = resolveInside(harness.dir, [ENV_CHAIN[0]]);
    if (path === undefined) {
      return { harnessId: id, ok: false, reason: "the .env path escapes the harness directory" };
    }
    try {
      const write = upsertEnvVar(path, key, value);
      return { harnessId: id, ok: true, specName: harness.specName, how: write.how };
    } catch (err) {
      // The reason is ours, never the value: `upsertEnvVar` refuses by NAME
      // and a filesystem error carries a path, not a secret.
      return {
        harnessId: id,
        ok: false,
        reason: err instanceof HttpError ? err.message : "write failed",
      };
    }
  });
  return {
    // `variable`, not `key`: a field literally named `key` is redacted by
    // `maskDeep` on the way out, and this one carries the NAME the operator
    // just wrote everywhere — the single most important word in the answer.
    variable: key,
    written: results.filter((result) => result.ok),
    refused: results.filter((result) => !result.ok),
    expectedConfirm: key,
    note:
      ids.length === 0
        ? "no harnesses were selected — nothing was written"
        : "the value was written and discarded; this manager kept no copy",
  };
};

/** `GET /api/h/:id/doctor` — the offline doctor picture. */
export const doctor: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const { items } = requirementsFor(spec, ctx.env);
  const checks = items.map((item) => ({
    id: item.id,
    area: item.area,
    level: item.level,
    // A lint QUOTES the literal it found, so the message is free text and
    // gets the value-shape masker itself — key-based redaction cannot see
    // into a sentence.
    message: maskText(item.message),
    remediation: item.remediation === undefined ? null : maskText(item.remediation),
    envVar: item.envVar ?? null,
  }));
  const last = ctx.jobs.recent(50).find((job) => job.kind === "doctor" && job.harnessDir === dir);
  return {
    ...m3Base(
      checks.length > 0,
      checks.length === 0 ? "this spec gives the offline doctor nothing to check" : null,
      "crewhaus doctor",
    ),
    checks,
    counts: {
      blocking: checks.filter((check) => check.level === "blocking").length,
      warn: checks.filter((check) => check.level === "warn").length,
      info: checks.filter((check) => check.level === "info").length,
    },
    anthropic: anthropicPrecedence(ctx.env),
    lastRun:
      last === undefined
        ? null
        : {
            jobId: last.jobId,
            state: last.state,
            exitCode: last.exitCode ?? null,
            endedAt: last.endedAt ?? null,
            probed: last.argv.includes("--probe"),
          },
    probeNote:
      "--probe spends a real provider call to tell a wrong key apart from an out-of-funds account, so it is opt-in",
    fixNote: "--fix only ever APPENDS commented `# NAME=` stubs; it never writes a value",
  };
};

/** `POST /api/h/:id/doctor` — run `crewhaus doctor` through the job queue. */
export const doctorRun: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  // A CLOSED vocabulary: two literal flags, and nothing from the body ever
  // reaches argv.
  const argv = ["doctor"];
  if (ctx.body["probe"] === true) argv.push("--probe");
  if (ctx.body["fix"] === true) argv.push("--fix");
  const job = ctx.submitJob("doctor", argv);
  return {
    job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
    probed: argv.includes("--probe"),
    fixed: argv.includes("--fix"),
    note: argv.includes("--fix")
      ? "--fix appends commented `# NAME=` stubs for the providers this spec needs; it writes no values"
      : "offline checks only — pass probe to spend one provider call per configured provider",
  };
};

// ---------------------------------------------------------------------------
// The secrets backend — names, never material
// ---------------------------------------------------------------------------

const SECRETS_DIR = [".crewhaus", "secrets"] as const;

/** File-backend secret NAMES + metadata. A secret file's CONTENT *is* the
 *  secret, so nothing here opens one: names, mtimes and modes only. */
function secretsInventory(ctx: M3Context): {
  names: Array<{ name: string; rotatedAt: string | null; mode: string | null }>;
  dirPresent: boolean;
} {
  const contain = containProbe(ctx);
  const root = contain([...SECRETS_DIR]);
  if (root === undefined || !existsSync(root)) return { names: [], dirPresent: false };
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return { names: [], dirPresent: true };
  }
  const names: Array<{ name: string; rotatedAt: string | null; mode: string | null }> = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || entry.endsWith(".tmp")) continue;
    if (!SAFE_SEGMENT_RE.test(entry)) continue;
    // Per FILE: a listed name can be a symlink out of the harness tree.
    const path = contain([...SECRETS_DIR, entry]);
    if (path === undefined) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      names.push({
        name: entry,
        rotatedAt: new Date(stat.mtimeMs).toISOString(),
        mode: `0${(stat.mode & 0o777).toString(8)}`,
      });
    } catch {
      // vanished between the listing and the stat — skip it
    }
  }
  return { names, dirPresent: true };
}

/** `GET /api/h/:id/secrets` — the secrets backend, names only. */
export const secrets: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const { names, dirPresent } = secretsInventory(ctx);
  return {
    ...m3Base(
      names.length > 0,
      names.length > 0
        ? null
        : dirPresent
          ? "the secrets directory exists but holds no secrets yet"
          : "this harness has no file-backed secrets store — credentials come from its .env chain",
      "crewhaus secrets rotate <name> --backend file",
    ),
    backend: dirPresent ? "file" : "env-var",
    names,
    looseModes: names.filter((entry) => entry.mode !== "0600").map((entry) => entry.name),
    valuesNote: "a secret file's CONTENT is the secret — this route never opens one",
  };
};

/** `GET /api/h/:id/secrets/doctor` — reachability, and the names a running
 *  harness expects but cannot resolve from either layer. */
export const secretsDoctor: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const { names, dirPresent } = secretsInventory(ctx);
  const stored = new Set(names.map((entry) => entry.name));
  const { requirements } = requirementsFor(spec, ctx.env);
  const unresolved: Array<{ name: string; requiredBy: string }> = [];
  for (const requirement of requirements) {
    if (requirement.informational) continue;
    if (requirement.group.some((name) => isEnvSet(ctx.env, name))) continue;
    for (const name of requirement.group) {
      if (stored.has(name)) continue;
      unresolved.push({ name, requiredBy: requirement.requiredBy });
    }
  }
  return {
    ...m3Base(
      dirPresent || unresolved.length > 0,
      dirPresent
        ? null
        : "no file-backed secrets store — the env-var backend is in use, so `.env` presence IS the answer",
      "crewhaus secrets doctor --backend file",
    ),
    backend: dirPresent ? "file" : "env-var",
    reachable: dirPresent,
    stored: [...stored].sort(),
    unresolved,
  };
};

/**
 * `POST /api/h/:id/secrets/:name/rotate` — NOT BUILT, deliberately.
 *
 * Rotation is the one write in this module the manager cannot perform
 * safely with what it has:
 *
 *   - `@crewhaus/secrets-manager` — whose `rotate` is the sanctioned writer,
 *     because it is the call that fires `onRotation` — is not a dependency
 *     of this package, and adding one is not this module's call to make.
 *   - The CLI fallback, `crewhaus secrets rotate <name> --value <value>`,
 *     puts the VALUE in argv, where any process on the box can read it out
 *     of the process table. That is the exact leak this module exists to
 *     prevent, so the job queue is not an escape hatch here.
 *
 * A 501 says "the route is real, the handler is not" — which is true, and is
 * a far better answer than a rotation that silently leaks.
 */
export const secretsRotate: M3Handler = () => {
  throw new HttpError(
    501,
    "not implemented (M3): secret rotate — needs @crewhaus/secrets-manager's rotate (not a dependency of this package); the CLI fallback would put the value in argv",
  );
};

/**
 * `GET /api/h/:id/mcp/lint` — the MCP config linter.
 *
 * A `resolveMcpServerConfig` dry run through `@crewhaus/preflight`, which
 * calls the SAME resolver a boot calls — so an "unset env-ref" finding
 * carries the byte-identical `ConfigError` the process would die with rather
 * than an approximation of it.
 *
 * Findings QUOTE the offending literal (that is what makes them
 * actionable), so every message goes through the value-shape masker here.
 */
export const mcpLint: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const servers = mcpServersOf(spec.doc);
  const findings = mcpDryRunItems(servers, ctx.env).map((item) => ({
    id: item.id,
    level: item.level,
    message: maskText(item.message),
    remediation: item.remediation === undefined ? null : maskText(item.remediation),
    envVar: item.envVar ?? null,
    kind: lintKind(item),
  }));
  return {
    ...m3Base(
      servers !== undefined,
      servers === undefined ? "this spec declares no mcp_servers: block" : null,
      "crewhaus mcp doctor",
    ),
    findings,
    servers: servers === undefined ? [] : Object.keys(servers),
    counts: {
      blocking: findings.filter((finding) => finding.level === "blocking").length,
      warn: findings.filter((finding) => finding.level === "warn").length,
      info: findings.filter((finding) => finding.level === "info").length,
    },
  };
};

/** The four finding classes the linter distinguishes, keyed off preflight's
 *  own message so the taxonomy cannot drift from what it reports. */
function lintKind(item: PreflightItem): string {
  if (item.message.startsWith("compilation will fail")) return "compile-error";
  if (item.level === "blocking") return "unset-env-ref";
  if (item.message.includes("NOT expanded")) return "unexpanded-literal";
  if (item.message.includes("inline literal")) return "inline-credential";
  return "resolved";
}

/** Re-exported for `channels-ops.ts`, which enumerates the same platforms. */
export type { ChannelEnvPlatform };
