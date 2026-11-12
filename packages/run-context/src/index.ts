/**
 * Catalog R1 `run-context` — per-run object threaded through the
 * orchestrator, tools, and policy. Constructed once per
 * `runChatLoop()` invocation; `turnNumber` is mutated by the
 * orchestrator as turns advance.
 *
 * Reference: claude-code/Tool.ts `ToolUseContext`,
 * openai-agents/run_context.py.
 */
import { randomBytes } from "node:crypto";
import { type Trigger, isId, mintRunId, parseResumeScope } from "@crewhaus/control-contract";
import { type Logger, createLogger } from "@crewhaus/logging";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import { registerRunController } from "./run-registry";
import { type AmbientRun, type InboundContent, takeAmbientRun, takePendingInbound } from "./scope";
import { trimToken } from "./token-trim";

export {
  type ResumeScope,
  type Trigger,
  type TriggerKind,
  formatResumeScope,
  mintRunId,
  parseResumeScope,
} from "@crewhaus/control-contract";
export {
  type CancelAbortReason,
  RUN_REGISTRY_CAP,
  type RunHoldOutcome,
  cancelRun,
  isCancelReason,
  onRunIdle,
  retainRun,
} from "./run-registry";
export { type InboundContent, type RunScope, runWithScope, withInboundContent } from "./scope";

/**
 * Where content currently flowing through the runtime originated. Mirrors
 * `TrustOrigin` in `@crewhaus/boundary-classifier`. Kept as a string-literal
 * union here (instead of an import) so `run-context` does not depend on the
 * classifier — it carries the metadata; the classifier owns the policy.
 * The two unions are pinned set-equal by the classifier's
 * `origin-mirror.test.ts` bridge (a `tsc -b` failure when they drift), so
 * adding an origin there without adding it here does not compile.
 */
export type TrustOrigin =
  | "user"
  | "mcp"
  | "subagent"
  | "channel"
  | "federation"
  | "skill"
  | "compaction"
  | "tool"
  | "chain"
  | "memory"
  | "consult"
  | "api";

export type RunContext = {
  readonly runId: string;
  readonly sessionId: string;
  /** Mutable: orchestrator increments at the start of each user turn. */
  turnNumber: number;
  readonly abortSignal: AbortSignal;
  readonly logger: Logger;
  /**
   * Per-run trace bus. Always non-null — the factory mints a default
   * subscriber-less bus when none is supplied. Pluggable subscribers
   * (otel-exporter, metrics-collector, structured-event-printer) are
   * attached by the orchestrator's `attachDefaultSubscribers` helper based
   * on env vars.
   */
  readonly eventBus: TraceEventBus;
  /**
   * Pillar 3 — origin chain. The runtime appends an origin every time it
   * crosses a trust boundary (sub-agent enters with `["subagent"]`; a
   * federation peer call enters with `["federation"]`; an MCP tool inside
   * a sub-agent looks like `["subagent", "mcp"]` when the boundary checks
   * fire). Audit logs and trace events read this so a redacted payload
   * carries the *full provenance* of the trust transition that produced
   * the redaction. Optional + readonly for backward-compat — existing
   * `createRunContext` callers don't need to pass it.
   */
  readonly originStack?: ReadonlyArray<TrustOrigin>;
  /**
   * Pillar 3 sink-side fabric — content-to-origin map populated by every
   * boundary site (sub-agent spawner, MCP host, channel adapters, federation
   * router, skills registry, compaction packages, tool result classifier)
   * via `tagContent(ctx, content, origin)` after the source-side
   * `classifyBoundary` call. `egress-classifier` reads this map at every
   * external-tool call to detect cross-origin exfiltration.
   *
   * Mutable Map (not readonly) because tagging accumulates throughout a
   * run; callers should never replace the reference, only mutate via the
   * `tagContent` helper which enforces the size cap. Optional for
   * backward-compat: pre-fabric runtimes don't pre-allocate it, and
   * `tagContent` lazy-creates on first use.
   */
  dataLineage?: Map<string, TrustOrigin>;
  /**
   * Cross-cutting (Track 10) — per-agent identity for tool calls,
   * permission decisions, and audit log entries. Source:
   * "Runtime Security for AI Agents: An Identity Governance
   * Perspective" (industry blog, May 2026).
   *
   * Without identity, CrewHaus tracks `tool → permission` but cannot
   * attribute a call to the specific skill, sub-agent, or role that
   * made it. The audit log and permission engine both consult this
   * field when present — undefined means "top-level user context"
   * (preserves prior behaviour for runtimes that haven't been
   * threaded through identity yet).
   *
   * Mutable so a sub-agent spawner can shadow the field for the
   * child run without rebuilding the whole context.
   */
  agentIdentity?: AgentIdentity;
  /**
   * The run that started this one: a sub-agent's or a side call's parent, set
   * through {@link lineageOf}. Absent on a top-level run.
   */
  readonly parent?: string;
  /**
   * What this run may be resumed as, a string `parseResumeScope` accepts
   * (`session:<id>`, `job:<id>`, `lane:<lane>`, `run:<root>`, `work:<wi>`).
   */
  readonly resumeScope?: string;
  /** The parked run this one continues. */
  readonly continues?: string;
  /** The work item (`wi_…`) this run serves. */
  readonly workItem?: string;
  /** What started this run. */
  readonly trigger?: Trigger;
};

