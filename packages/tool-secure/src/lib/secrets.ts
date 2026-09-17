/**
 * Credential detection.
 *
 * ## The one hard rule
 *
 * A finding never carries the secret. Every value that reaches a result goes
 * through `maskValue` first, and the tests assert that the serialized result
 * of scanning a known credential does not contain that credential. A scanner
 * that prints what it found has moved the secret from a file into a
 * transcript, a log and a model's context window — three more places it has
 * to be rotated out of.
 *
 * ## What the rules are
 *
 * Two kinds. VENDOR rules key on a published, distinctive prefix
 * (`AKIA…`, `ghp_…`, `sk-ant-…`); they are precise and they go stale — a
 * provider that changes its key format silently stops being covered here.
 * STRUCTURAL rules key on shape: a PEM block, a JWT, a URL with a password
 * in the authority, an assignment to something called `password`.
 *
 * ## What it cannot do
 *
 * It cannot tell a live key from a revoked one, a real key from an example
 * in documentation, or a missing rule from a clean file. `SecretScan`
 * reports the rule list it ran precisely so that "no findings" reads as
 * "none of THESE matched", which is the only claim it can support.
 *
 * The high-entropy rule is deliberately context-gated by default: commit
 * hashes, UUIDs, base64 images and minified code are all high entropy, and a
 * scanner that cries wolf on them gets switched off.
 */
import { type Charset, classifyCharset, looksHighEntropy, roundBits, shannonEntropy } from "./entropy";
import { type Finding, matchAll, maskValue, sortFindings, withPositions } from "./text";

export type Severity = "critical" | "high" | "medium" | "low";

export type SecretRule = {
  readonly id: string;
  readonly kind: "vendor" | "structural";
  readonly description: string;
  readonly severity: Severity;
  readonly pattern: RegExp;
  /** Which capture group holds the secret itself. 0 = the whole match. */
  readonly group?: number;
};

/**
 * The rule table, in scan order. Ids are stable: an operator's allow-list of
 * accepted findings keys on them.
 */
export const SECRET_RULES: ReadonlyArray<SecretRule> = [
  {
    id: "aws.access-key-id",
    kind: "vendor",
    description: "AWS access key id (AKIA/ASIA/… followed by 16 upper-case base32 characters)",
    severity: "high",
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "aws.secret-access-key",
    kind: "vendor",
    description: "AWS secret access key assigned to an aws_secret_access_key-style name",
    severity: "critical",
    pattern: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
    group: 1,
  },
  {
    id: "github.token",
    kind: "vendor",
    description: "GitHub personal access, OAuth, user, server or refresh token (gh[pousr]_…)",
    severity: "critical",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    id: "github.fine-grained-pat",
    kind: "vendor",
    description: "GitHub fine-grained personal access token (github_pat_…)",
    severity: "critical",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  },
  {
    id: "gitlab.token",
    kind: "vendor",
    description: "GitLab personal or project access token (glpat-…)",
    severity: "critical",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "slack.token",
    kind: "vendor",
    description: "Slack bot, user, app or refresh token (xox[abposr]-…)",
    severity: "critical",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "slack.webhook",
    kind: "vendor",
    description: "Slack incoming-webhook URL, which is itself the credential",
    severity: "high",
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]{20,}/g,
  },
  {
    id: "stripe.secret-key",
    kind: "vendor",
    description: "Stripe secret or restricted key (sk_live/sk_test/rk_…)",
    severity: "critical",
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "stripe.publishable-key",
    kind: "vendor",
    description: "Stripe publishable key — public by design, reported so it is not mistaken for a secret",
    severity: "low",
    pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "anthropic.api-key",
    kind: "vendor",
    description: "Anthropic API key (sk-ant-…)",
    severity: "critical",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai.api-key",
    kind: "vendor",
    description: "OpenAI API key (sk-… / sk-proj-…)",
    severity: "critical",
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "google.api-key",
    kind: "vendor",
    description: "Google API key (AIza followed by 35 characters)",
    severity: "high",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "sendgrid.api-key",
    kind: "vendor",
    description: "SendGrid API key (SG.<id>.<secret>)",
    severity: "critical",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: "twilio.api-key",
    kind: "vendor",
    description: "Twilio API key SID (SK followed by 32 hex characters)",
    severity: "high",
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
  },
  {
    id: "npm.token",
    kind: "vendor",
    description: "npm access token (npm_…)",
    severity: "critical",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "pypi.token",
    kind: "vendor",
    description: "PyPI upload token (pypi-…)",
    severity: "critical",
    pattern: /\bpypi-[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    id: "private-key.pem-block",
    kind: "structural",
    description: "PEM private-key header; the key body follows it",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "jwt.compact",
    kind: "structural",
    description: "JWT in compact serialization; a bearer token unless it is a public id token",
    severity: "medium",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "url.credentials",
    kind: "structural",
    description: "Connection string or URL carrying a password in the authority (scheme://user:pass@host)",
    severity: "high",
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:([^\s@/]{1,128})@[^\s/]{1,255}/gi,
    group: 1,
  },
  {
    id: "http.basic-auth-header",
    kind: "structural",
    description: "HTTP Basic Authorization header; the base64 decodes to user:password",
    severity: "high",
    pattern: /authorization\s*:\s*basic\s+([A-Za-z0-9+/=]{8,})/gi,
    group: 1,
  },
  {
    id: "generic.assignment",
    kind: "structural",
    description: "A value assigned to a password/secret/token/api-key-shaped name",
    severity: "medium",
    pattern:
      /\b(?:password|passwd|pwd|secret|client_secret|token|access_token|auth_token|api[_-]?key|apikey|private[_-]?key|credential)["']?\s*[:=]\s*["']([^"'\n]{8,200})["']/gi,
    group: 1,
  },
];

