/**
 * Delegation rules and what each one did, as files: an owner's rule that lets the control
 * plane decide one narrow kind of decision on its own (#517, #513, module brief 324).
 *
 * | Scope | Rules | Application lines |
 * |---|---|---|
 * | a harness (`merge`, `rollout`, `adopt`) | `.crewhaus/run/control/delegations.jsonl` | `.crewhaus/run/control/delegation-log/` |
 * | the workspace (`assistant`) | `<hangarRoot>/control/delegations.jsonl` | `<hangarRoot>/control/delegation-log/` |
 *
 * Both sit under the runtime-state floor, so no agent tool can write a rule. A rule row is
 * on control-contract's `delegation` machine and restates the whole rule; its keys are a
 * closed set of ids, keyed digests, counts, times and closed codes. Application lines are
 * in size segments on no machine, never compacted, with a closed key set of their own.
 * Each pair shares its root's control lock and claims, so a writer that holds the lock for
 * one compare-and-sets on the decisions and the rules together.
 *
 * Reads take no lock, write nothing and repair nothing: a row with a key outside the
 * closed set, or a move the machine refuses, is left out and reported as an anomaly.
 */
import { join } from "node:path";
import {
  DELEGATION_ACTIONS,
  DELEGATION_LOG_EVENTS,
  DELEGATION_LOG_KEYS,
  DELEGATION_RULE_KEYS,
  DELEGATION_RULE_REASONS,
  DELEGATION_RULE_STATES,
  type DelegationLogLine,
  type DelegationRuleRow,
  HARNESS_ID_RE,
  isId,
  isRef,
  isStoredActor,
  parseActor,
} from "@crewhaus/control-contract";
import { type CachedReader, cachedPerPath } from "./fail-closed";
import { type AppendAnswer, type LedgerRecord, foldStates, withLedgerLock } from "./ledger";
import { type Ledger, controlPaths, harnessLedger } from "./paths";
import type { LedgerRead } from "./standing-rules";
import { readPage } from "./tail";

/** Where a rule lives: in a harness, or in the workspace (`<hangarRoot>/control/`). */
export type DelegationScopeChoice = "harness" | "workspace";

function workspaceLedger(hangarRoot: string, records: Ledger["records"], machine?: "delegation") {
  return {
    root: hangarRoot,
    records,
    lock: join("control", "lock"),
    claims: join("control", "claims"),
    ...(machine !== undefined ? { machine } : {}),
  } as Ledger;
}

/**
 * The delegation rules of a harness (or of the workspace), on the `delegation` machine.
 *
 * First consumer: control-service's delegation service.
 */
export function delegationsLedger(root: string, scope: DelegationScopeChoice = "harness"): Ledger {
  return scope === "workspace"
    ? workspaceLedger(root, { file: join("control", "delegations.jsonl") }, "delegation")
    : harnessLedger(root, { file: controlPaths(root).delegationsFile }, { machine: "delegation" });
}

/**
 * The application lines of a harness's (or the workspace's) delegation rules: size
 * segments, no machine, never compacted.
 *
 * First consumer: control-service's delegation service.
 */
export function delegationLogLedger(
  root: string,
  scope: DelegationScopeChoice = "harness",
): Ledger {
  return scope === "workspace"
    ? workspaceLedger(root, { dir: join("control", "delegation-log") })
    : harnessLedger(root, { dir: controlPaths(root).delegationLogDir });
}

const BOOKKEEPING = new Set(["claim", "gen", "repaired"]);
const RULE_KEYS: ReadonlySet<string> = new Set(DELEGATION_RULE_KEYS);
const LOG_KEYS: ReadonlySet<string> = new Set(DELEGATION_LOG_KEYS);

/** A value from a closed list, a count, a digest or a name: what a content-free row holds. */
const CODE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const REVISION_RE = /^sha256:[0-9a-f]{64}$/;
/** A narrowing value of a rule's scope: a binding name, a glob or a branch. Never prose. */
const SCOPE_TEXT_RE = /^[A-Za-z0-9._*?/{}[\],!@:+=-]{1,200}$/;
const SUBJECT_REVISION_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

const isInstant = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
};
const isPositive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
  value === undefined || check(value);
const oneOf =
  (list: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === "string" && list.includes(value);

function withoutBookkeeping(row: LedgerRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (!BOOKKEEPING.has(name)) out[name] = value;
  }
  return out;
}

function onlyKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => keys.has(key));
}

function isScopeValue(value: unknown): boolean {
  if (typeof value === "string") return SCOPE_TEXT_RE.test(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((item) => typeof item === "string" && SCOPE_TEXT_RE.test(item))
  );
}

/**
 * Whether rule terms hold only the closed fields, each content-free.
 *
 * First consumers: {@link delegationRuleOf} and a delegation request's reader.
 */
export function isDelegationTerms(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!onlyKeys(value, new Set(["days", "maxUses", "scope"]))) return false;
  if (!isPositive(value["days"]) || (value["days"] as number) > 90) return false;
  if (!optional(value["maxUses"], isPositive)) return false;
  const scope = value["scope"];
  if (scope === undefined) return true;
  if (!isRecord(scope)) return false;
  return Object.entries(scope).every(([name, item]) => CODE_RE.test(name) && isScopeValue(item));
}

function isScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "harness") return HARNESS_ID_RE.test(String(value["harness"]));
  const many = value["harnesses"];
  return (
    keys[0] === "harnesses" &&
    Array.isArray(many) &&
    many.every((id) => typeof id === "string" && HARNESS_ID_RE.test(id))
  );
}

/** An owner is a person: a member's `prn_` or a local user's keyed digest, never a system actor. */
function isOwner(value: unknown): boolean {
  const form = parseActor(value)?.form;
  return form === "principal" || form === "stored-local";
}

/**
 * A row as a delegation rule, or `undefined` when it is not one: every key in the closed
 * set, every value of its declared shape.
 *
 * First consumer: {@link readDelegations}.
 */
export function delegationRuleOf(row: LedgerRecord): DelegationRuleRow | undefined {
  const r = withoutBookkeeping(row);
  const ok =
    onlyKeys(r, RULE_KEYS) &&
    r["v"] === 1 &&
    isInstant(r["at"]) &&
    isId("rule", r["id"]) &&
    oneOf(DELEGATION_RULE_STATES)(r["state"]) &&
    r["kind"] === "delegate" &&
    oneOf(DELEGATION_ACTIONS)(r["action"]) &&
    isPositive(r["revision"]) &&
    isScope(r["scope"]) &&
    isDelegationTerms(r["terms"]) &&
    HEX64_RE.test(String(r["termsDigest"])) &&
    REVISION_RE.test(String(r["ceilingDigest"])) &&
    REVISION_RE.test(String(r["policyRevision"])) &&
    HEX64_RE.test(String(r["consequencesDigest"])) &&
    optional(r["hostDigest"], (v) => HEX64_RE.test(String(v))) &&
    isInstant(r["expiresAt"]) &&
    optional(r["maxUses"], isPositive) &&
    isOwner(r["owner"]) &&
    optional(r["by"], isStoredActor) &&
    optional(r["decision"], (v) => isId("dec", v)) &&
    optional(r["reason"], oneOf(DELEGATION_RULE_REASONS)) &&
    isId("cmd", r["cmd"]);
  return ok ? (r as DelegationRuleRow) : undefined;
}

function isGateLine(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(
      value,
      new Set(["gate", "outcome", "boundTo", "evidence", "at", "freshUntil", "reason"]),
    ) &&
    CODE_RE.test(String(value["gate"])) &&
    CODE_RE.test(String(value["outcome"])) &&
    typeof value["boundTo"] === "string" &&
    SUBJECT_REVISION_RE.test(value["boundTo"]) &&
    Array.isArray(value["evidence"]) &&
    value["evidence"].length <= 20 &&
    value["evidence"].every(isRef) &&
    typeof value["at"] === "string" &&
    Number.isFinite(Date.parse(value["at"])) &&
    typeof value["freshUntil"] === "string" &&
    optional(value["reason"], (v) => CODE_RE.test(String(v)))
  );
}

/** A plan or a watch: a small object of ids, codes, digests, counts and times only. */
function isContentFree(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (typeof value === "string") return SCOPE_TEXT_RE.test(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.length <= 20 && value.every((item) => isContentFree(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 20 &&
    entries.every(
      ([name, item]) => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name) && isContentFree(item, depth + 1),
    )
  );
}

/**
 * A row as an application line, or `undefined` when it is not one.
 *
 * First consumer: {@link readDelegationLog}.
 */
export function delegationLogLineOf(
  row: Readonly<Record<string, unknown>>,
): DelegationLogLine | undefined {
  const r = row as Record<string, unknown>;
  const subject = r["subject"];
  const ok =
    onlyKeys(r, LOG_KEYS) &&
    r["v"] === 1 &&
    isInstant(r["at"]) &&
    oneOf(DELEGATION_LOG_EVENTS)(r["event"]) &&
    isId("rule", r["rule"]) &&
    isPositive(r["revision"]) &&
    optional(r["decision"], (v) => isId("dec", v)) &&
    optional(
      subject,
      (v) =>
        isRecord(v) &&
        onlyKeys(v, new Set(["ref", "revision"])) &&
        isRef(v["ref"]) &&
        SUBJECT_REVISION_RE.test(String(v["revision"])),
    ) &&
    optional(r["gates"], (v) => Array.isArray(v) && v.length <= 11 && v.every(isGateLine)) &&
    optional(r["plan"], (v) => isRecord(v) && isContentFree(v)) &&
    optional(r["watch"], (v) => isRecord(v) && isContentFree(v)) &&
    optional(r["cmd"], (v) => isId("cmd", v)) &&
    optional(r["appliedBy"], isStoredActor) &&
    optional(r["reason"], (v) => CODE_RE.test(String(v)));
  return ok ? (r as DelegationLogLine) : undefined;
}

/**
 * Every delegation rule of a harness (or of the workspace), as its latest legal row says:
 * a tolerant fold that takes no lock and writes nothing. A row with a key outside the
 * closed set, or of another shape, is left out and reported; an illegal move is kept on
 * disk and reported, never applied.
 *
 * First consumers: the delegation service, `crewhaus delegations`, Home.
 */
export function readDelegations(
  root: string,
  scope: DelegationScopeChoice = "harness",
): LedgerRead<DelegationRuleRow> {
  const fold = foldStates(delegationsLedger(root, scope));
  if (!fold.ok) {
    return fold.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: fold.reason };
  }
  if (fold.records === 0 && fold.gaps.length === 0) return { state: "absent" };
  const rows: DelegationRuleRow[] = [];
  const anomalies: string[] = [];
  for (const object of fold.objects.values()) {
    const row = delegationRuleOf(object.record);
    if (row !== undefined) rows.push(row);
    else anomalies.push(`${object.id}: the row is not a delegation rule`);
  }
  for (const anomaly of fold.anomalies) {
    anomalies.push(
      `${anomaly.id}: a row moving ${anomaly.from ?? "nothing"} to ${anomaly.to ?? "nothing"} is not a move its machine allows`,
    );
  }
  if (fold.gaps.length > 0) anomalies.push(`${fold.gaps.length} line(s) cannot be read`);
  return { state: "present", rows, anomalies };
}

