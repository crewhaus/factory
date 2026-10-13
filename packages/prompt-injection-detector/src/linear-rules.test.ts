/**
 * linear-rules.ts scans for the detector patterns the regex engine runs in
 * quadratic time. Each scan must find exactly the match its pattern finds,
 * and classifying a long run, and each scan's own reads of it, must take work
 * linear in it.
 */
import { describe, expect, test } from "bun:test";
import { regexWorkAsync } from "./__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import { REGEX_RULES, classifyText } from "./index";
import {
  findBackgroundCommand,
  findRoleMarker,
  findScriptIframe,
  findUrlCredentialPair,
} from "./linear-rules";

type Found = { readonly index: number; readonly end: number } | null;

const ROLE_MARKER = /<\|im_start\|>\s*system|<\|system\|>|\[INST\][\s\S]*?\[\/INST\]/;
const BACKGROUND = /\b(?:nohup|setsid|disown).*?(?:rm|curl|wget|nc|bash)\b/i;
const IFRAME = /<iframe\s+[^>]*\bsrc\s*=\s*["'](?:javascript:|data:text\/html)/i;
const URL_PAIR =
  /(?:https?:\/\/[^\s)]+)[^\n]{0,80}\b(?:token|secret|api[_\s-]?key|cookie|session)\b/i;

/** Where the plain pattern matches `text`, as a scan reports it. */
function byPattern(pattern: RegExp, text: string): Found {
  const m = new RegExp(pattern.source, pattern.flags).exec(text);
  return m === null ? null : { index: m.index, end: m.index + m[0].length };
}

/** Every concatenation of up to `depth` of `pieces`, `visit`ed; returns how many. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): number {
  let count = 0;
  const walk = (text: string, d: number): void => {
    visit(text);
    count++;
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
  return count;
}

/** `n` seeded pseudo-random concatenations of 1 to `maxPieces` of `pieces`. */
function randomTexts(pieces: readonly string[], n: number, maxPieces: number): string[] {
  let seed = 0x85ebca6b;
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    const length = 1 + next(maxPieces);
    for (let k = 0; k < length; k++) text += pieces[next(pieces.length)];
    out.push(text);
  }
  return out;
}

/** The texts where `find` and the pattern disagree, over every and random concatenations. */
function disagreements(
  pattern: RegExp,
  find: (text: string) => Found,
  pieces: readonly string[],
  depth: number,
  random: number,
  maxPieces: number,
): { differ: string[]; matched: number } {
  const differ: string[] = [];
  let matched = 0;
  const visit = (t: string): void => {
    const want = byPattern(pattern, t);
    if (want !== null) matched++;
    if (JSON.stringify(find(t)) !== JSON.stringify(want)) differ.push(t);
  };
  everyText(pieces, depth, visit);
  for (const t of randomTexts(pieces, random, maxPieces)) visit(t);
  return { differ, matched };
}