const RULES_BY_ID: ReadonlyMap<string, SecretRule> = new Map(SECRET_RULES.map((r) => [r.id, r]));

/**
 * Values that match a rule but are placeholders, not credentials. Kept short
 * and literal; anything cleverer would start guessing.
 */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|(?:your|my|the|some|example|sample|dummy|fake|test|placeholder|redacted|changeme|insert)[_a-z0-9-]*)$/i;

/** Context that makes a high-entropy string worth reporting. */
const CREDENTIAL_CONTEXT =
  /(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|auth|bearer|credential|private[_-]?key|access[_-]?key|session|signature)/i;

const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{20,120}/g;

export type SecretHit = {
  readonly rule: string;
  readonly kind: "vendor" | "structural";
  readonly severity: Severity;
  readonly description: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly length: number;
  /** The ONLY view of the value that ever leaves this module. */
  readonly masked: string;
  readonly entropyBits: number;
  readonly charset: Charset;
};

export type SecretScanOptions = {
  /** Restrict to these rule ids. Unknown ids are an error, not a silent no-op. */
  readonly rules?: ReadonlyArray<string>;
  /** Also run the context-gated high-entropy rule. Default true. */
  readonly highEntropy?: boolean;
  /** Bits-per-character floor for the high-entropy rule. Default is per-charset. */
  readonly minEntropy?: number;
  /**
   * Require a credential-ish word near a high-entropy string. Default true;
   * turning it off surfaces every opaque blob, hashes and UUIDs included.
   */
  readonly requireContext?: boolean;
};

export class SecretRuleError extends Error {
  override readonly name = "SecretRuleError";
}

/** The rules a given options object will actually run, in scan order. */
export function selectRules(options: SecretScanOptions = {}): SecretRule[] {
  if (options.rules === undefined) return [...SECRET_RULES];
  const unknown = options.rules.filter((id) => !RULES_BY_ID.has(id));
  if (unknown.length > 0) {
    throw new SecretRuleError(
      `unknown secret rule id(s): ${unknown.join(", ")} — known ids are ${SECRET_RULES.map((r) => r.id).join(", ")}`,
    );
  }
  return SECRET_RULES.filter((r) => options.rules?.includes(r.id));
}

