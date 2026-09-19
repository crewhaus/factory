/**
 * Opening a local template registry, and measuring what it did not tell us.
 *
 * `@crewhaus/template-registry` owns every rule about what a template IS —
 * the manifest shape, what `kind` an absent `kind` means, what makes a
 * grader-template's assets valid, and whether a signature verifies. None of
 * that is re-derived here; this module opens the directory, keeps the paths
 * contained, and reports the difference between what is on disk and what the
 * registry handed back.
 *
 * TWO THINGS THE REGISTRY SOURCE DOES THAT A SEARCH TOOL MUST NOT INHERIT:
 *
 *   1. `new LocalRegistrySource({rootDir})` CREATES the directory when it is
 *      missing (`mkdirSync(..., {recursive: true})`). A read-only search that
 *      creates a tree on a typo is a side effect nobody asked for, and it also
 *      turns "that registry does not exist" into "that registry is empty". So
 *      the directory is stat'd BEFORE the source is constructed, and a missing
 *      one is reported as missing.
 *
 *   2. `list()` returns one entry PER FILE, keyed on the `name` INSIDE the
 *      file, while `fetch(name)` reads `<name>.json`. Those are the same file
 *      only when a manifest's `name` matches its filename and no OTHER file
 *      claims that name. When two do, a row listed from one file and a
 *      signature verified over the other are two different manifests, and
 *      attributing one to the other is how an impostor row inherits a real
 *      signature. {@link duplicateNames} finds the collision and
 *      {@link sameMetadata} proves, per row, that the bytes that were verified
 *      are the bytes that are being shown.
 *
 *   3. `list()` swallows a manifest it cannot parse — `catch { // skip
 *      malformed files }`. That is the right call for the library (one bad
 *      file should not take down a listing) and the wrong answer for a search
 *      tool, because "3 templates" and "3 templates, 4 files unreadable" are
 *      different answers and an operator acts differently on them. The gap is
 *      computed by comparing the `*.json` files in the directory with the
 *      names the listing returned, and reported — never repaired by parsing
 *      the file a second way here.
 */
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  LocalRegistrySource,
  type RegistrySource,
  type TemplateMetadata,
  templateKind,
} from "@crewhaus/template-registry";
import type { SafePath } from "../paths";
import {
  type Loaded,
  compareStrings,
  contain,
  containExistingDir,
  fail,
  renderPath,
} from "./result";

export type OpenedRegistry = {
  readonly source: RegistrySource;
  readonly dir: SafePath;
  /** `*.json` basenames in the directory, sorted. Never readdir order. */
  readonly files: ReadonlyArray<string>;
};

/**
 * Contain the registry directory AND every manifest file inside it, then open
 * the source.
 *
 * Containing the directory and not its leaves contains nothing. `list()` does
 * its own `readdirSync` + `readFileSync` over every `*.json` in the directory,
 * so the paths this tool actually opens are the LEAVES, and a symlink sitting
 * at `<registry>/innocent.json` and pointing at `/etc/shadow` is read by the
 * library before this tool ever sees a name. The leaves are therefore checked
 * first, and one that leads out of the workspace refuses the whole call rather
 * than being skipped — the listing that followed would be a listing of a
 * directory somebody has already tampered with.
 *
 * There is a window between this check and the library's own `readdir`. It is
 * not closed here and is not claimed to be: an attacker who can rewrite the
 * registry directory between two syscalls is a different threat model from a
 * link that is already sitting there, which is the case this catches.
 */
