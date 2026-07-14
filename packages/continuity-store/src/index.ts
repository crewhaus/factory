/**
 * v0.3.0 Goal 1 — `continuity-store` (design §2.2–§2.7, PR 7).
 *
 * Human-readable, user-clearable continuity artifacts under
 * `.crewhaus/state/<specName>/`:
 *
 *   focus.md                  — marker-gated (`<!-- crewhaus:focus -->`),
 *                               focus body capped at `focusMaxChars`, plus the
 *                               REQ-nnn requirements ledger and the active
 *                               plan pointer
 *   plans/plan-NNNN-<slug>.md — YAML frontmatter + numbered steps carrying the
 *                               open → in_progress → claimed → proven ladder
 *   goals.yaml                — {id, title, status, target?, current?, unit?}
 *   handoff.md                — deterministic teardown render (NO model call
 *                               anywhere in this package)
 *   .lock                     — advisory single-writer lock (see lock.ts)
 *
 * Why files + markers: matches project-memory's LESSONS.md precedent — a
 * user-authored focus.md without the marker is NEVER overwritten (and never
 * injected), so crewhaus-managed state cannot hijack a human file.
 *
 * Proof ladder (§2.4): `claimed` is always free; `proven` is machine-checked
 * against the append-only session event logs (including sub-agent child
 * sessions via the `sub_agent_start` brackets). On a proven transition the
 * store (a) pins the cited session in `.crewhaus/retention.json` and (b)
 * freezes a `{toolName, inputHash, resultDigest}` proof excerpt into the
 * plan/goal record, so evidence outlives the transcript TTL.
 *
 * Clearing (§2.6): `clear()` moves files to `.crewhaus/trash/<ts>/…` — never
 * hard-deletes — and `restore(ts)` undoes it. `moveToTrash` is exported for
 * other stores to adopt.
 *
 * Scoping (§2.7): one store per spec by default; `scope: {kind: "session"}`
 * nests under `<spec>/sessions/<sessionId>/` for per-conversation state
 * (channel daemons). Tenant contexts use the same fail-closed path fencing
 * session-store enforces (CWE-1230): with a tenant present, any resolved
 * path outside the tenant's root throws.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { type Tenant, assertSamePath, currentTenantContext } from "@crewhaus/tenancy";
import YAML from "yaml";
import {
  type EvidenceRef,
  type FrozenProof,
  appendRetentionPins,
  verifyEvidence,
} from "./evidence";
import { HANDOFF_MARKER, renderHandoff } from "./handoff";
import { type AcquireLockOptions, withLock } from "./lock";
import {
  type MoveToTrashResult,
  type RestoreResult,
  type TrashSnapshot,
  listTrash as listTrashDir,
  moveToTrash,
  restoreFromTrash,
} from "./trash";
import type {
  ClaimableStatus,
  FocusState,
  Goal,
  LadderStatus,
  PlanRecord,
  PlanStep,
  Requirement,
  RequirementStatus,
} from "./types";

export {
  type AcquireLockOptions,
  type LockHandle,
  type LockPolicy,
  ContinuityLockError,
  DEFAULT_LOCK_POLICY,
  acquireLock,
  withLock,
} from "./lock";
export {
  type MoveToTrashResult,
  type PurgeTrashResult,
  type RestoreResult,
  type TrashSnapshot,
  TRASH_DIR_NAME,
  TRASH_PURGE_AFTER_MS,
  TrashError,
  listTrash,
  moveToTrash,
  parseTrashTimestamp,
  purgeTrash,
  restoreFromTrash,
} from "./trash";
export {
  type EvidenceRef,
  type EvidenceResolution,
  type EvidenceVerdict,
  type FrozenProof,
  type VerifyEvidenceOptions,
  DEFAULT_SESSION_ROOT_DIR,
  EvidenceError,
  appendRetentionPins,
  resolveEvidence,
  verifyEvidence,
} from "./evidence";
export { type HandoffInput, HANDOFF_MARKER, renderHandoff, renderStatus } from "./handoff";
export type {
  ClaimableStatus,
  FocusState,
  Goal,
  LadderStatus,
  PlanRecord,
  PlanStep,
  Requirement,
  RequirementStatus,
} from "./types";

export const DEFAULT_ROOT_DIR = ".crewhaus/state";
export const DEFAULT_FOCUS_MAX_CHARS = 4096;
/** §2.3 ledger cap: oldest-first eviction with a `[ledger truncated]` marker. */
export const REQUIREMENTS_LEDGER_MAX_BYTES = 16_384;

