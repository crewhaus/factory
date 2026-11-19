/**
 * Auto-loaded project memory — M3.1 of the heavy-hitter plan.
 *
 * At session-start, the runtime looks for canonical "project memory"
 * files in the current working directory and prepends their contents
 * to the system prompt. Follows the vendor-neutral agents.md convention
 * (https://agents.md) and is compatible with Claude Code's CLAUDE.md
 * auto-load behaviour.
 *
 * Files searched (in priority order, all matches are loaded):
 *   - AGENTS.md         (vendor-neutral convention — agents.md)
 *   - CLAUDE.md         (Claude Code convention)
 *   - CODE-COMPANION.md (hello-code demo convention)
 *   - AGENT.md          (legacy singular form; retained for compatibility)
 *
 * Each file's contents are wrapped in:
 *   <project_memory file="AGENTS.md">
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
 * The files the runtime writes from earlier work and re-reads here — a
 * marker-carrying `LESSONS.md` (`MARKER_GATED_FILES`) and the per-user
 * preference files (`extraFiles`) — are mined from ratings, feedback and
 * session logs, so they are screened as remembered memory instead: each line,
 * each two adjacent lines and the file as a whole are classified at
 * TrustOrigin `"memory"`, and what the classifier redacts is replaced by its
 * notice ({@link screenRememberedLines}).
 *
 * Size cap: 64 KB total across all matched files. Larger files load
 * the first N bytes plus a `[...truncated]` notice — the prompt cache
 * is more valuable than the tail of a large memory file.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyBoundary } from "@crewhaus/boundary-classifier";

/** Text screened as remembered memory, line by line and as a whole. */
export type ScreenedLines = {
  /**
   * The text, each line the classifier redacts replaced by its notice; the
   * notice alone when the text redacts as a whole after that.
   */
  readonly text: string;
  /** How many lines were replaced or withheld. */
  readonly redacted: number;
  /** How many lines were kept with a suspicious verdict. */
  readonly warned: number;
  /** The detector rules behind the replaced and flagged lines, first seen first. */
  readonly rules: readonly string[];
};

/**
 * Screen text the runtime re-reads from earlier work as remembered memory,
 * at TrustOrigin `"memory"`, in three passes:
 *
 * 1. Each line: a line the classifier redacts becomes its redaction notice.
 * 2. Each two adjacent non-blank lines still kept, read together: when the
 *    pair redacts, both lines become the pair's notice.
 * 3. The kept lines as a whole: when they still redact, the whole text is
 *    withheld and becomes that notice, every non-blank line counted.
 *
 * Every other line is kept as it is, with its line break. A classifier
 * rejection rejects.
 */
export async function screenRememberedLines(text: string): Promise<ScreenedLines> {
  const classify = (t: string) => classifyBoundary(t, { origin: "memory" });
  const lines = text.split("\n");
  const withheld = lines.map(() => false);
  const rules = new Set<string>();
  const note = (hits: ReadonlyArray<{ readonly rule: string }>): void => {
    for (const hit of hits) rules.add(hit.rule);
  };
  let redacted = 0;
  let warned = 0;
  const withhold = (i: number, notice: string): void => {
    lines[i] = notice;
    withheld[i] = true;
    redacted += 1;
  };
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const boundary = await classify(line);
    if (boundary.action === "pass") continue;
    note(boundary.verdict.hits);
    if (boundary.action === "redact") withhold(i, boundary.redacted ?? "");
    else warned += 1;
  }
  /** The kept non-blank lines, in order, and their text joined as one. */
  const kept = (): { readonly at: number[]; readonly text: string } => {
    const at = lines.flatMap((line, i) => (!withheld[i] && line.trim() !== "" ? [i] : []));
    return { at, text: at.map((i) => lines[i]).join("\n") };
  };
  const before = kept();
  if (before.at.length < 2) return { text: lines.join("\n"), redacted, warned, rules: [...rules] };
  // Each two adjacent kept lines, read from the text as it stood after the
  // line pass, so a pair is judged by its own two lines.
  const original = before.at.map((i) => lines[i] ?? "");
  for (let k = 0; k + 1 < before.at.length; k += 1) {
    const boundary = await classify(`${original[k]}\n${original[k + 1]}`);
    if (boundary.action !== "redact") continue;
    note(boundary.verdict.hits);
    for (const i of [before.at[k], before.at[k + 1]] as number[]) {
      if (!withheld[i]) withhold(i, boundary.redacted ?? "");
    }
  }
  const after = kept();
  if (after.at.length > 0) {
    const whole = await classify(after.text);
    if (whole.action === "redact") {
      note(whole.verdict.hits);
      const nonBlank = lines.filter((line) => line.trim() !== "").length;
      return {
        text: whole.redacted ?? "",
        redacted: nonBlank,
        warned,
        rules: [...rules],
      };
    }
  }
  return { text: lines.join("\n"), redacted, warned, rules: [...rules] };
}

