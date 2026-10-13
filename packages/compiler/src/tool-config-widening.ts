/**
 * `model-plan-tool-config-widens` — a model_pool candidate whose `tool_config`
 * lets a tool reach MORE than the agent-level block does.
 *
 * A candidate's `tool_config` block REPLACES the agent-level block for that
 * tool while the candidate serves (runtime-core hands it to the tool as
 * `ctx.toolConfig`, and every `resolve*Config(override)` builds from it
 * alone). That is the documented, deliberate design: a candidate may need a
 * different allow-list, and intersecting would break it. What it is NOT is a
 * narrowing — unlike a candidate's `tools` subset and `permissions` — and
 * nothing said so at compile time, so `webFetch: { allowed_domains: [] }` on
 * one candidate silently meant "every host" beside an agent-level list of
 * one domain.
 *
 * This names each such case. It is informational: the spec is legal, ran the
 * same on 0.7.0, and may mean exactly what it says, so `--strict` never fails
 * on it. Only the lists whose meaning is fixed are compared:
 *
 * - WebFetch's `allowed_domains` (host suffixes; an EMPTY list means every
 *   host), and
 * - `allowed_origins`, the egress allow-list of every package that has one
 *   (fetch, http, codehost, notify, obs, defi, …), where an empty list means
 *   no origin at all;
 * - the credential lists, where a candidate could add a process secret such
 *   as ANTHROPIC_API_KEY or drop an origin binding (net attacker review):
 *   http's `allowed_auth_envs` (a list, or a map binding a name to origins)
 *   and `allowed_signing_envs`, notify's `allowed_secret_envs` and the
 *   `auth.envVar` of its `providers`, codehost's `token_envs`, and the
 *   `token_env` and `base_url` of codehost and obs;
 * - the destination lists, where a candidate could reach more people:
 *   notify's `allowed_sms_recipients` and `allowed_push_targets` (an entry
 *   ending in `*` is a prefix), `allowed_recipients` (`*@domain` covers the
 *   domain) and `allowed_smtp_hosts`.
 *
 * Every one of these fails closed when empty, so only what the candidate
 * lists beyond the agent-level block is named. A candidate block for a tool
 * with no agent-level block is not compared: there is no operator list for
 * it to undermine.
 *
 * Two families do not replace: for the chain readers and FederationDiscover
 * (`candidateNarrows` on their registrar) a candidate's `allowed_origins`
 * narrows the agent's, per call. A candidate origin the agent does not list
 * is then never reached (`model-plan-tool-config-narrowed`, informational),
 * and a candidate list that keeps none reaches nothing at all
 * (`model-plan-tool-config-unreachable`, which `--strict` fails on).
 */
import { BUILTIN_TOOLS, TOOL_BOOT_REGISTRARS, toolConfigBlockFor } from "@crewhaus/tool-categories";

export type ToolConfigWidening = {
  readonly path: string;
  readonly message: string;
  /**
   * `model-plan-tool-config-widens` (the default, informational) for a
   * candidate block that REPLACES the agent's and admits more;
   * `model-plan-tool-config-narrowed` (informational) for a candidate origin
   * a narrowing family drops; `model-plan-tool-config-unreachable`
   * (remediable) for a narrowing family's candidate list that keeps no
   * origin at all, so every call of that candidate is refused.
   */
  readonly code?: "model-plan-tool-config-narrowed" | "model-plan-tool-config-unreachable";
};

type Block = Readonly<Record<string, unknown>>;

function asBlock(value: unknown): Block | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Block)
    : undefined;
}

/** A string-array field under either spelling the registrars accept. */
function listField(block: Block, snake: string, camel: string): string[] | undefined {
  const raw = block[camel] ?? block[snake];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === "string");
}

