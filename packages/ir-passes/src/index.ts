/**
 * Section 28 — `ir-passes`. Idempotent IR optimization passes; each pass
 * is a pure `(IrNode) → IrNode` function. The pipeline is composable and
 * deterministic: same input → same output regardless of pass order
 * (within the published "safe order" — see `applyPasses`).
 *
 * Built-in passes:
 *  - `deadToolElimination` — drop entries from `tools` that no sub-agent
 *    or permission rule references. Catches the common case where a spec
 *    declares `tools: [Read, Write, Bash]` then locks Write down with an
 *    `alwaysDeny` rule and never uses it elsewhere.
 *  - `redundantMcpServerCollapse` — dedup `mcp_servers` map entries by
 *    `(transport, command, args)` signature so two specs that import the
 *    same server under different keys collapse into one boot per process.
 *  - `permissionRuleCanonicalize` — sort + dedup `permissions.rules` by
 *    canonical (type, pattern) tuples; preserves source priority order
 *    (alwaysDeny > alwaysAsk > alwaysAllow) but de-dupes identical entries.
 *  - `promptCachePrefixSort` — TODO: re-orders system-block segments so
 *    the cache prefix is maximised. v0 stub returns IR unchanged so the
 *    pipeline contract holds; v1 follow-up wires this once we land
 *    multi-block system prompts in IR.
 *
 * Pipeline order in `applyPasses` (the safe default):
 *   deadToolElimination → redundantMcpServerCollapse →
 *   permissionRuleCanonicalize → promptCachePrefixSort
 */
import type {
  IrChannelV0,
  IrManagedV0,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissionRule,
  IrPermissions,
  IrV0,
} from "@crewhaus/ir";

export type IrPass = (ir: IrNode) => IrNode;

export type ApplyPassesOptions = {
  /** Override the pass order. Default: safe order. */
  readonly passes?: ReadonlyArray<IrPass>;
};

/** Apply every pass in order; returns the final IR. */
export function applyPasses(ir: IrNode, opts: ApplyPassesOptions = {}): IrNode {
  const pipeline = opts.passes ?? DEFAULT_PIPELINE;
  let current = ir;
  for (const pass of pipeline) {
    current = pass(current);
  }
  return current;
}

/**
 * Pass 1 — drop tools that no permission rule and no sub-agent references.
 * v0 only inspects `IrV0` (the cli target) since that's where tools[] +
 * sub_agents + permissions live in the same shape. Other targets either
 * don't carry `tools[]` (workflow uses per-step tools) or aren't v0-IR
 * subjects of dead-tool elimination yet (graph nodes carry their own
 * tool sets — handled by a follow-up pass).
 */
export function deadToolElimination(ir: IrNode): IrNode {
  if (ir.target !== "cli") return ir;
  const cli = ir as IrV0;
  const tools = cli.tools ?? [];
  if (tools.length === 0) return ir;
  // Track which tool names have any reachable use site.
  const used = new Set<string>();
  // Permission rules can reference a specific tool name (e.g. "Bash" or
  // "Bash(rm *)"). The matcher's compilePattern parses this as the tool
  // followed by an optional invocation pattern in parens. We look at the
  // characters before the first `(` or `:` to extract the tool name.
  const ruleNames = (cli.permissions?.rules ?? []).map((r) => extractToolFromPattern(r.pattern));
  for (const n of ruleNames) if (n) used.add(n);
  // Sub-agents inherit a subset of the parent's tools — surface them.
  const subAgentRefs = cli.subAgents ?? [];
  for (const sa of subAgentRefs) {
    for (const t of sa.tools) used.add(t);
  }
  // Always-allow defaults: if any rule references a tool by exact name we
  // count it; otherwise the original tool list serves as the
  // "implicitly used" baseline. We use case-insensitive comparison since
  // tool registration uses the lowercase variant.
  const filtered = tools.filter(
    (t) =>
      used.has(t) ||
      used.has(t.toLowerCase()) ||
      [...used].some((u) => u.toLowerCase() === t.toLowerCase()),
  );
  // If no reference exists at all (rules + sub-agents both empty), return
  // input unchanged — eliminating every tool would be wrong.
  if (used.size === 0) return ir;
  if (filtered.length === tools.length) return ir;
  return { ...cli, tools: Object.freeze(filtered) } as IrNode;
}

