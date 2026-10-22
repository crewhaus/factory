/**
 * Origins: the one spelling of "where a body came from" that a citation and
 * a tool call are compared under (design §5.2, §6.1, §6.2).
 *
 * A citation names a source as its author wrote it — `HTTPS://Acme.example/
 * policy/#refunds`, `./docs/../docs/pricing.md`, `doi:10.1000/XYZ` — and the
 * run read it as a tool's input spelled it. Grounding is a lookup of one in
 * the other, so both go through the functions here and nothing else.
 *
 * Everything is offline and lexical: no DNS, no realpath of the path being
 * named (a path is never followed off the workspace to be measured), no
 * request. The cited rung's checks that need the filesystem or the network
 * live in the verifier, behind injected seams.
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceRef } from "@crewhaus/claim-ledger";
import { isPrivateIp, normalizeIpv4 } from "./private-address";

/** Where workspace paths are measured from. */
export type PathRoots = {
  /** The workspace root (default `process.cwd()`). A path outside it has no origin. */
  readonly workspaceRoot?: string;
  /** Where a relative path is resolved from (default the workspace root);
   *  itself resolved against the workspace root when relative. */
  readonly baseDir?: string;
};

/** Longer than any path a filesystem opens (tool-verify's `MAX_PATH_CHARS` reasoning). */
const MAX_PATH_CHARS = 8_192;

/** The DOI resolver's hosts, folded to one. */
const DOI_HOSTS: ReadonlySet<string> = new Set(["doi.org", "dx.doi.org", "www.doi.org"]);

/**
 * The comparable form of an `http(s)` URL, or `undefined` when `raw` is not
 * one: scheme and host lowercased, a trailing dot on the host dropped, the
 * default port dropped, credentials and the fragment dropped (a fragment
 * names a place in the page, not another page, and credentials are never
 * written into a bundle), a trailing slash folded (`/a/` is `/a`; the root
 * stays `/`), the query kept (`?id=1` and `?id=2` are different pages).
 *
 * The DOI resolver is special-cased: `http://dx.doi.org/10.1000/ABC` and
 * `https://doi.org/10.1000/abc` are one origin, because DOIs are
 * case-insensitive by definition (the DOI Handbook, §2.4) and every
 * resolver host answers the same.
 *
 * `http` and `https` stay distinct: a page fetched over one is not evidence
 * that the other says the same thing, and folding them would let a citation
 * ground in a body the run never read under that name.
 */
export function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.replace(/\.$/, "");
  if (host === "") return undefined;
  let pathname = url.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "") || "/";
  if (DOI_HOSTS.has(host)) return `https://doi.org${pathname.toLowerCase()}${url.search}`;
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//${host}${port}${pathname}${url.search}`;
}

/** The resolver URL a DOI is fetched and grounded under: `https://doi.org/<doi>`, normalized. */
export function doiUrl(doi: string): string {
  const bare = doi.trim().replace(/^doi:\s*/i, "");
  return normalizeUrl(`https://doi.org/${bare}`) ?? `https://doi.org/${bare.toLowerCase()}`;
}

/** The host of a normalized URL (IPv6 without its brackets), or `undefined`. */
export function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/\.$/, "").toLowerCase();
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return undefined;
  }
}

/** Real paths of workspace roots, so `/var/…` and `/private/var/…` both resolve
 *  inside a root given as either. Only the ROOT is realpath'd, never the
 *  path being named. */
const realRoots = new Map<string, string | null>();

function realRoot(root: string): string | undefined {
  let real = realRoots.get(root);
  if (real === undefined) {
    try {
      real = realpathSync(root);
    } catch {
      real = null;
    }
    realRoots.set(root, real);
  }
  return real ?? undefined;
}

function inside(root: string, abs: string): string | undefined {
  if (abs === root) return ".";
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!abs.startsWith(prefix)) return undefined;
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * A workspace path as its workspace-relative POSIX form (`docs/pricing.md`),
 * or `undefined` when it names nothing inside the workspace.
 *
 * Lexical, the first half of tool-verify's `resolveSafe`: the path is
 * resolved against `baseDir` and must land inside the workspace root, `..`
 * and absolute escapes refused. It is NOT realpath'd — the key a citation and
 * a `Read` are compared under is the name, and following a link off the
 * workspace to measure it is exactly what this must not do. The verifier's
 * `cited` check does the symlink-aware half (`resolveContained`) before it
 * calls a path a source. A `file://` URL is read as the path it names; any
 * other scheme is not a path.
 */
