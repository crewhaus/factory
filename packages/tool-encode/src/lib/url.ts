/**
 * URLs: taking them apart, putting them back together, and canonicalizing
 * them so two spellings of the same resource compare equal.
 *
 * Every function here is built on the platform's WHATWG `URL`, which is the
 * same parser browsers and servers use, so the results agree with what a
 * request would actually do. That choice carries the WHATWG semantics with
 * it, and they are worth stating plainly:
 *
 *   - the scheme and host are lowercased, and an international host is
 *     converted to punycode;
 *   - a default port for the scheme (80/http, 443/https, 21/ftp, 25/smtp-ish
 *     special schemes) is dropped;
 *   - `.` and `..` path segments are resolved;
 *   - percent-encoding is normalized only where the parser must touch it, so
 *     `%7E` is NOT rewritten to `~`; unreserved-character decoding is out of
 *     scope here on purpose, because it is not safe for every component.
 *
 * Non-special schemes (`mailto:`, `urn:`, custom app schemes) parse, but their
 * host and path semantics are the URL standard's, not this module's.
 */

export type UrlParts = {
  /** The canonical URL, with any password replaced by `***`. */
  href: string;
  scheme: string;
  username: string;
  /** Masked: a password in a URL should not be copied into a transcript. */
  password: string | null;
  host: string;
  hostname: string;
  port: number | null;
  origin: string;
  path: string;
  pathSegments: string[];
  query: string;
  params: Array<{ key: string; value: string }>;
  fragment: string;
};

/** Parse a URL into its parts. Throws a legible error on an unparseable input. */
export function parseUrl(input: string, base?: string): UrlParts {
  let url: URL;
  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    throw new Error(
      `"${input}" is not a valid URL${base === undefined ? " — a relative reference needs a base" : ` relative to "${base}"`}`,
    );
  }
  // A password in the URL is replaced everywhere it appears, `href` included:
  // masking one field while echoing the credential in another is not masking.
  const hasPassword = url.password !== "";
  let href = url.href;
  if (hasPassword) {
    const masked = new URL(url.href);
    masked.password = "***";
    href = masked.href;
  }
  return {
    href,
    scheme: url.protocol.replace(/:$/, ""),
    username: url.username,
    password: url.password === "" ? null : "***",
    host: url.host,
    hostname: url.hostname,
    port: url.port === "" ? null : Number(url.port),
    origin: url.origin,
    path: url.pathname,
    pathSegments: url.pathname.split("/").filter((segment) => segment !== ""),
    query: url.search.replace(/^\?/, ""),
    params: [...url.searchParams.entries()].map(([key, value]) => ({ key, value })),
    fragment: url.hash.replace(/^#/, ""),
  };
}

export type UrlBuildParts = {
  scheme: string;
  host: string;
  port?: number;
  path?: string;
  params?: Array<{ key: string; value: string }>;
  fragment?: string;
  username?: string;
  password?: string;
};

/**
 * Assemble a URL from parts, percent-encoding each one for the component it
 * lands in. Building a URL by string concatenation is how a query value with
 * an `&` in it turns into two parameters; this is the fix.
 */
export function buildUrl(parts: UrlBuildParts): string {
  const scheme = parts.scheme.replace(/:$/, "").toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error(`"${parts.scheme}" is not a scheme`);
  if (parts.host.trim() === "") throw new Error("host is empty");
  let url: URL;
  try {
    url = new URL(`${scheme}://${parts.host}`);
  } catch {
    throw new Error(`"${parts.host}" is not a valid host`);
  }
  if (parts.port !== undefined) url.port = String(parts.port);
  if (parts.path !== undefined && parts.path !== "") {
    url.pathname = parts.path.startsWith("/") ? parts.path : `/${parts.path}`;
  }
  if (parts.username !== undefined) url.username = parts.username;
  if (parts.password !== undefined) url.password = parts.password;
  for (const { key, value } of parts.params ?? []) url.searchParams.append(key, value);
  if (parts.fragment !== undefined && parts.fragment !== "") url.hash = parts.fragment;
  return url.href;
}

export type NormalizeOptions = {
  sortQuery?: boolean;
  stripFragment?: boolean;
  stripTrailingSlash?: boolean;
  stripWww?: boolean;
  stripAuth?: boolean;
  /** Parameter names to drop; a trailing `*` matches a prefix, e.g. `utm_*`. */
  removeParams?: ReadonlyArray<string>;
};

