/**
 * The small whole files beside the ledgers: the access revision, the rewritable subjects
 * file and the bootstrap token's read. Reads take no lock and create nothing; writes are
 * atomic (temp and rename, never through a link) and are made only under the access lock.
 * A reason names the file and the fault, never a value from it.
 */
import { closeSync, readSync } from "node:fs";
import { isId } from "@crewhaus/control-contract";
import {
  appendContained,
  openForReadFd,
  openForReadSync,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { accessPaths } from "./paths";

const REVISION_MAX_BYTES = 4096;
const SUBJECTS_MAX_BYTES = 1024 * 1024;
const TOKEN_MAX_BYTES = 64 * 1024;

export type FileRead<T> =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly value: T }
  | { readonly state: "unreadable"; readonly reason: string };

export type Revision = { readonly v: 1; readonly epoch: number; readonly at: string };

export type SubjectEntry = { readonly displayName: string; readonly contact?: string };

/** Display names, contacts and readable link subjects: the only file that holds them. */
export type Subjects = {
  readonly v: 1;
  readonly principals: Readonly<Record<string, SubjectEntry>>;
  readonly links: Readonly<Record<string, string>>;
};

export const EMPTY_SUBJECTS: Subjects = Object.freeze({
  v: 1,
  principals: Object.freeze({}),
  links: Object.freeze({}),
}) as Subjects;

function readJsonObject(
  root: string,
  rel: string,
  maxBytes: number,
): FileRead<Record<string, unknown>> {
  const read = openForReadSync(root, rel, { maxBytes, followLeafSymlink: false });
  if (!read.ok) {
    return read.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: read.reason };
  }
  if (read.truncated)
    return { state: "unreadable", reason: `${rel} is larger than ${maxBytes} bytes` };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  } catch {
    return { state: "unreadable", reason: `${rel} is not JSON` };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { state: "unreadable", reason: `${rel} is not a JSON object` };
  }
  return { state: "present", value: body as Record<string, unknown> };
}

/** `access/revision.json`. Absent reads as epoch 0 at the caller. */
export function readRevision(root: string): FileRead<Revision> {
  const rel = accessPaths().revision;
  const read = readJsonObject(root, rel, REVISION_MAX_BYTES);
  if (read.state !== "present") return read;
  const { v, epoch, at } = read.value;
  if (v !== 1 || !Number.isSafeInteger(epoch) || (epoch as number) < 0 || typeof at !== "string") {
    return { state: "unreadable", reason: `${rel} is not an access revision` };
  }
  return { state: "present", value: { v: 1, epoch: epoch as number, at } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `access/subjects.json`. Absent reads as empty at the caller. */
export function readSubjects(root: string): FileRead<Subjects> {
  const rel = accessPaths().subjects;
  const read = readJsonObject(root, rel, SUBJECTS_MAX_BYTES);
  if (read.state !== "present") return read;
  const { v, principals, links } = read.value;
  const fault = (): FileRead<Subjects> => ({
    state: "unreadable",
    reason: `${rel} is not a subjects file`,
  });
  if (v !== 1 || !isPlainObject(principals) || !isPlainObject(links)) return fault();
  const outPrincipals: Record<string, SubjectEntry> = {};
  for (const [id, entry] of Object.entries(principals)) {
    if (!isId("prn", id) || !isPlainObject(entry)) return fault();
    const { displayName, contact } = entry;
    if (typeof displayName !== "string") return fault();
    if (contact !== undefined && typeof contact !== "string") return fault();
    outPrincipals[id] = contact === undefined ? { displayName } : { displayName, contact };
  }
  const outLinks: Record<string, string> = {};
  for (const [id, subject] of Object.entries(links)) {
    if (!isId("lnk", id) || typeof subject !== "string") return fault();
    outLinks[id] = subject;
  }
  return { state: "present", value: { v: 1, principals: outPrincipals, links: outLinks } };
}

/** The whole subjects file, sorted so equal content gives equal bytes. */
export function subjectsText(subjects: Subjects): string {
  const sortKeys = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key] as T]),
    );
  return `${JSON.stringify(
    { v: 1, principals: sortKeys(subjects.principals), links: sortKeys(subjects.links) },
    null,
    2,
  )}\n`;
}

export type WriteAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function writeWhole(root: string, rel: string, text: string): WriteAnswer {
  const written = writeFileSafe(root, rel, text, { overwrite: true, mode: 0o600 });
  return written.ok ? { ok: true } : { ok: false, reason: written.reason };
}

/** Rewrite `access/subjects.json`. Under the access lock only. */
export function writeSubjects(root: string, subjects: Subjects): WriteAnswer {
  return writeWhole(root, accessPaths().subjects, subjectsText(subjects));
}

/** Rewrite `access/revision.json`. Under the access lock only. */
export function writeRevision(root: string, epoch: number, at: string): WriteAnswer {
  return writeWhole(root, accessPaths().revision, `${JSON.stringify({ v: 1, epoch, at })}\n`);
}

export type TokenRead =
  | { readonly state: "present"; readonly token: string }
  | { readonly state: "absent" }
  | { readonly state: "empty" }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * `<hangarRoot>/token`, read the way Home reads it (its UTF-8, trimmed). A plain bounded
 * read: the file is never moved, rewritten or read for any other purpose.
 */
export function readBootstrapToken(root: string): TokenRead {
  const rel = accessPaths().token;
  const read = openForReadSync(root, rel, { maxBytes: TOKEN_MAX_BYTES, followLeafSymlink: false });
  if (!read.ok) {
    return read.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: read.reason };
  }
  if (read.truncated) return { state: "unreadable", reason: `${rel} is too large to be a token` };
  const token = new TextDecoder().decode(read.bytes).trim();
  return token.length === 0 ? { state: "empty" } : { state: "present", token };
}

/**
 * Before appending to a ledger, end a final line that a crash left without its `\n`, so
 * the torn bytes become one unreadable line rather than swallowing the row after them.
 * A missing file needs nothing. Under the access lock only.
 */
export function sealTornLine(root: string, rel: string): WriteAnswer {
  const opened = openForReadFd(root, rel, { followLeafSymlink: false });
  if (!opened.ok)
    return opened.code === "not-found" ? { ok: true } : { ok: false, reason: opened.reason };
  let torn = false;
  try {
    if (opened.stats.size > 0) {
      const last = Buffer.alloc(1);
      readSync(opened.fd, last, 0, 1, opened.stats.size - 1);
      torn = last[0] !== 0x0a;
    }
  } catch {
    return { ok: false, reason: `${rel} could not be read` };
  } finally {
    closeSync(opened.fd);
  }
  if (!torn) return { ok: true };
  const sealed = appendContained(root, rel, "\n", { mode: 0o600, hardLinks: "refuse" });
  return sealed.ok ? { ok: true } : { ok: false, reason: sealed.reason };
}
