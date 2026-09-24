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
 * on it. Only the allow-lists whose meaning is fixed are compared:
 *
 * - WebFetch's `allowed_domains` (host suffixes; an EMPTY list means every
 *   host), and
 * - `allowed_origins`, the egress allow-list of every package that has one
 *   (fetch, http, codehost, notify, obs, defi, …), where an empty list means
 *   no origin at all.
 *
 * A candidate block for a tool with no agent-level block is not compared:
 * there is no operator list for it to undermine.
 */
import { BUILTIN_TOOLS, toolConfigBlockFor } from "@crewhaus/tool-categories";

export type ToolConfigWidening = { readonly path: string; readonly message: string };

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
 * Every candidate allow-list in `candidateBlocks` that admits something the
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
    const isWebFetch = entry.initSymbol === "registerWebFetchConfig";
    const field = isWebFetch ? "allowed_domains" : "allowed_origins";
    const id = `${candidateKey}\u0000${field}`;
    if (seen.has(id)) continue;
    const extras = isWebFetch ? webFetchExtras(agent, candidate) : originExtras(agent, candidate);
    if (extras !== "all" && extras.length === 0) continue;
    seen.add(id);
    const reach =
      extras === "all"
        ? "every public host (an empty allowed_domains admits all)"
        : extras.map((e) => `"${e}"`).join(", ");
    out.push({
      path: `${candidatePath}.${candidateKey}.${field}`,
      message: `this candidate's ${entry.name} reaches ${reach}, which ${agentPath}.${agentKey}.${field} does not allow. A candidate's tool_config block REPLACES the agent-level block for that tool while the candidate serves; it does not narrow it. List only what the agent-level block allows if that was the intent.`,
    });
  }
  return out;
}
