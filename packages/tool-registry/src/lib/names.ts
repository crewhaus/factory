/**
 * Package-name validation, per ecosystem.
 *
 * This is the gate that makes the "one constant origin per registry" rule in
 * `./net` worth anything. The only caller-supplied text that reaches a URL is
 * a package name, so a name is checked against its registry's own grammar
 * BEFORE it is interpolated — `../-/user/org.couchdb.user:me` is a package
 * name the way `../../etc/passwd` is a filename, and a registry path is a
 * path.
 *
 * Validation is deliberately stricter than the encoder that follows it.
 * Percent-encoding alone would make `..%2F..` harmless to the origin but
 * would still send it, and the answer to "is `../foo` published?" is not a
 * 404, it is "that is not a package name".
 */
import type { Ecosystem } from "./net";

export type NameCheck =
  | { readonly ok: true; readonly name: string; readonly normalized: string }
  | { readonly ok: false; readonly message: string };

/** npm's own ceiling, from the days when the name became a directory name. */
const NPM_MAX = 214;
/** crates.io's published limit. */
const CRATES_MAX = 64;
/** No registry has a name this long; the cap keeps a megabyte out of a URL. */
const PYPI_MAX = 256;

/**
 * PEP 503: runs of `-`, `_` and `.` collapse to a single `-`, and the result
 * is lowercased. `Django_REST.framework` and `django-rest-framework` are the
 * same project, and PyPI's JSON endpoint answers to either — but two
 * spellings of one name would be two rows in an outdated table, so it is
 * normalised once, here.
 */
export function normalizePypiName(raw: string): string {
  return raw.replace(/[-_.]+/g, "-").toLowerCase();
}

/** Would this text change meaning once it is in a URL path? */
function hasUrlTrickery(raw: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being rejected.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return true;
  if (raw.includes("%") || raw.includes("?") || raw.includes("#") || raw.includes("\\"))
    return true;
  if (raw.includes("..")) return true;
  return raw !== raw.trim();
}

export function checkName(ecosystem: Ecosystem, raw: string): NameCheck {
  const refuse = (why: string): NameCheck => ({
    ok: false,
    message: `"${raw}" is not a valid ${ecosystem} package name: ${why}`,
  });
  if (raw === "") return refuse("it is empty");
  if (hasUrlTrickery(raw)) {
    return refuse("it contains a path, an escape or a control character");
  }

  if (ecosystem === "npm") {
    if (raw.length > NPM_MAX) return refuse(`npm names are at most ${NPM_MAX} characters`);
    const scoped = /^@([^/]+)\/(.+)$/.exec(raw);
    if (raw.startsWith("@") && scoped === null) return refuse("a scope must be followed by /name");
    const parts = scoped === null ? [raw] : [scoped[1] as string, scoped[2] as string];
    for (const part of parts) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]*$/.test(part)) {
        // Uppercase is allowed on the way IN because the registry still
        // serves the names it accepted years ago (JSONStream, CodeMirror);
        // it is refused for new publishes by npm, not by us.
        return refuse(
          "npm names are word characters, dots, hyphens and tildes, not starting with . or _",
        );
      }
    }
    return { ok: true, name: raw, normalized: raw };
  }

  if (ecosystem === "pypi") {
    if (raw.length > PYPI_MAX) return refuse(`names are at most ${PYPI_MAX} characters`);
    if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(raw)) {
      return refuse(
        "PEP 508 names are letters, digits, -, _ and ., starting and ending with a letter or digit",
      );
    }
    return { ok: true, name: raw, normalized: normalizePypiName(raw) };
  }

  if (raw.length > CRATES_MAX) return refuse(`crate names are at most ${CRATES_MAX} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw)) {
    return refuse("crate names are letters, digits, - and _, starting with a letter or digit");
  }
  return { ok: true, name: raw, normalized: raw.toLowerCase() };
}

/**
 * The name as one URL path segment.
 *
 * A scoped npm name becomes `@scope%2Fpkg`: the separator is escaped so that
 * nothing in between can read it as two path segments, and the leading `@`
 * is left literal because that is the form npm's own client sends and the
 * registry documents. `encodeURIComponent` alone would send `%40scope%2Fpkg`,
 * which relies on the registry decoding a sub-delimiter it never has to —
 * and if it does not, every scoped package answers 404, which this package
 * would report as `exists: false`. A wrong answer, not an error.
 */
export function nameForUrl(ecosystem: Ecosystem, name: string): string {
  if (ecosystem === "pypi") return encodeURIComponent(normalizePypiName(name));
  if (ecosystem === "npm" && name.startsWith("@")) {
    return `@${encodeURIComponent(name.slice(1))}`;
  }
  return encodeURIComponent(name);
}
