/**
 * The validation and the refusals for `PackageManifestGenerate`.
 *
 * `@crewhaus/single-binary-cli` owns the rendering. Its four renderers produce
 * the files that ship to brew, apt, scoop and winget on every real release,
 * and their output is pinned byte-for-byte by goldens in that package. Nothing
 * here re-implements them, and nothing here changes them. What this file does
 * is everything that has to be true BEFORE they are called:
 *
 *   - a sha256 is 64 hex characters, and one is present for every target the
 *     selected manifests actually need;
 *   - a version is semver-shaped, because the Homebrew formula requires it —
 *     and is semver-shaped ALL THE WAY, because the renderer's own check is
 *     anchored only at the start and `1.0.0"` would pass it straight into a
 *     Ruby string;
 *   - a download base URL is https and does not point into private space;
 *   - a product identity renders as the formats it is spliced into: Ruby
 *     double-quoted strings, YAML plain scalars, and Debian continuation
 *     lines that carry EXACTLY one leading space.
 *
 * The last one is the subtle one. The Debian renderer adds the single leading
 * space the control format requires, so a caller who has already added it
 * produces two — and a doubly-indented line is as unparseable as one that lost
 * the space, while looking far more innocent in a diff.
 */
import {
  BUILD_MATRIX,
  type ProductIdentity,
  type ShaByTarget,
  formatTarget,
} from "@crewhaus/single-binary-cli";
import { isPrivateIp, normalizeIpv4 } from "@crewhaus/tool-fetch";

/** The four files a release publishes. */
export const MANIFEST_KINDS = ["homebrew", "debian", "scoop", "winget"] as const;
export type ManifestKind = (typeof MANIFEST_KINDS)[number];

/**
 * The build targets, taken from the renderer package rather than restated, so
 * a target added to Bun's matrix arrives here without an edit.
 */
export const TARGET_KEYS: ReadonlyArray<string> = BUILD_MATRIX.map(formatTarget);

/**
 * Which targets each manifest's renderer demands a sha for.
 *
 * This mirrors the `requireSha` calls inside the four renderers. It is a
 * restatement, so `lib.test.ts` proves it by DROPPING each listed target and
 * asserting the renderer throws — and by rendering Debian with no shas at all.
 * A table that drifts from the code it describes is worse than no table.
 */
export const REQUIRED_TARGETS: Readonly<Record<ManifestKind, ReadonlyArray<string>>> =
  Object.freeze({
    homebrew: ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64"],
    debian: [],
    scoop: ["windows-x64"],
    winget: ["windows-x64"],
  });

/**
 * Semver shape, anchored at BOTH ends.
 *
 * `renderHomebrewFormula` tests `/^\d+\.\d+\.\d+/`, which is unanchored at the
 * end: `1.2.3" \n  system "rm -rf /` passes it and lands inside `version "…"`
 * in a Ruby file Homebrew will execute. Refusing here is the wrapper earning
 * its place — the renderer is not changed, it is simply never handed that.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+(?:-[0-9A-Za-z.]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

const SHA256 = /^[0-9a-f]{64}$/i;

/** A refusal, in the one line a tool returns when it cannot answer. */
export type Refusal = string;

export function checkVersion(version: string): Refusal | undefined {
  if (SEMVER.test(version)) return undefined;
  return `version "${version}" is not semver-shaped (MAJOR.MINOR.PATCH, optionally -prerelease and +build) — the Homebrew formula requires it, and the version is spliced into a Ruby string, a YAML scalar and every download URL`;
}

/**
 * Text that is about to sit inside a Ruby double-quoted string in a file
 * Homebrew executes.
 *
 * `"` ends the string, `\` starts an escape, and `#{…}` is interpolation —
 * arbitrary Ruby, run by `brew install`. The renderers do not escape (they
 * cannot: their output is pinned), so the values never get there.
 */
export function checkRubyString(field: string, value: string): Refusal | undefined {
  if (/[\r\n]/.test(value)) return `${field} contains a line break`;
  if (value.includes('"'))
    return `${field} contains a double quote, which would end the Ruby string it is spliced into`;
  if (value.includes("\\")) return `${field} contains a backslash, which starts a Ruby escape`;
  if (value.includes("#{"))
    return `${field} contains "#{" — Ruby interpolation inside a formula is code Homebrew runs on install`;
  return undefined;
}

/**
 * Text that is about to sit on the right of a `Key: value` line in the winget
 * YAML.
 *
 * A plain scalar cannot start with an indicator character, cannot contain
 * `: ` (that reads as a nested mapping), and cannot contain ` #` (a comment).
 * Values are emitted unquoted by the renderer, so a value that is not a plain
 * scalar produces YAML that means something else or nothing at all.
 */
