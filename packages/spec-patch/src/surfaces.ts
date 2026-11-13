/**
 * The spec's security surfaces: fields whose blast radius is a permission, a
 * spend, a credential path or a trust boundary rather than an answer's
 * quality. One table, read by Home's spec editor (which asks for the typed
 * confirmation before writing one), by `crewhaus run` (which says at start
 * which of them changed since the last start) and by the commit helper's
 * escalations.
 *
 * Pure data and functions: no `node:` import, so the main entry stays usable
 * anywhere. The digests of these surfaces live on `./commit`, beside the
 * other code that reads files and hashes.
 *
 * Load order: the table is built when this module loads, from
 * `DELTA_090_KEYS` and the wildcard below. It imports `./owner-keys` and
 * never `./index`, which re-exports this module: a cycle there would read a
 * constant before it is initialized.
 */
import { DELTA_090_KEYS } from "./owner-keys";
import { protectedBarChange } from "./protected";

/** `"*"` inside a row's `prefix` matches any one segment. Equal to `WILDCARD_SEGMENT`. */
export const SURFACE_WILDCARD = "*";
const WILDCARD_SEGMENT = SURFACE_WILDCARD;

/** One row of {@link SECURITY_SURFACES}. */
export type SecuritySurface = (typeof SECURITY_SURFACES)[number];

/**
 * The human-owned SECURITY surfaces: fields whose blast radius is a
 * permission, a spend, a credential path or a trust boundary rather than an
 * answer's quality. Editing one is legitimate — it just never happens by
 * accident, so these are the paths that demand the redacted diff plus a
 * typed confirmation (or `crewhaus propose`).
 *
 * Everything outside both this table and `OPTIMIZABLE_PATHS` is still
 * human-owned; it simply needs the confirmation without the interstitial.
 */
