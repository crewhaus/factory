export type DiffOp = { readonly kind: "eq" | "del" | "ins"; readonly line: string };

/**
 * Line-level diff via the classic longest-common-subsequence dynamic
 * program. O(n*m) in time and memory, which is why the tool caps its input:
 * diffing two 50k-line files would allocate a 2.5-billion-cell table.
 * Callers with bigger inputs should diff a narrowed region instead.
 */
export function diffLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i] as string });
      i++;
      j++;
      continue;
    }
    const down = (lcs[i + 1] as number[])[j] as number;
    const right = (lcs[i] as number[])[j + 1] as number;
    if (down >= right) {
      ops.push({ kind: "del", line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "ins", line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++] as string });
  while (j < m) ops.push({ kind: "ins", line: b[j++] as string });
  return ops;
}

export type DiffStats = { readonly added: number; readonly removed: number; readonly same: number };

/** Count each op kind — the "+12 -3" summary a reviewer actually reads. */
export function diffStats(ops: ReadonlyArray<DiffOp>): DiffStats {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const op of ops) {
    if (op.kind === "ins") added++;
    else if (op.kind === "del") removed++;
    else same++;
  }
  return { added, removed, same };
}

/**
 * Render ops as a unified diff keeping `context` unchanged lines around each
 * change. Long runs of unchanged lines collapse, which is the entire point:
 * the reader sees the change, not the file.
 */
export function renderUnified(
  ops: ReadonlyArray<DiffOp>,
  aLabel: string,
  bLabel: string,
  context: number,
): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]?.kind === "eq") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
      keep[j] = true;
    }
  }
  const out: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];
  let aLine = 1;
  let bLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      const op = ops[i] as DiffOp;
      if (op.kind !== "ins") aLine++;
      if (op.kind !== "del") bLine++;
      i++;
      continue;
    }
    const hunkStartA = aLine;
    const hunkStartB = bLine;
    const body: string[] = [];
    let aCount = 0;
    let bCount = 0;
    while (i < ops.length && keep[i]) {
      const op = ops[i] as DiffOp;
      if (op.kind === "eq") {
        body.push(` ${op.line}`);
        aLine++;
        bLine++;
        aCount++;
        bCount++;
      } else if (op.kind === "del") {
        body.push(`-${op.line}`);
        aLine++;
        aCount++;
      } else {
        body.push(`+${op.line}`);
        bLine++;
        bCount++;
      }
      i++;
    }
    out.push(`@@ -${hunkStartA},${aCount} +${hunkStartB},${bCount} @@`);
    out.push(...body);
  }
  return out.join("\n");
}
