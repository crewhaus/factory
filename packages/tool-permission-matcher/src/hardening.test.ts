/**
 * 0.7.1 hardening — the matcher cannot be dodged.
 *
 * Four things the 0.7.0 matcher got wrong, each pinned here:
 *
 *  1. It compiled a glob to a backtracking RegExp. `Bash(*git*push*--force*)`
 *     against an 18 KB command took twelve seconds on the event loop.
 *  2. It read allow, deny and ask rules the same way, so a deny needed EVERY
 *     string in the input to match and one extra argument dodged it.
 *  3. For Read/Write/Edit/Grep an allow was satisfied by ANY listed field,
 *     so a matching decoy `file_path` authorised the real `path`.
 *  4. It matched the literal string, so `build/../src` passed `build/**`.
 *     (Canonicalisation itself happens in the runtime; here we pin how the
 *     matcher reads the values the runtime hands it.)
 */
import { describe, expect, test } from "bun:test";
import {
  type OperativeValue,
  compilePattern,
  legacyMcpToolName,
  matchesPattern,
  matchesToolName,
} from "./index";

// ---------------------------------------------------------------------------
// The 0.7.0 compiler, kept verbatim as the ORACLE for the language the new
// automaton must accept. Any difference on any glob/value pair is a bug in the
// rewrite (or a deliberate grammar change, which this test would force into
// the open).
// ---------------------------------------------------------------------------
type GlobPos = "start" | "sep" | "other";
function oracleGlobToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  let pos: GlobPos = "start";
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "\\" && i + 1 < glob.length) {
      const lit = glob.charAt(i + 1);
      re += lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pos = lit === "/" ? "sep" : "other";
      i += 2;
    } else if (ch === "*" && glob[i + 1] === "*") {
      const afterTwo = glob[i + 2];
      if (afterTwo === "/" && pos === "start") {
        re += "(?:.*/)?";
        pos = "start";
        i += 3;
      } else if (afterTwo === "/" && pos === "sep") {
        re = `${re.slice(0, -1)}(?:/.*/|/)`;
        pos = "start";
        i += 3;
      } else if (afterTwo === undefined && pos === "sep") {
        re = `${re.slice(0, -1)}(?:/.*)?`;
        pos = "other";
        i += 2;
      } else {
        re += ".*";
        pos = "other";
        i += 2;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      pos = "other";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      pos = "other";
      i++;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      pos = ch === "/" ? "sep" : "other";
      i++;
    }
  }
  return new RegExp(`^${re}$`, "s");
}

