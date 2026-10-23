/**
 * The `lean4` proof checker — Lean 4 in a sandbox (design §6.4).
 *
 * Input: `statement` is a Lean proposition; `proof` is a term or a tactic
 * block (`by …`), optionally preceded by `import` lines. The adapter writes
 * one file:
 *
 *     import <allowed modules…>          ; only the proof's leading imports
 *     theorem crewhaus_claim : (
 *         <statement, each line indented 4>
 *         )
 *         :=
 *       <proof, each line indented 2>
 *     #print axioms crewhaus_claim
 *
 * and runs `lean --stdin --json` on it. The statement is closed off in
 * parentheses of the adapter's own, and its brackets must balance, so an
 * unfinished statement (`… ∨ let x`, `… id (a`) is a parse error instead of
 * something the proof completes across the `:=` line — the type Lean checks
 * is always the statement shown. `)` and `:=` get lines of their own so a
 * trailing `--` comment in the statement cannot swallow them; indenting the
 * proof uniformly keeps a tactic block's relative layout.
 *
 * A deterministic PRE-SCAN runs before any container does. It strips Lean
 * comments (`--`, nested `/- … -/`) and string and char literals (a `«…»`
 * identifier is kept as a name, its contents never read as a quote, a
 * comment or a bracket), splits words with Lean's own identifier characters,
 * then refuses — scanning exactly the statement and proof text the file holds:
 *   - a `formal.forbid` token as a whole word (default `sorry`, `axiom`,
 *     `native_decide`) — a `sorry` inside a comment or a string is not code
 *     and is not refused; `2omega` is the numeral `2` and the word `omega`;
 *   - a character literal or raw string anywhere but after a space, a line
 *     break, an opening bracket, `,` or `;` (`!'"'`, `0')'`, `1e5r"…"`):
 *     whether Lean opens one there is a lexer detail the scan must not guess;
 *   - a command keyword (`theorem`, `def`, `example`, `macro`, `elab`,
 *     `set_option`, …), a `#command` (`#eval`, `#print`, `#exit`, …) or an
 *     attribute (`@[…]`): the statement and the proof must stay inside the ONE
 *     theorem, or they could end it early and declare another, redefine how
 *     `#print axioms` reports, or turn the kernel check off;
 *   - an `import` that is not a leading line of the proof, that names a
 *     module outside the allowlist (`Init`, `Std` and their submodules;
 *     `Mathlib` too when the image is overridden, since only a Mathlib image
 *     can load it), or that carries a comment or a string (the header is
 *     rewritten from the module names, so a `/-` there would vanish from the
 *     file while still hiding the next line from the scan);
 *   - a statement containing `:=` or unbalanced brackets, either of which
 *     could end the theorem's type early (counted outside `«…»` names: `«)»`
 *     is a name to Lean, so it closes nothing);
 *   - a string literal holding `{`, or one after `!` (`s!"…"`, `m! "…"`):
 *     several Lean forms (`s!`, `m!`, `dbg_trace`, `throwError`, `trace[…]`)
 *     read `{…}` inside a string as code;
 *   - unterminated comments, strings or `«…»` names.
 *
 * Verdict: ok ⇔ lean exits 0, reports no `error`, and the `#print axioms`
 * message — read from the JSON message positioned on the adapter's own line,
 * so text the proof prints cannot impersonate it — parses. `sorryAx` is
 * always a rejection; the compiler-trusting axioms — `Lean.ofReduceBool` /
 * `Lean.ofReduceNat` / `Lean.trustCompiler`, and the `<decl>._native.…`
 * auxiliaries `native_decide` and `decide +native` leave on Lean 4.34 — are a
 * rejection while `native_decide` is forbidden. Any other axiom beyond
 * `propext`, `Classical.choice` and `Quot.sound` is RECORDED in `axioms` and
 * the proof stays ok: it is shown, not hidden (design §6.4).
 */
import {
  LEAN4_DEFAULT_ENTRYPOINT,
  LEAN4_HEALTHCHECK_ARGV,
  LEAN4_IMAGE_REF,
} from "@crewhaus/sandbox-image-lean4";
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  type SandboxCheckerOptions,
  type SandboxProofChecker,
  budgetMs,
  clipLine,
  clipOutput,
  createAvailabilityProbe,
  errorMessage,
  noopRefusal,
} from "./sandbox-common";
import type { CheckInput, CheckResult } from "./types";

