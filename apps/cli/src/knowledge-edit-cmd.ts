/**
 * The verbs a person uses to correct what a harness knows, without rewriting
 * its history:
 *
 *   crewhaus memory correct <mem_id> (--text "<t>" | --text-file <f>) --reason "<r>"
 *   crewhaus memory mark <mem_id> (--personal | --not-personal)
 *   crewhaus wiki write <slug> --body-file <f> --expect <v> [--title <t>]
 *   crewhaus wiki archive <slug> --expect <v> [--undo]
 *   crewhaus wiki rollback <slug> --to <n> --expect <current>
 *   crewhaus state clear --scope focus|plans|goals|all [--session <sess>] [--yes] [--expect <fp>]
 *   crewhaus state trash
 *   crewhaus state restore --trash <stamp>
 *   crewhaus lessons retire <lesson> [--reason "<r>"]
 *
 * A correction keeps the old fact as history, a wiki edit is a new version
 * marked as a person's, an archive changes only the status, and a clear moves
 * files to the trash after a dry run that names them. Each verb takes the
 * parsed arguments and an injected `{cwd, stdout, now, confirm}`, and answers
 * an exit code; a bad argument or a refusal throws {@link KnowledgeEditError},
 * which the entry file routes through `die()`. Side-effect-free on import: the
 * entry file `index.ts` runs an argv switch and cannot be imported by a test.
 *
 * No actor is stamped yet: the CLI records `author: {kind: "operator", via: "cli"}`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClearScope,
  ContinuityClearConflictError,
  type ContinuityScope,
  TRASH_PURGE_AFTER_MS,
  TrashError,
  createContinuityStore,
  listTrash,
  restoreFromTrash,
} from "@crewhaus/continuity-store";
import { harnessSpecName } from "@crewhaus/harness-lifecycle/knowledge-sync";
import type { ParsedArgs } from "@crewhaus/infra-utils";
import {
  MemoryNotLiveError,
  createMemoryStore,
  isMemoryEntryId,
  isMemorySpecName,
} from "@crewhaus/memory-store";
import { SESSION_ID_RE } from "@crewhaus/session-store";
import { appendContained, ensureDirContained } from "@crewhaus/tool-safety/fs";
import { WikiStoreError, WikiVersionConflictError, createWikiStore } from "@crewhaus/wiki-store";
import { type Lesson, parseLessonsMd, renderLessonsMd } from "./lessons";
import { MEMORIES_SUBDIR, resolveMemorySpec } from "./memory-cli";
import { WIKI_SUBDIR, listWikiSpecs, resolveWikiSpec } from "./wiki-cli";

/** A bad argument or a refusal: the entry file prints it and exits 1. */
export class KnowledgeEditError extends Error {
  override readonly name = "KnowledgeEditError";
}

export type KnowledgeEditIo = {
  /** The harness directory the verb works in. */
  readonly cwd: string;
  /** One line of output, without its newline. */
  readonly stdout: (line: string) => void;
  readonly now: () => Date;
  /** Ask a yes/no question; the entry file refuses outside a terminal without --yes. */
  readonly confirm: (prompt: string) => Promise<boolean>;
};

/** 0 when the verb did what it was asked (or nothing, when asked for a dry run); 1 on a conflict. */
export type KnowledgeEditExit = 0 | 1;

const CLI_AUTHOR = { kind: "operator", via: "cli" } as const;

