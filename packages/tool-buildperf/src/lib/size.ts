/**
 * Artifact size, and the single condition that makes two sizes comparable.
 *
 * Compressing bytes is the easy half. The half that costs a team a morning is
 * comparability: a gzip size is not a property of a file, it is a property of
 * a file AND the compressor settings. Level 6 against level 9 on the same
 * bundle differs by several percent — the same order as the regression anyone
 * is looking for — so a baseline produced at one level and a head measured at
 * another produce a confident, entirely fabricated "+4.1%". Every number this
 * module produces therefore travels with the parameters that produced it, and
 * `parametersMismatch` exists so the caller can refuse rather than subtract.
 *
 * Nothing here is statistical. Compression at fixed parameters is
 * deterministic, so a one-byte difference is a real one-byte difference and
 * there is no noise floor to declare. That is the whole reason size gating is
 * a different shape of problem from benchmark gating, which is next door in
 * `./bench`.
 */
import { constants as zlib, brotliCompressSync, gzipSync } from "node:zlib";

export const COMPRESSION_ALGORITHMS = ["none", "gzip", "brotli"] as const;
export type CompressionAlgorithm = (typeof COMPRESSION_ALGORITHMS)[number];

/**
 * Everything that determines the compressed byte count, stated rather than
 * assumed.
 *
 * `tuning` carries the settings below the level that also move the output —
 * zlib's memLevel and strategy, brotli's window and mode. They are pinned
 * explicitly when compressing instead of left to the library defaults,
 * because a default that changes under a runtime upgrade would silently make
 * old baselines incomparable while still LOOKING comparable.
 */
export type CompressionParameters = {
  readonly algorithm: CompressionAlgorithm;
  /** Compression level; `null` only for `none`, where there is no level. */
  readonly level: number | null;
  readonly tuning: Readonly<Record<string, number>>;
};

export class SizeError extends Error {
  override readonly name = "SizeError";
}

/** zlib's own default is 6; bundler size reporters quote level 9, so that is the default here. */
const GZIP_DEFAULT_LEVEL = 9;
/** Brotli's maximum quality, which is what every published "brotli size" means. */
const BROTLI_DEFAULT_LEVEL = 11;

/**
 * Fill in and validate the parameters for a run.
 *
 * A level outside the algorithm's range is a refusal, not a clamp: gzip
 * silently accepting 11 (a brotli quality) and compressing at 9 would produce
 * a report claiming a level it did not use, which is the exact failure this
 * module exists to prevent.
 */
export function compressionParameters(
  algorithm: CompressionAlgorithm,
  level?: number,
): CompressionParameters {
  if (algorithm === "none") {
    if (level !== undefined) {
      throw new SizeError(`algorithm "none" does not compress, so it has no level (got ${level})`);
    }
    return { algorithm, level: null, tuning: {} };
  }
  const max = algorithm === "gzip" ? 9 : 11;
  const chosen = level ?? (algorithm === "gzip" ? GZIP_DEFAULT_LEVEL : BROTLI_DEFAULT_LEVEL);
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > max) {
    throw new SizeError(
      `${algorithm} levels run 0-${max}, got ${chosen}${
        algorithm === "gzip" && chosen > 9
          ? " — 10 and 11 are brotli qualities, not gzip levels"
          : ""
      }`,
    );
  }
  return algorithm === "gzip"
    ? {
        algorithm,
        level: chosen,
        // memLevel and strategy move the output too; pinned so the recorded
        // pair (algorithm, level) really does determine the byte count.
        tuning: { memLevel: 8, strategy: zlib.Z_DEFAULT_STRATEGY as number, windowBits: 15 },
      }
    : {
        algorithm,
        level: chosen,
        tuning: { lgwin: 22, mode: zlib.BROTLI_MODE_GENERIC as number },
      };
}

/**
 * The string two parameter sets must agree on for a comparison to mean
 * anything. Sorted, so key order in a stored baseline cannot change it.
 */
