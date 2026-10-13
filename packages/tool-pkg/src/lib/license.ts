/**
 * Roll up the licenses of an installed dependency tree.
 *
 * The question a release needs answered is "is there anything in here we
 * cannot ship?", and it is answered by reading a few thousand small JSON
 * files — mechanical, and wrong to spend a model on. What this reports is
 * what the packages *declare*; it does not read license texts, and a package
 * that declares MIT while shipping something else will be reported as MIT.
 */

/** Families that carry obligations worth a human decision before shipping. */
const COPYLEFT = [
  "AGPL",
  "GPL",
  "LGPL",
  "MPL",
  "EPL",
  "CDDL",
  "OSL",
  "EUPL",
  "SSPL",
  "CC-BY-SA",
  "CC-BY-NC",
] as const;

export type LicenseFinding = {
  readonly name: string;
  readonly version: string;
  /** The declared expression, or "" when the package declares nothing. */
  readonly license: string;
  /** The individual identifiers, with OR/AND and parentheses resolved away. */
  readonly identifiers: ReadonlyArray<string>;
};

export type LicensePolicy = {
  /** Identifiers or prefixes that must not appear, e.g. ["AGPL", "SSPL"]. */
  readonly deny?: ReadonlyArray<string>;
  /** When set, anything outside this list is a violation. */
  readonly allow?: ReadonlyArray<string>;
};

export type LicenseReport = {
  readonly packages: number;
  /** Identifier to count, highest first, ties broken alphabetically. */
  readonly counts: ReadonlyArray<{ readonly license: string; readonly count: number }>;
  /** Packages declaring nothing at all — the ones that need a human. */
  readonly undeclared: ReadonlyArray<LicenseFinding>;
  readonly copyleft: ReadonlyArray<LicenseFinding>;
  readonly violations: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly rule: string;
  }>;
};

/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The length of `OR`, `AND` or `WITH` at `at`, in either case, or 0. */
function operatorAt(text: string, at: number): number {
  for (const word of ["or", "and", "with"]) {
    let i = 0;
    for (; i < word.length; i++) {
      const c = text.charCodeAt(at + i);
      // ASCII case only, as `/i` without `u` folds these letters.
      const lower = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
      if (lower !== word.charCodeAt(i)) break;
    }
    if (i === word.length) return word.length;
  }
  return 0;
}

/**
 * `text` split at each `OR`, `AND` or `WITH` with whitespace on both sides:
 * what `text.split(/\s+(?:OR|AND|WITH)\s+/i)` returned, in one pass. That
 * pattern tried every start inside a run of whitespace and, where no operator
 * followed the run, rescanned the rest of it from each before giving the
 * start up, so a long run was quadratic in its length; a license field is
 * whatever a package.json holds.
 */
export function splitAtOperators(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (!isRegExpSpace(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const runStart = i;
    while (i < text.length && isRegExpSpace(text.charCodeAt(i))) i++;
    const word = operatorAt(text, i);
    if (word > 0 && isRegExpSpace(text.charCodeAt(i + word))) {
      out.push(text.slice(from, runStart));
      i += word;
      while (i < text.length && isRegExpSpace(text.charCodeAt(i))) i++;
      from = i;
    }
  }
  out.push(text.slice(from));
  return out;
}

/**
 * Split an SPDX expression into the identifiers it names.
 *
 * `(MIT OR Apache-2.0)` is two identifiers, and a policy has to see both:
 * denying GPL should not fire on `MIT OR GPL-2.0` — the user may take the
 * MIT arm — but it must fire on `MIT AND GPL-2.0`, where both apply. This
 * returns the identifiers; {@link evaluatePolicy} is where the distinction
 * between OR and AND is made.
 */
export function splitExpression(expression: string): string[] {
  return splitAtOperators(expression.replace(/[()]/g, " "))
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^(OR|AND|WITH)$/i.test(part));
}

/** True when the expression's arms are alternatives rather than cumulative. */
export function isDisjunctive(expression: string): boolean {
  return /\sOR\s/i.test(expression) && !/\sAND\s/i.test(expression);
}

function matchesRule(identifier: string, rule: string): boolean {
  const id = identifier.toUpperCase();
  const r = rule.toUpperCase();
  return r.endsWith("*") ? id.startsWith(r.slice(0, -1)) : id === r || id.startsWith(`${r}-`);
}

export function isCopyleft(identifiers: ReadonlyArray<string>): boolean {
  return identifiers.some((id) => COPYLEFT.some((family) => matchesRule(id, family)));
}

export function summarize(
  findings: ReadonlyArray<LicenseFinding>,
  policy: LicensePolicy = {},
): LicenseReport {
  const tally = new Map<string, number>();
  const undeclared: LicenseFinding[] = [];
  const copyleft: LicenseFinding[] = [];
  const violations: LicenseReport["violations"] = [];

  for (const finding of findings) {
    const key = finding.license === "" ? "UNDECLARED" : finding.license;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (finding.license === "") {
      undeclared.push(finding);
      continue;
    }
    if (isCopyleft(finding.identifiers)) copyleft.push(finding);

    // For `A OR B` the consumer picks one arm, so a rule only bites when it
    // bites EVERY arm. For `A AND B` both apply, so one is enough.
    const disjunctive = isDisjunctive(finding.license);
    const test = (rule: string, hit: (id: string) => boolean): boolean =>
      disjunctive ? finding.identifiers.every(hit) : finding.identifiers.some(hit);

    for (const rule of policy.deny ?? []) {
      if (test(rule, (id) => matchesRule(id, rule))) {
        (violations as Array<LicenseReport["violations"][number]>).push({
          name: finding.name,
          version: finding.version,
          license: finding.license,
          rule: `denied: ${rule}`,
        });
      }
    }
    if (policy.allow && policy.allow.length > 0) {
      const allowed = (id: string): boolean =>
        (policy.allow as ReadonlyArray<string>).some((rule) => matchesRule(id, rule));
      const ok = disjunctive
        ? finding.identifiers.some(allowed)
        : finding.identifiers.every(allowed);
      if (!ok) {
        (violations as Array<LicenseReport["violations"][number]>).push({
          name: finding.name,
          version: finding.version,
          license: finding.license,
          rule: "outside the allow-list",
        });
      }
    }
  }

  const counts = [...tally.entries()]
    .map(([license, count]) => ({ license, count }))
    .sort((a, b) => b.count - a.count || (a.license < b.license ? -1 : 1));

  return { packages: findings.length, counts, undeclared, copyleft, violations };
}

/** Read the declared license out of a parsed package.json. */
export function declaredLicense(manifest: Record<string, unknown>): string {
  const direct = manifest["license"];
  if (typeof direct === "string") return direct.trim();
  if (direct !== null && typeof direct === "object") {
    const type = (direct as Record<string, unknown>)["type"];
    if (typeof type === "string") return type.trim();
  }
  // The `licenses: [{type}]` array is deprecated but still in the wild, and
  // treating those packages as undeclared would send a human to look at a
  // package that did say what it was.
  const legacy = manifest["licenses"];
  if (Array.isArray(legacy)) {
    const types = legacy
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof (entry as Record<string, unknown>)?.["type"] === "string"
            ? ((entry as Record<string, unknown>)["type"] as string)
            : "",
      )
      .filter((t) => t !== "");
    if (types.length > 0) return types.join(" OR ");
  }
  return "";
}
