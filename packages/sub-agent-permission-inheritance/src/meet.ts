/**
 * The decision-level MEET of two rule sets: for every call, the result is at
 * most as permissive as either input (deny < ask < allow). A sub-agent
 * definition read from `.crewhaus/sub-agents/` runs under the meet of its
 * parent's rules and its own `{ allow, deny }` set, so it can narrow the
 * parent but never widen it, and never widen what its own list allows.
 *
 * `evaluateWithReason` is first-match-wins, so the meet is built as one
 * ordered list, in the highest-priority source:
 *
 *   1. every deny from either set;
 *   2. every ask from either set;
 *   3. for each pair of allows, one from each set, the pattern that matches
 *      exactly the calls BOTH match — when this grammar can write it;
 *
 * then the mode's own fallback, which both sets share. A call that matches no
 * deny or ask gets `allow` only when both sets allow it; any other call falls
 * through to the fallback, as it would in the set that did not allow it.
 *
 * Where the meet is not exact it is stricter, never wider: a deny or ask that
 * an earlier allow shadowed in its own set now gates first (so does
 * `narrowRuleSet`), and a pair of allows whose overlap no single pattern
 * writes grants nothing. The randomised property test in `meet.test.ts` pins
 * `evaluate(meet) ≤ evaluate(each input)`.
 */
import type { PermissionRule, RuleSet } from "@crewhaus/permission-engine";
import { type CompiledPattern, compilePattern } from "@crewhaus/tool-permission-matcher";

const SOURCE_ORDER = ["flag", "settings", "yaml", "hooks", "builtin"] as const;

function flatten(rules: RuleSet): ReadonlyArray<PermissionRule> {
  return SOURCE_ORDER.flatMap((source) => rules[source]);
}

/** A glob with no `*`, `?` or `\`: it matches only itself. */
function isLiteral(glob: string): boolean {
  return !/[*?\\]/.test(glob);
}

/** `prefix**` with a literal prefix, or undefined. */
function literalPrefix(glob: string): string | undefined {
  if (!glob.endsWith("**")) return undefined;
  const prefix = glob.slice(0, -2);
  return isLiteral(prefix) ? prefix : undefined;
}

/** True only when every string `inner` matches, `outer` matches too — proven, not guessed. */
function argSubsumes(outer: CompiledPattern, inner: CompiledPattern): boolean {
  const o = outer.argGlob;
  const i = inner.argGlob;
  if (o === null) return true;
  if (i === null) return false;
  if (o === i || o === "**") return true;
  if (isLiteral(i)) return outer._argRe?.test(i) === true;
  const ip = literalPrefix(i);
  const op = literalPrefix(o);
  if (ip === undefined || op === undefined || !ip.startsWith(op)) return false;
  // `a/**` also matches `a` itself; that string must be in `outer` too.
  return !ip.endsWith("/") || outer._argRe?.test(ip.slice(0, -1)) === true;
}

function intersectTools(a: CompiledPattern, b: CompiledPattern): string | undefined {
  const x = a.toolGlob;
  const y = b.toolGlob;
  if (x === y) return x;
  // Tool names carry no `/`, so a bare `*` or `**` matches every one.
  if (x === "*" || x === "**") return y;
  if (y === "*" || y === "**") return x;
  if (isLiteral(x) && b._toolRe.test(x)) return x;
  if (isLiteral(y) && a._toolRe.test(y)) return y;
  return undefined;
}

/**
 * The pattern matching exactly the calls both `a` and `b` match, when one of
 * them contains the other's argument set; undefined when the overlap is empty
 * or not writable as one pattern (the meet then grants nothing for the pair).
 */
export function intersectPatterns(a: string, b: string): string | undefined {
  let ca: CompiledPattern;
  let cb: CompiledPattern;
  try {
    ca = compilePattern(a);
    cb = compilePattern(b);
  } catch {
    return undefined;
  }
  const tool = intersectTools(ca, cb);
  if (tool === undefined) return undefined;
  let arg: string | null;
  if (argSubsumes(ca, cb)) arg = cb.argGlob;
  else if (argSubsumes(cb, ca)) arg = ca.argGlob;
  else return undefined;
  return arg === null ? tool : `${tool}(${arg})`;
}

export type RuleSetMeet = {
  readonly rules: RuleSet;
  /** Allow patterns of `b` that no allow of `a` shares any writable overlap with. */
  readonly ungranted: ReadonlyArray<string>;
};

/** The meet of `a` and `b`; `ungranted` names `b`'s allows it cannot grant at all. */
export function meetRuleSets(a: RuleSet, b: RuleSet): RuleSetMeet {
  const all = [...flatten(a), ...flatten(b)];
  const gate = (type: PermissionRule["type"]): PermissionRule[] =>
    all.filter((r) => r.type === type).map((r) => ({ ...r, source: "flag" as const }));
  const allowsA = flatten(a).filter((r) => r.type === "alwaysAllow");
  const allowsB = flatten(b).filter((r) => r.type === "alwaysAllow");
  const granted = new Set<string>();
  const ungranted: string[] = [];
  for (const rb of allowsB) {
    let any = false;
    for (const ra of allowsA) {
      const both = intersectPatterns(ra.pattern, rb.pattern);
      if (both === undefined) continue;
      granted.add(both);
      any = true;
    }
    if (!any && !ungranted.includes(rb.pattern)) ungranted.push(rb.pattern);
  }
  const allows: PermissionRule[] = [...granted].map((pattern) => ({
    type: "alwaysAllow",
    pattern,
    source: "flag",
  }));
  return {
    rules: {
      flag: [...gate("alwaysDeny"), ...gate("alwaysAsk"), ...allows],
      settings: [],
      yaml: [],
      hooks: [],
      builtin: [],
    },
    ungranted,
  };
}
