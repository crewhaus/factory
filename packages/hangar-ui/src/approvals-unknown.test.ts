/**
 * A harness whose approvals cannot be read: its fleet row keeps `null` and says
 * "Approvals unknown" in words, and Home's Needs-you panel names it, so it never reads
 * as complete.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  APPROVALS_UNKNOWN,
  normalizeRows,
  unreachableNames,
  unreachableNote,
} from "../assets/js/util.js";

const VIEWS = join(import.meta.dir, "..", "assets", "js", "views");

describe("a fleet row whose approvals are unknown", () => {
  test("keeps no count and carries the flag; a readable row keeps its number", () => {
    const rows = normalizeRows({
      harnesses: [
        { id: "hrn_000000000000000a", pendingApprovals: null, approvalsUnreachable: true },
        { id: "hrn_000000000000000b", pendingApprovals: 2 },
        { id: "hrn_000000000000000c" },
      ],
    });
    expect(rows.map((r: { pendingApprovals: unknown }) => r.pendingApprovals)).toEqual([
      null,
      2,
      0,
    ]);
    expect(rows.map((r: { approvalsUnreachable: unknown }) => r.approvalsUnreachable)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("the Library and Runs rows say it in words", () => {
    expect(APPROVALS_UNKNOWN).toBe("Approvals unknown");
    for (const file of ["library.js", "runs.js"]) {
      const source = readFileSync(join(VIEWS, file), "utf8");
      expect(source).toContain("approvalsUnreachable");
      expect(source).toContain("text: APPROVALS_UNKNOWN");
    }
  });
});

describe("the Needs-you panel names what it could not read", () => {
  test("by spec name, falling back to the id", () => {
    expect(
      unreachableNames({
        unreachableHarnesses: [
          { id: "hrn_000000000000000a", specName: "Release notes bot" },
          { id: "hrn_000000000000000b", specName: "" },
        ],
      }),
    ).toEqual(["Release notes bot", "hrn_000000000000000b"]);
    expect(unreachableNames({})).toEqual([]);
  });

  test("one sentence, for one or several", () => {
    expect(unreachableNote(["Release notes bot"])).toBe(
      "Couldn't read the approvals of Release notes bot: its sessions folder is outside its folder.",
    );
    expect(unreachableNote(["A", "B", "C"])).toBe(
      "Couldn't read the approvals of A, B and C: each keeps its sessions folder outside its folder.",
    );
    expect(unreachableNote([])).toBe("");
  });
});
