/**
 * Slugify's `replacements` cost what the call is allowed to grow to,
 * counted, never timed.
 *
 * Keys apply longest first, each to the text the keys before it produced, so
 * a value that holds the next key twenty times multiplied the text by twenty
 * per key: a 347-byte call grew it to 336,841 characters, and each further
 * key multiplied it again. Each key was also a regular-expression pass over
 * the whole text, however many keys there were. The text may now grow to the
 * tool's limit for text, and the passes together may read eight times that;
 * past either the call is refused with a sentence, never cut.
 *
 * The replacement loop 0.7.0 shipped is kept below as the reference.
 */
import { describe, expect, test } from "bun:test";
import { slugify } from "./index";
import { applyReplacements, slugify as slugifyText } from "./lib/slug";

// ---------------------------------------------------------------------------
// the reference
// ---------------------------------------------------------------------------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The replacement loop as 0.7.0 shipped it, but for its name. */
function referenceReplacements(
  text: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let working = text;
  for (const key of Object.keys(replacements).sort((a, b) => b.length - a.length)) {
    const value = ` ${replacements[key] ?? ""} `;
    working = working.replace(new RegExp(escapeRegex(key), "g"), () => value);
  }
  return working;
}

/** xorshift32: the same cases on every run and every machine. */
function generator(seed: number): () => number {
  const state = { x: seed >>> 0 || 1 };
  return () => {
    state.x ^= state.x << 13;
    state.x >>>= 0;
    state.x ^= state.x >>> 17;
    state.x ^= state.x << 5;
    state.x >>>= 0;
    return state.x / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// the meter
// ---------------------------------------------------------------------------

type Fn = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Fn>;

const OVER = Symbol("over the work limit");

/**
 * Run `body`, counting the string work it does: one for each `charCodeAt`,
 * `charAt` and character a string iterator hands out, the characters
 * `slice` and `join` return, and the characters of the string `replace`,
 * `split`, `normalize` and `toLowerCase` run over. Past `limit` the next
 * charge throws, so an expansion that would run away stops at once. What it
 * cannot see is work inside native code that calls none of these (a regular
 * expression's own search); `replace` is charged its whole string instead.
 */
function stringWork<T>(
  limit: number,
  body: () => T,
): { readonly outcome: T | Error | undefined; readonly work: number } {
  const counter = { work: 0, over: false };
  const charge = (n: number): void => {
    if (counter.over) throw OVER;
    counter.work += n;
    if (counter.work > limit) {
      counter.over = true;
      throw OVER;
    }
  };
  const saved: Array<{ target: Methods; name: string; real: Fn }> = [];
  const wrap = (target: Methods, name: string, make: (real: Fn) => Fn): void => {
    const real = target[name] as Fn;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
  const strings = String.prototype as unknown as Methods;
  for (const name of ["charCodeAt", "charAt"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge(1);
          return real.apply(this, args);
        },
    );
  }
  wrap(
    strings,
    "slice",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const out = real.apply(this, args) as string;
        charge(out.length);
        return out;
      },
  );
  for (const name of ["replace", "split", "normalize", "toLowerCase"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge(String(this).length);
          return real.apply(this, args);
        },
    );
  }
  wrap(
    Array.prototype as unknown as Methods,
    "join",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const out = real.apply(this, args) as string;
        charge(out.length);
        return out;
      },
  );
  // Last, and everything from here on by index: a `for…of` would be charged.
  wrap(
    Object.getPrototypeOf(""[Symbol.iterator]()) as Methods,
    "next",
    (real) =>
      function (this: unknown) {
        const out = real.call(this) as IteratorResult<unknown>;
        if (out.done !== true) charge(1);
        return out;
      },
  );
  let outcome: T | Error | undefined;
  try {
    outcome = body();
  } catch (err) {
    if (err !== OVER) outcome = err as Error;
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const one = saved[i] as (typeof saved)[number];
      one.target[one.name] = one.real;
    }
  }
  return counter.over
    ? { outcome: undefined, work: Number.POSITIVE_INFINITY }
    : { outcome, work: counter.work };
}