export const SECURITY_SURFACES: ReadonlyArray<{
  /** Segments matched from the ROOT of the path (`anywhere` widens this). */
  readonly prefix: readonly string[];
  readonly reason: string;
  /**
   * 0.6.0 — match the segments as a contiguous run ANYWHERE in the path
   * (with `"*"` = any one segment), so one row covers a block that hangs
   * off several hosts: `model_pool.rules` on `agent`, `steps[i]`, `nodes.x`,
   * `roles.r` and every `sub_agents.<n>` alike.
   */
  readonly anywhere?: true;
  /** Match this path only, not the fields under it: a block whose own dials stay tunable. */
  readonly exact?: true;
}> = [
  {
    prefix: ["permissions"],
    reason:
      "permissions decide what the agent may do — a widened rule is a security change, not a quality one",
  },
  {
    prefix: ["agent", "model"],
    reason:
      "the model roster is never auto-patched: a swap moves cost, latency and behaviour at once",
  },
  {
    prefix: ["agent", "model_pool"],
    reason: "the candidate pool decides which models may serve traffic",
  },
  {
    prefix: ["agent", "model_fallbacks"],
    reason: "the failover chain decides which provider answers when the first one is down",
  },
  {
    prefix: ["agent", "model_tiers"],
    reason: "tier routing decides which model a turn is spent on",
  },
  {
    prefix: ["watchme"],
    reason:
      "watch-me is a consent + data-plane posture; the observer is never tuned by the loop it observes",
  },
  { prefix: ["plugins"], reason: "plugins load third-party code into the agent at boot" },
  {
    prefix: ["expose"],
    reason: "expose publishes this bundle as an MCP server other clients can call",
  },
  {
    prefix: ["learning", "sources"],
    reason: "learning sources decide what text is ingested into the agent's knowledge",
  },
  { prefix: ["thredz"], reason: "thredz crosses the harness boundary to a hosted wiki" },
  {
    prefix: ["sandbox"],
    reason: "the sandbox is the isolation boundary code execution runs inside",
  },
  {
    prefix: ["tool_config"],
    anywhere: true,
    reason: "tool config decides what the agent's tools may reach",
  },
  {
    prefix: ["transaction_policy"],
    reason: "the transaction policy gates on-chain writes and approvals",
  },
  {
    prefix: ["idempotencyWindowMs"],
    reason:
      "the idempotency window decides how long an event or job already acted on is not acted on again",
  },
  {
    prefix: ["mcp_servers"],
    reason:
      "an MCP server is third-party code plus its credentials — write it through the connectors tab",
  },
  { prefix: ["hooks"], reason: "hooks run commands on the machine at lifecycle points" },
  { prefix: ["security"], reason: "the security block is the harness's own defence configuration" },
  { prefix: ["wallets"], reason: "wallets hold funds" },
  { prefix: ["chains"], reason: "chain bindings decide which network is written to" },
  { prefix: ["contracts"], reason: "contract bindings decide which addresses are called" },
  // ---- 0.6.0 — the hybrid-model surfaces. The
  // optimizer may tune a handful of DIALS inside these blocks (a profile's
  // `max_tokens`, `rules[*].enabled`, `strategy.shadow.sample_rate`, …), but a
  // console write to any of them takes the typed confirmation: the same block
  // carries the roster, the rule targets, the judge identity and the floor.
  {
    prefix: ["models"],
    reason:
      "a model profile declares identity, tools, permissions and spend for every slot that references it — the roster is never edited by accident",
  },
  {
    prefix: ["model_pool", "rules"],
    anywhere: true,
    reason: "routing rules decide which turns leave the cheap lane and which arm serves them",
  },
  {
    prefix: ["model_pool", "strategy"],
    anywhere: true,
    reason:
      "the hybrid strategy names the draft, escalation, guide, shadow and committee arms and registers the Escalate / Consult tools",
  },
  {
    prefix: ["model_pool", "reward"],
    anywhere: true,
    reason:
      "the reward block bounds what the learned policy may exploit (quality source, priors, the floor) — never tuned by the loop it bounds",
  },
  {
    prefix: ["sub_agents", WILDCARD_SEGMENT, "allowed_profiles"],
    anywhere: true,
    reason:
      "the profile allowlist is what a model-filled Task profile argument is validated against — a roster decision for the child",
  },
  // A step, a node and a role each carry their own copy of these, and one row
  // covers all three. Last, so a narrower row's reason answers first.
  {
    prefix: ["tools"],
    anywhere: true,
    reason: "the tool list decides what this agent can do",
  },
  // This group keeps its own `tool_config` row, so a step's, node's or role's
  // tool config is human-owned whatever the root row above matches.
  {
    prefix: ["tool_config"],
    anywhere: true,
    reason: "tool config decides what the agent's tools may reach",
  },
  {
    prefix: ["permissions"],
    anywhere: true,
    reason:
      "permissions decide what the agent may do — a widened rule is a security change, not a quality one",
  },
  {
    prefix: ["mcp_servers"],
    anywhere: true,
    reason:
      "an MCP server is third-party code plus its credentials — write it through the connectors tab",
  },
  {
    prefix: ["hitl"],
    anywhere: true,
    reason: "a human gate decides where a person signs off on the work",
  },
  {
    prefix: ["model"],
    anywhere: true,
    reason:
      "the model roster is never auto-patched: a swap moves cost, latency and behaviour at once",
  },
  {
    prefix: ["model_pool"],
    anywhere: true,
    reason: "the candidate pool decides which models may serve traffic",
  },
  // A whole step, node or role, and the list or map that holds them: one value
  // there can carry every row above at once. A field inside one
  // (`steps[0].instructions`) is classified on its own.
  {
    prefix: ["steps"],
    exact: true,
    reason:
      "the step list holds each step's tools, permissions, models and human gates; a step's own fields stay tunable one at a time",
  },
  {
    prefix: ["steps", WILDCARD_SEGMENT],
    exact: true,
    reason:
      "a step holds its own tools, permissions, models and human gates; its fields stay tunable one at a time",
  },
  {
    prefix: ["nodes"],
    exact: true,
    reason:
      "the node map holds each node's tools, permissions, models and human gates; a node's own fields stay tunable one at a time",
  },
  {
    prefix: ["nodes", WILDCARD_SEGMENT],
    exact: true,
    reason:
      "a node holds its own tools, permissions, models and human gate; its fields stay tunable one at a time",
  },
  {
    prefix: ["roles"],
    exact: true,
    reason:
      "the role map holds each role's tools, permissions and models; a role's own fields stay tunable one at a time",
  },
  {
    prefix: ["roles", WILDCARD_SEGMENT],
    exact: true,
    reason:
      "a role holds its own tools, permissions and models; its fields stay tunable one at a time",
  },
  // On-chain bindings. A policy that allows a contract by id reads the address
  // from these, so they sit beside `contracts` and `chains`.
  {
    prefix: ["game", "contract"],
    reason: "the game contract binding decides which address is called",
  },
  {
    prefix: ["game", "actionsContract"],
    reason: "the actions contract decides which address a move is sent to",
  },
  {
    prefix: ["game"],
    exact: true,
    reason:
      "the game block holds the contract bindings; its objective and timing stay tunable one field at a time",
  },
  {
    prefix: ["triggers"],
    reason: "triggers decide which addresses and events wake the agent",
  },
  // Every security row of the owner-keys table, derived, never a hand copy.
  ...DELTA_090_KEYS.filter((key) => key.security).map((key) => ({
    prefix: key.pattern,
    reason: key.reason,
    ...(key.root === true ? {} : { anywhere: true as const }),
  })),
];

/** `prefix` matches the path from segment `start` (`"*"` = any one segment). */
export function surfaceMatchesFrom(
  prefix: readonly string[],
  path: readonly string[],
  start: number,
): boolean {
  if (path.length < start + prefix.length) return false;
  return prefix.every((seg, i) => seg === WILDCARD_SEGMENT || path[start + i] === seg);
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return surfaceMatchesFrom(prefix, path, 0);
}