/**
 * Per-agent identity for permission scope + audit trail. All fields
 * are optional so partial identity (just `skillId`, or just
 * `subAgentId`) is representable. The audit log uses
 * `formatAgentIdentity(id)` to render a stable string key for
 * grouping events.
 */
export type AgentIdentity = {
  readonly skillId?: string;
  readonly subAgentId?: string;
  readonly roleId?: string;
};

/**
 * Render an `AgentIdentity` to a stable string key. Format:
 * `skill=<id>;subagent=<id>;role=<id>` — fields with undefined
 * values are omitted; an empty identity renders as `<top-level>`.
 */
export function formatAgentIdentity(id: AgentIdentity | undefined): string {
  if (id === undefined) return "<top-level>";
  const parts: string[] = [];
  if (id.skillId !== undefined) parts.push(`skill=${id.skillId}`);
  if (id.subAgentId !== undefined) parts.push(`subagent=${id.subAgentId}`);
  if (id.roleId !== undefined) parts.push(`role=${id.roleId}`);
  return parts.length === 0 ? "<top-level>" : parts.join(";");
}

export type RunContextOptions = {
  /**
   * Override the auto-generated `runId`. Format is unconstrained; the
   * default factory mints a canonical id with `mintRunId()` (`run_` and 26
   * lowercase letters and digits).
   */
  runId?: string;
  /**
   * Override the auto-generated `sessionId`. Must follow the format
   * `sess_<16 hex>` so it round-trips through `@crewhaus/session-store`
   * (whose path-traversal guard rejects anything else). The default
   * factory produces a value that already conforms; runtime-core
   * overrides this when creating or resuming a persisted session.
   */
  sessionId?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /**
   * Override the auto-constructed `TraceEventBus`. Sub-agents pass a child
   * bus they minted via `inheritTraceId` so the parent and child share one
   * OpenTelemetry trace.
   */
  eventBus?: TraceEventBus;
  /** Initial origin chain. Defaults to undefined (top-level/user context). */
  originStack?: ReadonlyArray<TrustOrigin>;
  /**
   * Lineage. Each field set here wins; an unset one comes from the ambient
   * scope (`runWithScope`), and absent both it is absent. A `resumeScope` or
   * `workItem` that does not fit its grammar is dropped with one warning
   * naming the field. A child context takes these from {@link lineageOf}.
   */
  parent?: string;
  resumeScope?: string;
  continues?: string;
  workItem?: string;
  trigger?: Trigger;
};

