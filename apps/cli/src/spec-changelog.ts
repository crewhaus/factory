/**
 * Item 46 — auto-register spec versions with changelogs distilled from
 * patch history. Shared by `crewhaus compile` (post-emission), `crewhaus
 * optimize --write-back` (post-write-back) and `crewhaus spec put`:
 *
 *   - `autoRegisterSpecVersion` content-hashes the spec and, when the
 *     local registry has no version with that content, `put`s the next
 *     `vN` — so registry state tracks working files without a manual
 *     `crewhaus spec put`. Recompiling an unchanged spec is a no-op.
 *   - every auto/manual put appends a distilled entry to a per-spec
 *     `CHANGELOG.md` stored BESIDE the registry manifest
 *     (`.crewhaus/specs/<name>/CHANGELOG.md` — a NEW file; the registry's
 *     own on-disk format is untouched): version, date, the field-level
 *     YAML diff vs the previous version, and — when the content carries a
 *     `formatWriteBackHeader` stamp — the optimizer's runId/mutator/score
 *     plus the SpecPatch `rationale` from that run's `patch.json`.
 *
 * Kept in a side-effect-free module (nothing runs on import) so the logic
 * is unit-testable — the CLI entry file runs an argv switch on import.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SpecDiffEntry,
  type WriteBackHeaderInfo,
  diffSpecYaml,
  parseWriteBackHeader,
} from "@crewhaus/spec-patch";
import type { RegistryAdapter } from "@crewhaus/spec-registry";

/** The per-spec changelog file, beside the registry's `manifest.json`. */
export const CHANGELOG_FILE = "CHANGELOG.md";

// The registry's own name floor (spec-registry NAME_REGEX). Spec names may
// additionally contain spaces and ':' (the spec `safeName` grammar), so
// auto-registration maps a display name onto this grammar deterministically.
const REGISTRY_NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
// A write-back runId is read from a COMMENT in the spec being registered;
// refuse to path-join anything that could escape the optimize root.
const SAFE_RUN_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Map a spec's display name (spec `safeName`: letters, digits, spaces,
 * `_ . - :`) onto the registry's stricter name grammar: runs of characters
 * outside `[A-Za-z0-9_.-]` collapse to a single `-`, leading dots are
 * stripped (the registry hides dot-dirs), and an empty result falls back to
 * `"spec"`. Deterministic, so the same spec always lands in the same slot.
 */
export function registrySpecName(specName: string): string {
  const cleaned = specName.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^\.+/, "");
  const name = cleaned.length > 0 ? cleaned : "spec";
  // Defensive: the transform above always satisfies the registry grammar,
  // but verify so a future grammar drift fails loudly here, not deep in fs.
  if (!REGISTRY_NAME_REGEX.test(name)) return "spec";
  return name;
}

/** SHA-256 hex of the exact YAML text (the registry stores bytes verbatim). */
export function contentHash(yaml: string): string {
  return createHash("sha256").update(yaml).digest("hex");
}

/**
 * Next auto-version: `v<max+1>` over the existing `v<N>` versions (manifest
 * order, numeric — `v10` beats `v2`). Manually-put versions that don't match
 * `v<N>` (e.g. `2.0`, `release-1`) are ignored for numbering.
 */
