/**
 * Permission rules that can never do what they say — found before a run.
 *
 * The engine matches a rule's tool half against a tool's REGISTERED name and
 * its argument half against the fields the tool declares as operative. A
 * rule that gets either wrong is not an error at run time: it simply never
 * matches, and the call falls through to the next rule or the mode's
 * fallback. `crewhaus lint`, `compile` and `PermissionAudit` use this to say
 * so while the spec is being written (permission-integration#12).
 *
 * Only what can be shown is reported. A rule naming a tool this module has
 * never heard of is NOT reported as dead — the runtime adds tools a spec does
 * not list (`Task`, `Consult`, a sub-agent's tools from disk) — unless the
 * name is one or two letters away from a tool it does know. The caller's
 * `known` list must therefore carry the tools the runtime registers on its
 * own (`Skill`, the browser shape's `Type`), not only the builtins, or a real
 * tool name reads as a typo of a builtin.
 *
 * A correction never widens an allow: when the nearest name belongs to a tool
 * that can change or delete things, or needs a sandbox (or its flags are not
 * known), an allow rule is reported without a `Write "…"` fix, because
 * following it would grant that tool.
 *
 * A rule is matched against a name exactly, so `REMOVEPATH`, `remove_path`
 * and `Codegraph*` never fire on RemovePath or CodeGraphSearch; they are
 * found by folding case and dropping `_`, `-` and spaces on both sides.
 *
 * A glob that can still match a tool of an MCP server the spec declares
 * (`*write*` reaches `mcp__fs__write_file`) is not dead, so it is never
 * reported as one. When it reaches no granted builtin it resembles, that is
 * a `builtin-not-reached` note, which names the builtins and offers no
 * rewrite; `compile --strict` does not escalate it.
 *
 * Pure: plain data in, findings out.
 */
import { PatternParseError, compilePattern, matchesToolName } from "./index";

/** What the checker needs to know about one tool. */
export type RuleToolDescriptor = {
  /** The registered name a rule's tool half is matched against (`RemovePath`). */
  readonly name: string;
  /** The key a spec lists it under, when that differs (`removePath`). */
  readonly key?: string;
  /**
   * The tool's `operativeArgs`. Absent when it declares none, which leaves
   * nothing to check an argument pattern against.
   */
  readonly operativeArgs?: ReadonlyArray<{ readonly kind: string }>;
  /** Its flags, when known. Absent reads as "may be destructive". */
  readonly destructive?: boolean;
  readonly requiresSandbox?: boolean;
};

export type PermissionRuleProblemCode =
  /** The tool half is a spec key (`removePath`); rules use the name (`RemovePath`). */
  | "tool-key-not-name"
  /** The tool half matches no tool, and is a near miss of one that exists. */
  | "unknown-tool"
  /** `mcp__<server>__…` for a server the spec does not declare. */
  | "unknown-mcp-server"
  /** An argument pattern on a tool with no argument that says where it acts. */
  | "argument-not-scoped"
  /** An argument pattern no value of the tool's operative fields can match. */
  | "argument-cannot-match"
  /**
   * INFORMATIONAL, not a dead rule: a glob that can match tools of a declared
   * MCP server, and reaches no granted builtin whose key or spelling it
   * resembles. It still fires on the MCP tools; the note names the builtins.
   */
  | "builtin-not-reached";

export type PermissionRuleProblem = {
  readonly type: string;
  readonly pattern: string;
  readonly code: PermissionRuleProblemCode;
  /** What is wrong, and what to write instead. */
  readonly message: string;
  /** The corrected pattern, when there is exactly one. */
  readonly suggestion?: string;
};

export type PermissionRuleProblemsInput = {
  readonly rules: ReadonlyArray<{ readonly type: string; readonly pattern: string }>;
  /** The tools the spec grants. */
  readonly granted: ReadonlyArray<RuleToolDescriptor>;
  /** Every tool the caller knows exists (the builtins), granted or not. */
  readonly known: ReadonlyArray<RuleToolDescriptor>;
  /** The MCP server names the spec declares. */
  readonly mcpServers: ReadonlyArray<string>;
};

const GLOB_META = /[*?\\]/;
const METHOD_THEN_REST = /^[A-Za-z]+\s+(.+)$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

