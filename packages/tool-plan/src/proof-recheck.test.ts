/**
 * Under `continuity.proof: require`, a step or goal counts as proven only while
 * its frozen proof still matches the session log it was read from. A proof
 * written into a plan file or `goals.yaml` by hand completes nothing at the
 * tools that act on it: PlanComplete's note and GoalUpdate's at-target check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProofMode, ProofRequiredError, createPlanTools } from "./index";

let tmp: string;
const SESS = "sess_0123456789abcdef";

function makeTools(proofMode: ProofMode) {
  return createPlanTools({
    specName: "support-bot",
    rootDir: join(tmp, ".crewhaus", "state"),
    appendEvent: () => {},
    sessionId: SESS,
    proofMode,
  });
}

function logToolPair(toolUseId: string): void {
  const dir = join(tmp, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${SESS}.jsonl`),
    `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: toolUseId, name: "Bash", input: { cmd: "bun test" } } })}\n` +
      `${JSON.stringify({ ts: 2, version: 1, kind: "tool_result", payload: { toolUseId, content: "42 pass", isError: false } })}\n`,
  );
}

const storeDir = (): string => join(tmp, ".crewhaus", "state", "support-bot");

function planFile(): string {
  const dir = join(storeDir(), "plans");
  const [name] = readdirSync(dir).filter((n) => n.startsWith("plan-0001-"));
  return join(dir, name as string);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tool-plan-recheck-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("PlanComplete under require", () => {
  test("a fabricated frozen proof on step 1 leaves the plan incomplete, naming step 1", async () => {
    const tools = makeTools("require");
    await tools.planUpdate.execute({ action: "create", title: "ship", steps: ["one", "two"] });
    logToolPair("tu_one");
    await tools.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_one" }] });
    // Rewrite step 1's frozen proof by hand: an id no session log holds.
    const path = planFile();
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("tu_one", "tu_forged"));
    logToolPair("tu_two");
    const reply = await tools.planComplete.execute({
      step: 2,
      evidence: [{ toolUseId: "tu_two" }],
    });
    expect(reply).toContain("plan-0001 step 2 proven");
    expect(reply).toContain(
      "plan-0001 is not complete: step 1: its proof no longer matches the session log — prove it with PlanComplete",
    );
  });

  test("PlanUpdate's claimed note agrees", async () => {
    const tools = makeTools("require");
    await tools.planUpdate.execute({ action: "create", title: "ship", steps: ["one", "two"] });
    logToolPair("tu_one");
    await tools.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_one" }] });
    const path = planFile();
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("tu_one", "tu_forged"));
    const reply = await tools.planUpdate.execute({
      action: "set_step_status",
      step: 2,
      status: "claimed",
    });
    expect(reply).toContain(
      "plan-0001 is not complete: step 2 is claimed, not proven; step 1: its proof no longer matches the session log — prove each",
    );
  });

  test("the same flow on genuine proofs completes, with no note", async () => {
    const tools = makeTools("require");
    await tools.planUpdate.execute({ action: "create", title: "ship", steps: ["one", "two"] });
    logToolPair("tu_one");
    await tools.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_one" }] });
    logToolPair("tu_two");
    const reply = await tools.planComplete.execute({
      step: 2,
      evidence: [{ toolUseId: "tu_two" }],
    });
    expect(reply).toBe("plan-0001 step 2 proven — evidence: tu_two");
  });

  test("the ladder reads no log: the same forged file gives the ladder's reply", async () => {
    const tools = makeTools("ladder");
    await tools.planUpdate.execute({ action: "create", title: "ship", steps: ["one", "two"] });
    logToolPair("tu_one");
    await tools.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_one" }] });
    const path = planFile();
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("tu_one", "tu_forged"));
    logToolPair("tu_two");
    expect(await tools.planComplete.execute({ step: 2, evidence: [{ toolUseId: "tu_two" }] })).toBe(
      "plan-0001 step 2 proven — evidence: tu_two",
    );
  });
});

describe("GoalUpdate under require", () => {
  function handProvedGoal(): void {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(
      join(storeDir(), "goals.yaml"),
      // JSON is YAML: the store reads it as it reads its own file.
      JSON.stringify({
        version: 1,
        goals: [
          {
            id: "goal-0001",
            title: "Close tickets",
            status: "proven",
            target: 10,
            current: 4,
            proofs: [
              {
                toolUseId: "tu_made_up",
                sessionId: SESS,
                toolName: "Bash",
                inputHash: "sha256:00",
                resultDigest: "10 closed",
                verifiedAt: "2026-07-13T00:00:00.000Z",
              },
            ],
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        ],
      }),
    );
  }

  test("reaching the target on a hand-proved goal is refused", async () => {
    handProvedGoal();
    const before = readFileSync(join(storeDir(), "goals.yaml"), "utf8");
    const tools = makeTools("require");
    const err = await tools.goalUpdate
      .execute({ goalId: "goal-0001", current: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofRequiredError);
    expect((err as Error).message).toContain(
      "goal-0001 is marked proven with a proof the session log does not match, not proven — reaching its target (10/10) would mark it achieved. Prove it in the same call",
    );
    expect(readFileSync(join(storeDir(), "goals.yaml"), "utf8")).toBe(before);
  });

  test("a genuinely proven goal reaches its target", async () => {
    const tools = makeTools("require");
    await tools.goalWrite.execute({ title: "Close tickets", target: 10, current: 4 });
    logToolPair("tu_measure");
    await tools.goalUpdate.execute({
      goalId: "goal-0001",
      current: 5,
      status: "proven",
      evidence: [{ toolUseId: "tu_measure" }],
    });
    const reply = await tools.goalUpdate.execute({ goalId: "goal-0001", current: 10 });
    expect(reply).toContain("goal-0001 updated");
    expect(reply).toContain("(10/10)");
  });

  test("the ladder lets the hand-proved goal reach its target, reading no log", async () => {
    handProvedGoal();
    const tools = makeTools("ladder");
    expect(await tools.goalUpdate.execute({ goalId: "goal-0001", current: 10 })).toContain(
      "(10/10)",
    );
  });
});
