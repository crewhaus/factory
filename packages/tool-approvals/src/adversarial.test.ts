/**
 * The security property, on its own, because it is the reason this package
 * needed care: A SUGGESTED RULE MUST MEAN ONLY WHAT IT SAYS.
 *
 * Every rule `PermissionsSuggest` proposes is assembled from values the harness
 * OBSERVED — the tool a human was asked about and the argument they were asked
 * about it with. The permission matcher reads `*` and `?` in a pattern as
 * wildcards, so a value spliced in raw stops meaning itself, and a tool built to
 * summarise what a human already approved becomes a tool that quietly widens
 * what they approved.
 *
 * These tests do not read the implementation. They run the REAL matcher over
 * the emitted pattern and ask it what the rule actually covers: the approved
 * call, and nothing adjacent to it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  OPERATIVE_ARG_FIELDS,
  compilePattern,
  escapeGlobLiteral,
  matchesPattern,
} from "@crewhaus/tool-permission-matcher";
import {
  approval,
  approvalId,
  askSession,
  permissionAsk,
  toolUse,
  writeApprovals,
  writeSession,
} from "./fixtures";
import { approvalStatus, permissionsSuggest, verifyRule } from "./index";

const originalCwd = process.cwd();
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-approvals-adv-"));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

type SuggestResult = {
  suggestions: Array<{
    type: string;
    pattern: string;
    toolName: string;
    argConstrained: boolean;
    evidence: string[];
    verified: string[];
  }>;
  rejected: Array<{ toolName: string; pattern: string; reason: string }>;
  diff: { additions: Array<{ type: string; pattern: string }> } | null;
};

async function suggest(input: unknown = {}): Promise<SuggestResult> {
  return JSON.parse(await permissionsSuggest.execute(input)) as SuggestResult;
}

/**
 * Does the emitted rule cover this call? Asked of the REAL matcher, the same
 * code path `permission-engine` runs, so the answer is the runtime's answer and
 * not this package's opinion of it.
 */
function ruleCovers(pattern: string, toolName: string, value: string): boolean {
  const field = OPERATIVE_ARG_FIELDS[toolName]?.[0];
  const input: unknown = field === undefined ? value : { [field]: value };
  return matchesPattern(compilePattern(pattern), toolName, input);
}

/** A newline built rather than written, so no editor, diff or transport can
 *  quietly normalise the one character this test is about. */
const NEWLINE = String.fromCharCode(10);

/**
 * The path the task names: a `*`, a `?`, a `[`, a `{` and a newline, in one
 * value a human approved once.
 */
const HOSTILE_PATH = `notes/a*b?c[d]{e}${NEWLINE}secret.md`;

// ---------------------------------------------------------------------------
// the headline property
// ---------------------------------------------------------------------------