export function checkYamlScalar(field: string, value: string): Refusal | undefined {
  if (/[\r\n]/.test(value))
    return `${field} contains a line break, which would end the YAML scalar`;
  if (value !== value.trim())
    return `${field} has leading or trailing whitespace, which YAML will not preserve`;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value))
    return `${field} starts with "${value[0]}", a YAML indicator character — it would not read back as plain text`;
  if (value.includes(": "))
    return `${field} contains ": ", which YAML reads as a nested mapping rather than as text`;
  if (value.endsWith(":")) return `${field} ends with ":", which YAML reads as a mapping key`;
  if (value.includes(" #"))
    return `${field} contains " #", which YAML reads as the start of a comment`;
  return undefined;
}

/**
 * A URL that will be PUBLISHED as text has to be a URL as text.
 *
 * The WHATWG parser deletes ASCII tab, CR and LF from anywhere in a URL and
 * percent-encodes the remaining control characters, so `new URL(raw)` can
 * succeed, pass every check below, and describe a DIFFERENT URL from the one
 * the renderers then splice into the formula verbatim. A base URL carrying a
 * tab was validated as `https://dl.example.com/v1.2` and published as
 * `https://dl.example.com/v1<TAB>.2`, in every download line of every one of
 * the four files — and Ruby's URI, dpkg, scoop and winget do not all resolve
 * that the way the parser did. Checking the parsed form and shipping the
 * string is the trap; this makes the two the same thing.
 */
export function firstControlChar(raw: string): { code: number; index: number } | undefined {
  // A scan rather than a character class: biome bans control characters
  // inside a regular expression (`noControlCharactersInRegex`), and the one
  // place this rule matters is the one place the literal would have to spell
  // them out. Space is included because it is deleted at either end and
  // percent-encoded in the middle — both change the URL.
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return { code, index };
  }
  return undefined;
}

/** `U+0009`, for a message that names the character it is refusing. */
export function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function checkUrlLiteral(field: string, raw: string): Refusal | undefined {
  const control = firstControlChar(raw);
  if (control === undefined) return undefined;
  return `${field} contains ${codePointLabel(control.code)} at offset ${control.index} — the URL parser deletes tabs and line breaks and encodes the other control characters, so what was checked would not be what is published; percent-encode it or remove it`;
}

export type UrlCheck =
  | { readonly ok: true; readonly url: string; readonly notes: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: Refusal };

/**
 * The download base URL: the one field in a manifest that is an instruction to
 * download and execute.
 *
 * https is not a style preference here. A manifest fetched over plain http can
 * be rewritten in flight by anyone on the path, and the sha256 beside the URL
 * is no defence when the same attacker chose both. The private-address rule is
 * the same argument one hop further in: a formula that resolves to
 * 10.0.0.5 or 169.254.169.254 publishes an internal host as the source of a
 * binary the whole world is told to run.
 *
 * Only address LITERALS are classified here. Resolving the name would mean a
 * DNS lookup inside a pure, offline tool, and a name that resolves privately
 * today is not a property of the string the caller passed.
 */
export function checkDownloadBaseUrl(raw: string): UrlCheck {
  const unsafe =
    checkUrlLiteral("downloadBaseUrl", raw) ??
    checkRubyString("downloadBaseUrl", raw) ??
    checkYamlScalar("downloadBaseUrl", raw);
  if (unsafe !== undefined) return { ok: false, message: unsafe };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `downloadBaseUrl "${raw}" is not a URL` };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      message: `downloadBaseUrl is ${url.protocol.replace(":", "")}, not https — a package manifest is a bearer instruction to download and execute a binary, and plain http lets anyone on the path choose both the bytes and the checksum beside them`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message:
        "downloadBaseUrl carries credentials in the URL — these manifests are published, and a credential in one is a published credential",
    };
  }
  if (url.search !== "" || url.hash !== "") {
    return {
      ok: false,
      message: `downloadBaseUrl has a query or fragment — the renderers append "/<file>" to it, which would land after the "?" and produce a URL that fetches nothing`,
    };
  }
  const privateReason = privateHostReason(url.hostname);
  if (privateReason !== undefined) {
    return {
      ok: false,
      message: `downloadBaseUrl points at ${privateReason} — a manifest published to brew, apt, scoop or winget tells every installer in the world to fetch a binary from there`,
    };
  }

  // The renderers write `${downloadBaseUrl}/${file}`, so a trailing slash
  // becomes "//" in every published URL. Most servers forgive it; these files
  // are read by people in diffs, so it is trimmed and said out loud rather
  // than trimmed silently.
  const base = raw.replace(/\/+$/, "");
  const notes =
    base === raw
      ? []
      : [
          `downloadBaseUrl had a trailing slash; it was trimmed to "${base}" so the download URLs do not contain "//"`,
        ];
  return { ok: true, url: base, notes };
}

