/**
 * Standing rules: a narrow allow for one tool, made from a decision, that ends on its own.
 *
 * A rule is two things kept together under the harness's control lock: a row in
 * `.crewhaus/run/control/standing-rules.jsonl` (control-records) and an `alwaysAllow`
 * entry in `.crewhaus/settings.json`, in the shape every release reads. The row comes
 * first: until the entry is written the rule allows nothing, and an entry the record
 * names stops matching once no row for its pattern is live (permission-engine's
 * `loadSettingsRules`). Only the harness's owner makes or ends one; the decision service
 * checks that before it calls here.
 *
 * Every rule write first ends the rules past their end: an `expired` row each, and the
 * settings entry of a pattern no live row still names is removed. A read never does.
 *
 * The pattern names exactly the call that was approved (`narrowPatternFor`): the call's
 * one operative value, read from the builtin manifest's declaration with the harness as
 * the workspace, glob-escaped, and checked to grant that call. A wider glob is the
 * owner's own, typed and confirmed at a terminal.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import {
  type LedgerRead,
  type ProposalRow,
  type StandingRuleReason,
  type StandingRuleRow,
  casAppendLocked,
  proposalState,
  readProposals,
  readStandingRules,
  ruleIsLive,
  standingRulesLedger,
  withLedgerLock,
} from "@crewhaus/control-records";
import { specRevision } from "@crewhaus/ir/policy";
import {
  type NarrowPattern,
  appendSettingsRule,
  emptyRuleSet,
  evaluate,
  loadSettingsRules,
  narrowPatternFor,
  parsePermissionsConfig,
  removeSettingsRule,
  settingsFilePath,
} from "@crewhaus/permission-engine";
import { carriesCredential } from "@crewhaus/spec-patch";
import { lexicalPathValues, operativeValuesOf } from "@crewhaus/tool-executor";
import { TOOL_REGISTRY } from "@crewhaus/tool-registry-manifest";
import type { DecisionActor, Decisions } from "./decisions";

export { carriesCredential } from "@crewhaus/spec-patch";

type OperativeArgs = NonNullable<Parameters<typeof operativeValuesOf>[0]>;

/** `withLedgerLock`'s own refusal, told apart from an answer the locked step gave. */
function lockRefused(
  answer: unknown,
): answer is { readonly code: string; readonly reason: string } {
  return typeof answer === "object" && answer !== null && "code" in answer && "path" in answer;
}

/** How long a standing rule lasts when no `--days` is given. */
export const DEFAULT_RULE_DAYS = 30;
/** The longest a standing rule may last. */
export const MAX_RULE_DAYS = 365;

const DAY_MS = 86_400_000;

/** Why `days` is refused, or `undefined` for a whole number of days from 1 to 365. */
export function ruleDaysProblem(days: unknown): string | undefined {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_RULE_DAYS) {
    return `a standing rule lasts from 1 to ${MAX_RULE_DAYS} days (got ${String(days)})`;
  }
  return undefined;
}

/** The builtin manifest's row for a tool, by the name a session records. */
function manifestEntry(
  toolName: string,
): { readonly operativeArgs?: readonly unknown[] } | undefined {
  for (const entry of Object.values(TOOL_REGISTRY)) {
    if (entry.name === toolName) return entry;
  }
  return undefined;
}

/**
 * A path as the runtime's permission check reads it in this harness: one inside the
 * harness, written absolute, is read relative to it, then `..` is collapsed. Links
 * are not followed: a rule this writes for a path through a link grants nothing,
 * and the person is asked again.
 */
function harnessPathValues(
  harnessDir: string,
): (raw: string) => ReturnType<typeof lexicalPathValues> {
  const roots = [resolve(harnessDir)];
  try {
    const real = realpathSync(harnessDir);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    // A harness that cannot be resolved is read as given.
  }
  return (raw) => {
    if (isAbsolute(raw)) {
      for (const root of roots) {
        const rel = relative(root, resolve(raw));
        if (rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) {
          return lexicalPathValues(rel.split(sep).join("/"));
        }
      }
    }
    return lexicalPathValues(raw);
  };
}