export function normalizePath(raw: string, roots: PathRoots = {}): string | undefined {
  let given = raw.trim();
  if (given === "" || given.includes("\0") || given.length > MAX_PATH_CHARS) return undefined;
  if (/^file:\/\//i.test(given)) {
    try {
      given = fileURLToPath(given);
    } catch {
      return undefined;
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(given) && !/^[A-Za-z]:[\\/]/.test(given)) {
    // `https:`, `mailto:`, `tool:` — a scheme, not a path (a Windows drive
    // letter, `C:\`, is a path).
    return undefined;
  }
  const root = path.resolve(roots.workspaceRoot ?? process.cwd());
  const base = path.resolve(root, roots.baseDir ?? ".");
  const abs = path.resolve(base, given);
  const lexical = inside(root, abs);
  if (lexical !== undefined) return lexical;
  const real = realRoot(root);
  return real !== undefined && real !== root ? inside(real, abs) : undefined;
}

/**
 * The origin a citation's evidence reference is looked up under: the
 * normalized URL, the DOI's resolver URL, or the workspace-relative path.
 * Tool, proof, assumption and free-text references have none.
 */
export function originKey(ref: EvidenceRef, roots: PathRoots = {}): string | undefined {
  switch (ref.kind) {
    case "url":
      return normalizeUrl(ref.url);
    case "doi":
      return doiUrl(ref.doi);
    case "path":
      return normalizePath(ref.path, roots);
    default:
      return undefined;
  }
}

/**
 * Two-level public suffixes, for {@link registrableDomain}.
 *
 * A pragmatic eTLD+1, not the Public Suffix List: the common ICANN
 * second-level registries of the countries that use them (`co.uk`,
 * `com.au`, `co.jp`, …). A host under one keeps three labels; every other
 * host keeps two. PRIVATE suffixes (`github.io`, `blogspot.com`,
 * `herokuapp.com`) are deliberately absent, so every `*.github.io` page is
 * one origin: `grounded.independent` asks for corroboration, and the error
 * this approximation can make is to ask for one source too many — never to
 * count two pages one party controls as two parties.
 */
const TWO_LEVEL_SUFFIXES: ReadonlySet<string> = new Set(
  [
    "ac.uk co.uk gov.uk ltd.uk me.uk net.uk nhs.uk org.uk plc.uk police.uk sch.uk",
    "asn.au com.au edu.au gov.au id.au net.au org.au",
    "ac.nz co.nz geek.nz govt.nz net.nz org.nz school.nz",
    "ac.jp ad.jp co.jp ed.jp go.jp gr.jp lg.jp ne.jp or.jp",
    "ac.kr co.kr go.kr ne.kr or.kr re.kr",
    "com.br edu.br gov.br net.br org.br",
    "ac.cn com.cn edu.cn gov.cn net.cn org.cn",
    "com.hk edu.hk gov.hk net.hk org.hk",
    "com.tw edu.tw gov.tw net.tw org.tw",
    "com.sg edu.sg gov.sg net.sg org.sg",
    "ac.in co.in edu.in gov.in net.in nic.in org.in res.in",
    "ac.za co.za gov.za net.za org.za",
    "com.mx edu.mx gob.mx net.mx org.mx",
    "com.ar edu.ar gob.ar net.ar org.ar",
    "com.tr edu.tr gov.tr net.tr org.tr",
    "ac.il co.il gov.il net.il org.il",
    "com.my edu.my gov.my net.my org.my",
    "ac.id co.id go.id or.id",
    "ac.th co.th go.th or.th",
    "com.ph edu.ph gov.ph net.ph org.ph",
    "com.vn edu.vn gov.vn net.vn org.vn",
    "com.pk edu.pk gov.pk net.pk org.pk",
    "com.ng edu.ng gov.ng net.ng org.ng",
    "ac.ke co.ke go.ke or.ke",
    "com.eg edu.eg gov.eg net.eg org.eg",
    "com.sa edu.sa gov.sa net.sa org.sa",
    "com.ua edu.ua gov.ua net.ua org.ua",
    "com.pl edu.pl gov.pl net.pl org.pl",
    "ac.at co.at gv.at or.at",
    "com.es edu.es gob.es org.es",
    "com.pt edu.pt gov.pt org.pt",
    "com.gr edu.gr gov.gr org.gr",
    "com.ru edu.ru gov.ru net.ru org.ru",
    "com.cy gov.cy org.cy",
    "com.co edu.co gov.co net.co org.co",
    "com.pe edu.pe gob.pe org.pe",
    "com.ve gob.ve org.ve",
    "co.ve com.ec gob.ec edu.ec",
  ]
    .join(" ")
    .split(" "),
);

/**
 * The registrable domain of a host — `docs.acme.example` → `acme.example`,
 * `www.bbc.co.uk` → `bbc.co.uk` — for `grounded.independent`'s "distinct
 * origins". An IP literal is its own domain; a single label is itself. See
 * {@link TWO_LEVEL_SUFFIXES} for what this approximation knows.
 */
export function registrableDomain(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes(":") || normalizeIpv4(h) !== null) return h;
  const labels = h.split(".").filter((label) => label !== "");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * Does `host` match any of `globs` (`sources.allow` / `sources.deny`)? The
 * IR's grammar: `*` (any host), `*.<host>` (any host BELOW it — `*.gov`
 * matches `nasa.gov` and `www.nasa.gov`, not `gov`), or an exact host.
 * Case-insensitive; a trailing dot on the host is ignored.
 */
export function hostMatches(host: string, globs: ReadonlyArray<string>): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  for (const raw of globs) {
    const glob = raw.trim().toLowerCase();
    if (glob === "*") return true;
    if (glob.startsWith("*.")) {
      const suffix = glob.slice(1);
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (glob !== "" && h === glob) {
      return true;
    }
  }
  return false;
}

/**
 * Is `host` loopback, private, link-local or otherwise not a public source?
 * The repo's one IP classifier (`private-address.ts`, every spelling of
 * `169.254.169.254` included) plus the names tool-fetch refuses before DNS:
 * `localhost`, `*.localhost` and the mDNS `*.local`. Offline — a public-looking
 * name that RESOLVES privately is caught by the fetch that reads it, not here.
 */
export function isPrivateHost(host: string): boolean {
  let h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return isPrivateIp(h);
}
