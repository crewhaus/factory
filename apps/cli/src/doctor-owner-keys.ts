/**
 * The owner-keys findings of `doctor --philosophy-alignment` (#514): the
 * optimizer's whitelist admits no key in the owner-keys table, and a module that
 * emitted code imports stays inside its allow-list. Side-effect free, so it is
 * unit-tested without the CLI entry file's argv switch.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DELTA_090_KEYS, OPTIMIZABLE_PATHS, type OwnerKey } from "@crewhaus/spec-patch";
import { coversByPrefix, importSpecifiers, namesExactly, notACheckout } from "./doctor-provability";
import type { PhilosophyFinding } from "./scope-audit-drift";

const OWNER_KEYS_FILE = "packages/spec-patch/src/owner-keys.ts";

/** An entry longer than the path whose head matches it: it admits a patch inside the block. */
function reachesInside(entry: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return (
    entry.length > path.length &&
    path.every((seg, i) => entry[i] === "*" || seg === entry[i] || seg === "*")
  );
}

/** `pattern` appears as a contiguous run of `entry`, a `*` on either side matching one segment. */
function containsRun(entry: ReadonlyArray<string>, pattern: ReadonlyArray<string>): boolean {
  for (let start = 0; start + pattern.length <= entry.length; start++) {
    const hit = pattern.every(
      (seg, i) => seg === "*" || entry[start + i] === "*" || entry[start + i] === seg,
    );
    if (hit) return true;
  }
  return false;
}

/** Whether a whitelist entry admits the key, by the rule the key's row states. */
function admitsKey(entry: ReadonlyArray<string>, key: OwnerKey): boolean {
  if (key.root !== true) return containsRun(entry, key.pattern);
  return (
    namesExactly(entry, key.pattern) ||
    coversByPrefix(entry, key.pattern) ||
    reachesInside(entry, key.pattern)
  );
}

/**
 * One finding per owner-keys row: no target's whitelist names it or admits it,
 * by the rule the row states. This reads the TABLE and never asks
 * `isOptimizable`: a refused row answers "no" whatever the table holds, so asking
 * could never fail (`provabilityLevelOptimizerFindings` explains the same trap).
 */
export function ownerKeyOptimizerFindings(
  table: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = OPTIMIZABLE_PATHS,
  keys: ReadonlyArray<OwnerKey> = DELTA_090_KEYS,
): PhilosophyFinding[] {
  return keys.map((key) => {
    const symbol = key.pattern.join(".");
    const base = {
      class: "optimizer-exclusion" as const,
      file: OWNER_KEYS_FILE,
      symbol,
      label: `Pillar 2 — ${symbol} is not optimizable (OPTIMIZABLE_PATHS)`,
    };
    const admitted: string[] = [];
    for (const [target, entries] of Object.entries(table)) {
      for (const entry of entries) {
        if (admitsKey(entry, key)) admitted.push(`${target}: [${entry.join(", ")}]`);
      }
    }
    if (admitted.length === 0) return { ...base, pass: true };
    return {
      ...base,
      pass: false,
      reason: `OPTIMIZABLE_PATHS admits ${symbol} through ${admitted.join("; ")} — ${key.reason}. Remove the entry`,
    };
  });
}

/** One module emitted code imports, and the only specifiers it may import. */
export type RenderSubpathImports = {
  /** Repo-relative path of the module. */
  readonly file: string;
  /** The exact import specifiers it may use. */
  readonly allow: ReadonlyArray<string>;
  readonly label: string;
};

/**
 * The render subpaths held to an allow-list. A subpath lands here with the pull
 * request that adds it, so a bundle never pulls a store or a key module in
 * through a helper it renders.
 */
export const RENDER_SUBPATH_IMPORTS: ReadonlyArray<RenderSubpathImports> = Object.freeze([]);

/** One finding per entry: every import in the module is on its allow-list. */
export function renderSubpathImportFindings(
  repoRoot: string,
  entries: ReadonlyArray<RenderSubpathImports> = RENDER_SUBPATH_IMPORTS,
): PhilosophyFinding[] {
  const isCheckout = existsSync(join(repoRoot, "packages"));
  return entries.map((entry) => {
    if (!isCheckout) return notACheckout("import-boundary", entry.file, entry.label);
    const base = {
      class: "import-boundary" as const,
      file: entry.file,
      symbol: entry.file,
      label: entry.label,
    };
    let source: string;
    try {
      source = readFileSync(join(repoRoot, entry.file), "utf8");
    } catch {
      return {
        ...base,
        pass: false,
        reason: `${entry.file} could not be read, so its imports are unchecked — restore it or remove its RENDER_SUBPATH_IMPORTS entry`,
      };
    }
    const outside = [...new Set(importSpecifiers(source))].filter((s) => !entry.allow.includes(s));
    if (outside.length === 0) return { ...base, pass: true };
    return {
      ...base,
      pass: false,
      reason: `${entry.file} imports ${outside.join(", ")}, outside its allow-list (${entry.allow.join(", ")}) — emitted code would load it`,
    };
  });
}

/** Both, in the order the doctor prints them. */
export function ownerKeyPhilosophyFindings(repoRoot: string): PhilosophyFinding[] {
  return [...ownerKeyOptimizerFindings(), ...renderSubpathImportFindings(repoRoot)];
}