/** The operative values a call carries, as the runtime reads them; `undefined` when the tool declares none. */
export function callValues(
  toolName: string,
  input: unknown,
  harnessDir: string,
): ReturnType<typeof operativeValuesOf> | "no-scoping-argument" {
  const declared = manifestEntry(toolName)?.operativeArgs as OperativeArgs | undefined;
  if (declared === undefined) return undefined;
  if (declared.length === 0) return "no-scoping-argument";
  return (
    operativeValuesOf(declared, input, { canonicalizePath: harnessPathValues(harnessDir) }) ?? []
  );
}

/** A standing rule's pattern, or why there is none. */
export type StandingPattern =
  | NarrowPattern
  | {
      /** The call's value carries a credential, which a rule must never hold. */
      readonly refused: "carries-credential";
    };

/**
 * The narrowest standing rule for an approved call, or why there is none. A tool the
 * manifest says takes no scoping argument is refused here; one it does not list falls
 * back to the matcher's name table, as `crewhaus permissions suggest` does. A rule's
 * pattern is the call's own value, so a value that carries a credential is refused:
 * the pattern would be written to `.crewhaus/settings.json` and the rule's record.
 */
export function standingPatternFor(
  toolName: string,
  input: unknown,
  harnessDir: string,
): StandingPattern {
  const values = callValues(toolName, input, harnessDir);
  if (values === "no-scoping-argument") return { refused: "no-scoping-argument" };
  const narrow = narrowPatternFor(toolName, input, values);
  if ("pattern" in narrow && carriesCredential(narrow.value)) {
    return { refused: "carries-credential" };
  }
  return narrow;
}

/**
 * Why a wider pattern the owner typed is refused: it must be a rule for the same tool,
 * compile, and grant the call it is made from.
 */
export function widenedPatternProblem(
  toolName: string,
  input: unknown,
  pattern: string,
  harnessDir: string,
): string | undefined {
  if (!pattern.startsWith(`${toolName}(`) || !pattern.endsWith(")")) {
    return `a wider rule names the same tool with an argument: ${toolName}(<glob>)`;
  }
  if (carriesCredential(pattern)) return "a rule must not hold a credential";
  const values = callValues(toolName, input, harnessDir);
  const operativeValues = values === "no-scoping-argument" ? undefined : values;
  // Read by the engine itself, as a settings allow and nothing else: a pattern that
  // does not compile is skipped there and grants nothing here either.
  const verdict = evaluate(
    {
      toolName,
      input,
      ...(operativeValues !== undefined ? { operativeValues } : {}),
      readOnly: false,
      destructive: false,
    },
    "default",
    { ...emptyRuleSet, settings: [{ type: "alwaysAllow", pattern, source: "settings" }] },
  );
  return verdict === "allow" ? undefined : `${pattern} does not cover the call it is made from`;
}

