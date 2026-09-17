/**
 * A line diff over two documents' extracted text.
 *
 * A classic longest-common-subsequence table over lines, back-tracked into
 * add/remove/equal operations. It is O(n*m) in time and memory, which is fine
 * for documents and wrong for logs, so the caller bounds the table's cell
 * count before calling. (It is NOT Myers' algorithm, which trades this table
 * for O(n+m) space; naming it after Myers would claim a bound this does not
 * have.)
 *
 * The comparison happens on NORMALISED lines (optionally case-folded and
 * whitespace-collapsed) while the OUTPUT shows the original text, so a
 * reformatted paragraph does not read as a rewrite.
 */

export type DiffOp = {
  readonly kind: "equal" | "add" | "remove";
  readonly text: string;
};

export type DiffStats = {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
};

export function normalizeLine(
  line: string,
  ignoreWhitespace: boolean,
  ignoreCase: boolean,
): string {
  let out = line;
  if (ignoreWhitespace) out = out.replace(/\s+/g, " ").trim();
  if (ignoreCase) out = out.toLowerCase();
  return out;
}

/** The diff itself, over already-normalised keys but carrying original text. */
export function diffLines(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  keyA: ReadonlyArray<string>,
  keyB: ReadonlyArray<string>,
): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  // lengths[i * stride + j] = the longest common subsequence of a[i:] and b[j:].
  // A flat Uint32Array rather than an array of arrays: the table is the whole
  // memory cost of this function, and four bytes a cell instead of eight (plus
  // one object header per row) is what keeps the caller's cell cap honest.
  const lengths = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * stride;
    const nextRow = row + stride;
    for (let j = m - 1; j >= 0; j--) {
      lengths[row + j] =
        keyA[i] === keyB[j]
          ? (lengths[nextRow + j + 1] as number) + 1
          : Math.max(lengths[nextRow + j] as number, lengths[row + j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (keyA[i] === keyB[j]) {
      ops.push({ kind: "equal", text: a[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    const down = lengths[(i + 1) * stride + j] as number;
    const right = lengths[i * stride + j + 1] as number;
    if (down >= right) {
      ops.push({ kind: "remove", text: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "remove", text: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j] as string });
    j += 1;
  }
  return ops;
}

export function diffStats(ops: ReadonlyArray<DiffOp>): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.kind === "add") added += 1;
    else if (op.kind === "remove") removed += 1;
    else unchanged += 1;
  }
  return { added, removed, unchanged };
}

/** A unified diff with `context` unchanged lines around each change. */
export function renderUnified(
  ops: ReadonlyArray<DiffOp>,
  labelA: string,
  labelB: string,
  context: number,
): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (const [i, op] of ops.entries()) {
    if (op.kind === "equal") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }
  const lines: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let skipping = false;
  for (const [i, op] of ops.entries()) {
    if (keep[i] !== true) {
      if (!skipping) lines.push("@@ ...");
      skipping = true;
      continue;
    }
    skipping = false;
    const marker = op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " ";
    lines.push(`${marker}${op.text}`);
  }
  return lines.join("\n");
}

/**
 * Word-level counts for a summary line. Words are runs of non-whitespace,
 * compared case-sensitively; this is a magnitude, not a linguistic measure.
 */
export function wordCounts(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}
