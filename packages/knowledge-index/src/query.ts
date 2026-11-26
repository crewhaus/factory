/**
 * The search grammar, read by rule: plain words, `type:`, `in:`, `#tag`, `since:Nd`,
 * `status:`, and a few fixed phrases ("facts about …", "last week"). No model reads a query,
 * and nothing stores one.
 */
import { SEARCH_KINDS, type SearchKind } from "@crewhaus/control-contract/search";

export type ParsedQuery = {
  /** What the words rank by; empty when the query only filters. */
  readonly words: string;
  readonly kinds: readonly SearchKind[];
  /** Harness names or ids to look in. */
  readonly inHarnesses: readonly string[];
  readonly tags: readonly string[];
  /** Only what changed in this many days. */
  readonly sinceDays?: number;
  readonly statuses: readonly string[];
};

/** A kind by every word a person calls it. */
const KIND_WORDS: Readonly<Record<string, readonly SearchKind[]>> = {
  fact: ["facts", "shared"],
  facts: ["facts", "shared"],
  memory: ["facts", "shared"],
  memories: ["facts", "shared"],
  article: ["wiki"],
  articles: ["wiki"],
  page: ["wiki"],
  wiki: ["wiki"],
  plan: ["plans"],
  goal: ["goals"],
  requirement: ["requirements"],
  session: ["session", "sessions"],
  sessions: ["session", "sessions"],
  conversation: ["session", "sessions"],
  conversations: ["session", "sessions"],
  lesson: ["lessons"],
  suggestion: ["suggestions"],
  dataset: ["dataset"],
  datasets: ["dataset"],
  document: ["documents"],
  doc: ["documents"],
  docs: ["documents"],
  record: ["records"],
  task: ["tasks"],
  work: ["work"],
  criterion: ["criterion"],
  criteria: ["criterion"],
  grader: ["grader"],
  graders: ["grader"],
  harness: ["harness"],
  harnesses: ["harness"],
  run: ["run"],
  runs: ["run"],
  decision: ["decision"],
  decisions: ["decision"],
};

const KINDS: ReadonlySet<string> = new Set(SEARCH_KINDS);

/** The kinds a person means by a word (`fact`, `memories`, `wiki`), or `undefined`. */
export function kindsOf(word: string): readonly SearchKind[] | undefined {
  const lower = word.toLowerCase();
  if (Object.hasOwn(KIND_WORDS, lower)) return KIND_WORDS[lower];
  return KINDS.has(lower) ? [lower as SearchKind] : undefined;
}

/** Phrases that stand for a filter, matched on whole words, whatever their case. */
const TIMES: readonly (readonly [RegExp, number])[] = [
  [/\b(?:today)\b/i, 1],
  [/\b(?:since yesterday|yesterday)\b/i, 2],
  [/\b(?:last|past|this) week\b/i, 7],
  [/\b(?:last|past|this) month\b/i, 30],
];
const ABOUT_RE = /^\s*([a-z]+) about\b/i;

/** A `"quoted phrase"` is one argument of a filter; anything else ends at the next space. */
const TOKEN_RE = /(?:[^\s"]+:)?"[^"]*"|\S+/g;

const unquote = (text: string): string => text.replace(/^"|"$/g, "");

/** Read a query. Every input has an answer: what is not a filter is a word. */
export function parseQuery(q: string): ParsedQuery {
  let text = q;
  const kinds = new Set<SearchKind>();
  let sinceDays: number | undefined;
  const about = ABOUT_RE.exec(text);
  const asked = about?.[1] === undefined ? undefined : kindsOf(about[1]);
  if (about !== null && asked !== undefined) {
    for (const kind of asked) kinds.add(kind);
    text = text.slice(about[0].length);
  }
  for (const [pattern, days] of TIMES) {
    if (!pattern.test(text)) continue;
    sinceDays = Math.min(sinceDays ?? days, days);
    text = text.replace(pattern, " ");
  }
  const words: string[] = [];
  const inHarnesses: string[] = [];
  const tags: string[] = [];
  const statuses: string[] = [];
  for (const token of text.match(TOKEN_RE) ?? []) {
    const at = token.indexOf(":");
    const name = at > 0 ? token.slice(0, at).toLowerCase() : "";
    const value = at > 0 ? unquote(token.slice(at + 1)) : "";
    if (name === "type" && kindsOf(value) !== undefined) {
      for (const kind of kindsOf(value) ?? []) kinds.add(kind);
    } else if (name === "in" && value !== "") {
      inHarnesses.push(value);
    } else if (name === "status" && value !== "") {
      statuses.push(value.toLowerCase());
    } else if (name === "since" && /^[1-9]\d{0,3}d$/.test(value)) {
      sinceDays = Number(value.slice(0, -1));
    } else if (token.startsWith("#") && token.length > 1) {
      tags.push(token.slice(1).toLowerCase());
    } else {
      words.push(unquote(token));
    }
  }
  return {
    words: words.join(" ").trim(),
    kinds: [...kinds],
    inHarnesses,
    tags,
    ...(sinceDays !== undefined ? { sinceDays } : {}),
    statuses,
  };
}