/** The spec's revision, when the harness's spec can be read. */
function policyRevisionOf(harnessDir: string): string | undefined {
  try {
    return specRevision(readFileSync(join(harnessDir, "crewhaus.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * End every rule past its end, under the lock the caller holds: an `expired` row each,
 * then the settings entry of each pattern no live row still names.
 */
async function endExpiredLocked(harnessDir: string, nowMs: number): Promise<void> {
  const read = readStandingRules(harnessDir);
  if (read.state !== "present") return;
  const ended = new Set<string>();
  for (const row of read.rows) {
    if (row.state !== "active" || ruleIsLive(row, nowMs)) continue;
    const answer = await casAppendLocked(standingRulesLedger(harnessDir), row.id, "active", {
      ...row,
      state: "expired",
      expiredAt: iso(nowMs),
    });
    if (answer.ok && answer.applied) ended.add(row.pattern);
  }
  for (const pattern of ended) {
    if (read.rows.some((row) => row.pattern === pattern && ruleIsLive(row, nowMs))) continue;
    removeSettingsRule(harnessDir, { type: "alwaysAllow", pattern });
  }
}

/**
 * End the rules past their end in one harness, for Home's tick: the rules file is read
 * first, without a lock, and nothing happens unless an `active` row is past its end. Only
 * then is the control lock taken (as {@link createStandingRule} takes it) and each such
 * rule ended, with the rows read again under the lock: an `expired` row each, and the
 * settings entry of a pattern no live row still names is removed. A harness with no rules
 * file, or none past its end, is never touched. Answers how many patterns were looked at
 * under the lock (0 when nothing was due).
 *
 * First consumer: Home's `standing-rules` sweep.
 */
export async function endExpiredRules(harnessDir: string, nowMs: number): Promise<number> {
  const read = readStandingRules(harnessDir);
  if (read.state !== "present") return 0;
  const due = read.rows.filter((row) => row.state === "active" && !ruleIsLive(row, nowMs));
  if (due.length === 0) return 0;
  const answer = await withLedgerLock(standingRulesLedger(harnessDir), async () => {
    await endExpiredLocked(harnessDir, nowMs);
    return due.length;
  });
  if (typeof answer === "number") return answer;
  throw new Error(answer.reason);
}

/** Throw unless the settings file reads: nothing is written beside a file that does not. */
function assertSettingsReadable(harnessDir: string): void {
  loadSettingsRules(harnessDir);
}

export type RuleWrite = {
  readonly harnessDir: string;
  /** The rule's id, when the caller names it first (a request that names the rule it made). */
  readonly id?: string;
  readonly tool: string;
  readonly pattern: string;
  readonly reason: StandingRuleReason;
  readonly derivedFrom?: string;
  readonly proposal?: string;
  /** The stored actor that makes it. */
  readonly createdBy: string;
  readonly expiresAt: string;
  /** The receipt of the command that makes it. */
  readonly cmd?: string;
  readonly now: number;
};

export type RuleWriteAnswer =
  | { readonly ok: true; readonly rule: StandingRuleRow; readonly settingsPath: string }
  | { readonly ok: false; readonly reason: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Make a standing rule, under the harness's control lock: end the expired ones, write
 * the row, then the settings entry. When the entry cannot be written the row is
 * revoked again, so no rule stands that allows nothing.
 */
export async function createStandingRule(write: RuleWrite): Promise<RuleWriteAnswer> {
  const { harnessDir, now } = write;
  const ledger = standingRulesLedger(harnessDir);
  const answer = await withLedgerLock(ledger, async (): Promise<RuleWriteAnswer> => {
    try {
      assertSettingsReadable(harnessDir);
      await endExpiredLocked(harnessDir, now);
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
    const id = write.id ?? mintId("rule", { now });
    const policyRevision = policyRevisionOf(harnessDir);
    const row: StandingRuleRow = {
      id,
      kind: "allow",
      tool: write.tool,
      pattern: write.pattern,
      ...(write.derivedFrom !== undefined ? { derivedFrom: write.derivedFrom } : {}),
      ...(write.proposal !== undefined ? { proposal: write.proposal } : {}),
      createdBy: write.createdBy,
      reason: write.reason,
      ...(policyRevision !== undefined ? { policyRevision } : {}),
      createdAt: iso(now),
      expiresAt: write.expiresAt,
      ...(write.cmd !== undefined ? { cmd: write.cmd } : {}),
      state: "active",
    };
    const made = await casAppendLocked(ledger, id, null, row);
    if (!made.ok) return { ok: false, reason: made.reason };
    if (!made.applied) return { ok: false, reason: "the rule's id was taken" };
    try {
      const written = appendSettingsRule(harnessDir, {
        type: "alwaysAllow",
        pattern: write.pattern,
      });
      return { ok: true, rule: row, settingsPath: written.path };
    } catch (err) {
      await casAppendLocked(ledger, id, "active", {
        ...row,
        state: "revoked",
        revokedAt: iso(now),
        revokedBy: write.createdBy,
      });
      return { ok: false, reason: messageOf(err) };
    }
  });
  return lockRefused(answer) ? { ok: false, reason: answer.reason } : answer;
}

export type RevokeAnswer =
  | {
      readonly outcome: "revoked";
      readonly rule: StandingRuleRow;
      /** The settings entry went with it; `false` while another live rule names the pattern. */
      readonly settingsRemoved: boolean;
    }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "ended"; readonly rule: StandingRuleRow }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * End a standing rule, under the harness's control lock: the `revoked` row first, then
 * the settings entry, unless another live rule names the same pattern.
 */
export async function revokeStandingRule(input: {
  readonly harnessDir: string;
  readonly id: string;
  readonly revokedBy: string;
  readonly now: number;
}): Promise<RevokeAnswer> {
  const { harnessDir, id, now } = input;
  const ledger = standingRulesLedger(harnessDir);
  const answer = await withLedgerLock(ledger, async (): Promise<RevokeAnswer> => {
    try {
      assertSettingsReadable(harnessDir);
      await endExpiredLocked(harnessDir, now);
    } catch (err) {
      return { outcome: "unavailable", reason: messageOf(err) };
    }
    const read = readStandingRules(harnessDir);
    if (read.state === "unreadable") return { outcome: "unavailable", reason: read.reason };
    const rows = read.state === "present" ? read.rows : [];
    const current = rows.find((row) => row.id === id);
    if (current === undefined) return { outcome: "not-found" };
    if (current.state !== "active") return { outcome: "ended", rule: current };
    const revoked: StandingRuleRow = {
      ...current,
      state: "revoked",
      revokedAt: iso(now),
      revokedBy: input.revokedBy,
    };
    const moved = await casAppendLocked(ledger, id, "active", revoked);
    if (!moved.ok) return { outcome: "unavailable", reason: moved.reason };
    if (!moved.applied) return { outcome: "ended", rule: current };
    const stillNamed = rows.some(
      (row) => row.id !== id && row.pattern === current.pattern && ruleIsLive(row, now),
    );
    if (stillNamed) return { outcome: "revoked", rule: revoked, settingsRemoved: false };
    try {
      const removed = removeSettingsRule(harnessDir, {
        type: "alwaysAllow",
        pattern: current.pattern,
      });
      return { outcome: "revoked", rule: revoked, settingsRemoved: removed.removed };
    } catch (err) {
      // The row stands revoked, and an entry the record names loads only while a row is live.
      return { outcome: "unavailable", reason: messageOf(err) };
    }
  });
  return lockRefused(answer) ? { outcome: "unavailable", reason: answer.reason } : answer;
}

/** An `alwaysAllow` in the settings file that no standing-rule record names, for a whole tool. */
export type LegacyAllow = {
  readonly tool: string;
  readonly pattern: string;
  readonly note: string;
  readonly verb: string;
};

/** The settings file's `alwaysAllow` patterns, or `undefined` when it cannot be read. */
function settingsAllows(harnessDir: string): readonly string[] | undefined {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(settingsFilePath(harnessDir), "utf8"));
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? [] : undefined;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return undefined;
  try {
    const parsed = parsePermissionsConfig(
      (root as Record<string, unknown>)["permissions"],
      "settings",
    );
    return parsed.rules.filter((r) => r.type === "alwaysAllow").map((r) => r.pattern);
  } catch {
    return undefined;
  }
}

/**
 * Every settings `alwaysAllow` that no standing-rule row names and that names a whole
 * tool (no `(` argument): what to narrow or remove. Derived on read; nothing is written
 * and nothing is removed. A record or a settings file that cannot be read lists nothing.
 */
export function legacyBroadAllows(harnessDir: string): readonly LegacyAllow[] {
  const allows = settingsAllows(harnessDir);
  if (allows === undefined) return [];
  const read = readStandingRules(harnessDir);
  if (read.state === "unreadable") return [];
  const named = new Set(read.state === "present" ? read.rows.map((row) => row.pattern) : []);
  return allows
    .filter((pattern) => !pattern.includes("(") && !named.has(pattern))
    .map((pattern) => ({
      tool: pattern,
      pattern,
      note: "legacy broad allow: make it narrow, or remove it",
      verb: `crewhaus approvals revoke --legacy ${pattern} --dir ${harnessDir}`,
    }));
}

export type LegacyRevokeAnswer =
  | { readonly outcome: "removed"; readonly path: string }
  | { readonly outcome: "not-found" }
  /** A record names the pattern: revoke its rule by id instead. */
  | { readonly outcome: "recorded" }
  | { readonly outcome: "unavailable"; readonly reason: string };

/** Remove one settings `alwaysAllow` no standing-rule record names, under the control lock. */
export async function revokeLegacyAllow(input: {
  readonly harnessDir: string;
  readonly pattern: string;
}): Promise<LegacyRevokeAnswer> {
  const { harnessDir, pattern } = input;
  const answer = await withLedgerLock(
    standingRulesLedger(harnessDir),
    async (): Promise<LegacyRevokeAnswer> => {
      const read = readStandingRules(harnessDir);
      if (read.state === "unreadable") return { outcome: "unavailable", reason: read.reason };
      if (read.state === "present" && read.rows.some((row) => row.pattern === pattern)) {
        return { outcome: "recorded" };
      }
      try {
        const removed = removeSettingsRule(harnessDir, { type: "alwaysAllow", pattern });
        return removed.removed
          ? { outcome: "removed", path: removed.path }
          : { outcome: "not-found" };
      } catch (err) {
        return { outcome: "unavailable", reason: messageOf(err) };
      }
    },
  );
  return lockRefused(answer) ? { outcome: "unavailable", reason: answer.reason } : answer;
}

/** When a rule made now for `days` ends. */
export function ruleEnd(nowMs: number, days: number): string {
  return iso(nowMs + days * DAY_MS);
}

// ---------------------------------------------------------------------------
// The rules a head lists and ends
// ---------------------------------------------------------------------------

/** One live standing rule, as `crewhaus approvals rules` lists it. */
export type ListedRule = StandingRuleRow & { readonly verb: string };
/** One request to the owner still waiting. */
export type ListedProposal = ProposalRow & { readonly verbs: readonly string[] };

export type RuleListing = {
  readonly rules: readonly ListedRule[];
  readonly proposals: readonly ListedProposal[];
  readonly legacy: readonly LegacyAllow[];
  /** What could not be read, one sentence each. */
  readonly unreadable: readonly string[];
};

export type RuleRevokeAnswer =
  | RevokeAnswer
  | { readonly outcome: "forbidden"; readonly reason: string };

export type LegacyRevokeOutcome =
  | LegacyRevokeAnswer
  | { readonly outcome: "forbidden"; readonly reason: string };

export type Rules = {
  /** Live rules, waiting requests and whole-tool allows no record names. A pure read. */
  list(harnessDir: string): RuleListing;
  /** End a standing rule. The owner's alone. */
  revoke(input: {
    readonly harnessDir: string;
    readonly id: string;
    readonly actor: DecisionActor;
  }): Promise<RuleRevokeAnswer>;
  /** Remove a settings allow no record names. The owner's alone. */
  revokeLegacy(input: {
    readonly harnessDir: string;
    readonly pattern: string;
    readonly actor: DecisionActor;
  }): Promise<LegacyRevokeOutcome>;
};

function rowsOf<T>(read: LedgerRead<T>, what: string, unreadable: string[]): readonly T[] {
  if (read.state === "unreadable") {
    unreadable.push(`${what} cannot be read: ${read.reason}`);
    return [];
  }
  return read.state === "present" ? read.rows : [];
}

export function createRules(decisions: Decisions, now: () => number): Rules {
  const notOwner = { outcome: "forbidden" as const, reason: "Needs the owner." };
  return {
    list(harnessDir) {
      const unreadable: string[] = [];
      const nowMs = now();
      const rules = rowsOf(readStandingRules(harnessDir), "The standing rules", unreadable)
        .filter((row) => ruleIsLive(row, nowMs))
        .map((row) => ({
          ...row,
          verb: `crewhaus approvals revoke ${row.id} --dir ${harnessDir}`,
        }));
      const proposals = rowsOf(readProposals(harnessDir), "The requests to the owner", unreadable)
        .filter((row) => proposalState(row, nowMs) === "pending")
        .map((row) => ({
          ...row,
          verbs: [
            `crewhaus approvals grant ${row.id} --dir ${harnessDir}`,
            `crewhaus approvals deny ${row.id} --dir ${harnessDir}`,
          ],
        }));
      return { rules, proposals, legacy: legacyBroadAllows(harnessDir), unreadable };
    },
    async revoke({ harnessDir, id, actor }) {
      if (!decisions.mayManageRules(harnessDir, actor)) return notOwner;
      const revokedBy = await decisions.storedActorOf(harnessDir, actor);
      return revokeStandingRule({ harnessDir, id, revokedBy, now: now() });
    },
    async revokeLegacy({ harnessDir, pattern, actor }) {
      if (!decisions.mayManageRules(harnessDir, actor)) return notOwner;
      return revokeLegacyAllow({ harnessDir, pattern });
    },
  };
}
