/**
 * A secret file and a .env are read as 0.7.0 read them, a leading
 * byte-order mark included (bounds review). 0.7.1's first cut read them
 * through tool-safety's reader, whose text drops the mark: SecretLookup
 * reported another fingerprint and length for a file: secret, and
 * EnvFileUpsert rewrote a .env without the mark it started with, a byte the
 * edit never touched.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileUpsert, secretLookup } from "./index";

const BOM = String.fromCharCode(0xfeff);
let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-secrets-bom-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

test("a file: secret's fingerprint and length are those of the file's text, mark included", async () => {
  const value = `${BOM}abc123`;
  writeFileSync(join(workspace, "token"), value);
  const out = JSON.parse(String(await secretLookup.execute({ refs: ["file:token"] }, {} as never)));
  const [result] = out.results;
  expect(result.status).toBe("resolved");
  expect(result.length).toBe(7);
  // The values 0.7.0 reported for this file; the first cut said
  // sha256:4bdb35ae60bd and 6.
  expect(result.fingerprint).toBe("sha256:c0b0cefe8044");
});

test("EnvFileUpsert keeps the byte-order mark a .env starts with", async () => {
  writeFileSync(join(workspace, ".env"), `${BOM}FOO=1\nBAR=2\n`);
  const out = JSON.parse(
    String(
      await envFileUpsert.execute(
        { path: ".env", entries: [{ key: "BAZ", value: "3" }] },
        {} as never,
      ),
    ),
  );
  expect(out.applied).toBe(true);
  expect(readFileSync(join(workspace, ".env"), "utf8")).toBe(`${BOM}FOO=1\nBAR=2\nBAZ=3\n`);
});
