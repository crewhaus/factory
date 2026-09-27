import type { PatternAnswer } from "./regex";

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

/** Walk a dotted path (`user.name`, `items.0.id`) through plain data. */
export function lookupPath(data: unknown, path: string): unknown {
  if (path === ".") return data;
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Render `{{path}}` placeholders against `data`.
 *
 * Deliberately not a general template language: no loops, no conditionals,
 * no partials, no arbitrary expressions. A harness needing those should
 * build the string it wants and pass it in. What this guarantees is the part
 * that matters — the same data and template always produce the same bytes,
 * and under `strict` a typo in a placeholder is an error rather than an
 * empty string silently shipped to a customer.
 *
 * `{{{path}}}` is accepted as a synonym for `{{path}}`; this renders text,
 * not HTML, so there is no escaping distinction to draw.
 */
export function renderTemplateString(
  template: string,
  data: unknown,
  strict: boolean,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (_full, path: string) => {
    const value = lookupPath(data, path);
    if (value === undefined || value === null) {
      missing.push(path);
      return "";
    }
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
  const unique = [...new Set(missing)];
  if (strict && unique.length > 0) {
    throw new TemplateError(
      `template references ${unique.map((p) => `"${p}"`).join(", ")}, which the data does not provide`,
    );
  }
  return { text, missing: unique };
}

export type ClassifyRule = {
  readonly label: string;
  readonly patterns: ReadonlyArray<string>;
  readonly weight?: number;
  readonly regex?: boolean;
};

export type ClassifyResult = {
  readonly label: string | null;
  readonly score: number;
  readonly matched: ReadonlyArray<string>;
  readonly scores: Readonly<Record<string, number>>;
  /**
   * Regex patterns with no answer (the worker's deadline, the engine giving
   * up). When any is listed, `label` is null: a pattern that might have
   * matched could change the winner, so neither the top label nor the
   * default is given.
   */
  readonly undetermined?: ReadonlyArray<{ readonly pattern: string; readonly reason: string }>;
};

/**
 * Score text against operator-written rules and return the best label.
 *
 * Lexical only — phrase and regex matching with per-rule weights. No model
 * and no embedding, so the same message always gets the same label, which is
 * what makes it safe to route on.
 *
 * A regex rule's pattern is never run here: `regexAnswers` holds its answer
 * on this text, worked out in the regex worker beforehand (the tool does
 * that with `answerPatterns`). A pattern with no definite answer leaves the
 * label undetermined.
 */
export function classifyByRules(
  text: string,
  rules: ReadonlyArray<ClassifyRule>,
  threshold: number,
  defaultLabel: string | null,
  regexAnswers: ReadonlyMap<string, PatternAnswer> = new Map(),
): ClassifyResult {
  const haystack = text.toLowerCase();
  // Labels are the caller's text: a label named `constructor` or
  // `__proto__` is a label, never an Object.prototype member.
  const scores: Record<string, number> = Object.create(null);
  const matched: string[] = [];
  const undetermined: Array<{ pattern: string; reason: string }> = [];
  for (const rule of rules) {
    const weight = rule.weight ?? 1;
    let hits = 0;
    for (const pattern of rule.patterns) {
      let found: boolean;
      if (rule.regex === true) {
        const answer = regexAnswers.get(pattern);
        if (typeof answer !== "boolean") {
          undetermined.push({
            pattern,
            reason: answer?.undetermined ?? "the pattern was not answered before classifying",
          });
          continue;
        }
        found = answer;
      } else {
        found = haystack.includes(pattern.toLowerCase());
      }
      if (found) {
        hits += 1;
        matched.push(pattern);
      }
    }
    if (hits > 0) scores[rule.label] = (scores[rule.label] ?? 0) + hits * weight;
  }
  if (undetermined.length > 0) {
    const best = Math.max(0, ...Object.values(scores));
    return { label: null, score: best, matched, scores, undetermined };
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  if (top === undefined || top[1] < threshold) {
    return { label: defaultLabel, score: top?.[1] ?? 0, matched, scores };
  }
  return { label: top[0], score: top[1], matched, scores };
}
