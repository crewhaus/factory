import { describe, expect, test } from "bun:test";
import {
  LEAN4_DEFAULT_ENTRYPOINT,
  LEAN4_HEALTHCHECK_ARGV,
  LEAN4_IMAGE_REF,
} from "@crewhaus/sandbox-image-lean4";
import {
  LEAN4_CORE_IMPORTS,
  LEAN4_DEFAULT_FORBID,
  LEAN4_LANGUAGE,
  LEAN4_LIMITS,
  type LeanPrescanOptions,
  createLean4Checker,
  lexLean,
  parseLeanOutput,
  prescanLean,
  readAxioms,
  stripLean,
} from "./lean4";
import { type FakeReply, fakeSandbox } from "./test-helpers";

const OPTS: LeanPrescanOptions = { forbid: LEAN4_DEFAULT_FORBID, imports: LEAN4_CORE_IMPORTS };

function refusal(statement: string, proof: string, opts: LeanPrescanOptions = OPTS): string {
  try {
    prescanLean(statement, proof, opts);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the pre-scan to refuse");
}

/** One `--json` message line, the shape `lean --json` prints. */
function msg(severity: string, line: number, data: string): string {
  return JSON.stringify({
    severity,
    pos: { line, column: 0 },
    endPos: { line, column: 10 },
    keepFullRange: false,
    fileName: "<stdin>",
    data,
    caption: "",
  });
}

describe("stripLean", () => {
  test("blanks comments and literals, keeps length and newlines", () => {
    const src = 'a -- sorry\nb /- x /- sorry -/ z -/ "sor\\"ry" \'s\' h\' r#"sorry"# c';
    const out = stripLean(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(2);
    expect(out).not.toContain("sorry");
    expect(out).toMatch(/^a +\nb +h' +c$/);
  });

  test("refuses what it cannot blank safely", () => {
    expect(() => stripLean("by simp /- open")).toThrow(/never closed/);
    expect(() => stripLean('"open')).toThrow(/string is never closed/);
    expect(() => stripLean('r#"open')).toThrow(/raw string is never closed/);
    expect(() => stripLean('by simp [s!"{sorry}"]')).toThrow(/interpolated strings/);
    expect(() => stripLean("have «x := 1")).toThrow(/`«` name is never closed/);
  });

  // `{…}` in a string is code in several Lean forms, with or without a `!`
  // right before the quote (adversarial review, W1-D).
  test("a string that could hold code is refused, however it is introduced", () => {
    for (const src of [
      'dbg_trace "{(by omega : 2 + 2 = 4)}"; by decide',
      'have _h : String := s! "{(by omega : 2 + 2 = 4)}"',
      's!\n  "plain"',
      'throwError "{x}"',
      '"{"',
    ]) {
      expect(() => stripLean(src)).toThrow(/interpolated strings|containing `\{`/);
    }
    // Plain strings, `!=` before a string, and a `!` inside a comment are fine.
    expect(() => stripLean('x != "a" ∧ "}" = "}"')).not.toThrow();
    expect(() => stripLean('-- wow!\n"abc"')).not.toThrow();
  });

  test("many strings strip in linear time", () => {
    // Looking back through the kept code for the `!` of `s!"…"` once per
    // string is quadratic here: billions of steps. Timed against a text of
    // the same size with no strings, the least of three runs, so a slow
    // machine slows both (an absolute bound is a flake on a loaded runner).
    const fastest = (run: () => unknown): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        run();
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const many = '"a" '.repeat(50_000);
    expect(stripLean(many).length).toBe(many.length);
    const base = fastest(() => stripLean("aaa ".repeat(50_000)));
    expect(fastest(() => stripLean(many))).toBeLessThan(base * 20 + 100);
  }, 20_000);

  test("a «…» name is a name: a quote or comment opener inside it hides nothing", () => {
    const out = stripLean('have «"» := 1\n  set_option x true in\n  have «"» := 2');
    expect(out).toContain("set_option");
    expect(stripLean("«/-» sorry")).toContain("sorry");
  });

  test("the shape view masks «…» names, so a bracket inside one is not a bracket", () => {
    const src = "a «)» ')' \"x\" -- c\nb";
    const lexed = lexLean(src);
    expect(lexed.code).toBe("a «)»             \nb");
    expect(lexed.shape).toBe("a «x»             \nb");
    expect(lexed.shape.length).toBe(src.length);
  });

  test("blanked astral characters keep their UTF-16 width", () => {
    const src = "𝒜' \"𝒜\" '𝒜' x";
    expect(stripLean(src)).toBe(`𝒜'${" ".repeat(src.length - 4)}x`);
  });

  test("character literals Lean reads: \\uHHHH escapes and a literal line break", () => {
    expect(stripLean("'\\u0029' = ')'")).toBe(`${" ".repeat(8)} = ${" ".repeat(3)}`);
    expect(stripLean("('\n')")).toBe("( \n )");
    // `''` is not a character literal (Mathlib's `Set.image` token), nor is a
    // `'` that ends a token like `∑'` or `⁻¹'`.
    expect(stripLean("f '' s")).toBe("f '' s");
    expect(stripLean("∑' i, f i")).toBe("∑' i, f i");
  });

  // Whether `'` (or `r"`) opens a literal depends on what the token before it
  // was: after a standalone `!`, a numeral or a `«…»` name Lean opens one,
  // after an identifier character it does not. Guessing wrong hid code from the
  // scan (adversarial review, W1-D), so those spots are refused, not guessed.
  test("a literal right after a non-identifier word character is refused, not guessed", () => {
    for (const src of [
      "by first | exact (!'\"') | omega -- \"",
      'by first | exact (!r"\\") | omega -- "',
      "0')'",
      "!')'",
      "«x»'\"'",
      '1e5r"\\" omega -- "',
      "c='a'",
      'x.r"a"',
    ]) {
      expect(() => stripLean(src)).toThrow(/is ambiguous; put a space before it/);
    }
    // After a space, an opening bracket, `,` or `;` a literal is plain.
    expect(() => stripLean("#['a', 'b'] ++ ['c']; (r\"x\") ++ r#\"y\"# ⟨'d'⟩")).not.toThrow();
    // Inside an identifier `'` and `r` are name characters.
    expect(stripLean("h₁'a' xr\"s\" ℕ')'")).toBe("h₁'a' xr    ℕ')'");
  });

  test("a `'` that must open a character literal but does not is refused", () => {
    expect(() => stripLean("(' x)")).toThrow(/starts a character literal, and what follows/);
  });
});

describe("prescanLean — refusals", () => {
  test("a forbidden token in code is refused; in a comment or a string it is not code", () => {
    expect(refusal("True", "by exact sorry")).toBe(
      "the proof uses `sorry`, which this harness forbids",
    );
    expect(refusal("True", "by native_decide")).toMatch(/uses `native_decide`/);
    expect(refusal("sorry = sorry", "rfl")).toMatch(/^the statement uses `sorry`/);
    expect(() =>
      prescanLean("True", "-- no sorry here\nby trivial /- sorry -/", OPTS),
    ).not.toThrow();
    expect(() => prescanLean('"sorry" = "sorry"', "rfl", OPTS)).not.toThrow();
  });

  test('command words hidden behind a «"» name are still found', () => {
    expect(
      refusal(
        "True",
        'by\n  have «"» := 1\n  set_option debug.skipKernelTC true in\n  have «"» := 2\n  trivial',
      ),
    ).toMatch(/uses `set_option`/);
    expect(
      refusal("True", 'by\n  have «"» := 1\n  omega\n  have «"» := 2', {
        forbid: ["omega"],
        imports: LEAN4_CORE_IMPORTS,
      }),
    ).toMatch(/uses `omega`/);
  });

  test("custom forbid tokens inside an interpolated string are not smuggled past the scan", () => {
    const opts = { forbid: [...LEAN4_DEFAULT_FORBID, "omega"], imports: LEAN4_CORE_IMPORTS };
    expect(refusal("2 + 2 = 4", "by omega", opts)).toMatch(/uses `omega`/);
    expect(refusal("2 + 2 = 4", 'dbg_trace "{(by omega : 2 + 2 = 4)}"; by decide', opts)).toMatch(
      /containing `\{`/,
    );
    expect(
      refusal(
        "2 + 2 = 4",
        'by\n  have _h : String := s! "{(by omega : 2 + 2 = 4)}"\n  decide',
        opts,
      ),
    ).toMatch(/interpolated strings|containing `\{`/);
  });

  test("whole words only", () => {
    // `sorry_free_lemma` and `h'sorry` are other names; Lean decides whether they exist.
    expect(() => prescanLean("True", "by exact sorry_free_lemma", OPTS)).not.toThrow();
    expect(() => prescanLean("True", "by exact my_native_decide_lemma", OPTS)).not.toThrow();
    // A dot is not part of a word, so a qualified `sorry` is refused (the conservative side).
    expect(refusal("True", "by exact Foo.sorry")).toMatch(/uses `sorry`/);
    expect(refusal("True", "by exact «sorry»")).toMatch(/uses `sorry`/);
  });

  test("the forbid list is the harness's", () => {
    expect(() =>
      prescanLean("True", "by native_decide", { forbid: ["sorry"], imports: LEAN4_CORE_IMPORTS }),
    ).not.toThrow();
    expect(refusal("True", "by decide", { forbid: ["decide"], imports: [] })).toMatch(
      /uses `decide`/,
    );
  });

  test("anything that would start or change a command is refused", () => {
    for (const [stmt, proof, word] of [
      ["True\nexample : Nat", "5", "example"],
      ["True", "by trivial\ntheorem other : 1 = 1 := rfl", "theorem"],
      ["True", "by trivial\ndef x := 1", "def"],
      ["True", 'by trivial\nmacro "x" : term => `(1)', "macro"],
      ["True", 'by trivial\nelab "x" : term => pure default', "elab"],
      ["True", "by\n  set_option maxRecDepth 1000 in trivial", "set_option"],
      ["True", "by trivial\nattribute [simp] Nat.add_zero", "attribute"],
      ["True", "by trivial\nend", "end"],
      ["True", "by run_tac pure ()", "run_tac"],
      ["True", "unsafe (trivial)", "unsafe"],
    ] as const) {
      expect(refusal(stmt, proof)).toMatch(
        new RegExp(`uses \`${word}\`, which would start or change a Lean command`),
      );
    }
  });

  test("# commands and attributes are refused; #[…] array literals are not", () => {
    expect(refusal("True", "by\n  #eval 1\n  trivial")).toMatch(/`#` command \(`#eval`\)/);
    expect(refusal("True", "by trivial\n#print axioms crewhaus_claim")).toMatch(/`#print`/);
    expect(refusal("True", "by trivial\n#exit")).toMatch(/`#exit`/);
    expect(refusal("True", "@[simp] theorem x : True := trivial")).toMatch(/`theorem`|attribute/);
    expect(refusal("True", "by have h : True := by trivial; @[simp] exact h")).toMatch(/attribute/);
    expect(() => prescanLean("#[1, 2].size = 2", "by decide", OPTS)).not.toThrow();
  });

  test("a statement with `:=` is refused: it would end the theorem's type early", () => {
    expect(refusal("False := by\n  have h : True", "trivial\n  exact absurd h (by simp)")).toMatch(
      /contains `:=`, which would end the theorem's type early/,
    );
    expect(() => prescanLean("True -- not a := here", "trivial", OPTS)).not.toThrow();
  });

  // A statement left open (`… id (a`) could be finished by the proof across
  // the adapter's `:=` line, so the theorem Lean checks would not be the
  // statement shown (adversarial review, W1-D).
  test("a statement's brackets must balance", () => {
    for (const stmt of [
      "1 + 1 = 3 ∨ id (a",
      "(1 = 1",
      "1 = 1)",
      "⟨a, b",
      "(1 = 1]",
      "∀ ⦃x : Nat, x = x",
    ]) {
      expect(refusal(stmt, "True) := Or.inr trivial")).toMatch(
        /the statement's brackets do not balance/,
      );
    }
    for (const stmt of [
      "#[1, 2].size = 2",
      "∀ ⦃x : Nat⦄, x = x",
      "(fun ⟨a, b⟩ => a + b) (1, 2) = 3",
    ]) {
      expect(() => prescanLean(stmt, "by decide", OPTS)).not.toThrow();
    }
  });

  // `«)»` is an identifier to Lean, so counting its `)` let a statement leave
  // a real bracket open: the adapter's `)` closed only the inner group and its
  // `:=` became a binder default, and the type Lean checked was not the
  // statement shown (adversarial review, W1-D). The same phantom closer came
  // from a char literal the scan did not see (`0')'`, `!')'`).
  test("a bracket inside a «…» name or an unseen char literal does not balance the statement", () => {
    const proof = "fun _ _ => 0), True) := Or.inr (fun _ => trivial)";
    expect(refusal("1 + 1 = 3 ∨ ∀ (x : (∀ «)» «)» : Nat, Nat", proof)).toMatch(
      /the statement's brackets do not balance \(at `\(`\)/,
    );
    expect(refusal("1 + 1 = 3 ∨ id (a «)»", "True) := Or.inr trivial")).toMatch(
      /brackets do not balance/,
    );
    for (const stmt of [
      "1 + 1 = 3 ∨ ∀ (x : (∀ 0')' : Nat, Nat",
      "1 + 1 = 3 ∨ ∀ (x : (∀ !')' : Nat, Nat",
    ]) {
      expect(refusal(stmt, proof)).toMatch(/is ambiguous; put a space before it/);
    }
    // A name may hold any bracket, and `:=`, without unbalancing anything.
    expect(() => prescanLean("«)» = «(» ∧ «:=» = «:=»", "rfl", OPTS)).not.toThrow();
  });

  test("a literal after `!` cannot hide a forbidden tactic or a command", () => {
    const opts = { forbid: [...LEAN4_DEFAULT_FORBID, "omega"], imports: LEAN4_CORE_IMPORTS };
    for (const proof of [
      "by first | exact (!'\"') | omega -- \"",
      'by first | exact (!r"\\") | omega -- "',
      "by\n  first | exact (!'\"') | skip\n  set_option maxRecDepth 100 in omega\n  -- \"",
    ]) {
      expect(refusal("2 + 2 = 4", proof, opts)).toMatch(/is ambiguous; put a space before it/);
    }
    // With a space the literal is read as Lean reads it, and the tactic is found.
    expect(refusal("2 + 2 = 4", "by first | exact (! '\"') | omega -- \"", opts)).toMatch(
      /uses `omega`/,
    );
  });

  test("words split where Lean's lexer splits them", () => {
    const opts = { forbid: [...LEAN4_DEFAULT_FORBID, "omega"], imports: LEAN4_CORE_IMPORTS };
    // A numeral, a lone `!`, `λ` (a token, though a letter to Unicode), `²`
    // and a «…» name all end before the word: Lean reads `omega` on its own.
    for (const proof of [
      "by iterate 2omega",
      "by iterate 1e5omega",
      "by exact !omega",
      "by exact (λomega => 1) 2",
      "by exact x²omega",
      "by exact «x»omega",
    ]) {
      expect(refusal("2 + 2 = 4", proof, opts)).toMatch(/uses `omega`/);
    }
    // Inside a Lean identifier it is part of a longer name.
    for (const proof of [
      "by exact xomega",
      "by exact h₁omega",
      "by exact !xomega",
      "by exact omega2",
      "by exact omega'",
      "by exact h'omega",
    ]) {
      expect(() => prescanLean("2 + 2 = 4", proof, opts)).not.toThrow();
    }
  });

  test("an unfinished statement stays inside the adapter's parentheses", () => {
    // `let x` is not something a pre-scan can complete-check; the parentheses
    // make it a parse error for Lean instead of `let x := True; x`.
    const f = prescanLean("1 + 1 = 3 ∨ let x", "True\nx := Or.inr trivial", OPTS);
    expect(f.source).toContain(
      "theorem crewhaus_claim : (\n    1 + 1 = 3 ∨ let x\n    )\n    :=\n  True\n  x := Or.inr trivial\n",
    );
  });

  test("a comment on an import line cannot hide the first proof line from the scan", () => {
    // The header is rewritten from module names, so the `/-` vanished from the
    // file while the scan still blanked the next line (adversarial review, W1-D).
    expect(
      refusal("True", 'import Std /-\n(fun (_ : String) => (sorry : True)) "-/" --" trivial'),
    ).toBe("an `import` line may hold only module names (no comments or strings)");
    expect(refusal("True", 'import Std /-\ntrivial set_option x true "-/" --" y')).toMatch(
      /may hold only module names/,
    );
    expect(refusal("True", "/- x\n-/ import Std\nby trivial")).toMatch(
      /may hold only module names/,
    );
    expect(refusal("True", "import Std -- the standard library\nby trivial")).toMatch(
      /may hold only module names/,
    );
  });

  test("the scan reads the proof exactly as the file holds it", () => {
    // A leading comment line is dropped from the file; its closer is then
    // plain text, and what follows it is code.
    expect(refusal("True", "/-\n-/ by exact sorry")).toMatch(/uses `sorry`/);
    // A comment wholly before the proof is dropped and hides nothing.
    const f = prescanLean("True", "/- notes\n sorry -/\nby trivial", OPTS);
    expect(f.source).toContain("    :=\n  by trivial\n");
    expect(f.source).not.toContain("notes");
  });

  test("open … in stays allowed (it is term syntax)", () => {
    expect(() => prescanLean("True", "open Nat in trivial", OPTS)).not.toThrow();
  });

  test("imports: leading lines only, allowlisted roots only", () => {
    const f = prescanLean(
      "True",
      "import Std.Data.HashMap\n-- a comment\nimport Std Init.Core\n\nby trivial",
      OPTS,
    );
    expect(f.imports).toEqual(["Std.Data.HashMap", "Std", "Init.Core"]);
    expect(
      f.source.startsWith("import Std.Data.HashMap\nimport Std\nimport Init.Core\ntheorem"),
    ).toBe(true);
    expect(refusal("True", "import Mathlib\nby trivial")).toBe(
      "`import Mathlib` is not allowed (allowed: Init, Std and their submodules)",
    );
    expect(refusal("True", "import Lean\nby trivial")).toMatch(/`import Lean` is not allowed/);
    expect(refusal("True", "import StdX\nby trivial")).toMatch(/`import StdX` is not allowed/);
    expect(refusal("True", "by trivial\nimport Std")).toMatch(/must come first/);
    expect(refusal("True", "import\nby trivial")).toMatch(/names no module/);
    expect(refusal("True", "import Std.$x\nby trivial")).toMatch(/not a module name/);
    expect(refusal("True", "import Std")).toMatch(/imports but no proof/);
    expect(refusal("import Std", "by trivial")).toMatch(/must come first/);
  });

  test("empty and oversized input", () => {
    expect(refusal("", "rfl")).toBe("the statement is empty");
    expect(refusal("True", "  ")).toBe("the proof is empty");
    expect(refusal("x".repeat(LEAN4_LIMITS.maxStatementChars + 1), "rfl")).toMatch(
      /the cap is 20000/,
    );
    expect(refusal("True", "x".repeat(LEAN4_LIMITS.maxProofChars + 1))).toMatch(
      /the cap is 200000/,
    );
  });
});

describe("prescanLean — the file", () => {
  test("statement and proof inside one theorem, then the adapter's own #print axioms", () => {
    const f = prescanLean(
      "∀ n : Nat,\n  n + 0 = n -- by simp",
      "\nby\n  intro n\n  simp\n\n",
      OPTS,
    );
    expect(f.source).toBe(
      [
        "theorem crewhaus_claim : (",
        "    ∀ n : Nat,",
        "      n + 0 = n -- by simp",
        "    )",
        "    :=",
        "  by",
        "    intro n",
        "    simp",
        "#print axioms crewhaus_claim",
        "",
      ].join("\n"),
    );
    expect(f.printLine).toBe(9);
    expect(f.imports).toEqual([]);
  });

  test("a term proof", () => {
    const f = prescanLean("2 + 2 = 4", "rfl", OPTS);
    expect(f.source).toBe(
      "theorem crewhaus_claim : (\n    2 + 2 = 4\n    )\n    :=\n  rfl\n#print axioms crewhaus_claim\n",
    );
    expect(f.printLine).toBe(6);
  });
});

describe("parseLeanOutput and readAxioms", () => {
  test("JSON messages carry severity, line and text", () => {
    const out = `${msg("warning", 2, "declaration uses 'sorry'")}\n${msg("information", 5, "'crewhaus_claim' depends on axioms: [sorryAx]")}\n`;
    expect(parseLeanOutput(out)).toEqual({
      json: true,
      messages: [
        { severity: "warning", line: 2, text: "declaration uses 'sorry'" },
        { severity: "information", line: 5, text: "'crewhaus_claim' depends on axioms: [sorryAx]" },
      ],
    });
  });

  test("plain output: positioned errors, bare info text, continuation lines", () => {
    const out =
      "<stdin>:4:2: error: type mismatch\n  h\nhas type\n  True\n'crewhaus_claim' depends on axioms: [propext]\n";
    const parsed = parseLeanOutput(out);
    expect(parsed.json).toBe(false);
    expect(parsed.messages[0]).toEqual({
      severity: "error",
      line: 4,
      text: "type mismatch\n  h\nhas type\n  True\n'crewhaus_claim' depends on axioms: [propext]",
    });
  });

  test("readAxioms reads the list, the empty case, and nothing else", () => {
    expect(
      readAxioms("'crewhaus_claim' depends on axioms: [propext, Classical.choice, Quot.sound]"),
    ).toEqual(["propext", "Classical.choice", "Quot.sound"]);
    expect(readAxioms("'crewhaus_claim' depends on axioms: [propext,\n Classical.choice]")).toEqual(
      ["propext", "Classical.choice"],
    );
    expect(readAxioms("'crewhaus_claim' does not depend on any axioms")).toEqual([]);
    expect(readAxioms("'other' does not depend on any axioms")).toBeUndefined();
    expect(readAxioms("hello")).toBeUndefined();
  });
});

describe("createLean4Checker — with a scripted sandbox", () => {
  const STMT = "∀ n : Nat, n + 0 = n";
  const PROOF = "by intro n; simp";
  const PRINT_LINE = prescanLean(STMT, PROOF, OPTS).printLine;
  const axiomsLine = (list: string | null): FakeReply => ({
    stdout: `${msg(
      "information",
      PRINT_LINE,
      list === null
        ? "'crewhaus_claim' does not depend on any axioms"
        : `'crewhaus_claim' depends on axioms: [${list}]`,
    )}\n`,
  });
  const run = async (
    reply: FakeReply,
    extra: Partial<Parameters<typeof createLean4Checker>[0]> = {},
  ) => {
    const sandbox = fakeSandbox([reply]);
    const checker = createLean4Checker({ sandbox, ...extra });
    const result = await checker.check({
      claim: "adding zero changes nothing",
      statement: STMT,
      proof: PROOF,
    });
    return { result, sandbox, checker };
  };

  test("runs `lean --stdin --json` on the curated image with the file on stdin", async () => {
    const { result, sandbox, checker } = await run(axiomsLine("propext"));
    expect(result).toMatchObject({ ok: true, checker: "lean4", assumptions: [], axioms: [] });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]).toMatchObject({
      image: LEAN4_IMAGE_REF,
      argv: [...LEAN4_DEFAULT_ENTRYPOINT],
      stdin: prescanLean(STMT, PROOF, OPTS).source,
      timeoutMs: 30_000,
    });
    expect(LEAN4_DEFAULT_ENTRYPOINT).toEqual(["lean", "--stdin", "--json"]);
    expect(checker.image).toBe(LEAN4_IMAGE_REF);
  });

  test("the standard axioms are not recorded; no axioms at all is fine", async () => {
    expect((await run(axiomsLine("propext, Classical.choice, Quot.sound"))).result.axioms).toEqual(
      [],
    );
    expect((await run(axiomsLine(null))).result.ok).toBe(true);
  });

  test("axioms beyond the standard three are recorded and the proof stays ok", async () => {
    const { result } = await run(axiomsLine("propext, Classical.choice, Mathlib.SomeAxiom"));
    expect(result.ok).toBe(true);
    expect(result.axioms).toEqual(["Mathlib.SomeAxiom"]);
  });

  test("sorryAx is always a rejection", async () => {
    const { result } = await run(axiomsLine("propext, sorryAx"), { forbid: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/depends on `sorryAx`/);
  });

  test("the native_decide axioms are refused while native_decide is forbidden, recorded otherwise", async () => {
    const forbidden = await run(axiomsLine("propext, Lean.ofReduceBool"));
    expect(forbidden.result.ok).toBe(false);
    expect(forbidden.result.reason).toMatch(/trusts the compiler \(Lean.ofReduceBool/);
    const allowed = await run(axiomsLine("propext, Lean.ofReduceBool"), {
      forbid: ["sorry", "axiom"],
    });
    expect(allowed.result.ok).toBe(true);
    expect(allowed.result.axioms).toEqual(["Lean.ofReduceBool"]);
  });

  test("an error message rejects with Lean's text", async () => {
    const { result } = await run({
      exitCode: 1,
      stdout: `${msg("error", 4, "unsolved goals\nn : Nat\n⊢ n + 0 = n")}\n${msg("information", PRINT_LINE, "'crewhaus_claim' depends on axioms: [sorryAx]")}\n`,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("lean rejected the proof: unsolved goals n : Nat ⊢ n + 0 = n");
    expect(result.output).toMatch(/^4: error: unsolved goals/);
  });

  test("a report that is not on the adapter's #print line does not count", async () => {
    const { result } = await run({
      stdout: `${msg("information", 2, "'crewhaus_claim' does not depend on any axioms")}\n`,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not report the axioms of crewhaus_claim/);
  });

  test("plain (non-JSON) output still parses, from the only report", async () => {
    const ok = await run({ stdout: "'crewhaus_claim' depends on axioms: [propext]\n" });
    expect(ok.result.ok).toBe(true);
    const twice = await run({
      stdout:
        "'crewhaus_claim' does not depend on any axioms\n'crewhaus_claim' does not depend on any axioms\n",
    });
    expect(twice.result.reason).toMatch(/exactly once/);
  });

  test("a NaN budget falls back to the default", async () => {
    const sandbox = fakeSandbox([axiomsLine(null)]);
    await createLean4Checker({ sandbox }).check({
      claim: "c",
      statement: STMT,
      proof: PROOF,
      timeoutMs: Number.NaN,
    });
    expect(sandbox.calls[0]?.timeoutMs).toBe(30_000);
  });

  test("exit codes, timeouts and sandbox errors reject", async () => {
    expect((await run({ exitCode: 1, stderr: "lean: out of memory" })).result.reason).toBe(
      "lean exited 1: lean: out of memory",
    );
    expect((await run({ timedOut: true, exitCode: 137 })).result.reason).toBe(
      "lean did not finish within 30000 ms",
    );
    expect((await run({ throws: new Error("image not on the allowlist") })).result.reason).toBe(
      "the sandbox could not run lean: image not on the allowlist",
    );
  });

  test("a refused proof never reaches the sandbox", async () => {
    const sandbox = fakeSandbox([]);
    const r = await createLean4Checker({ sandbox }).check({
      claim: "c",
      statement: "True",
      proof: "sorry",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/forbids/);
    expect(sandbox.calls).toHaveLength(0);
  });

  test("an overridden image also accepts Mathlib imports; argv and imports are configurable", async () => {
    const proof = "import Mathlib.Tactic\nby norm_num";
    const sandbox = fakeSandbox(() => ({
      stdout: "'crewhaus_claim' depends on axioms: [propext]\n",
    }));
    const curated = await createLean4Checker({ sandbox }).check({
      claim: "c",
      statement: "2 + 2 = 4",
      proof,
    });
    expect(curated.reason).toMatch(/`import Mathlib.Tactic` is not allowed/);
    const mathlib = createLean4Checker({
      sandbox,
      image: "ghcr.io/acme/lean-mathlib:2026.10",
      argv: ["lake", "env", "lean", "--stdin", "--json"],
    });
    expect((await mathlib.check({ claim: "c", statement: "2 + 2 = 4", proof })).ok).toBe(true);
    expect(sandbox.calls[0]).toMatchObject({
      image: "ghcr.io/acme/lean-mathlib:2026.10",
      argv: ["lake", "env", "lean", "--stdin", "--json"],
    });
    expect(
      sandbox.calls[0]?.stdin?.startsWith("import Mathlib.Tactic\ntheorem crewhaus_claim :"),
    ).toBe(true);
    const explicit = await createLean4Checker({ sandbox, imports: ["Init"] }).check({
      claim: "c",
      statement: "True",
      proof: "import Std\nby trivial",
    });
    expect(explicit.reason).toMatch(/allowed: Init and their submodules/);
  });

  test("noop backend: unavailable and refused unless trusted code opts in", async () => {
    const sandbox = fakeSandbox([{ exitCode: 0 }], "noop");
    const checker = createLean4Checker({ sandbox });
    expect((await checker.available()).reason).toMatch(
      /lean4 checker runs proofs only in a container sandbox/,
    );
    expect((await checker.check({ claim: "c", statement: "True", proof: "trivial" })).ok).toBe(
      false,
    );
    expect(sandbox.calls).toHaveLength(0);
    expect((await createLean4Checker({ sandbox, allowNoop: true }).available()).ok).toBe(true);
    expect(sandbox.calls[0]).toMatchObject({ argv: [...LEAN4_HEALTHCHECK_ARGV] });
  });

  test("the language paragraph", () => {
    expect(LEAN4_LANGUAGE).toMatch(/theorem crewhaus_claim/);
    expect(LEAN4_LANGUAGE).toMatch(/sorry, axiom and native_decide/);
    expect(LEAN4_LANGUAGE).toMatch(/Example:/);
  });
});

/**
 * What `lean --stdin --json` prints in the curated image (Lean 4.34.1),
 * captured verbatim for the files the adapter writes — so the parser and the
 * verdicts are held to the real toolchain without Docker. The live run is
 * sandbox.live.test.ts.
 */
describe("createLean4Checker — on what Lean 4.34.1 actually prints", () => {
  const line = (severity: string, row: number, col: number, kind: string, data: string): string =>
    JSON.stringify({
      caption: "",
      data,
      endPos: { column: 6, line: row },
      fileName: "<stdin>",
      isSilent: false,
      keepFullRange: false,
      kind,
      pos: { column: col, line: row },
      severity,
    });
  const axioms = (list: string) =>
    line("information", 6, 0, "[anonymous]", `'crewhaus_claim' depends on axioms: [${list}]`);
  const lean434 = {
    simp: `${axioms("propext")}\n`,
    classical: `${axioms("propext, Classical.choice, Quot.sound")}\n`,
    sorry: `${line("warning", 1, 8, "hasSorry", "declaration uses `sorry`")}\n${axioms("sorryAx")}\n`,
    decideNative: `${axioms("crewhaus_claim._native.decide.ax_1_1")}\n`,
    nativeDecide: `${axioms("crewhaus_claim._native.native_decide.ax_1_1")}\n`,
    falseDecide: `${line("error", 5, 5, "[anonymous]", "Tactic `decide` proved that the proposition\n  2 + 2 = 5\nis false")}\n${axioms("sorryAx")}\n`,
    unsolved: `${line("error", 5, 2, "Tactic.unsolvedGoals", "unsolved goals\nn : Nat\n⊢ n * 1 = n + 0 * n")}\n${axioms("sorryAx")}\n`,
  };
  const check = async (
    statement: string,
    proof: string,
    reply: FakeReply,
    extra: Partial<Parameters<typeof createLean4Checker>[0]> = {},
  ) => {
    // Every captured file is the one-line statement + one-line proof shape,
    // so `#print axioms` sits on line 6, where the captures put it.
    expect(
      prescanLean(statement, proof, { forbid: [], imports: LEAN4_CORE_IMPORTS }).printLine,
    ).toBe(6);
    return createLean4Checker({ sandbox: fakeSandbox([reply]), ...extra }).check({
      claim: "c",
      statement,
      proof,
    });
  };

  test("a simp proof: ok, propext not recorded", async () => {
    const r = await check("∀ n : Nat, n + 0 = n", "by intro n; simp", { stdout: lean434.simp });
    expect(r).toMatchObject({ ok: true, axioms: [], assumptions: [] });
    expect(r.output).toBe("6: information: 'crewhaus_claim' depends on axioms: [propext]");
  });

  test("a classical proof: Classical.choice is captured and, being standard, not recorded", async () => {
    const r = await check("∀ p : Prop, p ∨ ¬p", "fun p => Classical.em p", {
      stdout: lean434.classical,
    });
    expect(r).toMatchObject({ ok: true, axioms: [] });
    expect(r.output).toContain("Classical.choice");
  });

  test("sorry past an emptied forbid list: the warning is not the verdict, sorryAx is", async () => {
    const r = await check("2 + 2 = 5", "by sorry", { stdout: lean434.sorry }, { forbid: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("the proof depends on `sorryAx` (a sorry), so it proves nothing");
  });

  test("a false or unfinished proof: rejected with Lean's error, exit 1", async () => {
    const no = await check("2 + 2 = 5", "by decide", { exitCode: 1, stdout: lean434.falseDecide });
    expect(no.reason).toBe(
      "lean rejected the proof: Tactic `decide` proved that the proposition 2 + 2 = 5 is false",
    );
    const open = await check("∀ n : Nat, n * 1 = n + 0 * n", "by intro n", {
      exitCode: 1,
      stdout: lean434.unsolved,
    });
    expect(open.reason).toBe("lean rejected the proof: unsolved goals n : Nat ⊢ n * 1 = n + 0 * n");
  });

  // Lean 4.34 names the compiler-trust axiom `<decl>._native.<tactic>.ax_i_j`;
  // before the adapter knew that, `decide +native` (which never spells
  // `native_decide`) passed a harness that forbids native_decide.
  test("`decide +native` is refused while native_decide is forbidden", async () => {
    const r = await check("(10 : Nat) < 100", "by decide +native", {
      stdout: lean434.decideNative,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(
      "the proof trusts the compiler (crewhaus_claim._native.decide.ax_1_1, what native_decide and decide +native leave behind), which this harness forbids",
    );
  });

  test("with native_decide allowed, its auxiliary axiom is recorded and the proof stays ok", async () => {
    for (const [proof, stdout, axiom] of [
      ["by native_decide", lean434.nativeDecide, "crewhaus_claim._native.native_decide.ax_1_1"],
      ["by decide +native", lean434.decideNative, "crewhaus_claim._native.decide.ax_1_1"],
    ] as const) {
      const r = await check("(10 : Nat) < 100", proof, { stdout }, { forbid: ["sorry", "axiom"] });
      expect(r).toMatchObject({ ok: true, axioms: [axiom] });
    }
  });

  test("a long axiom list wraps over lines in Lean's message and still reads whole", async () => {
    const r = await check(
      "(10 : Nat) < 100 ∧ ∀ p : Prop, p ∨ ¬p",
      "⟨by native_decide, fun p => Classical.em p⟩",
      {
        stdout: `${axioms("propext,\n Classical.choice,\n Quot.sound,\n crewhaus_claim._native.native_decide.ax_1_1,\n crewhaus_claim._native.native_decide.ax_1_2")}\n`,
      },
      { forbid: ["sorry", "axiom"] },
    );
    expect(r).toMatchObject({
      ok: true,
      axioms: [
        "crewhaus_claim._native.native_decide.ax_1_1",
        "crewhaus_claim._native.native_decide.ax_1_2",
      ],
    });
  });

  test("only a `_native` name component reads as compiler trust, not a name that mentions native", async () => {
    const r = await check("2 + 2 = 4", "by decide", {
      stdout: `${axioms("propext, Mathlib.native_ish, Foo.nativeBar, _nativeX.y")}\n`,
    });
    expect(r).toMatchObject({
      ok: true,
      axioms: ["Mathlib.native_ish", "Foo.nativeBar", "_nativeX.y"],
    });
    const trusted = await check("2 + 2 = 4", "by decide", {
      stdout: `${axioms("Foo._native.bar")}\n`,
    });
    expect(trusted.ok).toBe(false);
    expect(trusted.reason).toMatch(/^the proof trusts the compiler \(Foo\._native\.bar,/);
  });
});