/** An origin as the registrars compare it: lowercase, default port elided. */
function canonicalOrigin(raw: string): string {
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** The key under which `blocks` holds `block`, for the path in a notice. */
function keyOf(blocks: Block, block: unknown): string {
  return Object.entries(blocks).find(([, v]) => v === block)?.[0] ?? "?";
}

/** Entries of `wide` that `narrow` does not admit, or "all" when `wide` admits every host. */
function webFetchExtras(narrow: Block, wide: Block): readonly string[] | "all" {
  const agent = (listField(narrow, "allowed_domains", "allowedDomains") ?? []).map((d) =>
    d.toLowerCase(),
  );
  if (agent.length === 0) return []; // the agent-level block already admits every host
  const candidate = (listField(wide, "allowed_domains", "allowedDomains") ?? []).map((d) =>
    d.toLowerCase(),
  );
  if (candidate.length === 0) return "all";
  return candidate.filter((d) => !agent.some((a) => d === a || d.endsWith(`.${a}`)));
}

function originExtras(narrow: Block, wide: Block): readonly string[] {
  const agent = new Set(
    (listField(narrow, "allowed_origins", "allowedOrigins") ?? []).map(canonicalOrigin),
  );
  const candidate = (listField(wide, "allowed_origins", "allowedOrigins") ?? []).map(
    canonicalOrigin,
  );
  return [...new Set(candidate.filter((o) => !agent.has(o)))];
}

/**
 * For a family whose candidate list narrows the agent's: the candidate
 * origins the agent list drops, and the ones it keeps. `undefined` when
 * either block sets no list, or nothing is dropped.
 */
function narrowing(
  agentBlock: Block,
  candidateBlock: Block,
): { readonly kept: readonly string[]; readonly dropped: readonly string[] } | undefined {
  const agentList = listField(agentBlock, "allowed_origins", "allowedOrigins");
  const candidateList = listField(candidateBlock, "allowed_origins", "allowedOrigins");
  if (agentList === undefined || candidateList === undefined) return undefined;
  const agent = new Set(agentList.map(canonicalOrigin));
  const candidate = [...new Set(candidateList.map(canonicalOrigin))];
  const dropped = candidate.filter((o) => !agent.has(o));
  if (dropped.length === 0) return undefined;
  return { kept: candidate.filter((o) => agent.has(o)), dropped };
}

/** A value in a candidate block beyond the agent-level one, as text for a notice. */
type Extras = readonly string[] | "all";

/** Variable names and, when the operator bound one, the origins its credential may go to. */
function envBindings(raw: unknown): Map<string, ReadonlySet<string> | null> {
  const out = new Map<string, ReadonlySet<string> | null>();
  if (Array.isArray(raw)) {
    for (const name of raw) if (typeof name === "string") out.set(name, null);
    return out;
  }
  const block = asBlock(raw);
  if (block === undefined) return out;
  for (const [name, origins] of Object.entries(block)) {
    out.set(
      name,
      Array.isArray(origins)
        ? new Set(origins.filter((o): o is string => typeof o === "string").map(canonicalOrigin))
        : null,
    );
  }
  return out;
}

/** Names the candidate may read that the agent does not list, or that it binds less tightly. */
function envExtras(snake: string, camel: string): (agent: Block, candidate: Block) => Extras {
  return (agent, candidate) => {
    const narrow = envBindings(agent[camel] ?? agent[snake]);
    const out: string[] = [];
    for (const [name, origins] of envBindings(candidate[camel] ?? candidate[snake])) {
      if (!narrow.has(name)) {
        out.push(`"${name}"`);
        continue;
      }
      const bound = narrow.get(name);
      if (bound === null || bound === undefined) continue;
      if (origins === null) {
        out.push(`"${name}" (sent to any allowed origin, not only ${[...bound].join(", ")})`);
        continue;
      }
      const more = [...origins].filter((o) => !bound.has(o));
      if (more.length > 0) out.push(`"${name}" (also sent to ${more.join(", ")})`);
    }
    return out;
  };
}

/** A single string setting the candidate sets differently from the agent. */
function settingExtras(
  snake: string,
  camel: string,
  canon: (v: string) => string = (v) => v,
): (agent: Block, candidate: Block) => Extras {
  return (agent, candidate) => {
    const theirs = candidate[camel] ?? candidate[snake];
    if (typeof theirs !== "string" || theirs.trim() === "") return [];
    const ours = agent[camel] ?? agent[snake];
    return typeof ours === "string" && canon(ours) === canon(theirs) ? [] : [`"${theirs}"`];
  };
}

/**
 * A `base_url` the candidate points elsewhere, when the candidate's block
 * configures a token: `token_env`'s token goes only to `base_url`'s origin.
 */
function baseUrlExtras(agent: Block, candidate: Block): Extras {
  const token =
    candidate["token_env"] ??
    candidate["tokenEnv"] ??
    candidate["token_envs"] ??
    candidate["tokenEnvs"];
  if (token === undefined) return [];
  return settingExtras("base_url", "baseUrl", canonicalOrigin)(agent, candidate);
}

/** Destination entries the candidate lists that no agent-level entry covers. */
function destinationExtras(
  snake: string,
  camel: string,
  covers: (agentEntry: string, candidateEntry: string) => boolean,
  canon: (v: string) => string,
): (agent: Block, candidate: Block) => Extras {
  return (agent, candidate) => {
    const narrow = (listField(agent, snake, camel) ?? []).map(canon);
    const wide = (listField(candidate, snake, camel) ?? []).map(canon);
    return [...new Set(wide.filter((e) => !narrow.some((a) => covers(a, e))))].map((e) => `"${e}"`);
  };
}

/** An entry ending in `*` covers every value with that prefix, including a narrower prefix. */
function prefixCovers(agentEntry: string, candidateEntry: string): boolean {
  if (agentEntry === candidateEntry) return true;
  if (!agentEntry.endsWith("*")) return false;
  const stem = agentEntry.slice(0, -1);
  return candidateEntry.startsWith(stem);
}

/** `*@domain` covers every address at the domain, and `*@domain` itself. */
function recipientCovers(agentEntry: string, candidateEntry: string): boolean {
  if (agentEntry === candidateEntry) return true;
  if (!agentEntry.startsWith("*@")) return false;
  const at = candidateEntry.lastIndexOf("@");
  return at >= 0 && candidateEntry.slice(at + 1) === agentEntry.slice(2);
}

/** The separators people write in a phone number, removed, as notify compares them. */
function smsCanon(raw: string): string {
  let out = "";
  for (const ch of raw.trim()) {
    if (ch === " " || ch === "-" || ch === "." || ch === "(" || ch === ")") continue;
    out += ch;
  }
  return out;
}

const lower = (v: string): string => v.trim().toLowerCase();

/** Stable JSON text, object keys sorted, for comparing two provider profiles. */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) => {
      const block = asBlock(v);
      if (block === undefined) return v;
      return Object.fromEntries(
        Object.keys(block)
          .sort()
          .map((k) => [k, block[k]]),
      );
    }) ?? "undefined"
  );
}

