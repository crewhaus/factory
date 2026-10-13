/**
 * Overlaps are resolved in O(k log k), and spans are applied in one copy.
 *
 * `dedupeOverlaps` checked each ranked candidate against every finding kept
 * before it, and `secretFindings` checked each high-entropy candidate against
 * every finding pushed before it: k(k-1)/2 checks in the findings. PiiScan,
 * PiiRedact, SecretScan and RedactForExport take 2M characters, and an IP log
 * or a mailing-list export at that size holds a few hundred thousand
 * findings, so that was tens of billions of checks in one uninterruptible
 * call. `applySpans` then rebuilt the whole text once per span. A
 * `SpanIndex` now answers "does this overlap anything kept so far?" in
 * O(log k), and the spans are joined in one pass.
 *
 * Each rewrite is checked against the code it replaced on generated finding
 * sets (nested, touching, identical, empty, equal ranks, and offsets no
 * detector produces) and on generated logs, mail exports and secret-laden
 * text. The work is counted, never timed: the array searches, iterators and
 * string copies with tool-code's __test__/js-work.ts, and the slots and
 * probes each `SpanIndex` visits through its `steps`. The old loops go past
 * the same bounds, and stop there at once rather than running on.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { scanPii } from "./lib/pii";
import { redactFindings } from "./lib/redact";
import { secretFindings } from "./lib/secrets";
import {
  type Confidence,
  type Finding,
  SpanIndex,
  applySpans,
  compareStrings,
  dedupeOverlaps,
  sortFindings,
} from "./lib/text";

// ---------------------------------------------------------------------------
// The code as it was.

const OLD_RANK: Readonly<Record<Confidence, number>> = { verified: 3, likely: 2, possible: 1 };

function oldDedupeOverlaps(findings: ReadonlyArray<Finding>): Finding[] {
  const ranked = [...findings].sort((a, b) => {
    const byConfidence = OLD_RANK[b.confidence] - OLD_RANK[a.confidence];
    if (byConfidence !== 0) return byConfidence;
    const byLength = b.end - b.start - (a.end - a.start);
    if (byLength !== 0) return byLength;
    if (a.start !== b.start) return a.start - b.start;
    return compareStrings(a.rule, b.rule);
  });
  const kept: Finding[] = [];
  for (const candidate of ranked) {
    const clashes = kept.some((k) => candidate.start < k.end && k.start < candidate.end);
    if (!clashes) kept.push(candidate);
  }
  return sortFindings(kept);
}

function oldApplySpans(
  text: string,
  findings: ReadonlyArray<Finding>,
  replace: (finding: Finding) => string,
): string {
  const ordered = sortFindings(findings);
  let out = text;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const f = ordered[i];
    if (!f) continue;
    out = out.slice(0, f.start) + replace(f) + out.slice(f.end);
  }
  return out;
}

/**
 * `secretFindings` as it was, from its unchanged parts: the rule findings
 * (`highEntropy: false`), the high-entropy candidates that pass the filters
 * (`rules: []`, so nothing covers them), and the old loop between them. No
 * two findings tie on start, end, type and rule, so the final sort orders
 * them the same whichever order they were pushed in.
 */
function oldSecretFindings(text: string, options: Parameters<typeof secretFindings>[1]): Finding[] {
  const raw = secretFindings(text, { ...options, highEntropy: false });
  if (options?.highEntropy === false) return raw;
  for (const c of secretFindings(text, { ...options, rules: [] })) {
    if (raw.some((f) => c.start < f.end && f.start < c.end)) continue;
    raw.push(c);
  }
  return sortFindings(raw);
}

