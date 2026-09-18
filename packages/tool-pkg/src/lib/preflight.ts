/**
 * Checks to run on a package directory before publishing it.
 *
 * Every one of these is a mistake that passes every test, because it is a
 * property of the *published artifact* rather than of the source tree: a
 * `workspace:` range npm cannot resolve, an entry point outside the `files`
 * allow-list, a `.env` that would ship. The tree is fine; what comes out of
 * it is not.
 *
 * The filesystem is reached through a {@link PreflightProbe} rather than
 * directly, so the rules are pure and testable without laying out a tree on
 * disk for each case.
 */

export type PreflightProbe = {
  /** Does this workspace-relative path exist, as a file or a directory? */
  readonly exists: (rel: string) => boolean;
  readonly isDirectory: (rel: string) => boolean;
};

export const SEVERITIES = ["blocking", "warning"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Problem = {
  readonly id: string;
  readonly severity: Severity;
  readonly message: string;
};

export type PreflightReport = {
  readonly ok: boolean;
  readonly name: string | null;
  readonly version: string | null;
  readonly blocking: ReadonlyArray<Problem>;
  readonly warnings: ReadonlyArray<Problem>;
  readonly checked: number;
};

/** Files npm always publishes, whatever `files` says. */
const ALWAYS_INCLUDED = [
  "package.json",
  "readme",
  "readme.md",
  "license",
  "license.md",
  "licence",
  "licence.md",
  "notice",
  "changelog",
  "changelog.md",
];

/** Names that should never leave the machine. */
const SECRET_NAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  "id_rsa",
  "id_ed25519",
  ".pypirc",
  "credentials.json",
  "service-account.json",
];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const clean = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Match a `*` glob against a path, without building a regular expression.
 *
 * The regex form of this — each `*` becoming `[^/]*` — backtracks
 * catastrophically: a `files` entry of thirty asterisks against a
 * forty-character path does not finish at all. A `files` entry is
 * operator-written and the path comes off disk, so neither is hostile by
 * intent, but a preflight check that hangs on a typo is not a preflight
 * check.
 *
 * This is the standard two-pointer wildcard match: on a mismatch it extends
 * the most recent `*` by one character and resumes, which is quadratic at
 * worst and never exponential. A `*` does not cross a path separator, which
 * is what npm does.
 */
function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = -1;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
      continue;
    }
    if (p < pattern.length && pattern[p] === "*") {
      starP = p;
      starT = t;
      p++;
      continue;
    }
    if (starP !== -1) {
      // Extend the most recent `*` by one character. It may not swallow a
      // separator, or `src/*` would match `src/a/b`.
      if (text[starT] === "/") return false;
      starT++;
      t = starT;
      p = starP + 1;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Whether `files` would include `target`.
 *
 * This approximates npm's rules: an entry matches a path that equals it, sits
 * under it as a directory, or matches it as a simple `*` glob. It is an
 * approximation on purpose — npm layers .npmignore, .gitignore and a set of
 * always-included names on top — so a *positive* answer here is not proof.
 * `PackageTarballInspect` on real `npm pack` output is the authoritative
 * check, and this exists to catch the obvious case before you get that far.
 */
export function wouldInclude(files: ReadonlyArray<string>, target: string): boolean {
  const path = clean(target);
  if (ALWAYS_INCLUDED.includes(path.toLowerCase())) return true;
  for (const raw of files) {
    const entry = clean(raw);
    if (entry === "") continue;
    if (entry === path) return true;
    if (path.startsWith(`${entry}/`)) return true;
    if (entry.includes("*") && globMatch(entry, path)) return true;
  }
  return false;
}

/** Every path a manifest declares as an entry point. */
export function entryPoints(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["main", "module", "types", "typings", "browser", "unpkg"]) {
    const value = manifest[key];
    if (typeof value === "string") out.push(value);
  }
  const bin = manifest["bin"];
  if (typeof bin === "string") out.push(bin);
  else if (bin !== null && typeof bin === "object") {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === "string") out.push(value);
    }
  }
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith(".")) out.push(value);
      return;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const inner of Object.values(value as Record<string, unknown>)) walk(inner);
    }
  };
  walk(manifest["exports"]);
  return [...new Set(out.map(clean))];
}

