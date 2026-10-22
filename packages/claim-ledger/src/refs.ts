/**
 * The evidence-reference grammar: what a definition line's source IS.
 *
 * `citationDefinitions` reads `[1]: <source>` and hands back the whole rest
 * of the line, as it always has. This reads that source once more and says
 * what kind of thing it names (design §4.1):
 *
 *   [1]: https://acme.example/policy        url     (cited; grounded when fetched)
 *   [2]: ./docs/pricing.md#refunds          path    (a workspace file)
 *   [3]: doi:10.1000/xyz123                 doi
 *   [4]: tool:toolu_01H…                    tool    (execution evidence, `checked`)
 *   [5]: proof:prf_3f9a…                    proof   (a formal artifact, `proven`)
 *   [A1]: assume: the fiscal year starts in April      assume
 *   [6]: Smith, J. (2024). Refunds. Acme Press.       text
 *
 * The grammar is backward compatible by construction: the definition pattern
 * did not change, so every existing document parses as before, and the new
 * prefixes are simply sources CitationLint and FactCrossCheck could not
 * locate. Nothing here opens, fetches or resolves anything — the kind is read
 * off the characters, and the provability gate decides what each kind needs.
 */
import { hasUriScheme, splitLinkTarget, withoutLinkTitle } from "./markdown";

export type EvidenceRef =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "doi"; readonly doi: string }
  | { readonly kind: "path"; readonly path: string; readonly fragment?: string }
  | { readonly kind: "tool"; readonly toolUseId: string }
  | { readonly kind: "proof"; readonly proofId: string }
  | { readonly kind: "assume"; readonly text: string }
  | { readonly kind: "text"; readonly text: string };

export type EvidenceRefKind = EvidenceRef["kind"];

/** `tool:`, `proof:`, `assume:`, `doi:` — the scheme is case-insensitive, the value trimmed. */
const PREFIXED = /^(tool|proof|assume|doi):\s*([\s\S]*)$/i;

/** A DOI written bare, as one is usually printed: `10.1000/xyz123`. */
const BARE_DOI = /^10\.\d{4,9}\/\S+$/;

/**
 * Sentence punctuation a URL is not taken to end with — GitHub's autolink
 * rule, for the same reason: "see https://acme.example/policy." means the
 * page, not a page whose path ends in a full stop.
 */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** The first whitespace-free run of a value, which is all an identifier can be. */
const firstWord = (value: string): string => value.split(/\s/, 1)[0] ?? "";

/**
 * A destination without the title after it, in any of the three forms a
 * Markdown link reference definition may use: `"…"`, `'…'` or `(…)`, each
 * after whitespace. The double-quoted form is `withoutLinkTitle`, the reader
 * the link checker uses; the other two are read here the same way, from the
 * end, so `./a.md 'Title'` names the same file as `./a.md "Title"`. A `(`
 * with no whitespace before it is part of the destination (`Foo_(bar).md`).
 */
function withoutTitle(text: string): string {
  const doubleQuoted = withoutLinkTitle(text);
  if (doubleQuoted !== text) return doubleQuoted;
  const end = text.trimEnd().length;
  const close = text[end - 1];
  const open = close === "'" ? "'" : close === ")" ? "(" : null;
  if (open === null || end < 2) return text;
  const at = text.lastIndexOf(open, end - 2);
  if (at < 1 || !/\s/.test(text[at - 1] as string)) return text;
  return text.slice(0, at).trimEnd();
}

/**
 * A definition's destination: the title after it dropped, and `<…>`
 * unwrapped — the forms a Markdown link reference definition may take.
 */
function destinationOf(source: string): { readonly value: string; readonly bracketed: boolean } {
  const trimmed = source.trim();
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close > 0) return { value: trimmed.slice(1, close).trim(), bracketed: true };
  }
  return { value: withoutTitle(trimmed).trim(), bracketed: false };
}

/**
 * What a definition's source names. `source` is a value `citationDefinitions`
 * returned (the whole rest of the definition line).
 *
 * - `tool:` / `proof:` / `doi:` take the first word after the prefix, so a
 *   gloss after it (`tool:toolu_01 (MoneyAdd)`) is not part of the id;
 *   `assume:` takes everything after it. A prefix with nothing after it names
 *   nothing, and is `text`. A `doi:` value must have a DOI's shape, the same
 *   one a bare DOI is held to: `doi:hello` or `doi:../../admin` is a
 *   locatable kind in name only, and the `cited` rung lets a `doi` through.
 * - `http://` / `https://` is a `url`: the first word, a trailing full stop
 *   or comma dropped — `[1]: https://acme.example/policy — Acme refunds` is
 *   the page.
 * - Any other scheme (`mailto:`, `ftp:`, `file:`, and the `Note:` of a prose
 *   source) is `text`: nothing the gate can locate.
 * - A relative, `./` or `../` destination, an absolute path, and anything
 *   path-shaped — no whitespace, and a `/` or a file extension — is a `path`,
 *   split at `#` by `splitLinkTarget`, the one rule the link checker and
 *   FactCrossCheck use. `<docs/my report.md>` may hold spaces, as a Markdown
 *   destination in angle brackets may. A bare host such as
 *   `arxiv.org/abs/1234` is a `path` too, deliberately: it is what a Markdown
 *   renderer makes of it (a relative link), `example.com` cannot be told from
 *   `report.md` without a list of top-level domains, and guessing a scheme
 *   would ground a citation in a page nobody named. The gate then reports a
 *   file that is not in the workspace, which tells the author to write the
 *   URL out.
 * - A bare DOI (`10.1000/xyz123`) is a `doi`, not a path.
 * - Anything else — "Smith, J. (2024) …", a bare word, a fragment alone — is
 *   `text`: a bibliographic reference, accepted only where the spec says so.
 */
