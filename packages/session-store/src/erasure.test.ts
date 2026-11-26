import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureGrant } from "@crewhaus/control-contract/knowledge";
import { purgeSummaries, summariesOf } from "./erasure";
import { SESSIONS_INDEX_DIRNAME, summarizeSessionIntoIndex } from "./index";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "session-erasure-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const A = "sess_00000000000000aa";
const B = "sess_00000000000000bb";
const MARKER = ["PLANTED", "person", "4411"].join("-");
const index = (...parts: string[]): string => join(dir, SESSIONS_INDEX_DIRNAME, ...parts);
const grantFor = (
  targets: readonly string[],
  over: Partial<ErasureGrant["scopes"][number]> = {},
): ErasureGrant => ({
  nonce: "n",
  digest: "d",
  scopes: [{ store: "summaries", root: dir, targets, ...over }],
});

function summarize(id: string): void {
  const log = join(dir, `${id}.jsonl`);
  writeFileSync(
    log,
    `${JSON.stringify({ kind: "user_message", payload: { content: "hi" } })}\n${JSON.stringify({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: `${MARKER} ${id}` }] },
    })}\n`,
  );
  summarizeSessionIntoIndex(id, log, index());
}

describe("purgeSummaries", () => {
  test("removes the named summaries and leaves the rest, and the session logs", async () => {
    summarize(A);
    summarize(B);
    expect(summariesOf(dir, [A, B, "sess_00000000000000cc", "../x"])).toEqual([A, B]);
    expect(await purgeSummaries(dir, [A], grantFor([A]))).toBe(1);
    expect(readdirSync(index())).toEqual([`${B}.json`]);
    expect(existsSync(join(dir, `${A}.jsonl`))).toBe(true);
    // Again: nothing there.
    expect(await purgeSummaries(dir, [A], grantFor([A]))).toBe(0);
    expect(summariesOf(dir, [A])).toEqual([]);
  });

  test("refuses another root or store, a session the grant does not name, and what is not a session", async () => {
    summarize(A);
    const other = realpathSync(mkdtempSync(join(tmpdir(), "session-erasure-other-")));
    try {
      for (const grant of [
        grantFor([A], { root: other }),
        grantFor([A], { store: "trash" }),
        grantFor([A], { spec: "bot" }),
      ]) {
        await expect(purgeSummaries(dir, [A], grant)).rejects.toThrow("does not cover");
      }
      await expect(purgeSummaries(dir, [A, B], grantFor([A]))).rejects.toThrow("does not name");
      await expect(purgeSummaries(dir, ["../x"], grantFor(["../x"]))).rejects.toThrow(
        "does not name",
      );
      expect(readdirSync(index())).toEqual([`${A}.json`]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("an index directory that leads out is refused; a link at a summary is removed, never what it names", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "session-erasure-outside-")));
    try {
      writeFileSync(join(outside, `${A}.json`), MARKER);
      symlinkSync(outside, index());
      await expect(purgeSummaries(dir, [A], grantFor([A]))).rejects.toThrow("refusing to erase");
      expect(readFileSync(join(outside, `${A}.json`), "utf8")).toBe(MARKER);
      rmSync(index());
      mkdirSync(index());
      symlinkSync(join(outside, `${A}.json`), index(`${A}.json`));
      expect(await purgeSummaries(dir, [A], grantFor([A]))).toBe(1);
      expect(readFileSync(join(outside, `${A}.json`), "utf8")).toBe(MARKER);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
