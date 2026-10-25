/**
 * Does a run of words assert something, or only name it? Two places in the
 * extractor have to tell a sentence from a noun phrase, with no parser to
 * ask:
 *
 * - a heading, which is a section's title unless it is a sentence stating a
 *   figure ("## Refunds close after 30 days", "## AWS revenue rose 25% in
 *   2024" — design §2), read by `statesAsSentence`;
 * - the clause after an acknowledgement before a question ("Got it — 2
 *   seats, correct?"), which says the reader's request back unless it
 *   asserts ("Sure — refunds close after 30 days, anything else?"), read by
 *   `restatesRequest`.
 *
 * The two lean opposite ways, because their mistakes cost differently. A
 * title is the common case for a heading, so a heading is a claim only where
 * a finite verb is plain: a form of "be" or "do", a modal, a negation, or a
 * verb from the closed lists below where it stands after a subject. A clause
 * after "Sure —" with a figure in it is a claim unless it is plainly a
 * restatement — a figure and the noun it counts, and the prepositions and
 * articles around them ("2 adults and 1 child", "for the 3 files", "invoice
 * #1042") — because one the extractor skips is one the gate passes unread
 * (design §0: tests A, B and C are un-servable even when the model
 * misbehaves), and a restatement read as a claim costs a citation asked for.
 */
/** A word as these tests read it: lowercased, its punctuation and Markdown
 *  taken off, a curly apostrophe straightened; and whether it was written
 *  with a capital (a name: "the Grand Hotel"). */
type Word = { readonly word: string; readonly capital: boolean };

/** What may stand around a word without being part of it. */
const LEADING = /^[^\p{L}\p{N}#$€£¥+−-]+/u;
const TRAILING = /[^\p{L}\p{N}%]+$/u;

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const raw of text.replace(/’/g, "'").split(/\s+/)) {
    const bare = raw.replace(LEADING, "").replace(TRAILING, "");
    if (bare === "") continue;
    out.push({ word: bare.toLowerCase(), capital: /^\p{Lu}/u.test(bare) });
  }
  return out;
}

/** Number words a count is written with. "one" and "a" count here: in a
 *  restatement they stand where a numeral would ("one adult and two
 *  children"). */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
  "dozen",
  "half",
  "single",
  "couple",
]);

/** Is the word a figure: a numeral in any spelling ("30", "3pm", "#1042",
 *  "$45", "30-day"), or a number word ("six", "twenty-four")? */
function isFigure(word: string): boolean {
  return /\p{N}/u.test(word) || word.split("-").some((part) => NUMBER_WORDS.has(part));
}

/** A figure of one, so the noun after it is singular: "1 test", "one seat". */
const SINGULAR = /^(?:1|one|single)$/;

/** Plurals that do not end in -s. */
const IRREGULAR_PLURALS: ReadonlySet<string> = new Set([
  "people",
  "children",
  "men",
  "women",
  "feet",
  "teeth",
  "mice",
  "geese",
]);

/** Does the word read as a plural noun: "refunds", "meetings", "people" —
 *  not "class", "bus", "analysis", and not a possessive? */
function isPlural(word: string): boolean {
  if (IRREGULAR_PLURALS.has(word)) return true;
  return word.length >= 3 && /s$/.test(word) && !/(?:ss|us|is|'s)$/.test(word);
}

/** A form of "be", "do" or "have", or a modal: a finite verb wherever it
 *  stands after a word. "may" is left out — "May 3" is a date far more
 *  often than a modal. */
const AUXILIARIES: ReadonlySet<string> = new Set([
  "is",
  "are",
  "was",
  "were",
  "am",
  "be",
  "been",
  "being",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "has",
  "have",
  "had",
  "hasn't",
  "haven't",
  "hadn't",
  "do",
  "does",
  "did",
  "don't",
  "doesn't",
  "didn't",
  "will",
  "won't",
  "would",
  "wouldn't",
  "can",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "should",
  "shouldn't",
  "shall",
  "must",
  "mustn't",
  "might",
  "ought",
]);

/** A negation, which asserts what it denies: "The six meetings never
 *  overlap", "Sure — none of the 6 meetings overlap". */
const NEGATIONS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "none",
  "never",
  "neither",
  "nor",
  "nothing",
  "nobody",
  "nowhere",
]);

