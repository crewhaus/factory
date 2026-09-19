/**
 * Reading a PUBLISHED manifest back.
 *
 * `PackageManifestVerify` is handed files that are already out in the world —
 * in a tap, in a bucket, in a PR against microsoft/winget-pkgs — so this is a
 * reader, not the inverse of the renderer. It must cope with a formula someone
 * hand-edited, a scoop manifest with a top-level `url` instead of an
 * `architecture` block, and a winget file with three installers.
 *
 * Every extraction has a third answer. A field that cannot be read is reported
 * as unreadable, never defaulted: a version this file could not find must not
 * come back as "the version matched", and a manifest whose format it could not
 * identify must not come back as "nothing wrong with it". Findings carry a
 * severity that keeps those apart — `error` is a definite defect, `unknown` is
 * a check that could not be made, `note` is worth saying and nothing more.
 */
import type { ManifestKind } from "./inputs";

export type FindingSeverity = "error" | "unknown" | "note";

export type Finding = {
  readonly severity: FindingSeverity;
  readonly code: string;
  readonly message: string;
};

/** One download instruction a manifest carries: a URL and the sha beside it. */
export type DeclaredAsset = {
  readonly manifest: ManifestKind;
  /** The build target, when the filename says; otherwise the filename. */
  readonly label: string;
  readonly url: string;
  /** Exactly as the manifest spells it, case included. */
  readonly declaredSha256: string;
};

export type ParsedManifest = {
  readonly kind: ManifestKind;
  readonly source: string;
  /** Absent when the file does not state one this reader could find. */
  readonly version: string | undefined;
  readonly assets: ReadonlyArray<DeclaredAsset>;
  readonly findings: ReadonlyArray<Finding>;
};

export type ParseOutcome =
  | { readonly ok: true; readonly manifest: ParsedManifest }
  | { readonly ok: false; readonly source: string; readonly message: string };

const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Which of the four this text is, by the line only that format has.
 *
 * `undefined` means undecided, and the caller reports that rather than
 * guessing: a file this reader cannot identify has not been checked, and
 * "I could not tell what this is" is a different answer from "it is fine".
 */
export function detectKind(text: string): ManifestKind | undefined {
  if (/^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\s*<\s*Formula\b/m.test(text)) return "homebrew";
  if (/^PackageIdentifier:/m.test(text)) return "winget";
  if (/^Package:[ \t]*\S/m.test(text)) return "debian";
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === "object") return "scoop";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseManifest(text: string, source: string, kind: ManifestKind): ParseOutcome {
  switch (kind) {
    case "homebrew":
      return { ok: true, manifest: parseHomebrew(text, source) };
    case "debian":
      return { ok: true, manifest: parseDebian(text, source) };
    case "winget":
      return { ok: true, manifest: parseWinget(text, source) };
    default:
      return parseScoop(text, source);
  }
}

// ---------------------------------------------------------------------------
// Homebrew

/**
 * A formula's downloads are `url "…"` / `sha256 "…"` pairs, in that order,
 * inside `on_macos` / `on_linux` blocks. Pairing by ORDER rather than by block
 * is deliberate: this reader has to work on a formula someone edited by hand,
 * and a `url` with no `sha256` after it is the single most dangerous thing a
 * formula can contain — Homebrew would download and install it unverified —
 * so it is found and reported rather than skipped past.
 */
function parseHomebrew(text: string, source: string): ParsedManifest {
  const findings: Finding[] = [];
  const assets: DeclaredAsset[] = [];
  const version = /^\s*version\s+"([^"\n]*)"/m.exec(text)?.[1];
  if (version === undefined) {
    findings.push({
      severity: "unknown",
      code: "versionUnreadable",
      message: `no \`version "…"\` line — the version checks below could not be made on this formula`,
    });
  }

  let pendingUrl: string | undefined;
  for (const line of text.split("\n")) {
    const url = /^\s*url\s+"([^"\n]*)"/.exec(line)?.[1];
    if (url !== undefined) {
      if (pendingUrl !== undefined) {
        findings.push({
          severity: "error",
          code: "urlWithoutSha",
          message: `the url "${pendingUrl}" is followed by another url rather than by a sha256 — Homebrew would install that download without checking it`,
        });
      }
      pendingUrl = url;
      continue;
    }
    const sha = /^\s*sha256\s+"([^"\n]*)"/.exec(line)?.[1];
    if (sha === undefined) continue;
    if (pendingUrl === undefined) {
      findings.push({
        severity: "note",
        code: "shaWithoutUrl",
        message: `a sha256 line with no url before it: "${sha.slice(0, 16)}…"`,
      });
      continue;
    }
    assets.push({
      manifest: "homebrew",
      label: targetOf(pendingUrl),
      url: pendingUrl,
      declaredSha256: sha,
    });
    if (!SHA256.test(sha)) {
      findings.push({
        severity: "error",
        code: "shaMalformed",
        message: `the sha256 for ${targetOf(pendingUrl)} is not 64 hex characters: "${sha.slice(0, 80)}"`,
      });
    }
    pendingUrl = undefined;
  }
  if (pendingUrl !== undefined) {
    findings.push({
      severity: "error",
      code: "urlWithoutSha",
      message: `the url "${pendingUrl}" has no sha256 after it — Homebrew would install that download without checking it`,
    });
  }
  if (assets.length === 0) {
    findings.push({
      severity: "error",
      code: "noDownloads",
      message: "the formula declares no url/sha256 pair at all",
    });
  }
  return { kind: "homebrew", source, version, assets, findings };
}

