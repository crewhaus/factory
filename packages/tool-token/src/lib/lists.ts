/**
 * Token lists, and the reason a symbol is not an identifier.
 *
 * A symbol is a string a deployer chose. Nothing enforces uniqueness, nothing
 * stops a second contract from calling itself USDC with six decimals and a
 * convincing name, and two reputable lists routinely carry different
 * addresses for the same ticker on the same chain. So the matching here never
 * picks: it gathers every entry a query could plausibly mean and hands the
 * whole set back. Choosing between two addresses that both say "USDC" is a
 * decision with a wrong answer that costs money, and it is not a decision a
 * string match is entitled to make.
 *
 * ## The skeleton, and why folding is safe HERE
 *
 * `confusableSkeleton` folds a symbol towards ASCII so that "USDC" and
 * "USDС" — the second with a Cyrillic С — land on the same key. It is a
 * deliberately small table: the common Latin/Cyrillic/Greek homoglyphs,
 * invisible formatting characters, and two digit shapes. It is NOT UTS-39,
 * and a symbol that survives it is not thereby proven safe.
 *
 * That looseness is affordable because of the DIRECTION the fold is used in.
 * It only ever WIDENS the candidate set, and a wider set can only move the
 * answer towards a refusal — it can never resolve a query to a different
 * address. This is exactly the property ENS normalisation does not have,
 * which is why `EnsResolve` is not in this package: there, a fold that is
 * wrong by one codepoint resolves a name to the wrong address and sends funds
 * there, so it needs the real UTS-46 table and a real dependency.
 */
import { createHash } from "node:crypto";

/** One token as a list carries it. This is the Uniswap token-list shape. */
export type TokenListEntry = {
  readonly chainId: number;
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly tags?: ReadonlyArray<string>;
};

export type TokenList = {
  /** How the answer refers to this list. Two lists may not share an id. */
  readonly id: string;
  readonly name?: string;
  readonly tokens: ReadonlyArray<TokenListEntry>;
};

/** One list's claim about one address. */
export type ListClaim = {
  readonly listId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly tags: ReadonlyArray<string>;
};

export type MatchKind = "address" | "symbol" | "name" | "symbol-confusable" | "name-confusable";

/** One address a query could mean, with every list that carries it. */
export type Candidate = {
  /** Lowercase. Addresses are compared lowercased; the checksummed form is for display. */
  readonly address: string;
  readonly claims: ReadonlyArray<ListClaim>;
  readonly matchedBy: ReadonlyArray<MatchKind>;
};

// ---------------------------------------------------------------------------
// the skeleton
// ---------------------------------------------------------------------------

/**
 * Code points that occupy no width, as explicit ranges.
 *
 * A table rather than a character class on purpose: a regex whose source
 * contains the very characters it matches is unreadable, unreviewable, and one
 * careless paste away from silently losing an entry. Every code point below is
 * written as a number and named.
 *
 * A symbol padded with these is a different string from the one a human reads,
 * which is the entire trick: "USD" + U+200B + "C" displays as USDC in every
 * wallet and matches nothing a caller typed.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // arabic letter mark
  [0x115f, 0x1160], // hangul choseong and jungseong fillers
  [0x17b4, 0x17b5], // khmer inherent vowels, which render as nothing
  [0x180b, 0x180e], // mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space and joiners, LTR and RTL marks
  [0x202a, 0x202e], // bidi embeddings and overrides - the Trojan Source shape
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // bidi isolates and deprecated format characters
  [0x3164, 0x3164], // hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte order mark, also known as zero-width no-break space
  [0xffa0, 0xffa0], // halfwidth hangul filler
  [0xe0000, 0xe007f], // tag characters
]);

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** The text with every zero-width and formatting character removed. */
export function stripInvisible(text: string): string {
  let out = "";
  for (const ch of text) if (!isInvisible(ch.codePointAt(0) as number)) out += ch;
  return out;
}

/** Which invisible code points are present, in order, so a report can name them. */
export function invisibleCodePoints(text: string): ReadonlyArray<number> {
  const out: number[] = [];
  for (const ch of text) {
    const point = ch.codePointAt(0) as number;
    if (isInvisible(point)) out.push(point);
  }
  return out;
}

/** Combining marks, which NFKD leaves behind after decomposing an accent. */
const COMBINING = /\p{M}/gu;

/**
 * The homoglyph table, lowercase, applied after case folding. Small on
 * purpose — see the note at the top of this file about which direction a
 * wrong fold can move the answer.
 */
const CONFUSABLE: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  а: "a",
  б: "b",
  в: "b",
  е: "e",
  ё: "e",
  ѕ: "s",
  і: "i",
  ј: "j",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  // Greek
  α: "a",
  β: "b",
  ε: "e",
  ζ: "z",
  η: "n",
  ι: "i",
  κ: "k",
  μ: "u",
  ν: "v",
  ο: "o",
  ρ: "p",
  σ: "o",
  τ: "t",
  υ: "u",
  χ: "x",
  ϲ: "c",
  // Latin letters NFKD does not decompose
  ł: "l",
  ø: "o",
  đ: "d",
  ħ: "h",
  ı: "i",
  ȷ: "j",
  ſ: "s",
});

/** Digit shapes that read as letters in an all-caps ticker. */
const DIGIT_SHAPE: Readonly<Record<string, string>> = Object.freeze({
  "0": "o",
  "1": "l",
  "|": "l",
  "!": "l",
  "5": "s",
});

/**
 * Fold a symbol or a name towards a comparison key.
 *
 * Only ever used to ADD candidates. Never used to decide which address a
 * query resolves to.
 */
