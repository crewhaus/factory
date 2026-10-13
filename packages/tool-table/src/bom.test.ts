/**
 * A file is read as 0.7.0 read it, a leading byte-order mark included
 * (bounds review). 0.7.1's first cut read it through tool-safety's reader,
 * whose text drops the mark: FixedWidthParse's columns moved by one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedWidthParse } from "./index";

const BOM = String.fromCharCode(0xfeff);
let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-table-bom-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

test("FixedWidthParse counts the mark as 0.7.0 did", async () => {
  writeFileSync(join(workspace, "t.txt"), `${BOM}AB12\nCD34\n`);
  const out = JSON.parse(
    String(
      await fixedWidthParse.execute(
        { file: "t.txt", fields: [{ name: "a", start: 1, length: 2 }] },
        {} as never,
      ),
    ),
  );
  expect(out.rows).toEqual([{ a: "A" }, { a: "CD" }]);
});