describe("a rule built from a value full of glob metacharacters", () => {
  async function ruleForHostilePath(): Promise<string> {
    askSession(tmp, "sess_1", {
      toolName: "Read",
      input: { file_path: HOSTILE_PATH },
      approved: 3,
    });
    const out = await suggest();
    expect(out.rejected).toEqual([]);
    expect(out.suggestions).toHaveLength(1);
    const suggestion = out.suggestions[0] as SuggestResult["suggestions"][number];
    expect(suggestion.type).toBe("alwaysAllow");
    expect(suggestion.argConstrained).toBe(true);
    // It reached the proposed additions — a rule that was silently dropped
    // would pass every "does not widen" check for the wrong reason.
    expect(out.diff?.additions).toEqual([{ type: "alwaysAllow", pattern: suggestion.pattern }]);
    return suggestion.pattern;
  }

  test("the emitted pattern embeds the value ESCAPED, not raw", async () => {
    const pattern = await ruleForHostilePath();
    expect(pattern).toBe(`Read(${escapeGlobLiteral(HOSTILE_PATH)})`);
    // The two characters the matcher treats as wildcards are backslash-escaped…
    expect(pattern).toContain("a\\*b");
    expect(pattern).toContain("b\\?c");
    // …and the raw, widening spelling is nowhere in it.
    expect(pattern).not.toContain("a*b");
    expect(pattern).not.toContain("b?c");
  });

  test("the rule matches the approved path", async () => {
    expect(ruleCovers(await ruleForHostilePath(), "Read", HOSTILE_PATH)).toBe(true);
  });

  test("the rule matches NOTHING else — every single-character variation is refused", async () => {
    const pattern = await ruleForHostilePath();
    // Replace each position in turn. If any of these matches, some character in
    // the observed value was live rather than literal, which is exactly the
    // silent widening this package exists to prevent.
    const escaped: string[] = [];
    for (let i = 0; i < HOSTILE_PATH.length; i++) {
      const variant = `${HOSTILE_PATH.slice(0, i)}Z${HOSTILE_PATH.slice(i + 1)}`;
      if (ruleCovers(pattern, "Read", variant)) escaped.push(JSON.stringify(variant));
    }
    // The failure prints WHAT escaped, so a regression names the character.
    expect(escaped).toEqual([]);
  });

  test("the named decoys a raw splice would have let through are all refused", async () => {
    const pattern = await ruleForHostilePath();
    const decoys: Array<[string, string]> = [
      ["`*` read as any-run", `notes/aXXXXb?c[d]{e}${NEWLINE}secret.md`],
      ["`*` read as empty", `notes/ab?c[d]{e}${NEWLINE}secret.md`],
      ["`?` read as any-char", `notes/a*bZc[d]{e}${NEWLINE}secret.md`],
      ["`[d]` read as a character class", `notes/a*b?cd{e}${NEWLINE}secret.md`],
      ["`{e}` read as a brace expansion", `notes/a*b?c[d]e${NEWLINE}secret.md`],
      ["the newline read as any character", "notes/a*b?c[d]{e}Zsecret.md"],
      ["a longer sibling", `${HOSTILE_PATH}.bak`],
      ["a path that merely starts the same", "notes/a"],
      ["the directory itself", "notes/"],
      ["an unrelated secret", "/etc/shadow"],
    ];
    for (const [why, decoy] of decoys) {
      expect(`${why}: ${ruleCovers(pattern, "Read", decoy)}`).toBe(`${why}: false`);
    }
  });

  test("the rule is keyed to the OPERATIVE field, so a decoy field cannot satisfy it", async () => {
    const pattern = await ruleForHostilePath();
    const compiled = compilePattern(pattern);
    // The approved path parked in `content` while `file_path` points somewhere
    // else is the bypass `OPERATIVE_ARG_FIELDS` exists to close (#145).
    expect(
      matchesPattern(compiled, "Read", { file_path: "/etc/shadow", content: HOSTILE_PATH }),
    ).toBe(false);
  });

  test("the trailing-newline anchor holds: a value with the path plus a newline is not the path", async () => {
    const pattern = await ruleForHostilePath();
    expect(ruleCovers(pattern, "Read", `${HOSTILE_PATH}${NEWLINE}`)).toBe(false);
  });

  test("ApprovalStatus shows the same value back without mangling it", async () => {
    writeApprovals(tmp, [
      approval({ id: approvalId(1), toolName: "Read", input: { file_path: HOSTILE_PATH } }),
    ]);
    const out = JSON.parse(await approvalStatus.execute({ approvalId: approvalId(1) })) as {
      approval: { operativeValue: string };
    };
    expect(out.approval.operativeValue).toBe(HOSTILE_PATH);
  });
});

// ---------------------------------------------------------------------------
// the observed value that is NOT the argument: the tool name
// ---------------------------------------------------------------------------