export function confusableSkeleton(text: string): string {
  const stripped = stripInvisible(text).normalize("NFKD").replace(COMBINING, "");
  let out = "";
  for (const ch of stripped.toLowerCase()) {
    out += CONFUSABLE[ch] ?? DIGIT_SHAPE[ch] ?? ch;
  }
  return out.trim();
}

/** What is odd about a piece of text a contract or a list supplied. */
export type TextConcern = {
  readonly code: "invisible-characters" | "non-ascii" | "confusable" | "whitespace" | "over-long";
  readonly detail: string;
};

const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

/**
 * Everything worth saying about a symbol or a name before a human reads it.
 *
 * These are reported, not acted on. A legitimate token can have a non-ASCII
 * name; none of them need a zero-width space in the ticker.
 */
export function textConcerns(text: string): ReadonlyArray<TextConcern> {
  const out: TextConcern[] = [];
  const invisible = invisibleCodePoints(text);
  if (invisible.length > 0) {
    const points = [...new Set(invisible)]
      .map((point) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(", ");
    out.push({
      code: "invisible-characters",
      detail: `contains ${invisible.length} zero-width or formatting character(s): ${points}`,
    });
  }
  if (!ASCII_PRINTABLE.test(stripInvisible(text))) {
    out.push({ code: "non-ascii", detail: "contains characters outside printable ASCII" });
    const skeleton = confusableSkeleton(text);
    if (skeleton !== text.toLowerCase().trim()) {
      out.push({
        code: "confusable",
        detail: `folds to "${skeleton}", so it displays like a different ticker than it is`,
      });
    }
  }
  if (/^\s|\s$|[\r\n\t]/.test(text)) {
    out.push({ code: "whitespace", detail: "has leading, trailing or embedded whitespace" });
  }
  if (text.length > 64) {
    out.push({ code: "over-long", detail: `${text.length} characters is not a symbol or a name` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

export const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A stable digest of the lists a resolution was made against.
 *
 * Reproducibility evidence, not a security control: the same query against
 * the same fingerprint gives the same candidates, and a fingerprint that
 * moved explains why yesterday's answer differs from today's. Only the fields
 * that affect the outcome go in, sorted, so a list that reordered its tokens
 * or gained a logo URL still fingerprints the same.
 */
export function fingerprintLists(lists: ReadonlyArray<TokenList>, chainId: number): string {
  const rows: string[] = [];
  for (const list of lists) {
    for (const token of list.tokens) {
      if (token.chainId !== chainId) continue;
      rows.push(
        `${list.id}\u0000${token.address.toLowerCase()}\u0000${token.symbol}\u0000${token.name}\u0000${token.decimals}`,
      );
    }
  }
  rows.sort();
  return `sha256:${createHash("sha256").update(rows.join("\n")).digest("hex")}`;
}

function claimOf(list: TokenList, token: TokenListEntry): ListClaim {
  return {
    listId: list.id,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    tags: token.tags ?? [],
  };
}

/**
 * Every address on the given lists that the query could mean, for one chain.
 *
 * Matching is by exact symbol, exact name, and by confusable skeleton of
 * both. The four are reported separately in `matchedBy` so the caller can see
 * WHY an address is in the set — a candidate that only matched by skeleton is
 * the impostor the literal match would have missed.
 */
export function findCandidates(
  lists: ReadonlyArray<TokenList>,
  chainId: number,
  query: string,
): ReadonlyArray<Candidate> {
  const wanted = query.trim();
  const byAddress = ADDRESS_SHAPE.test(wanted) ? wanted.toLowerCase() : null;
  const folded = wanted.toLowerCase();
  const skeleton = confusableSkeleton(wanted);

  const found = new Map<string, { claims: ListClaim[]; matchedBy: Set<MatchKind> }>();
  const note = (address: string, claim: ListClaim, kind: MatchKind): void => {
    const key = address.toLowerCase();
    const entry = found.get(key) ?? { claims: [], matchedBy: new Set<MatchKind>() };
    if (!entry.claims.some((c) => c.listId === claim.listId)) entry.claims.push(claim);
    entry.matchedBy.add(kind);
    found.set(key, entry);
  };

  for (const list of lists) {
    for (const token of list.tokens) {
      if (token.chainId !== chainId) continue;
      const claim = claimOf(list, token);
      if (byAddress !== null) {
        if (token.address.toLowerCase() === byAddress) note(token.address, claim, "address");
        continue;
      }
      const symbol = token.symbol ?? "";
      const name = token.name ?? "";
      if (symbol.toLowerCase() === folded) note(token.address, claim, "symbol");
      else if (confusableSkeleton(symbol) === skeleton)
        note(token.address, claim, "symbol-confusable");
      if (name.toLowerCase() === folded) note(token.address, claim, "name");
      else if (confusableSkeleton(name) === skeleton) note(token.address, claim, "name-confusable");
    }
  }

  return [...found.entries()]
    .map(([address, entry]) => ({
      address,
      claims: entry.claims,
      matchedBy: [...entry.matchedBy].sort(),
    }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/** The distinct decimals the lists claim for one address, in order found. */
export function claimedDecimals(candidate: Candidate): ReadonlyArray<number> {
  return [...new Set(candidate.claims.map((c) => c.decimals))];
}

/** The distinct symbols the lists claim for one address. */
export function claimedSymbols(candidate: Candidate): ReadonlyArray<string> {
  return [...new Set(candidate.claims.map((c) => c.symbol))];
}
