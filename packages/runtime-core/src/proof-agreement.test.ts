/**
 * 0.8.0 (design/0.8.0-provability-release.md §6.3) — one rule for what a
 * cited tool call proves. `continuity.proof` (PlanComplete, through
 * continuity-store's `resolveEvidence`) and the provability gate's `checked`
 * rung (provability's `evidenceFromSessionLog`) each scan the same session
 * log for a `toolUseId`; where they read a log differently, a step is
 * proven by a call the gate refuses, or the other way round.
 *
 * The shapes they once read differently: a call whose result was logged
 * twice (ok then error, error then ok — a replayed or retried append), and
 * one id the provider reused in a later turn. Each scan is run for real
 * over one log on disk, and the two verdicts must agree. runtime-core is
 * the package that wires both (the gate, and the plan tools a harness
 * registers), so the agreement is held here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventLog } from "@crewhaus/event-log";
import {
  type ProvabilityConfig,
  buildEvidenceIndex,
  evidenceFromSessionLog,
  verifyDocument,
} from "@crewhaus/provability";
import { createPlanTools } from "@crewhaus/tool-plan";

const SESS = "sess_00000000000000e1";

const CHECKED: ProvabilityConfig = {
  level: "checked",
  onFail: "retry",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["moneyAdd"], replay: false, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: [], timeoutMs: 30_000 },
};

type Line =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "use"; readonly id: string }
  | { readonly kind: "result"; readonly id: string; readonly ok: boolean };

/** The log shapes, each under its own id: what each scan must read alike. */
const SHAPES: ReadonlyArray<{
  readonly id: string;
  readonly lines: readonly Line[];
  /** What both scans must conclude: the call proves the step / the claim. */
  readonly proves: boolean;
}> = [
  {
    id: "toolu_ok_then_error",
    lines: [
      { kind: "use", id: "toolu_ok_then_error" },
      { kind: "result", id: "toolu_ok_then_error", ok: true },
      { kind: "result", id: "toolu_ok_then_error", ok: false },
    ],
    proves: false,
  },
  {
    id: "toolu_error_then_ok",
    lines: [
      { kind: "use", id: "toolu_error_then_ok" },
      { kind: "result", id: "toolu_error_then_ok", ok: false },
      { kind: "result", id: "toolu_error_then_ok", ok: true },
    ],
    proves: true,
  },
  {
    // The provider reused the id a turn later, and that call failed.
    id: "toolu_reused",
    lines: [
      { kind: "use", id: "toolu_reused" },
      { kind: "result", id: "toolu_reused", ok: true },
      { kind: "user", text: "and again" },
      { kind: "use", id: "toolu_reused" },
      { kind: "result", id: "toolu_reused", ok: false },
    ],
    proves: false,
  },
  {
    // …and the other way round: a failed call, then a later one that worked.
    id: "toolu_reused_fixed",
    lines: [
      { kind: "use", id: "toolu_reused_fixed" },
      { kind: "result", id: "toolu_reused_fixed", ok: false },
      { kind: "user", text: "try once more" },
      { kind: "use", id: "toolu_reused_fixed" },
      { kind: "result", id: "toolu_reused_fixed", ok: true },
    ],
    proves: true,
  },
];

let tmp: string;
let sessions: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "proof-agreement-"));
  sessions = join(tmp, ".crewhaus", "sessions");
  const log = await openEventLog(SESS, { rootDir: sessions });
  try {
    await log.append({ kind: "user_message", payload: { content: "add the invoice" } });
    for (const shape of SHAPES) {
      for (const line of shape.lines) {
        if (line.kind === "user") {
          await log.append({ kind: "user_message", payload: { content: line.text } });
        } else if (line.kind === "use") {
          await log.append({
            kind: "tool_use",
            payload: { id: line.id, name: "MoneyAdd", input: { amounts: ["1200", "84.50"] } },
          });
        } else {
          await log.append({
            kind: "tool_result",
            payload: {
              toolUseId: line.id,
              content: line.ok ? "1284.50" : "error: the adder crashed",
              isError: !line.ok,
            },
          });
        }
      }
    }
  } finally {
    await log.close();
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("PlanComplete and the checked rung read a session log alike", () => {
  test("duplicated results and reused ids: the same verdict from both scans", async () => {
    const plan = createPlanTools({
      specName: "agreement",
      rootDir: join(tmp, ".crewhaus", "state"),
      sessionRootDir: sessions,
      sessionId: SESS,
      proofMode: "require",
    });
    await plan.planUpdate.execute({
      action: "create",
      title: "invoice",
      steps: SHAPES.map((s) => `total via ${s.id}`),
    });
    const evidence = buildEvidenceIndex(
      await evidenceFromSessionLog({ sessionId: SESS, rootDir: sessions }),
    );
    const verdicts: Array<[string, boolean, boolean]> = [];
    for (const [i, shape] of SHAPES.entries()) {
      await plan.planComplete
        .execute({ planId: "plan-0001", step: i + 1, evidence: [{ toolUseId: shape.id }] })
        .catch(() => undefined);
      const step = (await plan.store.getPlan("plan-0001"))?.steps[i];
      const stepProven = step?.status === "proven";
      const bundle = await verifyDocument(`The total is 1,284.50 [1].\n\n[1]: tool:${shape.id}`, {
        config: CHECKED,
        evidence,
      });
      const claimChecked = bundle.claims[0]?.status === "met";
      verdicts.push([shape.id, stepProven, claimChecked]);
    }
    // One rule: each pair agrees, and each says what the shape proves.
    expect(verdicts).toEqual(SHAPES.map((s) => [s.id, s.proves, s.proves]));
  });
});
