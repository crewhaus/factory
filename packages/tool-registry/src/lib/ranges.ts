/**
 * Version ranges, in four dialects, answered by one engine.
 *
 * `@crewhaus/tool-code` owns range satisfaction for this monorepo — `satisfies`,
 * `parseSemver` and `compareSemver` live there and the comment beside them says
 * why there is exactly one implementation. Nothing here re-implements any of
 * it. What this module does is the part that is genuinely NOT semver: a Cargo
 * requirement and a PEP 440 specifier are different grammars that happen to
 * look like npm ranges, and feeding one to the other produces a confident
 * wrong answer rather than an error.
 *
 *   - `1.2` means `=1.2.0` to npm and `^1.2.0` to Cargo.
 *   - `~=1.4.2` means `>=1.4.2 <1.5.0` to pip and nothing at all to npm.
 *   - `1.0rc1` is a PyPI version that `parseSemver` reads as `1.0.0`, because
 *     its pattern is unanchored — so `1.0rc1` and `1.0` compare EQUAL, and a
 *     prerelease looks like its own release.
 *
 * The dialect is a property of the DECLARATION SITE, not of the registry. One
 * pyproject.toml holds both: a PEP 621 `dependencies = ["requests>=2.31"]`
 * array is PEP 508, while `[tool.poetry.dependencies] requests = "^2.31"` is
 * Poetry's own caret/tilde grammar, which PEP 440 does not define at all. Read
 * as PEP 440, every ordinary Poetry pin — `^2.31`, `~0.27`, `*`, a bare
 * `2.31` — fails to parse and the whole project reports as unevaluable, which
 * is indistinguishable from "nothing is outdated" to anyone reading the count.
 *
 * So each dialect is translated into the one grammar `satisfies` understands,
 * and anything that does not translate exactly comes back as a refusal with a
 * reason. "Cannot tell" is a row in the table; a wrong answer is a bad upgrade.
 */
import { type SemVer, compareSemver, parseSemver, satisfies } from "@crewhaus/tool-code";
import type { Ecosystem } from "./net";

export type RangeTranslation =
  | { readonly ok: true; readonly range: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The grammar one declaration is written in. Three of them follow from the
 * registry; `poetry` does not, which is exactly why it is named separately.
 */
export type RangeDialect = "npm" | "cargo" | "pep440" | "poetry";

/** What a registry means when nothing more specific is known about the site. */
export const DIALECT_BY_ECOSYSTEM: Readonly<Record<Ecosystem, RangeDialect>> = Object.freeze({
  npm: "npm",
  crates: "cargo",
  pypi: "pep440",
});

/**
 * A version string this package is willing to COMPARE.
 *
 * `parseSemver`'s pattern is unanchored on purpose — it has to read `1.2` and
 * `v1.2.3` out of lockfiles — which means it also silently reads `1.0rc1` as
 * `1.0.0` and `1.0.post1` as `1.0.0`. Both are ordinary PyPI versions, and
 * both would then sort as equal to `1.0`. Anything that is not plainly
 * semver-shaped is therefore excluded from ordering rather than guessed at;
 * build metadata is allowed because `parseSemver` ignoring it is correct.
 */
export function isSemverShaped(raw: string): boolean {
  return /^v?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(raw.trim());
}

/** Specifier prefixes that are a location, not a version. */
const NON_VERSION_PROTOCOL =
  /^(workspace|catalog|file|link|path|git|git\+[a-z]+|npm|jsr|https?|portal|patch):/i;

/**
 * Translate a declared dependency spec into the npm-shaped range that
 * `satisfies` evaluates, or say why it cannot be.
 *
 * This overload takes the registry and so assumes the registry's own dialect.
 * A spec read out of a manifest must go through `toNpmRangeIn` with the
 * dialect of the TABLE it was read from, because a pyproject.toml holds two.
 */
export function toNpmRange(ecosystem: Ecosystem, rawSpec: string): RangeTranslation {
  return toNpmRangeIn(DIALECT_BY_ECOSYSTEM[ecosystem], rawSpec);
}

export function toNpmRangeIn(dialect: RangeDialect, rawSpec: string): RangeTranslation {
  const spec = rawSpec.trim();
  if (spec === "") return { ok: false, reason: "the manifest declares no version constraint" };
  if (NON_VERSION_PROTOCOL.test(spec)) {
    return {
      ok: false,
      reason: `"${spec}" names a location, not a published version range`,
    };
  }
  if (dialect === "npm") return translateNpm(spec);
  if (dialect === "cargo") return translateCargo(spec);
  if (dialect === "poetry") return translatePoetry(spec);
  return translatePep440(spec);
}

function translateNpm(spec: string): RangeTranslation {
  if (spec.includes(" - ")) {
    // `1.2.3 - 2.3.4` is a hyphen range, which the shared evaluator does not
    // implement; it would otherwise be split on whitespace into comparators
    // that mean something else entirely.
    return { ok: false, reason: `hyphen ranges ("${spec}") are not evaluated here` };
  }
  if (/^[a-zA-Z][\w./-]*$/.test(spec) && spec !== "x") {
    return { ok: false, reason: `"${spec}" is a dist-tag or an alias, not a version range` };
  }
  return { ok: true, range: spec };
}

/**
 * Cargo requirements, whose one real difference from npm is the default
 * operator: a bare `1.2` is `^1.2`, not `=1.2`. Cargo also ANDs on commas
 * where npm ANDs on whitespace.
 */
function translateCargo(spec: string): RangeTranslation {
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, reason: "the requirement is empty" };
  const out: string[] = [];
  for (const part of parts) {
    if (part === "*") {
      out.push("*");
      continue;
    }
    if (/^[\^~=<>]/.test(part)) {
      out.push(part);
      continue;
    }
    if (/[*x]/.test(part)) {
      // `1.*` is a wildcard requirement; a caret in front of it would mean
      // something Cargo never wrote.
      out.push(part);
      continue;
    }
    if (!/^\d/.test(part)) {
      return { ok: false, reason: `"${part}" is not a Cargo version requirement` };
    }
    // Cargo's documented default. This is the translation that matters most:
    // `serde = "1"` allows 1.9.0, and reading it as npm would read it says it
    // does not.
    out.push(`^${part}`);
  }
  return { ok: true, range: out.join(" ") };
}