export const CANONICAL_MEMORY_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CODE-COMPANION.md",
  "AGENT.md",
  // Item #56 — auto-maintained lessons file. `crewhaus lessons update` mines
  // corrections + recurring failure→fix patterns into this deduped file; the
  // runtime auto-loads it at run start exactly like the other memory files.
  //
  // #56 F2 — GATED: unlike the other canonical files, a project's `LESSONS.md`
  // is a common human-authored convention, so we ONLY auto-inject one that
  // carries the crewhaus marker (`MARKER_GATED_FILES` below). A marker-less
  // human LESSONS.md is skipped — we never silently prepend an unrelated file
  // to the agent's system prompt.
  "LESSONS.md",
] as const;

/**
 * #56 F2 — canonical files whose auto-load is gated on a crewhaus-generated
 * marker. These filenames collide with common human-authored conventions, so
 * only the crewhaus-managed variant (which carries the marker `crewhaus`
 * writes) is auto-injected. Maps filename → the exact marker substring that
 * must be present. `LESSONS.md`'s marker mirrors `apps/cli/src/lessons.ts`'s
 * `LESSONS_MARKER` — the same string `crewhaus lessons update` writes.
 */
export const MARKER_GATED_FILES: Readonly<Record<string, string>> = {
  "LESSONS.md": "<!-- crewhaus:lessons -->",
};

export const DEFAULT_PROJECT_MEMORY_CAP_BYTES = 64 * 1024;

export interface ProjectMemoryLoadOptions {
  /** Override cwd. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Override the filename list. Defaults to `CANONICAL_MEMORY_FILES`. */
  readonly filenames?: readonly string[];
  /** Maximum total bytes across all loaded files. Defaults to 64 KB. */
  readonly capBytes?: number;
  /**
   * Item #56 — absolute path(s) to per-user preference files (outside cwd, e.g.
   * `.crewhaus/preferences/<rater>.md`). Loaded + injected exactly like the
   * canonical files when they exist, so the current user's prefs reach the
   * system prompt. Absent/nonexistent → no-op.
   */
  readonly extraFiles?: readonly string[];
}

export interface LoadedMemoryFile {
  readonly filename: string;
  readonly content: string;
  readonly truncated: boolean;
  /** Set on a file loaded from `extraFiles`, outside the working directory. */
  readonly outside?: true;
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

  const matched: { filename: string; fullPath: string; size: number; outside?: true }[] = [];
  for (const filename of filenames) {
    const fullPath = join(cwd, filename);
    if (!existsSync(fullPath)) continue;
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      matched.push({ filename, fullPath, size: st.size });
    } catch {}
  }
  // Item #56 — extra per-user preference files (absolute paths outside cwd).
  for (const fullPath of opts.extraFiles ?? []) {
    if (!existsSync(fullPath)) continue;
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      // Use the basename as the `file=` label in the wrapper.
      const filename = fullPath.split(/[/\\]/).pop() ?? fullPath;
      matched.push({ filename, fullPath, size: st.size, outside: true });
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
    // #56 F2 — marker-gated files (e.g. LESSONS.md) only auto-inject when they
    // carry the crewhaus marker; a human-authored file of the same name (no
    // marker) is skipped so we never silently prepend it to the system prompt.
    const requiredMarker = MARKER_GATED_FILES[m.filename];
    if (requiredMarker !== undefined && !content.includes(requiredMarker)) {
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
    if (requiredMarker !== undefined || m.outside === true) {
      // Written by the runtime from earlier work (lessons, preferences):
      // screened as remembered memory, by line, by adjacent pair and whole,
      // before the model reads it. A classifier rejection leaves the file out
      // of the prompt.
      try {
        content = (await screenRememberedLines(content)).text;
      } catch {
        continue;
      }
    } else {
      // Pillar 3: classify with origin "user" — `pass` policy runs the
      // classifier and emits trace events without modifying content.
      await classifyBoundary(content, { origin: "user" }).catch(() => undefined);
    }
    files.push({
      filename: m.filename,
      content,
      truncated,
      ...(m.outside === true ? { outside: true as const } : {}),
    });
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
