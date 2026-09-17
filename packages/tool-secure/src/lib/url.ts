/**
 * Structural analysis of a URL, and allow-list matching.
 *
 * ## Nothing here fetches anything
 *
 * Every check reads the string. No DNS, no HTTP, no reputation service — so
 * this says nothing about whether a host is malicious, only whether the URL
 * is SHAPED like the ones used to mislead: credentials in the authority, an
 * IP where a name should be, a punycode label, another URL smuggled through
 * a redirect parameter, a `javascript:` payload.
 *
 * A URL with no findings is a URL that is structurally unremarkable. That is
 * all. Plenty of ordinary-looking URLs are hostile and plenty of odd-looking
 * ones are fine.
 *
 * ## Allow-list grammar
 *
 * A rule is matched, never guessed at. Exactly these forms:
 *
 * | kind | rule | matches |
 * |---|---|---|
 * | `url` | `example.com` | that host only, any http(s) URL |
 * | `url` | `*.example.com` | any subdomain, NOT the bare host |
 * | `url` | `https://example.com/api/` | host plus a path prefix, scheme pinned |
 * | `emailDomain` | `example.com` | that domain only, case-insensitive |
 * | `emailDomain` | `*.example.com` | any subdomain of it |
 * | `path` | `src/` | that workspace-relative directory and everything under it |
 *
 * Deny by default: an empty allow-list allows nothing, and a rule that does
 * not parse is an error rather than a rule that silently matches nothing.
 */
import { compareStrings } from "./text";
import { mixedScriptRuns } from "./unicode";

export type UrlSeverity = "high" | "medium" | "low" | "info";

export type UrlIssue = {
  readonly rule: string;
  readonly severity: UrlSeverity;
  readonly detail: string;
};

export type UrlAnalysis = {
  readonly parsed: boolean;
  readonly scheme?: string;
  readonly host?: string;
  readonly port?: string;
  readonly issues: ReadonlyArray<UrlIssue>;
  /** Every check that ran, named, so "no issues" is readable as a scope. */
  readonly checked: ReadonlyArray<string>;
};

/** Schemes a link in a document is normally allowed to use. */
const BENIGN_SCHEMES = new Set(["http", "https", "mailto"]);
/** Schemes that execute or inline content rather than locate it. */
const ACTIVE_SCHEMES = new Set(["javascript", "data", "vbscript", "blob", "file"]);