describe("a tool name is an observed value too", () => {
  /** A session whose permission lines name a hostile tool. An MCP tool's
   *  registered name is `<server>__<tool>`, composed from strings a REMOTE
   *  server declares — `namespacedToolName` sanitises neither half. */
  function askAbout(toolName: string, times = 3): void {
    writeSession(
      tmp,
      "sess_1",
      Array.from({ length: times }, () => permissionAsk(toolName, "approved")),
    );
  }

  test("a wildcard in the tool name is REFUSED, not proposed", async () => {
    askAbout("notes__read*");
    const out = await suggest();
    expect(out.suggestions).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.toolName).toBe("notes__read*");
    expect(out.rejected[0]?.reason).toContain("unescaped glob wildcard");
    // And it never reaches the additions a human would be asked to accept.
    expect(out.diff?.additions).toEqual([]);
  });

  test("the refused wildcard rule really would have widened — the reason is not decorative", () => {
    // `notes__read*` as a pattern covers a tool nobody approved.
    expect(matchesPattern(compilePattern("notes__read*"), "notes__read_all_secrets", {})).toBe(
      true,
    );
  });

  test("a BACKSLASH in the tool name is REFUSED, because the rule then names a different tool", async () => {
    // The hole a string comparison cannot see. `patternFor` embeds the name
    // verbatim, so the pattern text EQUALS the approved name and the escaped
    // `*` is not an unescaped wildcard — both of the earlier guards pass. But
    // the glob grammar reads `\\` as an escape lead-in, so the rule compiles to
    // a pattern about the literal string `notes__read*`: a tool nobody approved.
    const NAME = `notes__read${String.fromCharCode(92)}*`;
    askAbout(NAME);
    const out = await suggest();
    expect(out.suggestions).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]?.pattern).toBe(NAME); // the pattern IS the name, verbatim
    expect(out.rejected[0]?.reason).toContain("would never fire for the tool it was derived from");
    expect(out.diff?.additions).toEqual([]);
  });

  test("the refused backslash rule really would have named another tool — demonstrated, not asserted", () => {
    const NAME = `notes__read${String.fromCharCode(92)}*`;
    const compiled = compilePattern(NAME);
    // The text check that used to be the only tool-half guard passes…
    expect(compiled.toolGlob).toBe(NAME);
    // …while the ENGINE matches a different name, and not the approved one.
    expect(matchesPattern(compiled, NAME, {})).toBe(false);
    expect(matchesPattern(compiled, "notes__read*", {})).toBe(true);
  });

  test("a tool name carrying a parenthesis is REFUSED, because the pattern re-splits", async () => {
    askAbout("Fetch(x)");
    const out = await suggest();
    expect(out.suggestions).toEqual([]);
    expect(out.rejected[0]?.reason).toContain('parses as "Fetch"');
  });

  test("a tool name with an unbalanced parenthesis is REFUSED at compile", async () => {
    askAbout("Fetch(x");
    const out = await suggest();
    expect(out.suggestions).toEqual([]);
    expect(out.rejected[0]?.reason).toContain("cannot compile");
  });

  test("a refusal is reported as an unknown, because those tools keep asking", async () => {
    askAbout("notes__read*");
    const out = JSON.parse(await permissionsSuggest.execute({})) as {
      unknown: Array<{ field: string; reason: string }>;
    };
    expect(out.unknown.find((u) => u.field === "rejected")?.reason).toContain("refused");
  });
});

// ---------------------------------------------------------------------------
// blanket grants, said out loud
// ---------------------------------------------------------------------------

