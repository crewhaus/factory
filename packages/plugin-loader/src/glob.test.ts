/**
 * `matchesGlob` reads a pattern from a plugin's manifest (`permissions.fs` /
 * `permissions.net`), so it must not be a backtracking regex: 0.7.0 compiled
 * the glob to one, and `*a*a*a…` against a run of `a` that ends in a mismatch
 * took exponential time — an `fs` entry of forty `*a` stalled the Hangar that
 * evaluated it. It is now a table walk whose work is counted, and it answers
 * exactly as 0.7.0 did, except that `?` stands for itself (0.7.0 left it a
 * regex quantifier: `v1?` matched `v`, and `?abc` threw). That change goes
 * both ways: a pattern with `?` no longer matches what the optional character
 * let through, and a query-string pattern (`…/search?q=*`) now matches the
 * URL it spells, which 0.7.0's never did.
 */
import { describe, expect, test } from "bun:test";
import { isNetAllowed, matchesGlob } from "./index";

/** 0.7.0's matcher, verbatim: the oracle for every pattern without `?`. */
function matchesGlob070(target: string, pattern: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DOUBLESTAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DOUBLESTAR::/g, ".*")}$`,
  );
  return re.test(target);
}

/** A small deterministic generator, so a failure names a reproducible case. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** `pattern` with each `*` / `**` replaced by a short random run of `chars`. */
function instantiate(
  pattern: string,
  rand: () => number,
  pick: (xs: readonly string[]) => string,
  chars: readonly string[],
): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "*") {
      out += pattern[i];
      continue;
    }
    if (pattern[i + 1] === "*") i++;
    out += Array.from({ length: Math.floor(rand() * 4) }, () => pick(chars)).join("");
  }
  return out;
}

/** `text` unchanged half the time, else with one character replaced. */
function nearMiss(
  text: string,
  rand: () => number,
  pick: (xs: readonly string[]) => string,
  chars: readonly string[],
): string {
  if (text.length === 0 || rand() < 0.5) return text;
  const at = Math.floor(rand() * text.length);
  return text.slice(0, at) + pick(chars) + text.slice(at + 1);
}

describe("matchesGlob answers as 0.7.0 did", () => {
  test("on every pattern without ?, over a bounded random sample", () => {
    const rand = lcg(0x5eed);
    const pick = (xs: readonly string[]): string => xs[Math.floor(rand() * xs.length)] ?? "";
    const patternChars = ["a", "b", "/", "*", "*", ".", "\n", " "];
    const targetChars = ["a", "b", "/", ".", "\n", "\r"];
    let agreed = 0;
    let matched = 0;
    let crossedLine = 0;
    const disagreements: string[] = [];
    for (let k = 0; k < 20_000; k++) {
      const pattern = Array.from({ length: Math.floor(rand() * 9) }, () => pick(patternChars)).join(
        "",
      );
      // Half the targets are random; half are the pattern filled in (each
      // wildcard given a random run), then one character changed or not — so
      // the sample holds matches and near misses, not only misses.
      const target =
        rand() < 0.5
          ? Array.from({ length: Math.floor(rand() * 11) }, () => pick(targetChars)).join("")
          : nearMiss(instantiate(pattern, rand, pick, targetChars), rand, pick, targetChars);
      const was = matchesGlob070(target, pattern);
      const now = matchesGlob(target, pattern);
      if (was === now) agreed++;
      else if (disagreements.length < 5)
        disagreements.push(JSON.stringify({ pattern, target, was, now }));
      if (now) matched++;
      if (pattern.includes("**") && /[\n\r]/.test(target) && !now) crossedLine++;
    }
    expect(disagreements).toEqual([]);
    expect(agreed).toBe(20_000);
    // The sample exercises both answers and the line-break rule, not just one.
    expect(matched).toBeGreaterThan(1_000);
    expect(20_000 - matched).toBeGreaterThan(1_000);
    expect(crossedLine).toBeGreaterThan(100);
  });

  test("the documented cases", () => {
    expect(matchesGlob("", "")).toBe(true);
    expect(matchesGlob("a", "")).toBe(false);
    expect(matchesGlob("", "*")).toBe(true);
    expect(matchesGlob("", "**")).toBe(true);
    expect(matchesGlob("foo/bar", "foo/*")).toBe(true);
    expect(matchesGlob("foo/bar/baz", "foo/*")).toBe(false);
    expect(matchesGlob("foo/bar/baz", "foo/**")).toBe(true);
    expect(matchesGlob("foo/bar/baz", "**/baz")).toBe(true);
    expect(matchesGlob("foo/bar\nbaz", "foo/**")).toBe(false);
    expect(matchesGlob("fooXtxt", "foo.txt")).toBe(false);
  });
});

describe("? stands for itself", () => {
  test("in a URL pattern, a query is matched literally", () => {
    const perms = { net: ["fetch:https://api.example.com/v1?*"] };
    expect(isNetAllowed(perms, "https://api.example.com/v1?q=1")).toBe(true);
    // 0.7.0 read `1?` as "an optional 1", so these matched too.
    expect(isNetAllowed(perms, "https://api.example.com/vX")).toBe(false);
    expect(isNetAllowed(perms, "https://api.example.com/v")).toBe(false);
    expect(matchesGlob070("https://api.example.com/vX", "https://api.example.com/v1?*")).toBe(true);
  });

  test("so it both narrows and widens against 0.7.0: a query-string pattern now matches the URL it spells", () => {
    // 0.7.0 read `h?q` as "an optional h, then q": the `?` in the URL never
    // matched it, so a pattern written for one query admitted nothing.
    const pattern = "https://api.acme.dev/search?q=*";
    const url = "https://api.acme.dev/search?q=cats";
    expect(matchesGlob070(url, pattern)).toBe(false);
    expect(matchesGlob(url, pattern)).toBe(true);
    expect(isNetAllowed({ net: [`fetch:${pattern}`] }, url)).toBe(true);
    // …and a URL 0.7.0 admitted through the optional character no longer is.
    expect(matchesGlob070("https://api.acme.dev/searcq=cats", pattern)).toBe(true);
    expect(matchesGlob("https://api.acme.dev/searcq=cats", pattern)).toBe(false);
  });

  test("a leading ? is a character, not a regex that cannot compile", () => {
    expect(matchesGlob("?abc", "?abc")).toBe(true);
    expect(matchesGlob("abc", "?abc")).toBe(false);
    expect(() => matchesGlob070("abc", "?abc")).toThrow();
  });
});

describe("matchesGlob's work grows with the input, not exponentially", () => {
  test("pathological manifest patterns, counted, at 1x and 16x the target", () => {
    // Counted first on a trivial case, so a matcher that reports no work
    // fails here instead of being handed the inputs below.
    const probe = { steps: 0 };
    expect(matchesGlob("a", "a", probe)).toBe(true);
    expect(probe.steps).toBeGreaterThan(0);

    const cases = [
      { pattern: `/${"*a".repeat(40)}*`, target: (n: number) => `/${"a".repeat(n)}/b` },
      { pattern: `${"**a".repeat(40)}**b`, target: (n: number) => "a".repeat(n) },
      { pattern: `${"*".repeat(200)}x`, target: (n: number) => "y".repeat(n) },
    ];
    const results = cases.map(({ pattern, target }) => {
      const small = { steps: 0 };
      const large = { steps: 0 };
      const longTarget = target(256 * 16);
      const answers = [
        matchesGlob(target(256), pattern, small),
        matchesGlob(longTarget, pattern, large),
      ];
      const bound = pattern.length * (longTarget.length + 1);
      return { answers, small: small.steps, large: large.steps, bound };
    });
    for (const r of results) {
      expect(r.answers).toEqual([false, false]);
      expect(r.small).toBeGreaterThan(0);
      // Sixteen times the target is at most sixteen times the work, give or
      // take the constant; quadratic would be 256.
      expect(r.large / r.small).toBeLessThan(17);
      // …and never more than one visit per pattern character per position.
      expect(r.large).toBeLessThanOrEqual(r.bound);
    }
    expect(results.length).toBe(3);
  });
});