/** Ports that are a service, not a website. */
const SENSITIVE_PORTS = new Set([
  22, 23, 25, 110, 135, 139, 445, 1433, 1521, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

const REDIRECT_PARAMS = new Set([
  "callback",
  "continue",
  "dest",
  "destination",
  "forward",
  "goto",
  "image_url",
  "link",
  "next",
  "out",
  "path",
  "r",
  "redir",
  "redirect",
  "redirect_uri",
  "redirect_url",
  "return",
  "returnto",
  "return_to",
  "rurl",
  "target",
  "to",
  "u",
  "uri",
  "url",
  "window",
]);

/**
 * Every rule id `analyzeUrl` can emit, so `checked` and `issues[].rule` are
 * the same vocabulary — a caller can line an empty `issues` list up against
 * this one and see exactly what "no findings" covered. Naming a category here
 * that no issue ever reports under (`scheme` when the issue says
 * `scheme.active`) makes the two lists un-joinable, which is the whole point
 * of publishing the second one.
 */
export const URL_CHECKS: ReadonlyArray<string> = [
  "parse",
  "raw.whitespace-or-control",
  "length",
  "scheme.active",
  "scheme.unexpected",
  "authority.credentials",
  "host.numeric",
  "host.ip-literal",
  "host.punycode",
  "host.non-ascii",
  "host.mixed-script",
  "host.label-count",
  "port.service",
  "port.non-standard",
  "query.redirect-parameter",
  "query.embedded-url",
  "encoding.double",
];

const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ALL_DIGITS = /^\d+$/;
const HEX_HOST = /^0x[0-9a-f]+$/i;

/** Whitespace or an ASCII control character anywhere in the string. */
function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** True when every code unit is ASCII. */
function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/** Analyse one URL string. Never throws for a caller mistake. */
export function analyzeUrl(raw: string): UrlAnalysis {
  const issues: UrlIssue[] = [];

  if (hasWhitespaceOrControl(raw)) {
    issues.push({
      rule: "raw.whitespace-or-control",
      severity: "medium",
      detail: "the URL contains whitespace or control characters, which parsers disagree about",
    });
  }
  if (raw.length > 2000) {
    issues.push({
      rule: "length",
      severity: "low",
      detail: `the URL is ${raw.length} characters; unusually long URLs hide their tail in a status bar`,
    });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      parsed: false,
      issues: [
        ...issues,
        {
          rule: "parse",
          severity: "medium",
          detail:
            "not an absolute URL; a relative reference resolves against a base this tool cannot see",
        },
      ],
      checked: URL_CHECKS,
    };
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (ACTIVE_SCHEMES.has(scheme)) {
    issues.push({
      rule: "scheme.active",
      severity: "high",
      detail: `the "${scheme}:" scheme carries or executes content rather than locating it`,
    });
  } else if (!BENIGN_SCHEMES.has(scheme)) {
    issues.push({
      rule: "scheme.unexpected",
      severity: "low",
      detail: `scheme "${scheme}:" is neither http, https nor mailto`,
    });
  }

  if (url.username !== "" || url.password !== "") {
    issues.push({
      rule: "authority.credentials",
      severity: "high",
      detail:
        url.password === ""
          ? "the authority carries a username, which pushes the real host past where a reader stops looking"
          : "the authority carries a username and password",
    });
  }

  // The authority exactly as written. `url.hostname` is already normalized —
  // for an http URL the parser turns `2130706433` into `127.0.0.1` — so the
  // obfuscated form is only visible here.
  const rawAuthority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  const rawHost = rawAuthority
    .slice(rawAuthority.lastIndexOf("@") + 1)
    .replace(/:\d*$/, "")
    .toLowerCase();

  const host = url.hostname.toLowerCase();
  if (ALL_DIGITS.test(rawHost) || HEX_HOST.test(rawHost)) {
    issues.push({
      rule: "host.numeric",
      severity: "high",
      detail: `the host is written as a bare number ("${rawHost}"), a decimal or hex encoding of the IP address ${host} that hides it from a reader`,
    });
  } else if (IPV4_HOST.test(host)) {
    issues.push({
      rule: "host.ip-literal",
      severity: "medium",
      detail:
        "the host is an IPv4 literal, so there is no name to check and no certificate name to match",
    });
  } else if (host.startsWith("[")) {
    issues.push({
      rule: "host.ip-literal",
      severity: "medium",
      detail: "the host is an IPv6 literal",
    });
  }

  const labels = host.split(".");
  for (const label of labels) {
    if (label.startsWith("xn--")) {
      issues.push({
        rule: "host.punycode",
        severity: "medium",
        detail: `label "${label}" is punycode, so the host displays as non-ASCII characters that may imitate another name`,
      });
      break;
    }
  }

  // Compare against the raw input, because URL parsing already applied IDNA.
  if (!isAscii(rawAuthority)) {
    issues.push({
      rule: "host.non-ascii",
      severity: "medium",
      detail: "the host as written contains non-ASCII characters",
    });
    const mixed = mixedScriptRuns(rawAuthority);
    if (mixed.length > 0) {
      issues.push({
        rule: "host.mixed-script",
        severity: "high",
        detail: `the host mixes scripts (${mixed[0]?.scripts.join(" + ")}), the shape of a homograph imitation`,
      });
    }
  }

  if (labels.length > 5) {
    issues.push({
      rule: "host.label-count",
      severity: "low",
      detail: `${labels.length} labels: a long prefix can make a hostile registrable domain read as a path`,
    });
  }

  if (url.port !== "") {
    const port = Number(url.port);
    if (SENSITIVE_PORTS.has(port)) {
      issues.push({
        rule: "port.service",
        severity: "medium",
        detail: `port ${port} is an administrative or database service, not a web server`,
      });
    } else if (port !== 80 && port !== 443) {
      issues.push({
        rule: "port.non-standard",
        severity: "low",
        detail: `explicit port ${port}`,
      });
    }
  }

  for (const [key, value] of [...url.searchParams].sort(
    (a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]),
  )) {
    const decoded = safeDecode(value);
    const carriesUrl = /^(?:\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(decoded);
    if (!carriesUrl) continue;
    const named = REDIRECT_PARAMS.has(key.toLowerCase());
    issues.push({
      rule: named ? "query.redirect-parameter" : "query.embedded-url",
      severity: named ? "high" : "medium",
      detail: `parameter "${key}" carries another URL (${truncate(decoded, 80)})`,
    });
  }

  if (/%25[0-9a-f]{2}/i.test(raw)) {
    issues.push({
      rule: "encoding.double",
      severity: "medium",
      detail:
        "double percent-encoding: what one layer decodes may differ from what the next one sees",
    });
  }

  return {
    parsed: true,
    scheme,
    host,
    port: url.port === "" ? undefined : url.port,
    issues: issues.sort(
      (a, b) => compareStrings(a.rule, b.rule) || compareStrings(a.detail, b.detail),
    ),
    checked: URL_CHECKS,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

// ---------------------------------------------------------------------------
// allow-lists
// ---------------------------------------------------------------------------

export class AllowRuleError extends Error {
  override readonly name = "AllowRuleError";
}

/** A host matches a host rule exactly, or as a subdomain under `*.`. */
export function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const r = rule.toLowerCase().replace(/\.$/, "");
  if (r.startsWith("*.")) {
    const base = r.slice(2);
    return h.endsWith(`.${base}`) && h.length > base.length + 1;
  }
  return h === r;
}

/** True when `pathname` is `prefix` or lives under it. */
function underPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/" || prefix === "") return true;
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname === prefix || pathname.startsWith(normalized);
}

/** Does this URL satisfy this allow-list rule? */
export function urlMatchesRule(value: string, rule: string): boolean {
  const trimmed = rule.trim();
  if (trimmed === "") throw new AllowRuleError("an allow-list rule may not be empty");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let ruleUrl: URL;
    try {
      ruleUrl = new URL(trimmed);
    } catch {
      throw new AllowRuleError(
        `allow-list rule "${rule}" starts with a scheme but is not a valid URL`,
      );
    }
    if (ruleUrl.protocol !== url.protocol) return false;
    if (!hostMatches(url.hostname, ruleUrl.hostname)) return false;
    if (ruleUrl.port !== "" && ruleUrl.port !== url.port) return false;
    return underPrefix(url.pathname, ruleUrl.pathname);
  }
  const [hostPart = "", ...pathParts] = trimmed.split("/");
  if (hostPart.includes(":")) {
    throw new AllowRuleError(
      `allow-list rule "${rule}" has a port or scheme but no "://" — write it as https://host[:port][/prefix]`,
    );
  }
  if (!hostMatches(url.hostname, hostPart)) return false;
  const prefix = pathParts.join("/");
  return prefix === "" ? true : underPrefix(url.pathname, `/${prefix}`);
}

/** The domain of an email address, lower-cased, or undefined if there is none. */
export function emailDomain(address: string): string | undefined {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return undefined;
  const domain = address.slice(at + 1).toLowerCase();
  return domain.includes(" ") ? undefined : domain;
}
