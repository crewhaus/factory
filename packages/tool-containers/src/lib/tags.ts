/**
 * Tag lists: paging, filtering, and the sort that makes them readable.
 *
 * Real tag lists are mostly not semver. A typical repository holds `latest`,
 * `edge`, `sha-9f3c1a`, `0.6`, `v0.6.0-rc.1` and `3.19-alpine` side by side, so
 * a sort that assumes semver either throws or silently reorders the half it
 * could not read. This one partitions: versions ordered by semver precedence
 * first, everything else after it in plain lexicographic order, and nothing
 * throws on a tag it cannot parse.
 */

import { isValidTag } from "./ref";

export class TagListError extends Error {
  override readonly name = "TagListError";
}

export type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `null` for a release; an identifier list for a prerelease. */
  readonly prerelease: readonly string[] | null;
};

/**
 * Parse a tag as a version, tolerating the two things registries do that
 * semver does not: a leading `v`, and a truncated version (`0.6`, `3`).
 * Build metadata is accepted and ignored for precedence, exactly as semver
 * says, but the tag string itself still breaks ties so the sort stays total.
 */
export function parseTagVersion(tag: string): ParsedVersion | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
    tag,
  );
  if (!m) return null;
  const prerelease = m[4] === undefined ? null : m[4].split(".");
  return {
    major: Number.parseInt(m[1] as string, 10),
    minor: m[2] === undefined ? 0 : Number.parseInt(m[2], 10),
    patch: m[3] === undefined ? 0 : Number.parseInt(m[3], 10),
    prerelease,
  };
}

/** Semver §11 precedence. Returns <0, 0 or >0. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A release outranks any prerelease of the same version: 1.0.0 > 1.0.0-rc.1.
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // A shorter identifier list is lower precedence when all earlier ones tie.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (diff !== 0) return diff;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type TagSort = "semver" | "name" | "registry";

/**
 * Order a tag list.
 *
 * `semver` is newest-first, because that is the question people actually have
 * ("what is the latest?"), with unparseable tags collected at the end rather
 * than interleaved by a guess. `name` is lexicographic ascending. `registry`
 * preserves the order the registry returned, which for most registries is the
 * order tags were pushed and for some is nothing in particular.
 */
export function sortTags(tags: readonly string[], sort: TagSort): string[] {
  if (sort === "registry") return [...tags];
  if (sort === "name") return [...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const versions = new Map<string, ParsedVersion | null>();
  for (const tag of tags) versions.set(tag, parseTagVersion(tag));
  return [...tags].sort((a, b) => {
    const va = versions.get(a) ?? null;
    const vb = versions.get(b) ?? null;
    if (va !== null && vb !== null) {
      const byPrecedence = compareVersions(vb, va); // descending: newest first
      return byPrecedence !== 0 ? byPrecedence : a < b ? -1 : a > b ? 1 : 0;
    }
    if (va !== null) return -1;
    if (vb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Compile a glob into a matcher. Only `*` and `?` are special.
 *
 * This is deliberately NOT a regex. `*` compiles to `[^]*`, and `^[^]*a[^]*a…$`
 * is the textbook catastrophic backtracker: against a tag of n characters an
 * 8-wildcard pattern costs C(n, 8) steps — for a full-length 128-character tag
 * that is ~10^12, hours of CPU inside one synchronous `RegExp.test` that
 * neither `timeoutMs` nor `ctx.signal` can interrupt, because both only
 * unblock between awaits. The two-pointer glob match below is the standard
 * O(pattern x tag) algorithm with one backtrack point, so the worst case is
 * bounded by the product rather than by a binomial.
 *
 * Comparison is by code point, so `?` means one character rather than one
 * UTF-16 unit — the regex version needed two `?` to match an astral character.
 */
export function compileGlob(pattern: string): (value: string) => boolean {
  const pat = [...pattern];
  return (value) => globMatch(pat, [...value]);
}

function globMatch(pat: readonly string[], text: readonly string[]): boolean {
  let p = 0;
  let t = 0;
  // The last `*` seen, and how much of the text it had consumed at the time.
  // Re-entering there is the only backtrack this matcher ever performs.
  let star = -1;
  let starText = 0;
  while (t < text.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === text[t])) {
      p++;
      t++;
    } else if (p < pat.length && pat[p] === "*") {
      star = p;
      starText = t;
      p++;
    } else if (star !== -1) {
      starText++;
      t = starText;
      p = star + 1;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

export function filterTags(tags: readonly string[], pattern: string | undefined): string[] {
  if (pattern === undefined || pattern === "") return [...tags];
  const match = compileGlob(pattern);
  return tags.filter((t) => match(t));
}

export type TagsPage = {
  readonly tags: readonly string[];
  /** Entries that were not tags. Counted, never silently discarded. */
  readonly malformed: number;
};

/**
 * Read the `tags` array out of a `/tags/list` response. Registries have shipped
 * `"tags": null` for an empty repository, which is not what the spec says and
 * is exactly the shape that turns into `Cannot read properties of null`.
 *
 * Entries outside the tag grammar are DROPPED here rather than carried
 * downstream, because the rest of the package treats this array as trusted and
 * it is not: it is the one place where a string the registry chose becomes a
 * URL path (`withDigests`) and a regex subject (`match`). A registry that says
 * its tags include `../../victim/manifests/latest`, or a 4 KB string, is not
 * describing something anyone can pull. The count is reported, so the answer
 * still says the registry sent something odd.
 */
export function readTagsPage(document: Record<string, unknown>): TagsPage {
  const raw = document["tags"];
  if (raw === null || raw === undefined) return { tags: [], malformed: 0 };
  if (!Array.isArray(raw))
    throw new TagListError("tags/list response has a non-array 'tags' field");
  const tags: string[] = [];
  let malformed = 0;
  for (const entry of raw) {
    if (typeof entry === "string" && isValidTag(entry)) tags.push(entry);
    else malformed++;
  }
  return { tags, malformed };
}

/**
 * Follow RFC 5988 paging — with the link kept on the registry's own origin.
 *
 * The `Link` header is server-controlled: a registry that answers page 1 with
 * `Link: <https://evil.example/v2/...>; rel="next"` would otherwise have the
 * client walk off to a host the caller never named, carrying an Accept header
 * and a request pattern that says which images are being audited. Same origin
 * or we stop and say why.
 */
export function nextPageUrl(header: string | null, base: URL): URL | null {
  if (header === null || header.trim() === "") return null;
  for (const part of splitLinks(header)) {
    const m = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
    if (!m) continue;
    const params = m[2] as string;
    if (!/\brel\s*=\s*"?next"?/i.test(params)) continue;
    let url: URL;
    try {
      url = new URL(m[1] as string, base);
    } catch {
      throw new TagListError(`registry sent an unparseable Link header: ${header}`);
    }
    if (url.origin !== base.origin) {
      throw new TagListError(
        `registry's next-page Link points at ${url.origin}, not ${base.origin} — refusing to follow paging off the registry`,
      );
    }
    return url;
  }
  return null;
}

/** Split a Link header on commas that separate entries, not ones inside <> or "". */
function splitLinks(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inAngle = false;
  let inQuote = false;
  for (const ch of header) {
    if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    else if (ch === '"') inQuote = !inQuote;
    if (ch === "," && !inAngle && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}