export const FOCUS_MARKER = "<!-- crewhaus:focus -->";
const ACTIVE_PLAN_MARKER = "<!-- crewhaus:active-plan -->";
const REQUIREMENTS_MARKER = "<!-- crewhaus:requirements -->";
const LEDGER_TRUNCATED_LINE = "[ledger truncated]";
const NONE_LINE = "_none_";

const SPEC_NAME_REGEX = /^[a-zA-Z0-9_\-.]+$/;
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
const PLAN_ID_REGEX = /^plan-\d{4}$/;
const GOAL_ID_REGEX = /^goal-\d{4}$/;
const REQ_ID_REGEX = /^REQ-\d{3,}$/;
const REQ_LINE_REGEX =
  /^- (REQ-\d{3,}) \[(open|confirmed|dropped)\] (".*") \(user, (sess_[0-9a-f]{16}), turn (\d+)\)$/;
const STEP_LINE_REGEX = /^(\d+)\. \[(open|in_progress|claimed|proven)\] (.+)$/;

export class ContinuityStoreError extends CrewhausError {
  override readonly name = "ContinuityStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type ContinuityScope =
  | { readonly kind: "spec" }
  | { readonly kind: "session"; readonly sessionId: string };

export type ClearScope = "focus" | "plans" | "goals" | "all";

export interface ContinuityStoreOptions {
  readonly specName: string;
  /** Default `.crewhaus/state` (or `<tenantRoot>/state` under a tenant). */
  readonly rootDir?: string;
  /** Default `{kind: "spec"}`. Session scope nests the store under
   *  `<spec>/sessions/<sessionId>/` (design §2.7). */
  readonly scope?: ContinuityScope;
  /** Explicit tenant to fence against (in addition to any ambient
   *  `withTenant` context, which is always honored). */
  readonly tenant?: Tenant;
  /** Where session `.jsonl` event logs live, for proof verification.
   *  Default: the `sessions` sibling of the state root
   *  (`.crewhaus/sessions`). */
  readonly sessionRootDir?: string;
  /** Default session for evidence refs that omit `sessionId`. */
  readonly sessionId?: string;
  /** Hard cap on the focus body (design §2.1 `focusMaxChars`). Default 4096. */
  readonly focusMaxChars?: number;
  readonly now?: () => Date;
  /** Lock policy overrides + warning sink (lock steals, §7.6). */
  readonly lock?: AcquireLockOptions;
}

export type AppendRequirementInput = {
  /** Existing `REQ-nnn` to update (status move), or omitted to mint the next
   *  id. Updating requires `text` to match the stored entry VERBATIM. */
  readonly id?: string;
  /** The requirement, verbatim — never paraphrase. */
  readonly text: string;
  readonly source: { readonly sessionId: string; readonly turn: number };
  readonly status?: RequirementStatus;
};

export type UpdateGoalInput = {
  readonly title?: string;
  readonly status?: LadderStatus;
  readonly target?: number;
  readonly current?: number;
  readonly unit?: string;
  /** Required when `status: "proven"` — verified like a plan step. */
  readonly evidence?: readonly EvidenceRef[];
};

export interface ContinuityStore {
  /** The scoped directory this store reads and writes. */
  dir(): string;

  // ---- focus + requirements ledger ----
  readFocus(): Promise<FocusState | null>;
  writeFocus(body: string): Promise<void>;
  setActivePlan(planId: string | null): Promise<void>;
  appendRequirement(input: AppendRequirementInput): Promise<Requirement>;
  listRequirements(): Promise<readonly Requirement[]>;

  // ---- plans ----
  createPlan(input: { title: string; steps?: readonly string[] }): Promise<PlanRecord>;
  getPlan(planId: string): Promise<PlanRecord | null>;
  listPlans(): Promise<readonly PlanRecord[]>;
  getActivePlan(): Promise<PlanRecord | null>;
  addStep(planId: string, text: string): Promise<PlanRecord>;
  /** Ladder moves below `proven` — always free (§2.4). */
  setStepStatus(planId: string, step: number, status: ClaimableStatus): Promise<PlanRecord>;
  /** The `proven` transition: verifies evidence against session event logs,
   *  freezes proof excerpts into the plan record, and pins the cited
   *  sessions in `.crewhaus/retention.json`. */
  proveStep(planId: string, step: number, evidence: readonly EvidenceRef[]): Promise<PlanRecord>;

  // ---- goals ----
  writeGoal(input: {
    title: string;
    target?: number;
    current?: number;
    unit?: string;
  }): Promise<Goal>;
  updateGoal(goalId: string, patch: UpdateGoalInput): Promise<Goal>;
  listGoals(): Promise<readonly Goal[]>;

