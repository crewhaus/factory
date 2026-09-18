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
};

/**
 * Score text against operator-written rules and return the best label.
 *
 * Lexical only — phrase and regex matching with per-rule weights. No model
 * and no embedding, so the same message always gets the same label, which is
 * what makes it safe to route on.
 */
export function classifyByRules(
  text: string,
  rules: ReadonlyArray<ClassifyRule>,
  threshold: number,
  defaultLabel: string | null,
): ClassifyResult {
  const haystack = text.toLowerCase();
  const scores: Record<string, number> = {};
  const matched: string[] = [];
  for (const rule of rules) {
    const weight = rule.weight ?? 1;
    let hits = 0;
    for (const pattern of rule.patterns) {
      const found =
        rule.regex === true
          ? new RegExp(pattern, "i").test(text)
          : haystack.includes(pattern.toLowerCase());
      if (found) {
        hits += 1;
        matched.push(pattern);
      }
    }
    if (hits > 0) scores[rule.label] = (scores[rule.label] ?? 0) + hits * weight;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  if (top === undefined || top[1] < threshold) {
    return { label: defaultLabel, score: top?.[1] ?? 0, matched, scores };
  }
  return { label: top[0], score: top[1], matched, scores };
}