/** The lineage fields a context carries, as options take them. */
export type RunLineage = Pick<
  RunContextOptions,
  "parent" | "resumeScope" | "continues" | "workItem" | "trigger"
>;

/**
 * Generate a fresh sessionId in the format `sess_<16 hex>`. The 16-hex
 * suffix matches the regex `@crewhaus/session-store` enforces on every
 * read path, so a `RunContext`-supplied id can flow straight into
 * `sessionStore.create({ id })` without a format conversion.
 */
function generateSessionId(): string {
  return `sess_${randomBytes(8).toString("hex")}`;
}

/**
 * Build a fresh RunContext with sensible defaults: a canonical run id and a
 * random session id, a never-aborted signal, a logger that has the
 * run/session ids pre-bound so every log line is tagged automatically, and a
 * fresh `TraceEventBus`.
 *
 * With no `abortSignal`, the controller it makes is kept in the run registry
 * (`./run-registry`), so `cancelRun(ctx.runId)` can stop the run.
 *
 * Created inside a {@link withInboundContent} scope, the first context
 * adopts the run input a library classified and kept (see `./scope`): the
 * text is tagged into its lineage at its origin, and a warning is published
 * and logged for text kept with one. Outside a scope nothing is adopted.
 * Inside a `runWithScope` scope, it takes the scope's lineage for any field
 * its options leave unset.
 */
export function createRunContext(opts: RunContextOptions = {}): RunContext {
  const runId = opts.runId ?? mintRunId();
  const sessionId = opts.sessionId ?? generateSessionId();
  const controller = opts.abortSignal === undefined ? new AbortController() : undefined;
  const abortSignal = opts.abortSignal ?? (controller as AbortController).signal;
  const baseLogger = opts.logger ?? createLogger();
  const logger = baseLogger.child({ runId, sessionId });
  const eventBus = opts.eventBus ?? new TraceEventBus({ runId, sessionId, logger });
  const ctx: RunContext = {
    runId,
    sessionId,
    turnNumber: 0,
    abortSignal,
    logger,
    eventBus,
    ...(opts.originStack !== undefined ? { originStack: opts.originStack } : {}),
    ...lineageFrom(opts, takeAmbientRun(), logger),
  };
  if (controller !== undefined) registerRunController(runId, controller);
  adoptInbound(ctx, takePendingInbound());
  return ctx;
}

/**
 * The lineage a context carries: each field from the options, else from the
 * ambient scope. A `resumeScope` or `workItem` that does not fit its grammar
 * is dropped, with one warning naming the field and never its value.
 */