  // ---- proof ----
  verifyEvidence(refs: readonly EvidenceRef[]): Promise<readonly FrozenProof[]>;

  // ---- handoff ----
  renderHandoff(opts?: { lastSessionId?: string }): Promise<string>;
  /** Renders and writes `handoff.md`; returns the file path. */
  writeHandoff(opts?: { lastSessionId?: string }): Promise<string>;

  // ---- clearing (§2.6 — trash, never hard-delete) ----
  clear(scope: ClearScope): Promise<MoveToTrashResult>;
  restore(ts: string): Promise<RestoreResult>;
  listTrash(): Promise<readonly TrashSnapshot[]>;
}

// ---------------------------------------------------------------------------
// focus.md rendering + parsing
// ---------------------------------------------------------------------------

function renderRequirementLine(req: Requirement): string {
  return `- ${req.id} [${req.status}] ${JSON.stringify(req.text)} (user, ${req.source.sessionId}, turn ${req.source.turn})`;
}

function renderFocusFile(state: FocusState): string {
  const reqLines = state.requirements.map(renderRequirementLine);
  const ledgerLines =
    reqLines.length > 0
      ? state.ledgerTruncated
        ? [LEDGER_TRUNCATED_LINE, ...reqLines]
        : reqLines
      : [NONE_LINE];
  return [
    FOCUS_MARKER,
    "# Focus",
    "",
    state.body,
    "",
    "## Active plan",
    ACTIVE_PLAN_MARKER,
    state.activePlanId ?? NONE_LINE,
    "",
    "## Requirements",
    REQUIREMENTS_MARKER,
    ...ledgerLines,
    "",
  ].join("\n");
}

function parseFocusFile(raw: string): FocusState | null {
  if (!raw.trimStart().startsWith(FOCUS_MARKER)) return null;

  const activeHeader = `## Active plan\n${ACTIVE_PLAN_MARKER}`;
  const reqHeader = `## Requirements\n${REQUIREMENTS_MARKER}`;
  const activeIdx = raw.indexOf(activeHeader);
  const reqIdx = raw.indexOf(reqHeader);

  const afterMarker = raw.indexOf(FOCUS_MARKER) + FOCUS_MARKER.length;
  const bodyEnd = activeIdx >= 0 ? activeIdx : reqIdx >= 0 ? reqIdx : raw.length;
  let body = raw.slice(afterMarker, bodyEnd);
  body = body.replace(/^\s*# Focus\s*\n/, "").trim();

  let activePlanId: string | null = null;
  if (activeIdx >= 0) {
    const sectionStart = activeIdx + activeHeader.length;
    const sectionEnd = reqIdx >= 0 ? reqIdx : raw.length;
    const line = raw.slice(sectionStart, sectionEnd).trim().split("\n")[0]?.trim() ?? "";
    if (PLAN_ID_REGEX.test(line)) activePlanId = line;
  }

  const requirements: Requirement[] = [];
  let ledgerTruncated = false;
  if (reqIdx >= 0) {
    for (const line of raw
      .slice(reqIdx + reqHeader.length)
      .split("\n")
      .map((l) => l.trim())) {
      if (line === LEDGER_TRUNCATED_LINE) {
        ledgerTruncated = true;
        continue;
      }
      const m = REQ_LINE_REGEX.exec(line);
      if (m === null) continue;
      let text: string;
      try {
        text = JSON.parse(m[3] as string) as string;
      } catch {
        continue; // A hand-mangled line — skip rather than mis-attribute.
      }
      requirements.push({
        id: m[1] as string,
        status: m[2] as RequirementStatus,
        text,
        source: { sessionId: m[4] as string, turn: Number(m[5]) },
      });
    }
  }

  return { body, activePlanId, requirements, ledgerTruncated };
}

// ---------------------------------------------------------------------------
// plan file rendering + parsing
// ---------------------------------------------------------------------------

type PlanFrontmatter = {
  id: string;
  slug: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  proofs?: Record<string, FrozenProof[]>;
};

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug !== "" ? slug : "plan";
}

function renderPlanFile(plan: PlanRecord): string {
  const proofs: Record<string, FrozenProof[]> = {};
  for (const step of plan.steps) {
    if (step.proofs.length > 0) proofs[String(step.index)] = [...step.proofs];
  }
  const frontmatter: PlanFrontmatter = {
    id: plan.id,
    slug: plan.slug,
    title: plan.title,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(Object.keys(proofs).length > 0 ? { proofs } : {}),
  };
  const stepLines = plan.steps.map((s) => `${s.index}. [${s.status}] ${s.text}`);
  return [
    "---",
    YAML.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${plan.title}`,
    "",
    "## Steps",
    "",
    ...(stepLines.length > 0 ? stepLines : ["_no steps yet_"]),
    "",
  ].join("\n");
}

function isFrozenProofShape(value: unknown): value is FrozenProof {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["toolUseId"] === "string" &&
    typeof v["sessionId"] === "string" &&
    typeof v["toolName"] === "string" &&
    typeof v["inputHash"] === "string" &&
    typeof v["resultDigest"] === "string" &&
    typeof v["verifiedAt"] === "string"
  );
}

function parsePlanFile(raw: string, path: string): PlanRecord {
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (fmMatch === null) {
    throw new ContinuityStoreError(`continuity-store: ${path} has no YAML frontmatter`);
  }
  let fm: unknown;
  try {
    fm = YAML.parse(fmMatch[1] as string);
  } catch (err) {
    throw new ContinuityStoreError(`continuity-store: ${path} has malformed frontmatter`, err);
  }
  if (typeof fm !== "object" || fm === null) {
    throw new ContinuityStoreError(`continuity-store: ${path} frontmatter is not a mapping`);
  }
  const f = fm as Record<string, unknown>;
  const id = typeof f["id"] === "string" ? f["id"] : "";
  if (!PLAN_ID_REGEX.test(id)) {
    throw new ContinuityStoreError(`continuity-store: ${path} has an invalid plan id "${id}"`);
  }
  const proofsByStep = new Map<number, FrozenProof[]>();
  if (typeof f["proofs"] === "object" && f["proofs"] !== null) {
    for (const [key, value] of Object.entries(f["proofs"] as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isInteger(index) || !Array.isArray(value)) continue;
      proofsByStep.set(index, value.filter(isFrozenProofShape));
    }
  }

  const body = raw.slice(fmMatch[0].length);
  const steps: PlanStep[] = [];
  for (const line of body.split("\n")) {
    const m = STEP_LINE_REGEX.exec(line.trim());
    if (m === null) continue;
    const index = steps.length + 1;
    steps.push({
      index,
      status: m[2] as LadderStatus,
      text: (m[3] as string).trim(),
      proofs: proofsByStep.get(index) ?? [],
    });
  }

  return {
    id,
    slug: typeof f["slug"] === "string" ? f["slug"] : slugify(String(f["title"] ?? "")),
    title: typeof f["title"] === "string" ? f["title"] : id,
    createdAt: typeof f["createdAt"] === "string" ? f["createdAt"] : "",
    updatedAt: typeof f["updatedAt"] === "string" ? f["updatedAt"] : "",
    steps,
  };
}

// ---------------------------------------------------------------------------
// goals.yaml
// ---------------------------------------------------------------------------

function isGoalShape(value: unknown): value is Goal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["status"] === "string" &&
    ["open", "in_progress", "claimed", "proven"].includes(v["status"] as string)
  );
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/**
 * Construct a continuity store. Lazy: directories and files are created on
 * the first write. Reads never take the lock; every mutation runs under the
 * advisory `.lock` (§7.6) and lands via tmp+rename.
 */
export function createContinuityStore(opts: ContinuityStoreOptions): ContinuityStore {
  if (!opts.specName) {
    throw new ContinuityStoreError("specName is required");
  }
  if (!SPEC_NAME_REGEX.test(opts.specName) || /^\.+$/.test(opts.specName)) {
    throw new ContinuityStoreError(
      `invalid specName "${opts.specName}" — must match [a-zA-Z0-9_\\-.]+ and not be dots only`,
    );
  }
  const scope: ContinuityScope = opts.scope ?? { kind: "spec" };
  if (scope.kind === "session" && !SESSION_ID_REGEX.test(scope.sessionId)) {
    throw new ContinuityStoreError(
      `invalid scope.sessionId "${scope.sessionId}" — expected sess_<16 hex>`,
    );
  }

  const now = opts.now ?? (() => new Date());
  const focusMaxChars = opts.focusMaxChars ?? DEFAULT_FOCUS_MAX_CHARS;

  // Tenant fencing (§2.7): honor BOTH an explicit `tenant` option and the
  // ambient AsyncLocalStorage context, exactly like session-store — with a
  // tenant present, any resolved path outside the tenant's root fails closed
  // (CWE-1230). The fence root is the tenant's directory (the parent of its
  // sessionRoot), because state, trash, retention.json, and sessions all
  // live as siblings under it.
  function tenantRootOf(tenant: Tenant): string {
    return resolve(tenant.sessionRoot, "..");
  }
  function fence(absPath: string): string {
    if (opts.tenant !== undefined) assertSamePath(absPath, tenantRootOf(opts.tenant));
    const ctx = currentTenantContext();
    if (ctx !== undefined) assertSamePath(absPath, tenantRootOf(ctx.tenant));
    return absPath;
  }

  const constructionTenant = opts.tenant ?? currentTenantContext()?.tenant;
  const rootDir = resolve(
    opts.rootDir ??
      (constructionTenant !== undefined
        ? join(tenantRootOf(constructionTenant), "state")
        : DEFAULT_ROOT_DIR),
  );
  const crewhausDir = resolve(rootDir, "..");
  const storeDir =
    scope.kind === "session"
      ? join(rootDir, opts.specName, "sessions", scope.sessionId)
      : join(rootDir, opts.specName);
  const plansDir = join(storeDir, "plans");
  const focusPath = join(storeDir, "focus.md");
  const goalsPath = join(storeDir, "goals.yaml");
  const handoffPath = join(storeDir, "handoff.md");
  const lockPath = join(storeDir, ".lock");
  const retentionPath = join(crewhausDir, "retention.json");
  const sessionRootDir = resolve(opts.sessionRootDir ?? join(crewhausDir, "sessions"));
  // Fail closed at construction, not just on first I/O.
  fence(storeDir);

  async function writeAtomic(path: string, content: string): Promise<void> {
    fence(path);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, content, { mode: 0o600 });
    await rename(tmpPath, path);
  }

  async function readText(path: string): Promise<string | null> {
    fence(path);
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  function locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(fence(lockPath), fn, opts.lock ?? {});
  }

  // ---- focus internals ----

  const emptyFocus: FocusState = {
    body: "",
    activePlanId: null,
    requirements: [],
    ledgerTruncated: false,
  };

  async function readFocusState(): Promise<FocusState | null> {
    const raw = await readText(focusPath);
    if (raw === null) return null;
    return parseFocusFile(raw);
  }

  async function requireWritableFocus(): Promise<FocusState> {
    const raw = await readText(focusPath);
    if (raw === null) return emptyFocus;
    const parsed = parseFocusFile(raw);
    if (parsed === null) {
      throw new ContinuityStoreError(
        `continuity-store: ${focusPath} exists but is missing the "${FOCUS_MARKER}" marker — refusing to overwrite a user-authored file. Move it aside (or add the marker) to let crewhaus manage it.`,
      );
    }
    return parsed;
  }

  function capLedger(requirements: readonly Requirement[]): {
    requirements: readonly Requirement[];
    truncated: boolean;
  } {
    const kept = [...requirements];
    let truncated = false;
    const bytes = (): number =>
      Buffer.byteLength(kept.map(renderRequirementLine).join("\n"), "utf8");
    while (kept.length > 1 && bytes() > REQUIREMENTS_LEDGER_MAX_BYTES) {
      kept.shift(); // oldest-first eviction (§2.3)
      truncated = true;
    }
    return { requirements: kept, truncated };
  }

  async function writeFocusState(state: FocusState): Promise<void> {
    await writeAtomic(focusPath, renderFocusFile(state));
  }

  // ---- plan internals ----

  async function planFiles(): Promise<string[]> {
    fence(plansDir);
    let entries: string[];
    try {
      entries = await readdir(plansDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries.filter((e) => /^plan-\d{4}-.*\.md$/.test(e)).sort();
  }

  async function readPlans(): Promise<PlanRecord[]> {
    const files = await planFiles();
    const plans: PlanRecord[] = [];
    for (const file of files) {
      const raw = await readText(join(plansDir, file));
      if (raw === null) continue;
      plans.push(parsePlanFile(raw, join(plansDir, file)));
    }
    return plans;
  }

  async function planPathFor(planId: string): Promise<string | null> {
    const files = await planFiles();
    const match = files.find((f) => f.startsWith(`${planId}-`));
    return match !== undefined ? join(plansDir, match) : null;
  }

  async function readPlan(planId: string): Promise<{ plan: PlanRecord; path: string } | null> {
    if (!PLAN_ID_REGEX.test(planId)) {
      throw new ContinuityStoreError(`invalid planId "${planId}" — expected plan-NNNN`);
    }
    const path = await planPathFor(planId);
    if (path === null) return null;
    const raw = await readText(path);
    if (raw === null) return null;
    return { plan: parsePlanFile(raw, path), path };
  }

  async function requirePlan(planId: string): Promise<{ plan: PlanRecord; path: string }> {
    const found = await readPlan(planId);
    if (found === null) {
      throw new ContinuityStoreError(
        `continuity-store: no plan "${planId}" — create one first (PlanUpdate {action: "create"}).`,
      );
    }
    return found;
  }

  function requireStep(plan: PlanRecord, step: number): PlanStep {
    const found = plan.steps.find((s) => s.index === step);
    if (found === undefined) {
      throw new ContinuityStoreError(
        `continuity-store: ${plan.id} has no step ${step} (steps 1–${plan.steps.length}).`,
      );
    }
    return found;
  }

  async function writePlan(plan: PlanRecord): Promise<void> {
    const path = (await planPathFor(plan.id)) ?? join(plansDir, `${plan.id}-${plan.slug}.md`);
    await writeAtomic(path, renderPlanFile(plan));
  }

  function withStep(plan: PlanRecord, step: number, update: (s: PlanStep) => PlanStep): PlanRecord {
    return {
      ...plan,
      updatedAt: now().toISOString(),
      steps: plan.steps.map((s) => (s.index === step ? update(s) : s)),
    };
  }

  // ---- goal internals ----

  async function readGoals(): Promise<Goal[]> {
    const raw = await readText(goalsPath);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      throw new ContinuityStoreError(`continuity-store: ${goalsPath} is malformed YAML`, err);
    }
    const list = (parsed as { goals?: unknown } | null)?.goals;
    if (!Array.isArray(list)) return [];
    return list.filter(isGoalShape);
  }

  async function writeGoals(goals: readonly Goal[]): Promise<void> {
    await writeAtomic(goalsPath, YAML.stringify({ version: 1, goals }));
  }

  function nextId(prefix: string, existing: readonly string[], width = 4): string {
    let max = 0;
    for (const id of existing) {
      const n = Number(id.slice(prefix.length + 1));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return `${prefix}-${String(max + 1).padStart(width, "0")}`;
  }

  async function verify(refs: readonly EvidenceRef[]): Promise<readonly FrozenProof[]> {
    return verifyEvidence(refs, {
      sessionRootDir,
      ...(opts.sessionId !== undefined ? { defaultSessionId: opts.sessionId } : {}),
      now,
    });
  }

  function mergeProofs(
    existing: readonly FrozenProof[],
    incoming: readonly FrozenProof[],
  ): readonly FrozenProof[] {
    const seen = new Set(existing.map((p) => p.toolUseId));
    return [...existing, ...incoming.filter((p) => !seen.has(p.toolUseId))];
  }

  async function gatherHandoffInput(lastSessionId?: string) {
    const focus = (await readFocusState()) ?? emptyFocus;
    const plans = await readPlans();
    const activePlan =
      focus.activePlanId !== null ? (plans.find((p) => p.id === focus.activePlanId) ?? null) : null;
    const goals = await readGoals();
    return {
      focusBody: focus.body,
      activePlan,
      plans,
      goals,
      requirements: focus.requirements,
      ...(lastSessionId !== undefined ? { lastSessionId } : {}),
    };
  }

  return {
    dir(): string {
      return storeDir;
    },

    async readFocus(): Promise<FocusState | null> {
      return readFocusState();
    },

    async writeFocus(body: string): Promise<void> {
      if (body.length > focusMaxChars) {
        throw new ContinuityStoreError(
          `continuity-store: focus body is ${body.length} chars — the cap is ${focusMaxChars} (focusMaxChars). Keep focus.md short; details belong in plan steps.`,
        );
      }
      await locked(async () => {
        const state = await requireWritableFocus();
        await writeFocusState({ ...state, body: body.trim() });
      });
    },

    async setActivePlan(planId: string | null): Promise<void> {
      if (planId !== null) await requirePlan(planId);
      await locked(async () => {
        const state = await requireWritableFocus();
        await writeFocusState({ ...state, activePlanId: planId });
      });
    },

    async appendRequirement(input: AppendRequirementInput): Promise<Requirement> {
      if (input.text.trim() === "") {
        throw new ContinuityStoreError("appendRequirement(): text must be non-empty (verbatim)");
      }
      if (!SESSION_ID_REGEX.test(input.source.sessionId)) {
        throw new ContinuityStoreError(
          `appendRequirement(): invalid source.sessionId "${input.source.sessionId}" — expected sess_<16 hex>`,
        );
      }
      if (input.id !== undefined && !REQ_ID_REGEX.test(input.id)) {
        throw new ContinuityStoreError(
          `appendRequirement(): invalid id "${input.id}" — expected REQ-nnn`,
        );
      }
      return locked(async () => {
        const state = await requireWritableFocus();
        const requirements = [...state.requirements];
        let entry: Requirement;
        const existingIdx =
          input.id !== undefined ? requirements.findIndex((r) => r.id === input.id) : -1;
        if (existingIdx >= 0) {
          const existing = requirements[existingIdx] as Requirement;
          if (existing.text !== input.text) {
            throw new ContinuityStoreError(
              `appendRequirement(): ${existing.id} already exists with different text — the ledger is verbatim-only; append a NEW requirement instead of paraphrasing an old one.`,
            );
          }
          entry = { ...existing, status: input.status ?? existing.status };
          requirements[existingIdx] = entry;
        } else {
          const id =
            input.id ??
            nextId(
              "REQ",
              requirements.map((r) => r.id),
              3,
            );
          entry = {
            id,
            text: input.text,
            status: input.status ?? "open",
            source: { sessionId: input.source.sessionId, turn: input.source.turn },
          };
          requirements.push(entry);
        }
        const capped = capLedger(requirements);
        await writeFocusState({
          ...state,
          requirements: capped.requirements,
          ledgerTruncated: state.ledgerTruncated || capped.truncated,
        });
        return entry;
      });
    },

    async listRequirements(): Promise<readonly Requirement[]> {
      return (await readFocusState())?.requirements ?? [];
    },

    async createPlan(input: { title: string; steps?: readonly string[] }): Promise<PlanRecord> {
      if (input.title.trim() === "") {
        throw new ContinuityStoreError("createPlan(): title must be non-empty");
      }
      return locked(async () => {
        const existing = await readPlans();
        const id = nextId(
          "plan",
          existing.map((p) => p.id),
        );
        const iso = now().toISOString();
        const plan: PlanRecord = {
          id,
          slug: slugify(input.title),
          title: input.title.trim(),
          createdAt: iso,
          updatedAt: iso,
          steps: (input.steps ?? []).map((text, i) => ({
            index: i + 1,
            text: text.replace(/\s+/g, " ").trim(),
            status: "open" as const,
            proofs: [],
          })),
        };
        await writePlan(plan);
        // First plan becomes the active plan (the §2.2 pointer) so PlanRead
        // and the handoff have a default without an extra tool call.
        const focus = await requireWritableFocus();
        if (focus.activePlanId === null) {
          await writeFocusState({ ...focus, activePlanId: id });
        }
        return plan;
      });
    },

    async getPlan(planId: string): Promise<PlanRecord | null> {
      return (await readPlan(planId))?.plan ?? null;
    },

    async listPlans(): Promise<readonly PlanRecord[]> {
      return readPlans();
    },

    async getActivePlan(): Promise<PlanRecord | null> {
      const focus = await readFocusState();
      if (focus === null || focus.activePlanId === null) return null;
      return (await readPlan(focus.activePlanId))?.plan ?? null;
    },

    async addStep(planId: string, text: string): Promise<PlanRecord> {
      if (text.trim() === "") {
        throw new ContinuityStoreError("addStep(): text must be non-empty");
      }
      return locked(async () => {
        const { plan } = await requirePlan(planId);
        const next: PlanRecord = {
          ...plan,
          updatedAt: now().toISOString(),
          steps: [
            ...plan.steps,
            {
              index: plan.steps.length + 1,
              text: text.replace(/\s+/g, " ").trim(),
              status: "open",
              proofs: [],
            },
          ],
        };
        await writePlan(next);
        return next;
      });
    },

    async setStepStatus(
      planId: string,
      step: number,
      status: ClaimableStatus,
    ): Promise<PlanRecord> {
      if (!["open", "in_progress", "claimed"].includes(status)) {
        throw new ContinuityStoreError(
          `setStepStatus(): "${status}" is not claimable — the proven transition requires evidence; use proveStep() (PlanComplete).`,
        );
      }
      return locked(async () => {
        const { plan } = await requirePlan(planId);
        requireStep(plan, step);
        const next = withStep(plan, step, (s) => ({ ...s, status }));
        await writePlan(next);
        return next;
      });
    },

    async proveStep(
      planId: string,
      step: number,
      evidence: readonly EvidenceRef[],
    ): Promise<PlanRecord> {
      // Verify BEFORE taking the lock — verification reads foreign session
      // logs and can be slow; the store lock protects only our own writes.
      const { plan: preflight } = await requirePlan(planId);
      requireStep(preflight, step);
      const proofs = await verify(evidence);
      return locked(async () => {
        const { plan } = await requirePlan(planId);
        const current = requireStep(plan, step);
        const next = withStep(plan, step, (s) => ({
          ...s,
          status: "proven",
          proofs: mergeProofs(current.proofs, proofs),
        }));
        await writePlan(next);
        // Proof lifetime (§2.4): pin every cited session so TTL eviction
        // cannot orphan a live proven record.
        await appendRetentionPins(
          proofs.map((p) => p.sessionId),
          fence(retentionPath),
        );
        return next;
      });
    },

    async writeGoal(input: {
      title: string;
      target?: number;
      current?: number;
      unit?: string;
    }): Promise<Goal> {
      if (input.title.trim() === "") {
        throw new ContinuityStoreError("writeGoal(): title must be non-empty");
      }
      return locked(async () => {
        const goals = await readGoals();
        const iso = now().toISOString();
        const goal: Goal = {
          id: nextId(
            "goal",
            goals.map((g) => g.id),
          ),
          title: input.title.trim(),
          status: "open",
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.current !== undefined ? { current: input.current } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          createdAt: iso,
          updatedAt: iso,
        };
        await writeGoals([...goals, goal]);
        return goal;
      });
    },

    async updateGoal(goalId: string, patch: UpdateGoalInput): Promise<Goal> {
      if (!GOAL_ID_REGEX.test(goalId)) {
        throw new ContinuityStoreError(`invalid goalId "${goalId}" — expected goal-NNNN`);
      }
      // The proven transition is machine-checked for goals exactly like plan
      // steps (§2.4: plan steps AND goals carry the ladder).
      let proofs: readonly FrozenProof[] = [];
      if (patch.status === "proven") {
        if (patch.evidence === undefined || patch.evidence.length === 0) {
          throw new ContinuityStoreError(
            `continuity-store: marking ${goalId} proven requires evidence — run the action first, then cite its toolUseId(s).`,
          );
        }
        proofs = await verify(patch.evidence);
      }
      return locked(async () => {
        const goals = await readGoals();
        const idx = goals.findIndex((g) => g.id === goalId);
        if (idx < 0) {
          throw new ContinuityStoreError(`continuity-store: no goal "${goalId}"`);
        }
        const existing = goals[idx] as Goal;
        const mergedProofs =
          proofs.length > 0 ? mergeProofs(existing.proofs ?? [], proofs) : existing.proofs;
        const next: Goal = {
          ...existing,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.target !== undefined ? { target: patch.target } : {}),
          ...(patch.current !== undefined ? { current: patch.current } : {}),
          ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
          ...(mergedProofs !== undefined ? { proofs: mergedProofs } : {}),
          updatedAt: now().toISOString(),
        };
        const nextGoals = [...goals];
        nextGoals[idx] = next;
        await writeGoals(nextGoals);
        if (proofs.length > 0) {
          await appendRetentionPins(
            proofs.map((p) => p.sessionId),
            fence(retentionPath),
          );
        }
        return next;
      });
    },

    async listGoals(): Promise<readonly Goal[]> {
      return readGoals();
    },

    async verifyEvidence(refs: readonly EvidenceRef[]): Promise<readonly FrozenProof[]> {
      return verify(refs);
    },

    async renderHandoff(handoffOpts: { lastSessionId?: string } = {}): Promise<string> {
      return renderHandoff(await gatherHandoffInput(handoffOpts.lastSessionId));
    },

    async writeHandoff(handoffOpts: { lastSessionId?: string } = {}): Promise<string> {
      const rendered = renderHandoff(await gatherHandoffInput(handoffOpts.lastSessionId));
      await locked(async () => {
        const existing = await readText(handoffPath);
        if (existing !== null && !existing.trimStart().startsWith(HANDOFF_MARKER)) {
          throw new ContinuityStoreError(
            `continuity-store: ${handoffPath} exists but is missing the "${HANDOFF_MARKER}" marker — refusing to overwrite a user-authored file.`,
          );
        }
        await writeAtomic(handoffPath, rendered);
      });
      return handoffPath;
    },

    async clear(clearScope: ClearScope): Promise<MoveToTrashResult> {
      const targets: Record<ClearScope, string[]> = {
        focus: [focusPath],
        plans: [plansDir],
        goals: [goalsPath],
        all: [focusPath, plansDir, goalsPath, handoffPath],
      };
      return locked(async () => moveToTrash(targets[clearScope], fence(crewhausDir), { now }));
    },

    async restore(ts: string): Promise<RestoreResult> {
      return locked(async () => restoreFromTrash(ts, fence(crewhausDir)));
    },

    async listTrash(): Promise<readonly TrashSnapshot[]> {
      return listTrashDir(fence(crewhausDir));
    },
  };
}