/**
 * `k` keys, longest first, each one's value holding the next key `copies`
 * times, and the text the longest key: the shape that multiplied the text
 * by `copies` per key.
 */
function cascade(k: number, copies = 20): { text: string; replacements: Record<string, string> } {
  const keys = Array.from({ length: k }, (_, i) => "q".repeat(k - i + 1));
  const replacements: Record<string, string> = {};
  for (let i = 0; i < k; i++) {
    replacements[keys[i] as string] = Array.from({ length: copies }, () => keys[i + 1] ?? "z").join(
      "_",
    );
  }
  return { text: keys[0] as string, replacements };
}

const GREW = "longer than";
const READ = "use fewer keys or a shorter text";

// ---------------------------------------------------------------------------
// old against new
// ---------------------------------------------------------------------------

describe("the replacements give what the 0.7.0 loop gave", () => {
  test("generated texts and keys: overlapping keys, values that hold keys, the empty key, surrogates and pattern characters", () => {
    const random = generator(77);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const PIECES = [
      "a",
      "b",
      "ab",
      "A",
      "&",
      "$",
      "$&",
      "$'",
      "é",
      "é",
      "\u{1F600}",
      "\uD83D",
      "\uDE00",
      "ß",
      "-",
      " ",
      ".",
      "*",
      "\\",
      "(",
      "[",
      "\n",
      "1",
      "10",
    ];
    const piece = (max: number): string => {
      let out = "";
      for (let i = 0, n = Math.floor(random() * (max + 1)); i < n; i++) out += pick(PIECES);
      return out;
    };
    let cases = 0;
    let changed = 0;
    let emptyKey = 0;
    let mismatches = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = piece(8);
      const replacements: Record<string, string> = {};
      for (let j = 0, n = Math.floor(random() * 6); j < n; j++) {
        replacements[random() < 0.05 ? "" : piece(3)] = piece(3);
      }
      const expected = referenceReplacements(text, replacements);
      cases += 1;
      if (expected !== text) changed += 1;
      if ("" in replacements) emptyKey += 1;
      if (applyReplacements(text, replacements, 2_000_000) !== expected) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    expect(cases).toBe(20_000);
    expect(changed).toBeGreaterThan(10_000);
    expect(emptyKey).toBeGreaterThan(1_000);
  }, 60_000);

  test("keys that overlap themselves, where the search must fall back inside the key", () => {
    // "aab" in "aaab": after "aa" the next "a" does not finish the key, and a
    // search that starts the key over from there never sees the match that
    // began one unit earlier. Two letters make keys like that common.
    const fixed: Array<[string, string]> = [
      ["aaab", "aab"],
      ["aaaab", "aaab"],
      ["abababb", "ababb"],
      ["aabaabaaab", "aabaaab"],
      ["abaababaab", "abaab"],
      ["babbabbab", "babbab"],
      // The key's own borders need the fallback too: "aabaaa" falls back to
      // "aa", not to "a".
      ["aabaaabaaaa", "aabaaaa"],
    ];
    for (const [text, key] of fixed) {
      expect(applyReplacements(text, { [key]: "X" }, 100)).toBe(
        referenceReplacements(text, { [key]: "X" }),
      );
    }
    expect(applyReplacements("aaab", { aab: "X" }, 100)).toBe("a X ");

    // A search that starts the key over after a mismatch, which is what a
    // broken fallback does: the cases below must be ones it gets wrong.
    const restarting = (text: string, key: string, value: string): string => {
      let out = "";
      let copied = 0;
      let k = 0;
      for (let i = 0; i < text.length; i++) {
        if (k > 0 && key[k] !== text[i]) k = 0;
        if (key[k] === text[i]) k += 1;
        if (k === key.length) {
          out += text.slice(copied, i + 1 - key.length) + value;
          copied = i + 1;
          k = 0;
        }
      }
      return out + text.slice(copied);
    };
    const random = generator(79);
    const word = (max: number): string => {
      let out = "";
      for (let i = 0, n = Math.floor(random() * (max + 1)); i < n; i++) {
        out += random() < 0.6 ? "a" : "b";
      }
      return out;
    };
    let mismatches = 0;
    let fallbacks = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = word(16);
      const replacements: Record<string, string> = {};
      for (let j = 0, n = 1 + Math.floor(random() * 3); j < n; j++) {
        // Mostly a piece of the text itself, so the key is there to be found.
        const from = Math.floor(random() * text.length);
        const key =
          random() < 0.7 ? text.slice(from, from + 2 + Math.floor(random() * 5)) : word(6);
        if (key !== "") replacements[key] = random() < 0.3 ? word(3) : "X";
      }
      const expected = referenceReplacements(text, replacements);
      if (applyReplacements(text, replacements, 2_000_000) !== expected) mismatches += 1;
      const [first] = Object.keys(replacements).sort((a, b) => b.length - a.length);
      if (
        first !== undefined &&
        restarting(text, first, ` ${replacements[first]} `) !==
          referenceReplacements(text, { [first]: replacements[first] as string })
      ) {
        fallbacks += 1;
      }
    }
    expect(mismatches).toBe(0);
    expect(fallbacks).toBeGreaterThan(1_000);
  }, 60_000);

  test("the slug is the rest of the pipeline over the replaced text, as before", () => {
    const random = generator(78);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const WORDS = [
      "Tom",
      "&",
      "Jerry",
      "Crème",
      "Straße",
      "日本",
      "$&",
      "a-b",
      "  ",
      "!!",
      "\u{1F600}",
    ];
    let mismatches = 0;
    for (let i = 0; i < 3_000; i++) {
      const text = Array.from({ length: Math.floor(random() * 6) }, () => pick(WORDS)).join(
        pick([" ", "", "-"]),
      );
      const replacements: Record<string, string> = {};
      for (let j = 0, n = Math.floor(random() * 4); j < n; j++) {
        replacements[pick(WORDS)] = pick([...WORDS, "and", ""]);
      }
      const options = {
        separator: pick(["-", "_", "", "$&", "--"]),
        lowercase: random() < 0.5,
        allowUnicode: random() < 0.5,
        ...(random() < 0.5 ? { maxLength: pick([1, 3, 8, 40]) } : {}),
      };
      const expected = slugifyText(referenceReplacements(text, replacements), options);
      const got = slugifyText(text, { ...options, replacements });
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the limits
// ---------------------------------------------------------------------------

describe("the text may grow to the limit, and not one character past it", () => {
  const refusal = (body: () => unknown): string => {
    try {
      body();
    } catch (err) {
      return (err as Error).message;
    }
    return "not refused";
  };

  test("one match, two matches, and the empty key, each at the limit and one past it", () => {
    const limit = 100;
    const cases: Array<[string, Record<string, string>, number]> = [
      // " " + value + " " replaces "a": 100 characters.
      ["a", { a: "x".repeat(98) }, 100],
      // Two matches and the two dots after them: 2 × 49 + 2.
      ["a.a.", { a: "x".repeat(47) }, 100],
      // The empty key goes before every unit and at the end; of "" that is once.
      ["", { "": "x".repeat(98) }, 100],
      // Text after the last match: one past the limit is reached only once
      // that tail is counted, after the match itself fit.
      ["xxaxx", { a: "v".repeat(94) }, 100],
    ];
    for (const [text, replacements, length] of cases) {
      const at = applyReplacements(text, replacements, limit);
      expect(at).toBe(referenceReplacements(text, replacements));
      expect(at.length).toBe(length);
      const key = Object.keys(replacements)[0] as string;
      const over = { [key]: `${replacements[key]}x` };
      expect(referenceReplacements(text, over).length).toBeGreaterThan(limit);
      expect(refusal(() => applyReplacements(text, over, limit))).toContain(
        `${GREW} ${limit} characters`,
      );
    }
  });

  test("the passes may read eight times the limit, and not one pass more", () => {
    const limit = 100;
    const text = "z".repeat(limit);
    const keys = (n: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(applyReplacements(text, keys(8), limit)).toBe(text);
    expect(refusal(() => applyReplacements(text, keys(9), limit))).toContain(READ);
  });

  test("at the Slugify tool's own limit for text", () => {
    const limit = 2_000_000;
    expect(applyReplacements("a", { a: "x".repeat(limit - 2) }, limit).length).toBe(limit);
    expect(refusal(() => applyReplacements("a", { a: "x".repeat(limit - 1) }, limit))).toContain(
      `${GREW} ${limit} characters`,
    );
  });
});

describe("what a call can make the replacements do is counted", () => {
  test("keys whose values hold the next key: refused within a few times the limit, however many keys", () => {
    // Twelve keys would multiply the text by 20^12.
    const { text, replacements } = cascade(12);
    const counted = [20_000, 40_000].map((limit) => ({
      limit,
      ...stringWork(8 * limit, () => applyReplacements(text, replacements, limit)),
    }));
    for (const { limit, outcome, work } of counted) {
      expect(work).toBeLessThanOrEqual(8 * limit);
      expect((outcome as Error).message).toContain(`${GREW} ${limit} characters`);
    }
    const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
    expect(large.work / small.work).toBeLessThan(2.25);
  });

  test("a key that keeps nearly matching is searched in one read of the text", () => {
    // "bb…bac" against "bb…b": a search that tries the whole key from every
    // position reads n × m characters; this one reads each unit once.
    const counted = [10_000, 20_000].map((n) => {
      const text = "b".repeat(n);
      const key = `${"b".repeat(n / 2 - 2)}ac`;
      return { n, ...stringWork(8 * n, () => applyReplacements(text, { [key]: "v" }, 2_000_000)) };
    });
    for (const { n, outcome, work } of counted) {
      expect(outcome).toBe("b".repeat(n));
      expect(work).toBeLessThanOrEqual(8 * n);
      expect(work).toBeGreaterThanOrEqual(n);
    }
  });

  test("thousands of keys over a long text: refused after eight passes' reading", () => {
    const limit = 2_000;
    const text = "z".repeat(limit);
    const replacements = Object.fromEntries(
      Array.from({ length: 3_000 }, (_, i) => [`k${i}`, "v"]),
    );
    const { outcome, work } = stringWork(32 * limit, () =>
      applyReplacements(text, replacements, limit),
    );
    expect((outcome as Error).message).toContain(READ);
    expect(work).toBeLessThanOrEqual(32 * limit);
  });
});

// ---------------------------------------------------------------------------
// through the tool
// ---------------------------------------------------------------------------

describe("Slugify with replacements that multiply the text", () => {
  test("four keys stay under the limit and give the slug they always gave", async () => {
    // The 347-byte call that grew the text to 336,841 characters.
    const { text, replacements } = cascade(4);
    const expected = slugifyText(referenceReplacements(text, replacements), { maxLength: 80 });
    const out = JSON.parse(
      (await slugify.execute({ text, maxLength: 80, replacements })) as string,
    );
    expect(out).toEqual({ slug: expected.slug, truncated: true });
  });

  test("a fifth key would pass the limit for text, and the call says so", async () => {
    const { text, replacements } = cascade(5);
    const out = (await slugify.execute({ text, maxLength: 80, replacements })) as string;
    expect(out).toContain(`${GREW} 2000000 characters, the limit for text`);
    expect(out).toContain("a value that holds a later key is expanded again");
  });
});