export const LEAN4_CHECKER_ID = "lean4";
/** The theorem the adapter declares; `#print axioms` names it. */
export const LEAN4_THEOREM_NAME = "crewhaus_claim";
/** `formal.forbid`'s default. */
export const LEAN4_DEFAULT_FORBID: ReadonlyArray<string> = ["sorry", "axiom", "native_decide"];
/** Lean's own trusted base: listed by `#print axioms`, never recorded. */
export const LEAN4_STANDARD_AXIOMS: ReadonlyArray<string> = [
  "propext",
  "Classical.choice",
  "Quot.sound",
];
/** Modules a proof may import from the curated (Mathlib-free) image. */
export const LEAN4_CORE_IMPORTS: ReadonlyArray<string> = ["Init", "Std"];
/** Added to the allowlist when `formal.image` overrides the image. */
export const LEAN4_OVERRIDE_IMPORTS: ReadonlyArray<string> = ["Mathlib"];
/** The axioms through which a proof trusts the compiler, by name (older Lean, or a direct use). */
const COMPILER_AXIOMS = new Set(["Lean.ofReduceBool", "Lean.ofReduceNat", "Lean.trustCompiler"]);

/**
 * Whether an axiom is one a proof that trusts the compiler leaves behind.
 * `Lean.ofReduceBool` and friends name it directly; Lean 4.34 (the curated
 * image's toolchain) instead adds one auxiliary axiom per use, named
 * `<decl>._native.<tactic>.ax_<i>_<j>` — `crewhaus_claim._native.decide.ax_1_1`
 * for `decide +native`, a spelling the pre-scan's `native_decide` word never
 * sees. Found against the real toolchain (sandbox.live.test.ts); the `_native`
 * name component is Lean's, and a proof cannot declare an axiom of its own
 * (`axiom` is a command word the pre-scan refuses).
 */
function trustsCompiler(axiom: string): boolean {
  return COMPILER_AXIOMS.has(axiom) || axiom.split(".").includes("_native");
}

/**
 * Words that start a new command (or change how one elaborates). None can
 * appear inside a single theorem's statement or proof, so any of them is an
 * attempt to step outside it.
 */
export const LEAN4_COMMAND_WORDS: ReadonlyArray<string> = [
  "theorem",
  "lemma",
  "def",
  "example",
  "abbrev",
  "instance",
  "axiom",
  "opaque",
  "structure",
  "class",
  "inductive",
  "coinductive",
  "mutual",
  "namespace",
  "section",
  "end",
  "universe",
  "variable",
  "export",
  "prelude",
  "import",
  "macro",
  "macro_rules",
  "syntax",
  "elab",
  "elab_rules",
  "notation",
  "infix",
  "infixl",
  "infixr",
  "prefix",
  "postfix",
  "declare_syntax_cat",
  "initialize",
  "builtin_initialize",
  "attribute",
  "set_option",
  "unsafe",
  "partial",
  "noncomputable",
  "private",
  "protected",
  "deriving",
  "run_cmd",
  "run_elab",
  "run_meta",
  "run_tac",
  "by_elab",
];

export const LEAN4_LANGUAGE = [
  "lean4: Lean 4 (no Mathlib unless the harness overrides the image), checked in a sandbox.",
  "`statement` is one complete Lean proposition (no `:=`, brackets balanced), e.g. `∀ n : Nat, n + 0 = n`.",
  "`proof` is a term or a tactic block (`by simp`), optionally preceded by `import Std…` lines; the checker writes `theorem crewhaus_claim : <statement> := <proof>` and prints its axioms.",
  "Refused before Lean runs: sorry, axiom and native_decide (the harness's forbid list), any new command or attribute (def, example, set_option, macro, #eval, @[…], …) — keep helpers inside the proof with `have`/`where` — and imports other than Init/Std (plus Mathlib on a Mathlib image).",
  "Accepted when Lean reports no error; axioms beyond propext, Classical.choice and Quot.sound are listed with the proof. No tab characters.",
  "Example: statement `∀ n : Nat, n + 0 = n`, proof `by intro n; simp`.",
].join(" ");

// ---------------------------------------------------------------------------
// Pre-scan
// ---------------------------------------------------------------------------

class LeanRefusal extends Error {
  override readonly name = "LeanRefusal";
}