function lineageFrom(opts: RunContextOptions, ambient: AmbientRun, logger: Logger): RunLineage {
  const resumeScope = opts.resumeScope ?? ambient.resumeScope;
  const workItem = opts.workItem ?? ambient.workItem;
  const trigger = opts.trigger ?? ambient.trigger;
  const continues = opts.continues ?? ambient.continues;
  const fits = (field: string, ok: boolean): boolean => {
    if (!ok) logger.warn("run lineage field dropped: it does not fit its grammar", { field });
    return ok;
  };
  return {
    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
    ...(resumeScope !== undefined && fits("resumeScope", parseResumeScope(resumeScope) !== null)
      ? { resumeScope }
      : {}),
    ...(continues !== undefined ? { continues } : {}),
    ...(workItem !== undefined && fits("workItem", isId("wi", workItem)) ? { workItem } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
  };
}

/**
 * The options a child context takes from its parent: `parent` names the
 * parent's run, and the parent's `resumeScope`, `trigger` and `workItem` carry
 * over. `continues` never does: it belongs to the run that continued.
 */
export function lineageOf(ctx: RunContext): RunLineage {
  return {
    parent: ctx.runId,
    ...(ctx.resumeScope !== undefined ? { resumeScope: ctx.resumeScope } : {}),
    ...(ctx.trigger !== undefined ? { trigger: ctx.trigger } : {}),
    ...(ctx.workItem !== undefined ? { workItem: ctx.workItem } : {}),
  };
}

/**
 * Tag each kept input into `ctx`'s lineage at its origin, and report the ones
 * kept with a warning: one `permission_decision` event each (the template
 * runtime-core uses for suspicious tool output) and one log line. Neither
 * carries the text.
 */
function adoptInbound(ctx: RunContext, entries: readonly InboundContent[]): void {
  for (const entry of entries) {
    tagContent(ctx, entry.content, entry.origin);
    if (entry.warning === undefined) continue;
    const rules = [...entry.warning.rules];
    ctx.eventBus.publish({
      ...ctx.eventBus.envelope(),
      kind: "permission_decision",
      toolName: entry.door,
      decision: "allow",
      mode: "inbound",
      outcome: "warned",
      rules,
      reason: `input from origin ${entry.origin} kept with a warning`,
    });
    ctx.logger.warn("input kept with a warning", {
      origin: entry.origin,
      door: entry.door,
      rules,
      score: entry.warning.score,
    });
  }
}

/**
 * Return a shallow-cloned `RunContext` with `origin` appended to
 * `originStack`. Used by boundary sites (sub-agent spawner, MCP host,
 * channel adapters, federation router, skills registry, compaction
 * packages) to record the trust-domain crossing in the audit trail.
 *
 * Does NOT mutate the input — every caller works with a fresh context
 * that the inner runtime sees with its own provenance chain.
 */
export function pushOrigin(ctx: RunContext, origin: TrustOrigin): RunContext {
  const next: ReadonlyArray<TrustOrigin> = ctx.originStack
    ? [...ctx.originStack, origin]
    : [origin];
  return { ...ctx, originStack: next };
}

/**
 * Soft cap on `dataLineage` size. Beyond this, oldest entries (insertion
 * order) are evicted. Set deliberately conservative because the map is
 * scanned on every external-tool call (egress-classifier's substring
 * pass is O(n*m) per call); a runaway lineage degrades fast-path latency.
 *
 * A typical run touches 5–30 boundary crossings. 256 covers the 99th
 * percentile case (sub-agent fan-out, long MCP-tool transcripts) without
 * letting an adversarial input balloon the lineage.
 */
export const DATA_LINEAGE_CAP = 256;

/** Egress floor: tags shorter than this never produce a substring match. */
export const MIN_TAG_LENGTH = 16;
/** Cap on per-call line tags so one huge response can't dominate the lineage. */
export const MAX_LINE_TAGS = 64;
/**
 * Token floor (audit follow-up R2). Credential-shaped tokens this long or
 * longer are tagged even though they're under `MIN_TAG_LENGTH`; the egress
 * matcher floor (`MIN_MATCH_LENGTH` in egress-classifier) is set to this
 * value to match — the two must stay in sync.
 */
export const MIN_TOKEN_TAG_LENGTH = 8;
/** Cap on per-call token tags (longest kept) so noise can't flood lineage. */
export const MAX_TOKEN_TAGS = 16;
/** Assignments read per token, counted back from its last, so a token of them stays linear. */
const MAX_TOKEN_ASSIGNMENTS = 4;

/**
 * Well-known credential prefixes (Stripe sk-/sk_live_/rk_live_, GitHub
 * ghp_-family + github_pat_, GitLab glpat-, Slack xox?-, AWS AKIA/ASIA,
 * Google AIza/ya29., npm_, Shopify shpat_/shpss_, Stripe webhook whsec_,
 * Vault hvs., DigitalOcean dop_v1_, JWT segments eyJ). Curated, not
 * exhaustive — the assignment-context rule below catches custom schemes.
 */
const CREDENTIAL_PREFIX =
  /^(?:sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|ya29\.|npm_|shpat_|shpss_|whsec_|hvs\.|dop_v1_|eyJ)/;
const HEX_RUN = /^[0-9a-fA-F]{16,}$/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BASE64_SHAPE = /^[A-Za-z0-9+/_=-]{24,}$/;
/**
 * `password=...` / `token: ...` style assignments. The KEY context marks the
 * VALUE as secret regardless of its shape, catching custom credential
 * schemes the prefix list can't know about.
 */
const SECRET_ASSIGNMENT =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|bearer|credential)["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi;
/**
 * An upper-case name and its assignment, wherever it sits in a token: after a
 * `file:line:` prefix, a `#`, a flag or a JSON key's quote. A lower-case letter,
 * digit or `_` before the name means it is the tail of a longer word, and a `?`
 * or `&` means it is a URL's query, which stays whole.
 */
const ENV_ASSIGNMENT = /(?<![A-Za-z0-9_?&])[A-Z_][A-Z0-9_]*["']?(?::=|\?=|\+=|=|:)["']?/g;
/** A line break or tab as JSON or a shell prints it: `\\n` starts a new token. */
const ESCAPED_WHITESPACE = /\\[nrt]/g;

/**
 * High-confidence "this token IS a secret" shapes ONLY. A bare
 * charset-diversity heuristic was considered and rejected: every tool result
 * is tagged with origin `"tool"` (which blocks at external-dynamic sinks), so
 * tagging ordinary identifiers like `myVar123` out of file reads would turn
 * the egress fabric into a false-positive machine. The trade: short secrets
 * with no recognisable shape and no key=value context are NOT tagged
 * (documented residual — at that length substring matching cannot
 * distinguish them from prose anyway).
 */
function isCredentialShaped(token: string): boolean {
  if (CREDENTIAL_PREFIX.test(token)) return true;
  if (UUID_SHAPE.test(token)) return true;
  if (HEX_RUN.test(token)) return true;
  if (BASE64_SHAPE.test(token)) {
    // Long base64-ish runs qualify only with mixed character classes, so a
    // long plain word ("internationalization") never does.
    return /[0-9]/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token);
  }
  return false;
}

/**
 * The credential-shaped value of the last assignment in `token` that has one,
 * or `undefined`. The last, so `NAME=KEY=value` yields `value`, and working back
 * from it, so a base64 value's own `/ABC=` tail does not hide the value.
 */
function assignedValue(token: string): string | undefined {
  const ends: number[] = [];
  for (const m of token.matchAll(ENV_ASSIGNMENT)) {
    ends.push(m.index + m[0].length);
    if (ends.length > MAX_TOKEN_ASSIGNMENTS) ends.shift();
  }
  for (const end of ends.reverse()) {
    const value = trimToken(token.slice(end));
    if (value.length >= MIN_TOKEN_TAG_LENGTH && isCredentialShaped(value)) return value;
  }
  return undefined;
}

/** Credential-shaped tokens and assigned values in one run of text, into `candidates`. */
function collectCredentialTokens(content: string, candidates: Set<string>): void {
  const unescaped = content.includes("\\") ? content.replace(ESCAPED_WHITESPACE, " ") : content;
  for (const raw of unescaped.split(/[\s,;|()<>[\]{}\\]+/)) {
    const token = trimToken(raw);
    const value = assignedValue(token);
    if (value !== undefined) {
      candidates.add(value);
    } else if (token.length >= MIN_TOKEN_TAG_LENGTH && isCredentialShaped(token)) {
      candidates.add(token);
    }
  }
  for (const m of content.matchAll(SECRET_ASSIGNMENT)) {
    const value = trimToken(m[1] ?? "");
    if (value.length >= MIN_TOKEN_TAG_LENGTH) {
      candidates.add(value);
    }
  }
}

/** Every string leaf of a parsed JSON value, walked with a stack so depth costs no recursion. */
function jsonStringLeaves(root: unknown): string[] {
  const leaves: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      leaves.push(value);
    } else if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  return leaves;
}

