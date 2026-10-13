/**
 * Prompt-injection heuristics.
 *
 * ## This is not a defence
 *
 * It is a smoke detector. It matches phrasings and structural tricks that
 * have shown up in real injections, and an attacker who has read this file —
 * which is public — can write around every one of them in a minute. A low
 * score means "none of these patterns fired", never "this content is safe to
 * hand to a model with tools".
 *
 * The actual defences are architectural and live elsewhere: untrusted
 * content stays data, tool calls need permission, side-effectful actions are
 * confirmed by the user, and a model's instructions never come from the
 * content it is reading. `PromptInjectionScan` is worth running because it
 * is free and it catches the lazy attempt — triage, not a gate.
 *
 * ## Scoring
 *
 * Each rule carries a weight. The score sums each DISTINCT rule's weight
 * once, capped at 100: a document that says "ignore previous instructions"
 * forty times is not forty times more suspicious than one that says it once,
 * and rewarding repetition would make the score trivially inflatable.
 *
 * ## Excerpts
 *
 * A hit carries a short excerpt so a human can judge it. That excerpt is
 * attacker-controlled text. Show it to a person; do not paste it into a
 * prompt as if it were instructions.
 */
import { type Finding, compareStrings, matchAll, matchAllSkipping, withPositions } from "./text";
import { scanInvisible } from "./unicode";

export type InjectionCategory =
  | "override"
  | "role"
  | "exfiltration"
  | "tool-coercion"
  | "authority"
  | "secrecy"
  | "concealment";

export type InjectionRule = {
  readonly id: string;
  readonly category: InjectionCategory;
  readonly weight: number;
  readonly description: string;
  readonly pattern: RegExp;
  /**
   * The pattern's matches when a plain global search would rescan a run;
   * the same matches as `matchAll(text, pattern)`.
   */
  readonly matches?: (text: string) => Iterable<{ index: number; match: RegExpExecArray }>;
};

/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Where `^` matches under the `m` flag. */
function isLineStart(text: string, at: number): boolean {
  if (at === 0) return true;
  const c = text.charCodeAt(at - 1);
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

const CHAT_MARKUP =
  /<\/?(?:system|assistant|human|user)>|\[\/?INST\]|<\|im_(?:start|end)\|>|^\s*###\s*(?:instruction|system)/gim;

/**
 * CHAT_MARKUP's matches. Its `^\s*###` branch starts at every line and runs
 * its `\s*` on across blank lines, so a run of blank lines was rescanned from
 * each line start in it: quadratic in the run's length. The other branches
 * start at `<` or `[`, which no whitespace is, so a try at a line start that
 * fails rules out every start up to the end of its whitespace.
 */
function chatMarkupMatches(text: string): Iterable<{ index: number; match: RegExpExecArray }> {
  return matchAllSkipping(
    text,
    CHAT_MARKUP,
    (t, at) => {
      const c = t.charCodeAt(at);
      return c === 0x3c || c === 0x5b || isLineStart(t, at);
    },
    (t, at) => {
      if (!isLineStart(t, at)) return at + 1;
      let i = at;
      while (i < t.length && isRegExpSpace(t.charCodeAt(i))) i++;
      return i;
    },
  );
}

const PIPE_TO_SHELL = /\b(?:curl|wget)\s+[^\n|]{1,200}\|\s*(?:sudo\s+)?(?:ba|z|d|fi)?sh\b/gi;
/** What PIPE_TO_SHELL reads after its `|`, tried at one place. */
const PIPE_TO_SHELL_TAIL = /\s*(?:sudo\s+)?(?:ba|z|d|fi)?sh\b/iy;

/** A code unit `\w` matches. */
function isWordUnit(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
  );
}

/** `word` (lowercase ASCII) at `at`, in either case, as the `i` flag reads it. */
function asciiWordAt(text: string, at: number, word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const c = text.charCodeAt(at + i);
    if (c !== word.charCodeAt(i) && c !== word.charCodeAt(i) - 0x20) return false;
  }
  return true;
}

