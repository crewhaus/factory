/**
 * The group walk's three rules: plan-before-act, keep going past a refusal,
 * and skip-with-a-note. Driven against a fake registry — the ordering and
 * the walk are the contract here, not the process layer, which
 * `process.test.ts` owns.
 */
import { describe, expect, test } from "bun:test";
import type { HangarHarnessEntry, HangarRegistry } from "@crewhaus/harness-registry";
import { sortGroupMembers } from "@crewhaus/harness-registry";
import { GROUP_VERBS, groupPlan, isGroupVerb, runGroup } from "./group-ops";

function entry(
  specName: string,
  target: string,
  order?: number,
  missing = false,
): HangarHarnessEntry {
  return {
    id: `hrn_${specName.padEnd(16, "0").slice(0, 16)}`,
    dir: `/fleet/${specName}`,
    specName,
    target,
    origin: "manual",
    originDetail: "",
    registeredAt: "2026-08-01T00:00:00.000Z",
    lastSeen: "2026-08-01T00:00:00.000Z",
    groups: ["crew"],
    ...(order !== undefined ? { groupOrder: { crew: order } } : {}),
    tags: [],
    pinned: false,
    notes: "",
    kind: "local",
    watchme: { share: false },
    remotes: [],
    missingSince: missing ? "2026-08-02T00:00:00.000Z" : null,
  };
}

/** A registry whose only real behaviour is group membership + ordering. */
function fakeRegistry(entries: readonly HangarHarnessEntry[]): HangarRegistry {
  return {
    groupMembers: (group: string) => sortGroupMembers(group, entries),
    listGroups: () => [{ name: "crew", order: 1, color: "" }],
    get: (idOrDir: string) => entries.find((e) => e.id === idOrDir || e.dir === idOrDir),
  } as unknown as HangarRegistry;
}

const live = { live: () => true };

describe("the verb vocabulary", () => {
  test("start | stop | restart — drain is deliberately NOT a fleet sweep", () => {
    expect([...GROUP_VERBS]).toEqual(["start", "stop", "restart"]);
    expect(isGroupVerb("drain")).toBe(false);
    expect(isGroupVerb("start")).toBe(true);
  });
});

describe("groupPlan", () => {
  const fleet = [
    entry("chief", "channel", 3),
    entry("secretary", "channel", 1),
    entry("archivist", "channel", 2),
  ];

  test("start walks the declared boot order", () => {
    const plan = groupPlan(fakeRegistry(fleet), "crew", "start", live);
    expect(plan.members.map((m) => m.specName)).toEqual(["secretary", "archivist", "chief"]);
    expect(plan.members.map((m) => m.position)).toEqual([1, 2, 3]);
    expect(plan.actionable).toBe(3);
  });

  test("stop REVERSES it — dependents go down before what they depend on", () => {
    const plan = groupPlan(fakeRegistry(fleet), "crew", "stop", live);
    expect(plan.members.map((m) => m.specName)).toEqual(["chief", "archivist", "secretary"]);
  });

  test("members with no declared order come last, stably by name", () => {
    const mixed = [
      entry("zulu", "channel"),
      entry("alpha", "channel"),
      entry("first", "channel", 1),
    ];
    const plan = groupPlan(fakeRegistry(mixed), "crew", "start", live);
    expect(plan.members.map((m) => m.specName)).toEqual(["first", "alpha", "zulu"]);
    expect(plan.members[1]?.declaredOrder).toBeNull();
  });

  test("shapes with no daemon are planned as SKIPS, with the reason", () => {
    const plan = groupPlan(
      fakeRegistry([entry("secretary", "channel", 1), entry("scratch", "cli", 2)]),
      "crew",
      "start",
      live,
    );
    expect(plan.actionable).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.members[1]?.skip).toContain("interactive class");
  });

  test("a crew member is skipped toward the brief, not toward `start`", () => {
    const plan = groupPlan(fakeRegistry([entry("pipeline", "crew", 1)]), "crew", "start", live);
    expect(plan.members[0]?.skip).toContain("submit a brief");
  });

  test("a vanished directory is a named skip, never a silent one", () => {
    const plan = groupPlan(
      fakeRegistry([entry("gone", "channel", 1, true), entry("here", "channel", 2)]),
      "crew",
      "start",
      live,
    );
    expect(plan.members[0]?.skip).toContain("directory is missing");
    expect(plan.actionable).toBe(1);
  });

  test("planning touches nothing — it is the object the walk then consumes", () => {
    // No runner is passed at all; the plan is complete on its own.
    const plan = groupPlan(fakeRegistry(fleet), "crew", "restart", live);
    expect(plan.verb).toBe("restart");
    expect(plan.members).toHaveLength(3);
  });
});

describe("runGroup", () => {
  const fleet = [
    entry("secretary", "channel", 1),
    entry("archivist", "channel", 2),
    entry("chief", "channel", 3),
  ];

  test("acts in plan order and reports one row per member", async () => {
    const seen: string[] = [];
    const result = await runGroup(
      groupPlan(fakeRegistry(fleet), "crew", "start", live),
      async (m) => {
        seen.push(m.specName);
        return { ok: true, message: `started ${m.specName}` };
      },
    );
    expect(seen).toEqual(["secretary", "archivist", "chief"]);
    expect(result.ok).toBe(3);
    expect(result.failed).toBe(0);
  });

  test("a refusal does not strand the members behind it", async () => {
    const seen: string[] = [];
    const result = await runGroup(
      groupPlan(fakeRegistry(fleet), "crew", "start", live),
      async (m) => {
        seen.push(m.specName);
        if (m.specName === "archivist") return { ok: false, message: "already running" };
        return { ok: true, message: "started" };
      },
    );
    expect(seen).toEqual(["secretary", "archivist", "chief"]);
    expect(result.failed).toBe(1);
    expect(result.ok).toBe(2);
  });

  test("a runner that THROWS fails that member only", async () => {
    const result = await runGroup(
      groupPlan(fakeRegistry(fleet), "crew", "start", live),
      async (m) => {
        if (m.specName === "secretary") throw new Error("EMFILE");
        return { ok: true, message: "started" };
      },
    );
    expect(result.members[0]).toMatchObject({ ok: false, message: "EMFILE" });
    expect(result.ok).toBe(2);
  });

  test("skipped members are never handed to the runner, and are not failures", async () => {
    const seen: string[] = [];
    const result = await runGroup(
      groupPlan(
        fakeRegistry([entry("scratch", "cli", 1), entry("chief", "channel", 2)]),
        "crew",
        "start",
        live,
      ),
      async (m) => {
        seen.push(m.specName);
        return { ok: true, message: "started" };
      },
    );
    expect(seen).toEqual(["chief"]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.members[0]?.message).toContain("skipped —");
  });

  test("--parallel runs them together; sequential is the default", async () => {
    let inFlight = 0;
    let peak = 0;
    const runner = async (): Promise<{ ok: true; message: string }> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, message: "started" };
    };
    const plan = groupPlan(fakeRegistry(fleet), "crew", "start", live);

    peak = 0;
    await runGroup(plan, runner);
    expect(peak).toBe(1);

    peak = 0;
    const parallel = await runGroup(plan, runner, { parallel: true });
    expect(peak).toBe(3);
    expect(parallel.parallel).toBe(true);
  });
});
