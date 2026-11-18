import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalIdentity } from "@crewhaus/access-control";
import type { ApproverRead } from "@crewhaus/control-records";
import type { ControlService } from "@crewhaus/control-service";
import { BASELINES_FILENAME, type RunIndexEntry, pinRun } from "@crewhaus/eval-report";
import {
  governedHome,
  governedTmp,
  linkMember,
  linkTo,
  project,
  removeGovernedDirs,
} from "./__test__/governed";
import { NOT_THE_OWNER, UNNAMED_HOME, ownerCheck } from "./owner-check";

afterAll(removeGovernedDirs);

const OWNER_USER: LocalIdentity = { username: "owner", hostname: "laptop" };
const MEMBER_USER: LocalIdentity = { username: "rae", hostname: "laptop" };
const STRANGER: LocalIdentity = { username: "zed", hostname: "laptop" };

/** A decision service that counts every use and answers nothing. */
function countingControl(): { readonly control: Pick<ControlService, "decisions">; uses: number } {
  const counted = { uses: 0 } as { control: Pick<ControlService, "decisions">; uses: number };
  counted.control = {
    decisions: new Proxy({} as ControlService["decisions"], {
      get: () => {
        counted.uses += 1;
        return () => {
          throw new Error("the decision service was used");
        };
      },
    }),
  };
  return counted;
}

/** A harness governed by Home `A`, and the environment a terminal under `A` runs with. */
async function governed(): Promise<{
  readonly harness: string;
  readonly hangarRoot: string;
  readonly owner: string;
  readonly env: Record<string, string>;
}> {
  const a = await governedHome(OWNER_USER);
  const harness = governedTmp("crewhaus-owner-check-harness-");
  project(harness, a.owner, [], a.hangarRoot);
  return {
    harness,
    ...a,
    env: {
      CREWHAUS_HANGAR_ROOT: a.hangarRoot,
      CREWHAUS_REGISTRY_ROOT: governedTmp("crewhaus-owner-check-registry-"),
    },
  };
}

describe("ownerCheck", () => {
  const reader = (read: ApproverRead) => (_dir: string) => read;

  test("no approver projection: single-owner mode, the local user is the owner", () => {
    const counted = countingControl();
    expect(
      ownerCheck(
        "/h",
        reader({ state: "absent" }),
        {},
        {
          control: counted.control,
          identity: STRANGER,
        },
      ),
    ).toEqual({ ok: true });
    expect(counted.uses).toBe(0);
  });

  test("a projection that cannot be read refuses, naming the verb that rewrites it", () => {
    const counted = countingControl();
    const out = ownerCheck(
      "/h",
      reader({ state: "unreadable", reason: "its version is not 1" }),
      {},
      { control: counted.control, identity: OWNER_USER },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("its version is not 1");
      expect(out.reason).toContain("`crewhaus access sync`");
    }
    expect(counted.uses).toBe(0);
  });

  test("a projection that does not name the Home that wrote it refuses, naming the verb that rewrites it", async () => {
    const a = await governedHome(OWNER_USER);
    const harness = governedTmp("crewhaus-owner-check-harness-");
    project(harness, a.owner);
    const counted = countingControl();
    const out = ownerCheck(
      harness,
      undefined,
      { CREWHAUS_HANGAR_ROOT: a.hangarRoot },
      {
        control: counted.control,
        identity: OWNER_USER,
      },
    );
    expect(out).toEqual({ ok: false, reason: UNNAMED_HOME });
    expect(UNNAMED_HOME).toContain("`crewhaus access sync`");
    expect(counted.uses).toBe(0);
  });

  const projection = { owner: "prn_owner" } as unknown as Extract<
    ApproverRead,
    { state: "present" }
  >["projection"];

  test("a command started by an agent's tool is refused before the projection is read", () => {
    const env = { CREWHAUS_AGENT_TOOL: "Bash" };
    for (const read of [{ state: "absent" }, { state: "present", projection }] as const) {
      let calls = 0;
      const counting = (_dir: string): ApproverRead => {
        calls++;
        return read;
      };
      expect(ownerCheck("/h", counting, env)).toEqual({
        ok: false,
        reason: "this command was started by an agent's tool; a person makes this change",
      });
      expect(calls).toBe(0);
    }
  });
});