/**
 * PEP 440 version specifiers.
 *
 * Only the operators with an exact equivalent are translated. `!=` has no
 * negation in the evaluated grammar, `===` compares arbitrary strings, and a
 * version carrying an epoch (`1!2.0`) or a post/dev segment does not order
 * like semver — each of those comes back as a refusal rather than as a
 * comparator that means something else.
 */
function translatePep440(spec: string): RangeTranslation {
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, reason: "the specifier is empty" };
  const out: string[] = [];
  for (const part of parts) {
    const m = PEP440_CLAUSE.exec(part);
    if (m === null) {
      // Name the likely cause rather than only the symptom: a caret, a tilde
      // or a bare version here is almost always a Poetry constraint that
      // reached the PEP 440 reader, which is a bug in the caller, not in the
      // manifest.
      const poetryish = /^[\^~]\s*\d/.test(part) || part === "*" || /^v?\d/.test(part);
      return {
        ok: false,
        reason: poetryish
          ? `"${part}" is not a PEP 440 version specifier — it is a Poetry-style constraint, which only means something inside a [tool.poetry…] table`
          : `"${part}" is not a PEP 440 version specifier`,
      };
    }
    const op = m[1] as string;
    const version = (m[2] as string).trim();
    if (op === "!=" || op === "===") {
      return {
        ok: false,
        reason: `PEP 440 "${op}" has no equivalent in the range grammar this package evaluates`,
      };
    }
    if (version.includes("!")) {
      return { ok: false, reason: `version epochs ("${version}") do not order like semver` };
    }
    if (op === "==") {
      if (version.endsWith(".*")) {
        // `==1.4.*` is npm's `1.4.x`, which the evaluator does implement.
        out.push(version.replace(/\.\*$/, ".x"));
        continue;
      }
      if (!isSemverShaped(version)) {
        return { ok: false, reason: `"${version}" is not a version this package can order` };
      }
      out.push(`=${version}`);
      continue;
    }
    if (op === "~=") {
      // PEP 440's compatible release: `~=1.4.2` is `>=1.4.2, ==1.4.*`, and
      // `~=1.4` is `>=1.4, ==1.*`. Expanded rather than mapped onto npm's `~`,
      // which is `~=X.Y.Z` only and means something else for `~=X.Y`.
      const segments = version.split(".");
      if (segments.length < 2 || !isSemverShaped(version)) {
        return {
          ok: false,
          reason: `"~=${version}" needs at least two numeric segments to have a compatible release`,
        };
      }
      const upper = segments.slice(0, -1);
      const lastKept = Number(upper[upper.length - 1]);
      if (!Number.isFinite(lastKept)) {
        return { ok: false, reason: `"~=${version}" is not a numeric compatible release` };
      }
      upper[upper.length - 1] = String(lastKept + 1);
      while (upper.length < 3) upper.push("0");
      out.push(`>=${version}`, `<${upper.join(".")}`);
      continue;
    }
    if (!isSemverShaped(version)) {
      return { ok: false, reason: `"${version}" is not a version this package can order` };
    }
    out.push(`${op}${version}`);
  }
  return { ok: true, range: out.join(" ") };
}