/** Providers the candidate defines that the agent-level block does not define identically. */
function providerExtras(agent: Block, candidate: Block): Extras {
  const ours = asBlock(agent["providers"]) ?? {};
  const theirs = asBlock(candidate["providers"]) ?? {};
  return Object.keys(theirs)
    .filter((name) => canonicalJson(ours[name]) !== canonicalJson(theirs[name]))
    .map((name) => `"${name}"`);
}

/**
 * The fields compared beyond `allowed_origins`, with what a notice says the
 * candidate does. Each is read only where the field appears in a block.
 */
const CREDENTIAL_AND_DESTINATION_FIELDS: ReadonlyArray<{
  readonly field: string;
  readonly extras: (agent: Block, candidate: Block) => Extras;
  readonly says: string;
}> = [
  {
    field: "allowed_auth_envs",
    extras: envExtras("allowed_auth_envs", "allowedAuthEnvs"),
    says: "may send the credential in",
  },
  {
    field: "allowed_signing_envs",
    extras: envExtras("allowed_signing_envs", "allowedSigningEnvs"),
    says: "may sign with the secret in",
  },
  {
    field: "allowed_secret_envs",
    extras: envExtras("allowed_secret_envs", "allowedSecretEnvs"),
    says: "may send the credential in",
  },
  {
    field: "token_envs",
    extras: envExtras("token_envs", "tokenEnvs"),
    says: "may send the token in",
  },
  {
    field: "token_env",
    extras: settingExtras("token_env", "tokenEnv"),
    says: "sends the token in",
  },
  { field: "base_url", extras: baseUrlExtras, says: "sends its token to" },
  { field: "providers", extras: providerExtras, says: "defines the provider" },
  {
    field: "allowed_sms_recipients",
    extras: destinationExtras(
      "allowed_sms_recipients",
      "allowedSmsRecipients",
      prefixCovers,
      smsCanon,
    ),
    says: "may text",
  },
  {
    field: "allowed_push_targets",
    extras: destinationExtras("allowed_push_targets", "allowedPushTargets", prefixCovers, (v) =>
      v.trim(),
    ),
    says: "may push to",
  },
  {
    field: "allowed_recipients",
    extras: destinationExtras("allowed_recipients", "allowedRecipients", recipientCovers, lower),
    says: "may email",
  },
  {
    field: "allowed_smtp_hosts",
    extras: destinationExtras("allowed_smtp_hosts", "allowedSmtpHosts", (a, e) => a === e, lower),
    says: "may connect to the SMTP host",
  },
];

