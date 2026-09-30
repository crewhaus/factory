/**
 * The pure helpers behind the tools: output capping, backoff schedules and
 * environment construction. They are separated out precisely so this much of
 * the package can be proved without a world — no spawning, no filesystem,
 * no clock.
 */
import { describe, expect, test } from "bun:test";
import { backoffDelayMs, backoffSchedule, totalBackoffMs } from "./lib/backoff";
import { FALLBACK_PATH, buildSpawnEnv, inspectEnv, isValidEnvName } from "./lib/env";
import { capText, compileSafePattern, formatArgv } from "./lib/format";

describe("capText", () => {
  test("text within budget comes back untouched", () => {
    expect(capText("hello", 100)).toEqual({ text: "hello", truncated: false, droppedChars: 0 });
  });

  test("over budget keeps both ends, because the head says what started and the tail how it ended", () => {
    const text = `START${"x".repeat(500)}END`;
    const capped = capText(text, 100);
    expect(capped.truncated).toBe(true);
    expect(capped.droppedChars).toBe(text.length - 100);
    expect(capped.text.startsWith("START")).toBe(true);
    expect(capped.text.endsWith("END")).toBe(true);
    expect(capped.text).toContain("chars dropped");
  });

  test("a zero budget drops everything and says so", () => {
    expect(capText("abc", 0)).toEqual({ text: "", truncated: true, droppedChars: 3 });
  });

  test("capping is deterministic", () => {
    const text = "y".repeat(1000);
    expect(capText(text, 64)).toEqual(capText(text, 64));
  });
});

describe("formatArgv", () => {
  test("plain arguments stay plain", () => {
    expect(formatArgv(["git", "log"])).toBe("git log");
  });

  test("anything a reader could mistake for syntax is quoted", () => {
    expect(formatArgv(["echo", "$(whoami)"])).toBe('echo "$(whoami)"');
    expect(formatArgv(["echo", "two words"])).toBe('echo "two words"');
    expect(formatArgv(["echo", ""])).toBe('echo ""');
  });
});