const PEP440_CLAUSE = /^(===|==|!=|<=|>=|~=|<|>)\s*(.+)$/;

// ---------------------------------------------------------------------------
// Poetry
// ---------------------------------------------------------------------------

/**
 * A Poetry constraint's numeric core, with however many segments the AUTHOR
 * wrote. The count is the whole point: `^1.2` and `^1.2.0` mean the same
 * thing, but `^0.2` and `^0` do not, and neither does `~1` against `~1.0`.
 */
const POETRY_VERSION = /^v?(\d+(?:\.\d+)*)((?:[-+][0-9A-Za-z.-]+)?)$/;

function poetrySegments(version: string): number[] | undefined {
  const m = POETRY_VERSION.exec(version);
  if (m === null) return undefined;
  const segments = (m[1] as string).split(".").map(Number);
  // A segment past 2^53 is still `\d+` to the pattern, but stops being an
  // integer the moment it is a Number — the bound would then be computed by
  // adding one to a rounded value, which changes nothing.
  return segments.some((n) => !Number.isSafeInteger(n)) ? undefined : segments;
}

/** `[1, 2]` → `1.3.0`, with `index` incremented and everything after it zeroed. */
function bumpedBound(segments: readonly number[], index: number): string {
  const out = segments.slice(0, index + 1);
  out[index] = (out[index] as number) + 1;
  while (out.length < 3) out.push(0);
  return out.join(".");
}

/**
 * One Poetry constraint, as the comparators `satisfies` evaluates.
 *
 * Poetry's caret and tilde are expanded to explicit bounds rather than handed
 * to the shared `^`/`~` comparators, because those read the version as three
 * segments: `^0` would arrive as `^0.0.0` and pin the patch, and `~1` as
 * `~1.0.0` and pin the minor. Poetry documents both as widening to the next
 * whole segment the author wrote, so the bound is computed from the segments
 * that are actually there.
 */
function poetryClause(part: string): RangeTranslation {
  if (part === "*") return { ok: true, range: "*" };
  const wildcard = /^v?(\d+(?:\.\d+)?)\.\*$/.exec(part);
  if (wildcard !== null) return { ok: true, range: `${wildcard[1]}.x` };

  const operator = /^(\^|~=|~|>=|<=|==|=|!=|<|>)\s*(.+)$/.exec(part);
  const op = operator === null ? "" : (operator[1] as string);
  const version = (operator === null ? part : (operator[2] as string)).trim();

  if (op === "!=") {
    return {
      ok: false,
      reason: `Poetry "!=" has no negation in the range grammar this package evaluates`,
    };
  }
  if (op === "~=") {
    // Poetry accepts PEP 440 specifiers alongside its own; hand this one to
    // the reader that already implements it rather than growing a second
    // compatible-release expansion that can drift from it.
    return translatePep440(part);
  }
  // This is also what keeps a four-segment PEP 440 release out: `parseSemver`
  // reads `1.2.3.4` as 1.2.3, so a caret bound computed from it would be a
  // whole release series out.
  if (!isSemverShaped(version)) {
    return { ok: false, reason: `"${version}" is not a version this package can order` };
  }
  const segments = poetrySegments(version);
  if (segments === undefined) {
    return { ok: false, reason: `"${version}" is not a version this package can order` };
  }

  if (op === "^") {
    // The first non-zero segment the author wrote is the one held fixed:
    // `^1.2.3` → <2.0.0, `^0.2.3` → <0.3.0, `^0.0.3` → <0.0.4. All-zero has
    // no such segment, so the last one written moves: `^0` → <1.0.0.
    const firstNonZero = segments.findIndex((n) => n !== 0);
    const pivot = firstNonZero === -1 ? segments.length - 1 : firstNonZero;
    return { ok: true, range: `>=${version} <${bumpedBound(segments, pivot)}` };
  }
  if (op === "~") {
    // `~1.2.3` and `~1.2` allow patch-level change; `~1` allows minor-level.
    const pivot = segments.length >= 2 ? 1 : 0;
    return { ok: true, range: `>=${version} <${bumpedBound(segments, pivot)}` };
  }
  if (op === "" || op === "=" || op === "==") {
    // A bare version in a Poetry table is an exact pin, not a floor.
    return { ok: true, range: `=${version}` };
  }
  return { ok: true, range: `${op}${version}` };
}

