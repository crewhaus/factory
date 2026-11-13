/**
 * The criteria history log: one line per criterion revision a sanctioned writer made
 * (`crewhaus criteria apply`, an adopted graders change), so a criterion's revisions can
 * be told apart from an edit made outside them. Lines are `{criterion, digest, at, cmd,
 * by?}`: an id, a digest, a time, the command and a stored actor, never a value.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppendResult, appendContained } from "@crewhaus/tool-safety/fs";

/** Where the criteria history log lives, under the harness directory. */
export const CRITERIA_HISTORY_REL = join(
  ".crewhaus",
  "run",
  "control",
  "quality",
  "criteria-history.jsonl",
);

/** The command a history line records for `crewhaus criteria apply`. */
export const CRITERIA_APPLY_CMD = "crewhaus criteria apply";

/** A history line: `{criterion, digest, at, cmd, by?}`. */
export type CriteriaHistoryLine = {
  readonly criterion: string;
  readonly digest: string;
  readonly at: string;
  readonly cmd: string;
  readonly by?: string;
};

/** The revision `criteria apply --expect` compares: sha256 of the file's raw text. */
export function gradersRevision(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Every well-formed history line, in file order; a torn line is left out. */
export function readCriteriaHistory(harnessDir: string): CriteriaHistoryLine[] {
  const path = join(harnessDir, CRITERIA_HISTORY_REL);
  if (!existsSync(path)) return [];
  const out: CriteriaHistoryLine[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as Partial<CriteriaHistoryLine>;
      if (typeof parsed.criterion === "string" && typeof parsed.digest === "string") {
        out.push(parsed as CriteriaHistoryLine);
      }
    } catch {
      // a torn line is left out
    }
  }
  return out;
}

/**
 * Append one line per changed criterion that still exists (`after` set). Contained in
 * the harness directory, and never through a link at the file. Nothing to append is a
 * success.
 */
export function appendCriteriaHistory(
  harnessDir: string,
  changed: ReadonlyArray<{ readonly criterion: string; readonly after?: string }>,
  line: { readonly at: string; readonly cmd: string; readonly by?: string },
): AppendResult | { readonly ok: true; readonly skipped: true } {
  const logged = changed.filter((c) => c.after !== undefined);
  if (logged.length === 0) return { ok: true, skipped: true };
  return appendContained(
    harnessDir,
    CRITERIA_HISTORY_REL,
    logged
      .map(
        (c) =>
          `${JSON.stringify({
            criterion: c.criterion,
            digest: c.after,
            at: line.at,
            cmd: line.cmd,
            ...(line.by !== undefined ? { by: line.by } : {}),
          })}\n`,
      )
      .join(""),
    { createParents: true },
  );
}
