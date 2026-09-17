/**
 * Jupyter `.ipynb` handling, as pure functions over an already-parsed
 * document. The file format is JSON, so the only real work is the parts of
 * nbformat that are easy to get wrong: `source` and the text of an output
 * are stored as an ARRAY of lines, each line keeping its trailing newline,
 * and round-tripping a notebook means writing that shape back rather than a
 * single string (which Jupyter accepts but every diff of the file hates).
 */

export class NotebookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookError";
  }
}

export type NotebookCell = {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  [key: string]: unknown;
};

export type Notebook = {
  cells: NotebookCell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Parse and shape-check a notebook. Throws `NotebookError` on anything else. */
export function parseNotebook(text: string): Notebook {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new NotebookError(`not valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NotebookError("the top level of a notebook must be a JSON object");
  }
  const cells = (value as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) {
    throw new NotebookError('the notebook has no "cells" array — is this really an .ipynb?');
  }
  for (const [index, cell] of cells.entries()) {
    if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
      throw new NotebookError(`cell ${index} is not an object`);
    }
    const source = (cell as { source?: unknown }).source;
    if (typeof source !== "string" && !Array.isArray(source)) {
      throw new NotebookError(`cell ${index} has no string or string[] "source"`);
    }
  }
  return value as Notebook;
}

/** A cell's source as one string, whichever of the two shapes it used. */
export function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source;
}

/**
 * Split text into the line array nbformat stores: every line keeps its
 * newline, and the last line has one only if the text ended with one. An
 * empty string becomes an empty array, which is what Jupyter writes.
 */
export function toSourceLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const part = parts[i] as string;
    if (isLast && part === "") break;
    lines.push(isLast ? part : `${part}\n`);
  }
  return lines;
}

/** One rendered output of a code cell, flattened to text a reader can scan. */
export type OutputSummary = {
  readonly type: string;
  readonly text: string;
};

function joinMaybeLines(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("");
  return "";
}

/**
 * Flatten a code cell's outputs. Images and other binary mime bundles are
 * reported by mime type and byte length rather than inlined — a base64 PNG
 * in a tool result is a context-window fire with no upside.
 */
export function summarizeOutputs(outputs: unknown[], maxChars: number): OutputSummary[] {
  const summaries: OutputSummary[] = [];
  for (const raw of outputs) {
    if (typeof raw !== "object" || raw === null) continue;
    const output = raw as Record<string, unknown>;
    const type =
      typeof output["output_type"] === "string" ? (output["output_type"] as string) : "unknown";
    if (type === "stream") {
      summaries.push({
        type: `stream:${String(output["name"] ?? "stdout")}`,
        text: clamp(joinMaybeLines(output["text"]), maxChars),
      });
      continue;
    }
    if (type === "error") {
      const name = String(output["ename"] ?? "Error");
      const value = String(output["evalue"] ?? "");
      summaries.push({ type: "error", text: clamp(`${name}: ${value}`, maxChars) });
      continue;
    }
    const data = output["data"];
    if (typeof data === "object" && data !== null) {
      const bundle = data as Record<string, unknown>;
      // Prefer plain text; report anything else by mime type and size only.
      const plain = bundle["text/plain"];
      if (plain !== undefined) {
        summaries.push({ type, text: clamp(joinMaybeLines(plain), maxChars) });
        continue;
      }
      const mimes = Object.keys(bundle).sort();
      const described = mimes
        .map((mime) => `${mime} (${joinMaybeLines(bundle[mime]).length} chars)`)
        .join(", ");
      summaries.push({ type, text: `[non-text output: ${described}]` });
      continue;
    }
    summaries.push({ type, text: "" });
  }
  return summaries;
}

function clamp(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}…[+${text.length - maxChars} chars]`;
}

export type NotebookEditOp =
  | { readonly mode: "replace"; readonly index: number; readonly source: string }
  | {
      readonly mode: "insert";
      readonly index: number;
      readonly cellType: "code" | "markdown" | "raw";
      readonly source: string;
    }
  | { readonly mode: "delete"; readonly index: number };

/**
 * Apply one edit, returning a NEW notebook object. Replacing a code cell's
 * source clears its `outputs` and `execution_count`: keeping the old output
 * next to new code would be a lie the next reader believes.
 */
export function applyNotebookEdit(notebook: Notebook, op: NotebookEditOp): Notebook {
  const cells = [...notebook.cells];
  const upperBound = op.mode === "insert" ? cells.length : cells.length - 1;
  if (!Number.isInteger(op.index) || op.index < 0 || op.index > upperBound) {
    throw new NotebookError(
      `cell index ${op.index} is out of range — the notebook has ${cells.length} cell(s), so valid indexes are 0..${Math.max(upperBound, 0)}`,
    );
  }
  if (op.mode === "delete") {
    cells.splice(op.index, 1);
  } else if (op.mode === "insert") {
    const cell: NotebookCell = {
      cell_type: op.cellType,
      metadata: {},
      source: toSourceLines(op.source),
      ...(op.cellType === "code" ? { execution_count: null, outputs: [] } : {}),
    };
    cells.splice(op.index, 0, cell);
  } else {
    const existing = cells[op.index] as NotebookCell;
    const updated: NotebookCell = { ...existing, source: toSourceLines(op.source) };
    if (existing.cell_type === "code") {
      updated["outputs"] = [];
      updated["execution_count"] = null;
    }
    cells[op.index] = updated;
  }
  return { ...notebook, cells };
}

/**
 * Serialize a notebook the way Jupyter does: one-space indentation and a
 * trailing newline. Matching that exactly is what keeps an edit's git diff
 * to the cell that actually changed.
 */
export function serializeNotebook(notebook: Notebook): string {
  return `${JSON.stringify(notebook, null, 1)}\n`;
}