/** A security-surface row matches a path root-anchored, or anywhere or exactly when the row says so. */
export function surfaceMatches(surface: SecuritySurface, path: readonly string[]): boolean {
  if (surface.exact === true) {
    return path.length === surface.prefix.length && isPrefix(surface.prefix, path);
  }
  if (surface.anywhere !== true) return isPrefix(surface.prefix, path);
  for (let start = 0; start + surface.prefix.length <= path.length; start++) {
    if (surfaceMatchesFrom(surface.prefix, path, start)) return true;
  }
  return false;
}

/** The first security-surface row that covers `segments`, or undefined. */
export function surfaceFor(segments: readonly string[]): SecuritySurface | undefined {
  return SECURITY_SURFACES.find((surface) => surfaceMatches(surface, segments));
}

// ---------------------------------------------------------------------------
// escalations: the changes that need the owner's typed confirmation
// ---------------------------------------------------------------------------

/** What a change needs before it is written, and why. */
export type SpecEscalation = {
  /** `typed-name`: the spec's name typed again; `h.spec.edit.security`: the security edit permission. */
  readonly needs: "typed-name" | "h.spec.edit.security";
  readonly reason: string;
  /** The setting paths that raised it, dotted. */
  readonly paths: ReadonlyArray<string>;
};

/** The sentence a rename shows before it is confirmed. */
export const RENAME_WARNING =
  "Renaming starts new version history, test baselines and memory under the new name. The old ones stay under the old name.";

/** The sentence a budget raise shows before it is confirmed. */
export const BUDGET_RAISE_WARNING =
  "This raises or removes the spending cap, so the harness can spend more before it stops.";

/** The sentence a change to a protected quality bar shows before it is confirmed. */
export const PROTECTED_LOOSENING_WARNING =
  "This loosens a quality bar the owner protected, so only the owner can make it.";

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `on_exceed`'s action, with the schema's default (`stop`) for an absent block. */
function exceedAction(budget: Record<string, unknown>): unknown {
  const onExceed = plainObject(budget["on_exceed"]);
  return onExceed === undefined ? "stop" : onExceed["action"];
}

/** The budget paths a change raises: every way the cap lets the harness spend more. */
function budgetRaises(before: unknown, after: unknown): string[] {
  const was = plainObject(plainObject(before)?.["budget"]);
  if (was === undefined) return []; // a first budget is a new cap, not a raise
  const now = plainObject(plainObject(after)?.["budget"]);
  if (now === undefined) return ["budget"];
  const raised: string[] = [];
  const usdBefore = was["usd"];
  const usdAfter = now["usd"];
  if (typeof usdBefore === "number") {
    if (usdAfter === undefined) raised.push("budget.usd");
    else if (typeof usdAfter === "number" && usdAfter > usdBefore) raised.push("budget.usd");
  }
  // `run` is the default scope; a session cap is the narrower one.
  if (was["scope"] === "session" && now["scope"] !== "session") raised.push("budget.scope");
  // `stop` is the default; `degrade` keeps spending on another model.
  if (exceedAction(was) === "stop" && exceedAction(now) === "degrade") {
    raised.push("budget.on_exceed");
  }
  // `judge_share` divides the cap; it never raises it.
  return raised;
}

/**
 * The confirmations a change from `before` to `after` needs (both parsed YAML,
 * schema defaults not applied). A changed `name:` needs the name typed again,
 * because history, baselines and memory are kept under the name. Raising the
 * budget (a higher `usd`, the cap or `usd` removed, a `session` scope widened,
 * `on_exceed` moved from `stop` to `degrade`) needs the security edit
 * permission. A first budget and a lowered one need nothing. Loosening a
 * protected quality bar (`protectedBarChange`) needs the security edit
 * permission too; tightening one needs nothing.
 */
export function escalationFor(before: unknown, after: unknown): SpecEscalation[] {
  const out: SpecEscalation[] = [];
  const nameBefore = plainObject(before)?.["name"];
  const nameAfter = plainObject(after)?.["name"];
  if (nameBefore !== undefined && nameBefore !== nameAfter) {
    out.push({ needs: "typed-name", reason: RENAME_WARNING, paths: ["name"] });
  }
  const raised = budgetRaises(before, after);
  if (raised.length > 0) {
    out.push({ needs: "h.spec.edit.security", reason: BUDGET_RAISE_WARNING, paths: raised });
  }
  const loosened = protectedBarChange(before, after);
  if (loosened !== undefined) {
    out.push({
      needs: "h.spec.edit.security",
      reason: `${PROTECTED_LOOSENING_WARNING} (${loosened.reason})`,
      paths: [loosened.key],
    });
  }
  return out;
}
