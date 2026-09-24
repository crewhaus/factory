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
 * name is one or two letters away from a tool it does know.
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
  | "argument-cannot-match";

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

/** Every rule in `input.rules` that cannot do what it says, with the fix. */
export function permissionRuleProblems(
  input: PermissionRuleProblemsInput,
): PermissionRuleProblem[] {
  const problems: PermissionRuleProblem[] = [];
  const servers = new Set(input.mcpServers);
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
      // Written with a spec key? Rules are matched against the registered
      // name, which starts with a capital.
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
            `rule "${rule.pattern}" names ${toolGlob}, the key a spec lists the tool under, but a rule is matched against the tool's name, ${hit.name}, so this rule never fires. Write "${fixed}".`,
            fixed,
          );
          continue;
        }
      }
      if (toolGlob.startsWith("mcp__")) {
        const server = toolGlob.slice(5).split("__")[0] ?? "";
        if (server !== "" && !GLOB_META.test(server) && !servers.has(server)) {
          report(
            "unknown-mcp-server",
            `rule "${rule.pattern}" names the MCP server "${server}", which this spec does not declare, so it never fires. Declare it under mcp_servers, or remove the rule.`,
          );
        }
        continue;
      }
      if (!GLOB_META.test(toolGlob) && !input.known.some((t) => t.name === toolGlob)) {
        const near = input.known
          .map((t) => ({ name: t.name, d: distance(toolGlob, t.name, 2) }))
          .filter((c) => c.d <= 2)
          .sort((a, b) => a.d - b.d || (a.name < b.name ? -1 : 1));
        const best = near[0];
        if (best !== undefined && near.filter((c) => c.d === best.d).length === 1) {
          const fixed = withTool(rule.pattern, best.name);
          report(
            "unknown-tool",
            `rule "${rule.pattern}" matches no tool. Did you mean ${best.name}? Write "${fixed}".`,
            fixed,
          );
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