export function nextVersion(existing: ReadonlyArray<string>): string {
  let max = 0;
  for (const v of existing) {
    const m = /^v(\d+)$/.exec(v);
    if (m?.[1] === undefined) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return `v${max + 1}`;
}

/**
 * Optimizer provenance for a changelog entry: the write-back header fields
 * plus the `rationale` string the optimizer stored in that run's
 * `patch.json` (the SpecPatch field documented as existing "for audit /
 * write-back commit messages" — this is where it finally surfaces).
 */
export type OptimizeMetadata = WriteBackHeaderInfo & {
  readonly rationale?: string;
};

export type ExtractOptimizeMetadataOptions = {
  /** The YAML being registered (its leading comment block is scanned). */
  readonly yaml: string;
  /** Root of the optimizer run dirs (`.crewhaus/optimize`) for `<runId>/patch.json` lookup. */
  readonly optimizeRootDir?: string | undefined;
  /** Explicit patch.json path — the optimize --write-back hook knows its own out-dir (which `-o` may relocate). */
  readonly patchJsonPath?: string | undefined;
};

/**
 * When the YAML carries a `formatWriteBackHeader` stamp, recover the run
 * metadata and — if that run's `patch.json` is readable — its `rationale`.
 * Returns `undefined` for content that was never written back. Never throws:
 * provenance is best-effort garnish on the changelog, not a gate.
 */
export function extractOptimizeMetadata(
  opts: ExtractOptimizeMetadataOptions,
): OptimizeMetadata | undefined {
  const header = parseWriteBackHeader(opts.yaml);
  if (header === undefined) return undefined;
  let patchJsonPath = opts.patchJsonPath;
  if (
    patchJsonPath === undefined &&
    opts.optimizeRootDir !== undefined &&
    SAFE_RUN_ID_REGEX.test(header.runId)
  ) {
    patchJsonPath = join(opts.optimizeRootDir, header.runId, "patch.json");
  }
  let rationale: string | undefined;
  if (patchJsonPath !== undefined && existsSync(patchJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(patchJsonPath, "utf-8")) as {
        rationale?: unknown;
      };
      if (typeof parsed.rationale === "string" && parsed.rationale.length > 0) {
        rationale = parsed.rationale;
      }
    } catch {
      // Unreadable/malformed patch.json — keep the header fields alone.
    }
  }
  return { ...header, ...(rationale !== undefined ? { rationale } : {}) };
}

export type ChangelogEntryOptions = {
  readonly version: string;
  readonly yaml: string;
  /** The previous version's YAML; omit for a spec's first version. */
  readonly previousYaml?: string | undefined;
  readonly optimizeRootDir?: string | undefined;
  readonly patchJsonPath?: string | undefined;
  /** Injectable clock for deterministic tests. */
  readonly now?: Date | undefined;
};

/**
 * Render one changelog entry (pure): `## <version> — <date>` followed by
 * the field-level diff bullets vs the previous version (or `initial
 * version`) and, when present, the optimizer provenance + rationale.
 */
