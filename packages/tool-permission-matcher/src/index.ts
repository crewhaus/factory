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
  /** The compiled tool-name glob. Internal: use {@link matchesToolName}. */
  readonly _toolRe: GlobMatcher;
  /** The compiled argument glob, or null for a bare tool pattern. */
  readonly _argRe: GlobMatcher | null;
};

/**
 * The glob metacharacters the glob compiler treats specially — the ONLY characters
 * that widen a match beyond a literal (`*` = any run, `?` = one char). Every
 * other character (`. + ^ $ { } ( ) | [ ] \`) is regex-escaped and matched
 * literally. `\` is the escape lead-in: `\*`, `\?`, `\\` match the literal
 * character. Exported so callers that inject an observed literal value into a
 * pattern (e.g. permission-suggest) can neutralise widening via
 * `escapeGlobLiteral` and stay in sync with the grammar defined HERE.
 */
export const GLOB_METACHARS: readonly string[] = Object.freeze(["\\", "*", "?"]);

/**
 * Escape a raw string so it matches ONLY itself when spliced into a glob
 * pattern. Backslash-escapes every {@link GLOB_METACHARS} character (backslash
 * first, so we don't double-escape the escapes we add). Round-trips through
 * the glob compiler: `escapeGlobLiteral("a*b")` → `"a\\*b"` → matches only "a*b".
 */
export function escapeGlobLiteral(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\\" || ch === "*" || ch === "?") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Where the tokenizer stands when it reads a `**`, which decides what the
 * `**` means at a path-segment boundary: `a/**` must also match `a`, and a
 * leading double-star segment must also match a bare `b`.
 *
 *   - `"start"` — nothing emitted yet, OR the previous token was a `**` group
 *     that already absorbed the separator after it, so a new path segment
 *     begins here.
 *   - `"sep"`   — the last token is the literal `/` of a glob `/`. A `**` in
 *     this position folds that separator into its own optional group.
 *   - `"other"` — anything else; a `**` here is mid-segment and just means
 *     "any run of characters".
 *
 * Tracking this explicitly (rather than guessing from what was emitted) is the
 * fix for issue #17: a bare `**` once compiled to something that matched only
 * the empty string or a string starting with `/`, so a catch-all `Bash(**)`
 * rule was dead.
 */
type GlobPos = "start" | "sep" | "other";

/**
 * One step of a compiled glob. The grammar is small, and every construct is
 * one of these:
 *
 *   - `lit`       — one literal UTF-16 code unit;
 *   - `qmark`     — `?`: one code unit that is not `/`;
 *   - `star`      — `*`: any run of code units without a `/`;
 *   - `any`       — `**` mid-segment: any run at all, newlines included;
 *   - `optPrefix` — a leading `**` + `/`: an optional "any run then `/`";
 *   - `mid`       — `/` + `**` + `/`: a `/`, optionally followed by
 *                   "any run then `/`";
 *   - `optSuffix` — a trailing `/` + `**`: an optional "`/` then any run".
 */
type GlobToken =
  | { readonly k: "lit"; readonly c: number }
  | { readonly k: "qmark" | "star" | "any" | "optPrefix" | "mid" | "optSuffix" };

const SLASH = 0x2f;

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  let pos: GlobPos = "start";
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      // Escape lead-in: the next code unit is literal, never a metachar. Lets
      // `escapeGlobLiteral` emit `\*`/`\?`/`\\` that match the literal
      // character. An escaped `/` is still a separator, so a following `**`
      // folds it exactly as it would an unescaped one.
      const lit = glob.charCodeAt(i + 1);
      tokens.push({ k: "lit", c: lit });
      pos = lit === SLASH ? "sep" : "other";
      i += 2;
    } else if (ch === "*" && glob[i + 1] === "*") {
      const afterTwo = glob[i + 2];
      if (afterTwo === "/" && pos === "start") {
        tokens.push({ k: "optPrefix" });
        pos = "start";
        i += 3;
      } else if (afterTwo === "/" && pos === "sep") {
        tokens.pop(); // the `/` just emitted is part of this group
        tokens.push({ k: "mid" });
        pos = "start";
        i += 3;
      } else if (afterTwo === undefined && pos === "sep") {
        tokens.pop();
        tokens.push({ k: "optSuffix" });
        pos = "other";
        i += 2;
      } else {
        // A bare `**`, a `**` glued to a non-separator (`rm**`), or a
        // redundant `**` right after another `**` group: any run at all.
        tokens.push({ k: "any" });
        pos = "other";
        i += 2;
      }
    } else if (ch === "*") {
      tokens.push({ k: "star" });
      pos = "other";
      i++;
    } else if (ch === "?") {
      tokens.push({ k: "qmark" });
      pos = "other";
      i++;
    } else {
      tokens.push({ k: "lit", c: glob.charCodeAt(i) });
      pos = ch === "/" ? "sep" : "other";
      i++;
    }
  }
  return tokens;
}

/** A state of the glob automaton. Index 0 is always the accepting state. */
type GlobState =
  | { readonly t: "lit"; readonly c: number; readonly out: number }
  | { readonly t: "notSlash"; readonly out: number }
  | { readonly t: "anyChar"; readonly out: number }
  | { t: "split"; a: number; readonly b: number }
  | { readonly t: "accept" };

/**
 * A compiled glob: `test(value)` says whether the glob matches the whole of
 * `value`.
 *
 * This used to be a JavaScript RegExp, and a backtracking regex with several
 * `*` in it takes polynomial time — `Bash(*git*push*--force*)` against an
 * 18 KB command blocked the event loop for twelve seconds, and a rule with a
 * handful more wildcards did not finish at all. Every tool call is matched
 * against every rule, synchronously, with a model-supplied argument.
 *
 * So the glob is compiled to a small automaton and run by keeping the SET of
 * states it could be in (Thompson's construction). Each character is looked
 * at once, against each state once: the time is proportional to the length
 * of the value times the length of the glob, whatever the input looks like.
 * The language accepted is exactly the old regex's — the test suite checks
 * the two against each other.
 *
 * `work`, when passed, has the number of automaton states visited added to
 * `work.steps`: a count of the work done that does not depend on how busy
 * the machine is, so a test can check the cost grows linearly without
 * racing a clock.
 */
