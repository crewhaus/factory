/**
 * `@crewhaus/continuity-store/erasure`: removing what conversations left in working memory,
 * driven only by the erasure door. Clearing moves files to the trash; these do not, so they
 * act only on a grant the door minted: one whose scope is this store's own root and that
 * names the snapshot or the sessions.
 *
 * - {@link purgeTrashSnapshot} removes one trash snapshot now, before its undo window ends.
 * - {@link purgeSessions} removes the named conversations' own state, the requirements they
 *   asked for, and the frozen proof excerpts that quote them, and the rendered `handoff.md`
 *   of each scope it changed (the store renders it again). A step proven by such an excerpt
 *   keeps its status and has no proof on record.
 *
 * Each path is resolved inside its root before anything is unlinked, each scope is changed
 * under its own lock, and a re-run finds nothing.
 */
import {
  type Stats,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { SESSION_ID_RE } from "@crewhaus/control-contract";
import { type ErasureGrant, erasureTargets } from "@crewhaus/control-contract/knowledge";
import { openForReadSync, resolveContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import YAML from "yaml";
import { NONE_LINE, REQUIREMENTS_MARKER, REQ_LINE_REGEX } from "./focus-format";
import {
  ContinuityStoreError,
  FOCUS_MARKER,
  HANDOFF_MARKER,
  STATE_FILE_MAX_BYTES,
  TRASH_DIR_NAME,
  listTrash,
  parseTrashTimestamp,
  withLock,
} from "./index";

/** The store a session purge acts on: the state root (`.crewhaus/state`) and a spec. */
export type ContinuityErasureAt = { readonly rootDir: string; readonly specName: string };

export type ContinuityErasure = {
  /** Conversations whose own state was removed. */
  readonly sessions: number;
  readonly requirements: number;
  readonly proofs: number;
};

const SPEC_NAME_RE = /^[a-zA-Z0-9_\-.]+$/;
const PLAN_FILE_RE = /^plan-\d{4}-.*\.md$/;

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** What is at `rel` inside `root`; `undefined` when nothing is, a throw when it leads out. */
function found(
  root: string,
  rel: string,
): { readonly real: string; readonly stats: Stats } | undefined {
  const at = resolveContained(root, rel, { followLeaf: false });
  if (!at.ok) {
    if (at.code === "not-found") return undefined;
    throw new ContinuityStoreError(`continuity-store: refusing to erase ${rel}: ${at.reason}`);
  }
  try {
    return { real: at.real, stats: lstatSync(at.real) };
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Remove a directory that is really one, with everything in it. */
function removeDirectory(root: string, rel: string): boolean {
  const at = found(root, rel);
  if (at === undefined) return false;
  if (!at.stats.isDirectory()) {
    throw new ContinuityStoreError(
      `continuity-store: refusing to erase ${rel}: it is not a directory`,
    );
  }
  rmSync(at.real, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

/** Remove one trash snapshot for good. `false` when it is not there any more. */
export async function purgeTrashSnapshot(
  crewhausDir: string,
  stamp: string,
  grant: ErasureGrant,
): Promise<boolean> {
  const root = resolve(crewhausDir);
  const targets = erasureTargets(grant, {
    store: "trash",
    sameRoot: (given) => sameDir(given, root),
  });
  if (targets === undefined) {
    throw new ContinuityStoreError("continuity-store: this erasure does not cover this trash");
  }
  if (parseTrashTimestamp(stamp) === null || !targets.has(stamp)) {
    throw new ContinuityStoreError(
      "continuity-store: this erasure does not name the snapshot it was given",
    );
  }
  return removeDirectory(root, join(TRASH_DIR_NAME, stamp));
}

/** The trash snapshots that hold something from one of these conversations. Reads only. */
export async function trashHolding(
  crewhausDir: string,
  sessions: readonly string[],
): Promise<readonly string[]> {
  if (sessions.length === 0) return [];
  const root = resolve(crewhausDir);
  const out: string[] = [];
  for (const snapshot of await listTrash(root)) {
    const holds = snapshot.files.some((file) => {
      if (sessions.some((id) => file.includes(id))) return true;
      const text = readText(root, join(TRASH_DIR_NAME, snapshot.ts, file));
      return text !== undefined && sessions.some((id) => text.includes(id));
    });
    if (holds) out.push(snapshot.ts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function readText(root: string, rel: string): string | undefined {
  const read = openForReadSync(root, rel, {
    maxBytes: STATE_FILE_MAX_BYTES,
    followLeafSymlink: false,
  });
  return read.ok && !read.truncated ? read.text : undefined;
}

function write(root: string, rel: string, text: string): void {
  const written = writeFileSafe(root, rel, text, { overwrite: true, mode: 0o600 });
  if (!written.ok) {
    throw new ContinuityStoreError(`continuity-store: refusing to write ${rel}: ${written.reason}`);
  }
}

/** `focus.md` without the requirements these conversations asked for, or `undefined` when none. */
function withoutRequirements(
  text: string,
  sessions: ReadonlySet<string>,
): { readonly text: string; readonly removed: number } | undefined {
  if (!text.trimStart().startsWith(FOCUS_MARKER)) return undefined;
  const lines = text.split("\n");
  // The last marker is the store's own: the body above it is model-written.
  const marker = lines.findLastIndex((line) => line.trim() === REQUIREMENTS_MARKER);
  if (marker === -1) return undefined;
  const ledger = lines.slice(marker + 1);
  const kept = ledger.filter((line) => {
    const session = REQ_LINE_REGEX.exec(line.trim())?.[4];
    return session === undefined || !sessions.has(session);
  });
  const removed = ledger.length - kept.length;
  if (removed === 0) return undefined;
  const any = kept.some((line) => REQ_LINE_REGEX.test(line.trim()));
  const tail = any ? kept : [NONE_LINE, ...kept.filter((line) => line.trim() === "")];
  return { text: [...lines.slice(0, marker + 1), ...tail].join("\n"), removed };
}

/** A proof list without the excerpts frozen from these conversations. */
function withoutProofs(
  list: unknown,
  sessions: ReadonlySet<string>,
): { readonly kept: unknown[]; readonly removed: number } {
  if (!Array.isArray(list)) return { kept: [], removed: 0 };
  const kept = list.filter((proof) => {
    const session = (proof as { sessionId?: unknown } | null)?.sessionId;
    return typeof session !== "string" || !sessions.has(session);
  });
  return { kept, removed: list.length - kept.length };
}

/** A plan file without those excerpts, or `undefined` when it has none. */
function planWithoutProofs(
  text: string,
  sessions: ReadonlySet<string>,
): { readonly text: string; readonly removed: number } | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match === null) return undefined;
  let front: unknown;
  try {
    front = YAML.parse(match[1] as string);
  } catch {
    return undefined;
  }
  if (typeof front !== "object" || front === null) return undefined;
  const record = front as Record<string, unknown>;
  if (typeof record["proofs"] !== "object" || record["proofs"] === null) return undefined;
  let removed = 0;
  const proofs: Record<string, unknown[]> = {};
  for (const [step, list] of Object.entries(record["proofs"] as Record<string, unknown>)) {
    const left = withoutProofs(list, sessions);
    removed += left.removed;
    if (left.kept.length > 0) proofs[step] = left.kept;
  }
  if (removed === 0) return undefined;
  const { proofs: _proofs, ...rest } = record;
  const next = Object.keys(proofs).length > 0 ? { ...record, proofs } : rest;
  return {
    text: `---\n${YAML.stringify(next).trimEnd()}\n---\n${text.slice(match[0].length)}`,
    removed,
  };
}

/** `goals.yaml` without those excerpts, or `undefined` when it has none. */
function goalsWithoutProofs(
  text: string,
  sessions: ReadonlySet<string>,
): { readonly text: string; readonly removed: number } | undefined {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return undefined;
  }
  const goals = (parsed as { goals?: unknown } | null)?.goals;
  if (!Array.isArray(goals)) return undefined;
  let removed = 0;
  const next = goals.map((goal) => {
    if (typeof goal !== "object" || goal === null || !("proofs" in goal)) return goal;
    const { proofs, ...rest } = goal as Record<string, unknown>;
    const left = withoutProofs(proofs, sessions);
    removed += left.removed;
    return left.kept.length > 0 ? { ...rest, proofs: left.kept } : rest;
  });
  if (removed === 0) return undefined;
  return { text: YAML.stringify({ ...(parsed as object), goals: next }), removed };
}

/** The directories that hold a scope's state: the spec's own, and each conversation's. */
function scopeDirs(specDir: string): { readonly sessions: string[]; readonly dirs: string[] } {
  let sessions: string[] = [];
  const at = found(specDir, "sessions");
  if (at?.stats.isDirectory() === true) {
    sessions = readdirSync(at.real, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }
  return { sessions, dirs: ["", ...sessions.map((id) => join("sessions", id))] };
}

/** The changes one scope needs, each a whole file. */
function scopeEdits(
  scopeDir: string,
  sessions: ReadonlySet<string>,
): {
  readonly files: readonly { readonly rel: string; readonly text: string }[];
  readonly requirements: number;
  readonly proofs: number;
  /** Whether the rendered handoff names one of them. */
  readonly handoff: boolean;
} {
  const files: { rel: string; text: string }[] = [];
  let requirements = 0;
  let proofs = 0;
  const focus = readText(scopeDir, "focus.md");
  const nextFocus = focus === undefined ? undefined : withoutRequirements(focus, sessions);
  if (nextFocus !== undefined) {
    files.push({ rel: "focus.md", text: nextFocus.text });
    requirements += nextFocus.removed;
  }
  const plans = found(scopeDir, "plans");
  if (plans?.stats.isDirectory() === true) {
    for (const name of readdirSync(plans.real).sort()) {
      if (!PLAN_FILE_RE.test(name)) continue;
      const rel = join("plans", name);
      const text = readText(scopeDir, rel);
      const next = text === undefined ? undefined : planWithoutProofs(text, sessions);
      if (next === undefined) continue;
      files.push({ rel, text: next.text });
      proofs += next.removed;
    }
  }
  const goals = readText(scopeDir, "goals.yaml");
  const nextGoals = goals === undefined ? undefined : goalsWithoutProofs(goals, sessions);
  if (nextGoals !== undefined) {
    files.push({ rel: "goals.yaml", text: nextGoals.text });
    proofs += nextGoals.removed;
  }
  const handoff = readText(scopeDir, "handoff.md");
  return {
    files,
    requirements,
    proofs,
    handoff:
      handoff?.trimStart().startsWith(HANDOFF_MARKER) === true &&
      (files.length > 0 || [...sessions].some((id) => handoff.includes(id))),
  };
}

function specDirOf(at: ContinuityErasureAt): string {
  if (!SPEC_NAME_RE.test(at.specName) || /^\.+$/.test(at.specName)) {
    throw new ContinuityStoreError(`invalid specName "${at.specName}"`);
  }
  return resolve(at.rootDir, at.specName);
}

/** What these conversations left in this spec's working memory. Reads only. */
export function stateFromSessions(
  at: ContinuityErasureAt,
  sessions: readonly string[],
): ContinuityErasure {
  const wanted = new Set(sessions);
  const specDir = specDirOf(at);
  if (!existsSync(specDir)) return { sessions: 0, requirements: 0, proofs: 0 };
  const scopes = scopeDirs(specDir);
  let requirements = 0;
  let proofs = 0;
  for (const dir of scopes.dirs) {
    if (wanted.has(dir.slice("sessions/".length))) continue;
    const edits = scopeEdits(join(specDir, dir), wanted);
    requirements += edits.requirements;
    proofs += edits.proofs;
  }
  return { sessions: scopes.sessions.filter((id) => wanted.has(id)).length, requirements, proofs };
}

/** Remove what these conversations left in this spec's working memory. */
export async function purgeSessions(
  at: ContinuityErasureAt,
  ids: readonly string[],
  grant: ErasureGrant,
): Promise<ContinuityErasure> {
  const root = resolve(at.rootDir);
  const specDir = specDirOf(at);
  const targets = erasureTargets(grant, {
    store: "continuity",
    spec: at.specName,
    sameRoot: (given) => sameDir(given, root),
  });
  if (targets === undefined) {
    throw new ContinuityStoreError(
      "continuity-store: this erasure does not cover this spec's working memory",
    );
  }
  for (const id of ids) {
    if (!SESSION_ID_RE.test(id) || !targets.has(id)) {
      throw new ContinuityStoreError(
        "continuity-store: this erasure does not name every conversation it was given",
      );
    }
  }
  const wanted = new Set(ids);
  // The spec's directory may itself be a link (state kept on another disk); what is
  // contained is everything below it.
  if (wanted.size === 0 || !existsSync(specDir)) {
    return { sessions: 0, requirements: 0, proofs: 0 };
  }
  let sessions = 0;
  for (const id of wanted) {
    if (removeDirectory(specDir, join("sessions", id))) sessions += 1;
  }
  let requirements = 0;
  let proofs = 0;
  for (const dir of scopeDirs(specDir).dirs) {
    const scopeDir = join(specDir, dir);
    const before = scopeEdits(scopeDir, wanted);
    if (before.files.length === 0 && !before.handoff) continue;
    await withLock(join(scopeDir, ".lock"), async () => {
      const edits = scopeEdits(scopeDir, wanted);
      for (const { rel, text } of edits.files) write(scopeDir, rel, text);
      if (edits.handoff) {
        const handoff = found(scopeDir, "handoff.md");
        if (handoff?.stats.isFile() === true) unlinkSync(handoff.real);
      }
      requirements += edits.requirements;
      proofs += edits.proofs;
    });
  }
  return { sessions, requirements, proofs };
}