// ---------------------------------------------------------------------------
// Debian

const DEBIAN_REQUIRED = ["Package", "Version", "Architecture", "Maintainer", "Description"];

/**
 * A control paragraph carries no URLs and no checksums — the archive holds
 * those — so the only things to check are structural, and they are the ones
 * the format is famous for getting wrong.
 *
 * A continuation line is a line beginning with a single space. Lose the space
 * and the line stops being a continuation: `dpkg` then reads it as a field
 * name, and the paragraph does not parse. Add a SECOND space and it is legal
 * but means something else — dpkg's description formatter treats " " plus
 * further whitespace as verbatim text and stops re-wrapping it — which is
 * almost never what a wrapped description wanted, and is exactly what happens
 * when a caller adds the leading space the renderer already adds.
 */
function parseDebian(text: string, source: string): ParsedManifest {
  const findings: Finding[] = [];
  const version = /^Version:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  if (version === undefined) {
    findings.push({
      severity: "unknown",
      code: "versionUnreadable",
      message:
        "no single-token `Version:` field — the version checks could not be made on this control file",
    });
  }
  const present = new Set<string>();
  const lines = text.split("\n");
  let inDescription = false;

  lines.forEach((line, index) => {
    if (line === "" && index === lines.length - 1) return;
    const field = /^([A-Za-z][A-Za-z0-9-]*):/.exec(line)?.[1];
    if (field !== undefined) {
      present.add(field);
      inDescription = field === "Description";
      return;
    }
    if (line.startsWith(" ")) {
      if (/^[ \t]/.test(line.slice(1))) {
        findings.push({
          severity: "note",
          code: "continuationDoubleIndented",
          message: `line ${index + 1} begins with two spaces: dpkg reads " " plus more whitespace as a verbatim line and stops re-wrapping it, which is what happens when the text was passed in already carrying the leading space the renderer adds`,
        });
      }
      if (line.trim() === "") {
        findings.push({
          severity: "error",
          code: "continuationBlank",
          message: `line ${index + 1} is a space and nothing else — a control paragraph cannot contain a blank line; "." is the paragraph break`,
        });
      }
      return;
    }
    if (line.trim() === "") {
      // A blank line ENDS the paragraph. Anything after it belongs to the
      // next one, so a description that continues past it has been split.
      if (inDescription && lines.slice(index + 1).some((rest) => rest.trim() !== "")) {
        findings.push({
          severity: "error",
          code: "paragraphSplit",
          message: `line ${index + 1} is blank in the middle of the file — that ends the control paragraph, and everything after it is read as a second one`,
        });
      }
      inDescription = false;
      return;
    }
    findings.push({
      severity: "error",
      code: "continuationLostSpace",
      message: `line ${index + 1} ("${line.slice(0, 48)}") is neither a field nor a continuation — a description line that lost its single leading space stops the paragraph parsing`,
    });
  });

  for (const field of DEBIAN_REQUIRED) {
    if (!present.has(field)) {
      findings.push({
        severity: "error",
        code: "fieldMissing",
        message: `the control paragraph has no ${field}: field`,
      });
    }
  }
  return { kind: "debian", source, version, assets: [], findings };
}

// ---------------------------------------------------------------------------
// winget