export type GlobMatcher = {
  readonly test: (value: string, work?: { steps: number }) => boolean;
  /**
   * Whether the glob matches `prefix` followed by SOME run of characters
   * without a `/` (possibly none): for a value that stands for every value
   * in its last segment (see `OperativeValue.standsForAny`). With `segments`
   * above 1, that many such runs joined by `/` — a value that stands for
   * every `<qualifier>/<value>` (see `OperativeValue.anyQualifier`).
   */
  readonly matchesSegmentAfter: (prefix: string, segments?: number) => boolean;
  /**
   * Whether the glob matches `prefix` followed by SOME continuation (possibly
   * none): a run without a `/` when `tail` is `"segment"`, any run at all
   * when it is `"run"`.
   */
  readonly matchesSomeAfter: (prefix: string, tail: AnyValueTail) => boolean;
  /**
   * Whether the glob matches `prefix` followed by EVERY continuation of the
   * `tail` kind — what an allow must satisfy to grant a value that stands for
   * every value. With `segments` above 1 and a `"segment"` tail, every
   * continuation of up to that many segments joined by `/`: a value that
   * stands for every `<qualifier>/<value>` as well as every value (see
   * `OperativeValue.anyQualifier`). `false` when working that out would take
   * more than a bounded amount of work: an allow that cannot be shown to
   * cover every value grants nothing.
   */
  readonly matchesEveryAfter: (prefix: string, tail: AnyValueTail, segments?: number) => boolean;
};

/**
 * What follows the prefix of a value that stands for every value: one path
 * segment (an address after `<chainId>/`), or any run of characters (a path,
 * a URL or a command, which may hold `/`).
 */
export type AnyValueTail = "segment" | "run";

/**
 * How many sets of automaton states {@link GlobMatcher.matchesEveryAfter}
 * explores before it gives up and answers `false`. A glob a person writes
 * reaches a handful; the bound keeps a pathological one from stalling the
 * permission gate.
 */
const EVERY_AFTER_STATE_SETS = 4096;

function compileGlob(glob: string): GlobMatcher {
  const tokens = tokenizeGlob(glob);
  // Fast path: a glob with no metacharacters is a string comparison. Most
  // tool-name halves (`Read`, `Bash`) are this.
  if (tokens.every((t) => t.k === "lit")) {
    let literal = "";
    for (const t of tokens) literal += String.fromCharCode((t as { c: number }).c);
    const someAfter = (prefix: string, tail: AnyValueTail): boolean =>
      literal.startsWith(prefix) && (tail === "run" || !literal.slice(prefix.length).includes("/"));
    return {
      test: (value: string, work?: { steps: number }) => {
        if (work !== undefined) work.steps += value.length;
        return value === literal;
      },
      matchesSegmentAfter: (prefix: string, segments = 1) =>
        literal.startsWith(prefix) &&
        literal.slice(prefix.length).split("/").length === Math.max(1, segments),
      matchesSomeAfter: someAfter,
      // One string: never both the prefix alone and the prefix plus more.
      matchesEveryAfter: () => false,
    };
  }

  const states: GlobState[] = [{ t: "accept" }];
  const push = (state: GlobState): number => states.push(state) - 1;
  const loop = (t: "notSlash" | "anyChar", exit: number): number => {
    const split: GlobState = { t: "split", a: -1, b: exit };
    const splitAt = push(split);
    split.a = push({ t, out: splitAt });
    return splitAt;
  };
  const optionalRunThenSlash = (next: number): number => {
    const slash = push({ t: "lit", c: SLASH, out: next });
    return push({ t: "split", a: loop("anyChar", slash), b: next });
  };

  // Build right to left, so each fragment knows where it continues.
  let next = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] as GlobToken;
    switch (token.k) {
      case "lit":
        next = push({ t: "lit", c: token.c, out: next });
        break;
      case "qmark":
        next = push({ t: "notSlash", out: next });
        break;
      case "star":
        next = loop("notSlash", next);
        break;
      case "any":
        next = loop("anyChar", next);
        break;
      case "optPrefix":
        next = optionalRunThenSlash(next);
        break;
      case "mid":
        next = push({ t: "lit", c: SLASH, out: optionalRunThenSlash(next) });
        break;
      case "optSuffix": {
        const slash = push({ t: "lit", c: SLASH, out: loop("anyChar", next) });
        next = push({ t: "split", a: slash, b: next });
        break;
      }
    }
  }
  const start = next;
  const count = states.length;

  /** The non-split states reachable from `from` without reading, sorted. */
  function closureOf(from: ReadonlyArray<number>): number[] {
    const seen = new Uint8Array(count);
    const out: number[] = [];
    const stack = [...from];
    while (stack.length > 0) {
      const s = stack.pop() as number;
      if (seen[s] === 1) continue;
      seen[s] = 1;
      const st = states[s] as GlobState;
      if (st.t === "split") stack.push(st.b, st.a);
      else out.push(s);
    }
    return out.sort((a, b) => a - b);
  }

  /** The states after reading `c` from the (closed) set `set`, closed again. */
  function stepOn(set: ReadonlyArray<number>, c: number): number[] {
    const next: number[] = [];
    for (const s of set) {
      const st = states[s] as GlobState;
      if (
        (st.t === "lit" && st.c === c) ||
        (st.t === "notSlash" && c !== SLASH) ||
        st.t === "anyChar"
      ) {
        next.push(st.out);
      }
    }
    return next.length === 0 ? next : closureOf(next);
  }

  /** The states after reading `prefix` from the start, like `test` does. */
  function afterPrefix(prefix: string): number[] {
    let current = closureOf([start]);
    for (let i = 0; i < prefix.length && current.length > 0; i++) {
      current = stepOn(current, prefix.charCodeAt(i));
    }
    return current;
  }

  /** Whether the accepting state is reachable after the prefix, reading `tail` characters. */
  function someAfter(prefix: string, tail: AnyValueTail): boolean {
    const seen = new Uint8Array(count);
    const stack = afterPrefix(prefix);
    while (stack.length > 0) {
      const s = stack.pop() as number;
      if (seen[s] === 1) continue;
      seen[s] = 1;
      const st = states[s] as GlobState;
      if (st.t === "accept") return true;
      if (st.t === "split") stack.push(st.b, st.a);
      else if (
        (st.t === "lit" && (tail === "run" || st.c !== SLASH)) ||
        st.t === "notSlash" ||
        st.t === "anyChar"
      ) {
        stack.push(st.out);
      }
    }
    return false;
  }

  return {
    test(value: string, work?: { steps: number }): boolean {
      // `seen[s] === step` ⇔ state s is already in the set for this step.
      const seen = new Int32Array(count).fill(-1);
      let current: number[] = [];
      let following: number[] = [];
      const stack: number[] = [];
      const add = (into: number[], state: number, step: number): void => {
        stack.push(state);
        while (stack.length > 0) {
          const s = stack.pop() as number;
          if (seen[s] === step) continue;
          seen[s] = step;
          const st = states[s] as GlobState;
          if (st.t === "split") {
            stack.push(st.b, st.a);
          } else {
            into.push(s);
          }
        }
      };
      add(current, start, 0);
      let steps = 0;
      const done = (answer: boolean): boolean => {
        if (work !== undefined) work.steps += steps;
        return answer;
      };
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        following.length = 0;
        steps += current.length;
        for (const s of current) {
          const st = states[s] as GlobState;
          if (
            (st.t === "lit" && st.c === c) ||
            (st.t === "notSlash" && c !== SLASH) ||
            st.t === "anyChar"
          ) {
            add(following, st.out, i + 1);
          }
        }
        if (following.length === 0) return done(false);
        [current, following] = [following, current];
      }
      return done(current.includes(0));
    },
    matchesSegmentAfter(prefix: string, segments = 1): boolean {
      // Run the prefix like `test` does, then ask whether the accepting
      // state can be reached reading characters that are not `/`, with
      // exactly `segments - 1` slashes between them.
      let current = afterPrefix(prefix);
      if (current.length === 0) return false;
      const slashes = Math.max(1, segments) - 1;
      for (let level = 0; level <= slashes; level++) {
        // The states reachable at this level reading no `/`; a transition
        // that can read one leads to the next level.
        const seen = new Uint8Array(count);
        const stack = [...current];
        const next: number[] = [];
        while (stack.length > 0) {
          const s = stack.pop() as number;
          if (seen[s] === 1) continue;
          seen[s] = 1;
          const st = states[s] as GlobState;
          if (st.t === "accept") {
            if (level === slashes) return true;
            continue;
          }
          if (st.t === "split") {
            stack.push(st.b, st.a);
            continue;
          }
          if ((st.t === "lit" && st.c !== SLASH) || st.t === "notSlash" || st.t === "anyChar") {
            stack.push(st.out);
          }
          if ((st.t === "lit" && st.c === SLASH) || st.t === "anyChar") next.push(st.out);
        }
        if (next.length === 0) return false;
        current = next;
      }
      return false;
    },
    matchesSomeAfter: someAfter,
    matchesEveryAfter(prefix: string, tail: AnyValueTail, segments = 1): boolean {
      // The sets of states the automaton can be in after the prefix and any
      // continuation, built one character class at a time (the subset
      // construction). Every continuation is accepted exactly when every such
      // set holds the accepting state. Characters the glob never names act
      // alike, so one stands for all of them.
      const first = afterPrefix(prefix);
      if (first.length === 0) return false;
      // How many `/` a continuation may hold: any number in a run; in a
      // segment tail, one fewer than the segments it may have. Each set is
      // explored once per count of `/` read so far, so a glob that covers
      // `acme` but not `acme/app` is caught at the second segment.
      const slashes = tail === "run" ? 0 : Math.max(1, segments) - 1;
      const readsSlash = tail === "run" || slashes > 0;
      const alphabet = new Set<number>();
      for (const st of states) {
        if (st.t === "lit" && (readsSlash || st.c !== SLASH)) alphabet.add(st.c);
      }
      if (readsSlash) alphabet.add(SLASH);
      let other = 0x61;
      while (alphabet.has(other) || other === SLASH) other++;
      alphabet.add(other);
      const keyOf = (level: number, set: ReadonlyArray<number>): string =>
        `${level}:${set.join(",")}`;
      const seenSets = new Set<string>([keyOf(0, first)]);
      const queue: Array<readonly [number, number[]]> = [[0, first]];
      while (queue.length > 0) {
        const [level, set] = queue.pop() as readonly [number, number[]];
        if (!set.includes(0)) return false;
        for (const c of alphabet) {
          let nextLevel = level;
          if (c === SLASH && tail === "segment") {
            if (level >= slashes) continue;
            nextLevel = level + 1;
          }
          const next = stepOn(set, c);
          if (next.length === 0) return false;
          const key = keyOf(nextLevel, next);
          if (seenSets.has(key)) continue;
          if (seenSets.size >= EVERY_AFTER_STATE_SETS) return false;
          seenSets.add(key);
          queue.push([nextLevel, next]);
        }
      }
      return true;
    },
  };
}