// ---------------------------------------------------------------------------
// Inputs.

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONFIDENCES: ReadonlyArray<Confidence> = ["verified", "likely", "possible"];
const ODD_OFFSETS = [Number.NaN, -1, -0, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const finding = (
  type: string,
  rule: string,
  confidence: Confidence,
  start: number,
  end: number,
): Finding => ({ type, rule, confidence, start, end, line: 1, column: 1, value: "v" });

/**
 * Finding sets with every shape an overlap pass meets: nested, touching and
 * identical spans, empty ones, ranks that tie on everything but the rule,
 * and, once in a while, offsets no detector produces.
 */
function findingSets(count: number, odd: boolean): Finding[][] {
  const next = rng(0x5eed0001 + (odd ? 1 : 0));
  const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
  const int = (n: number) => Math.floor(next() * n);
  const sets: Finding[][] = [];
  for (let s = 0; s < count; s++) {
    const out: Finding[] = [];
    const width = 1 + int(60);
    const n = int(30);
    for (let i = 0; i < n; i++) {
      let start = int(width);
      let end = start + int(8);
      const prior = out.length > 0 ? pick(out) : undefined;
      switch (int(odd ? 10 : 9)) {
        case 0:
          end = start;
          break;
        case 1:
          if (prior) [start, end] = [prior.start, prior.end];
          break;
        case 2:
          if (prior) [start, end] = [prior.end, prior.end + int(5)];
          break;
        case 3:
          if (prior) {
            start = prior.start + int(Math.max(1, prior.end - prior.start));
            end = Math.min(prior.end, start + int(4));
          }
          break;
        case 9:
          start = pick([...ODD_OFFSETS, start]);
          end = pick([...ODD_OFFSETS, start - 2, end]);
          break;
      }
      out.push(
        finding(
          pick(["email", "phone", "ip_address"]),
          pick(["r1", "r2"]),
          pick(CONFIDENCES),
          start,
          end,
        ),
      );
    }
    sets.push(out);
  }
  return sets;
}

/**
 * Text of the kinds these tools are handed: a dense access log, a mailing-
 * list export, and secrets mixed with PII and noise. Credentials are built
 * from parts so the source holds no token-shaped literal.
 */
function texts(count: number): string[] {
  const next = rng(0x5eed0002);
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: ReadonlyArray<T>): T => xs[int(xs.length)] as T;
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const blob = (n: number, alphabet = ALNUM) => {
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[int(alphabet.length)];
    return s;
  };
  const piece = (): string => {
    switch (int(24)) {
      case 0:
        return `${int(256)}.${int(256)}.${int(256)}.${int(256)}`;
      case 1:
        return pick(["::1", "fe80::1", "2001:db8::7"]);
      case 2:
        return `a${int(500)}@b.co`;
      case 3:
        return `+1 415 555 ${String(int(10_000)).padStart(4, "0")}`;
      case 4:
        return `${100 + int(800)}-${10 + int(89)}-${1000 + int(8999)}`;
      case 5:
        return pick(["4111111111111111", "4111 1111 1111 1111", "378282246310005"]);
      case 6:
        return pick(["DE89370400440532013000", "GB82 WEST 1234 5698 7654 32"]);
      case 7:
        return pick(["DOB: 1990-01-02", "born 02/03/1985", "Springfield, IL 62704"]);
      case 8:
        return `${"gh"}p_${blob(36)}`;
      case 9:
        return `token=${"gh"}p_${blob(36)}`;
      case 10:
        return `${"AK"}IA${blob(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
      case 11:
        return `${"sk"}-ant-${blob(24 + int(20))}`;
      case 12:
        return `${"ey"}J${blob(10)}.${"ey"}J${blob(12)}.${blob(12)}`;
      case 13:
        return `password = "${blob(8 + int(20))}"`;
      case 14:
        return `secret=${blob(20 + int(60), `${ALNUM}+/=_-`)}`;
      case 15:
        return `Authorization: Basic ${blob(12 + int(20), `${ALNUM}+/=`)}`;
      case 16:
        return `postgres://${pick(["user", "admin_hunter2"])}:${blob(10)}@db.example.com/x`;
      case 17:
        return `session ${blob(20 + int(100), `${ALNUM}+/=_-`)}`;
      case 18:
        return blob(20 + int(100), `${ALNUM}+/=_-`);
      case 19:
        return pick(["xxxx", "<your-token>", "changeme123456789012345"]);
      default:
        return blob(1 + int(6), "abc XYZ.:-@/_=+0123456789");
    }
  };
  const out: string[] = [];
  for (let t = 0; t < count; t++) {
    const n = 1 + int(30);
    let s = "";
    for (let i = 0; i < n; i++) {
      switch (t % 3) {
        case 0:
          s += `10.0.${int(4)}.${int(256)} - - [12/Oct/2026:10:00:00 +0000] "GET /${blob(int(8))}" 200 ${piece()}\n`;
          break;
        case 1:
          s += `From: ${blob(5)} <a${int(300)}@b.co>\nTo: list@ex.org\nCc: ${piece()}\n\n${piece()} ${piece()}\n`;
          break;
        default:
          s +=
            piece() +
            pick([" ", "\n", ", ", "; ", "<", ">", '"', "=", ":", "", " token ", " password="]);
      }
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counting.

/** Run `body`, adding up the slots and probes every `SpanIndex` visits. */
function indexSteps<T>(body: () => T): { value: T; steps: number; calls: number } {
  const proto = SpanIndex.prototype;
  const realOverlaps = proto.overlaps;
  const realAdd = proto.add;
  const tally = { steps: 0, calls: 0 };
  proto.overlaps = function (this: SpanIndex, start: number, end: number) {
    const before = this.steps;
    try {
      return realOverlaps.call(this, start, end);
    } finally {
      tally.steps += this.steps - before;
      tally.calls += 1;
    }
  };
  proto.add = function (this: SpanIndex, start: number, end: number) {
    const before = this.steps;
    try {
      realAdd.call(this, start, end);
    } finally {
      tally.steps += this.steps - before;
      tally.calls += 1;
    }
  };
  try {
    const value = body();
    return { value, steps: tally.steps, calls: tally.calls };
  } finally {
    proto.overlaps = realOverlaps;
    proto.add = realAdd;
  }
}

/** Array and string work plus index steps; Infinity once past `limit`. */
function counted<T>(limit: number, body: () => T): { value: T | undefined; work: number } {
  const run = jsWork(limit, () => indexSteps(body));
  if (run.value === undefined) return { value: undefined, work: run.work };
  return { value: run.value.value, work: run.work + run.value.steps };
}

const log2 = (n: number) => Math.log2(Math.max(2, n));

// ---------------------------------------------------------------------------

describe("SpanIndex answers the overlap test the old loops made", () => {
  test("against a check of every span added, on generated sequences", () => {
    const next = rng(0x5eed0003);
    const int = (n: number) => Math.floor(next() * n);
    const value = (base: number) =>
      next() < 0.08 ? (ODD_OFFSETS[int(ODD_OFFSETS.length)] as number) : base;
    let questions = 0;
    let yes = 0;
    const differ: string[] = [];
    for (let s = 0; s < 4_000; s++) {
      const width = 1 + int(50);
      const ops: Array<{ add: boolean; start: number; end: number }> = [];
      for (let i = int(40); i > 0; i--) {
        const start = value(int(width));
        ops.push({ add: next() < 0.5, start, end: value(start + int(8) - (next() < 0.1 ? 3 : 0)) });
      }
      const index = new SpanIndex(ops.filter((o) => o.add).map((o) => o.start));
      const added: Array<{ start: number; end: number }> = [];
      for (const op of ops) {
        const expected = added.some((k) => op.start < k.end && k.start < op.end);
        const got = index.overlaps(op.start, op.end);
        questions += 1;
        if (expected) yes += 1;
        if (got !== expected) differ.push(JSON.stringify({ ops, op }));
        if (op.add) {
          index.add(op.start, op.end);
          added.push(op);
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(questions).toBeGreaterThan(50_000);
    expect(yes).toBeGreaterThan(10_000);
    expect(questions - yes).toBeGreaterThan(10_000);
  }, 20_000);

  test("a start it was not built with is refused rather than misfiled", () => {
    const index = new SpanIndex([0, 10]);
    expect(() => index.add(5, 6)).toThrow(/was not named/);
    index.add(Number.NaN, 4);
    index.add(0, Number.NaN);
    expect(index.overlaps(0, 100)).toBe(false);
  });
});

describe("dedupeOverlaps keeps what it kept before", () => {
  test("on generated finding sets, the same objects in the same order", () => {
    const differ: string[] = [];
    let total = 0;
    let kept = 0;
    for (const odd of [false, true]) {
      for (const set of findingSets(6_000, odd)) {
        const old = oldDedupeOverlaps(set);
        const ours = dedupeOverlaps(set);
        total += set.length;
        kept += old.length;
        if (old.length !== ours.length || old.some((f, i) => f !== ours[i])) {
          differ.push(JSON.stringify(set));
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(total).toBeGreaterThan(150_000);
    // Plenty are dropped and plenty survive, so both branches are exercised.
    expect(kept).toBeGreaterThan(0.3 * total);
    expect(kept).toBeLessThan(0.7 * total);
  }, 20_000);

  test("on PII and secret findings in generated logs, mail exports and mixed text", () => {
    const differ: string[] = [];
    let found = 0;
    for (const text of texts(900)) {
      const pii = scanPii(text);
      const both = [...secretFindings(text), ...pii];
      found += both.length;
      for (const set of [pii, both]) {
        if (JSON.stringify(oldDedupeOverlaps(set)) !== JSON.stringify(dedupeOverlaps(set))) {
          differ.push(JSON.stringify(text));
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(found).toBeGreaterThan(10_000);
  }, 60_000);
});

describe("secretFindings finds what it found before", () => {
  test("on generated text, under each option the tools pass", () => {
    const options = [
      {},
      { requireContext: false },
      { minEntropy: 3 },
      { rules: ["github.token", "jwt.compact"] },
      { highEntropy: false },
    ] as const;
    const differ: string[] = [];
    let found = 0;
    let entropy = 0;
    let covered = 0;
    for (const [i, text] of texts(900).entries()) {
      const opts = options[i % options.length];
      const old = oldSecretFindings(text, opts);
      const ours = secretFindings(text, opts);
      found += old.length;
      entropy += old.filter((f) => f.rule === "generic.high-entropy").length;
      if (opts?.highEntropy !== false) {
        covered += secretFindings(text, { ...opts, rules: [] }).length;
      }
      if (JSON.stringify(old) !== JSON.stringify(ours)) differ.push(JSON.stringify([text, opts]));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(found).toBeGreaterThan(2_000);
    expect(entropy).toBeGreaterThan(300);
    // Candidates a rule finding covers were dropped, so that branch ran too.
    expect(covered - entropy).toBeGreaterThan(300);
  }, 30_000);
});

describe("applySpans writes what it wrote before", () => {
  test("with replace called in the same order, on spans in and out of its contract", () => {
    const differ: string[] = [];
    let spans = 0;
    for (const odd of [false, true]) {
      for (const [i, set] of findingSets(3_000, odd).entries()) {
        const text = "abcdefgh ".repeat(4 + (i % 9));
        for (const chosen of [set, oldDedupeOverlaps(set)]) {
          const order = { old: [] as number[], ours: [] as number[] };
          const old = oldApplySpans(text, chosen, (f) => {
            order.old.push(f.start);
            return `[${f.start}]`;
          });
          const ours = applySpans(text, chosen, (f) => {
            order.ours.push(f.start);
            return `[${f.start}]`;
          });
          spans += chosen.length;
          if (old !== ours || JSON.stringify(order.old) !== JSON.stringify(order.ours)) {
            differ.push(JSON.stringify([text, chosen]));
          }
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(spans).toBeGreaterThan(100_000);
  }, 20_000);

  test("on the spans RedactForExport removes", () => {
    const differ: string[] = [];
    for (const text of texts(600)) {
      const spans = dedupeOverlaps([...secretFindings(text), ...scanPii(text)]);
      const label = (f: Finding) => `[${f.type.toUpperCase()}]`;
      if (oldApplySpans(text, spans, label) !== redactFindings(text, spans, label)) {
        differ.push(JSON.stringify(text));
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
  }, 30_000);
});

describe("the work grows with the findings, not their square", () => {
  // The bounds are a few times what the passes take: k log k index steps,
  // and a handful of array and string operations per finding or character.
  // The old loops take k(k-1)/2 checks on the same inputs.
  const ipLog = (k: number) => "10.0.0.1 ".repeat(k);

  test("dedupeOverlaps, on an IP log where every finding survives", () => {
    const rows = [4_000, 8_000].map((k) => {
      const found = scanPii(ipLog(k));
      const bound = 8 * k * log2(k);
      const run = counted(bound, () => dedupeOverlaps(found));
      return { k, found: found.length, kept: run.value?.length, work: run.work, bound };
    });
    for (const row of rows) {
      expect(row.work).toBeLessThanOrEqual(row.bound);
      expect([row.found, row.kept]).toEqual([row.k, row.k]);
    }
    // Twice the findings, a little over twice the work.
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.work / small.work).toBeLessThan(2.4);
  }, 20_000);

  test("dedupeOverlaps, ranked so each survivor lands left of those before it", () => {
    // Longer spans rank first; here the spans lengthen to the right, so each
    // one kept starts before every one already kept.
    const k = 8_000;
    const found = Array.from({ length: k }, (_, i) =>
      finding("t", "r", "likely", i * 64, i * 64 + 1 + Math.floor((i * 62) / k)),
    );
    const bound = 8 * k * log2(k);
    const run = counted(bound, () => dedupeOverlaps(found));
    expect(run.work).toBeLessThanOrEqual(bound);
    expect(run.value?.length).toBe(k);
  }, 20_000);

  test("secretFindings, on lines where a rule finding covers each candidate", () => {
    const line = `token=${"gh"}p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5\n`;
    const rows = [4_000, 8_000].map((k) => {
      const text = line.repeat(k);
      const bound = 12 * text.length;
      const run = counted(bound, () => secretFindings(text));
      return { k, found: run.value?.length, work: run.work, bound };
    });
    for (const row of rows) {
      expect(row.work).toBeLessThanOrEqual(row.bound);
      expect(row.found).toBe(row.k);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.work / small.work).toBeLessThan(2.4);
  }, 20_000);

  test("applySpans copies the text once, not once per span", () => {
    const rows = [4_000, 8_000].map((k) => {
      const text = ipLog(k);
      const spans = dedupeOverlaps(scanPii(text));
      const bound = 2 * text.length + 8 * k;
      const run = counted(bound, () => applySpans(text, spans, () => "[IP]"));
      return { k, spans: spans.length, out: run.value, work: run.work, bound };
    });
    for (const row of rows) {
      expect(row.work).toBeLessThanOrEqual(row.bound);
      expect(row.spans).toBe(row.k);
      expect(row.out === "[IP] ".repeat(row.k)).toBe(true);
    }
  }, 20_000);

  test("control: the count sees each old loop go past its bound", () => {
    const k = 8_000;
    const found = scanPii(ipLog(k));
    const bound = 8 * k * log2(k);
    expect(counted(bound, () => oldDedupeOverlaps(found)).work).toBe(Number.POSITIVE_INFINITY);
    expect(
      counted(2 * ipLog(k).length + 8 * k, () => oldApplySpans(ipLog(k), found, () => "[IP]")).work,
    ).toBe(Number.POSITIVE_INFINITY);
    const line = `token=${"gh"}p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5\n`;
    const text = line.repeat(k);
    expect(counted(12 * text.length, () => oldSecretFindings(text, {})).work).toBe(
      Number.POSITIVE_INFINITY,
    );
  }, 20_000);
});