describe("a proposal that covers more than the approved call says so", () => {
  test("a value containing a parenthesis silently drops the argument constraint — and is labelled", async () => {
    askSession(tmp, "sess_1", {
      toolName: "Read",
      input: { file_path: "docs/(draft).md" },
      approved: 3,
    });
    const out = await suggest();
    const suggestion = out.suggestions[0] as SuggestResult["suggestions"][number];
    // harness-advice cannot represent a paren in `Tool(arg)`, so it proposes the
    // bare tool — which is "allow every Read", not "allow that one file".
    expect(suggestion.pattern).toBe("Read");
    expect(suggestion.argConstrained).toBe(false);
    expect(suggestion.evidence.some((line) => line.startsWith("BLANKET GRANT"))).toBe(true);
    expect(suggestion.evidence.join(" ")).toContain("parenthesis");
    // And it IS a blanket grant, demonstrated rather than asserted:
    expect(ruleCovers(suggestion.pattern, "Read", "/etc/shadow")).toBe(true);
  });

  test("an argument-constrained rule for a tool with FIELD ALIASES says it is still wider — and it is", async () => {
    askSession(tmp, "sess_1", {
      toolName: "Read",
      input: { file_path: "notes/a.md" },
      approved: 3,
    });
    const out = await suggest();
    const suggestion = out.suggestions[0] as SuggestResult["suggestions"][number];
    expect(suggestion.pattern).toBe("Read(notes/a.md)");
    expect(suggestion.argConstrained).toBe(true);
    expect(suggestion.evidence.some((l) => l.startsWith("WIDER THAN THE APPROVED CALL"))).toBe(
      true,
    );
    // Demonstrated, not asserted: `matchesPattern` takes the value from ANY of
    // the tool's operative fields, so the approved value in one alias carries a
    // never-approved value in the other past the rule.
    const compiled = compilePattern(suggestion.pattern);
    expect(matchesPattern(compiled, "Read", { file_path: "notes/a.md" })).toBe(true);
    expect(matchesPattern(compiled, "Read", { file_path: "notes/a.md", path: "/etc/shadow" })).toBe(
      true,
    );
    // A tool with a SINGLE operative field gets no such line, because it has no
    // such alias — the note must not be boilerplate on every suggestion.
    expect(
      (
        await (async () => {
          rmSync(path.join(tmp, ".crewhaus"), { recursive: true, force: true });
          askSession(tmp, "sess_2", {
            toolName: "Bash",
            input: { command: "git status" },
            approved: 3,
          });
          return await suggest();
        })()
      ).suggestions[0]?.evidence.some((l) => l.startsWith("WIDER THAN THE APPROVED CALL")),
    ).toBe(false);
  });

  test("a tool with no operative-argument field can only ever get a blanket grant — and is labelled", async () => {
    writeSession(tmp, "sess_1", [
      toolUse("notes__read", { query: "anything" }),
      permissionAsk("notes__read", "approved"),
      permissionAsk("notes__read", "approved"),
      permissionAsk("notes__read", "approved"),
    ]);
    const out = await suggest();
    const suggestion = out.suggestions[0] as SuggestResult["suggestions"][number];
    expect(suggestion.pattern).toBe("notes__read");
    expect(suggestion.argConstrained).toBe(false);
    expect(suggestion.evidence.join(" ")).toContain("no operative-argument field");
  });

  test("several distinct approved inputs also yield a bare grant, as harness-advice already explains", async () => {
    writeSession(tmp, "sess_1", [
      toolUse("Read", { file_path: "a.md" }),
      toolUse("Read", { file_path: "b.md" }),
      permissionAsk("Read", "approved"),
      permissionAsk("Read", "approved"),
      permissionAsk("Read", "approved"),
    ]);
    const out = await suggest();
    const suggestion = out.suggestions[0] as SuggestResult["suggestions"][number];
    expect(suggestion.pattern).toBe("Read");
    expect(suggestion.argConstrained).toBe(false);
    expect(suggestion.evidence.join(" ")).toContain("inputs varied");
  });
});

// ---------------------------------------------------------------------------
// the verifier itself
// ---------------------------------------------------------------------------

describe("verifyRule", () => {
  test("accepts a correctly escaped rule and lists what it checked", () => {
    const verdict = verifyRule(`Read(${escapeGlobLiteral(HOSTILE_PATH)})`, "Read", HOSTILE_PATH);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.argConstrained).toBe(true);
    expect(verdict.ok && verdict.checks.length).toBeGreaterThan(3);
  });

  test("refuses a hand-written widening rule even though it matches the approved call", () => {
    const verdict = verifyRule("Read(notes/*)", "Read", "notes/a.md");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("unescaped glob wildcard");
  });

  test("refuses a rule that would never fire, which is not the same as a safe one", () => {
    const verdict = verifyRule("Read(other.md)", "Read", "notes/a.md");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("never fire");
  });

  test("refuses a tool half that trims away part of the approved name", () => {
    // `compilePattern` trims the tool glob, so a name with an edge space stops
    // being the name that was approved.
    const verdict = verifyRule("Read (a.md)", "Read ", "a.md");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("not the approved tool");
  });

  test("refuses a `**` rule, which is the broadest pattern the grammar has", () => {
    const verdict = verifyRule("**", "Read");
    expect(verdict.ok).toBe(false);
  });

  test("accepts a bare, literal tool grant — broad, but exactly what it says", () => {
    const verdict = verifyRule("Read", "Read");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.argConstrained).toBe(false);
  });

  test("a near-miss set is generated for every metacharacter position", () => {
    // Not a shape assertion: the point is that each generated variant really is
    // rejected by a correctly escaped rule, which is what the suite above runs.
    const pattern = `Bash(${escapeGlobLiteral("npm run test:*")})`;
    expect(verifyRule(pattern, "Bash", "npm run test:*").ok).toBe(true);
    // The documented disaster case: the unescaped form would have matched this.
    expect(ruleCovers(pattern, "Bash", "npm run test:PRODUCTION-DELETE")).toBe(false);
    expect(ruleCovers("Bash(npm run test:*)", "Bash", "npm run test:PRODUCTION-DELETE")).toBe(true);
  });
});
