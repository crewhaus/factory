/**
 * Validation and encoding for every caller-supplied value that becomes part
 * of a URL.
 *
 * This is the codehost analogue of the argv-array rule. A tool that spawns a
 * process must never paste caller data into a shell string; a tool that calls
 * an HTTP API must never paste caller data into a URL path. The failure mode
 * is the same shape and just as cheap: an `owner` of `..` turns
 * `/repos/{owner}/{repo}/pulls` into `/repos/{repo}/pulls`, and a `repo` of
 * `x/../../user/repos` walks to a completely different resource. Percent
 * encoding alone does not fix it — `..` contains nothing that needs encoding
 * — so each value is CHECKED first and encoded second.
 *
 * Every function here is pure and has no network or filesystem access.
 */

/** A rejection, or `null` when the value is fine. */
export type Refusal = string | null;

/**
 * True when `value` holds a control character or a space.
 *
 * Written as a code-point walk rather than a character class: a regex with a
 * literal control character in it is unreadable, easy to mistype, and the
 * thing `noControlCharactersInRegex` exists to stop.
 */
function hasControlOrSpace(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A single repository, owner or group path segment.
 *
 * GitHub and GitLab both restrict these to letters, digits, `.`, `_` and `-`.
 * `.` and `..` are the two that matter: they are legal characters in a
 * filename and a traversal in a URL.
 */
export function checkSegment(field: string, value: string): Refusal {
  if (value === "") return `${field} is empty`;
  if (value.length > 100) return `${field} is longer than 100 characters`;
  if (value === "." || value === "..") {
    return `${field} "${value}" is a path traversal, not a name`;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return `${field} "${value}" contains characters no host allows in a name — letters, digits, ".", "_" and "-" only`;
  }
  return null;
}

/**
 * An owner or namespace, which on GitLab may be a group path with slashes
 * (`group/subgroup`). Each part is checked as a segment, so a `..` anywhere
 * in the chain is refused.
 */
export function checkOwner(value: string): Refusal {
  if (value === "") return "owner is empty";
  if (value.startsWith("/") || value.endsWith("/")) {
    return `owner "${value}" has a leading or trailing "/"`;
  }
  const parts = value.split("/");
  if (parts.length > 10) return "owner has more than ten path parts";
  for (const part of parts) {
    const refusal = checkSegment("owner", part);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * A git ref: a branch, tag or sha.
 *
 * Slashes are legal and common (`release/1.2`), so this cannot reuse
 * `checkSegment`. The rules are the subset of `git check-ref-format` that a
 * URL cares about, plus a refusal of anything that is not printable ASCII —
 * a ref with a newline in it is either a mistake or an attempt to split
 * something downstream.
 */
export function checkRef(field: string, value: string): Refusal {
  if (value === "") return `${field} is empty`;
  if (value.length > 255) return `${field} is longer than 255 characters`;
  if (hasControlOrSpace(value)) {
    return `${field} contains a control character or a space, which no git ref may`;
  }
  if (value.startsWith("/") || value.endsWith("/")) {
    return `${field} "${value}" has a leading or trailing "/"`;
  }
  if (value.startsWith("-")) {
    // Harmless in a URL, refused anyway: the same value is routinely handed
    // to a git command line elsewhere in a fleet job, where a leading "-" is
    // read as an option. Keeping one rule for what a ref may look like is
    // cheaper than remembering which sink is safe.
    return `${field} "${value}" starts with "-", which git reads as an option`;
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return `${field} "${value}" contains an empty or traversal path part`;
  }
  if (value.includes("@{") || value.includes("\\") || value.includes("~") || value.includes("^")) {
    return `${field} "${value}" contains a git revision operator — pass a plain branch, tag or sha`;
  }
  if (value.endsWith(".lock")) return `${field} "${value}" ends with ".lock"`;
  return null;
}

/**
 * A list both hosts take as ONE comma-separated string.
 *
 * Labels are the case: GitHub's `labels` filter and every GitLab label field
 * are a single string the host splits on commas. A label whose own name
 * contains a comma therefore does not travel as one label — it silently
 * becomes two, which on a write means relabelling an issue with names nobody
 * asked for. The separator is the host's, so the value is refused here rather
 * than escaped into something the host would not understand.
 */
export function joinCommaList(
  field: string,
  values: readonly string[],
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string } {
  for (const value of values) {
    if (value.includes(",")) {
      return {
        ok: false,
        message: `${field} entry "${value}" contains a comma, and this host takes ${field} as one comma-separated string — sending it would silently become two entries`,
      };
    }
  }
  return { ok: true, value: values.join(",") };
}

/** A positive integer identifier (PR number, issue iid, run id). */
export function checkId(field: string, value: number): Refusal {
  if (!Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive whole number, got ${String(value)}`;
  }
  if (value > Number.MAX_SAFE_INTEGER) return `${field} is too large`;
  return null;
}

/**
 * A ref as it appears inside a URL PATH.
 *
 * Slashes stay slashes — both hosts accept `heads/release/1.2` in a path —
 * and everything else is percent-encoded. Called only after `checkRef`.
 */
export function encodePathRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/**
 * GitLab addresses a project by the URL-encoded `namespace/project` path, so
 * the separating slash is encoded too. Called only after `checkOwner` and
 * `checkSegment`.
 */
export function gitlabProjectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

/** A GitHub path prefix for a repository. Called only after validation. */
export function githubRepoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Build a query string from values that may be absent, in sorted key order so
 * the same call produces the same URL every time — which is what makes an
 * HTTP cache, a recorded fixture and a diff of two runs all line up.
 */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const pairs: Array<[string, string]> = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    pairs.push([key, String(value)]);
  }
  if (pairs.length === 0) return "";
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
}