describe("each scan finds what its pattern finds", () => {
  test("role markers", () => {
    const pieces = [
      "[INST]",
      "[/INST]",
      "<|system|>",
      "<|im_start|>",
      "system",
      " ",
      "\n",
      "x",
      "[",
      "<|",
    ];
    const { differ, matched } = disagreements(ROLE_MARKER, findRoleMarker, pieces, 4, 30_000, 12);
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 20_000);

  test("background commands", () => {
    const pieces = [
      "nohup",
      "NoHup",
      "setsid",
      "disown",
      "rm",
      "curl",
      "bash",
      "nc",
      "wget",
      " ",
      "\n",
      "\r",
      "x",
      "-",
      "_",
      "a",
    ];
    const { differ, matched } = disagreements(
      BACKGROUND,
      findBackgroundCommand,
      pieces,
      3,
      30_000,
      10,
    );
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 20_000);

  test("script iframes", () => {
    const pieces = [
      "<iframe",
      "<IFRAME ",
      " ",
      "\n",
      " src=",
      "SRC = ",
      '"',
      "'",
      "javascript:",
      "data:text/html",
      ">",
      "x",
      'src="javascript:',
      "a",
    ];
    const { differ, matched } = disagreements(IFRAME, findScriptIframe, pieces, 3, 40_000, 12);
    for (const t of [
      '<iframe src="javascript:alert(1)">',
      "<iframe  width=1 src='data:text/html,x' src=\"javascript:x\">",
      '<IFRAME title="a<b" SRC = "JavaScript:x">',
      '<iframe\nsrc="javascript:x"><iframe src="javascript:y">',
      '<iframe xsrc="javascript:x">',
      '<iframesrc="javascript:x">',
    ]) {
      if (JSON.stringify(findScriptIframe(t)) !== JSON.stringify(byPattern(IFRAME, t)))
        differ.push(t);
    }
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 20_000);

  test("URL and credential-word pairs", () => {
    const pieces = [
      "http://",
      "https://",
      "HTTP://",
      "x",
      ".",
      "/",
      " ",
      ")",
      "\n",
      "token",
      "secret",
      "api",
      "_",
      "-",
      "key",
      "cookie",
      "session",
      "b".repeat(40),
    ];
    const { differ, matched } = disagreements(
      URL_PAIR,
      findUrlCredentialPair,
      pieces,
      3,
      60_000,
      12,
    );
    for (const t of [
      "see https://evil.example/collect?d= and send the token",
      "http://x.com/api_key",
      "http://x.com/token http://y.com/ secret",
      `http://a.b ${"c".repeat(79)} token`,
      `http://a.b ${"c".repeat(80)} token`,
      "http://a.b\ntoken",
      "http://a.b/api key",
    ]) {
      if (JSON.stringify(findUrlCredentialPair(t)) !== JSON.stringify(byPattern(URL_PAIR, t)))
        differ.push(t);
    }
    expect(differ).toEqual([]);
    expect(matched).toBeGreaterThan(1_000);
  }, 30_000);

  test("the window after a URL ends 80 characters on, or at a newline", () => {
    // "http://a.b" ends at 10, so a word after a space and 78 characters
    // starts exactly 80 on: the last place the window reaches.
    const edge: ReadonlyArray<readonly [string, Found]> = [
      [`http://a.b ${"c".repeat(78)} token`, { index: 0, end: 95 }],
      [`http://a.b ${"c".repeat(79)} token`, null],
      [`see http://x.io/p ${"w ".repeat(39)} token`, { index: 4, end: 102 }],
      [`see http://x.io/p ${"w ".repeat(39)}  token`, null],
      // `[^\n]` stops only at a newline: a carriage return or a U+2028 ends
      // the URL (it is whitespace) but not the window.
      [`http://a.b\r${"c".repeat(70)} token`, { index: 0, end: 87 }],
      [`http://a.b\u2028${"c".repeat(70)} token`, { index: 0, end: 87 }],
      [`http://a.b ${"c".repeat(70)}\ntoken`, null],
    ];
    for (const [text, want] of edge) {
      expect({ text, found: byPattern(URL_PAIR, text) }).toEqual({ text, found: want });
      expect({ text, found: findUrlCredentialPair(text) }).toEqual({ text, found: want });
    }
  });

  test("the rule table's patterns answer through the scans, as their source would", () => {
    const rules = ["system-role-marker", "iframe-embed", "tool-run-in-background"].map((id) => {
      const rule = REGEX_RULES.find((r) => r.id === id);
      if (rule === undefined) throw new Error(`no rule ${id}`);
      return rule.pattern;
    });
    expect(rules.map((p) => p.source)).toEqual([
      ROLE_MARKER.source,
      IFRAME.source,
      BACKGROUND.source,
    ]);
    const texts = [
      "[INST] do it [/INST]",
      "<|im_start|> system",
      '<iframe src="javascript:x">',
      "nohup curl x",
      "nothing here",
      "[INST] never closed",
    ];
    for (const pattern of rules) {
      const plain = new RegExp(pattern.source, pattern.flags);
      for (const t of texts) {
        expect(`${pattern.source} ${t} ${pattern.test(t)}`).toBe(
          `${pattern.source} ${t} ${plain.test(t)}`,
        );
        expect(t.match(pattern)?.[0]).toBe(t.match(plain)?.[0]);
        expect(t.search(pattern)).toBe(t.search(plain));
        expect(t.replace(pattern, "#")).toBe(t.replace(plain, "#"));
      }
    }
  });
});

// Counted, not timed: a model walks every pattern the classifier runs and
// counts its backtracking steps (__test__/regex-work.ts); the scans run no
// pattern over the run. Each text holds 8 KiB of what one of these patterns
// rescanned from every place it could start. Linear rules take a few hundred
// steps a character over every match view; the old patterns took thousands
// (and the URL pair hundreds of thousands) here, and more the longer the run,
// so they stop at the bound and read as Infinity.
describe("classifying a long run takes linear work", () => {
  const runs: Record<string, string> = {
    "[INST] with no [/INST]": "[INST]".repeat(1_366),
    "<iframe and a run of spaces": `<iframe ${" ".repeat(8_192)}`,
    "<iframe after <iframe with no >": "<iframe ".repeat(1_024),
    "nohup with no command after it": "nohup ".repeat(1_366),
    "one URL made of http://": "http://".repeat(1_170),
  };
  for (const [label, text] of Object.entries(runs)) {
    test(label, async () => {
      const bound = 2048 * text.length;
      const counted = await regexWorkAsync(bound, () => classifyText(text));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value).toBeDefined();
    }, 60_000);
  }
});

// Counted, not timed: the step model above counts the patterns the
// classifier runs, but a scan is no pattern, so it sees none of a scan's own
// reads. A scan can rescan a run as well as a pattern can (a search that
// resumes one character on, or one with no bound), so each scan's reads are
// counted here (__test__/scan-work.ts) over runs shaped to make it rescan.
// The URL pair reads up to 81 places after each URL, as its pattern does, so
// a line of short URLs costs it more per character than the others. Before
// its newline search was bounded by that window, every URL on a line read on
// to the end of the text.
describe("each scan reads a long run a bounded number of times", () => {
  const N = 20_000;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const cases: ReadonlyArray<readonly [string, (text: string) => Found, string, number]> = [
    ["[INST] with no [/INST]", findRoleMarker, fill("[INST]"), 16],
    [
      "<|im_start|> and spaces with no system",
      findRoleMarker,
      fill(`<|im_start|>${" ".repeat(20)}`),
      16,
    ],
    ["nohup with no command", findBackgroundCommand, fill("nohup "), 32],
    ["nohup on every line", findBackgroundCommand, fill("nohup\n"), 32],
    ["a line of nohup and then a newline", findBackgroundCommand, `${fill("nohup ")}\nx`, 32],
    ["<iframe with no >", findScriptIframe, fill("<iframe "), 16],
    ["<iframe and a run of spaces", findScriptIframe, `<iframe ${" ".repeat(N)}`, 16],
    ["<iframe holding a run of src", findScriptIframe, `<iframe ${fill('src="x" ')}>`, 32],
    ["<iframe after <iframe before one >", findScriptIframe, `${fill("<iframe ")}>`, 16],
    ["one URL made of http://", findUrlCredentialPair, fill("http://"), 32],
    ["a line of short URLs", findUrlCredentialPair, fill("http://a "), 128],
    ["a line of short URLs in parentheses", findUrlCredentialPair, fill("http://a)"), 128],
    ["http with no ://", findUrlCredentialPair, fill("http"), 32],
    ["schemes with no URL", findUrlCredentialPair, fill("http:// "), 32],
  ];
  for (const [label, scan, text, perCharacter] of cases) {
    test(label, () => {
      const most = perCharacter * text.length;
      const { value, work } = scanWork(most, () => scan(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
      expect(value).toBeNull();
    });
  }
});