/**
 * Order two strings by UTF-16 code unit — the comparison `<` performs.
 * `localeCompare` is deliberately avoided: its ordering comes from the
 * runtime's default locale, so a normalized URL (and any cache key built from
 * one) would differ between a machine running under `en-US` and one running
 * under `sv-SE`. A canonical form has to be a function of the URL alone.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesAny(name: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );
}

/**
 * Canonicalize a URL so two spellings of the same resource compare equal.
 *
 * On top of what the URL parser already does (lowercased scheme and host,
 * default port dropped, dot segments resolved), this optionally sorts query
 * parameters, drops tracking parameters, and removes the fragment, the `www.`
 * label, credentials and a trailing slash.
 *
 * The query sort is by UTF-16 code unit, not by locale, so the canonical form
 * is the same on every machine. Sorting is safe for comparison and for most
 * servers, but it is not universally safe: a signed URL whose signature covers
 * the parameter order will break. Leave `sortQuery` off for signed URLs.
 */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`"${input}" is not a valid absolute URL`);
  }
  if (options.stripAuth ?? false) {
    url.username = "";
    url.password = "";
  }
  if (options.stripFragment ?? false) url.hash = "";
  if ((options.stripWww ?? false) && url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }
  const remove = options.removeParams ?? [];
  if (remove.length > 0) {
    for (const key of [...url.searchParams.keys()]) {
      if (matchesAny(key, remove)) url.searchParams.delete(key);
    }
  }
  if (options.sortQuery ?? true) {
    const entries = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
      a === b ? byCodeUnit(av, bv) : byCodeUnit(a, b),
    );
    url.search = "";
    for (const [key, value] of entries) url.searchParams.append(key, value);
  }
  if ((options.stripTrailingSlash ?? false) && url.pathname !== "/" && url.pathname.endsWith("/")) {
    // The slash that IS the path ("https://host/") stays; a trailing slash on
    // a deeper path is the spelling difference this option exists to remove.
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  const href = url.href;
  // An empty query renders as a bare "?", which is noise when comparing. Only
  // the "?" that introduces the (empty) query may go: a "?" inside the
  // fragment is fragment text, and removing it would change the URL.
  if (url.search !== "" && url.search !== "?") return href;
  const hash = url.hash;
  const beforeHash = hash === "" ? href : href.slice(0, href.length - hash.length);
  return beforeHash.endsWith("?") ? beforeHash.slice(0, -1) + hash : href;
}

export type UrlEncodeMode = "component" | "uri" | "form";

/** A high surrogate with no low after it, or a low with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Percent-encode text for a URL.
 *
 * - `component` — `encodeURIComponent`: everything but `A-Za-z0-9-_.!~*'()`.
 *   Use for one query value or one path segment.
 * - `uri` — `encodeURI`: leaves `:/?#[]@!$&'()*+,;=` alone. Use for a whole
 *   URL that is already structured and only needs its spaces fixed.
 * - `form` — `application/x-www-form-urlencoded`, the encoding an HTML form
 *   POST uses: space becomes `+` and `!'()*~` are encoded too. Produced by the
 *   platform's own `URLSearchParams` so it matches byte for byte.
 *
 * Text that is not valid UTF-16 — a lone surrogate, which is what a string cut
 * at the wrong index leaves behind — is refused. `encodeURIComponent` throws a
 * bare `URIError` on one and `URLSearchParams` quietly substitutes U+FFFD; a
 * silent substitution in a URL is the bug, not the fix.
 */
export function encodeUrlText(text: string, mode: UrlEncodeMode): string {
  const lone = LONE_SURROGATE.exec(text);
  if (lone !== null) {
    const code = (lone[0] as string).charCodeAt(0).toString(16).toUpperCase();
    throw new Error(
      `text contains an unpaired surrogate (U+${code} at index ${lone.index}), so it is not text that can be encoded`,
    );
  }
  switch (mode) {
    case "component":
      return encodeURIComponent(text);
    case "uri":
      return encodeURI(text);
    default:
      return new URLSearchParams([["k", text]]).toString().slice(2);
  }
}

/** The inverse of `encodeUrlText`. Throws on a malformed percent-escape. */
export function decodeUrlText(text: string, mode: UrlEncodeMode): string {
  const prepared = mode === "form" ? text.replace(/\+/g, " ") : text;
  try {
    return mode === "uri" ? decodeURI(prepared) : decodeURIComponent(prepared);
  } catch {
    throw new Error("input contains a malformed percent-escape, such as a bare % or %zz");
  }
}
