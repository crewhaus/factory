/**
 * The gate every proposed permission rule passes before this package will name
 * it — and the reason this package needed care at all.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO STOP
 * ---------------------------------------------------------------------------
 * A suggestion is built out of OBSERVED VALUES: the tool a human was asked
 * about, and the argument they were asked about it WITH. Both come off a
 * session log, so both are strings the harness saw rather than strings anyone
 * authored. `@crewhaus/tool-permission-matcher` reads `*` and `?` in a pattern
 * as wildcards, so a value spliced in raw stops meaning itself:
 *
 *     approved once:  Read  file_path = "notes/*.md"
 *     naive rule:     Read(notes/*.md)
 *     actually means: every .md file under notes/, forever
 *
 * That is a suggestion tool turning into a privilege-escalation tool, silently,
 * while showing the operator a pattern that LOOKS like the file they approved.
 *
 * `@crewhaus/harness-advice`'s `patternFor` already escapes the ARGUMENT
 * through `escapeGlobLiteral`. Two holes remain, and both are why this module
 * checks the finished pattern instead of trusting how it was built:
 *
 *   1. THE TOOL NAME IS ALSO AN OBSERVED VALUE. `patternFor` embeds
 *      `agg.toolName` verbatim on both of its paths. Built-in names are fixed,
 *      but an MCP tool's registered name is `<server>__<tool>` composed from
 *      strings a REMOTE server declares (`namespacedToolName` does no
 *      sanitising), so a hostile or careless server can register `notes__read*`
 *      and have "always allow the tool you approved" compile to a rule covering
 *      every tool whose name starts `notes__read`.
 *   2. A NAME CONTAINING A PAREN RE-SPLITS. `compilePattern` finds the first
 *      `(` and treats everything before it as the tool glob, so a tool named
 *      `Fetch(x` yields a rule about the DIFFERENT tool `Fetch` — one that was
 *      never approved and that really does reach the network.
 *   3. A NAME CONTAINING A BACKSLASH IS NOT THE NAME IT SPELLS. The glob
 *      grammar reads `\` as an escape lead-in, so `notes__read\*` compiles to
 *      /^notes__read\*$/ — a rule about the different tool `notes__read*`. The
 *      pattern text still equals the tool name, so no string comparison can see
 *      it; only running the matcher can, which is check (1b) below.
 *
 * ---------------------------------------------------------------------------
 * HOW IT CHECKS
 * ---------------------------------------------------------------------------
 * By RUNNING THE MATCHER, not by reading the pattern. The question "does this
 * rule mean only what it appears to mean" is answered by compiling it with the
 * same `compilePattern` the permission engine uses and asking it about the
 * approved call and about a set of near-misses. A rule that matches any
 * near-miss is refused: the operator is shown why, and it never reaches the
 * proposed settings diff.
 *
 * Refusing is always safe here. Nothing in this package applies a rule, so the
 * worst case of a false refusal is that a human writes the rule by hand — while
 * the worst case of a false accept is a standing grant nobody meant to give.
 */
import { hasUnescapedWildcard } from "@crewhaus/harness-advice";
import {
  OPERATIVE_ARG_FIELDS,
  compilePattern,
  matchesPattern,
} from "@crewhaus/tool-permission-matcher";

/**
 * A string no approved value will be, used to build near-misses. The NUL is
 * written as an escape rather than a raw byte so it survives every editor and
 * every diff, and it is a plain string constant — never a regex literal.
 */
const CANARY = "\u0000crewhaus-canary\u0000";

export type RuleVerdict =
  | {
      readonly ok: true;
      /** True when the rule constrains an argument as well as the tool name. */
      readonly argConstrained: boolean;
      /** The checks that were actually run, for the operator's record. */
      readonly checks: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Render a canary-bearing string for a human message, with the NUL sentinels
 *  taken back out. `split`/`join` rather than a regex: a control character in a
 *  regex literal is the lint this repository bans outright. */
function readable(text: string): string {
  return text.split("\u0000").join("");
}

/** The near-misses an argument-constrained rule must NOT match. */
export function argNearMisses(value: string): string[] {
  const misses = new Set<string>([
    `${value}${CANARY}`, // a longer value with the approved one as a prefix
    `${CANARY}${value}`, // …as a suffix
    "", // the empty argument
  ]);
  // Replace each glob/regex-significant character in turn. If the rule still
  // matches, that character was live rather than literal — which is precisely
  // the widening this module exists to catch.
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if ("*?[]{}().+^$|\\".includes(ch)) {
      misses.add(`${value.slice(0, i)}Z${value.slice(i + 1)}`);
    }
  }
  misses.delete(value);
  return [...misses];
}

/**
 * Verify a proposed rule against the call it claims to cover.
 *
 * `observedValue` is the operative-argument value the human approved, or
 * `undefined` for a bare tool grant (no argument constraint to check). The
 * verdict's `ok: false` reason is written for an operator, not a log.
 */
