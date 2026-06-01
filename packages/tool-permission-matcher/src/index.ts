import { CrewhausError } from "@crewhaus/errors";

export class PatternParseError extends CrewhausError {
  override readonly name = "PatternParseError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export type CompiledPattern = {
  readonly toolGlob: string;
  readonly argGlob: string | null;
  readonly _toolRe: RegExp;
  readonly _argRe: RegExp | null;
};

function globToRegex(glob: string): RegExp {
  // Tokenize character by character so replacement text is never re-processed.
  // This avoids the chaining bug where .* emitted for ** gets re-replaced by
  // the single-* rule on the next pass.
  let re = "";
  let i = 0;

  while (i < glob.length) {
    const ch = glob.charAt(i);

    if (ch === "*" && glob[i + 1] === "*") {
      const prevIsSep = i === 0 || glob[i - 1] === "/";
      const afterTwo = glob[i + 2];
      const nextIsSep = afterTwo === "/" || afterTwo === undefined;

      if (prevIsSep && i === 0 && afterTwo === "/") {
        // **/ at start → optional any-dir prefix
        re += "(?:.*/)?";
        i += 3;
      } else if (prevIsSep && afterTwo === undefined) {
        // /** at end → optional any-dir suffix (leading / already emitted)
        re = `${re.slice(0, -1)}(?:/.*)?`;
        i += 2;
      } else if (prevIsSep && nextIsSep && afterTwo === "/") {
        // /**/ in middle → any sub-tree separator (leading / already emitted)
        re = `${re.slice(0, -1)}(?:/.*/|/)`;
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(`^${re}$`);
}

export function compilePattern(pattern: string): CompiledPattern {
  if (!pattern.trim()) throw new PatternParseError("pattern must not be empty");

  const parenIdx = pattern.indexOf("(");
  if (parenIdx === -1) {
    const toolGlob = pattern.trim();
    return { toolGlob, argGlob: null, _toolRe: globToRegex(toolGlob), _argRe: null };
  }

  if (!pattern.endsWith(")")) {
    throw new PatternParseError(`pattern "${pattern}" has unmatched parenthesis`);
  }

  const toolGlob = pattern.slice(0, parenIdx).trim();
  const argGlob = pattern.slice(parenIdx + 1, -1);

  if (!toolGlob) throw new PatternParseError("tool name portion must not be empty");

  return {
    toolGlob,
    argGlob,
    _toolRe: globToRegex(toolGlob),
    _argRe: globToRegex(argGlob),
  };
}

function stringValues(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (input === null || typeof input !== "object") return [];
  return Object.values(input as Record<string, unknown>).flatMap(stringValues);
}

/**
 * The operative argument field(s) per built-in tool — the input the permission
 * arg-glob is meant to constrain. Matching ONLY these stops a decoy field (e.g.
 * Write's `content`, or an attacker-injected key) from satisfying an allow rule
 * (#145). Names cover both the tool-fs fields and the Claude-Code-style aliases.
 */
const OPERATIVE_ARG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Bash: ["command"],
  Read: ["file_path", "path"],
  Write: ["file_path", "path"],
  Edit: ["file_path", "path"],
  Glob: ["pattern"],
  Grep: ["pattern", "path"],
  Fetch: ["url"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Navigate: ["url"],
};

export function matchesPattern(
  compiled: CompiledPattern,
  toolName: string,
  input: unknown,
): boolean {
  if (!compiled._toolRe.test(toolName)) return false;
  const argRe = compiled._argRe;
  if (argRe === null) return true;

  // Match the arg-glob against the tool's OPERATIVE field(s) only, so a decoy
  // field cannot authorize a malicious operative one (#145). The previous
  // `.some` over every string in the input was the bypass.
  const fields = OPERATIVE_ARG_FIELDS[toolName];
  if (fields !== undefined && input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const vals: string[] = [];
    for (const f of fields) {
      const v = record[f];
      if (typeof v === "string") vals.push(v);
    }
    if (vals.length > 0) return vals.some((v) => argRe.test(v));
    // operative field absent → fall through to the conservative check
  }

  // Unknown tool (or operative field absent): require EVERY string to match, so
  // a decoy field cannot authorize the call. No strings at all → deny.
  const all = stringValues(input);
  return all.length > 0 && all.every((v) => argRe.test(v));
}