export function compilePattern(pattern: string): CompiledPattern {
  if (!pattern.trim()) throw new PatternParseError("pattern must not be empty");

  const parenIdx = pattern.indexOf("(");
  if (parenIdx === -1) {
    const toolGlob = pattern.trim();
    return { toolGlob, argGlob: null, _toolRe: compileGlob(toolGlob), _argRe: null };
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
    _toolRe: compileGlob(toolGlob),
    _argRe: compileGlob(argGlob),
  };
}

function stringValues(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (input === null || typeof input !== "object") return [];
  return Object.values(input as Record<string, unknown>).flatMap(stringValues);
}

/**
 * The operative argument field(s) per well-known tool NAME — the input a
 * permission arg-glob is meant to constrain.
 *
 * Since 0.7.1 this table is a FALLBACK. A tool says for itself which fields a
 * rule constrains (`operativeArgs` on its definition), and the runtime hands
 * the matcher those values, already canonicalised. The table only speaks for
 * a tool that declares nothing but carries one of these names — an MCP or
 * custom tool called `Write`, say — which is why it keeps the Claude-Code
 * style `file_path` alias next to `path`.
 *
 * Exported because `crewhaus permissions suggest` and the approvals tooling
 * read it to show an operator the field a rule would be checked against.
 */
export const OPERATIVE_ARG_FIELDS: Readonly<Record<string, readonly string[]>> = {
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

// ---------------------------------------------------------------------------
// MCP tool names
// ---------------------------------------------------------------------------

/**
 * The prefix of every tool an MCP server contributes:
 * `mcp__<server>__<tool>`.
 */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * The spelling an MCP tool name had before crewhaus 0.7.1, `<server>__<tool>`,
 * or `undefined` when `name` is not an MCP tool name. A rule written against
 * the old spelling keeps matching through it.
 */
export function legacyMcpToolName(name: string): string | undefined {
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
  // The separator after a server of at least one character. An
  // `mcp_servers` key may itself contain `__` or start with `_` (0.7.0 ran
  // such keys), and the old spelling is still everything after `mcp__`.
  const sep = rest.indexOf("__", 1);
  if (sep < 1 || sep + 2 >= rest.length) return undefined;
  return rest;
}

/**
 * Does the pattern's tool half name `toolName`? An MCP tool also answers to
 * its pre-0.7.1 spelling, so a rule written `github__*` still governs
 * `mcp__github__create_issue`. The alias runs one way only: `mcp__x__y` never
 * matches a tool that is not an MCP tool.
 */
export function matchesToolName(compiled: CompiledPattern, toolName: string): boolean {
  if (compiled._toolRe.test(toolName)) return true;
  const legacy = legacyMcpToolName(toolName);
  return legacy !== undefined && compiled._toolRe.test(legacy);
}

// ---------------------------------------------------------------------------
// Operative values
// ---------------------------------------------------------------------------

/** Which way a rule points. `allow` grants; `restrict` is a deny or an ask. */
export type RulePolarity = "allow" | "restrict";

/** Mirrors `OperativeArgKind` in `@crewhaus/tool-catalog`. */
export type OperativeValueKind = "path" | "url" | "command" | "recipient" | "text" | "id";

/**
 * One value a rule's argument glob is checked against, prepared by the
 * runtime from the tool's declared `operativeArgs` and its PARSED input.
 *
 * - `canonical` — the spelling(s) of what the tool will act on: for a path,
 *   the workspace-relative location with `..` collapsed and symlinks
 *   followed, plus the same location as an absolute path. An allow rule must
 *   match one of these. A `command` with none — run in another directory, or
 *   with an environment the call set, where its words may name another
 *   program — is granted only by a glob that matches every command
 *   (`RunCommand(**)`).
 * - `spellings` — other ways of writing the same value (what the model sent,
 *   the path before symlinks were followed). A deny or ask rule also fires on
 *   these, so a rule written against either form is not dodged.
 * - `outsideWorkspace` — the path lands outside the workspace, or where it
 *   lands could not be worked out. It never satisfies an allow rule and
 *   always satisfies a deny or ask rule — except that a command with no
 *   canonical value (its environment too large to read) is still granted by
 *   a glob that matches every command, as above: which program it runs is
 *   all that could not be worked out.
 * - `caseInsensitive` — the value names the same thing in any letter case: a
 *   path on a filesystem that does not tell names apart by case (macOS and
 *   Windows by default, or the runtime could not find out), or a `0x` hex id
 *   such as an address or a hash, whose EIP-55 mixed case is only a
 *   checksum. A deny or ask rule then compares it ignoring case, so
 *   `alwaysDeny Write(.crewhaus/settings.json)` also fires on
 *   `.crewhaus/Settings.json`, and `alwaysDeny EvmCall(1/0xdAC17F…)` on the
 *   same address written in lower case.
 * - `standsForAny` — the value stands for EVERY value after each of these
 *   prefixes: a field left out whose declared default is `*` (an EvmGetLogs
 *   call with no `address` reads every contract's logs, and is matched as
 *   `<chainId>/*`). What follows a prefix is one segment for an id, a
 *   recipient or a text value, and any run of characters for a path, a URL
 *   or a command. A deny or ask rule fires when its glob matches one of the
 *   prefixes followed by some such continuation, in any form the kind is
 *   folded in (so `alwaysDeny EvmGetLogs(Base/0xdAC17F…)` catches the query
 *   on `base` that reads that contract among all the others, and
 *   `EvmGetLogs(137/…)` does not). A value that names the same thing in any
 *   letter case (an `id`, a `command`, a `recipient`, a URL, or a `0x` hex
 *   value) is compared ignoring case here too, so an owner-wide code search
 *   written `ACME/*` still meets `alwaysDeny SearchCode(acme/secret)`; a
 *   path only where its filesystem ignores case. Each `canonical` spelling
 *   is then `<prefix>*`, and an allow rule grants it only when its glob
 *   matches the prefix followed by EVERY continuation: `EvmGetLogs(1/*)`
 *   grants the every-contract read, while naming one contract,
 *   `EvmGetLogs(1/0x*)` or `EvmGetLogs(1/?)` does not.
 * - `anyQualifier` — with `standsForAny`: the field is declared `within`
 *   another that the call left out as well, so the value also stands for
 *   every `<qualifier>/<value>`. A code search that names no owner reaches
 *   every repository the token can read, and `alwaysDeny
 *   SearchCode(acme/secret)` fires on it. An allow grants it only when its
 *   glob covers every value AND every `<qualifier>/<value>`:
 *   `SearchCode(**)` does, `SearchCode(*)` does not (it covers no
 *   `acme/app`, which a search of one repository would need).
 * - `standsForAnyRun` — with `standsForAny`: what follows each prefix is
 *   any run of characters, `/` included, whatever the kind. A prefix filter
 *   over keys that may hold `/` (KvList's `prefix`): `secrets/api` stands
 *   for `secrets/api/v2` too, so an allow must cover that as well
 *   (`KvList(secrets/**)` does, `KvList(secrets/*)` does not).
 * - `restrictOnly` — a value only a deny or ask reads. The declared default
 *   of a field that only relocates the tool (a store directory, the
 *   repository a branch operation runs in), standing in for a field the
 *   call left out while it carries another operative value: a deny or ask
 *   rule reads it like any value, so `alwaysDeny
 *   KvDelete(.crewhaus/state/**)` fires on a call that omits `stateDir`; an
 *   allow rule skips it, because the grant is about the record the call
 *   names (`alwaysAllow KvSet(scratch/*)`). Also a prefix read without its
 *   qualifier, for a deny written that way (`alwaysDeny KvGet(apikey)`).
 *
 * For a `path` value, a glob that starts with `/` is compared with the
 * absolute spellings and any other glob with the relative ones, so
 * `**` + `/src/**` cannot reach into the directories ABOVE the workspace. A
 * deny or ask rule also compares a path in Unicode normal form C, so a name
 * spelled with a combining accent (`cafe` + U+0301) is the name spelled with
 * the precomposed one (`café`), as it is on macOS.
 *
 * A deny or ask rule is not dodged by another spelling of a URL, a
 * recipient, an id or a command either: it also compares them folded, as
 * the destination treats them (`restrictFolds`) — a URL without userinfo,
 * root dot, fragment or percent-escapes, with an IPv4-mapped IPv6 host as
 * its IPv4 address, and, for a rule that names a host, on any port and over
 * http and https (a rule that names a port or leaves the host a wildcard
 * keeps to the scheme and port it names); an address in lower case without
 * a `+tag`; an id or a program name in lower case. An allow rule reads only
 * `canonical`, and never grants a URL that carries userinfo or an escaped
 * `..`.
 */
export type OperativeValue = {
  readonly kind: OperativeValueKind;
  readonly canonical: ReadonlyArray<string>;
  readonly spellings?: ReadonlyArray<string>;
  readonly outsideWorkspace?: boolean;
  readonly caseInsensitive?: boolean;
  readonly standsForAny?: ReadonlyArray<string>;
  readonly anyQualifier?: boolean;
  readonly standsForAnyRun?: boolean;
  readonly restrictOnly?: boolean;
};

export type MatchOptions = {
  /** Default `"allow"`, the conservative reading for a grant. */
  readonly polarity?: RulePolarity;
  /**
   * The tool's declared operative values, canonicalised by the runtime.
   * Absent ⇒ the tool declared none (or declared `[]`: no argument decides
   * where it acts), and the matcher falls back to the
   * {@link OPERATIVE_ARG_FIELDS} name table, then to every string in `input`.
   * Present but empty ⇒ the tool declares operative fields and this call
   * carries none of them (and no default stands in): no argument-scoped
   * allow can match it, and a deny or ask fires when EVERY string value of
   * the call matches (0.7.0's reading of a tool it knew no field of) —
   * `alwaysDeny WebhookPost(**)` still fires on a call that names its URL
   * through `urlEnv`, and `WebhookPost(http://**)` is not set off by a link
   * in its payload.
   */
  readonly operativeValues?: ReadonlyArray<OperativeValue>;
};

function isAbsoluteSpelling(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** True when an argument glob is written as an absolute path. */
function globIsAbsolute(argGlob: string): boolean {
  return argGlob.startsWith("/") || argGlob.startsWith("\\/") || /^[A-Za-z]:[\\/]/.test(argGlob);
}

const DOT_DOT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * Collapse `.` and `..` segments without touching the filesystem, and write
 * the result with `/` separators. `escapes` is true when a relative path
 * climbs above its starting point.
 *
 * Exported for the runtimes that canonicalise a path-kind operative value
 * where there is no filesystem to ask (the edge worker).
 */
export function normalizePathLexically(value: string): {
  readonly path: string;
  readonly escapes: boolean;
} {
  const absolute = value.startsWith("/");
  const out: string[] = [];
  let escapes = false;
  for (const segment of value.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      else if (!absolute) escapes = true;
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  return { path: absolute ? `/${joined}` : joined === "" ? "." : joined, escapes };
}

/**
 * A string from an input the tool has not described. Nothing says it is a
 * path, but it may be one, so a `..` segment in it is read the careful way
 * round for each polarity: an allow never matches it (what it resolves to is
 * unknown), and a deny or ask sees it with the `..` collapsed — and fires
 * outright when it climbs out of wherever it starts.
 */
function undeclaredValue(value: string): OperativeValue {
  if (!DOT_DOT_SEGMENT.test(value)) return { kind: "text", canonical: [value] };
  const lexical = normalizePathLexically(value);
  return {
    kind: "text",
    canonical: [],
    spellings: [value, lexical.path],
    ...(lexical.escapes ? { outsideWorkspace: true } : {}),
  };
}

function fallbackValues(toolName: string, input: unknown): OperativeValue[] {
  // Own keys only: a tool may be named after an Object.prototype member
  // (`toString`, `constructor`), which is not in the table.
  const fields = Object.hasOwn(OPERATIVE_ARG_FIELDS, toolName)
    ? OPERATIVE_ARG_FIELDS[toolName]
    : undefined;
  if (fields !== undefined && input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const present: string[] = [];
    for (const f of fields) {
      const v = record[f];
      if (typeof v === "string") present.push(v);
    }
    if (present.length > 0) return present.map(undeclaredValue);
    // operative field absent → every string in the input
  }
  return stringValues(input).map(undeclaredValue);
}

/** A path as a deny or ask rule compares it: NFC, and lower-cased when the filesystem ignores case. */
function foldPath(value: string, ignoreCase: boolean): string {
  const nfc = value.normalize("NFC");
  return ignoreCase ? nfc.toLowerCase() : nfc;
}

/**
 * How a deny or ask rule's glob is folded before it is compared with a
 * value's folded spellings: `nfc` keeps letter case (a path on a filesystem
 * that tells case apart), `lower` also lower-cases.
 */
type GlobFold = "nfc" | "lower";

/** Argument globs compiled in folded form, per pattern, built on first use. */
const foldedArgGlobs = new WeakMap<CompiledPattern, Map<GlobFold, GlobMatcher>>();

function foldedArgMatcher(compiled: CompiledPattern, fold: GlobFold): GlobMatcher {
  let byMode = foldedArgGlobs.get(compiled);
  if (byMode === undefined) {
    byMode = new Map();
    foldedArgGlobs.set(compiled, byMode);
  }
  let matcher = byMode.get(fold);
  if (matcher === undefined) {
    matcher = compileGlob(foldPath(compiled.argGlob ?? "", fold === "lower"));
    byMode.set(fold, matcher);
  }
  return matcher;
}

/** The escapes a server may decode into a path separator or a dot. */
const SEPARATOR_OR_DOT_ESCAPE = /%(2[eEfF]|5[cC])/g;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * The URL a request really goes to, spelled the one way: no userinfo, no
 * root dot on the host, no fragment (it is never sent), unreserved `%XX`
 * decoded, an escaped `/`, `\` or `.` decoded, repeated slashes collapsed and
 * dot segments resolved. `undefined` when the value is not a URL.
 */
function requestUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  const host = url.hostname;
  if (host.endsWith(".") && !host.startsWith("[")) {
    const bare = host.replace(/\.+$/, "");
    if (bare !== "") url.hostname = bare;
  }
  const path = url.pathname
    .replace(/%([0-9A-Fa-f]{2})/g, (pct, hex: string) => {
      const ch = String.fromCharCode(Number.parseInt(hex, 16));
      return UNRESERVED.test(ch) ? ch : pct.toUpperCase();
    })
    .replace(SEPARATOR_OR_DOT_ESCAPE, (pct) => (pct.toUpperCase() === "%2E" ? "." : "/"))
    .replace(/\/{2,}/g, "/");
  // The setter parses the path again, so `a/../b` collapses to `b`.
  url.pathname = path;
  return url;
}

/** `href`, plus the slash-less spelling of a bare origin. */
function hrefSpellings(url: URL): string[] {
  const href = url.href;
  const out = [href];
  if (url.pathname === "/" && url.search === "" && href.endsWith("/")) out.push(href.slice(0, -1));
  return out;
}

/**
 * One folded spelling of a URL a deny or ask rule compares, lower-cased, and
 * whether it moved the request to another port or the other of http and
 * https. Those two are other doors of the same host, and only a rule that
 * names the host reads them (see {@link urlGlobScope}).
 */
type UrlFold = {
  readonly text: string;
  readonly portDropped: boolean;
  readonly schemeSwapped: boolean;
};

/** An IPv6 literal that reaches an IPv4 host, as WHATWG writes it: mapped, or NAT64. */
const IPV4_IN_IPV6 = /^\[(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/**
 * The same request with its host written the other ways that name that
 * host: an IPv4-mapped (`[::ffff:93.184.215.14]`, which WHATWG writes
 * `[::ffff:5db8:d70e]`) or NAT64 (`[64:ff9b::…]`) literal is the dotted IPv4
 * address it reaches. (WHATWG already folds the decimal, hex and octal IPv4
 * forms.)
 */
function sameHostUrls(url: URL): URL[] {
  const m = IPV4_IN_IPV6.exec(url.hostname);
  if (m === null) return [url];
  const hi = Number.parseInt(m[1] as string, 16);
  const lo = Number.parseInt(m[2] as string, 16);
  const v4 = new URL(url.href);
  v4.hostname = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  return [url, v4];
}

/**
 * The spellings of one URL a deny or ask rule compares: as written, then as
 * the request that is really made (see {@link requestUrl}) under each way of
 * writing its host ({@link sameHostUrls}); and, marked, the same request on
 * no explicit port and over the other of http and https.
 */
function restrictUrlSpellings(raw: string): UrlFold[] {
  const out: UrlFold[] = [];
  const add = (texts: ReadonlyArray<string>, portDropped: boolean, schemeSwapped: boolean) => {
    for (const t of texts) {
      out.push({ text: t.normalize("NFC").toLowerCase(), portDropped, schemeSwapped });
    }
  };
  add([raw], false, false);
  const request = requestUrl(raw);
  if (request === undefined) return out;
  for (const url of sameHostUrls(request)) {
    add(hrefSpellings(url), false, false);
    const other =
      url.protocol === "https:" ? "http:" : url.protocol === "http:" ? "https:" : undefined;
    if (other !== undefined) {
      const swapped = new URL(url.href);
      swapped.protocol = other;
      add(hrefSpellings(swapped), false, true);
    }
    if (url.port !== "") {
      const portless = new URL(url.href);
      portless.port = "";
      add(hrefSpellings(portless), true, false);
      if (other !== undefined) {
        portless.protocol = other;
        add(hrefSpellings(portless), true, true);
      }
    }
  }
  return out;
}

/**
 * Which folded URL spellings a deny or ask rule reads, from its argument
 * glob. A rule that names a HOST (`https://evil.example/**`,
 * `http://*.corp.example/**`) is about that host, and the host on another
 * port, or over the other of http and https, is still it — unless the rule
 * names a port, which then stays the one it names. A rule whose host is a
 * wildcard (`http://**`, `https://*:8443/**`) is about the scheme or port it
 * names, and reads only that: `alwaysDeny WebFetch(http://**)` refuses
 * plain HTTP and nothing else.
 */
type UrlGlobScope = { readonly anyPort: boolean; readonly eitherScheme: boolean };

const urlScopes = new WeakMap<CompiledPattern, UrlGlobScope>();

function urlGlobScope(compiled: CompiledPattern): UrlGlobScope {
  const cached = urlScopes.get(compiled);
  if (cached !== undefined) return cached;
  const glob = (compiled.argGlob ?? "").normalize("NFC").toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/.exec(glob);
  let scope: UrlGlobScope = { anyPort: false, eitherScheme: false };
  if (m !== null) {
    const scheme = m[1] as string;
    const authority = m[2] as string;
    // The host, without userinfo or a port. (A port-less spelling can never
    // meet a glob that writes a port, so a rule that names one keeps to it.)
    let host = authority.slice(authority.lastIndexOf("@") + 1);
    if (host.startsWith("[")) {
      const close = host.indexOf("]");
      if (close !== -1) host = host.slice(0, close + 1);
    } else if (host.includes(":")) {
      host = host.slice(0, host.lastIndexOf(":"));
    }
    const namesHost = /[^*?]/.test(host);
    scope = {
      anyPort: namesHost,
      eitherScheme: namesHost && (scheme === "http" || scheme === "https"),
    };
  }
  urlScopes.set(compiled, scope);
  return scope;
}

/**
 * Can this URL satisfy an allow rule? Not when it carries userinfo (a
 * credential the model put in an argument, and a way to make a URL read as
 * another host), nor when an escaped separator or dot would climb out of
 * the path a rule granted once a server decodes it (`/public/..%2Fadmin`).
 */
function urlGrantable(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return true;
  }
  if (url.username !== "" || url.password !== "") return false;
  const decoded = url.pathname.replace(SEPARATOR_OR_DOT_ESCAPE, (pct) =>
    pct.toUpperCase() === "%2E" ? "." : "/",
  );
  return !decoded.split("/").some((segment) => segment === ".." || segment === ".");
}

const PHONE_SHAPED = /^\+?[\d\s().-]+$/;

/**
 * The spellings of one recipient a deny or ask rule compares, lower-cased: a
 * host or an email domain names the same place with a root dot or in
 * capitals, an address with a `+tag` reaches the mailbox without it at most
 * providers, and a phone number is the same number with or without spaces,
 * dashes and brackets.
 */
function restrictRecipientSpellings(raw: string): string[] {
  const written = raw.normalize("NFC").toLowerCase().trim();
  // `Name <addr>` is delivered to addr.
  const bracketed = /<([^<>]*)>/.exec(written)?.[1]?.trim();
  const out = [written];
  if (bracketed !== undefined && bracketed !== "") out.push(bracketed);
  const value = bracketed !== undefined && bracketed !== "" ? bracketed : written;
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1).replace(/\.+$/, "");
    out.push(`${local}@${domain}`);
    const plus = local.indexOf("+");
    if (plus > 0) out.push(`${local.slice(0, plus)}@${domain}`);
  } else if (PHONE_SHAPED.test(value)) {
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 5) out.push(`${value.startsWith("+") ? "+" : ""}${digits}`);
  } else if (value.endsWith(".")) {
    out.push(value.replace(/\.+$/, ""));
  }
  return out;
}