export function openLocalRegistry(toolName: string, registryDir: string): Loaded<OpenedRegistry> {
  const loaded = containExistingDir(toolName, registryDir);
  if (!loaded.ok) return loaded;
  const dir = loaded.value;

  let entries: string[];
  try {
    entries = readdirSync(dir.real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Never `[]`: a directory that could not be listed is not an empty
    // marketplace, and this is the read the whole tool is built on.
    return fail(
      "unreadable",
      `"${renderPath(registryDir)}" could not be listed (${code ?? "unknown error"})`,
    );
  }

  const files = entries.filter((name) => name.endsWith(".json")).sort(compareStrings);
  for (const name of files) {
    const rel = dir.rel === "" ? name : `${dir.rel}/${name}`;
    if (!contain(toolName, rel).ok) {
      return fail(
        "refused",
        `"${renderPath(name)}" in "${renderPath(registryDir)}" resolves outside the workspace root — the registry source reads every *.json in that directory, so listing it would read through the link. Remove it and run again; there is no flag for reading through it.`,
      );
    }
  }

  return {
    ok: true,
    value: { source: new LocalRegistrySource({ rootDir: dir.real }), dir, files },
  };
}

/**
 * Manifest files the listing did not store a template under.
 *
 * A manifest is stored at `<root>/<name>.json`, so a file whose stem never
 * appears as a template name is one of two things: it did not parse (the
 * source skipped it, and the template really is missing), or its `name`
 * disagrees with its filename — in which case the template IS in the listing
 * and is shown, and only `fetch` will go looking somewhere else. Those are
 * different facts and neither is worth guessing between, so the caller's
 * reason names both. It must not say the file "did not appear in the listing":
 * for the second case that is simply false, and a caller acts on it.
 */
export function unaccountedFiles(
  files: ReadonlyArray<string>,
  listing: ReadonlyArray<TemplateMetadata>,
): string[] {
  const named = new Set<string>();
  for (const meta of listing) {
    if (typeof meta.name === "string") named.add(`${meta.name}.json`);
  }
  return files.filter((f) => !named.has(f)).sort(compareStrings);
}

/**
 * Most per-file gap facts one result will carry.
 *
 * `results` is paged, and this has to be bounded for the same reason: a
 * directory holding a thousand stray `*.json` files would otherwise answer a
 * search with a thousand `unknowns` entries, and the page size the caller
 * chose would not bound the answer at all. The overflow is REPORTED, with the
 * true total — a silently shortened list of what could not be read is the
 * failure this whole file exists to avoid.
 */
export const MAX_GAP_FACTS = 50;

/**
 * Names that more than one manifest in the listing claims, with how many.
 *
 * A collision is not repairable from here — which of the files `fetch(name)`
 * returns is decided by the filename, and the listing does not say which file
 * each entry came from — so it is reported rather than resolved.
 */
export function duplicateNames(
  listing: ReadonlyArray<TemplateMetadata>,
): Array<{ readonly name: string; readonly count: number }> {
  const counts = new Map<string, number>();
  for (const meta of listing) {
    if (typeof meta.name !== "string") continue;
    counts.set(meta.name, (counts.get(meta.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * Deep equality by value, independent of key order.
 *
 * Used to answer one question: is the manifest `fetch(name)` just opened the
 * same manifest this row was listed from? `JSON.stringify` alone would answer
 * it for the ordinary case (both come from one `JSON.parse` of one file, so
 * the key order matches) and would report a false collision if either side
 * were ever rebuilt. Sorting the keys makes the comparison about content.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * Is this the manifest that row was listed from?
 *
 * Proved, never assumed. `fetch(name)` opens `<name>.json`; the row was built
 * from whatever file DECLARED that name. Two files can declare one name, and
 * then a signature verified over the file that owns the filename would be
 * reported next to the other file's description and author. A model told
 * "verified" trusts what it is shown.
 */
export function sameMetadata(listed: unknown, fetched: unknown): boolean {
  return stableJson(listed) === stableJson(fetched);
}

/** Is this entry a regular file? Used only to explain a gap, never to hide one. */
export function isRegularFile(dirReal: string, name: string): boolean {
  try {
    return statSync(path.join(dirReal, name)).isFile();
  } catch {
    return false;
  }
}

export type SearchFilters = {
  readonly query?: string;
  readonly kind?: string;
  readonly target?: string;
};

/**
 * Filter a listing.
 *
 * The match runs on the PARSED value — the manifest's own `description`, in a
 * case-folded copy — not on the sanitized text the result displays. Matching
 * the display string would mean a template whose description contains a
 * zero-width character silently stops matching the word it plainly contains,
 * which is the "validate one spelling, act on another" shape this repository
 * keeps paying for. The two are then reconciled in the result: the row says
 * which fields had to be sanitized.
 *
 * `kind` goes through `templateKind`, the registry's own rule for what an
 * absent `kind` means. A manifest written before the field existed is a
 * `spec-template`, and this package is not the place that decides that.
 */
export function filterTemplates(
  listing: ReadonlyArray<TemplateMetadata>,
  filters: SearchFilters,
): TemplateMetadata[] {
  const needle = filters.query?.toLowerCase();
  return listing
    .filter((meta) => {
      if (filters.kind !== undefined && templateKind(meta) !== filters.kind) return false;
      if (filters.target !== undefined && meta.target !== filters.target) return false;
      if (needle === undefined || needle === "") return true;
      const haystack = [meta.name, meta.description, meta.author, meta.target]
        .filter((v): v is string => typeof v === "string")
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => compareStrings(String(a.name), String(b.name)));
}
