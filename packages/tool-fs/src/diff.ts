/**
 * Inline diff renderer for the `Edit` tool — M3.3 of the heavy-hitter
 * plan. The CLI used to see "edited foo.ts" with no detail; now it sees
 * a unified-diff style hunk so the user (and the model on subsequent
 * turns) can see exactly what changed.
 *
 * Why a custom renderer instead of pulling in `diff` from npm: this is
 * the only consumer in factory today, and the Edit tool's diff shape
 * is structurally simpler than a general LCS diff — we already know
 * the exact oldString and newString. We compute the line range from
 * those known anchors instead of running a Myers diff over the full
 * file. The output mirrors `git diff --no-prefix` for familiarity.
 *
 * Output (truncated when very long — see DIFF_MAX_LINES):
 *
 *   --- a/path/to/file.ts
 *   +++ b/path/to/file.ts
 *   @@ -10,5 +10,7 @@
 *    function foo() {
 *      const x = 1;
 *   -  return x;
 *   +  const y = 2;
 *   +  return x + y;
 *    }
 *
 * Configurable via env:
 *   CREWHAUS_EDIT_DIFF_CONTEXT=N  (default 3 lines of context)
 *   CREWHAUS_EDIT_DIFF_MAX=N      (default 80 total diff lines before truncation)
 */

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_LINES = 80;

export interface EditDiffOptions {
  /** Lines of context above and below the change. Default 3. */
  readonly contextLines?: number;
  /** Total max lines in the rendered diff before truncation. Default 80. */
  readonly maxLines?: number;
}

/**
 * Render a unified diff for an `Edit` tool invocation. Returns the
 * diff as a single string (with embedded newlines, no trailing newline).
 */
export function renderEditDiff(
  args: {
    readonly path: string;
    readonly original: string;
    readonly oldString: string;
    readonly newString: string;
  },
  opts: EditDiffOptions = {},
): string {
  const ctx = opts.contextLines ?? envInt("CREWHAUS_EDIT_DIFF_CONTEXT", DEFAULT_CONTEXT_LINES);
  const maxLines = opts.maxLines ?? envInt("CREWHAUS_EDIT_DIFF_MAX", DEFAULT_MAX_LINES);

  const idx = args.original.indexOf(args.oldString);
  if (idx === -1) {
    // Caller invariant violation — Edit shouldn't have succeeded if
    // oldString wasn't found. Return an empty diff to be defensive.
    return "";
  }

  const allLines = args.original.split("\n");
  // 0-indexed line number where the change begins.
  const startLine = countLines(args.original.slice(0, idx));
  // oldString may contain trailing newline characters — preserve them
  // in the diff but don't double-count.
  const oldLines = args.oldString.split("\n");
  const newLines = args.newString.split("\n");

  // If oldString starts mid-line, normalize: render the entire affected
  // line range. The Edit tool's match-occurrence semantics mean this
  // is rare but possible.
  const oldLineSpan = oldLines.length;
  const afterChange = startLine + oldLineSpan;

  const contextBefore = allLines.slice(Math.max(0, startLine - ctx), startLine);
  const contextAfter = allLines.slice(afterChange, Math.min(allLines.length, afterChange + ctx));

  const oldRangeLen = oldLineSpan + contextBefore.length + contextAfter.length;
  const newRangeLen = newLines.length + contextBefore.length + contextAfter.length;

  const lines: string[] = [];
  lines.push(`--- a/${args.path}`);
  lines.push(`+++ b/${args.path}`);
  lines.push(
    `@@ -${Math.max(1, startLine - ctx + 1)},${oldRangeLen} +${Math.max(
      1,
      startLine - ctx + 1,
    )},${newRangeLen} @@`,
  );
  for (const l of contextBefore) lines.push(` ${l}`);
  for (const l of oldLines) lines.push(`-${l}`);
  for (const l of newLines) lines.push(`+${l}`);
  for (const l of contextAfter) lines.push(` ${l}`);

  // Truncation: if the diff is huge, keep header + first N lines + truncation notice.
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept.push(`@@ truncated: ${lines.length - maxLines} more lines @@`);
    return kept.join("\n");
  }

  return lines.join("\n");
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 0;
  for (const ch of s) {
    if (ch === "\n") count++;
  }
  return count;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
