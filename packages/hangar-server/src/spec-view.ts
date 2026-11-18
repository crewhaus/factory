/**
 * Masked spec view + lenient capability badges.
 *
 * The spec route returns the harness's `crewhaus.yaml` with credential
 * values masked (`@crewhaus/spec-patch` key + token-shape layers), the
 * `parseSpecIssues` lint result, and the `$VAR` env references it names with
 * SET/UNSET booleans against the merged spawn env — names and presence
 * only, never a value.
 *
 * Capability badges come from a LENIENT key scan, not a schema parse: a
 * fleet page must badge a harness whose spec is a version ahead of (or
 * behind) the manager's schema. The badge list is the fleet-table capability
 * column of the read-only milestone.
 *
 * Lenient does not mean wrong about where a block lives. `wiki:` and
 * `dream:` are NOT top-level keys — the schema nests them under `memory:`
 * (`memory.wiki` / `memory.dream`), and a top-level `dream:` fails
 * validation outright — so scanning only column 0 made two of the seven
 * badges unreachable for every valid spec. Each badge therefore carries the
 * parent block it may nest under, and the scan looks in both places.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type SpecHeader, readSpecHeader } from "@crewhaus/harness-inventory";
import { readBundleStamp, resolveBundle } from "@crewhaus/harness-supervisor";
import { type SupportStatus, featureSupport } from "@crewhaus/ir/support";
import { parseSpecIssues } from "@crewhaus/spec";
import { mergedSpawnEnv } from "./env-file";
import { maskSpecYaml } from "./mask";
import { withoutTrailingComment } from "./spec-lines";

/** The M1 capability-badge set (presence of the spec block that declares it). */
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

/**
 * The top-level block a badge key may ALSO appear inside. `wiki:` and
 * `dream:` are schema children of `memory:`; the rest are top-level blocks
 * with no nesting parent. The top-level scan is still tried first, so a spec
 * a schema version ahead (or behind) that hoists one of them still badges.
 */
const BADGE_PARENTS: Partial<Record<BadgeKey, readonly string[]>> = {
  wiki: ["memory"],
  dream: ["memory"],
};

/**
 * The text of a top-level YAML block: the remainder of the `<key>:` line
 * plus every following line that is indented, blank, or a comment — up to
 * the next key at column 0. Comments are stripped so a commented-out
 * `# wiki:` does not badge. Deliberately textual, like the rest of this
 * scan: a spec that does not parse under this manager's schema must still
 * badge correctly. The comment strip is a scan (spec-lines.ts): `/#.*$/` read
 * on from every `#` of a line holding a U+2028 or a lone `\r`.
 */
function topLevelBlockText(yamlText: string, key: string): string {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (start === -1) return "";
  const block = [
    withoutTrailingComment(lines[start] as string).replace(new RegExp(`^${key}\\s*:`), ""),
  ];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "" || /^[\s#]/.test(line)) block.push(withoutTrailingComment(line));
    else break;
  }
  return block.join("\n");
}

/** `<key>:` anywhere inside a block's text (flow or indented mapping). */
function declaresKey(blockText: string, key: string): boolean {
  return new RegExp(`(?:^|[\\s{,])${key}\\s*:`, "m").test(blockText);
}

/** Lenient key scan: `<key>:` at column 0, or inside the block that owns it. */
export function capabilityBadges(yamlText: string): Record<BadgeKey, boolean> {
  const out = {} as Record<BadgeKey, boolean>;
  for (const key of BADGE_KEYS) {
    out[key] =
      new RegExp(`^${key}:`, "m").test(yamlText) ||
      (BADGE_PARENTS[key] ?? []).some((parent) =>
        declaresKey(topLevelBlockText(yamlText, parent), key),
      );
  }
  return out;
}

/** The support-manifest feature each badge stands for. */
const BADGE_FEATURES: Readonly<Record<BadgeKey, string>> = {
  memory: "memory",
  wiki: "memory.wiki",
  dream: "memory.dream",
  thredz: "thredz",
  watchme: "watchme",
  feedback: "feedback",
  budget: "budget",
};

/** What one declared badge does on the harness's shape, as its build was compiled. */
export type BadgeSupport = {
  readonly status: SupportStatus | "unknown" | "recompile";
  readonly reason?: string;
};

export type BadgeSupportView = {
  /** One entry per declared badge. */
  readonly badgeSupport: Partial<Record<BadgeKey, BadgeSupport>>;
  /** Present when the build cannot be read against this release's manifest. */
  readonly badgeNote?: string;
  /** The command that answers `badgeNote`, when one does (`crewhaus compile`). */
  readonly badgeVerb?: string;
};

/**
 * Whether each declared badge takes effect on the harness's shape, from the
 * support manifest and the crewhaus version its bundle was compiled with: a
 * block a shape accepts and does not use reads `unwired` with the reason. A
 * harness with no build, or one compiled before the manifest existed, reads
 * `unknown` with a note (`badgeNote`) and the command that answers it
 * (`badgeVerb`, `crewhaus compile`); a build by a newer CrewHaus, or a shape
 * this one does not know, reads `unknown` with a note and no command.
 */
export function badgeSupport(
  badges: Readonly<Record<BadgeKey, boolean>>,
  target: string,
  compiledWith: string | undefined,
): BadgeSupportView {
  const declared = BADGE_KEYS.filter((key) => badges[key]);
  const support = featureSupport({
    shape: target,
    declared: declared.map((key) => ({ feature: BADGE_FEATURES[key], path: BADGE_FEATURES[key] })),
    ...(compiledWith !== undefined ? { compiledWith } : {}),
  });
  const out: Partial<Record<BadgeKey, BadgeSupport>> = {};
  for (const key of declared) {
    const answer = support.features.find((f) => f.feature === BADGE_FEATURES[key]);
    if (answer === undefined) continue;
    out[key] = {
      status: answer.status,
      ...(answer.reason !== undefined && support.basis === "manifest"
        ? { reason: answer.reason }
        : {}),
    };
  }
  return {
    badgeSupport: out,
    ...(support.basis === "unknown" && support.note !== undefined && declared.length > 0
      ? {
          badgeNote: support.note,
          ...(support.verb !== undefined ? { badgeVerb: support.verb } : {}),
        }
      : {}),
  };
}

/** The crewhaus version stamped on the harness's compiled bundle, or undefined (no build). */
export function bundleCompiledWith(harnessDir: string, target: string): string | undefined {
  const location = resolveBundle(harnessDir, target);
  if (location === undefined) return undefined;
  return readBundleStamp(location.bundleDir)?.compiledWith;
}

/**
 * A harness detail's badges and what each does there: the lenient badge scan,
 * then {@link badgeSupport} for the shape the spec names (the registry's
 * `fallbackTarget` when its header does not read).
 */
export function detailBadges(
  yamlText: string,
  harnessDir: string,
  fallbackTarget: string,
): { readonly badges: Record<BadgeKey, boolean> } & BadgeSupportView {
  const badges = capabilityBadges(yamlText);
  let shape = fallbackTarget;
  try {
    shape = readSpecHeader(yamlText).target ?? fallbackTarget;
  } catch {
    // A header that does not read: the registry's shape stands in.
  }
  return { badges, ...badgeSupport(badges, shape, bundleCompiledWith(harnessDir, shape)) };
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