export function comparabilityKey(p: CompressionParameters): string {
  const tuning = Object.keys(p.tuning)
    .sort()
    .map((k) => `${k}=${p.tuning[k]}`)
    .join(",");
  return `${p.algorithm}/level=${p.level ?? "n/a"}${tuning === "" ? "" : `/${tuning}`}`;
}

/**
 * Why these two sets of parameters cannot be compared, or `null` when they
 * can. The message names the fields that differ, because "incomparable" on
 * its own sends the reader to the source.
 */
export function parametersMismatch(
  baseline: CompressionParameters,
  head: CompressionParameters,
): string | null {
  if (baseline.algorithm !== head.algorithm) {
    return `the baseline was measured with ${baseline.algorithm} and this run used ${head.algorithm}; compressed sizes from two algorithms are different measurements, not a change`;
  }
  if (baseline.level !== head.level) {
    return `the baseline was measured at ${baseline.algorithm} level ${baseline.level} and this run at level ${head.level}; the difference between two levels is several percent on typical bundles, which would read as a regression that did not happen`;
  }
  const differing = [...new Set([...Object.keys(baseline.tuning), ...Object.keys(head.tuning)])]
    .filter((k) => baseline.tuning[k] !== head.tuning[k])
    .sort();
  if (differing.length > 0) {
    return `the baseline and this run disagree on ${differing
      .map((k) => `${k} (${baseline.tuning[k] ?? "unset"} vs ${head.tuning[k] ?? "unset"})`)
      .join(", ")}; those settings change the compressed size, so the two are not comparable`;
  }
  return null;
}

/**
 * Why this baseline's ENTRIES cannot be differenced against a run measured
 * under `algorithm`, or `null` when they can.
 *
 * `parametersMismatch` guards the compressor settings. This guards the
 * column. Every entry carries two numbers — a raw size and a compressed one —
 * and which of them a delta is taken on is decided by the algorithm, so a
 * baseline that declares gzip but stores no `compressedBytes` makes the
 * obvious `compressed ?? raw` fallback subtract a gzip size from a raw one.
 * That lands near -70% on real bundles: not a number a reader distrusts, a
 * number a reader celebrates, and it hides whatever the change actually did.
 * The reverse — a compressed column under algorithm "none" — fabricates a
 * regression the same way, so both directions are refused rather than
 * silently filled in.
 */
export function baselineBasisMismatch(
  algorithm: CompressionAlgorithm,
  entries: ReadonlyArray<{ readonly path: string; readonly compressedBytes?: number | null }>,
): string | null {
  if (entries.length === 0) return null;
  const compresses = algorithm !== "none";
  const offenders = entries
    .filter((e) => ((e.compressedBytes ?? null) === null) === compresses)
    .map((e) => e.path);
  if (offenders.length === 0) return null;
  const named = offenders.slice(0, 5).join(", ");
  const more = offenders.length > 5 ? `, and ${offenders.length - 5} more` : "";
  return compresses
    ? `the baseline declares ${algorithm} but has no compressedBytes on ${offenders.length} of its ${entries.length} entries (${named}${more}); this run's sizes are compressed, so pairing them would subtract a compressed size from a raw one and report a saving of roughly the compression ratio. Re-record it from a report of this tool`
    : `the baseline declares algorithm "none" but carries a compressedBytes on ${offenders.length} of its ${entries.length} entries (${named}${more}), and this run measured raw bytes; the two columns are different measurements, not a change`;
}

/** Compressed byte count under `parameters`; the raw length for `none`. */
export function compressedSize(bytes: Buffer, parameters: CompressionParameters): number {
  if (parameters.algorithm === "none") return bytes.byteLength;
  if (parameters.algorithm === "gzip") {
    return gzipSync(bytes, {
      level: parameters.level ?? GZIP_DEFAULT_LEVEL,
      memLevel: parameters.tuning["memLevel"] ?? 8,
      strategy: parameters.tuning["strategy"] ?? (zlib.Z_DEFAULT_STRATEGY as number),
      windowBits: parameters.tuning["windowBits"] ?? 15,
    }).byteLength;
  }
  return brotliCompressSync(bytes, {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: parameters.level ?? BROTLI_DEFAULT_LEVEL,
      [zlib.BROTLI_PARAM_LGWIN]: parameters.tuning["lgwin"] ?? 22,
      [zlib.BROTLI_PARAM_MODE]: parameters.tuning["mode"] ?? (zlib.BROTLI_MODE_GENERIC as number),
      // SIZE_HINT is deliberately not set. It improves the ratio and is what a
      // bundler passes, but it makes the output depend on a value the caller
      // never sees, so two tools measuring "the brotli size" would disagree.
    },
  }).byteLength;
}