function split(pattern: string): { tool: string; arg: string | null } {
  const paren = pattern.indexOf("(");
  if (paren === -1) return { tool: pattern.trim(), arg: null };
  return { tool: pattern.slice(0, paren).trim(), arg: pattern.slice(paren + 1, -1) };
}

function withTool(pattern: string, tool: string): string {
  const { arg } = split(pattern);
  return arg === null ? tool : `${tool}(${arg})`;
}

/** Levenshtein distance, capped: anything past `cap` is reported as `cap + 1`. */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? cap + 1;
}

/**
 * The text a glob must start with: everything before its first wildcard,
 * with escapes resolved.
 */
function literalPrefix(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      out += glob.charAt(i + 1);
      i++;
    } else if (ch === "*" || ch === "?") {
      break;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Can this argument glob match any URL? A URL is compared in its parsed
 * form, which always starts with a scheme and a colon (`https:`), so a glob
 * whose fixed start cannot begin that way — `GET https://…` — never matches.
 */
export function argGlobCanMatchUrl(argGlob: string): boolean {
  const prefix = literalPrefix(argGlob);
  const colon = prefix.indexOf(":");
  const scheme = colon === -1 ? prefix : prefix.slice(0, colon);
  // A scheme is a letter, then letters, digits, `+`, `-` or `.`; the fixed
  // start may stop part-way through one (`ht*`).
  return scheme === "" ? colon === -1 : SCHEME.test(scheme);
}

/** When a URL glob was written after an HTTP method (`GET https://…`), the glob without it. */
function withoutMethodPrefix(argGlob: string): string | undefined {
  const rest = argGlob.match(METHOD_THEN_REST)?.[1];
  return rest !== undefined && argGlobCanMatchUrl(rest) ? rest : undefined;
}

/**
 * `glob` re-cased to match `name`, for the shapes a case-only rewrite can be
 * derived for: an exact name, `prefix*`, `*suffix` and `*middle*` whose
 * literal part appears in `name` ignoring case. Undefined otherwise.
 */
function recasedGlob(glob: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (!GLOB_META.test(glob)) return glob.toLowerCase() === lower ? name : undefined;
  const inner = /^(\*?)([^*?\\]+)(\*?)$/.exec(glob);
  if (inner === null) return undefined;
  const [, lead, literal, trail] = inner as unknown as [string, string, string, string];
  const want = literal.toLowerCase();
  let at: number;
  if (lead === "" && trail === "*") at = lower.startsWith(want) ? 0 : -1;
  else if (lead === "*" && trail === "")
    at = lower.endsWith(want) ? lower.length - want.length : -1;
  else if (lead === "*" && trail === "*") at = lower.indexOf(want);
  else return undefined;
  return at === -1 ? undefined : `${lead}${name.slice(at, at + literal.length)}${trail}`;
}

/** Lower-cased, without the `_`, `-` and spaces people put between words. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * `glob` folded the way {@link fold} folds a name: its literal text
 * lower-cased and stripped of `_`, `-` and spaces, its wildcards and escapes
 * kept.
 */
function foldGlob(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      const next = glob.charAt(i + 1);
      i++;
      if (!/[\s_-]/.test(next)) out += `\\${next.toLowerCase()}`;
    } else if (ch === "*" || ch === "?") {
      out += ch;
    } else if (!/[\s_-]/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/**
 * The declared MCP servers a tool glob can still reach, in either spelling
 * (`mcp__<server>__<tool>`, or the pre-0.7.1 `<server>__<tool>` the matcher
 * still honours). Judged from the glob's fixed start, so it may say yes for
 * a glob whose tail rules the server's tools out, never no for one that can
 * reach them. An exact `mcp__…` name is handled where `mcp__` rules are; an
 * exact name in the old spelling (`web__fetch`) reaches its server here.
 */
function mcpServersReached(glob: string, servers: ReadonlySet<string>): string[] {
  if (!GLOB_META.test(glob)) {
    return [...servers].filter(
      (server) => glob.startsWith(`${server}__`) && glob.length > server.length + 2,
    );
  }
  const fixed = literalPrefix(glob);
  return [...servers].filter((server) =>
    [`mcp__${server}__`, `${server}__`].some(
      (start) => fixed.startsWith(start) || start.startsWith(fixed),
    ),
  );
}

/** `a`, `a and b`, `a, b and c`; past six, the first five and a count. */
function listNames(names: readonly string[]): string {
  const shown = names.length > 6 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
  return shown.length === 1
    ? (shown[0] as string)
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * The tools a rule that reaches none of them by name was written for: every
 * tool in `pool` whose spec key the glob matches, or whose name or key it
 * matches once case, `_`, `-` and spaces are set aside. Empty when the glob
 * reaches any tool in `pool` by its name — then it is a live spelling of a
 * tool that exists, not a misspelling of one.
 */
function toolsMisspelled(
  compiled: ReturnType<typeof compilePattern>,
  toolGlob: string,
  pool: readonly RuleToolDescriptor[],
): RuleToolDescriptor[] {
  if (pool.some((t) => matchesToolName(compiled, t.name))) return [];
  const folded = foldGlob(toolGlob);
  let foldedCompiled: ReturnType<typeof compilePattern> | undefined;
  try {
    foldedCompiled = folded === "" ? undefined : compilePattern(folded);
  } catch {
    foldedCompiled = undefined;
  }
  const byName = new Map<string, RuleToolDescriptor>();
  for (const t of pool) {
    const hit =
      (t.key !== undefined && matchesToolName(compiled, t.key)) ||
      (foldedCompiled !== undefined &&
        (matchesToolName(foldedCompiled, fold(t.name)) ||
          (t.key !== undefined && matchesToolName(foldedCompiled, fold(t.key)))));
    if (hit) byName.set(t.name, t);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every rule in `input.rules` that cannot do what it says, with the fix. */
export function permissionRuleProblems(
  input: PermissionRuleProblemsInput,
): PermissionRuleProblem[] {
  const problems: PermissionRuleProblem[] = [];
  const declaredServers = new Set(input.mcpServers);
  for (const rule of input.rules) {
    let compiled: ReturnType<typeof compilePattern>;
    try {
      compiled = compilePattern(rule.pattern);
    } catch (err) {
      if (err instanceof PatternParseError) continue; // reported as malformed elsewhere
      throw err;
    }
    const { tool: toolGlob, arg } = split(rule.pattern);
    const report = (code: PermissionRuleProblemCode, message: string, suggestion?: string) =>
      problems.push({
        type: rule.type,
        pattern: rule.pattern,
        code,
        message,
        ...(suggestion !== undefined ? { suggestion } : {}),
      });

    const matched = input.granted.filter((t) => matchesToolName(compiled, t.name));
    if (matched.length === 0) {
      // A glob that can still match a declared MCP server's tools is not
      // dead: `*write*` fires on mcp__fs__write_file. When it also resembles
      // a GRANTED builtin it does not reach, say so, name the builtin, and
      // offer no rewrite — the rule means something already.
      const reachable = mcpServersReached(toolGlob, declaredServers);
      if (reachable.length > 0) {
        // An exact name that addresses a declared server is an MCP rule: it
        // names one tool, and `web__fetch` is not a misspelled WebFetch.
        if (!GLOB_META.test(toolGlob)) continue;
        const missed = toolsMisspelled(compiled, toolGlob, input.granted);
        if (missed.length > 0) {
          const names = missed.map((t) => t.name);
          const one = names.length === 1;
          report(
            "builtin-not-reached",
            `rule "${rule.pattern}" can match tools of the MCP server${reachable.length === 1 ? "" : "s"} ${listNames(reachable)}, but no granted builtin: a rule is matched against a tool's exact name, and it does not match ${listNames(names)}, whose ${one ? "key or spelling" : "keys or spellings"} it resembles. If it is meant for ${one ? "that tool" : "those tools"} too, add a rule that names ${one ? "it" : "them"}: ${listNames(names)}.`,
          );
        }
        continue;
      }
      // Written with spec keys? The glob is tried against every tool's KEY,
      // not only with its first letter capitalised: `codegraph*` reaches the
      // keys codegraphSearch… whose names are CodeGraphSearch…, and `*script`
      // reaches javascript, whose name is JavaScript.
      const pool = [...input.granted, ...input.known];
      const byName = new Map<string, RuleToolDescriptor>();
      for (const t of pool) {
        if (
          t.key !== undefined &&
          t.key !== t.name &&
          matchesToolName(compiled, t.key) &&
          !matchesToolName(compiled, t.name)
        ) {
          byName.set(t.name, t);
        }
      }
      if (byName.size > 0) {
        const names = [...byName.keys()].sort();
        // A rewrite is offered only when one re-cased glob reaches exactly
        // these tools by name, no more and no fewer.
        const candidate = recasedGlob(toolGlob, names[0] as string);
        let fixed: string | undefined;
        if (candidate !== undefined) {
          const next = withTool(rule.pattern, candidate);
          const nextCompiled = compilePattern(next);
          const reached = new Set(
            pool.filter((t) => matchesToolName(nextCompiled, t.name)).map((t) => t.name),
          );
          if (reached.size === names.length && names.every((n) => reached.has(n))) fixed = next;
        }
        const shown = names.length > 6 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
        const list =
          shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
        const advice =
          fixed !== undefined
            ? `Write "${fixed}".`
            : `Name ${names.length === 1 ? "it" : "them"} by name: ${list}.`;
        const only = names.length === 1 ? byName.get(names[0] as string) : undefined;
        report(
          "tool-key-not-name",
          only !== undefined
            ? `rule "${rule.pattern}" ${GLOB_META.test(toolGlob) ? `matches ${only.key}` : `names ${toolGlob}`}, the key a spec lists the tool under, but a rule is matched against the tool's name, ${only.name}, so this rule never fires. ${advice}`
            : `rule "${rule.pattern}" matches the keys a spec lists ${list} under, but a rule is matched against each tool's name, so this rule never fires. ${advice}`,
          fixed,
        );
        continue;
      }
      // Written with a spec key the descriptors do not carry? Rules are
      // matched against the registered name, which starts with a capital.
      const capitalised = toolGlob.charAt(0).toUpperCase() + toolGlob.slice(1);
      if (capitalised !== toolGlob) {
        const fixed = withTool(rule.pattern, capitalised);
        const fixedCompiled = compilePattern(fixed);
        const hit = [...input.granted, ...input.known].find(
          (t) => matchesToolName(fixedCompiled, t.name) && !matchesToolName(compiled, t.name),
        );
        if (hit !== undefined) {
          report(
            "tool-key-not-name",
            hit.key !== undefined
              ? `rule "${rule.pattern}" names ${toolGlob}, the key a spec lists the tool under, but a rule is matched against the tool's name, ${hit.name}, so this rule never fires. Write "${fixed}".`
              : `rule "${rule.pattern}" names ${toolGlob}, but a rule is matched against the tool's name, ${hit.name}, so this rule never fires. Write "${fixed}".`,
            fixed,
          );
          continue;
        }
      }
      if (toolGlob.startsWith("mcp__")) {
        const rest = toolGlob.slice(5);
        // A declared key may itself contain `__` (0.7.0 ran such keys), so
        // the server is found by the keys, not by splitting the name.
        if ([...declaredServers].some((s) => rest.startsWith(`${s}__`))) continue;
        const server = rest.split("__")[0] ?? "";
        if (server !== "" && !GLOB_META.test(server) && !declaredServers.has(server)) {
          report(
            "unknown-mcp-server",
            `rule "${rule.pattern}" names the MCP server "${server}", which this spec does not declare, so it never fires. Declare it under mcp_servers, or remove the rule.`,
          );
        }
        continue;
      }
      // Spelled another way? A rule is matched exactly, so REMOVEPATH,
      // remove_path, `web fetch` and Codegraph* never fire on RemovePath,
      // WebFetch or CodeGraphSearch (C146).
      const misspelled = toolsMisspelled(compiled, toolGlob, pool);
      if (misspelled.length > 0) {
        const names = misspelled.map((t) => t.name);
        const one = names.length === 1;
        // Following a rewrite of an allow must not grant a tool that can
        // change or delete things on a guess about the spelling.
        const widens =
          rule.type === "alwaysAllow" &&
          misspelled.some((t) => t.destructive !== false || t.requiresSandbox !== false);
        let fixed: string | undefined;
        if (!GLOB_META.test(toolGlob)) {
          if (one) fixed = withTool(rule.pattern, names[0] as string);
        } else {
          const candidate = recasedGlob(foldGlob(toolGlob), names[0] as string);
          if (candidate !== undefined) {
            const next = withTool(rule.pattern, candidate);
            const nextCompiled = compilePattern(next);
            const reached = new Set(
              pool.filter((t) => matchesToolName(nextCompiled, t.name)).map((t) => t.name),
            );
            if (reached.size === names.length && names.every((n) => reached.has(n))) fixed = next;
          }
        }
        const list = listNames(names);
        const advice =
          fixed !== undefined && widens
            ? `${one ? `${list} is a tool that` : `${list} are tools that`} may change or delete things, so no fix is offered: write "${fixed}" only if you mean to allow ${one ? "it" : "them"}, or remove the rule.`
            : widens
              ? `${one ? `${list} is a tool that` : `${list} are tools that`} may change or delete things, so no fix is offered: name ${one ? "it" : "them"} only if you mean to allow ${one ? "it" : "them"}, or remove the rule.`
              : fixed !== undefined
                ? `Write "${fixed}".`
                : `Name ${one ? "it" : "them"} by name: ${list}.`;
        report(
          "unknown-tool",
          `rule "${rule.pattern}" matches no tool, so it never fires: a rule is matched against a tool's name exactly (case, "_", "-" and spaces count), and ${one ? `the name is ${list}` : `the names are ${list}`}. ${advice}`,
          widens ? undefined : fixed,
        );
        continue;
      }
      if (!GLOB_META.test(toolGlob) && !input.known.some((t) => t.name === toolGlob)) {
        const near = input.known
          .map((t) => ({ tool: t, name: t.name, d: distance(toolGlob, t.name, 2) }))
          .filter((c) => c.d <= 2)
          .sort((a, b) => a.d - b.d || (a.name < b.name ? -1 : 1));
        const best = near[0];
        if (best !== undefined && near.filter((c) => c.d === best.d).length === 1) {
          const fixed = withTool(rule.pattern, best.name);
          const widens =
            rule.type === "alwaysAllow" &&
            (best.tool.destructive !== false || best.tool.requiresSandbox !== false);
          if (widens) {
            report(
              "unknown-tool",
              `rule "${rule.pattern}" matches no tool, so it never fires. The nearest name is ${best.name}, which may change or delete things, so it is not offered as the fix: write "${fixed}" only if you mean to allow ${best.name}, or remove the rule.`,
            );
          } else {
            report(
              "unknown-tool",
              `rule "${rule.pattern}" matches no tool. Did you mean ${best.name}? Write "${fixed}".`,
              fixed,
            );
          }
        }
      }
      continue;
    }

    if (arg === null) continue;
    // The argument half is checked against every granted tool the tool half
    // reaches. It is a finding only when it is wrong for all of them.
    let notScoped = 0;
    let cannotMatch = 0;
    for (const tool of matched) {
      const declared = tool.operativeArgs;
      if (declared === undefined) break;
      if (declared.length === 0) {
        notScoped++;
        continue;
      }
      if (declared.every((a) => a.kind === "url") && !argGlobCanMatchUrl(arg)) {
        cannotMatch++;
        continue;
      }
      break;
    }
    const names = matched.map((t) => t.name).join(", ");
    if (cannotMatch > 0 && notScoped + cannotMatch === matched.length) {
      const fixedArg = withoutMethodPrefix(arg);
      const fixed = fixedArg !== undefined ? `${toolGlob}(${fixedArg})` : undefined;
      report(
        "argument-cannot-match",
        `rule "${rule.pattern}" can never match: a rule on ${names} is checked against its URL, and a URL starts with its scheme, such as https:. ${
          fixed !== undefined
            ? `Write "${fixed}".`
            : `Write the URL pattern, e.g. "${toolGlob}(https://api.example.com/**)".`
        }`,
        fixed,
      );
    } else if (notScoped === matched.length) {
      report(
        "argument-not-scoped",
        `rule "${rule.pattern}" has an argument pattern, but ${names} has no argument that says where it acts, so the pattern is checked against the text of each call, not a place. To cover every call, write "${toolGlob}".`,
        toolGlob,
      );
    }
  }
  return problems;
}
