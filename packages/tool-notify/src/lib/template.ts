/**
 * Message templates, where the operator owns the structure and the model
 * only ever supplies values.
 *
 * `@crewhaus/tool-text`'s `RenderTemplate` fills placeholders in a string.
 * This is the same idea with one extra rule that matters here and nowhere
 * else: the values are escaped for the platform the message is going to,
 * BEFORE they are substituted. A deploy summary containing `<!channel>` or
 * ```` ``` ```` would otherwise change what the message does, not just what
 * it says — which is the whole reason a harness should not be assembling
 * notification strings by hand.
 *
 * Missing keys are an error, never an empty string. A notification that
 * silently reads "deploy of  failed at " is worse than one that did not go
 * out, because somebody acts on it.
 */
import type { Platform } from "./blocks";
import { escapeFor } from "./blocks";

/** `{{ name }}` or `{{ a.b.c }}`; whitespace inside the braces is ignored. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.]*)\s*\}\}/g;

export type RenderResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** Placeholder names that were filled, sorted and de-duplicated. */
      readonly used: readonly string[];
      /** Keys present in the data that no placeholder asked for. */
      readonly unused: readonly string[];
    }
  | { readonly ok: false; readonly missing: readonly string[] };

/** Read a dotted path out of the data object. */
function lookup(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * How a value becomes text.
 *
 * Numbers and booleans are written out; `null` and `undefined` count as
 * missing rather than rendering the word "null"; objects and arrays are
 * JSON-encoded, because a template that interpolates a structure wants to
 * SHOW it, and `[object Object]` in a production alert helps nobody.
 */
function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** All the placeholder names a template refers to, in first-seen order. */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Fill `template` from `data`, escaping every substituted value for
 * `platform`.
 *
 * The template itself is NOT escaped: it is operator-authored, so its `*`
 * and `<…|…>` are the formatting the operator intended. Only the values are,
 * which is exactly the boundary that makes the result safe — a value can
 * never introduce structure, and the structure can never be introduced by
 * anything but the template.
 */
export function renderTemplate(
  template: string,
  data: Readonly<Record<string, unknown>>,
  platform: Platform,
): RenderResult {
  const missing: string[] = [];
  const used = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_whole, rawName: string) => {
    const name = rawName;
    const value = stringify(lookup(data, name));
    if (value === null) {
      missing.push(name);
      return "";
    }
    used.add(name);
    return escapeFor(platform, value);
  });
  if (missing.length > 0) {
    return { ok: false, missing: [...new Set(missing)].sort() };
  }
  const referenced = new Set(templatePlaceholders(template).map((n) => n.split(".")[0] as string));
  const unused = Object.keys(data)
    .filter((key) => !referenced.has(key))
    .sort();
  return { ok: true, text, used: [...used].sort(), unused };
}
