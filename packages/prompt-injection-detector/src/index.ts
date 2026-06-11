/**
 * Catalog R8 `prompt-injection-detector` — heuristic + optional LLM
 * classifier for tool output. Used by runtime-core after every tool
 * call (when the tool's `classifyOutput` flag is not explicitly false)
 * to decide whether the output should be passed to the model verbatim,
 * passed with a system warning, or redacted.
 *
 * Three layers, fail-closed when ambiguous:
 *
 *   Layer 1 — regex rules over a corpus drawn from OWASP LLM Top-10
 *   plus a 50+-vector hand-crafted set. Each rule has a severity tag
 *   and contributes to a cumulative score. The corpus is exported so
 *   tests and downstream tools can audit it.
 *
 *   Layer 2 — structural heuristics. Trailing imperative blocks,
 *   role-marker injection (e.g. "system:" / "<|im_start|>"), BOM
 *   tampering, and base64 wrapping a malicious string are all detected
 *   without overlap with Layer 1. These produce hits with severity
 *   weighted by structural risk.
 *
 *   Layer 3 — optional LLM classifier. Activated when
 *   `CREWHAUS_PI_CLASSIFIER_MODEL` is set; the runtime supplies a
 *   `classify` callback that delegates to a model. Without the env
 *   var the layer is a no-op.
 *
 * The aggregate score thresholds:
 *   < 0.40 → "clean"
 *   [0.40, 0.80) → "suspicious"
 *   ≥ 0.80 → "malicious"
 *
 * Layer R8. Pairs with `tool-result-store` (the previewContent input)
 * and `runtime-core` (the post-tool callsite that consumes the
 * classification).
 */

export type PromptInjectionClassification = "clean" | "suspicious" | "malicious";

export type PromptInjectionSeverity = "low" | "medium" | "high";

export type PromptInjectionHit = {
  /** Stable rule id; safe to surface in logs and the redaction notice. */
  readonly rule: string;
  /** [start, end) byte offset in the analyzed text. */
  readonly span: readonly [number, number];
  readonly severity: PromptInjectionSeverity;
  /** Layer that produced the hit. */
  readonly layer: "regex" | "structural" | "llm";
};

export type PromptInjectionResult = {
  readonly classification: PromptInjectionClassification;
  /** [0, 1] aggregate score. Higher = more likely injection. */
  readonly score: number;
  readonly hits: ReadonlyArray<PromptInjectionHit>;
};

export type PromptInjectionRule = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly severity: PromptInjectionSeverity;
  readonly description?: string;
};

const SEVERITY_WEIGHT: Record<PromptInjectionSeverity, number> = {
  low: 0.18,
  medium: 0.42,
  high: 0.85,
};

const SCORE_SUSPICIOUS = 0.4;
const SCORE_MALICIOUS = 0.8;

// Upper bound on the text the regex/structural layers scan, so a pathological
// (e.g. multi-MB whitespace) input cannot wedge the classifier (#153). Larger
// inputs are analyzed head + tail.
const MAX_CLASSIFY_LEN = 64 * 1024;

// Zero-width / format / bidi / tag characters used to split trigger words
// ("ig<U+200B>nore"). Stripped from the match view; their *presence* is still
// caught on the raw text by the unicode-tag-spoof / rtl-override rules.
const INVISIBLE_RE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿\u{E0000}-\u{E007F}]/gu;

// Common confusable homoglyphs → ASCII, applied only to the match view so an
// attacker cannot dodge the keyword rules with Cyrillic/Greek look-alikes
// (e.g. Cyrillic "іgnоre"). Intentionally small to limit false positives.
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ѕ: "s",
  ј: "j",
  // Lowercase Cyrillic look-alikes whose UPPERCASE forms are mapped below.
  // NFKC does not fold these to Latin, so without them a single lowercase
  // homoglyph inside a trigger word (e.g. Cyrillic т U+0442 in "insтructions")
  // slips past the keyword rules even though the uppercase Т is folded.
  в: "b",
  к: "k",
  м: "m",
  н: "h",
  т: "t",
  // Capital Cyrillic look-alikes. NFKC does not fold these to Latin, so without
  // them a sentence-initial homoglyph (e.g. "Іgnore all previous instructions",
  // Cyrillic І U+0406) evades the keyword rules. Symmetric with the lowercase set.
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  І: "I",
  Ј: "J",
  Ѕ: "S",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
  ο: "o",
  ρ: "p",
  α: "a",
  ε: "e",
  ι: "i",
  // Lowercase Greek look-alikes whose uppercase forms are mapped above.
  β: "b",
  τ: "t",
  χ: "x",
};