/** The homepage is a link, not a download instruction — a lower bar, stated. */
export function checkHomepage(raw: string): UrlCheck {
  const unsafe =
    checkUrlLiteral("homepage", raw) ??
    checkRubyString("homepage", raw) ??
    checkYamlScalar("homepage", raw);
  if (unsafe !== undefined) return { ok: false, message: unsafe };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `homepage "${raw}" is not a URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      message: `homepage "${raw}" is ${url.protocol.replace(":", "")} — a manifest's homepage is opened in a browser, so it has to be http(s)`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "homepage carries credentials in the URL" };
  }
  const notes =
    url.protocol === "http:"
      ? [
          "homepage is plain http; that is a page link rather than a download instruction, so it is allowed — but brew audit will complain",
        ]
      : [];
  return { ok: true, url: raw, notes };
}

/**
 * Why this host must not appear in a published download URL, or `undefined`.
 *
 * Used on the way out (refusing to GENERATE such a manifest) and on the way in
 * (flagging a PUBLISHED one that carries it), because the second case happens
 * to anyone who copies a manifest out of a staging environment.
 */
export function privateHostReason(hostname: string): string | undefined {
  const lower = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return `loopback ("${hostname}")`;
  if (lower.endsWith(".local")) return `an mDNS name ("${hostname}")`;
  // The classifier is `@crewhaus/tool-fetch`'s — the parsed one, which
  // understands `0177.0.0.1`, `2130706433` and `::ffff:169.254.169.254`. A
  // text comparison here would be the bypass it was written to close.
  const literal = normalizeIpv4(lower) ?? (lower.includes(":") ? lower : null);
  if (literal !== null && isPrivateIp(literal)) {
    return `a private or link-local address ("${hostname}")`;
  }
  return undefined;
}

export type ShaCheck =
  | {
      readonly ok: true;
      readonly sha256: ShaByTarget;
      readonly notes: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly message: Refusal };

/**
 * Normalize and check the sha map against what the SELECTED manifests need.
 *
 * "Needed" is per manifest: rendering only the Debian control needs no shas at
 * all, while the Homebrew formula needs four. An unknown key is refused rather
 * than ignored, because `macos_arm64` silently ignored reads back as "missing
 * sha256 for macos-arm64" and sends the caller looking in the wrong place.
 */
export function checkShas(
  raw: Readonly<Record<string, string>>,
  kinds: ReadonlyArray<ManifestKind>,
): ShaCheck {
  const notes: string[] = [];
  const known = new Set(TARGET_KEYS);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `sha256 has ${unknown.length === 1 ? "an entry" : "entries"} for ${unknown.map((k) => `"${k}"`).join(", ")}, which ${unknown.length === 1 ? "is not a build target" : "are not build targets"} — the targets are ${TARGET_KEYS.join(", ")}`,
    };
  }

  const out: Record<string, string> = {};
  for (const [target, value] of Object.entries(raw)) {
    if (!SHA256.test(value)) {
      return {
        ok: false,
        message: `sha256 for ${target} is ${value.length === 64 ? "not hex" : `${value.length} characters, not 64`}: "${value.slice(0, 80)}"`,
      };
    }
    if (value !== value.toLowerCase()) {
      // Hex case carries no information, and `shasum`, `certutil` and
      // `Get-FileHash` disagree about it. Lowercase is what the renderers
      // emit for brew/scoop and what winget's uppercasing starts from.
      notes.push(`sha256 for ${target} was uppercase; it was lowercased`);
    }
    out[target] = value.toLowerCase();
  }

  const needed = new Set<string>();
  for (const kind of kinds) for (const target of REQUIRED_TARGETS[kind]) needed.add(target);
  const missing = [...needed].filter((target) => out[target] === undefined).sort();
  if (missing.length > 0) {
    const who = missing.map(
      (target) =>
        `${target} (needed by ${MANIFEST_KINDS.filter((k) => kinds.includes(k) && REQUIRED_TARGETS[k].includes(target)).join(", ")})`,
    );
    return {
      ok: false,
      message: `sha256 is missing ${who.join("; ")}`,
    };
  }

  const spare = TARGET_KEYS.filter((target) => out[target] !== undefined && !needed.has(target));
  if (spare.length > 0) {
    notes.push(
      `sha256 also carried ${spare.join(", ")}, which ${kinds.join(" + ")} ${spare.length === 1 ? "does" : "do"} not reference — kept out of the manifests, not an error`,
    );
  }
  return { ok: true, sha256: out, notes };
}

/**
 * Everything the four renderers splice a product identity into, checked
 * against the format it lands in.
 *
 * Returns every problem rather than the first: a caller fixing a product block
 * should see all of it, and these are cheap checks over a handful of strings.
 */