// --- joining a hashed build against a baseline ------------------------------

export const JOIN_MODES = ["exact", "auto", "custom"] as const;
export type JoinMode = (typeof JOIN_MODES)[number];

/**
 * Whether a filename segment looks like a content hash rather than a name.
 *
 * Deliberately conservative in one direction only: `chunk`, `min`, `esm` and
 * `vendor` must never be eaten, because normalizing a real name merges two
 * different artifacts into one row. Pure hex needs 6 characters (webpack's
 * shortest common `[contenthash:6]`); a mixed alphabet needs 8 AND both a
 * digit and a letter (Vite's base64url ids, e.g. `BXaGz2Qm`). A lowercase
 * word of 6+ letters that happens to be all hex — `decade`, `defaced` — is
 * the known false positive, which is why every entry reports the key it was
 * joined on rather than just the delta.
 */
export function looksLikeHash(segment: string): boolean {
  if (!/^[0-9a-zA-Z_]+$/.test(segment)) return false;
  if (/^[0-9a-f]{6,}$/i.test(segment)) return true;
  return segment.length >= 8 && /[0-9]/.test(segment) && /[a-zA-Z]/.test(segment);
}

export type JoinKeyResult = { readonly key: string; readonly normalized: boolean };

/**
 * The key an entry joins on.
 *
 * `exact` is the default and joins on the path as written. It is the right
 * choice for a build with stable filenames and the wrong one for a hashed
 * build, where it matches NOTHING on every run — which reads as "every file
 * is new", not as "the join is broken". `auto` strips hash-shaped segments
 * from the basename; `custom` applies the caller's own pattern, which is the
 * escape hatch for a bundler whose scheme the heuristic does not recognise.
 */
export function joinKey(path: string, mode: JoinMode, custom?: RegExp): JoinKeyResult {
  if (mode === "exact") return { key: path, normalized: false };
  if (mode === "custom") {
    if (custom === undefined) throw new SizeError('join mode "custom" needs a pattern');
    const key = path.replace(custom, "[hash]");
    return { key, normalized: key !== path };
  }
  const cut = path.lastIndexOf("/");
  const dir = cut === -1 ? "" : path.slice(0, cut + 1);
  const base = path.slice(cut + 1);
  // Split on both separators at once: `app-4f2a1c.js` (Vite, Rollup) and
  // `app.4f2a1c.js` (webpack) are the same idea with a different delimiter,
  // and a build can contain both.
  const parts = base.split(/([.-])/);
  let normalized = false;
  const rebuilt = parts.map((part, i) => {
    // Odd indices are the captured separators; index 0 is the stem, which is
    // never a hash on its own — `4f2a1c.js` as a whole filename carries no
    // other identity, and blanking it would merge every such file.
    if (i === 0 || i % 2 === 1) return part;
    if (!looksLikeHash(part)) return part;
    normalized = true;
    return "[hash]";
  });
  return { key: `${dir}${rebuilt.join("")}`, normalized };
}

// --- budgets ----------------------------------------------------------------

/**
 * One glob dialect, chosen and documented, because the three config formats a
 * project might already have (`.size-limit.json`, `bundlesize`, the `size`
 * field some packages carry) disagree about what a bare `*` crosses. Here:
 * `*` matches within one path segment, `**` crosses segments, `?` is one
 * character, and everything else is literal.
 */