/**
 * The folded spellings a deny or ask rule also compares for a value of this
 * kind, with how the rule's glob is folded to meet them; `undefined` for a
 * kind that is compared only as written.
 *
 * - `url`: see {@link restrictUrlSpellings} and {@link urlGlobScope} — its
 *   folds depend on the rule, so they are read in `valueMatches`.
 * - `recipient`: see {@link restrictRecipientSpellings}.
 * - `id`: letter case ignored — an owner or repository on a code host, a
 *   hex address on a chain, are the same whatever the case.
 * - `command`: letter case ignored — a program named `RM` runs `rm` on a
 *   filesystem that ignores case, which macOS's does by default.
 */
/** Each value's folds, worked out once however many rules read them. */
const restrictFoldCache = new WeakMap<OperativeValue, string[] | undefined>();
const urlFoldCache = new WeakMap<OperativeValue, UrlFold[]>();

function restrictFoldsOf(value: OperativeValue): string[] | undefined {
  if (restrictFoldCache.has(value)) return restrictFoldCache.get(value);
  const folds = restrictFolds(value.kind, [...value.canonical, ...(value.spellings ?? [])]);
  restrictFoldCache.set(value, folds);
  return folds;
}

function urlFoldsOf(value: OperativeValue): UrlFold[] {
  let folds = urlFoldCache.get(value);
  if (folds === undefined) {
    folds = [...value.canonical, ...(value.spellings ?? [])].flatMap(restrictUrlSpellings);
    urlFoldCache.set(value, folds);
  }
  return folds;
}

