/**
 * A change's check and adoption: the promotion check fails a case the base measured
 * and the candidate did not; a spec check isolates the candidate; the holdout is read
 * once per side and counted; adoption re-checks at the moment it consumes the grant;
 * and a rollback restores the saved bytes, or refuses with the diff when the file moved.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import {
  type ChangeAdoptionRow,
  type LedgerRecord,
  casAppend,
  decisionsLedger,
} from "@crewhaus/control-records";
import { readHeldOutUses } from "@crewhaus/dataset-registry";
import { adoptChange, createChange, rollbackChange } from "./adopt";
import { type CheckRunners, checkChange, planCheck, promotionCheck } from "./check";
import { readAdoptionDecision } from "./decision";
import { readChange } from "./store";
import {
  GRADERS,
  NOW,
  SPEC,
  allPass,
  fakeRunners,
  harness,
  removeTempDirs,
  run,
  sameInstrument,
} from "./test-helpers";

afterAll(removeTempDirs);

const ACTOR = mintId("prn");
const CANDIDATE = SPEC.replace("Help the customer.", "Help the customer, briefly.");
const now = () => NOW;

async function propose(dir: string, candidate = CANDIDATE) {
  const created = await createChange({
    harnessDir: dir,
    kind: "spec",
    source: "manual",
    spec: "crewhaus.yaml",
    graders: "eval/graders.yaml",
    dataset: "registry:cases",
    baseText: SPEC,
    candidateText: candidate,
    actor: ACTOR,
    now,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.row;
}

async function grant(dir: string, decision: string): Promise<ChangeAdoptionRow> {
  const row = readAdoptionDecision(dir, decision) as ChangeAdoptionRow;
  const granted: ChangeAdoptionRow = {
    ...row,
    state: "granted",
    decision: "grant",
    decidedAt: new Date(NOW).toISOString(),
    decidedByPrincipal: ACTOR,
  };
  const cas = await casAppend(
    decisionsLedger(dir),
    row.id,
    "pending",
    granted as unknown as LedgerRecord,
  );
  expect(cas.ok && cas.applied).toBe(true);
  return granted;
}

describe("promotionCheck", () => {
  test("a candidate that leaves the hardest case not measured fails with its id", () => {
    const base = run("run_b", { easy: "pass", mid: "pass", hard: "pass" });
    const candidate = run("run_c", { easy: "pass", mid: "pass", hard: "not_measured" });
    const check = promotionCheck(base, candidate);
    expect(check.comparison).toBe("fail");
    expect(check.lost).toEqual(["hard"]);
    expect(check.reason).toContain("hard");
  });

  test("a candidate whose cases leave out one the base measured fails with that id", () => {
    const base = run("run_b", { easy: "pass", mid: "pass", hard: "pass" });
    const candidate = run("run_c", { easy: "pass", mid: "pass" });
    const check = promotionCheck(base, candidate);
    expect(check.comparison).toBe("fail");
    expect(check.absent).toEqual(["hard"]);
    expect(check.reason).toContain("absent from the candidate: hard");
  });

  test("a candidate that measured everything and lost nothing passes", () => {
    const base = run("run_b", { a: "pass", b: "fail" });
    const candidate = run("run_c", { a: "pass", b: "pass" });
    const check = promotionCheck(base, candidate);
    expect(check.comparison).toBe("pass");
    expect(check.recoveries).toEqual(["b"]);
  });

  test("runs measured with different graders are not comparable", () => {
    const base = run("run_b", { a: "pass" }, { gradersHash: "g1" });
    const candidate = run("run_c", { a: "pass" }, { gradersHash: "g2" });
    expect(promotionCheck(base, candidate)).toMatchObject({
      comparison: "not_comparable",
      rule: "instrument",
    });
  });
});

describe("checking a spec change", () => {
  test("tool results replay from the lineage's recording when it recorded them", async () => {
    const dir = await harness();
    const row = await propose(dir);
    const recorded = run(
      "run_rec",
      { c0: "pass" },
      {
        toolRecording: { mode: "record", dir: "/recordings/r1" },
      },
    );
    const { runners, calls } = fakeRunners((_l, a) => allPass(a), {
      recordedRun: () => ({ summary: recorded, dir: "/runs/rec" }),
      externalWriteTools: () => true,
    });
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    expect(checked.ok).toBe(true);
    expect(calls.evals.map((e) => e.replayToolsDir)).toEqual(["/recordings/r1", "/recordings/r1"]);
    expect(readChange(dir, row.id)?.isolation).toBe("recorded-tools");
  });

  test("a harness with an outside-writing tool and no recording needs a live check", async () => {
    const dir = await harness();
    const row = await propose(dir);
    const { runners, calls } = fakeRunners((_l, a) => allPass(a), {
      externalWriteTools: () => true,
    });
    const refused = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("needs-live");
    expect(calls.evals).toHaveLength(0);
    expect(readChange(dir, row.id)?.state).toBe("proposed");
  });

  test("a live check records who confirmed it", async () => {
    const dir = await harness();
    const row = await propose(dir);
    const { runners } = fakeRunners((_l, a) => allPass(a), { externalWriteTools: () => true });
    const checked = await checkChange({
      harnessDir: dir,
      chg: row.id,
      runners,
      actor: ACTOR,
      live: { confirmedBy: ACTOR },
      now,
    });
    if (!checked.ok) throw new Error(checked.reason);
    const after = readChange(dir, row.id);
    expect(after?.isolation).toBe("live");
    expect(after?.liveBy).toBe(ACTOR);
    const evidence = JSON.parse(readFileSync(join(dir, checked.evidenceRef), "utf8"));
    expect(evidence.isolation).toBe(`live, confirmed by ${ACTOR}`);
  });

  test("a runner that throws leaves the change failed, and it can be checked again", async () => {
    const dir = await harness();
    const row = await propose(dir);
    const broken: CheckRunners = {
      ...fakeRunners(allPassAll).runners,
      evalSpec: async () => {
        throw new Error("provider down");
      },
    };
    const failed = await checkChange({
      harnessDir: dir,
      chg: row.id,
      runners: broken,
      actor: ACTOR,
      now,
    });
    expect(failed.ok).toBe(false);
    expect(readChange(dir, row.id)?.state).toBe("failed");
    const { runners } = fakeRunners((_l, a) => allPass(a));
    const again = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    expect(again.ok).toBe(true);
  });
});

function allPassAll(_label: string, args: Parameters<typeof allPass>[0]) {
  return allPass(args);
}

describe("the holdout", () => {
  test("each check reads it once per side, and a later change with the same base reuses the base run", async () => {
    const dir = await harness({ holdout: true });
    const datasets = join(dir, ".crewhaus", "datasets");
    const first = await propose(dir);
    const cache = new Map<string, ReturnType<typeof run>>();
    const { runners, calls } = fakeRunners((_l, a) => allPass(a), {
      loadRun: async (path) => cache.get(path),
    });
    const wrapped: CheckRunners = {
      ...runners,
      evalSpec: async (args) => {
        const summary = await runners.evalSpec(args);
        cache.set(args.outDir, summary);
        return summary;
      },
    };
    const checked = await checkChange({
      harnessDir: dir,
      chg: first.id,
      runners: wrapped,
      actor: ACTOR,
      now,
    });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.verdict.holdout).toBe("pass");
    let uses = readHeldOutUses(datasets, "cases", "v1").uses;
    expect(uses.map((u) => [u.split, u.purpose, u.change])).toEqual([
      ["holdout", "promotion", first.id],
      ["holdout", "promotion", first.id],
    ]);
    expect(calls.evals.filter((e) => e.label.startsWith("holdout"))).toHaveLength(2);

    const second = await propose(
      dir,
      SPEC.replace("Help the customer.", "Help the customer fast."),
    );
    const before = calls.evals.length;
    const again = await checkChange({
      harnessDir: dir,
      chg: second.id,
      runners: wrapped,
      actor: ACTOR,
      now,
    });
    if (!again.ok) throw new Error(again.reason);
    uses = readHeldOutUses(datasets, "cases", "v1").uses;
    expect(uses).toHaveLength(3);
    expect(uses[2]?.change).toBe(second.id);
    expect(calls.evals.slice(before).map((e) => e.label)).toEqual([
      "base",
      "candidate",
      "holdout-candidate",
    ]);
  });

  test("a dataset with no holdout is adopted only with withoutHoldout", async () => {
    const dir = await harness();
    const row = await propose(dir);
    const { runners } = fakeRunners((_l, a) => allPass(a));
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.verdict.holdout).toBe("absent");
    await grant(dir, checked.decision as string);
    const base = { harnessDir: dir, chg: row.id, expect: row.base.revision, actor: ACTOR, now };
    const refused = await adoptChange({
      ...base,
      mayDecide: () => true,
      instrumentNow: sameInstrument,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("without-holdout");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    const adopted = await adoptChange({
      ...base,
      withoutHoldout: true,
      mayDecide: () => true,
      instrumentNow: sameInstrument,
    });
    if (!adopted.ok) throw new Error(adopted.reason);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(CANDIDATE);
    expect(adopted.lines.join(" ")).toContain("Adopted, not active yet");
    expect(readAdoptionDecision(dir, checked.decision as string)?.state).toBe("consumed");
  });
});

describe("adopting re-checks everything when it consumes the grant", () => {
  async function checkedAndGranted(requiredClassAnswer = true) {
    const dir = await harness();
    const row = await propose(dir);
    const { runners } = fakeRunners((_l, a) => allPass(a));
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    if (!checked.ok) throw new Error(checked.reason);
    await grant(dir, checked.decision as string);
    return { dir, row, decision: checked.decision as string, requiredClassAnswer };
  }

  test("a spec edited after the check supersedes the decision and the change, and stays as edited", async () => {
    const { dir, row, decision } = await checkedAndGranted();
    const edited = `${SPEC}# a person's edit\n`;
    writeFileSync(join(dir, "crewhaus.yaml"), edited);
    const out = await adoptChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.base.revision,
      withoutHoldout: true,
      actor: ACTOR,
      mayDecide: () => true,
      instrumentNow: sameInstrument,
      now,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("out-of-date");
      expect(out.reason).toContain("Out of date: re-check");
    }
    const dec = readAdoptionDecision(dir, decision);
    expect(dec?.state).toBe("superseded");
    expect(dec?.supersededReason).toBe("revision-changed");
    expect(readChange(dir, row.id)?.state).toBe("superseded");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(edited);
  });

  test("graders changed since the check refuse the adoption", async () => {
    const { dir, row } = await checkedAndGranted();
    writeFileSync(
      join(dir, "eval", "graders.yaml"),
      `${GRADERS}  - name: contains\n    type: expected_contains\n`,
    );
    const out = await adoptChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.base.revision,
      withoutHoldout: true,
      actor: ACTOR,
      mayDecide: () => true,
      instrumentNow: sameInstrument,
      now,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("instrument-changed");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
  });

  test("a grant decided by someone below the class the change needs is refused at adoption", async () => {
    const { dir, row } = await checkedAndGranted();
    const out = await adoptChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.base.revision,
      withoutHoldout: true,
      actor: ACTOR,
      mayDecide: (needed) => needed === "owner" && false,
      instrumentNow: sameInstrument,
      now,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("not-authorized");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
  });
});

describe("rolling back", () => {
  async function adopted() {
    const dir = await harness();
    const row = await propose(dir);
    const { runners } = fakeRunners((_l, a) => allPass(a));
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    if (!checked.ok) throw new Error(checked.reason);
    await grant(dir, checked.decision as string);
    const out = await adoptChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.base.revision,
      withoutHoldout: true,
      actor: ACTOR,
      mayDecide: () => true,
      instrumentNow: sameInstrument,
      now,
    });
    if (!out.ok) throw new Error(out.reason);
    return { dir, row: out.row };
  }

  test("restores the saved bytes when the spec is as adoption left it", async () => {
    const { dir, row } = await adopted();
    const out = await rollbackChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.adoption?.revision as string,
      actor: ACTOR,
      now,
    });
    if (!out.ok) throw new Error(out.reason);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    expect(readChange(dir, row.id)?.state).toBe("rolled-back");
  });

  test("refuses with the diff when the spec moved since adoption", async () => {
    const { dir, row } = await adopted();
    const moved = CANDIDATE.replace("briefly", "briefly and warmly");
    writeFileSync(join(dir, "crewhaus.yaml"), moved);
    const out = await rollbackChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.adoption?.revision as string,
      actor: ACTOR,
      now,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("moved");
      expect(out.diff?.map((d) => d.path)).toEqual(["agent.instructions"]);
    }
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(moved);
  });
});

test("a decision id is minted per check, and the decision binds the change", async () => {
  const dir = await harness();
  const row = await propose(dir);
  const { runners } = fakeRunners((_l, a) => allPass(a));
  const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
  if (!checked.ok) throw new Error(checked.reason);
  const decision = readAdoptionDecision(dir, checked.decision as string);
  expect(decision?.subject.chg).toBe(row.id);
  expect(decision?.requiredClass).toBe("maintainer");
  expect(readChange(dir, row.id)?.state).toBe("awaiting-decision");
  expect(mintId("dec")).not.toBe(checked.decision);
});

describe("a change's content is bound to its record", () => {
  async function granted(dir: string, candidate = CANDIDATE) {
    const row = await propose(dir, candidate);
    const { runners } = fakeRunners((_l, a) => allPass(a));
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    if (!checked.ok) throw new Error(checked.reason);
    await grant(dir, checked.decision as string);
    return { row, decision: checked.decision as string, evidenceRef: checked.evidenceRef };
  }
  const adoptAs = (
    dir: string,
    row: { id: string; base: { revision: string } },
    maintainerOnly = false,
  ) =>
    adoptChange({
      harnessDir: dir,
      chg: row.id,
      expect: row.base.revision,
      withoutHoldout: true,
      actor: ACTOR,
      mayDecide: (needed) => (maintainerOnly ? needed === "maintainer" : true),
      instrumentNow: sameInstrument,
      now,
    });
  const content = (dir: string, chg: string, name: string) =>
    join(dir, ".crewhaus", "proposals", chg, name);

  test("a proposed file rewritten after the grant is refused, and the grant stays unspent", async () => {
    const dir = await harness();
    const { row, decision } = await granted(dir);
    const swapped = `${SPEC}permissions:\n  rules:\n    - type: alwaysAllow\n      pattern: Bash(**)\n`;
    writeFileSync(content(dir, row.id, "proposed.yaml"), swapped);
    const out = await adoptAs(dir, row, true);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("binding-changed");
      expect(out.reason).toContain("proposed.yaml");
    }
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    expect(readAdoptionDecision(dir, decision)?.state).toBe("granted");
    expect(readChange(dir, row.id)?.state).toBe("awaiting-decision");
  });

  test("a patch.json retargeted after the grant is refused, and nothing is written", async () => {
    const dir = await harness();
    const { row, decision } = await granted(dir);
    writeFileSync(join(dir, "other.yaml"), SPEC);
    const path = content(dir, row.id, "patch.json");
    const patch = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...patch, spec: "other.yaml" }));
    const out = await adoptAs(dir, row);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("binding-changed");
    expect(readFileSync(join(dir, "other.yaml"), "utf8")).toBe(SPEC);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    expect(readAdoptionDecision(dir, decision)?.state).toBe("granted");
  });

  test("a patch.json that names a file outside the harness is refused", async () => {
    const dir = await harness();
    const { row } = await granted(dir);
    const path = content(dir, row.id, "patch.json");
    const patch = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...patch, spec: "../elsewhere.yaml" }));
    const out = await adoptAs(dir, row);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("binding-changed");
  });

  test("evidence edited after the grant is refused", async () => {
    const dir = await harness();
    const { row, evidenceRef, decision } = await granted(dir);
    const path = join(dir, evidenceRef);
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...evidence,
        instrument: { source: "summary", routed: false, gradersHash: "other" },
      }),
    );
    const out = await adoptAs(dir, row);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("binding-changed");
      expect(out.reason).toContain("evidence");
    }
    expect(readAdoptionDecision(dir, decision)?.state).toBe("granted");
  });

  test("content edited before the check is refused before anything runs", async () => {
    const dir = await harness();
    const row = await propose(dir);
    writeFileSync(content(dir, row.id, "proposed.yaml"), `${CANDIDATE}# edited\n`);
    const { runners, calls } = fakeRunners((_l, a) => allPass(a));
    const out = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("binding-changed");
    expect(calls.evals).toHaveLength(0);
    expect(readChange(dir, row.id)?.state).toBe("proposed");
  });

  test("a rollback restores only the base the change recorded", async () => {
    const dir = await harness();
    const { row } = await granted(dir);
    const adopted = await adoptAs(dir, row);
    if (!adopted.ok) throw new Error(adopted.reason);
    writeFileSync(content(dir, row.id, "base.yaml"), `${SPEC}# not the base\n`);
    const out = await rollbackChange({
      harnessDir: dir,
      chg: row.id,
      expect: adopted.row.adoption?.revision as string,
      actor: ACTOR,
      now,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("binding-changed");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(CANDIDATE);
  });
});

describe("the instrument is held to the one the check measured with", () => {
  async function granted(config: Record<string, string> = {}) {
    const dir = await harness();
    const row = await propose(dir);
    const fake = fakeRunners((_l, a) => allPass(a)).runners;
    const runners: CheckRunners = {
      ...fake,
      evalSpec: async (args) => {
        const summary = await fake.evalSpec(args);
        return { ...summary, config: { ...summary.config, ...config } };
      },
    };
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    if (!checked.ok) throw new Error(checked.reason);
    await grant(dir, checked.decision as string);
    const adopt = (instrumentNow: Parameters<typeof adoptChange>[0]["instrumentNow"]) =>
      adoptChange({
        harnessDir: dir,
        chg: row.id,
        expect: row.base.revision,
        withoutHoldout: true,
        actor: ACTOR,
        mayDecide: () => true,
        instrumentNow,
        now,
      });
    return { dir, row, decision: checked.decision as string, adopt };
  }

  test("a judge calibration applied since the check refuses the adoption", async () => {
    const { dir, adopt, decision } = await granted();
    const out = await adopt((inputs) => ({ ...sameInstrument(inputs), calibrationDigest: "c2" }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("instrument-changed");
      expect(out.reason).toContain("calibrationDigest");
    }
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    expect(readAdoptionDecision(dir, decision)?.state).toBe("granted");
  });

  test("a plugin grader changed since the check refuses the adoption", async () => {
    const { adopt } = await granted({ pluginsDigest: "p1", cliVersion: "0.9.0" });
    const out = await adopt((inputs) => ({
      ...sameInstrument(inputs),
      pluginsDigest: "p2",
      cliVersion: "0.9.0",
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("instrument-changed");
      expect(out.reason).toContain("pluginsDigest");
    }
  });

  test("an unreadable graders file is a refusal, never a match", async () => {
    const { dir, adopt } = await granted();
    rmSync(join(dir, "eval", "graders.yaml"));
    let asked = 0;
    const out = await adopt((inputs) => {
      asked += 1;
      return sameInstrument(inputs);
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("instrument-changed");
    expect(asked).toBe(0);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
  });

  test("an instrument that cannot be determined is a refusal", async () => {
    const { adopt } = await granted();
    for (const answer of [() => undefined, () => Promise.reject(new Error("no registry"))]) {
      const out = await adopt(answer);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("instrument-changed");
    }
  });

  test("the same instrument adopts", async () => {
    const { dir, adopt } = await granted();
    const out = await adopt(sameInstrument);
    if (!out.ok) throw new Error(out.reason);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(CANDIDATE);
  });
});

test("a write that fails after the grant is used closes the change", async () => {
  const dir = await harness();
  // A spec the writer refuses to save: it does not validate.
  const invalid = SPEC.replace("target: cli", "target: not-a-target");
  const row = await propose(dir, invalid);
  const { runners } = fakeRunners((_l, a) => allPass(a));
  const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
  if (!checked.ok) throw new Error(checked.reason);
  await grant(dir, checked.decision as string);
  const out = await adoptChange({
    harnessDir: dir,
    chg: row.id,
    expect: row.base.revision,
    withoutHoldout: true,
    actor: ACTOR,
    mayDecide: () => true,
    instrumentNow: sameInstrument,
    now,
  });
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.code).toBe("write-failed");
    expect(out.reason).toContain("propose it again");
  }
  expect(readAdoptionDecision(dir, checked.decision as string)?.state).toBe("consumed");
  const after = readChange(dir, row.id);
  expect(after?.state).toBe("superseded");
  expect(after?.reason).toBe("other");
  expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
});

describe("the holdout's own isolation", () => {
  /** A real cassette directory holding one recorded tool call per named case. */
  function cassette(dir: string, ids: ReadonlyArray<string>): string {
    const rec = join(dir, "recordings", "r1");
    mkdirSync(rec, { recursive: true });
    writeFileSync(
      join(rec, "tools.jsonl"),
      ids
        .map((id) =>
          JSON.stringify({
            sampleId: id,
            toolName: "Write",
            argsHash: "a".repeat(64),
            args: {},
            result: "ok",
          }),
        )
        .join("\n")
        .concat("\n"),
    );
    return rec;
  }
  function runnersWith(rec: string) {
    const recorded = run(
      "run_rec",
      { c0: "pass" },
      { toolRecording: { mode: "record", dir: rec } },
    );
    return fakeRunners((_l, a) => allPass(a), {
      recordedRun: () => ({ summary: recorded, dir: "/runs/rec" }),
      externalWriteTools: () => true,
    });
  }

  test("a recording that holds nothing for the holdout's cases needs a live check, before any read is counted", async () => {
    const dir = await harness({ holdout: true });
    const row = await propose(dir);
    const { runners, calls } = runnersWith(cassette(dir, ["c0", "c1", "d0"]));
    const opts = { harnessDir: dir, chg: row.id, runners, actor: ACTOR, now };
    const plan = await planCheck(opts);
    expect("kind" in plan && plan.isolation).toBe("recorded-tools");
    expect("kind" in plan && plan.holdoutIsolation).toBe("needs-live");
    const refused = await checkChange(opts);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("needs-live");
      expect(refused.reason).toContain("holdout");
    }
    expect(calls.evals).toHaveLength(0);
    expect(readHeldOutUses(join(dir, ".crewhaus", "datasets"), "cases", "v1").uses).toEqual([]);
    expect(readChange(dir, row.id)?.state).toBe("proposed");
  });

  test("a live check replays the recording for the cases it holds and runs the holdout live", async () => {
    const dir = await harness({ holdout: true });
    const row = await propose(dir);
    const rec = cassette(dir, ["c0", "c1", "d0"]);
    const { runners, calls } = runnersWith(rec);
    const checked = await checkChange({
      harnessDir: dir,
      chg: row.id,
      runners,
      actor: ACTOR,
      live: { confirmedBy: ACTOR },
      now,
    });
    if (!checked.ok) throw new Error(checked.reason);
    expect(calls.evals.map((e) => [e.label, e.replayToolsDir])).toEqual([
      ["base", rec],
      ["candidate", rec],
      ["holdout-base", undefined],
      ["holdout-candidate", undefined],
    ]);
    const evidence = JSON.parse(readFileSync(join(dir, checked.evidenceRef), "utf8"));
    expect(evidence.holdout.isolation).toBe(`live, confirmed by ${ACTOR}`);
  });

  test("a recording that holds the holdout's cases is replayed for them", async () => {
    const dir = await harness({ holdout: true });
    const row = await propose(dir);
    const rec = cassette(dir, ["c0", "h0", "h1"]);
    const { runners, calls } = runnersWith(rec);
    const checked = await checkChange({ harnessDir: dir, chg: row.id, runners, actor: ACTOR, now });
    if (!checked.ok) throw new Error(checked.reason);
    expect(calls.evals.map((e) => e.replayToolsDir)).toEqual([rec, rec, rec, rec]);
  });
});

describe("a candidate that abstains on a case the base measured", () => {
  test("fails the promotion check with its id, whatever its pass rate", () => {
    const base = run("run_b", { easy: "pass", mid: "pass", hard: "fail" });
    const candidate = run("run_c", { easy: "pass", mid: "pass", hard: "pass" });
    const abstained = {
      ...candidate,
      samples: candidate.samples.map((s) =>
        s.sampleId === "hard"
          ? {
              ...s,
              grades: {
                ...s.grades,
                overall: { ...s.grades.overall, passed: false, score: 0, abstained: true },
              },
            }
          : s,
      ),
      aggregates: { ...candidate.aggregates, passRate: 1 },
    };
    const check = promotionCheck(base, abstained);
    expect(check.comparison).toBe("fail");
    expect(check.lost).toEqual(["hard"]);
    expect(check.reason).toContain("not measured: hard");
  });
});