describe("ownerCheck on a governed harness: only its owner, as the Home that wrote the list knows them", () => {
  test("the owner passes, named by their principal; an unset or empty agent-tool variable changes nothing", async () => {
    const g = await governed();
    for (const env of [g.env, { ...g.env, CREWHAUS_AGENT_TOOL: "" }]) {
      expect(ownerCheck(g.harness, undefined, env, { identity: OWNER_USER })).toEqual({
        ok: true,
        principal: g.owner,
      });
    }
  });

  test("a local user the Home does not link is refused", async () => {
    const g = await governed();
    expect(ownerCheck(g.harness, undefined, g.env, { identity: STRANGER })).toEqual({
      ok: false,
      reason: NOT_THE_OWNER,
    });
  });

  test("a linked member who decides as a maintainer is refused", async () => {
    const g = await governed();
    const member = linkMember(g.hangarRoot, MEMBER_USER, g.owner);
    project(g.harness, g.owner, [{ principal: member, decide: "maintainer" }], g.hangarRoot);
    expect(ownerCheck(g.harness, undefined, g.env, { identity: MEMBER_USER })).toEqual({
      ok: false,
      reason: NOT_THE_OWNER,
    });
  });

  test("a user linked to the owner only under another Hangar root is refused", async () => {
    const g = await governed();
    const b = await governedHome({ username: "eve", hostname: "laptop" });
    linkTo(b.hangarRoot, STRANGER, g.owner, b.owner);
    const env = { ...g.env, CREWHAUS_HANGAR_ROOT: b.hangarRoot };
    expect(ownerCheck(g.harness, undefined, env, { identity: STRANGER })).toEqual({
      ok: false,
      reason: NOT_THE_OWNER,
    });
  });

  test("a directory inside the governed harness, or a link to one, is governed by it", async () => {
    const g = await governed();
    const inside = join(g.harness, "eval", "nested");
    mkdirSync(inside, { recursive: true });
    const link = join(governedTmp("crewhaus-owner-check-link-"), "to-nested");
    symlinkSync(inside, link);
    for (const dir of [inside, link]) {
      expect(ownerCheck(dir, undefined, g.env, { identity: STRANGER })).toEqual({
        ok: false,
        reason: NOT_THE_OWNER,
      });
      expect(ownerCheck(dir, undefined, g.env, { identity: OWNER_USER })).toEqual({
        ok: true,
        principal: g.owner,
      });
    }
  });

  test("a projection above that cannot be read refuses, naming the verb that rewrites it", async () => {
    const g = await governed();
    writeFileSync(join(g.harness, ".crewhaus", "run", "control", "approvers.json"), "{not json");
    const inside = join(g.harness, "eval");
    mkdirSync(inside, { recursive: true });
    const out = ownerCheck(inside, undefined, g.env, { identity: OWNER_USER });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain("`crewhaus access sync`");
  });

  test("a baseline pin over a changed protected criterion is made only for the owner, and names them", async () => {
    const g = await governed();
    const evalsDir = join(g.harness, ".crewhaus", "evals");
    const row = (runId: string, digest: string): RunIndexEntry => ({
      runId,
      specName: "shop",
      specHash: "h",
      datasetName: "smoke",
      datasetHash: "d",
      passRate: 1,
      meanScore: 1,
      sampleCount: 1,
      protectedCriteria: [{ id: "dates", digest }],
      ts: "2026-11-01T00:00:00.000Z",
      outDir: join(evalsDir, runId),
    });
    const cmd = "crewhaus eval-report baseline set";
    expect(pinRun(row("run_a", "d1"), "t1", evalsDir, { cmd }).ok).toBe(true);
    const file = join(evalsDir, BASELINES_FILENAME);
    const before = readFileSync(file, "utf8");
    const pinAs = (identity: LocalIdentity) =>
      pinRun(row("run_b", "d2"), "t2", evalsDir, {
        cmd,
        ownerCheck: () => ownerCheck(g.harness, undefined, g.env, { identity }),
      });
    const refused = pinAs(STRANGER);
    expect(!refused.ok && refused.refusal.code).toBe("protected");
    expect(!refused.ok && refused.refusal.reason).toContain(NOT_THE_OWNER);
    expect(readFileSync(file, "utf8")).toBe(before);
    const done = pinAs(OWNER_USER);
    expect(done.ok && done.pin.rebaselined).toEqual({
      from: "run_a",
      reason: "manual",
      cmd,
      protectedChange: true,
      by: g.owner,
    });
  });
});