/**
 * Hand-curated corpus. Rule ids are stable so callers (auditors, tests,
 * the redaction notice) can rely on them.
 */
export const REGEX_RULES: ReadonlyArray<PromptInjectionRule> = [
  {
    id: "ignore-previous",
    pattern:
      /\bignore (?:all |the )?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?|messages?)\b/i,
    severity: "high",
    description: "OWASP LLM01 — ignore-previous-instructions injection",
  },
  {
    id: "disregard-previous",
    pattern:
      /\bdisregard (?:all |the )?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)\b/i,
    severity: "high",
  },
  {
    id: "forget-previous",
    pattern:
      /\bforget (?:everything|all|what) (?:above|before|prior|previous|you (?:were|have been) told)\b/i,
    severity: "high",
  },
  {
    id: "new-instructions",
    pattern:
      /\b(?:here are|these are)\s+(?:your\s+)?new\s+(?:instructions|rules|directives|orders)\b/i,
    severity: "high",
  },
  {
    id: "from-now-on",
    pattern:
      /\bfrom now on(?: you (?:will|must|should))?\s+(?:act|behave|respond|answer|reply|follow)\b/i,
    severity: "medium",
  },
  {
    id: "you-are-now",
    pattern:
      /\byou are (?:now|hereby)\s+(?:a|an|the)\s+[\w-]+(?:\s+[\w-]+){0,3}\s+(?:assistant|model|persona|character|expert|engine|admin)\b/i,
    severity: "medium",
  },
  {
    id: "system-prompt-leak",
    pattern:
      /\b(?:reveal|print|output|display|show|expose|dump|leak)\s+(?:the\s+)?(?:system\s+prompt|developer\s+message|hidden\s+instructions|original\s+instructions)\b/i,
    severity: "high",
  },
  {
    id: "tell-me-system-prompt",
    pattern:
      /\b(?:tell me|tell me about|what is|what are|repeat|reveal|show me)\s+(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+prompt|original\s+instructions|hidden\s+(?:rules|prompt))\b/i,
    severity: "high",
  },
  {
    id: "developer-mode",
    pattern:
      /\b(?:enable|activate|enter|enable_)?\s*(?:developer|dev|debug|admin|god|jailbreak|dan|stan|aim|free)\s*mode\b/i,
    severity: "medium",
  },
  {
    id: "dan-jailbreak",
    pattern: /\b(?:DAN|do anything now)\b/i,
    severity: "medium",
  },
  {
    id: "above-text-untrusted",
    pattern:
      /\bthe (?:above|prior|previous) (?:text|message|content|instruction)s? (?:is|are|was) (?:fake|untrusted|wrong|incorrect|a test)\b/i,
    severity: "high",
  },
  {
    id: "destructive-rm",
    pattern: /\brm\s+-rf\s+(?:\/|~|\$HOME|--no-preserve-root)/i,
    severity: "high",
    description: "Direct destructive command injection",
  },
  {
    id: "destructive-curl-pipe-sh",
    pattern: /\bcurl\s+[^\s|]+\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
    severity: "high",
  },
  {
    id: "destructive-wget-pipe-sh",
    pattern: /\bwget\s+[^\s|]+\s*-O\s*-\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
    severity: "high",
  },
  {
    id: "powershell-iex-net",
    pattern:
      /\b(?:iex|invoke-expression)\s*\(\s*(?:new-object\s+net\.webclient|invoke-webrequest)/i,
    severity: "high",
  },
  {
    id: "exfil-dotenv",
    pattern:
      /\b(?:cat|read|exfil(?:trate)?|upload|send|leak)\s+(?:the\s+)?(?:\.env|secrets?\.(?:json|yml|yaml)|id_rsa|\.aws\/credentials)/i,
    severity: "high",
  },
  {
    id: "exfil-credentials",
    pattern:
      /\b(?:send|post|upload|exfil(?:trate)?|forward)\s+(?:the\s+)?(?:credentials?|api[_\s-]?keys?|tokens?|passwords?)\s+(?:to|via|over)\b/i,
    severity: "high",
  },
  {
    id: "system-role-marker",
    pattern: /<\|im_start\|>\s*system|<\|system\|>|\[INST\][\s\S]*?\[\/INST\]/,
    severity: "high",
    description: "OpenAI/Anthropic role-marker injection",
  },
  {
    id: "anthropic-tag-injection",
    pattern: /<\/?(?:system|human|assistant)>/i,
    severity: "medium",
  },
  {
    id: "hidden-system",
    pattern:
      /\b(?:override|replace|update)\s+(?:your\s+)?system\s+(?:prompt|message|instructions)\b/i,
    severity: "high",
  },
  {
    id: "no-restrictions",
    pattern: /\b(?:no|without|removing)\s+(?:restrictions|filters|limits|safeguards|guardrails)\b/i,
    severity: "medium",
  },
  {
    id: "pretend-you-are",
    pattern:
      /\b(?:pretend|act as if|imagine|roleplay (?:as|that))\s+you\s+(?:are|were)\s+(?:not\s+|no\s+longer\s+)?(?:bound|restricted|limited|trained)\b/i,
    severity: "medium",
  },
  {
    id: "override-safety",
    pattern:
      /\b(?:bypass|circumvent|disable|override|turn off)\s+(?:your\s+)?(?:safety|content|moderation|alignment)/i,
    severity: "high",
  },
  {
    id: "tool-call-injection",
    pattern:
      /\b(?:invoke|call|run|execute)\s+(?:the\s+)?(?:Bash|Python|Shell|Write|Edit|Fetch|fetch|webFetch)\s+tool\s+with\b/i,
    severity: "medium",
  },
  {
    id: "auto-execute",
    pattern:
      /\b(?:then|next|after that|finally|now)\s+(?:run|execute|do)\s+(?:the following|this|these)\b[^\n]*\b(?:rm|curl|wget|chmod|chown|sudo|nc|ncat)\b/i,
    severity: "high",
  },
  {
    id: "ssh-key-action",
    pattern:
      /\b(?:upload|publish|push|copy|cat)\s+(?:my\s+|your\s+|the\s+)?(?:ssh\s+)?(?:public\s+)?key/i,
    severity: "medium",
  },
  {
    id: "kubectl-cluster-admin",
    pattern: /\bkubectl\s+(?:create|apply|patch)\s+(?:clusterrolebinding|role|rolebinding)\b/i,
    severity: "high",
  },
  {
    id: "git-push-force-main",
    pattern: /\bgit\s+push\s+(?:--force|-f)\s+\w+\s+(?:main|master)/i,
    severity: "medium",
  },
  {
    id: "iframe-embed",
    pattern: /<iframe\s+[^>]*\bsrc\s*=\s*["'](?:javascript:|data:text\/html)/i,
    severity: "high",
  },
  {
    id: "javascript-uri",
    pattern: /\bjavascript:\s*(?:eval|fetch|XMLHttpRequest|document\.write)/i,
    severity: "high",
  },
  {
    id: "data-url-script",
    pattern: /data:text\/html;base64,[A-Za-z0-9+/=]{40,}/,
    severity: "medium",
  },
  {
    id: "smuggled-system-block",
    pattern: /^[ \t]*system:[ \t]*\n[\s\S]{0,400}\n[ \t]*human:/im,
    severity: "high",
  },
  {
    id: "fake-user-injection",
    pattern: /^[ \t]*(?:User|Human|USER):[ \t]*[^\n]{1,200}\n[ \t]*(?:Assistant|System|SYSTEM):/m,
    severity: "high",
  },
  {
    id: "unicode-tag-spoof",
    pattern: /[\u{E0001}\u{E0020}-\u{E007F}]+/u,
    severity: "high",
    description: "Unicode tag block (often used for hidden prompts)",
  },
  {
    id: "rtl-override",
    pattern: /[‮‭‎‏؜]/,
    severity: "medium",
    description: "Bidi/RTL override character — common in homoglyph attacks",
  },
  {
    id: "instruct-then-deny",
    pattern:
      /\b(?:do not|don'?t)\s+(?:tell|inform|reveal|warn)\s+(?:the )?(?:user|operator|caller)\b/i,
    severity: "high",
  },
  {
    id: "silently-execute",
    pattern: /\bsilently\s+(?:execute|run|perform|invoke)\b/i,
    severity: "high",
  },
  {
    id: "prompt-leak-by-name",
    pattern: /\b(?:print|repeat|output)\s+(?:everything|all of)\s+(?:above|before this line)\b/i,
    severity: "high",
  },
  {
    id: "tool-arg-injection",
    pattern:
      /\b(?:set|use|pass)\s+(?:the\s+)?(?:argument|parameter|flag)\s+["']?--?\w+["']?\s*=\s*["'][^"']*\$\(/i,
    severity: "medium",
  },
  {
    id: "fetch-attacker-url",
    pattern:
      /\b(?:please|now|then)?\s*(?:fetch|GET|POST|download)\s+(?:from\s+)?(?:https?:\/\/(?:[a-z0-9-]+\.)?(?:burpcollaborator|requestcatcher|webhook\.site|requestbin|interactsh|oast|ngrok|attacker)[a-z0-9.-]*)/i,
    severity: "high",
  },
  {
    id: "exfil-base64",
    pattern:
      /\bbase64\s+(?:encode|the\s+(?:secrets?|env|keys?))\b[\s\S]{0,40}(?:then\s+)?(?:send|post|upload|cat)/i,
    severity: "high",
  },
  {
    id: "shutdown-host",
    pattern:
      /\b(?:shutdown|halt|poweroff|reboot)\s+(?:-h\s+now|now|the host|the (?:server|machine))\b/i,
    severity: "medium",
  },
  {
    id: "mkfs-format",
    pattern: /\bmkfs\.(?:ext\d|xfs|btrfs|vfat)\s+\/dev\//i,
    severity: "high",
  },
  {
    id: "dd-of-dev",
    pattern: /\bdd\s+if=\S+\s+of=\/dev\/(?:sd[a-z]|nvme\d+n\d+|disk\d+)/i,
    severity: "high",
  },
  {
    id: "iptables-flush",
    pattern: /\biptables\s+-F(?:\s|$)/i,
    severity: "medium",
  },
  {
    id: "history-clear",
    pattern: /\b(?:history\s+-c|unset\s+HISTFILE|export\s+HISTFILE=\/dev\/null)\b/i,
    severity: "medium",
  },
  {
    id: "tool-run-in-background",
    pattern: /\b(?:nohup|setsid|disown).*?(?:rm|curl|wget|nc|bash)\b/i,
    severity: "medium",
  },
  {
    id: "encoded-injection-marker",
    pattern: /(?:%69gnore|%69%67%6e%6f%72%65)\s+(?:%70revious|%70%72%65%76%69%6f%75%73)/i,
    severity: "medium",
  },
  {
    id: "instruction-tag-payload",
    pattern: /<\s*INSTRUCTIONS?\s*>[\s\S]{0,800}<\s*\/\s*INSTRUCTIONS?\s*>/i,
    severity: "medium",
  },
  {
    id: "markdown-instruction-block",
    pattern: /^[\s\S]{1,400}?^>+[ \t]*(?:You are|Ignore|Disregard|Forget|From now on)/im,
    severity: "low",
  },
  {
    id: "imperative-link",
    pattern: /\[click here\]\(\s*(?:javascript:|data:|file:)/i,
    severity: "medium",
  },
];

const MIN_CORPUS_RULES = 50;

/**
 * Defensive corpus-floor guard. If the rule list is ever trimmed below the
 * documented minimum, fail loudly at module-load instead of silently weakening
 * detection. Extracted (and re-exported via `__internals`) so the failure path
 * is testable without mutating the production corpus.
 */
function assertCorpusFloor(rules: ReadonlyArray<PromptInjectionRule>): void {
  if (rules.length < MIN_CORPUS_RULES) {
    throw new Error(
      `prompt-injection-detector regex corpus has ${rules.length} rules; minimum is ${MIN_CORPUS_RULES}`,
    );
  }
}

assertCorpusFloor(REGEX_RULES);

function severityWeight(s: PromptInjectionSeverity): number {
  return SEVERITY_WEIGHT[s];
}

function regexHits(
  text: string,
  rules: ReadonlyArray<PromptInjectionRule> = REGEX_RULES,
): PromptInjectionHit[] {
  const hits: PromptInjectionHit[] = [];
  for (const rule of rules) {
    const m = rule.pattern.exec(text);
    if (m === null) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    hits.push({
      rule: rule.id,
      span: [start, end],
      severity: rule.severity,
      layer: "regex",
    });
    if (rule.pattern.global) {
      // reset lastIndex so we don't surprise downstream consumers
      rule.pattern.lastIndex = 0;
    }
  }
  return hits;
}

function structuralHits(text: string): PromptInjectionHit[] {
  const hits: PromptInjectionHit[] = [];

  // BOM tampering — text shouldn't open with a BOM unless it's at the
  // start of a UTF document. Tool outputs almost never legitimately do.
  if (text.startsWith("﻿")) {
    hits.push({ rule: "structural-bom", span: [0, 1], severity: "low", layer: "structural" });
  }

  // Role-marker injection beyond the ones the regex layer already matches.
  // A cheap structural variant: "role:\nrole:" cluster on adjacent lines.
  const roleClusterRe =
    /(?:^|\n)[ \t]*(?:system|assistant|user|human)[ \t]*:[^\n]*\n[ \t]*(?:system|assistant|user|human)[ \t]*:/i;
  const role = roleClusterRe.exec(text);
  if (role) {
    hits.push({
      rule: "structural-role-cluster",
      span: [role.index, role.index + role[0].length],
      severity: "medium",
      layer: "structural",
    });
  }

  // Trailing imperative block: if the last 250 chars contain an imperative
  // verb and no preceding paragraph break, score it as suspicious. This
  // catches innocuous-looking tool output that ends with "Now run X".
  const tailStart = Math.max(0, text.length - 350);
  const tail = text.slice(tailStart);
  const tailImperative =
    /(?:^|\n)[ \t]*(?:now |then |finally )?(?:please[ \t]+)?(?:run|execute|fetch|delete|remove|email|upload|send|forward|leak|exfil(?:trate)?|shutdown|kill|chmod|chown|sudo)\b[^\n]{0,200}$/i;
  const t = tailImperative.exec(tail);
  if (t) {
    hits.push({
      rule: "structural-trailing-imperative",
      span: [tailStart + t.index, tailStart + t.index + t[0].length],
      severity: "medium",
      layer: "structural",
    });
  }

  // Long base64 with imperative neighbour — common smuggling shape.
  const b64 = /[A-Za-z0-9+/]{120,}={0,2}/.exec(text);
  if (b64 !== null) {
    const ctxStart = Math.max(0, b64.index - 80);
    const ctx = text.slice(ctxStart, b64.index);
    if (/(decode|run|execute|eval|payload|shell)/i.test(ctx)) {
      hits.push({
        rule: "structural-suspicious-base64",
        span: [b64.index, b64.index + b64[0].length],
        severity: "medium",
        layer: "structural",
      });
    }
  }

  // Smuggled URL with credential exfil pattern in the same line.
  const urlExfil =
    /(?:https?:\/\/[^\s)]+)[^\n]{0,80}\b(?:token|secret|api[_\s-]?key|cookie|session)\b/i.exec(
      text,
    );
  if (urlExfil) {
    hits.push({
      rule: "structural-url-exfil-pair",
      span: [urlExfil.index, urlExfil.index + urlExfil[0].length],
      severity: "medium",
      layer: "structural",
    });
  }

  return hits;
}

export type LlmClassifyFn = (
  text: string,
) => Promise<{ verdict: PromptInjectionClassification; rationale?: string } | undefined>;

export type ClassifyOptions = {
  /**
   * When set, layer 3 LLM classifier runs and its verdict can lift
   * "clean" → "suspicious" or upgrade an existing suspicious verdict
   * to "malicious". A `clean` verdict from the model is advisory only —
   * we never downgrade a high-severity regex hit.
   *
   * Activated when the runtime sets `CREWHAUS_PI_CLASSIFIER_MODEL` and
   * the runtime supplies the actual classify callback.
   */
  readonly llmClassifier?: LlmClassifyFn;
  /**
   * Override the suspicious / malicious thresholds. Mostly used by
   * tests; production should leave defaults.
   */
  readonly thresholds?: { readonly suspicious?: number; readonly malicious?: number };
};

function aggregateScore(hits: ReadonlyArray<PromptInjectionHit>): number {
  // Probabilistic OR: each hit raises the score multiplicatively.
  let p = 0;
  for (const h of hits) {
    const w = severityWeight(h.severity);
    p = 1 - (1 - p) * (1 - w);
  }
  return Math.min(1, p);
}

function classify(score: number, threshold: { suspicious: number; malicious: number }) {
  if (score >= threshold.malicious) return "malicious" as const;
  if (score >= threshold.suspicious) return "suspicious" as const;
  return "clean" as const;
}

function foldHomoglyphs(s: string): string {
  let out = "";
  for (const ch of s) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

/**
 * Canonical "match view" of the text. NFKC-folds full-width / compatibility
 * forms, strips zero-width/format/bidi/tag characters, maps confusable
 * homoglyphs to ASCII, and collapses whitespace runs to single spaces so the
 * literal-space anchors in the keyword rules match "ignore\n\nprevious" and
 * "ｉｇｎｏｒｅ　ｐｒｅｖｉｏｕｓ" alike (#143).
 */
function normalizeForMatch(text: string): string {
  const stripped = text.normalize("NFKC").replace(INVISIBLE_RE, "");
  return foldHomoglyphs(stripped).replace(/\s+/g, " ");
}

function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  return printable / s.length > 0.85;
}

function tryDecodeBase64(blob: string): string | undefined {
  if (blob.length < 16 || blob.length % 4 === 1) return undefined;
  try {
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    return isMostlyPrintable(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryDecodeHex(blob: string): string | undefined {
  if (blob.length < 16 || blob.length % 2 !== 0) return undefined;
  try {
    const decoded = Buffer.from(blob, "hex").toString("utf8");
    return isMostlyPrintable(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryDecodePercent(text: string): string | undefined {
  try {
    const decoded = decodeURIComponent(text);
    return decoded !== text ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recursively decode base64 / hex / percent-encoded blobs so an injection
 * hidden in an encoded payload is rescanned in cleartext, regardless of
 * neighbouring keywords (#143). Match counts and depth are bounded so this
 * cannot itself become a DoS vector.
 */
function decodedVariants(text: string, depth = 2): string[] {
  if (depth <= 0 || text.length === 0) return [];
  const out: string[] = [];
  const push = (s: string | undefined): void => {
    if (s !== undefined && s.length > 0) out.push(s, ...decodedVariants(s, depth - 1));
  };
  for (const m of [...text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].slice(0, 8)) {
    push(tryDecodeBase64(m[0]));
  }
  for (const m of [...text.matchAll(/(?:[0-9A-Fa-f]{2}){8,}/g)].slice(0, 8)) {
    push(tryDecodeHex(m[0]));
  }
  if (/%[0-9A-Fa-f]{2}/.test(text)) push(tryDecodePercent(text));
  return out.slice(0, 16);
}

/**
 * Classify a tool output. Pure with respect to the input string when
 * the LLM classifier is not supplied.
 */
export async function classifyText(
  text: string,
  opts: ClassifyOptions = {},
): Promise<PromptInjectionResult> {
  const threshold = {
    suspicious: opts.thresholds?.suspicious ?? SCORE_SUSPICIOUS,
    malicious: opts.thresholds?.malicious ?? SCORE_MALICIOUS,
  };
  if (text === "") {
    return { classification: "clean", score: 0, hits: [] };
  }
  // Bound the work the regex/structural layers do so a pathological input
  // can't wedge the classifier (#153). Keep head + tail so leading and
  // trailing injections both stay in view.
  const analyzed =
    text.length > MAX_CLASSIFY_LEN
      ? `${text.slice(0, MAX_CLASSIFY_LEN / 2)}\n${text.slice(-MAX_CLASSIFY_LEN / 2)}`
      : text;
  // De-obfuscate into match views so the keyword rules can't be dodged with
  // full-width characters, zero-width splits, homoglyphs, whitespace tricks,
  // or base64/percent/hex encoding (#143). Structural rules run on the raw
  // (bounded) text; regex rules run on every variant, deduped by rule id.
  const variants = [analyzed, normalizeForMatch(analyzed), ...decodedVariants(analyzed)];
  const regHits: PromptInjectionHit[] = [];
  const seenRules = new Set<string>();
  for (const variant of variants) {
    for (const h of regexHits(variant)) {
      if (seenRules.has(h.rule)) continue;
      seenRules.add(h.rule);
      regHits.push(h);
    }
  }
  const hits: PromptInjectionHit[] = [...regHits, ...structuralHits(analyzed)];
  let score = aggregateScore(hits);
  let classification = classify(score, threshold);

  if (opts.llmClassifier !== undefined) {
    try {
      const verdict = await opts.llmClassifier(analyzed);
      if (verdict !== undefined) {
        if (verdict.verdict === "malicious") {
          classification = "malicious";
          score = Math.max(score, threshold.malicious);
          hits.push({
            rule: "llm-malicious",
            span: [0, Math.min(text.length, 200)],
            severity: "high",
            layer: "llm",
          });
        } else if (verdict.verdict === "suspicious" && classification === "clean") {
          classification = "suspicious";
          score = Math.max(score, threshold.suspicious);
          hits.push({
            rule: "llm-suspicious",
            span: [0, Math.min(text.length, 200)],
            severity: "medium",
            layer: "llm",
          });
        }
      }
    } catch {
      // LLM tier is best-effort; swallow so a model outage doesn't
      // block tool execution.
    }
  }

  return { classification, score, hits };
}

/**
 * Build a redaction notice safe to substitute for the original tool
 * output. The notice names the rules that fired so that auditors can
 * verify the decision later.
 */
export function buildRedactionNotice(hits: ReadonlyArray<PromptInjectionHit>): string {
  const ids = [...new Set(hits.map((h) => h.rule))].slice(0, 6);
  return `[tool output redacted: prompt injection detected: ${ids.join(", ")}]`;
}

/**
 * Returns true when the env-driven LLM classifier should run.
 */
export function llmClassifierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const m = env["CREWHAUS_PI_CLASSIFIER_MODEL"];
  return m !== undefined && m.trim() !== "";
}

/**
 * Internal seams exposed ONLY for unit tests. Not part of the public API and
 * not subject to semver — these let the test suite drive the module's
 * defensive branches (corpus-floor guard, global-flag `lastIndex` reset, and
 * the decoder `try/catch` fallbacks) with crafted inputs that the public
 * `classifyText` entrypoint can never construct on its own. Do not import
 * from application code.
 */
export const __internals = {
  assertCorpusFloor,
  regexHits,
  tryDecodeBase64,
  tryDecodeHex,
  tryDecodePercent,
  MIN_CORPUS_RULES,
} as const;