/**
 * Every candidate list in `candidateBlocks` that admits something the
 * agent-level `agentBlocks` does not, for the tools a site lists. One notice
 * per candidate block and field, however many tools read that block.
 */
export function toolConfigWidenings(
  tools: ReadonlyArray<string>,
  agentBlocks: Block,
  agentPath: string,
  candidateBlocks: Block,
  candidatePath: string,
): ReadonlyArray<ToolConfigWidening> {
  const out: ToolConfigWidening[] = [];
  const seen = new Set<string>();
  const note = (
    candidateKey: string,
    agentKey: string,
    tool: string,
    field: string,
    doing: string,
  ): void => {
    out.push({
      path: `${candidatePath}.${candidateKey}.${field}`,
      message: `this candidate's ${tool} ${doing}, which ${agentPath}.${agentKey}.${field} does not allow. A candidate's tool_config block REPLACES the agent-level block for that tool while the candidate serves; it does not narrow it. List only what the agent-level block allows if that was the intent.`,
    });
  };
  for (const key of tools) {
    const entry = Object.hasOwn(BUILTIN_TOOLS, key) ? BUILTIN_TOOLS[key] : undefined;
    if (entry === undefined) continue;
    const agentRaw = toolConfigBlockFor(agentBlocks, key);
    const candidateRaw = toolConfigBlockFor(candidateBlocks, key);
    const agent = asBlock(agentRaw);
    const candidate = asBlock(candidateRaw);
    if (agent === undefined || candidate === undefined) continue;
    const candidateKey = keyOf(candidateBlocks, candidateRaw);
    const agentKey = keyOf(agentBlocks, agentRaw);
    if (
      entry.initSymbol !== undefined &&
      TOOL_BOOT_REGISTRARS[entry.initSymbol]?.candidateNarrows === true
    ) {
      const id = `${candidateKey}\u0000allowed_origins`;
      if (seen.has(id)) continue;
      const narrowed = narrowing(agent, candidate);
      if (narrowed === undefined) continue;
      seen.add(id);
      const at = `${agentPath}.${agentKey}.allowed_origins`;
      const dropped = narrowed.dropped.map((e) => `"${e}"`).join(", ");
      out.push(
        narrowed.kept.length === 0
          ? {
              code: "model-plan-tool-config-unreachable",
              path: `${candidatePath}.${candidateKey}.allowed_origins`,
              message: `this candidate's ${entry.name} lists ${dropped}, none of which ${at} allows. For ${entry.name} a candidate's list NARROWS the agent-level one — a call reaches only origins on both — so this candidate reaches no origin and every call it makes is refused. List origins the agent-level block allows.`,
            }
          : {
              code: "model-plan-tool-config-narrowed",
              path: `${candidatePath}.${candidateKey}.allowed_origins`,
              message: `this candidate's ${entry.name} lists ${dropped}, which ${at} does not allow. For ${entry.name} a candidate's list NARROWS the agent-level one — a call reaches only origins on both — so ${narrowed.dropped.length === 1 ? "it is" : "they are"} never reached.`,
            },
      );
      continue;
    }
    const isWebFetch = entry.initSymbol === "registerWebFetchConfig";
    const field = isWebFetch ? "allowed_domains" : "allowed_origins";
    const id = `${candidateKey}\u0000${field}`;
    if (!seen.has(id)) {
      const extras = isWebFetch ? webFetchExtras(agent, candidate) : originExtras(agent, candidate);
      if (extras === "all" || extras.length > 0) {
        seen.add(id);
        const reach =
          extras === "all"
            ? "every public host (an empty allowed_domains admits all)"
            : extras.map((e) => `"${e}"`).join(", ");
        note(candidateKey, agentKey, entry.name, field, `reaches ${reach}`);
      }
    }
    if (isWebFetch) continue;
    for (const check of CREDENTIAL_AND_DESTINATION_FIELDS) {
      const checkId = `${candidateKey}\u0000${check.field}`;
      if (seen.has(checkId)) continue;
      const extras = check.extras(agent, candidate);
      if (extras !== "all" && extras.length === 0) continue;
      seen.add(checkId);
      const reach = extras === "all" ? "anything" : extras.join(", ");
      note(candidateKey, agentKey, entry.name, check.field, `${check.says} ${reach}`);
    }
  }
  return out;
}