/** A pronoun put first in a clause is its subject: "you owe $45", "I found
 *  3 orders", "that'll be $45". */
const SUBJECTS: ReadonlySet<string> = new Set([
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "it",
  "there",
]);

/** A pronoun or a name with a verb glued on: "it's", "that'll", "I've",
 *  "you'd", "there's". A possessive ("Max's") is not one. */
const CONTRACTED =
  /^(?:i|you|we|they|he|she|it|that|this|there|here|what|who|which|everything|everyone|nothing)'(?:s|ll|ve|re|d|m)$|n't$/;

/**
 * Third-person forms that are verbs and seldom nouns: after a subject they
 * are the sentence's verb ("The refund window closes after 30 days",
 * "Pricing starts at $10", "The invoice comes to 1,386.26").
 */
const THIRD_PERSON: ReadonlySet<string> = new Set([
  "closes",
  "opens",
  "starts",
  "ends",
  "begins",
  "expires",
  "arrives",
  "fits",
  "exceeds",
  "reaches",
  "applies",
  "requires",
  "includes",
  "allows",
  "equals",
  "outperforms",
  "completes",
  "differs",
  "varies",
  "remains",
  "comes",
  "goes",
  "gets",
  "gives",
  "grows",
  "earns",
  "loses",
  "soars",
  "plunges",
  "recovers",
  "renews",
  "lasts",
  "ships",
  "supports",
  "contains",
  "provides",
  "qualifies",
  "owes",
  "receives",
  "accepts",
  "delivers",
  "weighs",
  "happens",
  "occurs",
  "becomes",
  "stays",
  "expands",
  "shrinks",
  "overlaps",
]);

/**
 * Third-person forms that are as often plural nouns ("Shipping costs for
 * 2024", "Price increases for 2025", "Hot takes"): a verb only with a value
 * straight after it ("The plan costs $10", "Refund takes 30 days").
 */
const NOUN_OR_VERB: ReadonlySet<string> = new Set([
  "costs",
  "totals",
  "runs",
  "stands",
  "holds",
  "takes",
  "cuts",
  "drops",
  "gains",
  "increases",
  "decreases",
  "jumps",
  "declines",
  "hits",
  "returns",
  "shows",
  "needs",
  "uses",
  "leads",
  "changes",
  "moves",
  "raises",
  "saves",
  "passes",
  "fails",
  "matches",
  "averages",
  "peaks",
  "doubles",
  "triples",
  "rises",
  "falls",
  "climbs",
  "surges",
  "rebounds",
  "offers",
  "covers",
  "finishes",
  "means",
  "beats",
  "trails",
  "ranges",
  "counts",
  "scores",
  "tops",
  "charges",
  "pays",
  "sells",
  "wins",
  // the same spelling for a base form and a past tense, or a noun
  "cost",
  "hit",
  "beat",
  "cut",
  "topped",
]);

/** Past tenses a finding is stated with: "AWS revenue rose 25%", "The
 *  meeting moved to 3pm", "The deploy finished in 4 minutes". */
const PAST: ReadonlySet<string> = new Set([
  "closed",
  "opened",
  "started",
  "ended",
  "began",
  "shipped",
  "arrived",
  "expired",
  "applied",
  "required",
  "included",
  "covered",
  "supported",
  "allowed",
  "offered",
  "exceeded",
  "averaged",
  "reached",
  "grew",
  "rose",
  "fell",
  "dropped",
  "increased",
  "decreased",
  "doubled",
  "tripled",
  "halved",
  "passed",
  "failed",
  "renewed",
  "finished",
  "completed",
  "peaked",
  "jumped",
  "climbed",
  "slipped",
  "surged",
  "soared",
  "plunged",
  "declined",
  "rebounded",
  "recovered",
  "moved",
  "gained",
  "earned",
  "saved",
  "raised",
  "lowered",
  "reduced",
  "lasted",
  "totaled",
  "totalled",
  "equaled",
  "equalled",
  "matched",
  "outperformed",
  "trailed",
  "lagged",
  "returned",
  "took",
  "came",
  "went",
  "got",
  "gave",
  "ran",
  "stayed",
  "remained",
  "contained",
  "provided",
  "delivered",
  "received",
  "accepted",
  "charged",
  "processed",
  "refunded",
  "scored",
  "missed",
  "expanded",
  "shrank",
  "overlapped",
]);

