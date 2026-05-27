/**
 * Cross-cutting (Track 10) — `rules-engine`. Reads multi-language
 * always-follow rule packs from `rules/{common,typescript,python,…}`
 * and renders them as a system-prompt prefix.
 *
 * Source: ECC (https://github.com/affaan-m/ECC). ECC ships 12
 * language ecosystems' worth of rule files, organized as a folder per
 * language plus a `common/` folder for cross-language guidelines.
 * Rules are *always-follow* (distinct from skills, which are
 * workflow-triggered).
 *
 * The CrewHaus take:
 *
 *   - `rules/` is project-rooted. CrewHaus reads from `rules/common/`
 *     and from `rules/<language>/` based on the spec's declared
 *     language(s).
 *   - Each file under `rules/<bucket>/` is one rule. The filename
 *     (kebab-case) becomes the rule's `id`; the file body is the
 *     rule text.
 *   - The rules are concatenated with section headers and injected
 *     into the agent's system prompt by callers (runtime-core's
 *     prompt-builder).
 *   - Empty/missing `rules/` directory is a no-op (graceful default).
 *
 * Also supports a `CREWHAUS_HOOK_PROFILE`-style env-var (here named
 * `CREWHAUS_RULES_PROFILE`) to gate which buckets are included at
 * runtime, e.g. `CREWHAUS_RULES_PROFILE=core` to limit to `common/`
 * only.
 *
 * Reference repo: ECC (https://github.com/affaan-m/ECC).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

export class RulesEngineError extends CrewhausError {
  override readonly name = "RulesEngineError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type Rule = {
  readonly id: string;
  readonly bucket: string;
  readonly body: string;
};

export type LoadRulesOptions = {
  /** Project root that contains the `rules/` directory. */
  readonly projectRoot: string;
  /** Languages to include (always merged with `common`). */
  readonly languages?: ReadonlyArray<string>;
  /**
   * Override the profile env var read (`CREWHAUS_RULES_PROFILE`).
   * `core` → common/ only. `standard` → common + named languages.
   * `full` → every bucket present under `rules/`. Default: standard.
   */
  readonly profile?: "core" | "standard" | "full";
};

/**
 * Load and order all rules per the profile + languages. Pure (no
 * env read) — the CLI is responsible for resolving the env var.
 *
 * Returns rules in deterministic order (bucket alphabetical, then
 * file alphabetical) so prompt-cache prefixes stay stable across runs.
 */
export function loadRules(opts: LoadRulesOptions): ReadonlyArray<Rule> {
  const root = resolve(opts.projectRoot);
  const rulesDir = join(root, "rules");
  let buckets: string[];
  try {
    buckets = readdirSync(rulesDir).filter((name) => {
      try {
        return statSync(join(rulesDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const profile = opts.profile ?? "standard";
  const wanted = new Set<string>();
  wanted.add("common");
  if (profile === "standard") {
    for (const lang of opts.languages ?? []) wanted.add(lang);
  } else if (profile === "full") {
    for (const b of buckets) wanted.add(b);
  }
  const selectedBuckets = buckets.filter((b) => wanted.has(b)).sort();

  const out: Rule[] = [];
  for (const bucket of selectedBuckets) {
    const bucketDir = join(rulesDir, bucket);
    let files: string[];
    try {
      files = readdirSync(bucketDir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const id = file.replace(/\.(md|txt)$/, "");
      let body: string;
      try {
        body = readFileSync(join(bucketDir, file), "utf8");
      } catch (err) {
        throw new RulesEngineError(
          `failed to read rule ${bucket}/${file}: ${(err as Error).message}`,
        );
      }
      out.push({ id, bucket, body });
    }
  }
  return out;
}

/**
 * Render an ordered rule list as a markdown system-prompt prefix.
 * Used by runtime-core to fold rules into the prompt during turn
 * construction. Idempotent: identical input → identical output bytes,
 * which preserves prompt-cache hits across turns.
 */
export function renderRules(rules: ReadonlyArray<Rule>): string {
  if (rules.length === 0) return "";
  const sections: string[] = ["# Project rules", ""];
  let lastBucket: string | undefined;
  for (const rule of rules) {
    if (rule.bucket !== lastBucket) {
      sections.push(`## ${rule.bucket}`, "");
      lastBucket = rule.bucket;
    }
    sections.push(`### ${rule.id}`, "", rule.body.trim(), "");
  }
  return sections.join("\n");
}

/**
 * Convenience env-var read for the CLI. Validates the profile
 * value; falls back to `standard` for any unrecognised value.
 */
export function resolveProfile(envValue: string | undefined): "core" | "standard" | "full" {
  if (envValue === "core" || envValue === "standard" || envValue === "full") return envValue;
  return "standard";
}