const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/;
/**
 * One Lean character literal: a character, `\xHH`, `\uHHHH`, or a one-letter
 * escape. A literal newline is a character too — Lean's `charLitFnAux` takes
 * any one — and must be read as one, or the closing `'` would start another.
 */
const CHAR_LITERAL = /^'(?:\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/u;
/** Statement and proof caps (characters). */
export const LEAN4_LIMITS = { maxStatementChars: 20_000, maxProofChars: 200_000 } as const;

// Lean 4's identifier characters, exactly (`isLetterLike`, `isSubScriptAlnum`,
// `isIdFirst`, `isIdRest` in Lean's `Init/Meta.lean`). The pre-scan must split
// words where Lean's lexer does, not where Unicode does: `λ`, `Π` and `Σ` are
// letters to Unicode and tokens to Lean, `²` is a number to Unicode and not an
// identifier character to Lean, and `2omega` is the numeral `2` and the word
// `omega` (so `iterate 2omega` runs `omega`).
function isLetterLike(cp: number): boolean {
  return (
    (cp >= 0x3b1 && cp <= 0x3c9 && cp !== 0x3bb) || // lower Greek, not λ
    (cp >= 0x391 && cp <= 0x3a9 && cp !== 0x3a0 && cp !== 0x3a3) || // upper Greek, not Π Σ
    (cp >= 0x3ca && cp <= 0x3fb) || // Coptic
    (cp >= 0x1f00 && cp <= 0x1ffe) || // polytonic Greek
    (cp >= 0x2100 && cp <= 0x214f) || // letterlike symbols (ℕ ℝ …)
    (cp >= 0x1d49c && cp <= 0x1d59f) // script, double-struck, Fraktur
  );
}

function isSubscriptAlnum(cp: number): boolean {
  return (
    (cp >= 0x2080 && cp <= 0x2089) ||
    (cp >= 0x2090 && cp <= 0x209c) ||
    (cp >= 0x1d62 && cp <= 0x1d6a)
  );
}