/**
 * The installer manifest: one `Installers:` list, each entry an
 * `InstallerUrl` and an `InstallerSha256`, usually with an `Architecture`.
 *
 * The sha is checked for CASE as well as for content. `winget hash` prints
 * uppercase, every manifest in microsoft/winget-pkgs is uppercase, and the
 * renderer in `@crewhaus/single-binary-cli` uppercases for exactly that
 * reason — so a lowercase digest here means the file did not come from that
 * renderer and will not match the rest of the repository it is submitted to.
 * The BYTES are unaffected, so it is reported as its own finding and never as
 * a hash mismatch.
 */
function parseWinget(text: string, source: string): ParsedManifest {
  const findings: Finding[] = [];
  const assets: DeclaredAsset[] = [];
  const version = /^PackageVersion:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  if (version === undefined) {
    findings.push({
      severity: "unknown",
      code: "versionUnreadable",
      message:
        "no single-token `PackageVersion:` field — the version checks could not be made on this manifest",
    });
  }

  let pendingUrl: string | undefined;
  let pendingArch: string | undefined;
  for (const line of text.split("\n")) {
    const arch = /^\s*-?\s*Architecture:[ \t]*(\S+)/.exec(line)?.[1];
    if (arch !== undefined) {
      pendingArch = arch;
      continue;
    }
    const url = /^\s*-?\s*InstallerUrl:[ \t]*(\S+)/.exec(line)?.[1];
    if (url !== undefined) {
      if (pendingUrl !== undefined) {
        findings.push({
          severity: "error",
          code: "urlWithoutSha",
          message: `the installer "${pendingUrl}" has no InstallerSha256 — winget would install it unverified`,
        });
      }
      pendingUrl = url;
      continue;
    }
    const sha = /^\s*-?\s*InstallerSha256:[ \t]*(\S+)/.exec(line)?.[1];
    if (sha === undefined) continue;
    if (pendingUrl === undefined) {
      findings.push({
        severity: "note",
        code: "shaWithoutUrl",
        message: "an InstallerSha256 with no InstallerUrl before it",
      });
      continue;
    }
    const label = pendingArch ?? targetOf(pendingUrl);
    assets.push({
      manifest: "winget",
      label,
      url: pendingUrl,
      declaredSha256: sha,
    });
    if (!SHA256.test(sha)) {
      findings.push({
        severity: "error",
        code: "shaMalformed",
        message: `the InstallerSha256 for ${label} is not 64 hex characters: "${sha.slice(0, 80)}"`,
      });
    } else if (sha !== sha.toUpperCase()) {
      findings.push({
        severity: "error",
        code: "shaNotUppercase",
        message: `the InstallerSha256 for ${label} is not uppercase — winget hash emits uppercase and the community repository is uppercase throughout, so this file did not come from the release renderer; the bytes it names are unaffected, so this is a manifest defect and not a hash mismatch`,
      });
    }
    pendingUrl = undefined;
    pendingArch = undefined;
  }
  if (pendingUrl !== undefined) {
    findings.push({
      severity: "error",
      code: "urlWithoutSha",
      message: `the installer "${pendingUrl}" has no InstallerSha256 — winget would install it unverified`,
    });
  }
  if (assets.length === 0) {
    findings.push({
      severity: "error",
      code: "noDownloads",
      message: "the manifest declares no InstallerUrl/InstallerSha256 pair",
    });
  }
  return { kind: "winget", source, version, assets, findings };
}

// ---------------------------------------------------------------------------
// scoop

/**
 * Scoop's manifest is JSON, and it has two shapes: a top-level `url`/`hash`
 * for a single-architecture app, or an `architecture` map keyed `64bit` /
 * `32bit` / `arm64`. Both are read — the renderer emits the second, but a
 * published manifest is whatever someone published.
 *
 * `url` and `hash` may each be a string or an array (a bucket that ships
 * several files per architecture), so both are normalised to a list and
 * paired by index. A pair that does not line up is a finding, not a silent
 * truncation.
 */