/**
 * Base forms, the verb of a plural subject ("Refunds close after 30 days",
 * "All 6 meetings fit without overlap", "Prices start at $10") — and,
 * first in a heading, an imperative ("Cut costs by 30%"), which is a title.
 */
const BASE: ReadonlySet<string> = new Set([
  "close",
  "open",
  "start",
  "end",
  "begin",
  "fit",
  "overlap",
  "ship",
  "arrive",
  "expire",
  "apply",
  "require",
  "need",
  "include",
  "cover",
  "support",
  "allow",
  "offer",
  "exceed",
  "average",
  "reach",
  "grow",
  "rise",
  "fall",
  "drop",
  "increase",
  "decrease",
  "double",
  "triple",
  "halve",
  "pass",
  "fail",
  "renew",
  "finish",
  "complete",
  "conflict",
  "clash",
  "differ",
  "vary",
  "peak",
  "last",
  "mean",
  "beat",
  "outperform",
  "trail",
  "lag",
  "cut",
  "save",
  "earn",
  "lose",
  "gain",
  "take",
  "come",
  "go",
  "get",
  "give",
  "cost",
  "run",
  "total",
  "remain",
  "stay",
  "equal",
  "match",
  "return",
  "hit",
  "jump",
  "climb",
  "surge",
  "soar",
  "plunge",
  "decline",
  "rebound",
  "recover",
  "move",
  "show",
  "lead",
  "qualify",
  "range",
  "sell",
  "top",
  "provide",
  "contain",
  "hold",
  "stand",
  "count",
  "score",
  "weigh",
  "accept",
  "receive",
  "charge",
  "pay",
  "owe",
  "deliver",
  "expand",
  "shrink",
]);

/** Verbs a heading's goal or a how-to opens with, besides `BASE`: "Compare
 *  the 2024 revenue of the top 3 providers", "Install Node 20". */
const IMPERATIVES: ReadonlySet<string> = new Set([
  "compare",
  "install",
  "upgrade",
  "configure",
  "set",
  "add",
  "create",
  "build",
  "deploy",
  "migrate",
  "reduce",
  "lower",
  "raise",
  "improve",
  "boost",
  "find",
  "pick",
  "choose",
  "book",
  "plan",
  "schedule",
  "try",
  "learn",
  "make",
  "keep",
  "avoid",
  "check",
  "review",
  "read",
  "write",
  "see",
  "know",
  "fix",
  "update",
  "enable",
  "disable",
  "remove",
  "delete",
  "track",
  "measure",
  "calculate",
  "estimate",
  "optimize",
  "scale",
  "test",
  "use",
  "list",
  "rank",
  "summarize",
  "explain",
  "stop",
  "prepare",
  "research",
  "analyze",
  "evaluate",
]);

/** Articles, possessives and quantifiers. */
const DETERMINERS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "your",
  "my",
  "our",
  "their",
  "his",
  "her",
  "its",
  "this",
  "that",
  "these",
  "those",
  "each",
  "every",
  "both",
  "all",
  "any",
  "some",
  "another",
]);

const PREPOSITIONS: ReadonlySet<string> = new Set([
  "for",
  "with",
  "without",
  "about",
  "of",
  "on",
  "at",
  "in",
  "to",
  "from",
  "by",
  "per",
  "via",
  "into",
  "onto",
  "regarding",
  "re",
  "within",
  "after",
  "before",
  "between",
  "during",
  "until",
  "through",
  "over",
  "under",
  "around",
  "across",
  "among",
  "since",
  "near",
  "vs",
  "versus",
]);

const CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "or", "plus", "&", "+", "so", "also"]);

/** Adverbs a verb's predicate may open with ("Tests pass again on CI"). */
const ADVERBS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "only",
  "just",
  "again",
  "back",
  "up",
  "down",
  "out",
  "still",
  "now",
  "today",
  "early",
  "late",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "annually",
  "automatically",
  "instantly",
  "immediately",
  "together",
  "fully",
  "entirely",
  "completely",
  "mostly",
  "roughly",
  "nearly",
  "almost",
  "exactly",
]);