export function classifyDefinition(source: string): EvidenceRef {
  const whole = source.trim();
  const prefixed = PREFIXED.exec(whole);
  if (prefixed !== null) {
    const scheme = (prefixed[1] as string).toLowerCase();
    const value = (prefixed[2] as string).trim();
    if (value === "") return { kind: "text", text: whole };
    if (scheme === "assume") return { kind: "assume", text: value };
    const id = firstWord(value);
    if (scheme === "tool") return { kind: "tool", toolUseId: id };
    if (scheme === "proof") return { kind: "proof", proofId: id };
    return BARE_DOI.test(id) ? { kind: "doi", doi: id } : { kind: "text", text: whole };
  }

  const { value, bracketed } = destinationOf(whole);
  if (value === "") return { kind: "text", text: whole };
  if (/^https?:\/\//i.test(value)) {
    const url = (bracketed ? value : firstWord(value)).replace(TRAILING_PUNCTUATION, "");
    // `https://` and nothing after it names no page.
    if (/^https?:\/\/[^/?#\s]/i.test(url)) return { kind: "url", url };
    return { kind: "text", text: whole };
  }
  if (BARE_DOI.test(value)) return { kind: "doi", doi: value };
  if (hasUriScheme(value)) return { kind: "text", text: whole };

  const pathShaped =
    bracketed ||
    (!/\s/.test(value) &&
      (/^\.{1,2}\//.test(value) ||
        value.includes("/") ||
        /\.[A-Za-z0-9]{1,10}(?:#|$)/.test(value)));
  if (!pathShaped) return { kind: "text", text: whole };
  const { target, fragment } = splitLinkTarget(value);
  // `#section` alone points inside the document itself, not at a source.
  if (target === "") return { kind: "text", text: whole };
  return fragment === undefined || fragment === ""
    ? { kind: "path", path: target }
    : { kind: "path", path: target, fragment };
}

/**
 * Is this marker id an assumption's, `A` and digits (`[A1]`, `[A12]`)? A
 * convention the gate's nudge and the skill teach, not a rule: what makes a
 * binding an assumption is its definition's `assume:` prefix, whatever the
 * marker is called.
 */
export function isAssumptionMarker(id: string): boolean {
  return /^A\d+$/.test(id);
}

/** A Markdown link title, the whole of what may follow a destination unseen: `"…"`, `'…'`, `(…)`. */
const LINK_TITLE = /^(?:"[^"]*"|'[^']*'|\([^)]*\))$/;

/**
 * The text a definition line shows the reader beyond what it names:
 * `[8]: https://acme.example/x Payments clear within 5 days` → `Payments
 * clear within 5 days`. Empty when the line is a destination and at most a
 * link title — CommonMark renders such a definition as nothing at all.
 *
 * `[8]: https://… Payments clear within 5 days` is not a valid link
 * reference definition, so it renders as that sentence: a reader sees an
 * assertion there. `extractClaims` leaves a definition line out only when
 * what it shows is empty or is read as claims by the provability gate
 * (which binds them to the definition they sit under), so no text a
 * definition shows goes unread.
 *
 * `ref` is `classifyDefinition(source)`. A URL or `doi:`/`tool:`/`proof:`
 * id is its first word (or a `<…>` destination), so whatever follows it is
 * shown; a `path` holds no whitespace outside `<…>`, so only a title can
 * follow it; an `assume:` line is a declared assumption, shown as one and
 * counted where it is cited, so it is not read again. A free-text source is
 * all text — unless `bibliographic` accepts free text as a reference
 * ("Smith, J. (2024). Annual report."), in which case the whole of it is
 * the reference, as a URL is, and only what follows a URL, DOI, path or id
 * is ever read as prose.
 */
export function definitionGloss(source: string, ref: EvidenceRef, bibliographic = false): string {
  const whole = source.trim();
  if (ref.kind === "assume") return "";
  if (ref.kind === "text") return bibliographic ? "" : whole;
  let rest: string;
  if (/^(?:tool|proof|doi):/i.test(whole)) {
    rest = /^[a-z]+:\s*\S+([\s\S]*)$/i.exec(whole)?.[1] ?? "";
  } else if (whole.startsWith("<")) {
    const close = whole.indexOf(">");
    rest = close === -1 ? "" : whole.slice(close + 1);
  } else {
    const space = whole.search(/\s/);
    rest = space === -1 ? "" : whole.slice(space);
  }
  rest = rest.trim();
  if (rest === "" || LINK_TITLE.test(rest)) return "";
  return rest.replace(/^[—–\-:|,;]+\s*/, "").trim();
}
