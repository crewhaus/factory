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
import { type Finding, compareStrings, matchAll, withPositions } from "./text";
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
};

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
    pattern:
      /<\/?(?:system|assistant|human|user)>|\[\/?INST\]|<\|im_(?:start|end)\|>|^\s*###\s*(?:instruction|system)/gim,
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
    pattern: /\b(?:curl|wget)\s+[^\n|]{1,200}\|\s*(?:sudo\s+)?(?:ba|z|d|fi)?sh\b/gi,
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
    for (const { index, match } of matchAll(text, rule.pattern)) {
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
  for (const { index, match } of matchAll(text, HTML_COMMENT)) {
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
  for (const { index, match } of matchAll(text, MARKDOWN_LINK)) {
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