function restrictFolds(
  kind: OperativeValueKind,
  candidates: ReadonlyArray<string>,
): string[] | undefined {
  switch (kind) {
    case "recipient":
      return candidates.flatMap(restrictRecipientSpellings);
    case "id":
    case "command":
      return candidates.map((c) => c.normalize("NFC").toLowerCase());
    default:
      return undefined;
  }
}

function valueMatches(
  value: OperativeValue,
  compiled: CompiledPattern,
  argRe: GlobMatcher,
  absoluteGlob: boolean,
  polarity: RulePolarity,
): boolean {
  // A command with no canonical spelling runs where its words may name
  // another program — another directory, or an environment the call set
  // (PATH, BASH_ENV) — so no allow that names a command covers it. One that
  // names EVERY command (`RunCommand(**)`) still does: whichever program it
  // turns out to be is one it names — even when the environment was too
  // large to read (`outsideWorkspace`), which only decides WHICH program.
  if (polarity === "allow" && value.kind === "command" && value.canonical.length === 0) {
    return argRe.matchesEveryAfter("", anyValueTail(value));
  }
  if (value.outsideWorkspace === true) return polarity === "restrict";
  // A value that stands for every value (a field left out whose default is
  // `*`) is granted only by a glob that matches every value there: its
  // canonical spelling `<prefix>*` is not a literal `*`, so `EvmGetLogs(1/?)`
  // cannot stand in for `EvmGetLogs(1/*)`.
  if (polarity === "allow" && value.standsForAny !== undefined) {
    const tail = anyValueTail(value);
    // A value whose qualifier was left out too stands for every
    // `<qualifier>/<value>` as well (a search naming no owner reaches every
    // repository), so an allow must cover both widths: `SearchIssues(*)`
    // covers no `acme/app`, and so grants no search of every repository.
    const segments = value.anyQualifier === true ? 2 : 1;
    return value.canonical.some((candidate) => {
      if (value.kind === "path" && isAbsoluteSpelling(candidate) !== absoluteGlob) return false;
      return candidate.endsWith(ANY_VALUE)
        ? argRe.matchesEveryAfter(candidate.slice(0, -ANY_VALUE.length), tail, segments)
        : argRe.test(candidate);
    });
  }
  const candidates =
    polarity === "allow"
      ? value.kind === "url"
        ? value.canonical.filter(urlGrantable)
        : value.canonical
      : [...value.canonical, ...(value.spellings ?? [])];
  for (const candidate of candidates) {
    if (value.kind === "path" && isAbsoluteSpelling(candidate) !== absoluteGlob) continue;
    if (argRe.test(candidate)) return true;
  }
  if (polarity !== "restrict") return false;
  // A field the call left out whose default is `*` stands for every value, so
  // a deny or ask naming any one value there fires on it — in whatever form
  // the kind is folded in below, so a deny naming the chain `Base` catches
  // the every-contract query on `base` as it catches the one-contract one,
  // and, when its qualifier was left out too, under any qualifier.
  if (value.standsForAny !== undefined && standsForAnyFires(value, compiled, argRe, absoluteGlob)) {
    return true;
  }
  // A deny or ask on a path is not dodged by spelling the name another way
  // the filesystem treats as the same: another Unicode normal form always,
  // and another letter case where the filesystem ignores case.
  if (value.kind === "path") {
    const ignoreCase = value.caseInsensitive === true;
    const folded = foldedArgMatcher(compiled, ignoreCase ? "lower" : "nfc");
    for (const candidate of candidates) {
      if (isAbsoluteSpelling(candidate) !== absoluteGlob) continue;
      if (folded.test(foldPath(candidate, ignoreCase))) return true;
    }
    return false;
  }
  // Nor is one on a value that names the same thing in any letter case — a
  // `0x` hex address or hash, whose case is at most an EIP-55 checksum,
  // whether it arrives as an id, a recipient or text.
  if (value.caseInsensitive === true) {
    const folded = foldedArgMatcher(compiled, "lower");
    if (candidates.some((c) => folded.test(c.normalize("NFC").toLowerCase()))) return true;
  }
  // Nor is a deny or ask on a URL, a recipient, an id or a command dodged by
  // another spelling of the same destination.
  if (value.kind === "url") {
    const scope = urlGlobScope(compiled);
    const folded = foldedArgMatcher(compiled, "lower");
    return urlFoldsOf(value).some(
      (f) =>
        (!f.portDropped || scope.anyPort) &&
        (!f.schemeSwapped || scope.eitherScheme) &&
        folded.test(f.text),
    );
  }
  // A glob that folding leaves as it is compiles to the same matcher, so a
  // fold that is already one of the value's own spellings was tested above;
  // a command's words are mostly lower case already, and a long argv run in
  // a subdirectory would otherwise be matched twice over.
  const folds = globFoldsToItself(compiled) ? restrictNewFoldsOf(value) : restrictFoldsOf(value);
  if (folds === undefined) return false;
  const folded = foldedArgMatcher(compiled, "lower");
  return folds.some((candidate) => folded.test(candidate));
}

