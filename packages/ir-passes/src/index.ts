/**
 * Section 28 — `ir-passes`. Idempotent IR optimization passes; each pass
 * is a pure `(IrNode) → IrNode` function. The pipeline is composable and
 * deterministic: same input → same output regardless of pass order
 * (within the published "safe order" — see `applyPasses`).
 *
 * Built-in passes:
 *  - `deadToolElimination` — drop entries from `tools` that no sub-agent
 *    or permission rule references. Catches the common case where a spec
 *    declares `tools: [Read, Write, Bash]` but only ever references some of
 *    them — e.g. an `alwaysDeny` rule naming `Write` actually counts as a
 *    reference and KEEPS `Write` in the list; only a tool that no rule and
 *    no sub-agent mentions at all (say `Bash` here) gets dropped.
 *  - `redundantMcpServerCollapse` — dedup `mcp_servers` map entries by
 *    `(transport, command, args)` signature so two specs that import the
 *    same server under different keys collapse into one boot per process.
 *  - `permissionRuleCanonicalize` — sort + dedup `permissions.rules` by
 *    canonical (type, pattern) tuples; preserves source priority order
 *    (alwaysDeny > alwaysAsk > alwaysAllow) but de-dupes identical entries.
 *  - `transactionPolicyEnforcement` — §47 validating pass: checks the
 *    blockchain blocks (wallets/contracts/chains/transaction_policy) for
 *    referential integrity and throws `IrPassError` on a mismatch.
 *  - `wellFormednessCheck` — Track F validating pass: checks typed
 *    multi-agent graphs/crews (edges connect declared nodes, reachability
 *    from entry, schema/role references resolve) and throws on a violation.
 *  - `memoryIntegrityPass` — v0.3.0 validating pass: memory/continuity
 *    block integrity (wiki.recallK bounds, ttl floor, session-scope only
 *    on session-routed shapes, fragment JSON-serializability).
 *  - `promptCachePrefixSort` — TODO: re-orders system-block segments so
 *    the cache prefix is maximised. v0 stub returns IR unchanged so the
 *    pipeline contract holds; v1 follow-up wires this once we land
 *    multi-block system prompts in IR.
 *
 * Pipeline order in `applyPasses` (the safe default):
 *   deadToolElimination → redundantMcpServerCollapse →
 *   permissionRuleCanonicalize → transactionPolicyEnforcement →
 *   wellFormednessCheck → memoryIntegrityPass → promptCachePrefixSort
 *
 * G45 (loop contract 0.4) — the passes split into two families:
 *   - VALIDATING (transactionPolicyEnforcement, wellFormednessCheck,
 *     memoryIntegrityPass): pure pass-throughs that throw `IrPassError` on
 *     a violation. Exported as `VALIDATING_PASSES`; the compiler runs them
 *     UNCONDITIONALLY inside `compile()` (they cannot drift bundle bytes).
 *   - REWRITING (deadToolElimination, redundantMcpServerCollapse,
 *     permissionRuleCanonicalize, promptCachePrefixSort): structural
 *     optimizations that stay behind `compile({ applyIrPasses: true })`.
 */
import { CrewhausError } from "@crewhaus/errors";
import type {
  IrChainBinding,
  IrChannelV0,
  IrContinuity,
  IrContractBinding,
  IrCrewV0,
  IrGraphV0,
  IrLearning,
  IrManagedV0,
  IrMcpServerConfig,
  IrMcpServers,
  IrMemory,
  IrNode,
  IrPermissionRule,
  IrPermissions,
  IrSecretRef,
  IrTransactionPolicy,
  IrV0,
  IrWalletBinding,
} from "@crewhaus/ir";