function extractToolFromPattern(pattern: string): string | undefined {
  if (!pattern) return undefined;
  // Strip a `(...)` invocation suffix: "Bash(rm *)" → "Bash".
  const parenIdx = pattern.indexOf("(");
  const head = (parenIdx === -1 ? pattern : pattern.slice(0, parenIdx)).trim();
  if (!head) return undefined;
  return head;
}

/**
 * Pass 2 — collapse `mcp_servers` entries that share `(transport, command,
 * args)` (stdio) or `(transport, url)` (sse). The first key wins on
 * collision; later duplicates are dropped. Order is preserved for entries
 * that survive.
 */
export function redundantMcpServerCollapse(ir: IrNode): IrNode {
  // mcp_servers lives on cli, channel, managed
  const carriesMcp = (n: IrNode): n is IrV0 | IrChannelV0 | IrManagedV0 =>
    n.target === "cli" || n.target === "channel" || n.target === "managed";
  if (!carriesMcp(ir)) return ir;
  const ms = (ir as { mcp_servers?: IrMcpServers }).mcp_servers;
  if (!ms || Object.keys(ms).length < 2) return ir;
  const sigToFirstKey = new Map<string, string>();
  const keptOrdered: Array<[string, IrMcpServerConfig]> = [];
  for (const [k, v] of Object.entries(ms)) {
    const sig = mcpSignature(v);
    if (sigToFirstKey.has(sig)) continue;
    sigToFirstKey.set(sig, k);
    keptOrdered.push([k, v]);
  }
  if (keptOrdered.length === Object.keys(ms).length) return ir;
  const next: Record<string, IrMcpServerConfig> = {};
  for (const [k, v] of keptOrdered) next[k] = v;
  return { ...ir, mcp_servers: Object.freeze(next) } as IrNode;
}

function mcpSignature(c: IrMcpServerConfig): string {
  if (c.transport === "stdio") {
    return `stdio|${c.command}|${(c.args ?? []).join(" ")}`;
  }
  return `sse|${c.url}`;
}

/**
 * Pass 3 — sort + dedup permission rules. Within each precedence tier
 * (alwaysDeny > alwaysAsk > alwaysAllow), rules are sorted alphabetically
 * by pattern and exact duplicates dropped.
 */
export function permissionRuleCanonicalize(ir: IrNode): IrNode {
  const carriesPerms = (n: IrNode): n is IrV0 | IrChannelV0 | IrManagedV0 =>
    n.target === "cli" || n.target === "channel" || n.target === "managed";
  if (!carriesPerms(ir)) return ir;
  const perms = (ir as { permissions?: IrPermissions }).permissions;
  if (!perms) return ir;
  const tier = (t: IrPermissionRule["type"]): number =>
    t === "alwaysDeny" ? 0 : t === "alwaysAsk" ? 1 : 2;
  const seen = new Set<string>();
  const sorted = [...perms.rules]
    .map((r) => ({ r, key: `${r.type}:${r.pattern}` }))
    .filter(({ key }) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const ta = tier(a.r.type);
      const tb = tier(b.r.type);
      if (ta !== tb) return ta - tb;
      return a.r.pattern.localeCompare(b.r.pattern);
    })
    .map(({ r }) => r);
  if (sorted.length === perms.rules.length) {
    let identical = true;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== perms.rules[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return ir;
  }
  const newPerms: IrPermissions = {
    ...perms,
    rules: Object.freeze(sorted),
  };
  return { ...ir, permissions: newPerms } as IrNode;
}

/**
 * Pass 4 — re-order system-block segments to maximise the prompt-cache
 * prefix. v0 stub: IR carries the system prompt as a single string, so
 * there's no segmentation to reorder yet. Returns input unchanged.
 * The placeholder keeps the pipeline contract stable; once IR carries
 * multi-block system prompts (Section 31's Studio v1 paths), the real
 * impl lands here.
 */
export function promptCachePrefixSort(ir: IrNode): IrNode {
  return ir;
}

export const DEFAULT_PIPELINE: ReadonlyArray<IrPass> = Object.freeze([
  deadToolElimination,
  redundantMcpServerCollapse,
  permissionRuleCanonicalize,
  promptCachePrefixSort,
]);