export function checkProduct(product: ProductIdentity): ReadonlyArray<Refusal> {
  const problems: Refusal[] = [];
  const add = (message: Refusal | undefined): void => {
    if (message !== undefined) problems.push(message);
  };

  // binaryName is a filename inside every download URL, the Debian `Package:`
  // field and the scoop `bin`. Debian's own grammar for a package name is the
  // strictest of the three, and it is the one that has to hold.
  if (!/^[a-z0-9][a-z0-9+.-]{1,63}$/.test(product.binaryName)) {
    problems.push(
      `binaryName "${product.binaryName}" is not a Debian package name (lowercase letters, digits, "+", "-", "." — at least two characters, starting alphanumeric); it is also a filename in every download URL`,
    );
  }
  if (!/^[A-Z][A-Za-z0-9]*$/.test(product.formulaClass)) {
    problems.push(
      `formulaClass "${product.formulaClass}" is not a Ruby class name (CamelCase, starting with a capital)`,
    );
  }
  add(checkRubyString("shortDescription", product.shortDescription));
  add(checkYamlScalar("shortDescription", product.shortDescription));
  add(checkRubyString("license", product.license));
  add(checkYamlScalar("license", product.license));

  add(checkSingleLine("debian.section", product.debian.section));
  add(checkSingleLine("debian.maintainer", product.debian.maintainer));
  add(checkSingleLine("debian.depends", product.debian.depends));

  product.debian.longDescription.forEach((line, index) => {
    const where = `debian.longDescription[${index}]`;
    if (/[\r\n]/.test(line)) {
      problems.push(`${where} contains a line break — pass one array entry per line`);
      return;
    }
    if (/^[ \t]/.test(line)) {
      // THE trap this check exists for. The renderer writes ` ${line}`, so a
      // line that arrives already indented is published with two leading
      // spaces — and a double-spaced continuation is as broken as one that
      // lost its space, while reading as a harmless indentation change.
      problems.push(
        `${where} already starts with ${line.startsWith("\t") ? "a tab" : "a space"} — the Debian renderer adds the single leading space the control format requires, so this line would be published doubly indented, which stops it being a continuation line at all`,
      );
      return;
    }
    if (line.trim() === "") {
      problems.push(
        `${where} is blank — a control paragraph cannot contain an empty line; use "." for a paragraph break`,
      );
    }
  });

  add(checkYamlScalar("winget.packageIdentifier", product.winget.packageIdentifier));
  if (!/^[A-Za-z0-9-]{1,32}(\.[A-Za-z0-9-]{1,32}){1,3}$/.test(product.winget.packageIdentifier)) {
    problems.push(
      `winget.packageIdentifier "${product.winget.packageIdentifier}" is not a winget identifier (Publisher.Package, dot-separated, 2 to 4 parts)`,
    );
  }
  add(checkYamlScalar("winget.publisher", product.winget.publisher));
  add(checkYamlScalar("winget.author", product.winget.author));
  add(checkYamlScalar("winget.longDescription", product.winget.longDescription));
  product.winget.tags.forEach((tag, index) => {
    add(checkYamlScalar(`winget.tags[${index}]`, tag));
  });

  (product.homebrewMacosNote ?? []).forEach((line, index) => {
    const where = `homebrewMacosNote[${index}]`;
    if (/[\r\n]/.test(line)) {
      problems.push(`${where} contains a line break — pass one array entry per line`);
    }
    // A "#{" here is inside a Ruby COMMENT, where it is inert, so the Ruby
    // string rules do not apply. Only the line break matters.
  });

  return problems;
}

function checkSingleLine(field: string, value: string): Refusal | undefined {
  if (/[\r\n]/.test(value)) {
    return `${field} contains a line break — every Debian field here is one line, and a stray break splits the paragraph`;
  }
  return undefined;
}

/**
 * The class name Homebrew derives from a formula filename: `demo-driver.rb`
 * holds `class DemoDriver`. `ProductIdentity` keeps `formulaClass` separate
 * because the mapping is not reversible in general, so this is used for a
 * NOTE, never a refusal — `brew audit` is the authority, and it is the one
 * that will complain.
 */
export function homebrewClassFor(binaryName: string): string {
  return binaryName
    .split(/[-_@.]/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The file each manifest is published as, given the product. */
export function manifestFilename(kind: ManifestKind, product: ProductIdentity): string {
  switch (kind) {
    case "homebrew":
      return `Formula/${product.binaryName}.rb`;
    case "debian":
      return "debian/control";
    case "scoop":
      return `${product.binaryName}.json`;
    default:
      return `${product.winget.packageIdentifier}.installer.yaml`;
  }
}
