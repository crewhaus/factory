/**
 * `runDetail`, as this package exports it, masks on its own.
 *
 * `GET /runs/:runId` and the SSE `replay` frame are masked AGAIN at the
 * dispatch site, so a server-level sweep cannot tell whether `runDetail`
 * itself still masks. It must: it is exported, and a library caller is not
 * entitled to assume a dispatcher behind it. So this plants three
 * credentials that only this server's exit layers know about, and asks
 * `runDetail` directly:
 *
 *   - in an event, one under a credential-NAMED key, with no shape (key
 *     redaction);
 *   - in an event, one with a credential SHAPE that no env file holds (shape
 *     masking);
 *   - in an event AND in the log, one written as a literal in the harness's
 *     own spec (the spec-credential scrubber, which serves both halves).
 *
 * None may come back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { runDetail } from "./runs";

const RUN = "run_00000000000000e7";
/** Built from parts: never realistic-shaped literals in a fixture. */
const KEYED = ["keyed", "but", "shapeless", "value"].join("-");
const SHAPED = ["sk", "fixture", "0123456789abcdefghij"].join("-");
const SPEC_LITERAL = ["spec", "inline", "literal", "value"].join("-");

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function harness(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-run-detail-exit-"));
  scratch.push(root);
  return makeFixtureHarness(join(root, "exit"), {
    specName: "exit",
    target: "channel",
    specExtra: ["channels:", "  slack:", `    signingSecret: ${SPEC_LITERAL}`].join("\n"),
    runLedger: [
      {
        runId: RUN,
        kind: "daemon",
        argv: ["bun", "dist/daemon.ts"],
        startedAt: "2026-10-31T12:00:00.000Z",
        logFile: `logs/${RUN}.log`,
      },
    ],
    runLogs: [
      {
        runId: RUN,
        log: `verifying with ${SPEC_LITERAL}\nready\n`,
        events: [
          { kind: "tool_result", runId: RUN, apiKey: KEYED, output: `echoed ${SHAPED}` },
          { kind: "note", runId: RUN, text: `slack secret ${SPEC_LITERAL}` },
        ],
      },
    ],
  });
}

describe("runDetail masks at this server's exit", () => {
  test("a keyed, a shaped and a spec-literal credential never come back", () => {
    const detail = runDetail(harness(), RUN, { env: {} });
    expect(detail).toBeDefined();
    const text = JSON.stringify(detail);
    for (const planted of [KEYED, SHAPED, SPEC_LITERAL]) expect(text).not.toContain(planted);
    const [first, second] = (detail?.events ?? []) as Array<Record<string, unknown>>;
    // Key redaction, then shape masking, on the events…
    expect(first?.["apiKey"]).toBe("[redacted]");
    expect(String(first?.["output"])).toStartWith("echoed ");
    // …and the spec literal replaced by the NAME it was found under, in the
    // events and in the tail alike.
    expect(second?.["text"]).toBe("slack secret «signingSecret»");
    expect(detail?.proseTail).toEqual(["verifying with «signingSecret»", "ready"]);
  });
});