type GlobToken =
  /** A run of literal characters, merged so the token count stays near the
   * number of wildcards rather than the pattern's length. */
  | { readonly kind: "literal"; readonly text: string }
  /** `?` — exactly one character, never `/`. */
  | { readonly kind: "one" }
  /** `*` — any run of characters within one segment. */
  | { readonly kind: "segment" }
  /** `**` — any run at all. */
  | { readonly kind: "any" }
  /** `**\/` — nothing, or a run ending at a separator, so `**\/*.js` covers `a.js`. */
  | { readonly kind: "anyDir" };

/**
 * Long enough for any real budget, short enough that the matcher's recursion
 * depth (one frame per token) cannot reach the stack limit.
 */
export const MAX_GLOB_LENGTH = 512;

function tokenizeGlob(pattern: string): GlobToken[] {
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new SizeError(
      `glob pattern is ${pattern.length} characters, over the ${MAX_GLOB_LENGTH}-character limit; a budget pattern that long is not a path shape`,
    );
  }
  const tokens: GlobToken[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      flush();
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          tokens.push({ kind: "anyDir" });
          i += 2;
          continue;
        }
        tokens.push({ kind: "any" });
        i += 1;
        continue;
      }
      tokens.push({ kind: "segment" });
      continue;
    }
    if (ch === "?") {
      flush();
      tokens.push({ kind: "one" });
      continue;
    }
    literal += ch;
  }
  flush();
  return tokens;
}

export type GlobMatcher = (path: string) => boolean;

/**
 * Compile a pattern once, match many paths with it.
 *
 * This deliberately does NOT compile to a regular expression. `*` and `**`
 * become `[^/]*` and `.*`, and a backtracking engine handed several of those
 * separated by literals explores every way of splitting the string between
 * them: `*a*a*a…*b` — a 49-character pattern — against sixty `a`s does not
 * finish, and a budget pattern is caller-supplied. The state here is only
 * (token index, offset in the path), so memoising it bounds the search at
 * tokens x length cells no matter how the wildcards are arranged.
 *
 * Callers with many paths should hold the matcher: recompiling per path
 * multiplies the tokenizer by the size of the build.
 */
export function compileGlob(pattern: string): GlobMatcher {
  const tokens = tokenizeGlob(pattern);
  const width = tokens.length;
  return (path: string): boolean => {
    const n = path.length;
    const stride = n + 1;
    // 0 = not yet answered, 1 = no, 2 = yes. `match` only ever descends to a
    // higher token index, so a cell can never be re-entered while it is being
    // computed and there is no need for an "in progress" state.
    const memo = new Uint8Array((width + 1) * stride);
    const match = (j: number, i: number): boolean => {
      const cell = j * stride + i;
      const cached = memo[cell];
      if (cached !== 0) return cached === 2;
      let answer: boolean;
      if (j === width) {
        answer = i === n;
      } else {
        const token = tokens[j] as GlobToken;
        switch (token.kind) {
          case "literal":
            answer = path.startsWith(token.text, i) && match(j + 1, i + token.text.length);
            break;
          case "one":
            answer = i < n && path[i] !== "/" && match(j + 1, i + 1);
            break;
          case "segment": {
            answer = false;
            for (let k = i; ; k++) {
              if (match(j + 1, k)) {
                answer = true;
                break;
              }
              // A segment wildcard stops at the separator it is not allowed to
              // cross, which is what makes `*.js` miss `dist/app.js`.
              if (k >= n || path[k] === "/") break;
            }
            break;
          }
          case "any": {
            answer = false;
            for (let k = i; k <= n; k++) {
              if (match(j + 1, k)) {
                answer = true;
                break;
              }
            }
            break;
          }
          case "anyDir": {
            answer = match(j + 1, i);
            for (let k = i; !answer && k < n; k++) {
              if (path[k] === "/") answer = match(j + 1, k + 1);
            }
            break;
          }
        }
      }
      memo[cell] = answer ? 2 : 1;
      return answer;
    };
    return match(0, 0);
  };
}

export function globMatch(pattern: string, path: string): boolean {
  return compileGlob(pattern)(path);
}