/**
 * PIPE_TO_SHELL's matches. Its blanks after `curl` and the up to 200
 * characters before `|` overlap on blanks, so a try that fails gave the
 * blanks back one at a time and read up to 200 characters again after each,
 * and every `curl` in a stretch did it again: hundreds of steps a character
 * over text of up to 2M characters. A try is made only where it matches:
 * after `curl` or `wget` and its blanks, the first `|` or `\n` must be a `|`
 * that some split of the blanks leaves 1 to 200 characters before, with no
 * `\n` among them, and the shell must follow it. Those ends only move
 * forward, so each is found once.
 */
function pipeToShellMatches(text: string): Iterable<{ index: number; match: RegExpExecArray }> {
  let stop = -1;
  let tailAt = -1;
  let tailMatches = false;
  return matchAllSkipping(
    text,
    PIPE_TO_SHELL,
    (t, at) => {
      if (!(asciiWordAt(t, at, "curl") || asciiWordAt(t, at, "wget"))) return false;
      if (at > 0 && isWordUnit(t.charCodeAt(at - 1))) return false;
      const from = at + 4;
      let blanksEnd = from;
      let lastBreak = -1;
      while (blanksEnd < t.length && isRegExpSpace(t.charCodeAt(blanksEnd))) {
        if (t.charCodeAt(blanksEnd) === 0x0a) lastBreak = blanksEnd;
        blanksEnd++;
      }
      if (blanksEnd === from) return false;
      if (stop < blanksEnd) {
        stop = blanksEnd;
        while (stop < t.length && t.charCodeAt(stop) !== 0x7c && t.charCodeAt(stop) !== 0x0a)
          stop++;
      }
      if (t.charCodeAt(stop) !== 0x7c) return false;
      // The blanks the `\s+` keeps, `w`: at least one, no `\n` left after
      // them, and 1 to 200 characters from them to the `|`.
      const lo = Math.max(1, stop - from - 200, lastBreak - from + 1);
      const hi = Math.min(blanksEnd - from, stop - from - 1);
      if (lo > hi) return false;
      if (tailAt !== stop + 1) {
        tailAt = stop + 1;
        PIPE_TO_SHELL_TAIL.lastIndex = tailAt;
        tailMatches = PIPE_TO_SHELL_TAIL.test(t);
      }
      return tailMatches;
    },
    (_, at) => at + 1,
  );
}