/** Scan text. The returned hits are already masked. */
export function scanSecrets(text: string, options: SecretScanOptions = {}): SecretHit[] {
  const rules = selectRules(options);
  const raw: Array<Omit<Finding, "line" | "column">> = [];

  for (const rule of rules) {
    for (const { index, match } of matchAll(text, rule.pattern)) {
      const group = rule.group ?? 0;
      const value = match[group];
      if (value === undefined || value.length === 0) continue;
      if (PLACEHOLDER.test(value)) continue;
      // Offset of the captured group inside the whole match: the group text is
      // unique enough in practice, and indexOf keeps this independent of the
      // `d` flag, which would change the rule table's shape for one detail.
      const offset = group === 0 ? 0 : Math.max(0, match[0].indexOf(value));
      raw.push({
        type: rule.id,
        rule: rule.id,
        confidence: rule.kind === "vendor" ? "likely" : "possible",
        start: index + offset,
        end: index + offset + value.length,
        value,
        detail: { severity: rule.severity },
      });
    }
  }

  if (options.highEntropy !== false) {
    const requireContext = options.requireContext !== false;
    for (const { index, match } of matchAll(text, HIGH_ENTROPY_CANDIDATE)) {
      const value = match[0];
      if (PLACEHOLDER.test(value)) continue;
      const { high } = looksHighEntropy(value, options.minEntropy);
      if (!high) continue;
      if (requireContext) {
        const before = text.slice(Math.max(0, index - 60), index);
        if (!CREDENTIAL_CONTEXT.test(before)) continue;
      }
      // A vendor rule already covering this span is the better finding.
      if (raw.some((f) => index < f.end && f.start < index + value.length)) continue;
      raw.push({
        type: "generic.high-entropy",
        rule: "generic.high-entropy",
        confidence: "possible",
        start: index,
        end: index + value.length,
        value,
        detail: { severity: "low" },
      });
    }
  }

  const located = sortFindings(withPositions(text, raw));
  return located.map((f) => {
    const rule = RULES_BY_ID.get(f.rule);
    const { bits } = shannonEntropy(f.value);
    return {
      rule: f.rule,
      kind: rule?.kind ?? "structural",
      severity: (rule?.severity ?? "low") as Severity,
      description:
        rule?.description ??
        "opaque high-entropy string near a credential-shaped word (heuristic, not a vendor rule)",
      line: f.line,
      column: f.column,
      start: f.start,
      length: f.value.length,
      masked: maskValue(f.value),
      entropyBits: roundBits(bits),
      charset: classifyCharset(f.value),
    };
  });
}

/**
 * The spans a redactor should replace, derived from the same rules. Returned
 * as `Finding`s (value included) because the caller is about to remove them;
 * it is the scanner's OUTPUT that must never carry a value.
 */
export function secretSpans(text: string, options: SecretScanOptions = {}): Finding[] {
  const rules = selectRules(options);
  const raw: Array<Omit<Finding, "line" | "column">> = [];
  for (const rule of rules) {
    for (const { index, match } of matchAll(text, rule.pattern)) {
      const group = rule.group ?? 0;
      const value = match[group];
      if (value === undefined || value.length === 0) continue;
      if (PLACEHOLDER.test(value)) continue;
      const offset = group === 0 ? 0 : Math.max(0, match[0].indexOf(value));
      raw.push({
        type: rule.id,
        rule: rule.id,
        confidence: rule.kind === "vendor" ? "likely" : "possible",
        start: index + offset,
        end: index + offset + value.length,
        value,
        detail: { severity: rule.severity },
      });
    }
  }
  return withPositions(text, raw);
}

/** Summarize hits by severity, highest first, for a one-line verdict. */
export function severityCounts(hits: ReadonlyArray<SecretHit>): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const hit of hits) counts[hit.severity] += 1;
  return counts;
}
