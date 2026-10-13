/**
 * classifyRouterError reads "peer … unreachable" with a scan
 * (unreachable-peer.ts): the pattern read to the end of the line from every
 * `peer ` in the message, and a message can hold a peer's version string.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { classifyRouterError } from "./index";
import { mentionsUnreachablePeer } from "./unreachable-peer";

const PEER_CLAUSE = /peer .* unreachable/i;
const BEFORE =
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|federation transport timeout|peer .* unreachable/i;

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
  let seed = 0x2f6b9a13;
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

describe("mentionsUnreachablePeer", () => {
  test("answers what the pattern answered", () => {
    const pieces = [
      "peer ",
      "PeEr ",
      "peer",
      " unreachable",
      " UNREACHABLE",
      "unreachable",
      " ",
      "\n",
      "\r",
      "\u2028",
      "x",
    ];
    const differ: string[] = [];
    let yes = 0;
    const visit = (t: string): void => {
      const want = PEER_CLAUSE.test(t);
      if (want) yes++;
      if (mentionsUnreachablePeer(t) !== want) differ.push(t);
    };
    const checked = everyText(pieces, 4, visit);
    for (const t of randomTexts(pieces, 30_000, 12)) visit(t);
    expect(differ).toEqual([]);
    expect(checked).toBe((11 ** 5 - 1) / 10);
    expect(yes).toBeGreaterThan(1_000);
  }, 20_000);

  test("classifyRouterError hints what it hinted", () => {
    // The classifier as it was, with the pattern.
    const before = (message: string) => {
      if (BEFORE.test(message)) return { kind: "retry", delayMs: 1_000 };
      if (
        /cert-pin mismatch|cert chain|certificate has expired|wrong CA|status 4[0-9][0-9]|fingerprint mismatch/i.test(
          message,
        )
      ) {
        return { kind: "tombstone", reason: message };
      }
      if (/status 5[0-9][0-9]/i.test(message)) return { kind: "retry", delayMs: 2_000 };
      return { kind: "fail", reason: message };
    };
    for (const message of [
      "connect ECONNREFUSED 127.0.0.1:443",
      "federation peer acme.example unreachable after 3 attempts",
      "federation peer acme.example\nunreachable",
      "peer acme.example returned status 503",
      "peer acme.example returned status 404",
      "pinned fingerprint mismatch for acme.example",
      "something else",
      ...randomTexts(
        ["peer ", " unreachable", "status 503", "status 404", "x", "\n", "ETIMEDOUT"],
        5_000,
        8,
      ),
    ]) {
      expect(classifyRouterError(new Error(message))).toEqual(before(message));
    }
  });
});

/**
 * Runs `body` with the old pattern refused on the spot and recorded when it
 * runs over a text holding `run`; every other pattern runs. Replacing
 * `RegExp.prototype.exec` routes every String and RegExp method that runs a
 * pattern through it; restored after.
 */
function refusingOldOver<T>(run: string, body: () => T): { ran: string[]; outcome: T | Error } {
  const ran: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (this.source === BEFORE.source && typeof input === "string" && input.includes(run)) {
      ran.push(`/${this.source}/`);
      throw new Error("the old pattern ran over the peer's text");
    }
    return realExec.call(this, input);
  };
  try {
    return { ran, outcome: body() };
  } catch (err) {
    return { ran, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

// Counted, not timed: the old pattern is refused on the spot if it runs over
// the peer's text. The scan's own reads are counted below.
describe("a message holding a peer's long version string", () => {
  test("is classified without the pattern over it", () => {
    const run = "peer ".repeat(1_000);
    // Control: the hook sees the old pattern when RegExp#test runs it.
    expect(refusingOldOver(run, () => BEFORE.test(run)).ran).toEqual([`/${BEFORE.source}/`]);
    const message = `peer acme.example speaks ${"peer ".repeat(200_000)}, expected 1`;
    const classified = refusingOldOver(run, () => classifyRouterError(new Error(message)));
    expect(classified.ran).toEqual([]);
    expect(classified.outcome).toEqual({ kind: "fail", reason: message });
  }, 20_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a search
// that resumes one character on instead of after what it read), so the scan's
// own reads are counted (__test__/scan-work.ts) over messages shaped to make it
// rescan, and held to a few per character. A rescan reads the rest of the run
// from every place in it and stops at the bound at once.
describe("the scan reads a long message a bounded number of times", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a line of peer with no unreachable", mentionsUnreachablePeer, fill("peer ")],
    ["peer on every line", mentionsUnreachablePeer, fill("peer x\n")],
    ["a line of peer, then a line break", mentionsUnreachablePeer, `${fill("peer ")}\nx`],
  ];
  for (const [label, scan, text] of cases) {
    test(label, () => {
      const most = PER_CHARACTER * text.length;
      const { work } = scanWork(most, () => scan(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
    });
  }
});