/** Deterministic PRNG so a failure reproduces. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the linear-time glob accepts exactly the old regex's language", () => {
  test("randomised differential against the 0.7.0 compiler", () => {
    const rand = prng(0x5eed);
    const globAlphabet = ["a", "b", "/", "*", "**", "?", "\\", "\\*", ".", "(", "[", "\n"];
    const valueAlphabet = ["a", "b", "/", ".", "*", "?", "\\", "\n", "(", "["];
    let compared = 0;
    let matched = 0;
    for (let g = 0; g < 1500; g++) {
      let glob = "";
      const glen = 1 + Math.floor(rand() * 7);
      for (let i = 0; i < glen; i++) {
        glob += globAlphabet[Math.floor(rand() * globAlphabet.length)];
      }
      const oracle = oracleGlobToRegex(glob);
      const compiled = compilePattern(`T(${glob})`);
      const argRe = compiled._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (let v = 0; v < 40; v++) {
        let value = "";
        const vlen = Math.floor(rand() * 8);
        for (let i = 0; i < vlen; i++) {
          value += valueAlphabet[Math.floor(rand() * valueAlphabet.length)];
        }
        const want = oracle.test(value);
        if (argRe.test(value) !== want) {
          throw new Error(
            `glob ${JSON.stringify(glob)} vs ${JSON.stringify(value)}: oracle=${want} new=${!want}`,
          );
        }
        compared++;
        if (want) matched++;
      }
    }
    // A differential that never compares a MATCH proves nothing about matches.
    expect(compared).toBe(1500 * 40);
    expect(matched).toBeGreaterThan(2000);
  });
});

describe("matchesSegmentAfter: a glob against a prefix and ANY one segment", () => {
  test("agrees with trying every short segment against the 0.7.0 compiler", () => {
    // For a glob this short, when some segment after the prefix matches, a
    // segment of at most five characters from {a, b, c} does: each literal
    // or `?` needs at most one character, and every `*` can match none.
    // So trying all of them is a complete oracle.
    const rand = prng(0x5e9);
    const globAlphabet = ["a", "b", "/", "*", "**", "?", "\\*"];
    const prefixes = ["", "a", "a/", "b/", "a/b/", "/"];
    const segments = [""];
    for (let len = 1; len <= 5; len++) {
      for (const base of segments.filter((x) => x.length === len - 1)) {
        for (const c of ["a", "b", "c", "*"]) segments.push(base + c);
      }
    }
    let compared = 0;
    let matched = 0;
    for (let g = 0; g < 600; g++) {
      let glob = "";
      const glen = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < glen; i++) {
        glob += globAlphabet[Math.floor(rand() * globAlphabet.length)];
      }
      const oracle = oracleGlobToRegex(glob);
      const argRe = compilePattern(`T(${glob})`)._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (const prefix of prefixes) {
        const want = segments.some((seg) => oracle.test(prefix + seg));
        if (argRe.matchesSegmentAfter(prefix) !== want) {
          throw new Error(
            `glob ${JSON.stringify(glob)} after ${JSON.stringify(prefix)}: oracle=${want} new=${!want}`,
          );
        }
        compared++;
        if (want) matched++;
      }
    }
    expect(compared).toBe(600 * 6);
    expect(matched).toBeGreaterThan(300);
    expect(compared - matched).toBeGreaterThan(300);
  });

  test("with two segments, agrees with trying every short <segment>/<segment>", () => {
    // A value that stands for every `<owner>/<repo>` (a code search that
    // names neither). For a glob of at most three tokens, a match needs at
    // most three characters besides the one slash between the segments, so
    // pairs of at most three characters in all are a complete oracle.
    const rand = prng(0x5ea);
    const globAlphabet = ["a", "b", "/", "*", "**", "?", "\\*"];
    const prefixes = ["", "a", "a/", "b/", "a/b/", "/"];
    const short = [""];
    for (let len = 1; len <= 3; len++) {
      for (const base of short.filter((x) => x.length === len - 1)) {
        for (const c of ["a", "b", "c", "*"]) short.push(base + c);
      }
    }
    const pairs: string[] = [];
    for (const one of short) {
      for (const two of short) if (one.length + two.length <= 3) pairs.push(`${one}/${two}`);
    }
    let compared = 0;
    let matched = 0;
    for (let g = 0; g < 400; g++) {
      let glob = "";
      const glen = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < glen; i++) {
        glob += globAlphabet[Math.floor(rand() * globAlphabet.length)];
      }
      const oracle = oracleGlobToRegex(glob);
      const argRe = compilePattern(`T(${glob})`)._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (const prefix of prefixes) {
        const want = pairs.some((pair) => oracle.test(prefix + pair));
        if (argRe.matchesSegmentAfter(prefix, 2) !== want) {
          throw new Error(
            `glob ${JSON.stringify(glob)} after ${JSON.stringify(prefix)} (2 segments): oracle=${want} new=${!want}`,
          );
        }
        compared++;
        if (want) matched++;
      }
    }
    expect(compared).toBe(400 * 6);
    expect(matched).toBeGreaterThan(200);
    expect(compared - matched).toBeGreaterThan(200);
    // The literal fast path reads the same way.
    const literal = compilePattern("T(acme/secret)")._argRe;
    expect(literal?.matchesSegmentAfter("", 2)).toBe(true);
    expect(literal?.matchesSegmentAfter("", 1)).toBe(false);
    expect(literal?.matchesSegmentAfter("acme/", 2)).toBe(false);
  });
});

// merge-seams (0.7.1 wave III) — a value that stands for every value is read
// by a deny through `matchesSomeAfter` (a path, a URL and a command may hold
// `/`, so their tail is any run) and granted by an allow only through
// `matchesEveryAfter`, never by comparing its `*` sentinel as a literal.
describe("matchesSomeAfter / matchesEveryAfter: a glob against a prefix and some or every continuation", () => {
  test("agree with trying every short continuation against the 0.7.0 compiler", () => {
    // Every continuation of at most five characters from the glob's own
    // literals plus one it never names. For globs this short a rejected
    // continuation, when there is one, is at most that long.
    const continuations = (alphabet: readonly string[]): string[] => {
      const out = [""];
      for (let len = 1; len <= 5; len++) {
        for (const base of out.filter((x) => x.length === len - 1)) {
          for (const c of alphabet) out.push(base + c);
        }
      }
      return out;
    };
    const tails = {
      segment: continuations(["a", "b", "c", "*"]),
      run: continuations(["a", "b", "c", "*", "/"]),
    } as const;
    const rand = prng(0xa11);
    const globAlphabet = ["a", "b", "/", "*", "**", "?", "\\*"];
    const prefixes = ["", "a", "a/", "b/", "a/b/", "/"];
    const tally = { compared: 0, some: 0, every: 0 };
    for (let g = 0; g < 400; g++) {
      let glob = "";
      const glen = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < glen; i++) {
        glob += globAlphabet[Math.floor(rand() * globAlphabet.length)];
      }
      const oracle = oracleGlobToRegex(glob);
      const argRe = compilePattern(`T(${glob})`)._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (const prefix of prefixes) {
        for (const tail of ["segment", "run"] as const) {
          const wantSome = tails[tail].some((t) => oracle.test(prefix + t));
          const wantEvery = tails[tail].every((t) => oracle.test(prefix + t));
          const gotSome = argRe.matchesSomeAfter(prefix, tail);
          const gotEvery = argRe.matchesEveryAfter(prefix, tail);
          if (gotSome !== wantSome || gotEvery !== wantEvery) {
            throw new Error(
              `glob ${JSON.stringify(glob)} after ${JSON.stringify(prefix)} (${tail}): oracle some=${wantSome} every=${wantEvery}, got some=${gotSome} every=${gotEvery}`,
            );
          }
          tally.compared++;
          if (wantSome) tally.some++;
          if (wantEvery) tally.every++;
        }
      }
    }
    expect(tally.compared).toBe(400 * 6 * 2);
    // Both answers of both questions occur, so neither is vacuous.
    expect(tally.some).toBeGreaterThan(500);
    expect(tally.compared - tally.some).toBeGreaterThan(500);
    expect(tally.every).toBeGreaterThan(100);
    expect(tally.some - tally.every).toBeGreaterThan(500);
    // 400 globs × 12 questions, each against up to 3,906 continuations: about
    // 0.3 s alone, but 9.4 s was measured under the full suite's load (and CI
    // runners are slower still), so it declares a budget rather than racing
    // bun's 5 s default.
  }, 60_000);

  test("a visible run and a two-segment every agree with the 0.7.0 compiler (final review)", () => {
    // `"visible"`: some continuation in which no segment starts with `.`,
    // what a walk that skips hidden entries reaches beneath a directory
    // (Grep). Two segments: every `<value>` and every `<qualifier>/<value>`,
    // what an allow must cover for a search that names no owner.
    const continuations = (alphabet: readonly string[], maxSlashes: number): string[] => {
      const out = [""];
      for (let len = 1; len <= 5; len++) {
        for (const base of out.filter((x) => x.length === len - 1)) {
          for (const c of alphabet) out.push(base + c);
        }
      }
      return out.filter((t) => t.split("/").length - 1 <= maxSlashes);
    };
    const runs = continuations(["a", "b", ".", "*", "/"], 5);
    const pairs = continuations(["a", ".", "*", "/"], 1);
    /** Independent of the matcher: a `.` that starts a segment is hidden. */
    const visibleAfter = (prefix: string, t: string): boolean => {
      for (let i = 0; i < t.length; i++) {
        const startsSegment = i === 0 ? prefix === "" || prefix.endsWith("/") : t[i - 1] === "/";
        if (startsSegment && t[i] === ".") return false;
      }
      return true;
    };
    const rand = prng(0xd07);
    const globAlphabet = ["a", ".", "/", "*", "**", "?", ".a", "/."];
    const prefixes = ["", "a", "a/", ".", "a/.", "/"];
    const tally = { compared: 0, some: 0, every: 0 };
    for (let g = 0; g < 300; g++) {
      let glob = "";
      const glen = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < glen; i++) {
        glob += globAlphabet[Math.floor(rand() * globAlphabet.length)];
      }
      const oracle = oracleGlobToRegex(glob);
      const argRe = compilePattern(`T(${glob})`)._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (const prefix of prefixes) {
        const wantSome = runs.some((t) => visibleAfter(prefix, t) && oracle.test(prefix + t));
        const wantEvery = pairs.every((t) => oracle.test(prefix + t));
        const gotSome = argRe.matchesSomeAfter(prefix, "visible");
        const gotEvery = argRe.matchesEveryAfter(prefix, "segment", 2);
        if (gotSome !== wantSome || gotEvery !== wantEvery) {
          throw new Error(
            `glob ${JSON.stringify(glob)} after ${JSON.stringify(prefix)}: oracle visible=${wantSome} every2=${wantEvery}, got visible=${gotSome} every2=${gotEvery}`,
          );
        }
        tally.compared++;
        if (wantSome) tally.some++;
        if (wantEvery) tally.every++;
      }
    }
    expect(tally.compared).toBe(300 * 6);
    expect(tally.some).toBeGreaterThan(200);
    expect(tally.compared - tally.some).toBeGreaterThan(200);
    expect(tally.every).toBeGreaterThan(20);
    expect(tally.compared - tally.every).toBeGreaterThan(200);
    // The literal fast path reads a visible run the same way.
    const literal = (glob: string) => compilePattern(`T(${glob})`)._argRe;
    expect(literal("src/.env")?.matchesSomeAfter("src/", "visible")).toBe(false);
    expect(literal("src/.env")?.matchesSomeAfter("src/", "run")).toBe(true);
    expect(literal("src/a.env")?.matchesSomeAfter("src/", "visible")).toBe(true);
    expect(literal(".github/workflows/ci.yml")?.matchesSomeAfter(".github/", "visible")).toBe(true);
    expect(literal("a/.b/c")?.matchesSomeAfter("", "visible")).toBe(false);
  }, 60_000);

  test("matchesSegmentAfter is matchesSomeAfter with a segment tail", () => {
    for (const glob of ["1/*", "1/**", "**x", "1/a/b", "?", "1/?"]) {
      const argRe = compilePattern(`T(${glob})`)._argRe;
      if (argRe === null) throw new Error("expected an arg glob");
      for (const prefix of ["", "1/", "2/"]) {
        expect(argRe.matchesSegmentAfter(prefix)).toBe(argRe.matchesSomeAfter(prefix, "segment"));
      }
    }
  });

  test("a literal glob never matches every continuation; `?` is one character, not every one", () => {
    const every = (glob: string, prefix: string, tail: "segment" | "run") =>
      compilePattern(`T(${glob})`)._argRe?.matchesEveryAfter(prefix, tail);
    expect(every("1/*", "1/", "segment")).toBe(true);
    expect(every("1/**", "1/", "segment")).toBe(true);
    expect(every("1/?", "1/", "segment")).toBe(false);
    expect(every("1/\\*", "1/", "segment")).toBe(false);
    expect(every("1/0x*", "1/", "segment")).toBe(false);
    expect(every("1/*", "2/", "segment")).toBe(false);
    // One segment is not every run: `*` stops at `/`.
    expect(every("*", "", "segment")).toBe(true);
    expect(every("*", "", "run")).toBe(false);
    expect(every("**", "", "run")).toBe(true);
    expect(every("src/**", "", "run")).toBe(false);
    expect(every("src/**", "src/", "run")).toBe(true);
  });
});