export function renderChangelogEntry(opts: ChangelogEntryOptions): string {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const lines: string[] = [`## ${opts.version} — ${date}`, ""];
  if (opts.previousYaml === undefined) {
    lines.push("- initial version");
  } else {
    let diff: ReadonlyArray<SpecDiffEntry> | undefined;
    try {
      diff = diffSpecYaml(opts.previousYaml, opts.yaml);
    } catch (err) {
      lines.push(`- diff unavailable (${(err as Error).message})`);
    }
    if (diff !== undefined) {
      if (diff.length === 0) {
        lines.push("- no structural changes (comments/formatting only)");
      } else {
        for (const d of diff) lines.push(formatDiffLine(d));
      }
    }
  }
  const meta = extractOptimizeMetadata(opts);
  if (meta !== undefined) {
    const details: string[] = [];
    if (meta.mutator !== undefined) details.push(`mutator ${meta.mutator}`);
    if (meta.iterations !== undefined) details.push(`${meta.iterations} iteration(s)`);
    if (meta.scoreBefore !== undefined && meta.scoreAfter !== undefined) {
      details.push(`score ${meta.scoreBefore.toFixed(3)} → ${meta.scoreAfter.toFixed(3)}`);
    }
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    lines.push(`- optimizer: runId ${meta.runId}${suffix}`);
    if (meta.rationale !== undefined) lines.push(`- rationale: ${meta.rationale}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatDiffLine(d: SpecDiffEntry): string {
  switch (d.kind) {
    case "added":
      return `- added \`${d.path}\`: ${d.after ?? ""}`;
    case "removed":
      return `- removed \`${d.path}\`: ${d.before ?? ""}`;
    case "changed":
      return `- changed \`${d.path}\`: ${d.before ?? ""} → ${d.after ?? ""}`;
  }
}

/**
 * Insert an entry into a changelog text, NEWEST FIRST (pure): the new entry
 * lands above the previous top `## ` heading, under the `# Changelog — …`
 * title. `crewhaus spec log` can therefore print the file verbatim and read
 * most-recent-first.
 */
export function insertNewestFirst(existing: string, name: string, entry: string): string {
  if (existing.trim() === "") {
    return `# Changelog — ${name}\n\n${entry}`;
  }
  const firstHeading = /^## /m.exec(existing);
  if (firstHeading === null) {
    // A title-only (or hand-edited) file: append below whatever is there.
    return `${existing.trimEnd()}\n\n${entry}`;
  }
  return `${existing.slice(0, firstHeading.index)}${entry}\n${existing.slice(firstHeading.index)}`;
}

export type AppendChangelogOptions = ChangelogEntryOptions & {
  /** Registry root (`.crewhaus/specs`) — the changelog lives beside `<name>/manifest.json`. */
  readonly registryRootDir: string;
  /** Registry-grammar spec name (already sanitized/validated by the caller's `put`). */
  readonly name: string;
};

/**
 * Append (newest-first) one entry to `<registryRoot>/<name>/CHANGELOG.md`,
 * creating the file with its title on first use. Returns the file path.
 */
export function appendChangelogEntry(opts: AppendChangelogOptions): string {
  const dir = join(opts.registryRootDir, opts.name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CHANGELOG_FILE);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const entry = renderChangelogEntry(opts);
  writeFileSync(path, insertNewestFirst(existing, opts.name, entry), { mode: 0o600 });
  return path;
}

export type AutoRegisterOptions = {
  readonly registry: RegistryAdapter;
  readonly registryRootDir: string;
  /** The spec's display name straight from the YAML (sanitized internally). */
  readonly specName: string;
  /** The exact YAML text to register (including any write-back header). */
  readonly yaml: string;
  readonly optimizeRootDir?: string | undefined;
  readonly patchJsonPath?: string | undefined;
  readonly now?: Date | undefined;
};

export type AutoRegisterResult = {
  readonly status: "registered" | "unchanged";
  /** The registry-grammar name the spec landed under. */
  readonly name: string;
  readonly version: string;
};

/**
 * Content-hash gated auto-put: when some stored version already carries this
 * exact content, report `unchanged` (with that version); otherwise `put` the
 * next `vN` and append the distilled changelog entry. The previous-latest
 * version (manifest order) is the diff baseline.
 */
export async function autoRegisterSpecVersion(
  opts: AutoRegisterOptions,
): Promise<AutoRegisterResult> {
  const name = registrySpecName(opts.specName);
  const hash = contentHash(opts.yaml);
  const manifest = await opts.registry.manifest(name);

  // Scan ALL stored versions for this content — re-registering any past
  // version (e.g. a rollback restored on disk) is also a no-op. Later
  // matches win so the reported version is the most recent occurrence.
  let matched: string | undefined;
  for (const v of manifest.versions) {
    try {
      if (contentHash(await opts.registry.get(name, v)) === hash) matched = v;
    } catch {
      // A manifest-listed version whose file vanished: ignore for matching.
    }
  }
  if (matched !== undefined) {
    return { status: "unchanged", name, version: matched };
  }

  const previousVersion = manifest.versions[manifest.versions.length - 1];
  let previousYaml: string | undefined;
  if (previousVersion !== undefined) {
    try {
      previousYaml = await opts.registry.get(name, previousVersion);
    } catch {
      // Baseline unavailable — the entry renders as diff-less.
    }
  }

  const version = nextVersion(manifest.versions);
  await opts.registry.put(name, version, opts.yaml);
  appendChangelogEntry({
    registryRootDir: opts.registryRootDir,
    name,
    version,
    yaml: opts.yaml,
    ...(previousYaml !== undefined ? { previousYaml } : {}),
    ...(opts.optimizeRootDir !== undefined ? { optimizeRootDir: opts.optimizeRootDir } : {}),
    ...(opts.patchJsonPath !== undefined ? { patchJsonPath: opts.patchJsonPath } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { status: "registered", name, version };
}