function isIdFirst(cp: number): boolean {
  return (
    (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f || isLetterLike(cp)
  );
}

function isIdRest(cp: number): boolean {
  return (
    isIdFirst(cp) ||
    (cp >= 0x30 && cp <= 0x39) ||
    cp === 0x27 || // '
    cp === 0x21 || // !
    cp === 0x3f || // ?
    isSubscriptAlnum(cp)
  );
}

/**
 * A letter, digit or mark to Unicode. Where it is not one of Lean's
 * identifier characters (`λ`, `²`) — or follows a numeral — the scan does not
 * model how Lean lexes the run, so a word inside it counts as a word of its
 * own (the conservative side) and a literal after it is refused.
 */
const WORDISH = /[\p{L}\p{N}\p{M}]/u;
/**
 * What may sit right before a character literal or a raw string. Lean opens
 * one only at the start of a token, and whether `'` (or `r"`) after `!`, `?`, a
 * digit, `»` or another token starts one depends on lexer details the scan
 * must not guess — `!'"'` is `!` then the literal `'"'`, `1e5r"\"` a numeral
 * then a raw string, and a token ending in `'` (Mathlib's `∑'`) would make the
 * same `'` plain code. So a literal must follow a space, a line break, an
 * opening bracket, `,` or `;`; anywhere else it is refused, never guessed.
 */
const LITERAL_MAY_FOLLOW = new Set(["(", "[", "{", "⟨", "⦃", "⟦", ",", ";"]);

function literalMayStartAt(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text.charAt(i - 1);
  return /\s/.test(prev) || LITERAL_MAY_FOLLOW.has(prev);
}

/** How the pre-scan reads Lean source. All three views are as long as the source (UTF-16 units). */
export type LeanLexed = {
  /**
   * Comments and string, char and raw-string literals blanked to spaces,
   * newlines kept. A `«…»` name is kept as written, so the word scans see
   * inside it (refusing `«sorry»` is the conservative side).
   */
  readonly code: string;
  /**
   * `code` with each `«…»` name's contents masked as well: the view the
   * bracket and `:=` checks read, because `«)»` is a name to Lean, not a
   * bracket.
   */
  readonly shape: string;
  /**
   * `continues[k]` is 1 when the code unit at `k` continues an identifier
   * that began before it — so a word starting there is part of a longer name.
   */
  readonly continues: Uint8Array;
};

/**
 * Lex Lean source the way the pre-scan needs to: what is code, what is a
 * name, and where identifiers run. Throws a one-sentence reason for anything
 * it cannot read the way Lean would.
 */
export function lexLean(text: string): LeanLexed {
  const code: string[] = [];
  const shape: string[] = [];
  const n = text.length;
  const continues = new Uint8Array(n);
  const blank = (from: number, to: number): void => {
    // Per UTF-16 unit, so a blanked astral character keeps its width.
    const s = text.slice(from, to).replace(/[^\n]/g, " ");
    code.push(s);
    shape.push(s);
  };
  // The last character of CODE kept so far (comments and literals do not
  // count), tracked as we go: looking back through `code` per string would be
  // quadratic in a proof of many strings.
  let lastCode = "";
  // Where Lean's lexer stands: inside an identifier (`ident`), inside some
  // other run of word characters whose lexing the scan does not model — a
  // numeral, a `«…»` name, a Unicode letter Lean does not take (`other`) — or
  // at a token boundary (`none`).
  let state: "none" | "ident" | "other" = "none";
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    const d = text.charAt(i + 1);
    if (c === "-" && d === "-") {
      let j = i;
      while (j < n && text.charAt(j) !== "\n") j += 1;
      blank(i, j);
      state = "none";
      i = j;
      continue;
    }
    if (c === "/" && d === "-") {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (text.startsWith("/-", j)) {
          depth += 1;
          j += 2;
        } else if (text.startsWith("-/", j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      if (depth !== 0) throw new LeanRefusal("a `/-` comment is never closed");
      blank(i, j);
      state = "none";
      i = j;
      continue;
    }
    if (c === "r" && state !== "ident" && (d === '"' || d === "#")) {
      // Raw string r"…" / r#"…"# — Lean opens one only at a token start; in
      // an identifier (`bar"…"`) the `r` is part of the name.
      let j = i + 1;
      let hashes = 0;
      while (text.charAt(j) === "#") {
        hashes += 1;
        j += 1;
      }
      if (text.charAt(j) === '"') {
        if (!literalMayStartAt(text, i)) {
          throw new LeanRefusal(
            `a raw string right after \`${text.charAt(i - 1)}\` is ambiguous; put a space before it`,
          );
        }
        const close = `"${"#".repeat(hashes)}`;
        const end = text.indexOf(close, j + 1);
        if (end < 0) throw new LeanRefusal("a raw string is never closed");
        blank(i, end + close.length);
        state = "none";
        i = end + close.length;
        continue;
      }
    }
    if (c === "«") {
      // A «…» name: its contents are an identifier, never a quote, a comment
      // opener or a bracket (`«"»` must not start a string that hides code,
      // and `«)»` must not close a bracket Lean leaves open).
      const end = text.indexOf("»", i + 1);
      if (end < 0) throw new LeanRefusal("a `«` name is never closed");
      code.push(text.slice(i, end + 1));
      shape.push(`«${text.slice(i + 1, end).replace(/[^\n]/g, "x")}»`);
      lastCode = "»";
      // Lean ends the name at `»` (only `.` continues it), but what follows
      // is not something the scan needs to read as an identifier.
      state = "other";
      i = end + 1;
      continue;
    }
    if (c === '"') {
      if (lastCode === "!") {
        throw new LeanRefusal(
          'interpolated strings (`s!"…"`, `m!"…"`) are not accepted in a proof',
        );
      }
      let j = i + 1;
      while (j < n && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      if (j >= n) throw new LeanRefusal("a string is never closed");
      if (text.slice(i + 1, j).includes("{")) {
        // `dbg_trace "{e}"`, `throwError "{e}"`, `trace[c] "{e}"` and the `!`
        // forms all read `{e}` as code, so a brace in any string is refused
        // rather than blanked.
        throw new LeanRefusal(
          "a string containing `{` is not accepted: in several Lean forms (`dbg_trace`, `throwError`, `s!`) `{…}` inside a string is code",
        );
      }
      blank(i, j + 1);
      state = "none";
      i = j + 1;
      continue;
    }
    if (c === "'" && state !== "ident") {
      // Outside an identifier a `'` starts a character literal (Lean's
      // `tokenFnAux`), unless the next character is `'` too (`''`, a token
      // Mathlib uses for `Set.image`).
      if (d === "'") {
        code.push("''");
        shape.push("''");
        lastCode = "'";
        state = "none";
        i += 2;
        continue;
      }
      const m = CHAR_LITERAL.exec(text.slice(i, i + 16));
      if (literalMayStartAt(text, i)) {
        if (m === null) {
          throw new LeanRefusal(
            "a `'` here starts a character literal, and what follows is not one (`'a'`, `'\\n'`, `'\\x41'`)",
          );
        }
        blank(i, i + m[0].length);
        state = "none";
        i += m[0].length;
        continue;
      }
      if (m !== null) {
        throw new LeanRefusal(
          `a character literal right after \`${text.charAt(i - 1)}\` is ambiguous; put a space before it`,
        );
      }
      // Otherwise the `'` belongs to whatever came before (`∑'`, `⁻¹'`): code.
    }
    const cp = text.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + width);
    if (state === "ident" && isIdRest(cp)) {
      continues[i] = 1;
      if (width === 2) continues[i + 1] = 1;
    } else if (state === "other" && (isIdRest(cp) || WORDISH.test(ch))) {
      // Still inside the run the scan does not model.
    } else if (isIdFirst(cp)) {
      state = "ident";
    } else if (cp !== 0x21 && cp !== 0x3f && (isIdRest(cp) || WORDISH.test(ch))) {
      // A digit (a numeral: `1e5`, `0x1F`), a subscript, or a letter Lean
      // does not take. `!` and `?` alone are tokens of their own.
      state = "other";
    } else {
      state = "none";
    }
    code.push(ch);
    shape.push(ch);
    if (!/\s/.test(ch)) lastCode = ch;
    i += width;
  }
  return { code: code.join(""), shape: shape.join(""), continues };
}

/**
 * Lean source with comments and string/char literals blanked to spaces, the
 * same length, newlines kept — so offsets and line numbers still line up.
 */
export function stripLean(text: string): string {
  return lexLean(text).code;
}

const BRACKETS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "⟨": "⟩",
  "⦃": "⦄",
  "⟦": "⟧",
  "‹": "›",
};
const CLOSERS = new Set(Object.values(BRACKETS));

/** The first bracket that is unmatched or mismatched in stripped code, or undefined. */
function unbalancedBracket(code: string): string | undefined {
  const stack: string[] = [];
  for (const ch of code) {
    const close = BRACKETS[ch];
    if (close !== undefined) {
      stack.push(close);
    } else if (CLOSERS.has(ch)) {
      if (stack.pop() !== ch) return ch;
    }
  }
  if (stack.length === 0) return undefined;
  const open = Object.entries(BRACKETS).find(([, c]) => c === stack[stack.length - 1]);
  return open?.[0];
}

/**
 * Whether `word` occurs in `lexed.code` as a whole word: not the tail of an
 * identifier that began before it, and not followed by a character that
 * would extend it. Word boundaries are Lean's (see {@link isIdRest}), so a
 * word after a numeral, a lone `!` or a `«…»` name counts — Lean reads it as
 * a token of its own there.
 */
function findWord(lexed: LeanLexed, word: string): boolean {
  if (word === "") return false;
  const { code, continues } = lexed;
  const first = word.codePointAt(0) as number;
  const chars = Array.from(word);
  const last = (chars[chars.length - 1] as string).codePointAt(0) as number;
  for (let k = code.indexOf(word); k >= 0; k = code.indexOf(word, k + 1)) {
    if (isIdRest(first) && continues[k] === 1) continue;
    const after = code.codePointAt(k + word.length);
    if (isIdRest(last) && after !== undefined && isIdRest(after)) continue;
    return true;
  }
  return false;
}

export type LeanFile = {
  /** The file `lean --stdin` reads. */
  readonly source: string;
  /** 1-based line of the adapter's `#print axioms`. */
  readonly printLine: number;
  readonly imports: readonly string[];
};

export type LeanPrescanOptions = {
  readonly forbid: readonly string[];
  readonly imports: readonly string[];
};

function importAllowed(module: string, allow: readonly string[]): boolean {
  return allow.some((root) => module === root || module.startsWith(`${root}.`));
}

/**
 * The deterministic pre-scan and the file it yields. Throws a one-sentence
 * reason when the input is refused.
 */
export function prescanLean(statement: string, proof: string, opts: LeanPrescanOptions): LeanFile {
  if (statement.trim() === "") throw new LeanRefusal("the statement is empty");
  if (proof.trim() === "") throw new LeanRefusal("the proof is empty");
  if (statement.length > LEAN4_LIMITS.maxStatementChars) {
    throw new LeanRefusal(
      `the statement is ${statement.length} characters; the cap is ${LEAN4_LIMITS.maxStatementChars}`,
    );
  }
  if (proof.length > LEAN4_LIMITS.maxProofChars) {
    throw new LeanRefusal(
      `the proof is ${proof.length} characters; the cap is ${LEAN4_LIMITS.maxProofChars}`,
    );
  }
  const statementLexed = lexLean(statement);
  const proofCode = stripLean(proof);

  // Leading `import` lines of the proof become the file header.
  const proofLines = proof.split("\n");
  const codeLines = proofCode.split("\n");
  const imports: string[] = [];
  let first = 0;
  for (; first < codeLines.length; first++) {
    const line = (codeLines[first] as string).trim();
    if (line === "") continue;
    if (!/^import(\s|$)/.test(line)) break;
    if ((proofLines[first] as string).trim() !== line) {
      // The header is rewritten from the module names, so a comment opened
      // here would vanish from the file while still blanking the next line
      // in the scan.
      throw new LeanRefusal("an `import` line may hold only module names (no comments or strings)");
    }
    const modules = line.split(/\s+/).slice(1);
    if (modules.length === 0) throw new LeanRefusal("an `import` line names no module");
    for (const module of modules) {
      if (!MODULE_RE.test(module)) throw new LeanRefusal(`\`${module}\` is not a module name`);
      if (!importAllowed(module, opts.imports)) {
        throw new LeanRefusal(
          `\`import ${module}\` is not allowed (allowed: ${opts.imports.join(", ")} and their submodules)`,
        );
      }
      if (!imports.includes(module)) imports.push(module);
    }
  }
  const body = proofLines.slice(first).join("\n");
  if (body.trim() === "") throw new LeanRefusal("the proof has imports but no proof");
  const proofBody = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  // Scan exactly the text the file holds after `:=`, lexed from its own
  // start (the statement and the header leave no comment or string open).
  const bodyLexed = lexLean(proofBody);

  // `P := by have h : Q` would end the theorem's type at `:=` and splice the
  // proof into a block the statement opened — the type proven would not be
  // the statement shown. A proposition needs no `:=`. Both structural checks
  // read the shape view, where `«…»` names are masked: `«)»` is a name to
  // Lean, and counting it as a closer would let a statement leave a real
  // bracket open past the adapter's `)`.
  if (/:=/.test(statementLexed.shape)) {
    throw new LeanRefusal(
      "the statement contains `:=`, which would end the theorem's type early; state the proposition alone",
    );
  }
  // The same splice through an open bracket (`… id (a` finished by a proof
  // `True) := …`): the adapter's own parentheses close the statement, and
  // they only can when its brackets balance.
  const bracket = unbalancedBracket(statementLexed.shape);
  if (bracket !== undefined) {
    throw new LeanRefusal(
      `the statement's brackets do not balance (at \`${bracket}\`); state one complete proposition`,
    );
  }
  for (const [where, lexed] of [
    ["statement", statementLexed],
    ["proof", bodyLexed],
  ] as const) {
    const code = lexed.code;
    for (const token of opts.forbid) {
      if (token !== "" && findWord(lexed, token)) {
        throw new LeanRefusal(`the ${where} uses \`${token}\`, which this harness forbids`);
      }
    }
    if (findWord(lexed, "import")) {
      throw new LeanRefusal("`import` lines must come first in the proof");
    }
    for (const word of LEAN4_COMMAND_WORDS) {
      if (findWord(lexed, word)) {
        throw new LeanRefusal(
          `the ${where} uses \`${word}\`, which would start or change a Lean command; the statement and the proof must stay inside one theorem (use \`have\` or \`where\` for helpers)`,
        );
      }
    }
    const hash = /#[\p{L}_]/u.exec(code);
    if (hash !== null) {
      throw new LeanRefusal(
        `the ${where} uses a \`#\` command (\`${clipLine(code.slice(hash.index, hash.index + 12).split(/\s/)[0] ?? "#", 20)}\`), which is not allowed`,
      );
    }
    if (code.includes("@[")) {
      throw new LeanRefusal(`the ${where} uses an attribute (\`@[…]\`), which is not allowed`);
    }
  }

  const header = imports.map((m) => `import ${m}`);
  const statementLines = statement
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => `    ${l}`);
  const proofLinesOut = proofBody.split("\n").map((l) => `  ${l}`);
  const lines = [
    ...header,
    `theorem ${LEAN4_THEOREM_NAME} : (`,
    ...statementLines,
    "    )",
    "    :=",
    ...proofLinesOut,
    `#print axioms ${LEAN4_THEOREM_NAME}`,
  ];
  return { source: `${lines.join("\n")}\n`, printLine: lines.length, imports };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type LeanMessage = {
  readonly severity: "information" | "warning" | "error";
  /** 1-based line, when Lean reported one. */
  readonly line?: number;
  readonly text: string;
};

const PLAIN_MESSAGE = /^(?:.*?):(\d+):(\d+):\s*(error|warning|info|information):\s?(.*)$/;

/**
 * Lean's messages. `--json` prints one JSON object per line (`severity`,
 * `pos.line`, `data`); without it, warnings and errors are
 * `<file>:<line>:<col>: error: …` and info messages are bare text. Both are
 * read, so an image that drops `--json` still parses — but only the JSON form
 * carries the position the axioms check relies on.
 */
export function parseLeanOutput(stdout: string): { messages: LeanMessage[]; json: boolean } {
  const messages: LeanMessage[] = [];
  let json = false;
  let current: { severity: LeanMessage["severity"]; line?: number; text: string } | undefined;
  const flush = (): void => {
    if (current !== undefined) messages.push(current);
    current = undefined;
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const severity = obj["severity"];
        const data = obj["data"];
        if (
          (severity === "information" || severity === "warning" || severity === "error") &&
          typeof data === "string"
        ) {
          flush();
          json = true;
          const pos = obj["pos"] as { line?: unknown } | undefined;
          messages.push({
            severity,
            ...(typeof pos?.line === "number" ? { line: pos.line } : {}),
            text: data,
          });
          continue;
        }
      } catch {
        // Not a JSON message: read it as plain text below.
      }
    }
    const m = PLAIN_MESSAGE.exec(line);
    if (m !== null) {
      flush();
      const sev = m[3] === "error" ? "error" : m[3] === "warning" ? "warning" : "information";
      current = { severity: sev, line: Number(m[1]), text: m[4] ?? "" };
      continue;
    }
    if (line.trim() === "") continue;
    if (current !== undefined) {
      current.text += `\n${line}`;
    } else {
      current = { severity: "information", text: line };
    }
  }
  flush();
  return { messages, json };
}