// C037 — the cases a plain two-pointer "back up to the last star" matcher
// gets wrong when `*` (no `/`) and `**` (anything) mix, and the regex's
// UTF-16 code-unit reading of `?`; each row is checked against the 0.7.0
// regex too, so the rows themselves cannot be wrong.
describe("the linear-time glob keeps the cases a naive matcher breaks", () => {
  test.each([
    ["**x*y", "x/xay", true],
    ["**x*y", "xa/y", false],
    ["a*b**c", "a/b/c", false],
    ["a*b**c", "axb/c", true],
    ["?", "\u{1F600}", false],
    ["??", "\u{1F600}", true],
  ] as const)("%j against %j is %p", (glob, value, want) => {
    expect(oracleGlobToRegex(glob).test(value)).toBe(want);
    expect(compilePattern(`T(${glob})`)._argRe?.test(value)).toBe(want);
  });
});

describe("security-8#2 — a glob cannot stall the event loop", () => {
  // The audit's reproductions. Under the old regex the first took 12 s at
  // 18 KB (cubic), and the second did not finish inside 110 s at 20 KB.
  //
  // They run in a CHILD process with a kill timer. A backtracking matcher
  // blocks the thread it runs on, so run in-process it would hang this test
  // instead of failing it — the event loop that would fire the timeout is the
  // thing that is stuck.
  //
  // Linear time is checked by COUNTING the work, not by timing it: each rule
  // runs on an argument and on one sixteen times longer, and the matcher
  // reports how many automaton states it visited. Linear means sixteen times
  // the steps. A clock cannot say that reliably on a busy runner — in a full
  // `bun run test` a wall-clock ratio of this same code measured 261.
  test("wildcard-heavy rules against long arguments finish in linear time", async () => {
    const script = `
        import { compilePattern, matchesPattern } from ${JSON.stringify(`${import.meta.dir}/index.ts`)};
        const cases = [
          ["Bash(*git*push*--force*)", (k) => "git push --force origin main ; " + "git push ".repeat(k), 1000],
          ["Bash(*a*b*c*d*)", (k) => "a".repeat(k), 12500],
          ["Bash(**curl**|**sh**)", (k) => "curl ".repeat(k), 2500],
          ["Bash(*a*a*a*a*a*a*a*a*b)", (k) => "a".repeat(k) + "b", 6250],
        ];
        const out = [];
        for (const [pattern, make, k] of cases) {
          const p = compilePattern(pattern);
          const short = make(k);
          const long = make(16 * k);
          const small = { steps: 0 };
          const large = { steps: 0 };
          p._argRe.test(short, small);
          p._argRe.test(long, large);
          out.push({
            pattern,
            length: long.length,
            answer: matchesPattern(p, "Bash", { command: long }),
            small: small.steps,
            large: large.steps,
          });
        }
        console.log(JSON.stringify(out));
      `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 45_000);
    const code = await child.exited;
    clearTimeout(killer);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    // A kill here means the matcher did not get through the inputs in 45 s:
    // it is backtracking again (the old regex never finished the second one).
    expect({ killed, code, stderr }).toEqual({ killed: false, code: 0, stderr: "" });
    const rows = JSON.parse(stdout) as Array<{
      pattern: string;
      length: number;
      answer: boolean;
      small: number;
      large: number;
    }>;
    // The answers are what they always were; only the cost changed.
    expect(rows.map((r) => r.answer)).toEqual([true, false, false, true]);
    for (const r of rows) {
      // The inputs really are the audit's sizes, 100–200 KB, and the work was
      // counted (a matcher that reports nothing proves nothing)…
      expect(r.length).toBeGreaterThanOrEqual(100_000);
      expect(r.small).toBeGreaterThan(0);
      // …sixteen times the input is at most sixteen times the work, give or
      // take the fixed cost at either end (quadratic would be 256)…
      expect({ pattern: r.pattern, growth: r.large / r.small < 17 }).toEqual({
        pattern: r.pattern,
        growth: true,
      });
      // …and no character costs more than a few states per glob token.
      expect(r.large / r.length).toBeLessThan(r.pattern.length);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Polarity
// ---------------------------------------------------------------------------

const allow = { polarity: "allow" } as const;
const restrict = { polarity: "restrict" } as const;

describe("polarity — allow needs every value, deny/ask fire on any", () => {
  test("undeclared tool: an extra string no longer dodges a deny (permission-integration#0)", () => {
    const p = compilePattern("RemovePath(.git/**)");
    const honest = { path: ".git/hooks", recursive: true };
    const decoy = { path: ".git/hooks", recursive: true, reason: "cleanup" };
    expect(matchesPattern(p, "RemovePath", honest, restrict)).toBe(true);
    expect(matchesPattern(p, "RemovePath", decoy, restrict)).toBe(true);
    // …and an allow still needs every string, so the extra one blocks it.
    const scoped = compilePattern("RemovePath(.git/**)");
    expect(matchesPattern(scoped, "RemovePath", decoy, allow)).toBe(false);
  });

  test("undeclared tool: RunCommand deny fires on any argv element (flag-truth-4#0, security-8#0)", () => {
    const p = compilePattern("RunCommand(rm)");
    expect(matchesPattern(p, "RunCommand", { argv: ["rm", "-rf", "src"] }, restrict)).toBe(true);
    expect(matchesPattern(p, "RunCommand", { argv: ["rm"], cwd: "src" }, restrict)).toBe(true);
    expect(matchesPattern(p, "RunCommand", { argv: ["ls", "-la"] }, restrict)).toBe(false);
  });

  test("HttpRequest deny survives method/note additions", () => {
    const p = compilePattern("HttpRequest(http://169.254.169.254/**)");
    const url = "http://169.254.169.254/latest/meta-data/iam";
    for (const input of [{ url }, { url, method: "GET" }, { url, note: "x" }]) {
      expect(matchesPattern(p, "HttpRequest", input, restrict)).toBe(true);
    }
  });

  test("named-table alias decoy: allow needs every PRESENT operative field (security-1#0)", () => {
    const p = compilePattern("Write(src/**)");
    const decoy = { file_path: "src/ok.ts", path: ".crewhaus/settings.json", content: "x" };
    expect(matchesPattern(p, "Write", decoy, allow)).toBe(false);
    expect(matchesPattern(p, "Write", { path: "src/ok.ts", content: "x" }, allow)).toBe(true);
    // The deny side fires on either alias.
    const deny = compilePattern("Write(.crewhaus/**)");
    expect(matchesPattern(deny, "Write", decoy, restrict)).toBe(true);
  });

  test("Grep: a pattern decoy cannot carry an out-of-scope path (flag-truth-1#0)", () => {
    const p = compilePattern("Grep(src/**)");
    expect(matchesPattern(p, "Grep", { pattern: "src/x|password", path: "." }, allow)).toBe(false);
  });

  test("the default polarity is allow", () => {
    const p = compilePattern("Write(src/**)");
    const decoy = { file_path: "src/ok.ts", path: ".git/config" };
    expect(matchesPattern(p, "Write", decoy)).toBe(matchesPattern(p, "Write", decoy, allow));
  });

  test("a bare pattern ignores polarity; an input with no string matches no arg glob", () => {
    const bare = compilePattern("Lint");
    expect(matchesPattern(bare, "Lint", {}, allow)).toBe(true);
    expect(matchesPattern(bare, "Lint", {}, restrict)).toBe(true);
    const scoped = compilePattern("Lint(**)");
    expect(matchesPattern(scoped, "Lint", { fix: true }, allow)).toBe(false);
    expect(matchesPattern(scoped, "Lint", { fix: true }, restrict)).toBe(false);
  });
});

describe("undeclared strings with `..` segments (permission-integration#1 fallback)", () => {
  test("an allow never matches a `..` segment", () => {
    const p = compilePattern("RemovePath(build/**)");
    expect(matchesPattern(p, "RemovePath", { path: "build/../src" }, allow)).toBe(false);
    expect(matchesPattern(p, "RemovePath", { path: "build/out" }, allow)).toBe(true);
  });

  test("a deny sees the collapsed form, and fires outright on a climb out", () => {
    const p = compilePattern("RemovePath(.git/**)");
    expect(matchesPattern(p, "RemovePath", { path: "src/../.git/hooks" }, restrict)).toBe(true);
    expect(matchesPattern(p, "RemovePath", { path: "../elsewhere" }, restrict)).toBe(true);
    // `..` inside a name is not a segment.
    expect(matchesPattern(p, "RemovePath", { path: "notes..txt" }, restrict)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Declared operative values
// ---------------------------------------------------------------------------

const pathValue = (relative: string, absolute: string, raw = relative): OperativeValue => ({
  kind: "path",
  canonical: [relative, absolute],
  spellings: [raw],
});

describe("declared operative values", () => {
  test("they replace the input entirely: a decoy key in the input is never read", () => {
    const p = compilePattern("Write(src/**)");
    const values = [pathValue(".git/hooks/pre-commit", "/ws/.git/hooks/pre-commit")];
    expect(
      matchesPattern(p, "Write", { file_path: "src/ok.ts" }, { ...allow, operativeValues: values }),
    ).toBe(false);
  });

  test("an empty list: no arg glob allows it, and a deny reads the call's strings instead", () => {
    const p = compilePattern("Grep(**)");
    expect(matchesPattern(p, "Grep", { pattern: "x" }, { ...allow, operativeValues: [] })).toBe(
      false,
    );
    // It used to match no deny either, so leaving every optional operative
    // field out dodged `alwaysDeny Tool(**)`, which 0.7.0 enforced (C004).
    expect(matchesPattern(p, "Grep", { pattern: "x" }, { ...restrict, operativeValues: [] })).toBe(
      true,
    );
  });

  test("outside the workspace: never an allow, always a deny", () => {
    const outside: OperativeValue = {
      kind: "path",
      canonical: [],
      spellings: ["../x"],
      outsideWorkspace: true,
    };
    expect(
      matchesPattern(
        compilePattern("Write(**)"),
        "Write",
        {},
        { ...allow, operativeValues: [outside] },
      ),
    ).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Write(.git/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [outside] },
      ),
    ).toBe(true);
  });

  test("an allow reads only canonical spellings; a deny also reads the raw ones", () => {
    // `build/link` is a symlink to `src`: the tool acts on src/app.ts.
    const v = pathValue("src/app.ts", "/ws/src/app.ts", "build/link/app.ts");
    expect(
      matchesPattern(
        compilePattern("Write(build/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Write(src/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(true);
    // A deny written against either name fires.
    expect(
      matchesPattern(
        compilePattern("Write(src/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [v] },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        compilePattern("Write(build/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [v] },
      ),
    ).toBe(true);
  });

  test("a path glob that starts with / sees the absolute spelling, any other glob the relative one", () => {
    const v = pathValue("proj.txt", "/home/me/src/ws/proj.txt");
    // `**/src/**` must not reach through the workspace's own location.
    expect(
      matchesPattern(
        compilePattern("Write(**/src/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(false);
    expect(
      matchesPattern(
        compilePattern("Write(**/src/**)"),
        "Write",
        {},
        { ...restrict, operativeValues: [v] },
      ),
    ).toBe(false);
    // An absolute rule still works against the absolute spelling.
    expect(
      matchesPattern(
        compilePattern("Write(/home/me/src/ws/**)"),
        "Write",
        {},
        { ...allow, operativeValues: [v] },
      ),
    ).toBe(true);
  });

  test("every value must match an allow; any value fires a deny", () => {
    const a = pathValue("src/a.ts", "/ws/src/a.ts");
    const b = pathValue("docs/b.md", "/ws/docs/b.md");
    const p = compilePattern("CopyPath(src/**)");
    expect(matchesPattern(p, "CopyPath", {}, { ...allow, operativeValues: [a, b] })).toBe(false);
    expect(matchesPattern(p, "CopyPath", {}, { ...allow, operativeValues: [a] })).toBe(true);
    expect(matchesPattern(p, "CopyPath", {}, { ...restrict, operativeValues: [b, a] })).toBe(true);
  });

  test("a case-insensitive id fires a deny in any letter case; an allow still matches as written", () => {
    // An address's EIP-55 mixed case is only a checksum: lower case is the
    // same account, and must not dodge a deny written from a block explorer.
    const lower: OperativeValue = {
      kind: "id",
      canonical: ["1/0xdac17f958d2ee523a2206206994597c13d831ec7"],
      caseInsensitive: true,
    };
    const deny = compilePattern("EvmCall(*/0xdAC17F958D2ee523a2206206994597C13D831ec7)");
    expect(matchesPattern(deny, "EvmCall", {}, { ...restrict, operativeValues: [lower] })).toBe(
      true,
    );
    expect(matchesPattern(deny, "EvmCall", {}, { ...allow, operativeValues: [lower] })).toBe(false);
    // Every id already folds case for a deny or ask; the mark is what carries
    // the same protection to a hex value held as text or a recipient, which
    // are otherwise compared as written.
    const plainId: OperativeValue = { kind: "id", canonical: lower.canonical };
    expect(matchesPattern(deny, "EvmCall", {}, { ...restrict, operativeValues: [plainId] })).toBe(
      true,
    );
    const plainText: OperativeValue = { kind: "text", canonical: lower.canonical };
    expect(matchesPattern(deny, "EvmCall", {}, { ...restrict, operativeValues: [plainText] })).toBe(
      false,
    );
    const markedText: OperativeValue = { ...plainText, caseInsensitive: true };
    expect(
      matchesPattern(deny, "EvmCall", {}, { ...restrict, operativeValues: [markedText] }),
    ).toBe(true);
    // Folding widens only what a deny or ask catches, never what it names.
    const other: OperativeValue = {
      ...lower,
      canonical: ["1/0xdac17f958d2ee523a2206206994597c13d831ec8"],
    };
    expect(matchesPattern(deny, "EvmCall", {}, { ...restrict, operativeValues: [other] })).toBe(
      false,
    );
  });

  test("a value that stands for any value fires a deny naming one of them; an allow must name it", () => {
    // EvmGetLogs with no `address` reads every contract's logs, and is
    // matched as `1/*`. A deny about one contract on chain 1 read nothing in
    // `1/*`, so leaving the address out dodged it.
    const every: OperativeValue = {
      kind: "id",
      canonical: ["1/*"],
      spellings: ["*", "1"],
      standsForAny: ["1/", ""],
    };
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const fires = (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "EvmGetLogs",
        {},
        {
          ...restrict,
          operativeValues: [every],
        },
      );
    const grants = (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "EvmGetLogs",
        {},
        {
          ...allow,
          operativeValues: [every],
        },
      );
    const denies = [
      `EvmGetLogs(1/${USDT})`,
      `EvmGetLogs(*/${USDT})`,
      `EvmGetLogs(**${USDT})`,
      `EvmGetLogs(${USDT})`,
      "EvmGetLogs(1/0x*)",
    ];
    expect(denies.filter(fires)).toEqual(denies);
    // Another chain, or a pattern no single address can match, does not fire.
    expect([`EvmGetLogs(137/${USDT})`, "EvmGetLogs(1/a/b)"].filter(fires)).toEqual([]);
    // An allow still reads only the canonical value.
    expect([`EvmGetLogs(1/${USDT})`, `EvmGetLogs(${USDT})`].filter(grants)).toEqual([]);
    expect(["EvmGetLogs(1/*)", "EvmGetLogs(**)"].filter(grants)).toHaveLength(2);
    // Without the mark the value is only its text.
    const plain: OperativeValue = { kind: "id", canonical: ["1/*"] };
    expect(
      matchesPattern(
        compilePattern(`EvmGetLogs(1/${USDT})`),
        "EvmGetLogs",
        {},
        {
          ...restrict,
          operativeValues: [plain],
        },
      ),
    ).toBe(false);
  });

  test("a value standing for every repository of an owner meets a deny in any letter case", () => {
    // SearchCode {owner: "ACME", query: "password org:ACME"}: GitHub logins
    // are case-insensitive, so this searches acme/secret, and the deny,
    // written in lower case, must fire (C004).
    const ownerWide: OperativeValue = {
      kind: "id",
      canonical: ["ACME/*"],
      spellings: ["*", "ACME"],
      standsForAny: ["ACME/", ""],
    };
    const fires = (pattern: string, value: OperativeValue = ownerWide) =>
      matchesPattern(
        compilePattern(pattern),
        "SearchCode",
        {},
        {
          ...restrict,
          operativeValues: [value],
        },
      );
    expect(
      ["SearchCode(acme/secret)", "SearchCode(Acme/*)", "SearchCode(acme/s*)"].filter((p) =>
        fires(p),
      ),
    ).toHaveLength(3);
    // Another owner is not this search's business.
    expect(fires("SearchCode(other/secret)")).toBe(false);
    // A path is folded only where its filesystem ignores case, and a URL by
    // its own rules: the prefix fold is for values compared ignoring case.
    // A path's prefix stands for every path UNDER it (any run, not one
    // segment), so its twin carries only the owner prefix: with the root
    // prefix "" as well it would stand for every path in the workspace, and
    // every deny fires on it — failing closed, as the last line pins.
    const pathValue: OperativeValue = {
      kind: "path",
      canonical: ["ACME/*"],
      standsForAny: ["ACME/"],
    };
    expect(fires("SearchCode(acme/secret)", pathValue)).toBe(false);
    expect(fires("SearchCode(acme/secret)", { ...pathValue, caseInsensitive: true })).toBe(true);
    expect(fires("SearchCode(acme/secret)", { ...ownerWide, kind: "path" })).toBe(true);
  });

  test("an ordinary path is folded for a deny only where its filesystem ignores case", () => {
    // The twin of the prefix case above, for a path that names one place. On
    // Linux `ACME/x` and `acme/x` are two files: a deny on one must not fire
    // on the other. Where the filesystem folds case (the runtime marks the
    // value), they are one file and the deny must fire.
    const upper: OperativeValue = { kind: "path", canonical: ["ACME/x"] };
    const fires = (pattern: string, value: OperativeValue) =>
      matchesPattern(
        compilePattern(pattern),
        "Read",
        {},
        { ...restrict, operativeValues: [value] },
      );
    expect(fires("Read(acme/x)", upper)).toBe(false);
    expect(fires("Read(acme/**)", upper)).toBe(false);
    expect(fires("Read(ACME/x)", upper)).toBe(true);
    const folded: OperativeValue = { ...upper, caseInsensitive: true };
    expect(fires("Read(acme/x)", folded)).toBe(true);
    expect(fires("Read(acme/**)", folded)).toBe(true);
    // Folding widens only what a deny catches, never which file it names.
    expect(fires("Read(acme/y)", folded)).toBe(false);
  });

  test("a value whose qualifier was left out too stands for every <qualifier>/<value>", () => {
    // SearchIssues {query: "password"}: no owner and no repo, so every
    // repository the token can read is searched.
    const everything: OperativeValue = {
      kind: "id",
      canonical: ["*"],
      standsForAny: [""],
      anyQualifier: true,
    };
    const fires = (pattern: string, value: OperativeValue = everything) =>
      matchesPattern(
        compilePattern(pattern),
        "SearchIssues",
        {},
        {
          ...restrict,
          operativeValues: [value],
        },
      );
    const grants = (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "SearchIssues",
        {},
        {
          ...allow,
          operativeValues: [everything],
        },
      );
    const denies = [
      "SearchIssues(acme/secret)",
      "SearchIssues(ACME/Secret)",
      "SearchIssues(acme/*)",
      "SearchIssues(*/secret)",
      "SearchIssues(acme/**)",
      "SearchIssues(secret)",
    ];
    expect(denies.filter((p) => fires(p))).toEqual(denies);
    // Deeper than owner/repo names no repository.
    expect(fires("SearchIssues(acme/secret/issues)")).toBe(false);
    // Without the mark, only one segment stands for any value.
    const oneSegment: OperativeValue = { kind: "id", canonical: ["*"], standsForAny: [""] };
    expect(fires("SearchIssues(acme/secret)", oneSegment)).toBe(false);
    // An allow grants the every-repository search only when it covers every
    // value there, `<owner>/<repo>` included. It used to take `*` (one
    // segment) as enough, so `alwaysAllow SearchIssues(*)` granted the
    // search of every repository while the search of acme/app asked — the
    // broader call granted, the narrower one not (final review, 0.7.1).
    expect(grants("SearchIssues(acme/secret)")).toBe(false);
    expect(grants("SearchIssues(*)")).toBe(false);
    expect(grants("SearchIssues(*/*)")).toBe(false);
    expect(grants("SearchIssues(acme/*)")).toBe(false);
    for (const wide of ["SearchIssues(**)", "SearchIssues(*/**)"]) {
      expect({ wide, granted: grants(wide) }).toEqual({ wide, granted: true });
    }
    // Monotone: every allow that grants the every-repository search also
    // grants one repository in it, and one owner's every repository.
    const oneRepo: OperativeValue = { kind: "id", canonical: ["acme/app"] };
    const oneOwner: OperativeValue = {
      kind: "id",
      canonical: ["acme/*"],
      standsForAny: ["acme/", ""],
    };
    const grantsValue = (pattern: string, value: OperativeValue) =>
      matchesPattern(
        compilePattern(pattern),
        "SearchIssues",
        {},
        {
          ...allow,
          operativeValues: [value],
        },
      );
    const candidates = [
      "SearchIssues(*)",
      "SearchIssues(**)",
      "SearchIssues(*/*)",
      "SearchIssues(*/**)",
      "SearchIssues(acme/*)",
      "SearchIssues(?*)",
      "SearchIssues(*/?*)",
    ];
    for (const pattern of candidates.filter(grants)) {
      expect({ pattern, repo: grantsValue(pattern, oneRepo) }).toEqual({ pattern, repo: true });
      expect({ pattern, owner: grantsValue(pattern, oneOwner) }).toEqual({ pattern, owner: true });
    }
    expect(candidates.filter(grants)).toEqual(["SearchIssues(**)", "SearchIssues(*/**)"]);
  });

  // merge-seams (wave III): the every-contract query on `base` was caught by
  // `alwaysDeny EvmGetLogs(base/0x…)` but not by the same deny spelled
  // `Base/…`, which caught the one-contract query; and `EvmGetLogs(1/?)`
  // granted the every-contract read, `?` matching the literal `*`.
  test("a value that stands for any value: a deny is folded like its kind, an allow must cover every value", () => {
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const every: OperativeValue = {
      kind: "id",
      canonical: ["base/*"],
      spellings: ["*", "base"],
      standsForAny: ["base/", ""],
    };
    const on = (polarity: "allow" | "restrict") => (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "EvmGetLogs",
        {},
        {
          polarity,
          operativeValues: [every],
        },
      );
    const fires = on("restrict");
    const grants = on("allow");
    const denies = [
      `EvmGetLogs(Base/${USDT})`,
      `EvmGetLogs(BASE/${USDT.toLowerCase()})`,
      "EvmGetLogs(Base/*)",
      "EvmGetLogs(Base/0x*)",
    ];
    expect(denies.filter(fires)).toEqual(denies);
    expect([`EvmGetLogs(Basel/${USDT})`, `EvmGetLogs(137/${USDT})`].filter(fires)).toEqual([]);
    // Only a glob that covers every address on the chain grants the read of
    // them all; an allow keeps the chain's case as written.
    const allows = ["EvmGetLogs(base/*)", "EvmGetLogs(base/**)", "EvmGetLogs(**)"];
    expect(allows.filter(grants)).toEqual(allows);
    expect(
      [
        "EvmGetLogs(base/?)",
        "EvmGetLogs(base/\\*)",
        "EvmGetLogs(base/0x*)",
        `EvmGetLogs(base/${USDT})`,
        "EvmGetLogs(*)",
        "EvmGetLogs(Base/*)",
      ].filter(grants),
    ).toEqual([]);
  });

  test("a path, URL or command that stands for any value reads any run after its prefix", () => {
    const check = (value: OperativeValue, tool: string) => ({
      fires: (pattern: string) =>
        matchesPattern(
          compilePattern(pattern),
          tool,
          {},
          {
            ...restrict,
            operativeValues: [value],
          },
        ),
      grants: (pattern: string) =>
        matchesPattern(
          compilePattern(pattern),
          tool,
          {},
          {
            ...allow,
            operativeValues: [value],
          },
        ),
    });
    // Every path under the workspace root, as the runtime spells it.
    const root = check(
      { kind: "path", canonical: ["*", "/ws/*"], standsForAny: ["", "/ws/"] },
      "P",
    );
    expect(
      ["P(secret/**)", "P(**/.env)", "P(/ws/secret/**)", "P(*.pem)"].filter(root.fires),
    ).toHaveLength(4);
    expect(["P(/etc/**)", "P(/other/**)"].filter(root.fires)).toEqual([]);
    expect(["P(**)", "P(/ws/**)"].filter(root.grants)).toHaveLength(2);
    expect(["P(*)", "P(?)", "P(src/**)", "P(\\*)"].filter(root.grants)).toEqual([]);
    // Every path under one directory.
    const sub = check(
      {
        kind: "path",
        canonical: ["pkg/*"],
        standsForAny: ["pkg/", "./pkg/"],
        caseInsensitive: true,
      },
      "P",
    );
    expect(["P(pkg/secret/**)", "P(PKG/**)", "P(./pkg/x)"].filter(sub.fires)).toHaveLength(3);
    expect(["P(other/**)", "P(pkgx/**)"].filter(sub.fires)).toEqual([]);
    expect(["P(pkg/**)", "P(**)"].filter(sub.grants)).toHaveLength(2);
    expect(["P(pkg/*)", "P(PKG/**)"].filter(sub.grants)).toEqual([]);
    // Every URL.
    const url = check({ kind: "url", canonical: ["*"], standsForAny: [""] }, "U");
    expect(
      ["U(https://evil.example/**)", "U(HTTPS://EVIL.example/x)"].filter(url.fires),
    ).toHaveLength(2);
    expect(url.grants("U(**)")).toBe(true);
    expect(["U(https://**)", "U(*)"].filter(url.grants)).toEqual([]);
    // Every command, run where no allow can name it: only one that names
    // every command grants it.
    const cmd = check(
      { kind: "command", canonical: [], spellings: ["*"], standsForAny: [""] },
      "C",
    );
    expect(["C(*scripts/release.sh*)", "C(RM*)", "C(rm -rf /)"].filter(cmd.fires)).toHaveLength(3);
    expect(["C(**)", "C(*)"].filter(cmd.grants)).toEqual(["C(**)"]);
  });

  // wave III: a command with no canonical spelling (run in another
  // directory, or with an environment the call set) asked under every
  // scoped allow, `RunCommand(**)` included — which 0.7.0 honoured for any
  // call, since every string matched it.
  test("a command no allow can name is granted only by one that names every command", () => {
    const elsewhere: OperativeValue = {
      kind: "command",
      canonical: [],
      spellings: ["sh release.sh", "sh", "release.sh", "scripts/release.sh"],
    };
    const grants = (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "C",
        {},
        {
          polarity: "allow",
          operativeValues: [elsewhere],
        },
      );
    expect(["C(**)", "C(***)"].filter(grants)).toEqual(["C(**)", "C(***)"]);
    expect(
      ["C(*)", "C(sh *)", "C(sh release.sh)", "C(**release.sh)", "C(?**)"].filter(grants),
    ).toEqual([]);
    // Unreadable (outsideWorkspace: an environment too large to read) is
    // granted by the same allows and no others. It says which program runs
    // could not be worked out, and an allow naming every command does not
    // need to know; 0.7.0's `RunCommand(**)` covered such a call.
    const unreadable = (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "C",
        {},
        {
          polarity: "allow",
          operativeValues: [{ ...elsewhere, outsideWorkspace: true }],
        },
      );
    expect(["C(**)", "C(***)", "C(*)", "C(sh *)", "C(?**)"].filter(unreadable)).toEqual([
      "C(**)",
      "C(***)",
    ]);
    // …and every deny or ask fires on it.
    expect(
      matchesPattern(
        compilePattern("C(nothing-like-it)"),
        "C",
        {},
        { polarity: "restrict", operativeValues: [{ ...elsewhere, outsideWorkspace: true }] },
      ),
    ).toBe(true);
  });

  test("non-path values are not filtered by absoluteness", () => {
    const cmd: OperativeValue = { kind: "command", canonical: ["/bin/ls -la"] };
    expect(
      matchesPattern(
        compilePattern("Bash(**ls**)"),
        "Bash",
        {},
        { ...allow, operativeValues: [cmd] },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C004 — a deny or ask on a URL, a recipient, an id or a command is not
// dodged by another spelling of the same destination
// ---------------------------------------------------------------------------

describe("a restrict rule reads every spelling of a destination", () => {
  // What the runtime hands the matcher for a URL: the WHATWG href.
  const url = (raw: string): OperativeValue => ({
    kind: "url",
    canonical: [new URL(raw).href],
    spellings: [raw],
  });
  const fires = (
    pattern: string,
    value: OperativeValue,
    opts: { readonly polarity: "allow" | "restrict" } = restrict,
  ) => matchesPattern(compilePattern(pattern), "T", {}, { ...opts, operativeValues: [value] });

  test("a host deny fires on userinfo, a root dot, a port and the other scheme", () => {
    const rule = "T(https://evil.example/**)";
    const spellings = [
      "https://evil.example/exfil",
      "https://x@evil.example/exfil",
      "https://user:pw@evil.example/exfil",
      "https://evil.example./exfil",
      "https://evil.example../exfil",
      "https://evil.example:8443/exfil",
      "http://evil.example/exfil",
      "https://EVIL.Example/exfil#frag",
    ];
    const hits = spellings.filter((s) => fires(rule, url(s)));
    expect(hits).toEqual(spellings);
    // Control: another host is not caught by the folding.
    expect(fires(rule, url("https://evil.example.org/exfil"))).toBe(false);
    expect(fires(rule, url("https://good.example/evil.example/"))).toBe(false);
  });

  // A rule that names a scheme or a port, and not a host, is about that
  // scheme or port: folding http into https (or every port into none) made
  // `alwaysDeny WebFetch(http://**)` — "no plain HTTP" — deny every https
  // fetch, and `http://localhost:5432/**` deny localhost:3000.
  test("a rule that leaves the host a wildcard keeps to the scheme and port it names", () => {
    const plain = "T(http://**)";
    expect(fires(plain, url("http://a.example/x"))).toBe(true);
    expect(fires(plain, url("http://a.example:8080/x"))).toBe(true);
    expect(fires(plain, url("https://a.example/x"))).toBe(false);
    expect(fires(plain, url("https://a.example:8080/x"))).toBe(false);
    const altPort = "T(https://*:8443/**)";
    expect(fires(altPort, url("https://a.example:8443/x"))).toBe(true);
    expect(fires(altPort, url("https://a.example/x"))).toBe(false);
    expect(fires(altPort, url("http://a.example:8443/x"))).toBe(false);
  });

  test("a rule that names a port keeps to it, over either scheme", () => {
    const db = "T(http://localhost:5432/**)";
    expect(fires(db, url("http://localhost:5432/q"))).toBe(true);
    expect(fires(db, url("https://localhost:5432/q"))).toBe(true);
    expect(fires(db, url("http://localhost:3000/health"))).toBe(false);
    expect(fires(db, url("http://localhost/health"))).toBe(false);
  });

  test("a rule that names a host and no port covers the host on every port (0.7.1)", () => {
    const hits = [
      "http://localhost/x",
      "http://localhost:3000/x",
      "https://localhost:8443/x",
      "http://x@localhost:3000/x",
    ].filter((s) => fires("T(http://localhost/**)", url(s)));
    expect(hits).toHaveLength(4);
    expect(fires("T(http://*.corp.example/**)", url("https://db.corp.example:8443/x"))).toBe(true);
  });

  // An IPv4-mapped IPv6 literal reaches the IPv4 host (a socket bound only to
  // 127.0.0.1 answers http://[::ffff:127.0.0.1]:<port>/), and WHATWG writes
  // it in hex, so a deny on the dotted address never saw it.
  test("a deny on an IPv4 address fires on its IPv4-mapped and NAT64 IPv6 literals", () => {
    const rule = "T(https://93.184.215.14/**)";
    const spellings = [
      "https://93.184.215.14/x",
      "https://1572394766/x",
      "https://[::ffff:93.184.215.14]/x",
      "https://[::ffff:5db8:d70e]/x",
      "https://[0:0:0:0:0:ffff:5db8:d70e]/x",
      "https://[64:ff9b::5db8:d70e]/x",
      "http://[::ffff:93.184.215.14]:8080/x",
    ];
    expect(spellings.filter((s) => fires(rule, url(s)))).toEqual(spellings);
    // Controls: IPv6 literals that do not reach that IPv4 host.
    for (const other of ["https://[::1]/x", "https://[2001:db8::5db8:d70e]/x"]) {
      expect({ other, fired: fires(rule, url(other)) }).toEqual({ other, fired: false });
    }
    // An allow is not widened: the mapped literal is not granted by the dotted rule.
    expect(fires(rule, url("https://[::ffff:5db8:d70e]/x"), allow)).toBe(false);
  });

  test("a path deny fires on an escaped letter, a doubled slash, a dot segment and case", () => {
    const rule = "T(https://api.example/admin/**)";
    const spellings = [
      "https://api.example/admin/users",
      "https://api.example/%61dmin/users",
      "https://api.example//admin/users",
      "https://api.example/public/..%2Fadmin/users",
      "https://api.example/public/..%5cadmin/users",
      "https://api.example/ADMIN/users",
    ];
    const hits = spellings.filter((s) => fires(rule, url(s)));
    expect(hits).toEqual(spellings);
    expect(fires(rule, url("https://api.example/administrator"))).toBe(false);
    // A rule written in capitals meets the lower-case href too.
    expect(fires("T(https://API.example/**)", url("https://api.example/x"))).toBe(true);
  });

  test("an allow never grants a URL with userinfo or an escaped climb out", () => {
    expect(fires("T(https://*.example/**)", url("https://a.example/x"), allow)).toBe(true);
    expect(fires("T(https://*/**)", url("https://u:p@a.example/x"), allow)).toBe(false);
    expect(fires("T(https://a.example/public/**)", url("https://a.example/public/x"), allow)).toBe(
      true,
    );
    expect(
      fires("T(https://a.example/public/**)", url("https://a.example/public/..%2Fadmin"), allow),
    ).toBe(false);
    // An allow is not widened by the folding: a capitalised or dotted host is not granted.
    expect(fires("T(https://a.example/**)", url("https://a.example./x"), allow)).toBe(false);
  });

  test("a recipient deny fires on case, a root dot, a +tag, a display name and phone punctuation", () => {
    const mail = (raw: string): OperativeValue => ({ kind: "recipient", canonical: [raw] });
    const rule = "T(ceo@corp.example)";
    const spellings = [
      "ceo@corp.example",
      "CEO@corp.example",
      "ceo@CORP.EXAMPLE",
      "ceo@corp.example.",
      "ceo+board@corp.example",
      "The CEO <ceo@corp.example>",
    ];
    expect(spellings.filter((s) => fires(rule, mail(s)))).toEqual(spellings);
    expect(fires(rule, mail("cfo@corp.example"))).toBe(false);
    expect(fires(rule, mail("ceo@corp.example.org"))).toBe(false);
    const phones = ["+15551234567", "+1 (555) 123-4567", "+1.555.123.4567"];
    expect(phones.filter((s) => fires("T(+15551234567)", mail(s)))).toEqual(phones);
    expect(fires("T(+15551234567)", mail("+15551234568"))).toBe(false);
    expect(fires("T(db.corp.example)", mail("DB.Corp.Example."))).toBe(true);
    // An allow compares only what was written.
    expect(fires("T(*@corp.example)", mail("ops@CORP.example"), allow)).toBe(false);
  });

  test("an id or a program name is compared ignoring case", () => {
    const id: OperativeValue = { kind: "id", canonical: ["CrewHaus/Factory"] };
    expect(fires("T(crewhaus/factory)", id)).toBe(true);
    expect(fires("T(crewhaus/factory)", id, allow)).toBe(false);
    const cmd: OperativeValue = { kind: "command", canonical: ["RM -rf src"], spellings: ["RM"] };
    expect(fires("T(rm)", cmd)).toBe(true);
    expect(fires("T(rm)", cmd, allow)).toBe(false);
    // `text` keeps its case: nothing says what reads it.
    const text: OperativeValue = { kind: "text", canonical: ["Hello"] };
    expect(fires("T(hello)", text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP names (flag-truth-1#1)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A tool named after an Object.prototype member (C202, in the matcher)
// ---------------------------------------------------------------------------

describe("a tool named after an Object.prototype member", () => {
  // The name table was read with `OPERATIVE_ARG_FIELDS[toolName]`, so
  // `toString` found the inherited function and `for … of` threw. The engine
  // caught it and failed closed: every deny or ask on the name fired and no
  // scoped allow ever matched.
  test("falls back to the input's string values, like any undeclared tool", () => {
    const names = ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"];
    for (const name of names) {
      const secret = { a: "secret.txt" };
      expect({
        name,
        restrict: matchesPattern(compilePattern(`${name}(secret*)`), name, secret, restrict),
        allow: matchesPattern(compilePattern(`${name}(secret*)`), name, secret, allow),
        other: matchesPattern(compilePattern(`${name}(secret*)`), name, { a: "public" }, restrict),
      }).toEqual({ name, restrict: true, allow: true, other: false });
    }
  });
});

describe("MCP tool names", () => {
  test("a documented mcp__ rule and a pre-0.7.1 rule both govern the registered name", () => {
    const name = "mcp__github__create_issue";
    for (const pattern of [
      "mcp__github__*",
      "mcp__github__create_issue",
      "github__*",
      "github__create_issue",
      "mcp__*",
    ]) {
      expect(matchesToolName(compilePattern(pattern), name)).toBe(true);
    }
    expect(matchesToolName(compilePattern("gitlab__*"), name)).toBe(false);
    expect(matchesToolName(compilePattern("mcp__gitlab__*"), name)).toBe(false);
  });

  test("the alias runs one way: an mcp__ rule never governs a non-MCP tool", () => {
    expect(matchesToolName(compilePattern("mcp__contract__fn"), "contract__fn")).toBe(false);
  });

  test("legacyMcpToolName needs a server and a tool", () => {
    expect(legacyMcpToolName("mcp__a__b")).toBe("a__b");
    expect(legacyMcpToolName("mcp____b")).toBeUndefined();
    expect(legacyMcpToolName("mcp__a__")).toBeUndefined();
    expect(legacyMcpToolName("a__b")).toBeUndefined();
  });

  test("matchesPattern applies the same name rule", () => {
    const p = compilePattern("github__create_issue");
    expect(matchesPattern(p, "mcp__github__create_issue", { title: "x" }, restrict)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C004 — a relocating field's default, and a call with no operative value
// ---------------------------------------------------------------------------

// Final review (0.7.1): a path naming a directory was one point to a rule and
// a whole subtree to the tool, so `alwaysDeny RemovePath(src/prod/**)` did
// not fire on `RemovePath src` (recursive), and `alwaysDeny Grep(secrets/**)`
// not on a Grep of the whole workspace. A tool that walks what a directory
// holds declares `beneath`, and the runtime hands its prefixes over.
describe("a directory the tool walks: a deny or ask naming anything beneath it fires", () => {
  const src: OperativeValue = {
    kind: "path",
    canonical: ["src", "./src", "/ws/src"],
    spellings: ["src"],
    beneath: ["src/", "./src/", "/ws/src/"],
  };
  const on = (value: OperativeValue, polarity: typeof allow | typeof restrict) => (p: string) =>
    matchesPattern(compilePattern(p), "T", {}, { ...polarity, operativeValues: [value] });

  test("a deny naming a path beneath fires; one beside it does not", () => {
    const fires = on(src, restrict);
    const beneath = [
      "T(src/prod/**)",
      "T(src/prod/keep.ts)",
      "T(**/.git/**)",
      "T(/ws/src/prod/**)",
    ];
    expect(beneath.filter(fires)).toEqual(beneath);
    expect(
      ["T(other/**)", "T(srcx/**)", "T(sr)", "T(/other/**)", "T(src2/a)"].filter(fires),
    ).toEqual([]);
    // The same value without the mark is one point, as it was.
    const point: OperativeValue = { ...src, beneath: undefined };
    expect(on(point, restrict)("T(src/prod/**)")).toBe(false);
    expect(on(point, restrict)("T(src/**)")).toBe(true);
  });

  test("an allow reads the path alone", () => {
    const grants = on(src, allow);
    expect(["T(src)", "T(src/**)", "T(/ws/src)"].filter(grants)).toHaveLength(3);
    expect(["T(src/prod/**)", "T(src/*)", "T(other/**)"].filter(grants)).toEqual([]);
  });

  test("a walk that skips hidden entries is not read as reaching them", () => {
    // Grep with no path: the workspace root, walked by a glob that never
    // opens a name starting with `.` below it.
    const root: OperativeValue = {
      kind: "path",
      canonical: [".", "/ws"],
      spellings: ["."],
      beneath: ["", "/ws/"],
      beneathSkipsHidden: true,
    };
    const fires = on(root, restrict);
    expect(
      ["T(secrets/**)", "T(**/*.pem)", "T(/ws/secrets/prod.yml)", "T(src/.hidden.ts)"].filter(
        fires,
      ),
    ).toEqual(["T(secrets/**)", "T(**/*.pem)", "T(/ws/secrets/prod.yml)"]);
    expect(
      ["T(.env)", "T(**/.env)", "T(.git/**)", "T(a/.ssh/**)", "T(/etc/**)"].filter(fires),
    ).toEqual([]);
    // A hidden directory the call names is walked: only what is below it is
    // held to the rule.
    const github: OperativeValue = {
      kind: "path",
      canonical: [".github"],
      beneath: [".github/"],
      beneathSkipsHidden: true,
    };
    expect(on(github, restrict)("T(.github/workflows/**)")).toBe(true);
    expect(on(github, restrict)("T(.github/.secret)")).toBe(false);
  });

  test("letter case is folded only where the filesystem ignores it", () => {
    expect(on(src, restrict)("T(SRC/Prod/**)")).toBe(false);
    expect(on({ ...src, caseInsensitive: true }, restrict)("T(SRC/Prod/**)")).toBe(true);
  });
});

describe("a relocating field's default is read by a deny or ask, and skipped by an allow", () => {
  // KvDelete {namespace: "ns", key: "k"} with stateDir left out: the key it
  // names, and the store it lives in standing in with its default.
  const key: OperativeValue = { kind: "id", canonical: ["ns/k"], spellings: ["k", "ns"] };
  const store: OperativeValue = {
    kind: "path",
    canonical: [".crewhaus/state", "./.crewhaus/state"],
    spellings: [".crewhaus/state"],
    restrictOnly: true,
  };
  const call = (pattern: string, polarity: typeof allow | typeof restrict) =>
    matchesPattern(
      compilePattern(pattern),
      "KvDelete",
      {},
      {
        ...polarity,
        operativeValues: [key, store],
      },
    );

  test("a deny on the default store fires, so leaving stateDir out does not dodge it", () => {
    expect(call("KvDelete(.crewhaus/state/**)", restrict)).toBe(true);
    expect(call("KvDelete(.crewhaus/state)", restrict)).toBe(true);
    // Not a value that is not there.
    expect(call("KvDelete(other/**)", restrict)).toBe(false);
  });

  test("an allow is about the key: the store's default does not have to match it too", () => {
    expect(call("KvDelete(ns/*)", allow)).toBe(true);
    expect(call("KvDelete(other/*)", allow)).toBe(false);
    // And the default alone grants nothing: the key must still be covered.
    expect(call("KvDelete(.crewhaus/state/**)", allow)).toBe(false);
  });

  test("an allow with nothing but restrict-only values matches nothing", () => {
    const only = (pattern: string) =>
      matchesPattern(
        compilePattern(pattern),
        "KvDelete",
        {},
        {
          ...allow,
          operativeValues: [store],
        },
      );
    expect(only("KvDelete(**)")).toBe(false);
    expect(only("KvDelete(.crewhaus/state)")).toBe(false);
  });
});

describe("a deny or ask on a call that carries none of its declared operative fields", () => {
  // WebhookPost {urlEnv, payload}: the destination is named through an
  // operator-listed environment variable, so the declared `url` is absent.
  const input = { urlEnv: "HOOK_URL", payload: { note: "hello" } };
  const fires = (pattern: string) =>
    matchesPattern(compilePattern(pattern), "WebhookPost", input, {
      ...restrict,
      operativeValues: [],
    });
  const grants = (pattern: string) =>
    matchesPattern(compilePattern(pattern), "WebhookPost", input, {
      ...allow,
      operativeValues: [],
    });

  test("fires when every string value of the call matches, as 0.7.0 read such a call", () => {
    expect(fires("WebhookPost(**)")).toBe(true);
    // One string matching is not enough: 0.7.0 needed every one, and a
    // deny about one value would otherwise fire on unrelated payload text.
    expect(fires("WebhookPost(HOOK_URL)")).toBe(false);
    // A deny about a place the call does not name still does not fire.
    expect(fires("WebhookPost(https://evil.example/**)")).toBe(false);
  });

  test("a destination deny is not set off by a link inside the payload", () => {
    // An ordinary alert whose destination is named through urlEnv, with a
    // link in its text: `WebhookPost(http://**)` is about where the post
    // goes, which this call does not say, and 0.7.0 allowed it.
    const alert = {
      urlEnv: "ALERT_WEBHOOK_URL",
      payload: { text: "Deploy failed", link: "http://status.internal/incident/42" },
    };
    const deny = (pattern: string, input: unknown) =>
      matchesPattern(compilePattern(pattern), "WebhookPost", input, {
        ...restrict,
        operativeValues: [],
      });
    expect(deny("WebhookPost(http://**)", alert)).toBe(false);
    expect(deny("WebhookPost(**)", alert)).toBe(true);
  });

  test("no argument-scoped allow can match it", () => {
    expect(grants("WebhookPost(**)")).toBe(false);
    expect(grants("WebhookPost(HOOK_URL)")).toBe(false);
  });

  test("a call with no string at all still matches no argument-scoped deny", () => {
    const empty = matchesPattern(
      compilePattern("Tool(**)"),
      "Tool",
      { n: 1 },
      {
        ...restrict,
        operativeValues: [],
      },
    );
    expect(empty).toBe(false);
  });
});