function str(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

function oneLine(text: string, max = 100): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A whole number at least `min`, from a flag, or a refusal naming the flag. */
function wholeFlag(args: ParsedArgs, name: string, verb: string, min: number): number {
  const raw = str(args, name);
  if (raw === undefined) throw new KnowledgeEditError(`${verb}: --${name} <n> is required`);
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new KnowledgeEditError(`${verb}: --${name} must be a whole number of at least ${min}`);
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

function memoriesDir(io: KnowledgeEditIo): string {
  return join(io.cwd, MEMORIES_SUBDIR);
}

function factId(args: ParsedArgs, verb: string): string {
  const id = args.positional[1];
  if (id === undefined) throw new KnowledgeEditError(`usage: crewhaus memory ${verb} <mem_id> …`);
  if (!isMemoryEntryId(id)) {
    throw new KnowledgeEditError(
      `memory ${verb}: "${id}" is not a fact id (mem_ and 16 hex digits)`,
    );
  }
  return id;
}

/** `crewhaus memory correct`: replace a wrong fact with the right one; the old fact stays in history. */
export async function runMemoryCorrect(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const id = factId(args, "correct");
  const text = str(args, "text");
  const textFile = str(args, "text-file");
  if ((text === undefined) === (textFile === undefined)) {
    throw new KnowledgeEditError(
      "memory correct: give the new text with exactly one of --text or --text-file",
    );
  }
  const reason = str(args, "reason")?.trim();
  if (reason === undefined || reason === "") {
    throw new KnowledgeEditError(
      'memory correct: --reason "<why>" is required, so the history says why',
    );
  }
  let next: string;
  if (textFile !== undefined) {
    try {
      next = readFileSync(join(io.cwd, textFile), "utf-8").trim();
    } catch (err) {
      throw new KnowledgeEditError(
        `memory correct: could not read ${textFile}: ${(err as Error).message}`,
      );
    }
  } else {
    next = (text as string).trim();
  }
  if (next === "") throw new KnowledgeEditError("memory correct: the new text is empty");
  const spec = resolveMemorySpec(memoriesDir(io), str(args, "spec"));
  const store = createMemoryStore({ specName: spec, rootDir: memoriesDir(io), now: io.now });
  const item = (await store.list()).find((i) => i.entry.id === id);
  if (item === undefined) throw new KnowledgeEditError(`memory correct: no fact ${id} in ${spec}`);
  if (item.status !== "live") {
    throw new KnowledgeEditError(
      `memory correct: ${id} is ${item.status}${item.entry.supersededBy !== undefined ? `, replaced by ${item.entry.supersededBy}` : ""}; correct the live fact instead`,
    );
  }
  io.stdout(`[memory] ${spec}: correct ${id}`);
  io.stdout(`  old: ${oneLine(item.entry.text)}`);
  io.stdout(`  new: ${oneLine(next)}`);
  if (
    !flag(args, "yes") &&
    !(await io.confirm("Replace this fact? The old one stays in history. [y/N] "))
  ) {
    io.stdout("[memory] nothing changed");
    return 0;
  }
  try {
    const { successor } = await store.supersede(id, next, { reason, author: CLI_AUTHOR });
    io.stdout(`[memory] corrected ${id} → ${successor.id}; the old fact stays in history`);
    return 0;
  } catch (err) {
    if (err instanceof MemoryNotLiveError)
      throw new KnowledgeEditError(`memory correct: ${err.message}`);
    throw err;
  }
}

/** `crewhaus memory mark`: mark a fact as about a person, or clear the mark. */
export async function runMemoryMark(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const id = factId(args, "mark");
  const personal = flag(args, "personal");
  const notPersonal = flag(args, "not-personal");
  if (personal === notPersonal) {
    throw new KnowledgeEditError("memory mark: give exactly one of --personal or --not-personal");
  }
  const spec = resolveMemorySpec(memoriesDir(io), str(args, "spec"));
  const store = createMemoryStore({ specName: spec, rootDir: memoriesDir(io), now: io.now });
  if (!(await store.list()).some((i) => i.entry.id === id)) {
    throw new KnowledgeEditError(`memory mark: no fact ${id} in ${spec}`);
  }
  await store.annotate(id, { category: personal ? "person" : null });
  io.stdout(
    personal
      ? `[memory] ${id} is marked personal; a knowledge sync does not share it`
      : `[memory] ${id} is not marked personal`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// wiki
// ---------------------------------------------------------------------------

function wikiDir(io: KnowledgeEditIo): string {
  return join(io.cwd, WIKI_SUBDIR);
}

function slugOf(args: ParsedArgs, verb: string): string {
  const slug = args.positional[1];
  if (slug === undefined) throw new KnowledgeEditError(`usage: crewhaus wiki ${verb} <slug> …`);
  return slug;
}

/**
 * Which wiki a write lands in: `--spec`, else the one wiki there is, else the
 * spec this harness's `crewhaus.yaml` names, so the first article of a new
 * wiki needs no flag.
 */
function writeSpec(io: KnowledgeEditIo, specFlag: string | undefined): string {
  if (specFlag !== undefined) {
    if (!isMemorySpecName(specFlag)) {
      throw new KnowledgeEditError(`wiki write: "${specFlag}" is not a spec name`);
    }
    return specFlag;
  }
  const specs = listWikiSpecs(wikiDir(io));
  if (specs.length === 1) return specs[0] as string;
  if (specs.length > 1) return resolveWikiSpec(wikiDir(io), undefined);
  const named = harnessSpecName(io.cwd);
  if (named === undefined) {
    throw new KnowledgeEditError(
      "wiki write: no wiki here yet and no crewhaus.yaml names the spec; pass --spec <name>",
    );
  }
  return named;
}

function conflictLines(verb: string, slug: string, err: WikiVersionConflictError): string[] {
  return err.currentVersion === undefined
    ? [`[wiki] ${verb} refused: there is no article "${slug}"; create it with --expect 0`]
    : [
        `[wiki] ${verb} refused: "${slug}" is at version ${err.currentVersion}, not ${err.expectedVersion ?? "(none)"}. Nothing was written.`,
        `  Read it with crewhaus wiki show ${slug}, then pass --expect ${err.currentVersion}.`,
      ];
}

/** `crewhaus wiki write`: a person's new version of an article (`--expect 0` creates it). */
export async function runWikiWrite(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const slug = slugOf(args, "write");
  const bodyFile = str(args, "body-file");
  if (bodyFile === undefined)
    throw new KnowledgeEditError("wiki write: --body-file <file> is required");
  const expect = wholeFlag(args, "expect", "wiki write", 0);
  let body: string;
  try {
    body = readFileSync(join(io.cwd, bodyFile), "utf-8");
  } catch (err) {
    throw new KnowledgeEditError(
      `wiki write: could not read ${bodyFile}: ${(err as Error).message}`,
    );
  }
  const spec = writeSpec(io, str(args, "spec"));
  const store = createWikiStore({ specName: spec, rootDir: wikiDir(io), now: io.now });
  const current = await store.get(slug);
  const title = str(args, "title") ?? current?.title;
  if (title === undefined || title.trim() === "") {
    throw new KnowledgeEditError("wiki write: --title <t> is required to create an article");
  }
  try {
    const result = await store.write({
      slug,
      title,
      body,
      ...(expect > 0 ? { expectedVersion: expect } : {}),
      author: CLI_AUTHOR,
    });
    io.stdout(
      result.version === 1
        ? `[wiki] ${spec}: created "${slug}" at v1`
        : `[wiki] ${spec}: wrote "${slug}" as v${result.version}; v${result.version - 1} is kept`,
    );
    return 0;
  } catch (err) {
    if (err instanceof WikiVersionConflictError) {
      for (const line of conflictLines("write", slug, err)) io.stdout(line);
      return 1;
    }
    if (err instanceof WikiStoreError) throw new KnowledgeEditError(`wiki write: ${err.message}`);
    throw err;
  }
}

/** `crewhaus wiki archive`: archive an article, or with `--undo` publish it again. Status only. */
export async function runWikiArchive(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const slug = slugOf(args, "archive");
  const expect = wholeFlag(args, "expect", "wiki archive", 1);
  const spec = resolveWikiSpec(wikiDir(io), str(args, "spec"));
  const store = createWikiStore({ specName: spec, rootDir: wikiDir(io), now: io.now });
  const status = flag(args, "undo") ? "published" : "archived";
  try {
    await store.setStatus(slug, status, { expectedVersion: expect });
  } catch (err) {
    if (err instanceof WikiVersionConflictError) {
      for (const line of conflictLines("archive", slug, err)) io.stdout(line);
      return 1;
    }
    if (err instanceof WikiStoreError) throw new KnowledgeEditError(`wiki archive: ${err.message}`);
    throw err;
  }
  io.stdout(`[wiki] ${spec}: "${slug}" is ${status}; its text and version are unchanged`);
  return 0;
}

/** `crewhaus wiki rollback`: a new version with the text of an older one. Nothing is deleted. */
export async function runWikiRollback(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const slug = slugOf(args, "rollback");
  const to = wholeFlag(args, "to", "wiki rollback", 1);
  const expect = wholeFlag(args, "expect", "wiki rollback", 1);
  const spec = resolveWikiSpec(wikiDir(io), str(args, "spec"));
  const store = createWikiStore({ specName: spec, rootDir: wikiDir(io), now: io.now });
  const current = await store.get(slug);
  if (current === null)
    throw new KnowledgeEditError(`wiki rollback: no article "${slug}" in ${spec}`);
  if (current.version !== expect) {
    for (const line of conflictLines(
      "rollback",
      slug,
      new WikiVersionConflictError(slug, expect, current.version),
    )) {
      io.stdout(line);
    }
    return 1;
  }
  if (to === current.version) {
    throw new KnowledgeEditError(
      `wiki rollback: "${slug}" is already at v${current.version}; nothing to roll back`,
    );
  }
  const older = await store.getVersion(slug, to);
  if (older === null) {
    throw new KnowledgeEditError(
      `wiki rollback: "${slug}" has no v${to}; the kept versions are v1 to v${current.version - 1}`,
    );
  }
  try {
    const result = await store.write({
      slug,
      title: older.title,
      body: older.body,
      tags: older.tags,
      sources: older.sources,
      expectedVersion: current.version,
      author: CLI_AUTHOR,
    });
    io.stdout(
      `[wiki] ${spec}: "${slug}" now has the text of v${to}, as v${result.version}; v${current.version} is kept`,
    );
    return 0;
  } catch (err) {
    if (err instanceof WikiVersionConflictError) {
      for (const line of conflictLines("rollback", slug, err)) io.stdout(line);
      return 1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// state (working memory)
// ---------------------------------------------------------------------------

const CLEAR_SCOPES: readonly ClearScope[] = ["focus", "plans", "goals", "all"];
/** The names that make a `.crewhaus/state/<name>/` directory a continuity store. */
const STORE_NAMES = ["focus.md", "goals.yaml", "plans", "handoff.md", "sessions"];

function crewhausDir(io: KnowledgeEditIo): string {
  return join(io.cwd, ".crewhaus");
}

/** The specs whose working memory lives under `.crewhaus/state/`, sorted. */
export function listStateSpecs(cwd: string): string[] {
  const dir = join(cwd, ".crewhaus", "state");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && STORE_NAMES.some((n) => existsSync(join(dir, e.name, n))))
    .map((e) => e.name)
    .sort();
}

function stateSpec(io: KnowledgeEditIo, specFlag: string | undefined): string {
  const specs = listStateSpecs(io.cwd);
  if (specFlag !== undefined) {
    if (!specs.includes(specFlag)) {
      throw new KnowledgeEditError(
        `state clear: no working memory for spec "${specFlag}"${specs.length > 0 ? ` (have: ${specs.join(", ")})` : ""}`,
      );
    }
    return specFlag;
  }
  if (specs.length === 1) return specs[0] as string;
  if (specs.length === 0) {
    throw new KnowledgeEditError("state clear: no working memory under .crewhaus/state yet");
  }
  throw new KnowledgeEditError(
    `state clear: more than one spec has working memory; pick one with --spec <name> (have: ${specs.join(", ")})`,
  );
}

/**
 * `crewhaus state clear`: without `--yes`, list what would move to the trash and
 * the exact command that moves it, and move nothing. With `--yes`, move it,
 * refusing when the files changed since the listing `--expect` names.
 */
export async function runStateClear(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const scope = str(args, "scope");
  if (scope === undefined || !CLEAR_SCOPES.includes(scope as ClearScope)) {
    throw new KnowledgeEditError(`state clear: --scope must be one of ${CLEAR_SCOPES.join(", ")}`);
  }
  const session = str(args, "session");
  if (session !== undefined && !SESSION_ID_RE.test(session)) {
    throw new KnowledgeEditError(
      `state clear: "${session}" is not a session id (sess_ and 16 hex digits)`,
    );
  }
  const spec = stateSpec(io, str(args, "spec"));
  const storeScope: ContinuityScope =
    session !== undefined ? { kind: "session", sessionId: session } : { kind: "spec" };
  const store = createContinuityStore({
    specName: spec,
    rootDir: join(io.cwd, ".crewhaus", "state"),
    scope: storeScope,
    now: io.now,
  });
  const clearScope = scope as ClearScope;
  if (!flag(args, "yes")) {
    const plan = await store.planClear(clearScope);
    if (plan.entries.length === 0) {
      io.stdout(`[state] nothing to clear: ${spec} has no ${scope} in its working memory`);
      return 0;
    }
    io.stdout(`[state] would move ${plan.entries.length} file(s) to the trash:`);
    for (const e of plan.entries) io.stdout(`  .crewhaus/${e.path}  (${e.size} bytes)`);
    const purge = new Date(io.now().getTime() + TRASH_PURGE_AFTER_MS).toISOString().slice(0, 10);
    io.stdout(`  They stay in the trash until ${purge}, and can be restored until then.`);
    io.stdout("  To move them, run:");
    io.stdout(
      `  crewhaus state clear --scope ${scope}${session !== undefined ? ` --session ${session}` : ""} --spec ${spec} --yes --expect ${plan.fingerprint}`,
    );
    return 0;
  }
  const expected = str(args, "expect") ?? (await store.planClear(clearScope)).fingerprint;
  try {
    const moved = await store.clear(clearScope, { expectFingerprint: expected });
    if (moved.moved.length === 0) {
      io.stdout(`[state] nothing to clear: ${spec} has no ${scope} in its working memory`);
      return 0;
    }
    io.stdout(`[state] moved ${moved.moved.length} file(s) to the trash`);
    io.stdout(`  undo: crewhaus state restore --trash ${moved.ts}`);
    return 0;
  } catch (err) {
    if (err instanceof ContinuityClearConflictError) {
      io.stdout(
        "[state] clear refused: the working memory changed since that listing. Nothing was moved.",
      );
      io.stdout(`  Run crewhaus state clear --scope ${scope} --spec ${spec} again to see it now.`);
      return 1;
    }
    throw err;
  }
}

/** `crewhaus state trash`: what clearing moved, and how to bring it back. */
export async function runStateTrash(
  _args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const snapshots = await listTrash(crewhausDir(io));
  if (snapshots.length === 0) {
    io.stdout("[state] the trash is empty: crewhaus state clear moves working memory here");
    return 0;
  }
  for (const snap of snapshots) {
    io.stdout(
      `${snap.ts}  ${snap.files.length} file(s)  restore: crewhaus state restore --trash ${snap.ts}`,
    );
    for (const f of snap.files) io.stdout(`  ${f}`);
  }
  return 0;
}

/** `crewhaus state restore --trash <stamp>`: put a cleared snapshot back. */
export async function runStateRestoreTrash(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const stamp = str(args, "trash");
  if (stamp === undefined)
    throw new KnowledgeEditError("state restore: --trash <stamp> is required");
  try {
    const restored = await restoreFromTrash(stamp, crewhausDir(io));
    io.stdout(`[state] restored ${restored.restored.length} file(s) from ${stamp}`);
    for (const f of restored.restored) io.stdout(`  ${f}`);
    return 0;
  } catch (err) {
    if (err instanceof TrashError) throw new KnowledgeEditError(`state restore: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// lessons
// ---------------------------------------------------------------------------

/** Where retired lessons and lesson provenance are kept. */
export const LESSONS_RECORD_DIR = join(".crewhaus", "lessons");
const RETIRED_FILE = "retired.jsonl";
const PROVENANCE_FILE = "provenance.jsonl";
const LESSON_ID_RE = /^l[0-9a-f]{16}$/;

/** A lesson's id: `l` and the first 16 hex of the sha256 of its normalized text. */
export function lessonId(lesson: Pick<Lesson, "key">): string {
  return `l${createHash("sha256").update(lesson.key).digest("hex").slice(0, 16)}`;
}

/** The ids `crewhaus lessons retire` has retired. A malformed line is skipped. */
export function readRetiredLessons(cwd: string): Set<string> {
  const path = join(cwd, LESSONS_RECORD_DIR, RETIRED_FILE);
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    try {
      const rec = JSON.parse(line) as { lesson?: unknown };
      if (typeof rec.lesson === "string" && LESSON_ID_RE.test(rec.lesson)) out.add(rec.lesson);
    } catch {
      // a blank or torn line
    }
  }
  return out;
}

/** Append record lines under `.crewhaus/lessons/`, never through a link planted there. */
function appendRecord(cwd: string, file: string, lines: readonly object[]): void {
  if (lines.length === 0) return;
  const dir = ensureDirContained(cwd, LESSONS_RECORD_DIR, { mode: 0o700 });
  if (!dir.ok) {
    throw new KnowledgeEditError(`could not create ${LESSONS_RECORD_DIR}: ${dir.reason}`);
  }
  const rel = join(LESSONS_RECORD_DIR, file);
  const appended = appendContained(cwd, rel, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
    mode: 0o600,
  });
  if (!appended.ok)
    throw new KnowledgeEditError(`refusing to append to ${rel}: ${appended.reason}`);
}

/**
 * For `crewhaus lessons update`: one provenance line per lesson new to
 * LESSONS.md, naming the sessions (and feedback turns) it was mined from. Ids
 * only, never text.
 */
export function recordLessonProvenance(
  cwd: string,
  added: ReadonlyArray<Lesson>,
  now: () => Date,
): void {
  const at = now().toISOString();
  appendRecord(
    cwd,
    PROVENANCE_FILE,
    added.map((l) => ({
      v: 1,
      at,
      lesson: lessonId(l),
      kind: l.kind,
      sessions: [...(l.sources?.sessions ?? [])],
      ...(l.sources?.turns !== undefined && l.sources.turns.length > 0
        ? {
            turns: l.sources.turns.map((t) => ({
              sessionId: t.sessionId,
              turnNumber: t.turnNumber,
            })),
          }
        : {}),
    })),
  );
}

/** `crewhaus lessons retire`: remove a lesson from LESSONS.md and keep a record of it. */
export async function runLessonsRetire(
  args: ParsedArgs,
  io: KnowledgeEditIo,
): Promise<KnowledgeEditExit> {
  const id = args.positional[1];
  if (id === undefined)
    throw new KnowledgeEditError('usage: crewhaus lessons retire <lesson> [--reason "<why>"]');
  if (!LESSON_ID_RE.test(id)) {
    throw new KnowledgeEditError(
      `lessons retire: "${id}" is not a lesson id (l and 16 hex digits)`,
    );
  }
  const file = str(args, "out") ?? join(io.cwd, "LESSONS.md");
  const raw = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const { preamble, lessons } = parseLessonsMd(raw);
  const target = lessons.find((l) => lessonId(l) === id);
  if (target === undefined) {
    const known = lessons.map((l) => `  ${lessonId(l)}  ${oneLine(l.text, 72)}`);
    throw new KnowledgeEditError(
      `lessons retire: no lesson ${id} in ${file}${known.length > 0 ? `; its lessons are:\n${known.join("\n")}` : ""}`,
    );
  }
  writeFileSync(
    file,
    renderLessonsMd(
      lessons.filter((l) => l !== target),
      preamble,
    ),
    { mode: 0o600 },
  );
  const reason = str(args, "reason")?.trim();
  appendRecord(io.cwd, RETIRED_FILE, [
    {
      v: 1,
      at: io.now().toISOString(),
      lesson: id,
      ...(reason !== undefined && reason !== "" ? { reason } : {}),
    },
  ]);
  io.stdout(`[lessons] retired ${id}: ${oneLine(target.text, 72)}`);
  io.stdout("  crewhaus lessons update will not add it again");
  return 0;
}
