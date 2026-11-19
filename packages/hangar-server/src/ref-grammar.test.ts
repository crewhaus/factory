/**
 * The console's object links read a ref's shape the way Home reads a ref: the
 * console never refuses a link Home would open, and the length limit and the
 * scope's grammar are Home's own.
 */
import { describe, expect, test } from "bun:test";
import {
  HARNESS_ID_RE,
  REF_KINDS,
  REF_MAX_LENGTH,
  mintId,
  mintRunId,
  parseRef,
} from "@crewhaus/control-contract";

type Router = {
  refShape(text: unknown): { scope: string; kind: string; id: string } | null;
  REF_MAX_LENGTH: number;
  parseRoute(hash: string): { view: string; ref?: string };
  hrefInspect(ref: string): string;
};

async function loadRouter(): Promise<Router> {
  const url = new URL("../../hangar-ui/assets/js/router.js", import.meta.url).href;
  return (await import(url)) as Router;
}

const HRN = "hrn_0123456789abcdef";

/** Ids of every grammar a ref kind takes, and ids that fit none. */
const IDS = [
  HRN,
  mintRunId(),
  "run_0123456789abcdef",
  "run_0a1b2c3d",
  "run_k3x9",
  "appr_0123456789abcdef",
  "sess_0123456789abcdef",
  mintId("dep"),
  mintId("cmd"),
  mintId("prn"),
  mintId("rule"),
  mintId("dec"),
  mintId("chg"),
  mintId("wi"),
  mintId("con"),
  mintId("crs"),
  `att_${"0".repeat(26)}`,
  "notes.md",
  "x",
  "",
  "a b",
  "a%20b",
  "x".repeat(REF_MAX_LENGTH),
];

describe("the console's ref shape", () => {
  test("never refuses a ref Home accepts, over every kind and scope", async () => {
    const router = await loadRouter();
    let accepted = 0;
    for (const kind of [...REF_KINDS, "nope"]) {
      for (const scope of ["home", HRN, "hrn_XYZ", "nope"]) {
        for (const id of IDS) {
          const text = `${scope}/${kind}/${id}`;
          if ("error" in parseRef(text)) continue;
          accepted += 1;
          expect([text, router.refShape(text) !== null]).toEqual([text, true]);
          // And the link to it opens as a ref.
          expect([text, router.parseRoute(router.hrefInspect(text)).ref]).toEqual([text, text]);
        }
      }
    }
    // Every kind took at least one id, so the corpus reached each grammar.
    expect(accepted).toBeGreaterThanOrEqual(REF_KINDS.length);
  });

  test("refuses what Home refuses by shape alone", async () => {
    const router = await loadRouter();
    for (const text of [
      `${HRN}/run`,
      `${HRN}/run/a/b`,
      "nope/run/run_1",
      `${HRN}/run/a b`,
      `${HRN}/run/a%b`,
      `${HRN}/run/${"x".repeat(REF_MAX_LENGTH)}`,
      `${HRN}//run_1`,
    ]) {
      expect([text, router.refShape(text)]).toEqual([text, null]);
      expect([text, "error" in parseRef(text)]).toEqual([text, true]);
    }
  });

  test("its length limit and scope grammar are Home's", async () => {
    const router = await loadRouter();
    expect(router.REF_MAX_LENGTH).toBe(REF_MAX_LENGTH);
    expect(HARNESS_ID_RE.source).toBe("^hrn_[0-9a-f]{16}$");
    expect(router.refShape(`${HRN}/run/x`)).not.toBeNull();
    expect(router.refShape("hrn_0123456789abcdeg/run/x")).toBeNull();
    const longest = `${HRN}/run/${"x".repeat(REF_MAX_LENGTH - HRN.length - 5)}`;
    expect(longest.length).toBe(REF_MAX_LENGTH);
    expect(router.refShape(longest)).not.toBeNull();
    expect(router.refShape(`${longest}x`)).toBeNull();
  });
});
