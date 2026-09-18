export type Heading = {
  readonly depth: number;
  readonly title: string;
  readonly line: number;
  readonly slug: string;
};

/** GitHub-style heading anchor: lowercase, drop punctuation, spaces to dashes. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Collect ATX headings, ignoring any inside a fenced code block — a
 * `# comment` in a shell sample is not a section, and treating it as one
 * corrupts every section boundary after it.
 */
export function parseHeadings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  let fenceChar = "";
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence !== null) {
      const marker = (fence[1] as string)[0] as string;
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m === null) continue;
    const title = (m[2] as string).trim();
    out.push({ depth: (m[1] as string).length, title, line: i + 1, slug: slugify(title) });
  }
  return out;
}

/**
 * Return one section's body: the heading plus everything until the next
 * heading at the same or shallower depth. Matches on slug or exact title, so
 * a caller can address a section either way.
 */
export function sectionBody(markdown: string, wanted: string): string | undefined {
  const headings = parseHeadings(markdown);
  const target = slugify(wanted);
  const idx = headings.findIndex((h) => h.slug === target || h.title === wanted);
  if (idx === -1) return undefined;
  const start = headings[idx] as Heading;
  const next = headings.slice(idx + 1).find((h) => h.depth <= start.depth);
  const lines = markdown.split("\n");
  const end = next === undefined ? lines.length : next.line - 1;
  return lines
    .slice(start.line - 1, end)
    .join("\n")
    .trimEnd();
}

/** Render the heading tree as an indented outline with line numbers. */
export function renderOutline(headings: ReadonlyArray<Heading>, maxDepth: number): string {
  const kept = headings.filter((h) => h.depth <= maxDepth);
  if (kept.length === 0) return "(no headings)";
  const shallowest = Math.min(...kept.map((h) => h.depth));
  return kept.map((h) => `${"  ".repeat(h.depth - shallowest)}L${h.line}  ${h.title}`).join("\n");
}

/** Every fenced code block, with its language tag and start line. */
export function codeBlocks(
  markdown: string,
): Array<{ language: string; code: string; line: number }> {
  const out: Array<{ language: string; code: string; line: number }> = [];
  const lines = markdown.split("\n");
  let open: { language: string; startLine: number; fenceChar: string; body: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fence !== null) {
      const marker = (fence[1] as string)[0] as string;
      if (open === undefined) {
        open = { language: fence[2] ?? "", startLine: i + 1, fenceChar: marker, body: [] };
      } else if (marker === open.fenceChar) {
        out.push({ language: open.language, code: open.body.join("\n"), line: open.startLine });
        open = undefined;
      }
      continue;
    }
    if (open !== undefined) open.body.push(line);
  }
  return out;
}

/**
 * Render rows as a GitHub-flavoured markdown table, padded so the source is
 * readable. Column order comes from `columns`, or from the union of keys in
 * first-seen order when it is omitted.
 */
export function markdownTable(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  columns?: ReadonlyArray<string>,
): string {
  const cols =
    columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c.length > 0);
  if (cols.length === 0) return "";
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // A literal pipe would break the row into extra columns.
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  };
  const body = rows.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...body.map((r) => (r[i] as string).length), 3),
  );
  const pad = (s: string, w: number): string => s + " ".repeat(w - s.length);
  const lines = [
    `| ${cols.map((c, i) => pad(c, widths[i] as number)).join(" | ")} |`,
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...body.map((r) => `| ${r.map((v, i) => pad(v, widths[i] as number)).join(" | ")} |`),
  ];
  return lines.join("\n");
}