const globFoldCache = new WeakMap<CompiledPattern, boolean>();

/** Does folding (NFC, lower case) leave this pattern's argument glob as it is? */
function globFoldsToItself(compiled: CompiledPattern): boolean {
  let same = globFoldCache.get(compiled);
  if (same === undefined) {
    const glob = compiled.argGlob ?? "";
    same = foldPath(glob, true) === glob;
    globFoldCache.set(compiled, same);
  }
  return same;
}

const restrictNewFoldCache = new WeakMap<OperativeValue, string[] | undefined>();

/** The value's folds that are not already among its own canonical spellings and spellings. */
function restrictNewFoldsOf(value: OperativeValue): string[] | undefined {
  if (restrictNewFoldCache.has(value)) return restrictNewFoldCache.get(value);
  const folds = restrictFoldsOf(value);
  const own = new Set([...value.canonical, ...(value.spellings ?? [])]);
  const fresh = folds?.filter((f) => !own.has(f));
  restrictNewFoldCache.set(value, fresh);
  return fresh;
}

/** The declared default that stands for every value of its field. */
const ANY_VALUE = "*";

/**
 * What follows a prefix in a value that stands for every value. An id, a
 * recipient or a text value is one segment after its qualifier (the address
 * after `<chainId>/`), so `EvmGetLogs(137/…)` does not fire on chain 1's
 * every-contract query; a path, a URL or a command may hold `/` anywhere,
 * and so may a value marked `standsForAnyRun` (a prefix of a key).
 */
