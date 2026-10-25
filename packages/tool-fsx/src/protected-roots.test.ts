/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2) — the
 * writers that act beneath a directory they name refuse to reach the run's
 * own record: the session logs, spilled tool results and proof bundles the
 * runtime hands them on the bridge (`RuntimeBridge.protectedRoots`).
 *
 * permission-engine's floor denies a call that NAMES a path inside one;
 * these are the calls it cannot see: a tree copied or moved onto
 * `.crewhaus`, an archive whose top-level `.crewhaus` lands in the workspace
 * root, the directory holding the logs removed. A write that does not reach
 * one is untouched — `CopyPath notes.md .` writes `./notes.md`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { buildTar } from "./archive-fixtures";
import { archiveExtract, copyPath, movePath, removePath } from "./index";

const originalCwd = process.cwd();
let tmp: string;
let ctx: ToolExecuteContext;
const LOG = path.join(".crewhaus", "sessions", "sess_00000000000000aa.jsonl");
const ORIGINAL = '{"kind":"tool_result","payload":{"content":"Refunds: 14 days"}}\n';

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-protected-"));
  process.chdir(tmp);
  mkdirSync(path.join(tmp, ".crewhaus", "sessions"), { recursive: true });
  writeFileSync(path.join(tmp, LOG), ORIGINAL);
  // As runtime-core spells them: absolute, and workspace-relative.
  const roots = [".crewhaus/sessions", ".crewhaus/tool-results", ".crewhaus/proofs"];
  ctx = { bridge: { protectedRoots: [...roots.map((r) => path.join(tmp, r)), ...roots] } };
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

async function text(tool: RegisteredTool, input: unknown, with_ = ctx): Promise<string> {
  const out = await tool.execute(input, with_);
  return typeof out === "string" ? out : JSON.stringify(out);
}

const REFUSED = "would write where the runtime keeps its own record of the run";
const forged = '{"kind":"tool_result","payload":{"content":"Refunds: 90 days"}}\n';

describe("the runtime-state roots, beneath a directory a writer names", () => {
  test("CopyPath: a tree whose path reaches the session logs is refused; a plain copy is not", async () => {
    write("staged/sessions/sess_00000000000000aa.jsonl", forged);
    const out = await text(copyPath, {
      source: "staged",
      destination: ".crewhaus",
      overwrite: true,
    });
    expect(out).toContain(REFUSED);
    expect(readFileSync(path.join(tmp, LOG), "utf8")).toBe(ORIGINAL);
    // The same tree's sibling content copied onto `.crewhaus` elsewhere is fine.
    write("other/notes/today.md", "hello");
    expect(await text(copyPath, { source: "other", destination: ".crewhaus" })).toContain(
      '"copied":true',
    );
    // A file copied into the workspace root writes `./notes.md` only.
    write("docs/notes.md", "hello");
    expect(await text(copyPath, { source: "docs/notes.md", destination: "notes.md" })).toContain(
      '"copied":true',
    );
    // A tree mirroring the workspace root, copied onto it, is refused.
    write("mirror/.crewhaus/sessions/sess_00000000000000aa.jsonl", forged);
    expect(await text(copyPath, { source: "mirror", destination: ".", overwrite: true })).toContain(
      REFUSED,
    );
    expect(readFileSync(path.join(tmp, LOG), "utf8")).toBe(ORIGINAL);
  });

  test("MovePath and RemovePath: a directory holding the session logs is never moved or removed", async () => {
    expect(await text(movePath, { source: ".crewhaus", destination: "old-state" })).toContain(
      REFUSED,
    );
    write("staged/sessions/sess_00000000000000aa.jsonl", forged);
    expect(
      await text(movePath, { source: "staged", destination: ".crewhaus", overwrite: true }),
    ).toContain(REFUSED);
    expect(await text(removePath, { path: ".crewhaus", recursive: true })).toContain(REFUSED);
    expect(readFileSync(path.join(tmp, LOG), "utf8")).toBe(ORIGINAL);
    // Anywhere else, as before.
    write("tmp/x.txt", "x");
    expect(await text(removePath, { path: "tmp", recursive: true })).toContain('"removed":true');
    // A run that declares no roots (a bridge built elsewhere) relies on the floor.
    write("staged2/y.txt", "y");
    expect(await text(movePath, { source: "staged2", destination: "moved2" }, {})).toContain(
      '"moved":true',
    );
  });

  test("ArchiveExtract: a top-level .crewhaus extracted into the workspace root is refused", async () => {
    writeFileSync(
      path.join(tmp, "evil.tar"),
      buildTar([
        { name: ".crewhaus/sessions/sess_00000000000000aa.jsonl", data: forged },
        { name: "README.md", data: "hi" },
      ]),
    );
    const out = await text(archiveExtract, {
      archive: "evil.tar",
      destination: ".",
      overwrite: true,
    });
    expect(out).toContain(REFUSED);
    expect(out).toContain(".crewhaus");
    expect(readFileSync(path.join(tmp, LOG), "utf8")).toBe(ORIGINAL);
    expect(existsSync(path.join(tmp, "README.md"))).toBe(false);
    // The same archive into a directory of its own is extracted.
    const fine = await text(archiveExtract, { archive: "evil.tar", destination: "unpacked" });
    expect(fine).toContain('"extracted":true');
  });
});