export class IrPassError extends CrewhausError {
  override readonly name = "IrPassError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

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
 * args, env)` (stdio) or `(transport, url, headers)` (sse). The first key
 * wins on collision; later duplicates are dropped. Order is preserved for
 * entries that survive. env/header values are `IrSecretRef` objects
 * (0.3.0), compared structurally under sorted keys — two servers that
 * reference the same `$VAR` still dedupe, while servers that differ only
 * in credentials are (correctly) kept apart.
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
    return `stdio|${c.command}|${(c.args ?? []).join(" ")}|${secretMapSignature(c.env)}`;
  }
  return `sse|${c.url}|${secretMapSignature(c.headers)}`;
}

/**
 * Canonical signature for an env/headers map of `IrSecretRef` values:
 * sorted keys, refs discriminated so an env ref `$X` never collides with
 * the literal string `"$X"`. An absent map and an empty map are
 * equivalent (both configure nothing).
 */
function secretMapSignature(map: Readonly<Record<string, IrSecretRef>> | undefined): string {
  if (map === undefined) return "";
  return Object.keys(map)
    .sort()
    .map((k) => {
      const ref = map[k] as IrSecretRef;
      return ref.kind === "env" ? `${k}=env:${ref.name}` : `${k}=lit:${ref.value}`;
    })
    .join(" ");
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

/**
 * Pass 5 — §47 transaction-policy enforcement. Validates the
 * cross-cutting blockchain blocks at compile time so the runtime
 * can rely on referential integrity:
 *
 *   - every `wallets[].chainId` references a declared `chains[].id`
 *   - every `contracts[].chainId` references a declared `chains[].id`
 *   - every `transaction_policy.allowed_contracts` entry references
 *     a declared `contracts[].id`
 *   - `transaction_policy.defaultWriteApproval = "none"` is only
 *     permitted when every wallet is `automated` custody
 *   - declared wallets without a key reference are user-controlled
 *     (kms / hsm / local custody require `keyRef`)
 *
 * Mismatches throw `IrPassError` so compilation halts before any
 * bundle is emitted. The wallet-engine also re-checks these at
 * runtime (defense in depth); this pass catches mistakes at the
 * earliest possible point.
 */
type CarriesChainSubsystem = {
  readonly chains?: ReadonlyArray<IrChainBinding>;
  readonly wallets?: ReadonlyArray<IrWalletBinding>;
  readonly contracts?: ReadonlyArray<IrContractBinding>;
  readonly transactionPolicy?: IrTransactionPolicy;
};

function carriesChainSubsystem(ir: IrNode): ir is IrNode & CarriesChainSubsystem {
  const t = ir.target;
  return (
    t === "cli" ||
    t === "workflow" ||
    t === "channel" ||
    t === "graph" ||
    t === "crew" ||
    t === "research" ||
    t === "batch"
  );
}

export function transactionPolicyEnforcement(ir: IrNode): IrNode {
  if (!carriesChainSubsystem(ir)) return ir;
  const chains = ir.chains;
  const wallets = ir.wallets;
  const contracts = ir.contracts;
  const policy = ir.transactionPolicy;

  // Empty subsystem is a no-op (existing specs untouched).
  if (
    (chains === undefined || chains.length === 0) &&
    (wallets === undefined || wallets.length === 0) &&
    (contracts === undefined || contracts.length === 0) &&
    policy === undefined
  ) {
    return ir;
  }

  const chainIds = new Set<string>((chains ?? []).map((c) => c.id));
  const contractIds = new Set<string>((contracts ?? []).map((c) => c.id));

  // chains[] uniqueness
  if (chains !== undefined) {
    const seen = new Set<string>();
    for (const c of chains) {
      if (seen.has(c.id)) {
        throw new IrPassError(`duplicate chains[].id "${c.id}"`);
      }
      seen.add(c.id);
    }
  }

  // wallets[*].chainId ⊆ chains[].id; keyRef required for non-user-controlled
  if (wallets !== undefined) {
    const seen = new Set<string>();
    for (const w of wallets) {
      if (seen.has(w.id)) {
        throw new IrPassError(`duplicate wallets[].id "${w.id}"`);
      }
      seen.add(w.id);
      if (!chainIds.has(w.chainId)) {
        throw new IrPassError(
          `wallets[].id "${w.id}" references chainId "${w.chainId}" which is not declared in chains[]`,
        );
      }
      if (w.custody !== "user-controlled" && w.keyRef === undefined) {
        throw new IrPassError(
          `wallets[].id "${w.id}" has custody="${w.custody}" but no keyRef; kms/hsm/local custody requires keyRef`,
        );
      }
    }
  }

  // contracts[*].chainId ⊆ chains[].id
  if (contracts !== undefined) {
    const seen = new Set<string>();
    for (const c of contracts) {
      if (seen.has(c.id)) {
        throw new IrPassError(`duplicate contracts[].id "${c.id}"`);
      }
      seen.add(c.id);
      if (!chainIds.has(c.chainId)) {
        throw new IrPassError(
          `contracts[].id "${c.id}" references chainId "${c.chainId}" which is not declared in chains[]`,
        );
      }
    }
  }

  // transaction_policy.allowed_contracts ⊆ contracts[].id
  if (policy !== undefined) {
    for (const cid of policy.allowedContracts) {
      if (!contractIds.has(cid)) {
        throw new IrPassError(
          `transaction_policy.allowedContracts entry "${cid}" is not a declared contracts[].id`,
        );
      }
    }
    if (policy.defaultWriteApproval === "none") {
      const allAutomated = (wallets ?? []).every((w) => w.signingPolicy === "automated");
      if (!allAutomated) {
        throw new IrPassError(
          'transaction_policy.defaultWriteApproval="none" requires every wallet to have signingPolicy="automated"',
        );
      }
    }
  }

  // No structural rewrite — the pass validates and passes through.
  return ir;
}

/**
 * Track F (Section 57) — well-formedness check for typed multi-agent
 * graphs. Source: AgentFlow (arxiv 2604.20801). Before any candidate
 * harness is sent for expensive LLM evaluation, this pass:
 *
 *   1. Verifies every graph edge connects declared nodes.
 *   2. Verifies the graph is connected (every node reachable from entry).
 *   3. Verifies every edge's `schema` either is `untyped` or resolves
 *      to a declared `messageSchemas` entry.
 *   4. For crews: verifies routing.match targets all reference declared
 *      roles (a subset of what `parseSpec` does; we re-check here so
 *      `applyPasses(ir)` is safe to call standalone).
 *
 * Failing this check is fast and cheap, which means the search budget
 * for upstream optimizers (Tracks D, E) goes to well-formed harnesses
 * only. Cited paper: AgentFlow (arxiv 2604.20801).
 */
export function wellFormednessCheck(ir: IrNode): IrNode {
  if (ir.target === "graph") {
    const g = ir as IrGraphV0;
    const nodeNames = new Set(g.nodes.map((n) => n.name));
    if (!nodeNames.has(g.entry)) {
      throw new IrPassError(
        `graph entry "${g.entry}" is not a declared node (nodes: ${[...nodeNames].join(", ")})`,
      );
    }
    const schemaNames = new Set((g.messageSchemas ?? []).map((s) => s.name));
    for (const e of g.edges) {
      if (!nodeNames.has(e.from)) {
        throw new IrPassError(`graph edge from "${e.from}" references an undeclared node`);
      }
      if (!nodeNames.has(e.to)) {
        throw new IrPassError(`graph edge to "${e.to}" references an undeclared node`);
      }
      // Loop contract 0.4 (Batch A) — `when.key` reads a node's recorded
      // output from the shared state, so it must name a declared node
      // (mirror of the parseSpec cross-check for direct-IR builders).
      if (e.when !== undefined && !nodeNames.has(e.when.key)) {
        throw new IrPassError(
          `graph edge ${e.from}→${e.to} when.key "${e.when.key}" references an undeclared node`,
        );
      }
      if (e.schema !== undefined && e.schema.kind === "named") {
        if (!schemaNames.has(e.schema.name)) {
          throw new IrPassError(
            `graph edge ${e.from}→${e.to} references undeclared message schema "${e.schema.name}"`,
          );
        }
      }
    }
    // Loop contract 0.4 (Batch A) — parallel groups: >= 2 members (the
    // graph-engine's addParallel rejects smaller groups at build time —
    // fail at compile instead), every member a declared node.
    const parallelGroups = g.parallel ?? [];
    for (const group of parallelGroups) {
      if (group.length < 2) {
        throw new IrPassError(
          `graph parallel group [${group.join(", ")}] needs at least 2 nodes (addParallel rejects smaller groups)`,
        );
      }
      for (const member of group) {
        if (!nodeNames.has(member)) {
          throw new IrPassError(`graph parallel group references undeclared node "${member}"`);
        }
      }
    }
    // Reachability from entry. Two propagation rules, run to fixpoint:
    //   - an edge from a reachable node reaches its `to`;
    //   - a parallel group whose FIRST member is reachable runs ALL its
    //     members (the engine triggers the barrier when the cursor lands on
    //     group[0] and continues from the LAST member's outgoing edge).
    const reachable = new Set<string>([g.entry]);
    let added = true;
    while (added) {
      added = false;
      for (const e of g.edges) {
        if (reachable.has(e.from) && !reachable.has(e.to)) {
          reachable.add(e.to);
          added = true;
        }
      }
      for (const group of parallelGroups) {
        const head = group[0];
        if (head !== undefined && reachable.has(head)) {
          for (const member of group) {
            if (!reachable.has(member)) {
              reachable.add(member);
              added = true;
            }
          }
        }
      }
    }
    for (const n of g.nodes) {
      if (!reachable.has(n.name)) {
        throw new IrPassError(`graph node "${n.name}" is unreachable from entry "${g.entry}"`);
      }
    }
  } else if (ir.target === "crew") {
    const c = ir as IrCrewV0;
    const roleNames = new Set(c.roles.map((r) => r.name));
    if (!roleNames.has(c.entry)) {
      throw new IrPassError(
        `crew entry "${c.entry}" is not a declared role (roles: ${[...roleNames].join(", ")})`,
      );
    }
    const schemaNames = new Set((c.messageSchemas ?? []).map((s) => s.name));
    if (c.routing?.kind === "match" && c.routing.match !== undefined) {
      for (const [from, rules] of Object.entries(c.routing.match)) {
        if (!roleNames.has(from)) {
          throw new IrPassError(`crew routing.match["${from}"]: source role not declared`);
        }
        for (const rule of rules) {
          if (!roleNames.has(rule.to)) {
            throw new IrPassError(
              `crew routing.match["${from}"].to "${rule.to}": target role not declared`,
            );
          }
        }
      }
    }
    // Schema declarations exist (they're optional but if present they must
    // be uniquely named). This catches the easy authoring bug of declaring
    // two schemas with the same name.
    if (schemaNames.size !== (c.messageSchemas ?? []).length) {
      throw new IrPassError("crew messageSchemas contains duplicate names");
    }
  }
  return ir;
}

/**
 * v0.3.0 PR 11 — memory/continuity integrity check. VALIDATION-ONLY (no
 * structural rewrite), mirroring `transactionPolicyEnforcement`'s posture:
 *
 *   - `memory.wiki.recallK` within 1–50 (the spec's own zod bound, re-checked
 *     for direct-IR builders that never went through `parseSpec`)
 *   - `memory.ttlMs` >= 1h (mirror of the compiler's load-bearing floor —
 *     a sub-hour fact TTL expires memories mid-session)
 *   - `continuity.scope: "session"` only on shapes with per-conversation
 *     session routing (channel) — everywhere else no session id ever
 *     arrives and the store could never resolve
 *   - fragment serializability: the memory/continuity blocks must survive a
 *     JSON round-trip UNCHANGED (emitters `JSON.stringify` them into
 *     bundles via `memoryFragmentFromIr` — a Date/function/undefined/cycle
 *     smuggled in by a direct-IR builder would silently corrupt the bundle)
 *
 * NOTE (G45, loop contract 0.4): this pass is one of the VALIDATING passes
 * the compiler now runs UNCONDITIONALLY inside `compile()` — for specs the
 * rules here fire only if something slipped past the compiler's own
 * `lowerMemory`/`lowerContinuity` checks (and the spec zod bounds), which
 * remain the first line. The pass is still the complete audit for IR built
 * outside `parseSpec → lower` (direct-IR builders via `applyPasses(ir)`).
 */
type CarriesMemoryFabric = {
  readonly memory?: IrMemory;
  readonly continuity?: IrContinuity;
  /** v0.3.0 PR 17 — carried on the five memory shapes only; structurally
   *  optional here so the workflow/batch/voice/browser variants type-check. */
  readonly learning?: IrLearning;
  readonly thredz?: unknown;
};

function carriesMemoryFabric(ir: IrNode): ir is IrNode & CarriesMemoryFabric {
  const t = ir.target;
  return (
    t === "cli" ||
    t === "channel" ||
    t === "managed" ||
    t === "research" ||
    t === "crew" ||
    t === "workflow" ||
    t === "batch" ||
    t === "voice" ||
    t === "browser"
  );
}

const MEMORY_TTL_MIN_MS = 60 * 60 * 1000;

/** Mirror of the compiler's load-bearing `memory.dream.every` floor (PR 14). */
const DREAM_EVERY_MIN_MS = 5 * 60 * 1000;

/** Deep JSON-serializability check: value must survive a round-trip
 *  unchanged (rejects functions/undefined/Dates/NaN/cycles — anything
 *  `JSON.stringify` drops or rewrites). */
function jsonRoundTrips(value: unknown): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false; // cycle or BigInt
  }
  if (text === undefined) return false;
  return deepEqualJson(value, JSON.parse(text));
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

export function memoryIntegrityPass(ir: IrNode): IrNode {
  if (!carriesMemoryFabric(ir)) return ir;
  const memory = ir.memory;
  const continuity = ir.continuity;
  const learning = ir.learning;
  if (memory === undefined && continuity === undefined && learning === undefined) return ir;

  if (memory?.wiki?.recallK !== undefined) {
    const k = memory.wiki.recallK;
    if (!Number.isInteger(k) || k < 1 || k > 50) {
      throw new IrPassError(`memory.wiki.recallK must be an integer in 1–50 (got ${String(k)})`);
    }
  }
  if (memory?.ttlMs !== undefined && memory.ttlMs < MEMORY_TTL_MIN_MS) {
    throw new IrPassError(
      `memory.ttlMs ${memory.ttlMs} is below the 1h floor (${MEMORY_TTL_MIN_MS}ms) — a sub-hour fact TTL expires memories mid-session`,
    );
  }
  if (memory?.dream !== undefined && memory.dream.everyMs < DREAM_EVERY_MIN_MS) {
    throw new IrPassError(
      `memory.dream.everyMs ${memory.dream.everyMs} is below the 5m floor (${DREAM_EVERY_MIN_MS}ms) — consolidation is a scheduled maintenance pass, not a per-turn hook`,
    );
  }
  if (continuity?.scope === "session" && ir.target !== "channel") {
    throw new IrPassError(
      `continuity.scope "session" needs a shape with per-conversation session routing (channel); target "${ir.target}" has no session router`,
    );
  }
  // v0.3.0 PR 17 — learning needs a wiki (mirror of the compiler's
  // load-bearing cross-field check): the local one enabled, or thredz.
  if (learning !== undefined) {
    const wikiOn = memory?.wiki !== undefined && memory.wiki.enabled !== false;
    if (!wikiOn && ir.thredz === undefined) {
      throw new IrPassError(
        "learning needs a wiki to learn into — carry memory.wiki (enabled) or a thredz block on this IR",
      );
    }
    if (learning.domain === "") {
      throw new IrPassError("learning.domain must be a non-empty string");
    }
  }
  for (const [label, block] of [
    ["memory", memory],
    ["continuity", continuity],
    ["learning", learning],
  ] as const) {
    if (block !== undefined && !jsonRoundTrips(block)) {
      throw new IrPassError(
        `${label} block is not JSON-serializable — emitters stringify it into bundles via memoryFragmentFromIr, so it must survive a JSON round-trip unchanged`,
      );
    }
  }
  return ir;
}

/**
 * G45 (loop contract 0.4) — the VALIDATING passes: pure pass-throughs that
 * throw `IrPassError` on a violation and never rewrite the IR. The compiler
 * runs these UNCONDITIONALLY inside `compile()` (between `lower()` and the
 * opt-in rewriting pipeline); they are also part of `DEFAULT_PIPELINE`, in
 * the same relative order, so `applyPasses(ir)` stays a complete standalone
 * audit. Order matters: chain referential integrity → graph/crew
 * well-formedness → memory/continuity integrity.
 */
export const VALIDATING_PASSES: ReadonlyArray<IrPass> = Object.freeze([
  transactionPolicyEnforcement,
  wellFormednessCheck,
  memoryIntegrityPass,
]);

export const DEFAULT_PIPELINE: ReadonlyArray<IrPass> = Object.freeze([
  deadToolElimination,
  redundantMcpServerCollapse,
  permissionRuleCanonicalize,
  ...VALIDATING_PASSES,
  promptCachePrefixSort,
]);
