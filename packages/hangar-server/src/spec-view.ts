/**
 * Masked spec view + lenient capability badges.
 *
 * The spec route returns the harness's `crewhaus.yaml` with credential
 * values masked (`@crewhaus/spec-patch` key + token-shape layers), the
 * `parseSpecIssues` lint result, and the `$VAR` env references it names with
 * SET/UNSET booleans against the merged spawn env — names and presence
 * only, never a value.
 *
 * Capability badges come from a LENIENT top-level key scan, not a schema
 * parse: a fleet page must badge a harness whose spec is a version ahead of
 * (or behind) the manager's schema. The badge list is the fleet-table
 * capability column of the read-only milestone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type SpecHeader, readSpecHeader } from "@crewhaus/harness-inventory";
import { parseSpecIssues } from "@crewhaus/spec";
import { mergedSpawnEnv } from "./env-file";
import { maskSpecYaml } from "./mask";

/** The M1 capability-badge set (presence of the top-level spec block). */
export const BADGE_KEYS = [
  "memory",
  "wiki",
  "dream",
  "thredz",
  "watchme",
  "feedback",
  "budget",
] as const;
export type BadgeKey = (typeof BADGE_KEYS)[number];

/** Lenient top-level-key scan: `<key>:` at column 0. */
export function capabilityBadges(yamlText: string): Record<BadgeKey, boolean> {
  const out = {} as Record<BadgeKey, boolean>;
  for (const key of BADGE_KEYS) {
    out[key] = new RegExp(`^${key}:`, "m").test(yamlText);
  }
  return out;
}

/** Every `$VAR` / `${VAR}` name a spec text references. */
export function collectEnvRefs(yamlText: string): string[] {
  const names = new Set<string>();
  for (const m of yamlText.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

export type SpecIssue = { readonly path: readonly (string | number)[]; readonly message: string };

export type SpecView = {
  /** Masked YAML — safe to render verbatim. */
  readonly yaml: string;
  readonly specName: string;
  readonly target: string;
  /** `parseSpecIssues` diagnostics (empty = compiles cleanly). */
  readonly issues: readonly SpecIssue[];
  /** Env names the spec references, with SET/UNSET presence only. */
  readonly envRefs: ReadonlyArray<{ readonly key: string; readonly set: boolean }>;
  readonly badges: Record<BadgeKey, boolean>;
  /** True when crewhaus.yaml was absent/unreadable (fields degrade). */
  readonly specUnreadable: boolean;
};

/** Build the masked spec view for one harness dir. */
export function specView(
  harnessDir: string,
  baseEnv: Readonly<Record<string, string | undefined>>,
): SpecView {
  const specPath = join(harnessDir, "crewhaus.yaml");
  let yamlText: string | undefined;
  if (existsSync(specPath)) {
    try {
      yamlText = readFileSync(specPath, "utf8");
    } catch {
      yamlText = undefined;
    }
  }
  const header: SpecHeader = yamlText !== undefined ? readSpecHeader(yamlText) : {};
  let issues: SpecIssue[] = [];
  if (yamlText !== undefined) {
    try {
      issues = parseSpecIssues(yamlText).map((i) => ({ path: i.path, message: i.message }));
    } catch (err) {
      issues = [{ path: [], message: err instanceof Error ? err.message : String(err) }];
    }
  }
  const { env } = mergedSpawnEnv(baseEnv, harnessDir);
  const refs = yamlText !== undefined ? collectEnvRefs(yamlText) : [];
  return {
    yaml: yamlText !== undefined ? maskSpecYaml(yamlText) : "",
    specName: header.name ?? harnessDir.split("/").filter(Boolean).at(-1) ?? harnessDir,
    target: header.target ?? "unknown",
    issues,
    envRefs: refs.map((key) => ({
      key,
      set: env[key] !== undefined && env[key] !== "",
    })),
    badges: capabilityBadges(yamlText ?? ""),
    specUnreadable: yamlText === undefined,
  };
}