/** What may stand between a verb and its value: "costs only $10", "takes
 *  up to 30 days", "rose by 25%". */
const HEDGES: ReadonlySet<string> = new Set([
  "only",
  "just",
  "about",
  "around",
  "nearly",
  "almost",
  "roughly",
  "exactly",
  "approximately",
  "over",
  "under",
  "up",
  "least",
  "most",
  "less",
  "more",
  "than",
  "by",
  "at",
]);

/** After these a verb's form is an adjective, a participle or an
 *  infinitive, not the sentence's verb: "the updated 2024 plan", "Getting
 *  started in 5 minutes", "5 ways to cut costs". */
const NOT_A_SUBJECT: ReadonlySet<string> = new Set([
  ...DETERMINERS,
  ...PREPOSITIONS,
  ...CONJUNCTIONS,
  "getting",
  "get",
  "gets",
  "got",
  "be",
  "been",
  "being",
  "become",
  "most",
  "least",
  "more",
  "less",
  "very",
  "newly",
  "recently",
]);

/** The prepositions a past participle's title goes on with: "Tickets closed
 *  in 2024", "Accounts opened during Q3". */
const PARTICIPLE_PERIOD: ReadonlySet<string> = new Set([
  "in",
  "during",
  "since",
  "for",
  "across",
  "at",
  "from",
  "over",
  "this",
  "last",
  "per",
  "on",
  "through",
  "between",
  "among",
]);

/** Does a value follow at `at`, past a hedge ("only", "up to", "by")? */
function valueFollows(words: readonly string[], at: number): boolean {
  let i = at;
  while (i < words.length) {
    const word = words[i] as string;
    if (HEDGES.has(word) || (word === "to" && words[i - 1] === "up")) i++;
    else break;
  }
  const value = words[i];
  return value !== undefined && isFigure(value);
}

/** Can a predicate open with this word: nothing, a value, a preposition,
 *  an article or an adverb ("close after", "fit without", "overlap")? */
function predicateFollows(next: string | undefined): boolean {
  return (
    next === undefined ||
    isFigure(next) ||
    PREPOSITIONS.has(next) ||
    DETERMINERS.has(next) ||
    ADVERBS.has(next)
  );
}

/**
 * Irregular past forms a finding is stated with that are also participles
 * ("AWS made $150B in 2024", "Uptime held at 99.99%"): a verb only with a
 * value after it, as "Mistakes made by startups" is a title.
 */
const PAST_PARTICIPLE: ReadonlySet<string> = new Set([
  "made",
  "held",
  "paid",
  "sold",
  "won",
  "lost",
  "spent",
  "built",
  "kept",
  "led",
  "sent",
  "brought",
  "bought",
  "hit",
  "set",
]);

/** Past tenses beside {@link PAST} a finding is stated with, a verb only
 *  with a value after it: "Cloud drove 60% of operating income". */
const PURE_PAST: ReadonlySet<string> = new Set(["drove", "broke", "sank", "slid"]);

/** Prepositions a verb's value may stand behind, as any quantity:
 *  "extended to 30 days", "dropped from 12 to 4", "held at 99.99%". */
const VALUE_PREPOSITIONS: ReadonlySet<string> = new Set([
  "to",
  "from",
  "by",
  "at",
  "below",
  "above",
  "under",
  "over",
  "around",
  "about",
]);

/** Prepositions a verb's value stands behind only as a measure — "for 17%",
 *  "within 30 days", "in 4 minutes" — and not as a count ("added for 3
 *  plans") or a period ("closed in 2024"). */
const MEASURE_PREPOSITIONS: ReadonlySet<string> = new Set(["for", "within", "in"]);

/** Units a measure is written with after its numeral. */
const UNITS: ReadonlySet<string> = new Set([
  "second",
  "seconds",
  "ms",
  "minute",
  "minutes",
  "min",
  "mins",
  "hour",
  "hours",
  "hrs",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "business",
  "working",
  "calendar",
  "percent",
  "points",
  "pts",
  "bps",
  "dollars",
  "euros",
  "pounds",
  "cents",
  "gb",
  "mb",
  "tb",
  "kb",
  "times",
]);