const AXIOMS_RE = new RegExp(
  `'?${LEAN4_THEOREM_NAME}'?\\s+(?:depends on axioms:\\s*\\[([^\\]]*)\\]|does not depend on any axioms)`,
);

/** The axiom list in a `#print axioms` message, or undefined when it is not one. */
export function readAxioms(text: string): string[] | undefined {
  const m = AXIOMS_RE.exec(text);
  if (m === null) return undefined;
  if (m[1] === undefined) return [];
  return m[1]
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

export type Lean4CheckerOptions = SandboxCheckerOptions & {
  /** Tokens the pre-scan refuses (the spec's `formal.forbid`; default sorry, axiom, native_decide). */
  readonly forbid?: readonly string[];
  /**
   * Module roots a proof may import. Default: `Init`, `Std`, plus `Mathlib`
   * when `image` overrides the curated image.
   */
  readonly imports?: readonly string[];
  /** The argv that elaborates stdin (default `lean --stdin --json`; e.g. `lake env lean --stdin --json` on a project image). */
  readonly argv?: readonly string[];
};

/** The `lean4` checker: Lean 4 in the given sandbox. */
export function createLean4Checker(opts: Lean4CheckerOptions): SandboxProofChecker {
  const image = opts.image ?? LEAN4_IMAGE_REF;
  const overridden = opts.image !== undefined && opts.image !== LEAN4_IMAGE_REF;
  const forbid = opts.forbid ?? LEAN4_DEFAULT_FORBID;
  const imports =
    opts.imports ??
    (overridden ? [...LEAN4_CORE_IMPORTS, ...LEAN4_OVERRIDE_IMPORTS] : LEAN4_CORE_IMPORTS);
  const argv = opts.argv ?? LEAN4_DEFAULT_ENTRYPOINT;
  const available = createAvailabilityProbe({
    id: LEAN4_CHECKER_ID,
    image,
    healthcheck: LEAN4_HEALTHCHECK_ARGV,
    opts,
  });
  return {
    id: LEAN4_CHECKER_ID,
    language: LEAN4_LANGUAGE,
    image,
    available,
    async check(input: CheckInput): Promise<CheckResult> {
      const started = performance.now();
      const done = (r: Omit<CheckResult, "checker" | "durationMs">): CheckResult => ({
        ...r,
        checker: LEAN4_CHECKER_ID,
        durationMs: Math.round(performance.now() - started),
      });
      const refuse = (reason: string, output = ""): CheckResult =>
        done({ ok: false, assumptions: [], axioms: [], output, reason });
      const refusal = noopRefusal(LEAN4_CHECKER_ID, opts.sandbox, opts.allowNoop === true);
      if (refusal !== undefined) return refuse(refusal);
      if (typeof input.statement !== "string" || typeof input.proof !== "string") {
        return refuse("the statement and the proof must be text");
      }
      let file: LeanFile;
      try {
        file = prescanLean(input.statement, input.proof, { forbid, imports });
      } catch (err) {
        return refuse(errorMessage(err));
      }
      const timeoutMs = budgetMs(input.timeoutMs, opts.timeoutMs, DEFAULT_SANDBOX_TIMEOUT_MS);
      let result: Awaited<ReturnType<SandboxCheckerOptions["sandbox"]["exec"]>>;
      try {
        result = await opts.sandbox.exec({
          image,
          argv,
          stdin: file.source,
          timeoutMs,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (err) {
        return refuse(`the sandbox could not run lean: ${clipLine(errorMessage(err), 300)}`);
      }
      const { messages, json } = parseLeanOutput(result.stdout);
      const rendered = messages
        .map((m) => `${m.line !== undefined ? `${m.line}: ` : ""}${m.severity}: ${m.text}`)
        .join("\n");
      const output = clipOutput(
        result.stderr.trim() !== "" ? `${rendered}\n[stderr]\n${result.stderr}` : rendered,
      );
      if (input.signal?.aborted === true) return refuse("the check was cancelled", output);
      if (result.timedOut === true)
        return refuse(`lean did not finish within ${timeoutMs} ms`, output);
      const error = messages.find((m) => m.severity === "error");
      if (error !== undefined) {
        return refuse(`lean rejected the proof: ${clipLine(error.text, 400)}`, output);
      }
      if (result.exitCode !== 0) {
        const why = clipLine(result.stderr || result.stdout, 300);
        return refuse(`lean exited ${result.exitCode}${why !== "" ? `: ${why}` : ""}`, output);
      }
      // The axioms report must be the one OUR `#print axioms` produced: with
      // JSON positions, the information message on its line; without them
      // (plain output cannot tell a continuation line from a new message),
      // the only report anywhere in the output.
      const reports = json
        ? messages
            .filter((m) => m.severity === "information" && m.line === file.printLine)
            .map((m) => readAxioms(m.text))
            .filter((a): a is string[] => a !== undefined)
        : [...result.stdout.matchAll(new RegExp(AXIOMS_RE.source, "g"))].map(
            (m) => readAxioms(m[0]) as string[],
          );
      if (reports.length !== 1) {
        return refuse(
          `lean did not report the axioms of ${LEAN4_THEOREM_NAME}${reports.length > 1 ? " exactly once" : ""}; the proof may not have elaborated`,
          output,
        );
      }
      const all = reports[0] as string[];
      if (all.includes("sorryAx")) {
        return refuse("the proof depends on `sorryAx` (a sorry), so it proves nothing", output);
      }
      const compiler = all.filter(trustsCompiler);
      if (compiler.length > 0 && forbid.includes("native_decide")) {
        return refuse(
          `the proof trusts the compiler (${compiler.join(", ")}, what native_decide and decide +native leave behind), which this harness forbids`,
          output,
        );
      }
      const axioms = all.filter((a) => !LEAN4_STANDARD_AXIOMS.includes(a));
      return done({ ok: true, assumptions: [], axioms, output });
    },
  };
}