function anyValueTail(value: OperativeValue): AnyValueTail {
  if (value.standsForAnyRun === true) return "run";
  const kind = value.kind;
  return kind === "path" || kind === "url" || kind === "command" ? "run" : "segment";
}

/**
 * Does a deny or ask glob name some value of a value that stands for every
 * value — directly, or folded the way a value of its kind is folded?
 */
function standsForAnyFires(
  value: OperativeValue,
  compiled: CompiledPattern,
  argRe: GlobMatcher,
  absoluteGlob: boolean,
): boolean {
  const tail = anyValueTail(value);
  // One segment after the prefix — or, when the qualifier was left out too
  // (`anyQualifier`), also `<qualifier>/<value>`: two. A run already holds
  // any number of `/`.
  const someAfter = (m: GlobMatcher, prefix: string): boolean =>
    tail === "segment" && value.anyQualifier === true
      ? m.matchesSegmentAfter(prefix, 1) || m.matchesSegmentAfter(prefix, 2)
      : m.matchesSomeAfter(prefix, tail);
  const prefixes = (value.standsForAny ?? []).filter(
    (prefix) => value.kind !== "path" || isAbsoluteSpelling(prefix) === absoluteGlob,
  );
  if (prefixes.some((prefix) => someAfter(argRe, prefix))) return true;
  if (value.kind === "path") {
    const ignoreCase = value.caseInsensitive === true;
    const folded = foldedArgMatcher(compiled, ignoreCase ? "lower" : "nfc");
    return prefixes.some((prefix) => someAfter(folded, foldPath(prefix, ignoreCase)));
  }
  const foldsCase =
    value.caseInsensitive === true ||
    value.kind === "url" ||
    value.kind === "id" ||
    value.kind === "recipient" ||
    value.kind === "command";
  if (!foldsCase) return false;
  const folded = foldedArgMatcher(compiled, "lower");
  return prefixes.some((prefix) => someAfter(folded, prefix.normalize("NFC").toLowerCase()));
}