/** A year ("2024", "FY2024", "2023-24", "2020s"), a quarter or half ("Q3",
 *  "H1"), or a month: a period, not a value a sentence states. */
function isPeriod(word: string): boolean {
  return (
    /^(?:fy|cy)?(?:19|20)\d\d(?:[-–/]\d{2,4})?s?$/.test(word) ||
    /^(?:q[1-4]|h[12])(?:[-/]?(?:fy)?\d{2,4})?$/.test(word) ||
    MONTHS.has(word)
  );
}

const MONTHS: ReadonlySet<string> = new Set([
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

/** Words a period is named with after its preposition ("in the last quarter", "this year"). */
const PERIOD_NOUNS: ReadonlySet<string> = new Set([
  "year",
  "years",
  "quarter",
  "quarters",
  "month",
  "months",
  "week",
  "weeks",
  "decade",
  "season",
  "semester",
  "period",
  "ytd",
  "today",
  "yesterday",
]);

/** A figure that is a quantity: not a period, and not a time of day ("5pm", "10:30"). */
function isQuantity(word: string): boolean {
  return (
    isFigure(word) &&
    !isPeriod(word) &&
    !/^\d{1,2}(?::\d\d)?(?:am|pm)$/.test(word) &&
    !/^\d{1,2}:\d\d$/.test(word)
  );
}

/** A quantity that is a measure: a percentage, an amount of money, a
 *  magnitude ("150b", "9m", "3x"), or a numeral with its unit after it. */
function isMeasure(word: string, next: string | undefined): boolean {
  return (
    isQuantity(word) &&
    (/%$/.test(word) ||
      /^[$€£¥]/.test(word) ||
      /\d(?:k|m|mn|b|bn|x)$/.test(word) ||
      (next !== undefined && UNITS.has(next)))
  );
}

/** What joins a range's two ends: "from 12 to 4 minutes". */
const RANGE_JOINS: ReadonlySet<string> = new Set(["to", "and", "-", "–"]);

/**
 * Does a value follow at `at`: a quantity straight after the verb or past
 * a hedge ("only", "nearly"), or a measure past a preposition a value
 * stands behind ({@link VALUE_PREPOSITIONS}, {@link MEASURE_PREPOSITIONS}:
 * "extended to 30 days", "accounted for 17%", "held at 99.99%", "dropped
 * from 12 to 4 minutes")? A count behind one is what the noun is about
 * ("Changes to 2 policies", "Features added for 3 plans"), and a period or
 * a time of day is no value ("Shipping costs for 2024").
 */
function quantityAfter(words: readonly string[], at: number): boolean {
  let i = at;
  let behind = false;
  for (let skipped = 0; i < words.length && skipped < 3; skipped++) {
    const word = words[i] as string;
    if (VALUE_PREPOSITIONS.has(word) || MEASURE_PREPOSITIONS.has(word)) {
      behind = true;
      i++;
    } else if (HEDGES.has(word)) i++;
    else break;
  }
  const value = words[i];
  if (value === undefined) return false;
  if (!behind) return isQuantity(value);
  const next = words[i + 1];
  return (
    isMeasure(value, next) ||
    (next !== undefined &&
      RANGE_JOINS.has(next) &&
      isQuantity(value) &&
      isMeasure(words[i + 2] ?? "", words[i + 3]))
  );
}

/** Does a quantity follow at `at`, straight after the verb or past a hedge alone? */
function quantityStraightAfter(words: readonly string[], at: number): boolean {
  let i = at;
  while (i < words.length && HEDGES.has(words[i] as string)) i++;
  const value = words[i];
  return value !== undefined && isQuantity(value);
}

/** Does a period phrase open at `at`: "in 2024", "during Q3", "since 2020", "in the last quarter", "this year"? */
function periodPhrase(words: readonly string[], at: number): boolean {
  const opener = words[at];
  if (opener === undefined) return false;
  if ((opener === "this" || opener === "last") && PERIOD_NOUNS.has(words[at + 1] ?? ""))
    return true;
  if (!PARTICIPLE_PERIOD.has(opener)) return false;
  let i = at + 1;
  while (
    i < at + 3 &&
    /^(?:the|this|last|next|each|every|fiscal|calendar|early|late|mid)$/.test(words[i] ?? "")
  )
    i++;
  const period = words[i];
  return period !== undefined && (isPeriod(period) || PERIOD_NOUNS.has(period));
}

/** Can the word be a past participle, the head of a title ("Tickets closed in 2024")? */
function canBeParticiple(word: string): boolean {
  return /ed$/.test(word) || PAST_PARTICIPLE.has(word) || word === "got";
}

/** A verb's form that is not in the lists: a third-person "-s" ("adds", "reports", "employs"). */
function thirdPersonS(word: string): boolean {
  return /^\p{L}{3,}s$/u.test(word) && !/(?:ss|us|is|'s)$/.test(word);
}

/** A verb from the lists, as a figure-ending name's verb ("iPhone 15 costs $799"). */
function listVerb(word: string): boolean {
  return (
    THIRD_PERSON.has(word) ||
    NOUN_OR_VERB.has(word) ||
    PAST.has(word) ||
    PAST_PARTICIPLE.has(word) ||
    PURE_PAST.has(word)
  );
}

/**
 * Does the figure at `at` end a name, so that it is a subject: a token with
 * a letter first ("gpt-5", "h100"), or a whole number after a word that is
 * no article, preposition, figure or adverb ("iPhone 15", "Tier 2",
 * "Windows 11")?
 */
function endsName(words: readonly string[], at: number): boolean {
  const figure = words[at] as string;
  if (/^\p{L}/u.test(figure)) return true;
  const before = words[at - 1];
  return (
    /^\d+$/.test(figure) &&
    before !== undefined &&
    !NOT_A_SUBJECT.has(before) &&
    !isFigure(before) &&
    !ADVERBS.has(before)
  );
}

/** Where a clause of a heading ends: a colon, a semicolon, a pipe, an em dash, a spaced dash. */
const HEADING_CLAUSE = /[:;|—]|\s[–-]\s/;

/**
 * Is a heading a sentence — a subject and a finite verb — rather than a
 * title? A title is a noun phrase ("Top 5 providers by 2024 revenue",
 * "Shipping costs for 2024", "Tickets closed in 2024", "Revenue earned in
 * 2024"), an imperative ("Compare the 2024 revenue of the top 3 providers",
 * "Cut costs by 30%") or an indirect question, which the caller leaves out.
 * Each clause of it ({@link HEADING_CLAUSE}) is read on its own. A sentence
 * has, after the word that is its subject:
 *
 * - a form of "be", "do" or "have", a modal, or a negation ("The 6 meetings
 *   do not overlap", "The six meetings never overlap");
 * - a verb's third-person or past form ("The refund window lasts 30 days",
 *   "AWS revenue rose 25% in 2024", "The meeting moved to 3pm") — a past
 *   form that may be a
 *   participle, with no value after it, before a period after a plural
 *   ("Tickets closed in 2024") or a bare singular ("Revenue earned in
 *   2024"), is a title;
 * - a form as often a noun ("costs", "takes", "increases"), a past tense in
 *   -ed, or an irregular one outside the lists ("made", "held", "drove"),
 *   with a quantity after it — straight after, past a hedge or past a
 *   preposition a value stands behind ("The plan costs $10", "Refund window
 *   extended to 30 days", "Operating margin improved to 37%", "AWS accounted
 *   for 17% of revenue", "Wait times dropped from 12 to 4 minutes", "Uptime
 *   held at 99.99%", "AWS made $150B in 2024") — never a period ("Shipping
 *   costs for 2024");
 * - any other "-s" form with a quantity straight after it ("Netflix adds 9M
 *   subscribers", "The company employs 1,500 people");
 * - a base form after a plural, with a predicate after it ("Refunds close
 *   after 30 days", "All 6 meetings fit without overlap"), and any word
 *   after a plural with a preposition and a measure after it ("Refunds
 *   settle within 30 days").
 *
 * A figure that ends a name is a subject for a verb from the lists with a
 * quantity after it ("iPhone 15 costs $799", "Tier 2 costs $49 a month",
 * "GPT-5 scores 90% on MMLU", "Windows 11 requires 4 GB of RAM"); any
 * other figure is a count, and what follows it is the noun it counts ("Top
 * 5 providers", "Year 1 costs").
 *
 * The rules after the first two are what an imperative says of its object,
 * so a heading that opens with a verb's base form is a sentence by the
 * first two alone ("Hold times rose 20%" is, "Cut costs by 30%" is not).
 * After an article, a preposition or "getting" a verb's form is an
 * adjective or an infinitive ("the updated plan", "Getting started in 5
 * minutes", "5 ways to cut costs").
 */
export function statesAsSentence(plain: string): boolean {
  return plain.split(HEADING_CLAUSE).some(clauseStates);
}

function clauseStates(clause: string): boolean {
  const words = wordsOf(clause).map((w) => w.word);
  const first = words[0];
  if (first === undefined) return false;
  const imperative = IMPERATIVES.has(first) || BASE.has(first);
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    const prev = words[i - 1] as string;
    if (NOT_A_SUBJECT.has(prev)) continue;
    // A clause on a counted noun is the title's: "5 ways revenue grew in
    // 2024", "The 3 reasons churn rose".
    if (i >= 3 && isPlural(words[i - 2] as string) && isFigure(words[i - 3] as string)) continue;
    if (isFigure(prev)) {
      // A name ending in a figure; an imperative's object ("Cut 3 costs by
      // 30%") takes no verb as often a noun.
      const opensImperative = imperative && i - 1 === 1;
      if (
        endsName(words, i - 1) &&
        (opensImperative ? THIRD_PERSON.has(word) : listVerb(word)) &&
        quantityAfter(words, i + 1)
      ) {
        return true;
      }
      continue;
    }
    if (AUXILIARIES.has(word) || NEGATIONS.has(word) || CONTRACTED.test(word)) return true;
    if (THIRD_PERSON.has(word)) return true;
    if (PAST.has(word)) {
      if (canBeParticiple(word) && !quantityAfter(words, i + 1)) {
        const title = isPlural(prev)
          ? PARTICIPLE_PERIOD.has(words[i + 1] ?? "")
          : periodPhrase(words, i + 1) && !words.slice(0, i).some((one) => DETERMINERS.has(one));
        if (title) continue;
      }
      return true;
    }
    if (imperative) continue;
    // Past a preposition, a measure: "Price changes for 3 plans" counts plans.
    if (
      (NOUN_OR_VERB.has(word) ||
        pastInEd(word) ||
        PAST_PARTICIPLE.has(word) ||
        PURE_PAST.has(word)) &&
      (valueFollows(words, i + 1) || quantityAfter(words, i + 1))
    ) {
      return true;
    }
    if (thirdPersonS(word) && !isPlural(prev) && quantityStraightAfter(words, i + 1)) return true;
    if (BASE.has(word) && isPlural(prev) && predicateFollows(words[i + 1])) return true;
    if (
      isPlural(prev) &&
      !isPlural(word) &&
      !isFigure(word) &&
      !ADVERBS.has(word) &&
      (VALUE_PREPOSITIONS.has(words[i + 1] ?? "") ||
        MEASURE_PREPOSITIONS.has(words[i + 1] ?? "")) &&
      quantityAfter(words, i + 1)
    ) {
      return true;
    }
  }
  return false;
}

/** A past tense spelled with -ed, not "need", "speed" or "bed". */
function pastInEd(word: string): boolean {
  return word.length > 4 && /[^e]ed$/.test(word);
}

/** A verb's form, which after a noun is the clause's verb: "the refund
 *  window ends", "the meeting moved", "1 file changed". */
function verbForm(word: string): boolean {
  return THIRD_PERSON.has(word) || NOUN_OR_VERB.has(word) || PAST.has(word) || pastInEd(word);
}

/** Demonstratives and quantifiers that stand as a clause's subject before a
 *  verb ("that comes to $45", "each costs $12", "all 6 fit"). */
const PRONOUN_SUBJECTS: ReadonlySet<string> = new Set([
  "that",
  "this",
  "these",
  "those",
  "each",
  "both",
  "all",
  "either",
]);

/** What a restatement may hold around its figures and nouns: an article, a
 *  preposition, a conjunction, an object pronoun, "then", "please". */
function glue(word: string, prev: string | undefined): boolean {
  return (
    DETERMINERS.has(word) ||
    PREPOSITIONS.has(word) ||
    CONJUNCTIONS.has(word) ||
    word === "then" ||
    word === "please" ||
    /^(?:me|us|them|him)$/.test(word) ||
    // "2 seats for you"
    (prev !== undefined && PREPOSITIONS.has(prev) && SUBJECTS.has(word))
  );
}

/**
 * Does a clause after an acknowledgement or a set-up ("Got it —", "Thanks
 * for", "Just to confirm:") only say the reader's request back — a
 * restatement, with no verb of its own? What it may hold:
 *
 * - figures, and the noun each counts, up to three words, ending at the
 *   first plural: "2 seats", "2 adults and 1 child", "2 rooms for 3
 *   nights", "2 king-size beds", "12 months then";
 * - the articles, prepositions and conjunctions around them: "for the 3
 *   files", "about the 2024 report", "with the 5 tickets", "2 rooms for the
 *   family reunion";
 * - before its first figure, one word or a name: "invoice #1042", "the
 *   meeting at 3pm", "June 3 for 2 people", "the Grand Hotel for 2 nights";
 * - at its end, the reader's own words or a "that is" said back: "for the 3
 *   invoices you mentioned", "30 minutes it is".
 *
 * Anything else asserts, and the clause is a claim: a subject before its
 * verb ("refunds close after 30 days", "your order ships in 3 days", "the
 * meeting moved to 3pm"), a pronoun subject ("you owe $45", "I've booked 2
 * seats"), a word after the plural a figure counts ("all 12 tests pass",
 * "no two of the six meetings overlap", "3 files changed"), a form of "be"
 * or a modal, a negation, or a quantity's name before its value ("total
 * $45"). An empty clause — the opening was the whole of it ("Two quick
 * questions:") — restates.
 */
export function restatesRequest(text: string, amountNouns: ReadonlySet<string>): boolean {
  const words = wordsOf(text);
  // The run of nouns since the last figure or glue word, whether a figure
  // opened it (and was one), whether it has reached its plural, how many
  // figures the clause has shown, and whether a run before the first is a
  // name.
  let run = 0;
  let counted = false;
  let single = false;
  let plural = false;
  let figures = 0;
  let name = true;
  for (let i = 0; i < words.length; i++) {
    const { word, capital } = words[i] as Word;
    const prev = words[i - 1]?.word;
    if (isFigure(word)) {
      run = 0;
      counted = true;
      single = SINGULAR.test(word);
      plural = false;
      figures++;
      continue;
    }
    if (glue(word, prev)) {
      run = 0;
      counted = false;
      plural = false;
      name = true;
      continue;
    }
    // "…you mentioned", "…it is": the clause's last two words, after the
    // figure they are said of. A pronoun anywhere else is a subject.
    if (SUBJECTS.has(word)) return i === words.length - 2 && figures > 0;
    if (AUXILIARIES.has(word) || NEGATIONS.has(word) || CONTRACTED.test(word)) return false;
    // A demonstrative or a quantifier with a verb after it is the clause's
    // subject, not an article: "that comes to $1,386.26", "this takes about
    // 3 days", "each costs $12".
    if (prev !== undefined && PRONOUN_SUBJECTS.has(prev) && (verbForm(word) || BASE.has(word))) {
      return false;
    }
    // A base form after a count of more than one is what the counted do,
    // not a noun ("all 6 fit in the week"): a plural noun would be counted.
    if (
      prev !== undefined &&
      isFigure(prev) &&
      !SINGULAR.test(prev) &&
      BASE.has(word) &&
      predicateFollows(words[i + 1]?.word)
    ) {
      return false;
    }
    if (prev === undefined ? PAST.has(word) || pastInEd(word) : verbForm(word)) {
      if (prev === undefined || !(isFigure(prev) || NOT_A_SUBJECT.has(prev))) return false;
    }
    run++;
    if (figures > 0) {
      if (plural || run > 3) return false;
      if (counted && single && run > 1 && /s$/.test(word)) return false;
      if (isPlural(word)) plural = true;
    } else {
      name &&= capital;
      if (amountNouns.has(word) || (run > 1 && !name)) return false;
    }
  }
  return true;
}