/**
 * Extract credential-shaped tokens (see `isCredentialShaped`) plus values of
 * secret-keyed assignments. A credential-shaped value on an upper-case
 * `NAME=value` token is the candidate on its own, so the value matches where
 * it is copied without its name and the pair takes no slot of its own. Content
 * that parses as JSON is also read through its string leaves, as the egress
 * check reads a payload, so a value in an escaped field is found as written.
 * Capped at `MAX_TOKEN_TAGS`, longest first — the longest candidates are the
 * likeliest real secrets.
 */
function credentialTokens(content: string): string[] {
  const candidates = new Set<string>();
  collectCredentialTokens(content, candidates);
  const opens = content.trimStart()[0];
  if (opens === "{" || opens === "[") {
    try {
      for (const leaf of jsonStringLeaves(JSON.parse(content))) {
        collectCredentialTokens(leaf, candidates);
      }
    } catch {
      // Not JSON: the text was read above.
    }
  }
  return [...candidates].sort((a, b) => b.length - a.length).slice(0, MAX_TOKEN_TAGS);
}

/**
 * The set of strings to tag for one piece of content: the whole blob PLUS each
 * substantial line PLUS credential-shaped tokens. Whole-blob tagging catches a
 * full echo; per-line tagging catches PARTIAL reflection — the model copying
 * just the secret line out of a large (e.g. multi-KB MCP) response; token
 * tagging (audit follow-up R2) catches the model extracting just the SECRET
 * out of its line ("the key is sk-abc…"), which line pieces miss because the
 * fragment isn't the full tagged line. Token tagging can be disabled with
 * `CREWHAUS_DISABLE_TOKEN_LINEAGE=1` (documented escape hatch for operators
 * whose tool outputs are dense with hex/base64 that is NOT secret).
 * Single-line content without credential tokens yields exactly one piece
 * (the blob), unchanged.
 */
