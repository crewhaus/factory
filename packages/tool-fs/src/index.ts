import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { renderEditDiff } from "./diff";

/**
 * Built-in filesystem tools, sandboxed to the process's current working
 * directory. Every path argument is resolved relative to `process.cwd()` and
 * rejected if it escapes outside via `..`, absolute prefixes, or symlinks
 * whose real target lies outside the root.
 *
 * Layer R4 (built-in tools). Pairs with the `target-cli` codegen contract,
 * which imports each lowercase variable (`read`, `write`, ...) by name.
 */

export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;

  constructor(toolName: string, attemptedPath: string) {
    super(
      "tool",
      `tool "${toolName}" rejected path "${attemptedPath}": resolved location escapes the workspace root`,
    );
    this.toolName = toolName;
    this.path = attemptedPath;
  }
}

function resolveSafe(toolName: string, rel: string, root: string = process.cwd()): string {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  // 1) Lexical containment — fast path; rejects `..` and absolute escapes.
  //    The trailing `path.sep` avoids the `/root` vs `/root-sibling` pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  // 2) Symlink-aware containment (CWE-59). The lexical check above is fooled
  //    by an in-root symlink that points outside the workspace, so re-check
  //    the REAL path. The leaf may not exist yet (Write/Edit create it), so
  //    resolve the deepest existing ancestor and re-append the missing tail.
  //    Fails closed if realpath errors for any reason other than the walk.
  try {
    const rootReal = realpathSync(rootResolved);
    let probe = abs;
    const tail: string[] = [];
    while (!existsSync(probe)) {
      tail.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
    const real = tail.length > 0 ? path.join(realpathSync(probe), ...tail) : realpathSync(probe);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new ToolPermissionError(toolName, rel);
    }
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    throw new ToolPermissionError(toolName, rel);
  }
  return abs;
}

function rejectTraversalPattern(toolName: string, pattern: string): void {
  if (pattern.includes("..") || path.isAbsolute(pattern)) {
    throw new ToolPermissionError(toolName, pattern);
  }
}

const readSchema = z.object({ path: z.string() });
export const read: RegisteredTool = buildTool({
  name: "Read",
  description: "Read the contents of a file inside the workspace as UTF-8 text.",
  inputSchema: readSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const abs = resolveSafe("Read", input.path);
    return await Bun.file(abs).text();
  },
});

const writeSchema = z.object({ path: z.string(), content: z.string() });
export const write: RegisteredTool = buildTool({
  name: "Write",
  description:
    "Atomically write UTF-8 text to a file inside the workspace (replaces existing content).",
  inputSchema: writeSchema,
  destructive: true,
  execute: async (input) => {
    const abs = resolveSafe("Write", input.path);
    const tmp = `${abs}.tmp.${randomBytes(6).toString("hex")}`;
    try {
      await Bun.write(tmp, input.content);
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return `wrote ${input.content.length} bytes to ${input.path}`;
  },
});

const editSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
});
export const edit: RegisteredTool = buildTool({
  name: "Edit",
  description:
    "Replace the unique occurrence of oldString with newString in a workspace file. Errors when oldString matches zero or multiple times.",
  inputSchema: editSchema,
  destructive: true,
  execute: async (input) => {
    const abs = resolveSafe("Edit", input.path);
    const original = await Bun.file(abs).text();
    const occurrences = original.split(input.oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldString not found in "${input.path}"`);
    }
    if (occurrences > 1) {
      throw new Error(
        `oldString matches ${occurrences} times in "${input.path}" — provide more surrounding context to make it unique`,
      );
    }
    const next = original.replace(input.oldString, input.newString);
    const tmp = `${abs}.tmp.${randomBytes(6).toString("hex")}`;
    try {
      await Bun.write(tmp, next);
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    // M3.3 — return a unified-diff style hunk so the CLI (and the model
    // on subsequent turns) can see exactly what changed. The header
    // line "edited <path>" stays first for backward compatibility with
    // tests + tool-result parsers; the diff body follows.
    const diff = renderEditDiff({
      path: input.path,
      original,
      oldString: input.oldString,
      newString: input.newString,
    });
    return diff.length > 0 ? `edited ${input.path}\n${diff}` : `edited ${input.path}`;
  },
});

const globSchema = z.object({ pattern: z.string() });
export const glob: RegisteredTool = buildTool({
  name: "Glob",
  description:
    "List files inside the workspace matching a glob pattern (e.g. **/*.ts). Returns newline-joined relative paths.",
  inputSchema: globSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    rejectTraversalPattern("Glob", input.pattern);
    const cwd = process.cwd();
    const matcher = new Bun.Glob(input.pattern);
    const matches: string[] = [];
    for await (const rel of matcher.scan({ cwd, onlyFiles: true })) {
      matches.push(rel);
    }
    matches.sort();
    return matches.length === 0 ? "no matches" : matches.join("\n");
  },
});

const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});
export const grep: RegisteredTool = buildTool({
  name: "Grep",
  description:
    "Search for a regex pattern across files in the workspace (or a subdirectory). Returns lines as path:lineNo:match.",
  inputSchema: grepSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = process.cwd();
    let baseAbs = root;
    let baseRel = "";
    if (input.path !== undefined && input.path !== "") {
      baseAbs = resolveSafe("Grep", input.path, root);
      baseRel = path.relative(root, baseAbs);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid regex pattern: ${msg}`);
    }

    const matcher = new Bun.Glob("**/*");
    const hits: string[] = [];
    for await (const rel of matcher.scan({ cwd: baseAbs, onlyFiles: true })) {
      const fileAbs = path.join(baseAbs, rel);
      const display = baseRel === "" ? rel : path.join(baseRel, rel);
      let text: string;
      try {
        text = await Bun.file(fileAbs).text();
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          hits.push(`${display}:${i + 1}:${line}`);
        }
      }
    }
    return hits.length === 0 ? "no matches" : hits.join("\n");
  },
});

export const allFsTools: ReadonlyArray<RegisteredTool> = [read, write, edit, glob, grep];