describe("compileSafePattern", () => {
  test("a normal pattern compiles", () => {
    const out = compileSafePattern("Listening on \\d+", "i");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.regex.test("listening on 8080")).toBe(true);
  });

  test("a nested quantifier is refused before it can backtrack", () => {
    const out = compileSafePattern("(a+)+$", "");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("exponentially");
  });

  /**
   * Star height alone misses this one: `(a|a)*` nests no quantifier, yet its
   * branches overlap, so a failing match doubles its work with every added
   * character. The numbers are not theoretical — the unfixed gate admitted
   * this pattern, and 41 characters of input already took ~750ms, which is
   * 2^19 times the cost of 22 characters. `WaitForOutput` runs the match
   * against a buffer of up to a quarter-million characters, inside a loop
   * whose deadline cannot interrupt a single `exec`.
   */
  test("a quantified group with an alternation is refused, because its branches can overlap", () => {
    for (const source of ["(a|a)*$", "(a|ab)*$", "(x|xy)+z"]) {
      const out = compileSafePattern(source, "");
      expect({ source, ok: out.ok }).toEqual({ source, ok: false });
      if (!out.ok) expect(out.message).toContain("alternation");
    }
  });

  test("an alternation that is NOT quantified is the normal case and stays allowed", () => {
    for (const source of ["(Listening|Ready) on", "^(ready|started|listening)\\b", "a|b"]) {
      expect({ source, ok: compileSafePattern(source, "").ok }).toEqual({ source, ok: true });
    }
  });

  test("a quantifier carried out through an optional group is still nesting", () => {
    // `((a+)?)+` has star height 2 by way of a `?`, which the earlier scan
    // did not treat as a quantifier at all, so it let this through.
    expect(compileSafePattern("((a+)?)+", "").ok).toBe(false);
  });

  test("an optional group is not itself a repetition, so it is not refused on its own", () => {
    expect(compileSafePattern("(foo)?bar", "").ok).toBe(true);
    expect(compileSafePattern("(a+)?b", "").ok).toBe(true);
  });

  test("the gate is fast enough to be worth having — a refused pattern never runs", () => {
    const started = Date.now();
    expect(compileSafePattern("(a|a)*$", "").ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("a brace or optional quantifier inside a repeated group is still nesting (C079)", () => {
    // 0.7.0 counted only `*` and `+` inside a group, so each of these passed
    // and JavaScriptCore then gave up on it as a false "no match".
    for (const source of [
      "(a{1,})+$",
      "(\\w{1,})*$",
      "(\\w{1,64})*$",
      "(\\w\\w?)*$",
      "(?:a{1,}){1,}$",
      "(a?){20}a{20}",
      "^(a|a){1,99}$",
    ]) {
      expect({ source, ok: compileSafePattern(source, "").ok }).toEqual({ source, ok: false });
    }
  });

  test("the shared screen admits what a waiting pattern really looks like", () => {
    // Including a quantified alternation whose branches cannot overlap, which
    // 0.7.0's scanner refused wholesale.
    for (const source of [
      "(\\d{1,3}\\.){3}\\d{1,3}",
      "Listening on (\\d+)",
      "(ready|listening)",
      "a{2,5}",
      "\\{literal\\}",
      "(a|b)*$",
    ]) {
      expect({ source, ok: compileSafePattern(source, "").ok }).toEqual({ source, ok: true });
    }
  });

  test("a character class containing a bracket does not confuse the scan", () => {
    const out = compileSafePattern("[)(]+", "");
    expect(out.ok).toBe(true);
  });

  test("an invalid pattern is reported, not thrown", () => {
    const out = compileSafePattern("(unclosed", "");
    expect(out.ok).toBe(false);
  });

  test("an over-long pattern is refused", () => {
    expect(compileSafePattern("a".repeat(1001), "").ok).toBe(false);
  });
});

describe("backoff", () => {
  test("the first attempt never waits", () => {
    expect(backoffDelayMs({ kind: "fixed", delayMs: 500 }, 1)).toBe(0);
    expect(backoffDelayMs({ kind: "exponential", baseMs: 100 }, 1)).toBe(0);
  });

  test("fixed waits the same every time", () => {
    expect(backoffSchedule({ kind: "fixed", delayMs: 250 }, 4)).toEqual([0, 250, 250, 250]);
  });

  test("exponential doubles from the declared base", () => {
    expect(backoffSchedule({ kind: "exponential", baseMs: 100 }, 5)).toEqual([
      0, 100, 200, 400, 800,
    ]);
  });

  test("an explicit factor and cap are honoured", () => {
    expect(
      backoffSchedule({ kind: "exponential", baseMs: 100, factor: 3, maxDelayMs: 500 }, 5),
    ).toEqual([0, 100, 300, 500, 500]);
  });

  test("the schedule has no jitter — two computations agree exactly", () => {
    const policy = { kind: "exponential", baseMs: 37, factor: 1.5 } as const;
    expect(backoffSchedule(policy, 6)).toEqual(backoffSchedule(policy, 6));
  });

  test("the total is what a caller must budget for", () => {
    expect(totalBackoffMs({ kind: "fixed", delayMs: 100 }, 3)).toBe(200);
  });
});

describe("buildSpawnEnv", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    AWS_SECRET_ACCESS_KEY: "do-not-leak",
    WANTED: "yes",
  };

  test("nothing is inherited beyond the pinned floor unless it is named", () => {
    const built = buildSpawnEnv(parent);
    expect(Object.keys(built.env)).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TZ"]);
    expect(built.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  test("locale and timezone are pinned, so a program's own output cannot drift", () => {
    const built = buildSpawnEnv(parent);
    expect(built.env["LC_ALL"]).toBe("C");
    expect(built.env["LANG"]).toBe("C");
    expect(built.env["TZ"]).toBe("UTC");
  });

  test("a named variable is forwarded", () => {
    expect(buildSpawnEnv(parent, { forward: ["WANTED"] }).env["WANTED"]).toBe("yes");
  });

  test("a named variable the parent lacks is reported rather than silently missing", () => {
    expect(buildSpawnEnv(parent, { forward: ["NOPE"] }).missing).toEqual(["NOPE"]);
  });

  test("explicit values win over forwarded ones", () => {
    const built = buildSpawnEnv(parent, { forward: ["WANTED"], set: { WANTED: "override" } });
    expect(built.env["WANTED"]).toBe("override");
  });

  test("a name that is not an environment-variable name is rejected", () => {
    expect(buildSpawnEnv(parent, { forward: ["not a name"] }).invalid).toEqual(["not a name"]);
    expect(isValidEnvName("A_1")).toBe(true);
    expect(isValidEnvName("1A")).toBe(false);
  });

  test("keys come out sorted, so the same request builds the same environment", () => {
    const a = buildSpawnEnv(parent, { set: { B: "1", A: "2" } });
    const b = buildSpawnEnv(parent, { set: { A: "2", B: "1" } });
    expect(JSON.stringify(a.env)).toBe(JSON.stringify(b.env));
  });

  test("a parent with no PATH still gets a usable one", () => {
    expect(buildSpawnEnv({}).env["PATH"]).toBe(FALLBACK_PATH);
  });
});

describe("inspectEnv", () => {
  const parent = { TOKEN: "sk-abcdef", EMPTYISH: "" };

  test("a value is withheld unless it is revealed", () => {
    const { views } = inspectEnv(parent, ["TOKEN"]);
    expect(views).toEqual([{ name: "TOKEN", present: true, chars: 9 }]);
  });

  test("a revealed value comes back in full only when the policy allows it", () => {
    const allow = () => ({ ok: true }) as const;
    expect(inspectEnv(parent, ["TOKEN"], ["TOKEN"], allow).views[0]?.value).toBe("sk-abcdef");
    // The default policy reveals nothing, and says so.
    expect(inspectEnv(parent, ["TOKEN"], ["TOKEN"]).views).toEqual([
      { name: "TOKEN", present: true, chars: 9, withheld: "not-allowed" },
    ]);
    const deny = () => ({ ok: false, code: "credential-shaped" }) as const;
    expect(inspectEnv(parent, ["TOKEN"], ["TOKEN"], deny).views[0]?.withheld).toBe(
      "credential-shaped",
    );
  });

  test("an unset variable is reported as absent, never invented", () => {
    const allow = () => ({ ok: true }) as const;
    const { views } = inspectEnv(parent, ["MISSING"], ["MISSING"], allow);
    expect(views).toEqual([{ name: "MISSING", present: false, chars: 0 }]);
  });

  test("output is name-sorted and duplicate-free, so argument order cannot change the bytes", () => {
    const a = inspectEnv(parent, ["TOKEN", "EMPTYISH", "TOKEN"]);
    const b = inspectEnv(parent, ["EMPTYISH", "TOKEN"]);
    expect(JSON.stringify(a.views)).toBe(JSON.stringify(b.views));
    expect(a.views.map((v) => v.name)).toEqual(["EMPTYISH", "TOKEN"]);
  });

  test("a malformed name is rejected rather than looked up", () => {
    expect(inspectEnv(parent, ["bad name"]).invalid).toEqual(["bad name"]);
  });
});