export function preflight(
  manifest: Record<string, unknown>,
  probe: PreflightProbe,
): PreflightReport {
  const problems: Problem[] = [];
  const add = (id: string, severity: Severity, message: string): void => {
    problems.push({ id, severity, message });
  };

  const name = typeof manifest["name"] === "string" ? (manifest["name"] as string) : null;
  const version = typeof manifest["version"] === "string" ? (manifest["version"] as string) : null;

  if (name === null) add("name-missing", "blocking", "package.json has no name");
  if (version === null) add("version-missing", "blocking", "package.json has no version");
  else if (!SEMVER_RE.test(version)) {
    add("version-invalid", "blocking", `version "${version}" is not a valid semver`);
  }

  if (manifest["private"] === true) {
    add("private-true", "blocking", "private: true — npm will refuse to publish this package");
  }

  // A workspace: range is the one that reliably survives every local test and
  // then fails for everyone else: it resolves inside the monorepo and means
  // nothing to a registry client.
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (deps === null || typeof deps !== "object") continue;
    for (const [dep, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== "string") continue;
      if (/^(workspace|link|file|portal):/.test(range)) {
        add(
          "unpublishable-range",
          "blocking",
          `${field}.${dep} is "${range}" — a registry client cannot resolve that; it must be a version range at publish time`,
        );
      }
    }
  }

  const filesField = Array.isArray(manifest["files"])
    ? (manifest["files"] as unknown[]).filter((f): f is string => typeof f === "string")
    : null;

  for (const entry of entryPoints(manifest)) {
    if (!probe.exists(entry)) {
      add("entry-missing", "blocking", `entry point "${entry}" does not exist`);
      continue;
    }
    if (filesField !== null && !wouldInclude(filesField, entry)) {
      add(
        "entry-excluded",
        "blocking",
        `entry point "${entry}" exists but no "files" entry covers it — it would be missing from the published tarball`,
      );
    }
  }

  if (filesField === null) {
    add(
      "no-files-field",
      "warning",
      'no "files" field — everything not ignored gets published, which is how build output and scratch files escape',
    );
  } else {
    for (const entry of filesField) {
      if (!entry.includes("*") && !probe.exists(clean(entry))) {
        add("files-entry-missing", "warning", `"files" lists "${entry}", which does not exist`);
      }
    }
  }

  for (const secret of SECRET_NAMES) {
    if (!probe.exists(secret)) continue;
    const included = filesField === null || wouldInclude(filesField, secret);
    add(
      "secret-file",
      included ? "blocking" : "warning",
      included
        ? `"${secret}" is in the package directory and would be published`
        : `"${secret}" is in the package directory; "files" excludes it, but it should not be here`,
    );
  }

  if (typeof manifest["license"] !== "string") {
    add("license-missing", "warning", "no license field");
  } else if (!probe.exists("LICENSE") && !probe.exists("LICENSE.md") && !probe.exists("LICENCE")) {
    add("license-file-missing", "warning", "a license is declared but no LICENSE file is present");
  }

  if (!probe.exists("README.md") && !probe.exists("README")) {
    add("readme-missing", "warning", "no README — the registry page will be empty");
  }

  if (manifest["repository"] === undefined) {
    add("repository-missing", "warning", "no repository field, so provenance cannot be linked");
  }

  const blocking = problems.filter((p) => p.severity === "blocking");
  const warnings = problems.filter((p) => p.severity === "warning");
  return { ok: blocking.length === 0, name, version, blocking, warnings, checked: problems.length };
}
