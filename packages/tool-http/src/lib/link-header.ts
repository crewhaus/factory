/**
 * RFC 5988 / RFC 8288 `Link` header parsing.
 *
 * This is how most paginated APIs say "there is more": a header of the form
 *
 *   <https://api.example.com/items?page=2>; rel="next", <...>; rel="last"
 *
 * Pure string work, so it is tested without a socket. Quoted parameter
 * values may contain commas and semicolons, which is why this is a scanner
 * rather than a `split(",")`.
 */

export type LinkRef = {
  readonly uri: string;
  readonly params: Readonly<Record<string, string>>;
  /** Lowercased, whitespace-split `rel` values. Empty when `rel` is absent. */
  readonly rels: readonly string[];
};

/** Split a header value at top-level commas, ignoring commas inside <> or "". */
function splitRefs(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inAngle = false;
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (inQuote) {
      if (ch === "\\") i++;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    else if (ch === "," && !inAngle) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Split one reference at top-level semicolons, ignoring those inside quotes. */
function splitParams(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (inQuote) {
      if (ch === "\\") i++;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === ";") {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim());
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** Every link reference in a `Link` header value, in header order. */
export function parseLinkHeader(value: string): readonly LinkRef[] {
  const refs: LinkRef[] = [];
  for (const raw of splitRefs(value)) {
    const segments = splitParams(raw);
    const first = segments[0];
    if (first === undefined) continue;
    const open = first.indexOf("<");
    const close = first.lastIndexOf(">");
    if (open === -1 || close <= open) continue; // not a link reference
    const uri = first.slice(open + 1, close).trim();
    if (uri === "") continue;
    const params: Record<string, string> = {};
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf("=");
      if (eq === -1) {
        if (segment !== "") params[segment.toLowerCase()] = "";
        continue;
      }
      params[segment.slice(0, eq).trim().toLowerCase()] = unquote(segment.slice(eq + 1));
    }
    const rel = params["rel"];
    refs.push({
      uri,
      params,
      rels:
        rel === undefined
          ? []
          : rel
              .toLowerCase()
              .split(/\s+/)
              .filter((r) => r !== ""),
    });
  }
  return refs;
}

/** The URI of the first reference carrying this `rel`, or `undefined`. */
export function relTarget(value: string | null, rel: string): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const wanted = rel.toLowerCase();
  return parseLinkHeader(value).find((ref) => ref.rels.includes(wanted))?.uri;
}