function lineagePieces(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string, floor: number): void => {
    if (s.length >= floor && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  add(content, MIN_TAG_LENGTH);
  if (content.includes("\n")) {
    let n = 0;
    for (const line of content.split("\n")) {
      if (n >= MAX_LINE_TAGS) break;
      add(line.trim(), MIN_TAG_LENGTH);
      n++;
    }
  }
  if (process.env["CREWHAUS_DISABLE_TOKEN_LINEAGE"] !== "1") {
    for (const token of credentialTokens(content)) {
      add(token, MIN_TOKEN_TAG_LENGTH);
    }
  }
  return out;
}

/**
 * Tag `content` as having entered the run from `origin`. Called by every
 * Pillar-3 boundary site immediately after `classifyBoundary` returns a
 * non-blocked verdict, so the content that reaches the model's context
 * carries its provenance into the lineage map.
 *
 * Tags the whole blob AND each substantial line AND credential-shaped tokens
 * (see `lineagePieces`) so a reflected line — or just the extracted secret —
 * is still attributed to its origin. Lazy-creates `ctx.dataLineage`; enforces
 * the size cap by evicting oldest-first (Map iteration order is insertion
 * order). Pieces shorter than their floor (`MIN_TAG_LENGTH` for blob/lines,
 * `MIN_TOKEN_TAG_LENGTH` for vetted tokens) are skipped — any tag we'd create
 * could never produce a match. The floors are duplicated here deliberately:
 * callers reading `dataLineage` directly shouldn't have to filter again.
 */
export function tagContent(ctx: RunContext, content: string, origin: TrustOrigin): void {
  if (typeof content !== "string") return;
  const pieces = lineagePieces(content);
  if (pieces.length === 0) return;
  if (ctx.dataLineage === undefined) {
    // biome-ignore lint/suspicious/noExplicitAny: legitimate mutation of readonly-ish optional
    (ctx as any).dataLineage = new Map<string, TrustOrigin>();
  }
  const map = ctx.dataLineage as Map<string, TrustOrigin>;
  for (const piece of pieces) {
    // Refresh recency by deleting then re-inserting.
    if (map.has(piece)) map.delete(piece);
    map.set(piece, origin);
  }
  while (map.size > DATA_LINEAGE_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
