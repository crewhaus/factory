/**
 * Isolated tests for the `readTranscript` catch arm in `runSample`.
 *
 * `readTranscript` opens the per-sample event-log to reconstruct the
 * transcript when the invoker didn't supply one. A missing log is tolerated
 * only when it surfaces as an "invalid sessionId" error (test stubs that skip
 * persistence); any other failure is rethrown as a `RunnerError`. Both arms
 * require `openEventLog` to throw, so we stub `@crewhaus/event-log`.
 *
 * `mock.module` is process-global and Bun evaluates every test file's body in
 * one up-front load phase, so this stub can leak into sibling suites whose
 * real `runSample` legitimately opens an event-log. The stub must therefore be
 * BOTH deterministic for this file and transparent when leaked:
 *
 *   - Its throwing modes ("invalid"/"generic") are armed only for the single
 *     test that needs them and disarmed again in `afterEach`. In its default
 *     "off" state it is a pure pass-through to the real implementation, so any
 *     leak into a sibling suite behaves exactly like the real module.
 *   - The pass-through calls a *snapshot* of the real `openEventLog`
 *     (`realOpenEventLog`), captured into a local before `mock.module` runs —
 *     NOT `realEventLog.openEventLog`. Reading the property at call time would
 *     self-recurse, because `mock.module` redirects the captured namespace's
 *     own `openEventLog` binding back into this stub (the `RangeError:
 *     Maximum call stack size exceeded` previously seen in sibling suites). A
 *     plain function value captured pre-mock is immune to that redirection.
 *
 * `throwMode` is disarmed in `afterEach` and the real module is reinstalled in
 * `afterAll` so the override is fully inert once this file's tests finish.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";

// Capture the real module (for `afterAll` restoration) AND snapshot the real
// `openEventLog` function value *before* installing the override, so the
// pass-through can call it without re-entering this stub. The module capture
// is a plain-object SNAPSHOT (`{ ...ns }`): an ESM namespace is a live view
// that resolves to the stub once mock.module patches the module, so restoring
// from the namespace itself would silently reinstall the stub.
const realEventLog = { ...(await import("@crewhaus/event-log")) };
const realOpenEventLog = realEventLog.openEventLog;

// "off" → transparent pass-through to the real log (safe for any leaked call).
let throwMode: "off" | "invalid" | "generic" = "off";

mock.module("@crewhaus/event-log", () => ({
  ...realEventLog,
  openEventLog: async (sessionId: string, opts?: { rootDir?: string }) => {
    if (throwMode === "invalid") {
      // Tolerated: matches the /invalid sessionId/ guard in readTranscript.
      throw new Error('event-log: invalid sessionId "nope" — expected sess_<16 hex>');
    }
    if (throwMode === "generic") {
      // Rethrown as RunnerError.
      throw new Error("disk on fire");
    }
    // Default: real behaviour against the (possibly empty) on-disk log.
    return realOpenEventLog(sessionId, opts ?? {});
  },
}));

const { runSample } = await import("./run-sample");

const SAMPLE: Sample = { id: "s1", input: "hi", expected_output: "ok" };
const EXACT = (() => {
  const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
  return compiled.map((g) => ({ name: g.name, grader: g.grader }));
})();

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-rs-eventlog-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterEach(() => {
  // Disarm immediately so the stub is inert (returns an empty log) outside the
  // test that armed a throwing mode. The stub itself stays installed across
  // this file's tests — both of them rely on it — but in its "off" state it is
  // behaviourally identical to the real module against a not-yet-written log,
  // so any leak into a sibling suite is harmless.
  throwMode = "off";
});
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("@crewhaus/event-log", () => realEventLog);
});

describe("runSample — readTranscript failure handling", () => {
  test("tolerates an 'invalid sessionId' error (missing-log stub case)", async () => {
    throwMode = "invalid";
    const outDir = newTempRoot();
    // Invoker supplies no transcript/events and no error → readTranscript runs.
    const invoker = async () => ({ agentOutput: "ok" });
    const result = await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir,
      model: "claude-test",
    });
    // Tolerated: transcript stays empty, sample still grades.
    expect(result.turns).toBe(0);
    expect(result.grades.overall.passed).toBe(true);
  });

  test("rethrows any other open failure as a RunnerError", async () => {
    throwMode = "generic";
    const outDir = newTempRoot();
    const invoker = async () => ({ agentOutput: "ok" });
    await expect(
      runSample({
        sample: SAMPLE,
        invoker,
        graders: EXACT,
        outDir,
        model: "claude-test",
      }),
    ).rejects.toThrow(/failed to read transcript for/);
  });
});
