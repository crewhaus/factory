/**
 * Auto-loaded project memory — M3.1 of the heavy-hitter plan.
 *
 * At session-start, the runtime looks for canonical "project memory"
 * files in the current working directory and prepends their contents
 * to the system prompt. Mirrors Claude Code's CLAUDE.md auto-load
 * convention.
 *
 * Files searched (in priority order, first match wins for each name):
 *   - CLAUDE.md         (Claude Code convention)
 *   - CODE-COMPANION.md (hello-code demo convention)
 *   - AGENT.md          (provider-neutral convention)
 *
 * Each file's contents are wrapped in:
 *   <project_memory file="CLAUDE.md">
 *   ...contents...
 *   </project_memory>
 *
 * Multiple files concatenate with blank-line separators.
 *
 * Pillar 3 — Security fabric: every file's contents are classified via
 * `boundary-classifier` with origin `"user"` (the developer owns their
 * repo). The user-origin default policy is `"pass"`, so classification
 * RUNS (and logs trace events) without blocking — which is the right
 * stance for a developer-trusted source. If a future deployment wants
 * strict policy on these files, pass `severity: "block"` via opts.
 *
 * Size cap: 64 KB total across all matched files. Larger files load
 * the first N bytes plus a `[...truncated]` notice — the prompt cache
 * is more valuable than the tail of a large memory file.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyBoundary } from "@crewhaus/boundary-classifier";

export const CANONICAL_MEMORY_FILES = ["CLAUDE.md", "CODE-COMPANION.md", "AGENT.md"] as const;

export const DEFAULT_PROJECT_MEMORY_CAP_BYTES = 64 * 1024;

export interface ProjectMemoryLoadOptions {
  /** Override cwd. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Override the filename list. Defaults to `CANONICAL_MEMORY_FILES`. */
  readonly filenames?: readonly string[];
  /** Maximum total bytes across all loaded files. Defaults to 64 KB. */
  readonly capBytes?: number;
}

export interface LoadedMemoryFile {
  readonly filename: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ProjectMemoryLoadResult {
  readonly files: readonly LoadedMemoryFile[];
  /** Total content bytes across all files (post-truncation). */
  readonly totalBytes: number;
  /** Wrapped + concatenated content ready to prepend to the system prompt. */
  readonly prompt: string;
}

/**
 * Scan cwd for project-memory files and return the rendered prompt block.
 * Returns `{ files: [], prompt: "" }` when no files matched — caller can
 * conditionally skip the prepend without a length check.
 */
export async function loadProjectMemory(
  opts: ProjectMemoryLoadOptions = {},
): Promise<ProjectMemoryLoadResult> {
  const cwd = opts.cwd ?? process.cwd();
  const filenames = opts.filenames ?? CANONICAL_MEMORY_FILES;
  const cap = opts.capBytes ?? DEFAULT_PROJECT_MEMORY_CAP_BYTES;

  const matched: { filename: string; fullPath: string; size: number }[] = [];
  for (const filename of filenames) {
    const fullPath = join(cwd, filename);
    if (!existsSync(fullPath)) continue;
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      matched.push({ filename, fullPath, size: st.size });
    } catch {}
  }

  if (matched.length === 0) {
    return { files: [], totalBytes: 0, prompt: "" };
  }

  const files: LoadedMemoryFile[] = [];
  let remaining = cap;
  for (const m of matched) {
    if (remaining <= 0) break;
    let content: string;
    try {
      content = await readFile(m.fullPath, "utf-8");
    } catch {
      continue;
    }
    let truncated = false;
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > remaining) {
      // Truncate at the byte cap, then append a notice.
      const buf = Buffer.from(content, "utf-8").subarray(0, remaining);
      content = `${buf.toString("utf-8")}\n\n[...truncated to ${remaining} bytes; ${
        contentBytes - remaining
      } bytes omitted]`;
      truncated = true;
    }
    // Pillar 3: classify with origin "user" — `pass` policy runs the
    // classifier and emits trace events without modifying content.
    await classifyBoundary(content, { origin: "user" }).catch(() => undefined);
    files.push({ filename: m.filename, content, truncated });
    remaining -= Buffer.byteLength(content, "utf8");
  }

  const sections = files
    .map((f) => `<project_memory file="${f.filename}">\n${f.content}\n</project_memory>`)
    .join("\n\n");

  return {
    files,
    totalBytes: files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0),
    prompt: sections,
  };
}