/**
 * Poetry's dependency constraints: caret, tilde, wildcard, the inequalities,
 * an exact bare version, `,` for AND and `||` for OR.
 *
 * This is NOT PEP 440, and that is the trap it exists to close. `^2.31` and a
 * bare `2.31` are the two most common things in any `[tool.poetry.…]` table,
 * and a PEP 440 reader rejects both — so a Poetry project read with the wrong
 * dialect produces a table where every row is unevaluable and the outdated
 * count is zero.
 */
function translatePoetry(spec: string): RangeTranslation {
  const alternatives = spec
    .split("||")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  if (alternatives.length === 0) return { ok: false, reason: "the constraint is empty" };
  const rendered: string[] = [];
  for (const alternative of alternatives) {
    const parts = alternative
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (parts.length === 0) return { ok: false, reason: "the constraint is empty" };
    const out: string[] = [];
    for (const part of parts) {
      const clause = poetryClause(part);
      if (!clause.ok) return clause;
      out.push(clause.range);
    }
    rendered.push(out.join(" "));
  }
  return { ok: true, range: rendered.join("||") };
}

export type Satisfaction = boolean | undefined;

/** Does one published version satisfy a translated range? */
export function versionSatisfies(version: string, npmRange: string): Satisfaction {
  if (!isSemverShaped(version)) return undefined;
  return satisfies(version, npmRange);
}

/**
 * The highest published version the declared range allows — what an install
 * into this manifest would pick, as opposed to what the registry calls latest.
 *
 * Prereleases are skipped unless the caller asks for them or the range itself
 * names one, which is npm's rule and the least surprising of the available
 * ones.
 */
export function highestSatisfying(
  versions: readonly string[],
  npmRange: string,
  includePrerelease = false,
): string | undefined {
  const rangeNamesPrerelease = /\d-[0-9A-Za-z]/.test(npmRange);
  let best: { raw: string; parsed: SemVer } | undefined;
  for (const raw of versions) {
    if (!isSemverShaped(raw)) continue;
    const parsed = parseSemver(raw);
    if (parsed === undefined) continue;
    if (parsed.prerelease !== "" && !includePrerelease && !rangeNamesPrerelease) continue;
    if (satisfies(raw, npmRange) !== true) continue;
    if (best === undefined || compareSemver(parsed, best.parsed) > 0) best = { raw, parsed };
  }
  return best?.raw;
}

/** The highest version in a list, ignoring anything that does not order. */
export function highestVersion(
  versions: readonly string[],
  includePrerelease = false,
): string | undefined {
  let best: { raw: string; parsed: SemVer } | undefined;
  for (const raw of versions) {
    if (!isSemverShaped(raw)) continue;
    const parsed = parseSemver(raw);
    if (parsed === undefined) continue;
    if (parsed.prerelease !== "" && !includePrerelease) continue;
    if (best === undefined || compareSemver(parsed, best.parsed) > 0) best = { raw, parsed };
  }
  return best?.raw;
}

/**
 * Newest first, by version order rather than string order.
 *
 * `["1.9.0", "1.10.0"].sort()` puts 1.10.0 FIRST ascending and last
 * descending, because "1" sorts before "9" — so a list labelled "newest
 * first" would put the older release at the top for every package that has
 * reached a two-digit minor. Versions that do not order (a PyPI post-release,
 * a calendar string) keep a stable place at the end in string order, so the
 * list is deterministic either way.
 */
export function sortVersionsDescending(versions: readonly string[]): string[] {
  const orderable: Array<{ raw: string; parsed: SemVer }> = [];
  const rest: string[] = [];
  for (const raw of versions) {
    const parsed = isSemverShaped(raw) ? parseSemver(raw) : undefined;
    if (parsed === undefined) rest.push(raw);
    else orderable.push({ raw, parsed });
  }
  orderable.sort((a, b) => compareSemver(b.parsed, a.parsed));
  rest.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return [...orderable.map((v) => v.raw), ...rest];
}

export type VersionDelta = "same" | "patch" | "minor" | "major" | "prerelease" | "downgrade";

/**
 * How far apart two versions are, in the terms a reviewer decides with.
 * `undefined` when either side does not order as semver — a PyPI calendar
 * version against a post-release, say — because "unknown" is a usable answer
 * and "patch" would not be.
 */
export function versionDelta(from: string, to: string): VersionDelta | undefined {
  if (!isSemverShaped(from) || !isSemverShaped(to)) return undefined;
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (a === undefined || b === undefined) return undefined;
  const cmp = compareSemver(a, b);
  if (cmp === 0) return "same";
  if (cmp > 0) return "downgrade";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  return "prerelease";
}