/**
 * {@link readDelegations} behind a one-second cache per path, by the injected clock: what
 * every application reads. The effect reads uncached, so a revoke between a check and
 * the effect always wins. Synchronous, no lock, nothing created.
 *
 * First consumer: the delegation service's sweep.
 */
export function createDelegationReader(
  options: { readonly now?: () => number; readonly scope?: DelegationScopeChoice } = {},
): CachedReader<LedgerRead<DelegationRuleRow>> {
  const scope = options.scope ?? "harness";
  return cachedPerPath((root) => readDelegations(root, scope), options.now ?? (() => Date.now()));
}

/**
 * Append one application line, under the root's control lock, after checking it against
 * the closed key set: a line that is not one is refused and nothing is written.
 *
 * First consumer: the delegation service.
 */
export async function appendDelegationLog(
  root: string,
  line: DelegationLogLine,
  scope: DelegationScopeChoice = "harness",
): Promise<AppendAnswer> {
  if (delegationLogLineOf(line as unknown as Record<string, unknown>) === undefined) {
    throw new TypeError("control-records: an application line outside its closed key set");
  }
  return withLedgerLock(delegationLogLedger(root, scope), (lockedAppend) =>
    lockedAppend(line as unknown as LedgerRecord),
  );
}

export type DelegationLogRead =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      /** Oldest first. */
      readonly lines: readonly DelegationLogLine[];
      /** Lines left out, one sentence each, never a value from a line. */
      readonly anomalies: readonly string[];
      /** Older lines lie past the cap. */
      readonly truncated: boolean;
    };

/** Lines read per page. */
const LOG_PAGE = 512;

/**
 * The application lines, oldest first: a raw read, page by page from the newest end,
 * with no lock and no write. `maxLines` caps a view, and `truncated` says so; the write
 * path reads whole (no cap). A line outside the closed key set is left out and reported.
 *
 * First consumers: the sweep (whole) and `delegations.get` (capped).
 */
export function readDelegationLog(
  root: string,
  options: { readonly scope?: DelegationScopeChoice; readonly maxLines?: number } = {},
): DelegationLogRead {
  const ledger = delegationLogLedger(root, options.scope ?? "harness");
  const cap = options.maxLines ?? Number.POSITIVE_INFINITY;
  const newestFirst: DelegationLogLine[] = [];
  const anomalies: string[] = [];
  let before: Parameters<typeof readPage>[1]["before"];
  let truncated = false;
  let any = false;
  for (;;) {
    const page = readPage(ledger, { limit: LOG_PAGE, ...(before !== undefined ? { before } : {}) });
    for (const gap of page.gaps) {
      if (gap.reason === "unreadable" && gap.bytes === 0 && "detail" in gap) {
        anomalies.push("a segment of the application log cannot be read");
      } else {
        anomalies.push("a line of the application log cannot be read");
      }
    }
    for (const item of page.items) {
      any = true;
      if (newestFirst.length >= cap) {
        truncated = true;
        break;
      }
      const line = delegationLogLineOf(item.record);
      if (line === undefined) anomalies.push("a line is not an application line");
      else newestFirst.push(line);
    }
    if (truncated || page.next === undefined) break;
    before = page.next;
  }
  if (!any && anomalies.length === 0) return { state: "absent" };
  return { state: "present", lines: newestFirst.reverse(), anomalies, truncated };
}

/**
 * How many times a rule has acted: its `acted` lines, every revision counted.
 *
 * First consumer: the sweep's use cap.
 */
export function ruleUses(lines: readonly DelegationLogLine[], rule: string): number {
  let uses = 0;
  for (const line of lines) if (line.event === "acted" && line.rule === rule) uses += 1;
  return uses;
}