/** The phrase rules. Also run against decoded base64, once, no recursion. */
export const INJECTION_RULES: ReadonlyArray<InjectionRule> = [
  {
    id: "override.ignore-previous",
    category: "override",
    weight: 35,
    description: "asks the reader to ignore earlier instructions",
    pattern:
      /\bignore\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|directions?|prompts?|rules?|messages?|context)/gi,
  },
  {
    id: "override.disregard",
    category: "override",
    weight: 30,
    description: "asks the reader to disregard what came before",
    pattern:
      /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior|earlier|foregoing|your\s+instructions)/gi,
  },
  {
    id: "override.forget",
    category: "override",
    weight: 25,
    description: "asks the reader to forget its instructions",
    pattern:
      /\bforget\s+(?:everything|all\s+(?:previous|prior)|your\s+(?:instructions|rules|training))/gi,
  },
  {
    id: "override.new-instructions",
    category: "override",
    weight: 25,
    description: "announces replacement instructions",
    pattern:
      /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions?|directives?|rules?)\s*[:\-]/gi,
  },
  {
    id: "override.chat-markup",
    category: "override",
    weight: 30,
    description: "embeds chat-template or role markup, trying to close the current turn",
    pattern: CHAT_MARKUP,
    matches: chatMarkupMatches,
  },
  {
    id: "role.you-are-now",
    category: "role",
    weight: 20,
    description: "reassigns the reader's role",
    pattern: /\byou\s+are\s+(?:now|no\s+longer)\b/gi,
  },
  {
    id: "role.pretend",
    category: "role",
    weight: 15,
    description: "role-play framing used to move past a refusal",
    pattern: /\bpretend\s+(?:to\s+be|that\s+you|you\s+are)\b/gi,
  },
  {
    id: "role.jailbreak-persona",
    category: "role",
    weight: 25,
    description: "names a known jailbreak persona or mode",
    pattern: /\b(?:DAN\s+mode|developer\s+mode|god\s+mode|unfiltered\s+mode|jailbreak(?:en)?)\b/gi,
  },
  {
    id: "exfil.reveal-prompt",
    category: "exfiltration",
    weight: 35,
    description: "asks for the system prompt or hidden instructions",
    pattern:
      /\b(?:reveal|repeat|print|show|output|display|disclose)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|original\s+)?(?:system\s+)?(?:prompt|instructions?|rules|configuration)/gi,
  },
  {
    id: "exfil.repeat-above",
    category: "exfiltration",
    weight: 30,
    description: "asks for the preceding context verbatim",
    pattern: /\brepeat\s+(?:the\s+)?(?:text|everything|all)\s+(?:above|before)/gi,
  },
  {
    id: "exfil.send-elsewhere",
    category: "exfiltration",
    weight: 35,
    description: "asks for data to be sent to an address the content supplies",
    pattern:
      /\b(?:send|post|upload|forward|email|exfiltrate)\s+(?:it|this|them|the\s+\w+(?:\s+\w+)?)\s+to\s+(?:https?:\/\/\S+|\S+@\S+\.\w+)/gi,
  },
  {
    id: "tool.run-command",
    category: "tool-coercion",
    weight: 25,
    description: "instructs the reader to run supplied code",
    pattern:
      /\b(?:run|execute|eval(?:uate)?)\s+(?:the\s+)?(?:following|this|these)\s+(?:command|script|code|snippet)/gi,
  },
  {
    id: "tool.pipe-to-shell",
    category: "tool-coercion",
    weight: 35,
    description: "a download-and-execute one-liner",
    pattern: PIPE_TO_SHELL,
    matches: pipeToShellMatches,
  },
  {
    id: "tool.credential-request",
    category: "tool-coercion",
    weight: 30,
    description: "asks for credentials to be produced or entered",
    pattern:
      /\b(?:paste|provide|enter|reveal|share|type)\s+(?:your|the)\s+(?:api[\s_-]?key|password|secret|token|credentials?|private\s+key)/gi,
  },
  {
    id: "authority.claimed",
    category: "authority",
    weight: 20,
    description: "the content claims to be the operator, developer or system",
    pattern:
      /\b(?:i\s+am|this\s+is)\s+(?:the\s+)?(?:system|administrator|admin|developer|operator|your\s+(?:developer|creator|owner|principal))\b/gi,
  },
  {
    id: "authority.preauthorized",
    category: "authority",
    weight: 25,
    description: "the content asserts the user already consented",
    pattern:
      /\b(?:the\s+)?(?:user|owner|operator|human)\s+(?:has\s+)?(?:already\s+)?(?:approved|authorized|authorised|consented|pre-?approved)\b/gi,
  },
  {
    id: "authority.policy-override",
    category: "authority",
    weight: 30,
    description: "asks for safety or policy constraints to be set aside",
    pattern:
      /\b(?:override|bypass|ignore|suspend|disable)\s+(?:your\s+|the\s+)?(?:safety|security|content|policy|policies|guidelines?|restrictions?|filters?)/gi,
  },
  {
    id: "secrecy.do-not-tell",
    category: "secrecy",
    weight: 30,
    description: "asks for the action to be hidden from the user",
    pattern:
      /\b(?:do\s*n[o']?t|never|avoid)\s+(?:tell|telling|inform|informing|mention(?:ing)?\s+to|notify(?:ing)?|alert(?:ing)?)\s+(?:the\s+)?(?:user|human|operator|owner)/gi,
  },
  {
    id: "secrecy.silently",
    category: "secrecy",
    weight: 15,
    description: "asks for an action without confirmation",
    pattern:
      /\b(?:silently|quietly|without\s+(?:asking|telling|informing|confirmation|notifying))\b/gi,
  },
];

const HTML_COMMENT = /<!--([\s\S]{0,4000}?)-->/g;
const HIDDEN_STYLE =
  /style\s*=\s*["'][^"']{0,200}(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)/gi;
const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;
const BASE64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/g;
const DOMAIN_IN_TEXT =
  /\b(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/i;

/**
 * HTML_COMMENT's matches. From each `<!--` it reads up to 4,000 characters
 * for a `-->`, so a text of `<!--` with none read 4,000 characters again
 * from every one: thousands of steps a character, seconds over 2M. A try is
 * made only where the first `-->` after the opener lies within reach; that
 * `-->` only moves forward, so it is searched for once.
 */
export function htmlCommentMatches(
  text: string,
): Iterable<{ index: number; match: RegExpExecArray }> {
  let close = -2;
  return matchAllSkipping(
    text,
    HTML_COMMENT,
    (t, at) => {
      if (!t.startsWith("<!--", at)) return false;
      const from = at + 4;
      if (close !== -1 && close < from) close = t.indexOf("-->", from);
      return close !== -1 && close - from <= 4_000;
    },
    (_, at) => at + 1,
  );
}

/**
 * MARKDOWN_LINK's matches. From each `[` it reads up to 200 label and 500
 * target characters, so a run of `[` read 200 again from every one. A try
 * is made only where it matches: the label runs from the `[` to the first
 * `]` or `\n` (1 to 200 characters, ending at `]`), `(` follows, and the
 * target runs to the first `)` or blank (1 to 500, ending at `)`). Both ends
 * only move forward, so each is found once.
 */
export function markdownLinkMatches(
  text: string,
): Iterable<{ index: number; match: RegExpExecArray }> {
  let labelEnd = -1;
  let targetEnd = -1;
  return matchAllSkipping(
    text,
    MARKDOWN_LINK,
    (t, at) => {
      if (t.charCodeAt(at) !== 0x5b) return false;
      const label = at + 1;
      if (labelEnd < label) {
        labelEnd = label;
        while (
          labelEnd < t.length &&
          t.charCodeAt(labelEnd) !== 0x5d &&
          t.charCodeAt(labelEnd) !== 0x0a
        ) {
          labelEnd++;
        }
      }
      const labelLength = labelEnd - label;
      if (labelLength < 1 || labelLength > 200 || t.charCodeAt(labelEnd) !== 0x5d) return false;
      if (t.charCodeAt(labelEnd + 1) !== 0x28) return false;
      const target = labelEnd + 2;
      if (targetEnd < target) {
        targetEnd = target;
        while (
          targetEnd < t.length &&
          t.charCodeAt(targetEnd) !== 0x29 &&
          !isRegExpSpace(t.charCodeAt(targetEnd))
        ) {
          targetEnd++;
        }
      }
      const targetLength = targetEnd - target;
      return targetLength >= 1 && targetLength <= 500 && t.charCodeAt(targetEnd) === 0x29;
    },
    (_, at) => at + 1,
  );
}

/** Decoded blobs are bounded so one base64 wall cannot blow up memory. */
export const MAX_BASE64_CANDIDATE_CHARS = 100_000;
/** Decoding happens once. Content inside a decoded blob is never decoded again. */
export const BASE64_DEPTH = 1;

export type InjectionHit = {
  readonly rule: string;
  readonly category: InjectionCategory;
  readonly weight: number;
  readonly description: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  /** Attacker-controlled text, capped. For a human to read, not a model to obey. */
  readonly excerpt: string;
  readonly source: "text" | "decoded-base64";
};

export type InjectionResult = {
  readonly score: number;
  readonly band: "none" | "low" | "medium" | "high";
  readonly hits: ReadonlyArray<InjectionHit>;
  readonly categories: ReadonlyArray<InjectionCategory>;
  /** How many base64 blobs were decoded and rescanned. */
  readonly decodedBlobs: number;
};

const EXCERPT_CHARS = 120;

function excerptAt(text: string, start: number, length: number): string {
  const slice = text.slice(start, start + Math.min(length, EXCERPT_CHARS));
  return slice.length < length ? `${slice}…` : slice;
}

function band(score: number): InjectionResult["band"] {
  if (score === 0) return "none";
  if (score < 25) return "low";
  if (score < 50) return "medium";
  return "high";
}

/** Decode a base64 blob when it is valid and decodes to mostly printable text. */
export function decodeBase64Text(candidate: string): string | undefined {
  if (candidate.length > MAX_BASE64_CANDIDATE_CHARS) return undefined;
  if (candidate.length % 4 !== 0) return undefined;
  let decoded: string;
  try {
    const buf = Buffer.from(candidate, "base64");
    if (buf.length === 0) return undefined;
    // Round-trip check: Buffer.from is permissive, and a blob that does not
    // re-encode to itself was not base64 in the first place.
    if (buf.toString("base64") !== candidate) return undefined;
    decoded = buf.toString("utf8");
  } catch {
    return undefined;
  }
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) printable++;
  }
  return printable / decoded.length >= 0.85 ? decoded : undefined;
}

function phraseHits(
  text: string,
  source: InjectionHit["source"],
): Array<Omit<Finding, "line" | "column">> {
  const raw: Array<Omit<Finding, "line" | "column">> = [];
  for (const rule of INJECTION_RULES) {
    for (const { index, match } of rule.matches?.(text) ?? matchAll(text, rule.pattern)) {
      raw.push({
        type: rule.category,
        rule: rule.id,
        confidence: "possible",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { weight: rule.weight, source },
      });
    }
  }
  return raw;
}

const RULE_BY_ID: ReadonlyMap<string, InjectionRule> = new Map(
  INJECTION_RULES.map((r) => [r.id, r]),
);

const STRUCTURAL: ReadonlyMap<
  string,
  { category: InjectionCategory; weight: number; description: string }
> = new Map([
  [
    "conceal.invisible-characters",
    {
      category: "concealment" as const,
      weight: 25,
      description: "zero-width, tag or bidi characters hide content from a human reviewer",
    },
  ],
  [
    "conceal.html-comment",
    {
      category: "concealment" as const,
      weight: 20,
      description: "instruction-shaped text inside an HTML comment, invisible when rendered",
    },
  ],
  [
    "conceal.hidden-style",
    {
      category: "concealment" as const,
      weight: 25,
      description:
        "markup that renders text invisible (display:none, zero font size, zero opacity)",
    },
  ],
  [
    "conceal.link-cloaking",
    {
      category: "concealment" as const,
      weight: 20,
      description:
        "a markdown link whose visible text names a different destination than its target",
    },
  ],
  [
    "conceal.base64-instructions",
    {
      category: "concealment" as const,
      weight: 35,
      description: "a base64 blob that decodes to instruction-shaped text",
    },
  ],
]);

/** Run every rule. `text` is untrusted by assumption. */
export function scanInjection(text: string): InjectionResult {
  const raw = phraseHits(text, "text");

  // Concealment: invisible characters.
  const invisible = scanInvisible(text).filter(
    (hit) => hit.class === "zero-width" || hit.class === "tag" || hit.class === "bidi-control",
  );
  const firstInvisible = invisible[0];
  if (firstInvisible) {
    raw.push({
      type: "concealment",
      rule: "conceal.invisible-characters",
      confidence: "possible",
      start: firstInvisible.start,
      end: firstInvisible.end,
      value: firstInvisible.label,
      detail: { weight: 25, count: invisible.length },
    });
  }

  // Concealment: instruction text inside an HTML comment.
  for (const { index, match } of htmlCommentMatches(text)) {
    const inner = match[1] ?? "";
    if (phraseHits(inner, "text").length === 0) continue;
    raw.push({
      type: "concealment",
      rule: "conceal.html-comment",
      confidence: "possible",
      start: index,
      end: index + match[0].length,
      value: match[0].slice(0, EXCERPT_CHARS),
      detail: { weight: 20 },
    });
  }

  for (const { index, match } of matchAll(text, HIDDEN_STYLE)) {
    raw.push({
      type: "concealment",
      rule: "conceal.hidden-style",
      confidence: "possible",
      start: index,
      end: index + match[0].length,
      value: match[0].slice(0, EXCERPT_CHARS),
      detail: { weight: 25 },
    });
  }

  // Concealment: a link whose label names a different host than its target.
  for (const { index, match } of markdownLinkMatches(text)) {
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    const labelDomain = DOMAIN_IN_TEXT.exec(label)?.[1]?.toLowerCase();
    const hrefScheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
    const hrefDomain = DOMAIN_IN_TEXT.exec(
      href.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""),
    )?.[1]?.toLowerCase();
    const dangerousScheme =
      hrefScheme === "javascript" || hrefScheme === "data" || hrefScheme === "vbscript";
    const cloaked =
      labelDomain !== undefined &&
      (dangerousScheme || (hrefDomain !== undefined && hrefDomain !== labelDomain));
    if (!cloaked) continue;
    raw.push({
      type: "concealment",
      rule: "conceal.link-cloaking",
      confidence: "possible",
      start: index,
      end: index + match[0].length,
      value: match[0].slice(0, EXCERPT_CHARS),
      detail: { weight: 20 },
    });
  }

  // Concealment: base64 that decodes to instructions. Depth 1, by construction.
  let decodedBlobs = 0;
  for (const { index, match } of matchAll(text, BASE64_BLOB)) {
    const decoded = decodeBase64Text(match[0]);
    if (decoded === undefined) continue;
    decodedBlobs += 1;
    const inner = phraseHits(decoded, "decoded-base64");
    if (inner.length === 0) continue;
    const firstRule = inner[0]?.rule ?? "";
    raw.push({
      type: "concealment",
      rule: "conceal.base64-instructions",
      confidence: "possible",
      start: index,
      end: index + match[0].length,
      value: decoded.slice(0, EXCERPT_CHARS),
      detail: { weight: 35, decodedRule: firstRule },
    });
  }

  // A total order: two hits at the same offset under the same rule must
  // compare equal, or `sort` is free to order them differently on a different
  // run and the "same input, same bytes" claim stops holding.
  const located = withPositions(text, raw).sort(
    (a, b) => a.start - b.start || compareStrings(a.rule, b.rule) || a.end - b.end,
  );
  const hits: InjectionHit[] = located.map((f) => {
    const rule = RULE_BY_ID.get(f.rule);
    const structural = STRUCTURAL.get(f.rule);
    const source: InjectionHit["source"] =
      f.detail?.["source"] === "decoded-base64" ? "decoded-base64" : "text";
    return {
      rule: f.rule,
      category: (rule?.category ?? structural?.category ?? "override") as InjectionCategory,
      weight: rule?.weight ?? structural?.weight ?? 0,
      description: rule?.description ?? structural?.description ?? "",
      line: f.line,
      column: f.column,
      start: f.start,
      excerpt: f.rule.startsWith("conceal.") ? f.value : excerptAt(text, f.start, f.end - f.start),
      source,
    };
  });

  const seen = new Map<string, number>();
  for (const hit of hits) if (!seen.has(hit.rule)) seen.set(hit.rule, hit.weight);
  let score = 0;
  for (const weight of seen.values()) score += weight;
  score = Math.min(100, score);
  const categories = [...new Set(hits.map((h) => h.category))].sort();
  return { score, band: band(score), hits, categories, decodedBlobs };
}