function parseScoop(text: string, source: string): ParseOutcome {
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, source, message: "the scoop manifest is not a JSON object" };
    }
    doc = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      source,
      message: `the scoop manifest is not valid JSON: ${(err as Error).message}`,
    };
  }

  const findings: Finding[] = [];
  const assets: DeclaredAsset[] = [];
  const version = typeof doc["version"] === "string" ? (doc["version"] as string) : undefined;
  if (version === undefined) {
    findings.push({
      severity: "unknown",
      code: "versionUnreadable",
      message: `no string "version" key — the version checks could not be made on this manifest`,
    });
  }

  const collect = (label: string, holder: Record<string, unknown>): void => {
    const urls = asList(holder["url"]);
    const hashes = asList(holder["hash"]);
    if (urls.length === 0) return;
    if (urls.length !== hashes.length) {
      findings.push({
        severity: "error",
        code: "urlWithoutSha",
        message: `${label} lists ${urls.length} url${urls.length === 1 ? "" : "s"} and ${hashes.length} hash${hashes.length === 1 ? "" : "es"} — scoop pairs them by position, so one download would be installed unverified`,
      });
    }
    urls.forEach((url, index) => {
      const hash = hashes[index];
      if (hash === undefined) return;
      // Scoop allows an algorithm prefix (`sha512:…`); only sha256 is verified
      // here, and anything else is said rather than assumed away.
      const withoutPrefix = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : hash;
      const algorithm = hash.includes(":")
        ? hash.slice(0, hash.indexOf(":")).toLowerCase()
        : "sha256";
      if (algorithm !== "sha256") {
        findings.push({
          severity: "unknown",
          code: "hashAlgorithmUnsupported",
          message: `${label} names a ${algorithm} hash; this tool computes sha256, so that download was not checked`,
        });
        return;
      }
      assets.push({
        manifest: "scoop",
        label: urls.length === 1 ? label : `${label}[${index}]`,
        url,
        declaredSha256: withoutPrefix,
      });
      if (!SHA256.test(withoutPrefix)) {
        findings.push({
          severity: "error",
          code: "shaMalformed",
          message: `the hash for ${label} is not 64 hex characters: "${withoutPrefix.slice(0, 80)}"`,
        });
      }
    });
  };

  collect("top-level", doc);
  const architecture = doc["architecture"];
  if (architecture !== null && typeof architecture === "object" && !Array.isArray(architecture)) {
    for (const [arch, holder] of Object.entries(architecture as Record<string, unknown>)) {
      if (holder !== null && typeof holder === "object" && !Array.isArray(holder)) {
        collect(arch, holder as Record<string, unknown>);
      }
    }
  }
  if (assets.length === 0) {
    findings.push({
      severity: "error",
      code: "noDownloads",
      message: "the manifest declares no url/hash pair",
    });
  }
  return { ok: true, manifest: { kind: "scoop", source, version, assets, findings } };
}

function asList(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

// ---------------------------------------------------------------------------
// shared

/**
 * The build target a download URL names, for labelling a row.
 *
 * Falls back to the filename: this is a label, and a URL that does not follow
 * the `<binary>-<platform>-<arch>-<version>` convention is still an asset that
 * has to be fetched and hashed.
 */
export function targetOf(url: string): string {
  const path = url.split("?")[0]?.split("#")[0] ?? url;
  const file = path.slice(path.lastIndexOf("/") + 1);
  const match =
    /-((?:linux|macos|darwin|windows|win)-(?:x64|x86_64|amd64|arm64|aarch64))(?:[-.]|$)/.exec(file);
  return match?.[1] ?? (file === "" ? url : file);
}

/**
 * Does this URL carry the version the manifest claims?
 *
 * Three answers, not two. "matches" and "differs" are both definite; when the
 * URL carries no version-shaped segment at all, the answer is that this check
 * could not be made — a release that publishes `latest/download/tool.exe` is
 * unusual but not wrong, and calling that a version mismatch would block it.
 */
export type VersionInUrl = "matches" | "differs" | "notFound";

export function versionInUrl(url: string, version: string): VersionInUrl {
  const tokens = versionTokensInUrl(url);
  if (tokens.length === 0) return "notFound";
  if (tokens.some((token) => token === version)) return "matches";
  return "differs";
}

/**
 * The version-shaped tokens a download URL carries, so a caller reporting a
 * disagreement can name what the URL actually says rather than just that it
 * disagrees.
 *
 * Whole TOKENS, not a substring search: `includes("1.2.3")` is satisfied by
 * `…-1.2.30`, which is a different release, and reporting that as a match is
 * how a manifest pointing at last week's build passes.
 *
 * Only the PATH is scanned. A host is full of dot-separated numbers — an
 * IP-literal download host (`https://93.184.216.34/latest/tool`) yields the
 * token `93.184.216`, which would read as "this URL names a different
 * version" and turn a merely unusual manifest into a definite defect. The
 * version lives in the tag and the filename, both of which are the path.
 */
export function versionTokensInUrl(url: string): ReadonlyArray<string> {
  let scanned: string;
  try {
    const parsed = new URL(url);
    scanned = `${parsed.pathname}${parsed.search}`;
  } catch {
    scanned = url;
  }
  return [...scanned.matchAll(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g)].map((m) => m[0]);
}