/**
 * Does a rule's pattern match this tool call?
 *
 * The tool half is matched against the tool's name (see
 * {@link matchesToolName}). A bare pattern stops there. An argument glob is
 * matched against the call's operative values, and how depends on which way
 * the rule points:
 *
 * - `polarity: "allow"` (the default) — EVERY operative value must match. One
 *   in-scope value cannot carry an out-of-scope one: `Write(src/**)` does not
 *   authorise `{ file_path: "src/ok.ts", path: ".git/hooks/pre-commit" }`.
 * - `polarity: "restrict"` (deny, ask) — ANY operative value matching is
 *   enough. A deny that needed every value to match would be dodged by
 *   adding one more argument.
 *
 * An allow skips a `restrictOnly` value (a relocating field's default). A
 * call with no operative value an allow can read matches no
 * argument-scoped allow. A deny or ask on a call that carries none of its
 * tool's declared operative fields is matched against the call's string
 * values instead, the way 0.7.0 matched a tool it knew no field of: EVERY
 * string must match, and a call with none matches nothing. So leaving
 * every optional operative field out does not dodge `alwaysDeny Tool(**)`,
 * while a deny about a destination (`WebhookPost(http://**)`) is not set
 * off by a link inside the payload of a call that names its destination
 * through `urlEnv`.
 */
export function matchesPattern(
  compiled: CompiledPattern,
  toolName: string,
  input: unknown,
  options: MatchOptions = {},
): boolean {
  if (!matchesToolName(compiled, toolName)) return false;
  const argRe = compiled._argRe;
  if (argRe === null) return true;
  const polarity = options.polarity ?? "allow";
  const absoluteGlob = globIsAbsolute(compiled.argGlob ?? "");
  const values = options.operativeValues ?? fallbackValues(toolName, input);
  if (polarity === "allow") {
    const granted = values.filter((v) => v.restrictOnly !== true);
    if (granted.length === 0) return false;
    return granted.every((v) => valueMatches(v, compiled, argRe, absoluteGlob, polarity));
  }
  // The tool declares where it acts and this call names none of it: read
  // what the call does carry, as 0.7.0 did — every string, not any one.
  if (values.length === 0 && options.operativeValues !== undefined) {
    const strings = stringValues(input).map(undeclaredValue);
    return (
      strings.length > 0 &&
      strings.every((v) => valueMatches(v, compiled, argRe, absoluteGlob, polarity))
    );
  }
  return values.some((v) => valueMatches(v, compiled, argRe, absoluteGlob, polarity));
}

export {
  type PermissionRuleList,
  type PermissionRuleProblem,
  type PermissionRuleProblemCode,
  type PermissionRuleProblemsInput,
  type RuleToolDescriptor,
  argGlobCanMatchUrl,
  mcpServersReachedBy,
  permissionRuleProblems,
  specPermissionRuleLists,
} from "./rule-problems";
