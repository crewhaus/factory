/**
 * Reading the registry FILE's condition, which the registry API cannot tell
 * you, and shaping an entry for a result.
 *
 * `openHangarRegistry` is the only thing in this package that ever WRITES
 * `harnesses.json`: it owns the atomic tmp+rename, the 0600 mode and the
 * fingerprint-checked read-merge-write retry that keeps two sessions and a
 * running manager from losing each other's rows. Nothing here reimplements
 * any of that, and nothing here opens the file for writing.
 *
 * What it does do is READ the file once, before a mutation, because the
 * registry's own reader cannot report what this package has to report:
 *
 * ```js
 * try { parsed = JSON.parse(readFileSync(path, "utf8")); … }
 * catch { parsed = undefined; }           // registry.ts, read()
 * … healable ? normalizeDoc(…) : { doc: EMPTY_DOC, … }
 * ```
 *
 * A registry that could not be parsed therefore reads as an EMPTY registry,
 * and the next write persists that empty document over the file — the
 * package's own comment calls this "healed wholesale by the next write". For
 * a boot hook that is the right posture. For a tool that is about to add,
 * remove or relocate a row it is the worst possible one: the operator asked
 * to move one harness and every other row, every group, every tag and every
 * note in a hand-recoverable file is gone. So a mutation against a registry
 * whose file exists but did not parse is REFUSED here, and a listing says
 * `unparseable` rather than reporting zero harnesses.
 */
import { readFileSync } from "node:fs";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import {
  type Loaded,
  compareStrings,
  fail,
  isInside,
  probeName,
  renderStorePath,
  renderText,
} from "./result";

/** The condition of `harnesses.json` itself. */
export type RegistryFileState =
  | "absent" // no file yet; the first write creates it
  | "ok" // parses to a JSON object the registry can normalize
  | "unparseable" // exists, but is not a JSON object
  | "not-a-file" // the NAME is there and is a directory/socket/…
  | "unreadable"; // could not be opened at all (EACCES, EIO, ELOOP)

export type RegistryFileProbe = {
  readonly state: RegistryFileState;
  /** Absolute path, always reported so a reader knows which file answered. */
  readonly path: string;
  /** Present for every state except `ok`/`absent`. */
  readonly detail?: string;
  /** Rows the raw document carries, when it parsed. Independent of the
   *  normalized view, so "the file has 11 rows but the API returned 0" is
   *  visible instead of invisible. */
  readonly rawHarnessCount?: number;
};

/** Longest registry file this tool will read for its integrity probe. */
const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;

/**
 * What condition the registry file is in — READ ONLY, and never healed.
 *
 * Deliberately NOT a `JSON.parse` wrapped in a shrug: each failure mode gets
 * its own state, because the remedies differ (restore a backup, fix a
 * permission, delete a stray directory) and because "absent" is the only one
 * a mutation may proceed through.
 */
export function probeRegistryFile(path: string): RegistryFileProbe {
  const kind = probeName(path, path);
  if (!kind.ok) return { state: "unreadable", path, detail: kind.reason };
  if (kind.value === undefined) return { state: "absent", path };
  if (kind.value === "directory" || kind.value === "other") {
    return {
      state: "not-a-file",
      path,
      detail: `the registry path is a ${kind.value}, not a file`,
    };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "unreadable", path, detail: `could not be read (${code ?? "unknown error"})` };
  }
  if (text.length > MAX_REGISTRY_BYTES) {
    return { state: "unreadable", path, detail: `larger than ${MAX_REGISTRY_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      state: "unparseable",
      path,
      detail: `not valid JSON (${err instanceof Error ? err.message : "parse error"})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "unparseable", path, detail: "the document is not a JSON object" };
  }
  const harnesses = (parsed as Record<string, unknown>)["harnesses"];
  return {
    state: "ok",
    path,
    ...(Array.isArray(harnesses) ? { rawHarnessCount: harnesses.length } : {}),
  };
}

/**
 * Refuse a mutation the registry would answer by destroying the file.
 *
 * `absent` and `ok` are the two states a write may proceed through. Every
 * other one means the next `writeDoc` would replace a file this tool could
 * not read with one built from `EMPTY_DOC`.
 */
export function mutationBlockedBy(probe: RegistryFileProbe): Loaded<undefined> {
  if (probe.state === "ok" || probe.state === "absent") return { ok: true, value: undefined };
  const shared =
    "@crewhaus/harness-registry reads an unusable registry as an EMPTY one and heals it on the next write, so proceeding would replace every row, group, tag and note in that file with an empty document. A registry that could not be read is not an empty registry.";
  return fail(
    probe.state === "unreadable" || probe.state === "not-a-file" ? "unreadable" : "refused",
    `${probe.path}: ${probe.detail ?? probe.state}. ${shared}`,
  );
}

/** The entry fields a result carries, in a stable order. */
export type EntryView = Record<string, unknown>;

/**
 * One registry row, shaped for a result.
 *
 * `dir` is reported as the registry holds it — absolute, and possibly
 * outside this workspace, because the registry is machine-wide. `inWorkspace`
 * says which, and it is the flag every caller of this module keys on before
 * doing any I/O of its own on that directory: a path a STORE handed back is
 * not a path a caller passed containment for.
 */
export function entryView(entry: HangarHarnessEntry, workspaceRoot: string): EntryView {
  // EVERY STRING HERE CAME OUT OF A SHARED FILE. `harnesses.json` is
  // machine-wide and every crewhaus process on the box writes it, so a row's
  // name, notes, tags and groups are text this package neither wrote nor
  // validated — and this view is on its way into a model's context. Bounded
  // and stripped of control characters so a row cannot spend the whole
  // context or forge a line break out of the field it sits in. The
  // containment decision is made on `entry.dir` itself, never on the
  // rendered copy.
  return {
    id: entry.id,
    dir: renderStorePath(entry.dir),
    inWorkspace: isInside(workspaceRoot, entry.dir),
    specName: renderText(entry.specName),
    target: renderText(entry.target),
    origin: entry.origin,
    ...(entry.originDetail !== "" ? { originDetail: renderText(entry.originDetail) } : {}),
    kind: entry.kind,
    groups: [...entry.groups].sort(compareStrings).map((g) => renderText(g, 100)),
    ...(entry.groupOrder !== undefined ? { groupOrder: entry.groupOrder } : {}),
    tags: [...entry.tags].sort(compareStrings).map((t) => renderText(t, 100)),
    pinned: entry.pinned,
    hidden: entry.hidden,
    ...(entry.notes !== "" ? { notes: renderText(entry.notes, 1000) } : {}),
    registeredAt: entry.registeredAt,
    lastSeen: entry.lastSeen,
    // `null` means the directory was there at the last listing. Reported as
    // an explicit field either way: a vanished harness is never pruned, and
    // an operator reading this table needs to see which rows point at
    // nothing.
    missingSince: entry.missingSince,
  };
}

/** Registry rows in a stable order — by dir, with plain string comparison. */
export function sortEntries(entries: readonly HangarHarnessEntry[]): HangarHarnessEntry[] {
  return [...entries].sort((a, b) => compareStrings(a.dir, b.dir) || compareStrings(a.id, b.id));
}