export function verifyRule(pattern: string, toolName: string, observedValue?: string): RuleVerdict {
  const checks: string[] = [];

  // (0) The engine must be able to compile it at all. An uncompilable rule is
  //     not inert: the engine fails closed, so a bad `alwaysAsk` gates every
  //     call as if it had matched and a bad `alwaysAllow` is dropped entirely.
  //     Either way it is not what the pattern says.
  let compiled: ReturnType<typeof compilePattern>;
  try {
    compiled = compilePattern(pattern);
  } catch (err) {
    return {
      ok: false,
      reason: `the permission matcher cannot compile "${pattern}" (${err instanceof Error ? err.message : String(err)}), and an uncompilable rule does not behave as written`,
    };
  }
  checks.push("compiles under the permission matcher");

  // (1) The pattern's tool half must be the observed name EXACTLY. This is the
  //     paren re-split guard: a tool literally named `Fetch(x` compiles to a
  //     rule about `Fetch`, a different tool nobody approved.
  if (compiled.toolGlob !== toolName) {
    return {
      ok: false,
      reason: `the rule's tool half parses as "${compiled.toolGlob}", not the approved tool "${toolName}" — the name carries a character the pattern grammar reads structurally, so this rule would govern a tool that was never approved`,
    };
  }
  checks.push("tool half parses back to the approved tool name exactly");

  // (1b) …and the ENGINE must agree that it names that tool. Check (1) compares
  //      TEXT; `permission-engine` acts on the COMPILED REGEX, and the two
  //      disagree for any name carrying a backslash, because the glob grammar
  //      reads `\` as an escape lead-in rather than as a character.
  //
  //      A tool an MCP server registers as `notes__read\*` spells its own name
  //      into the pattern, so the text check passes; `hasUnescapedWildcard`
  //      passes too, because the `*` IS escaped. But the pattern compiles to
  //      /^notes__read\*$/ — a rule that never fires for the tool it was
  //      derived from, and that governs the DIFFERENT tool `notes__read*`,
  //      which the same server can register alongside it. Validating one
  //      spelling while the engine acts on another is the failure class this
  //      module exists to stop, so the question is put to the matcher instead
  //      of to `===`.
  //
  //      `compiled.toolGlob` can never contain `(` (compilePattern splits at
  //      the first one), so compiling the half on its own cannot re-split.
  let toolOnly: ReturnType<typeof compilePattern>;
  try {
    toolOnly = compilePattern(compiled.toolGlob);
  } catch (err) {
    return {
      ok: false,
      reason: `the rule's tool half ${JSON.stringify(compiled.toolGlob)} does not compile on its own (${err instanceof Error ? err.message : String(err)}), so what tool it governs cannot be established`,
    };
  }
  if (!matchesPattern(toolOnly, toolName, {})) {
    return {
      ok: false,
      reason: `the rule spells the approved tool name ${JSON.stringify(toolName)} exactly, but the permission matcher does not match it against that tool: the name carries a backslash, which the glob grammar reads as an escape rather than as a character, so the compiled rule governs a DIFFERENT name and would never fire for the tool it was derived from`,
    };
  }
  checks.push("the matcher matches the rule's tool half against the approved tool name");

  // (2) No live wildcard in either half. `hasUnescapedWildcard` is
  //     harness-advice's own check, so this stays in step with the escaping
  //     `patternFor` does rather than second-guessing it.
  if (hasUnescapedWildcard(compiled.toolGlob)) {
    return {
      ok: false,
      reason: `the tool name "${toolName}" contains an unescaped glob wildcard, so the rule would cover every tool whose name matches it, not just the approved one`,
    };
  }
  if (compiled.argGlob !== null && hasUnescapedWildcard(compiled.argGlob)) {
    return {
      ok: false,
      reason:
        "the argument pattern contains an unescaped glob wildcard, so the rule would cover values the human never approved",
    };
  }
  checks.push("no live wildcard in either half");

  // (3) The rule must actually cover the call it was derived from. A rule that
  //     matches nothing is not "safe" — it is a proposal that will never fire,
  //     and the human who accepts it keeps being asked with no idea why.
  const field = OPERATIVE_ARG_FIELDS[toolName]?.[0];
  const probe = (value: string): unknown => (field === undefined ? value : { [field]: value });
  if (observedValue !== undefined) {
    if (!matchesPattern(compiled, toolName, probe(observedValue))) {
      return {
        ok: false,
        reason: "the rule does not match the very call it was derived from, so it would never fire",
      };
    }
    checks.push("matches the approved call");
  }

  // (4) The tool half must not reach past the approved name.
  for (const other of [`${toolName}${CANARY}`, `${CANARY}${toolName}`]) {
    if (matchesPattern(compiled, other, probe(observedValue ?? "x"))) {
      return {
        ok: false,
        reason: `the rule also matches a name neighbouring the approved tool ("${readable(other)}" with extra characters) — it is broader than the tool it names`,
      };
    }
  }
  checks.push("does not reach a neighbouring tool name");

  // (5) The argument half must match the approved value and nothing adjacent to
  //     it. This is the check that fails on an unescaped `*`, `?`, or on any
  //     future grammar change that makes another character live.
  if (observedValue !== undefined && compiled.argGlob !== null) {
    const misses = argNearMisses(observedValue);
    for (const miss of misses) {
      if (matchesPattern(compiled, toolName, probe(miss))) {
        return {
          ok: false,
          reason: `the rule also matches an argument the human never approved (${JSON.stringify(readable(miss))}) — a character in the observed value is being read as a wildcard rather than as itself`,
        };
      }
    }
    checks.push(`matches the approved argument and none of its ${misses.length} near-misses`);
  }

  return { ok: true, argConstrained: compiled.argGlob !== null, checks };
}
