/**
 * Group-ordered bulk lifecycle for the console — the server twin of
 * `crewhaus daemon start|stop|restart --group`.
 *
 * A fleet has dependency order: the secretary whose A2A door every other
 * spec mounts boots first, the archivist that owns the shared wiki space
 * second, the chief that supervises the rest last — and stops go the other
 * way. The console's Runs board was per-row Start/Stop, so bringing a fleet
 * up was N clicks in an order the operator had to remember and nothing
 * recorded.
 *
 * The order lives on the registry entry (`groupOrder[group]`, 1-based) and
 * is read here through `registry.groupMembers`, which puts declared orders
 * first and undeclared ones after, each tier by spec name so the walk is
 * reproducible on every machine.
 *
 * Three rules this module owns, all of them the same ones the CLI applies —
 * they live in ONE encoding per head, and `group-ops.test.ts` pins them:
 *
 *   1. **Plan before act.** {@link groupPlan} answers "what would this do,
 *      in what order" without touching a process, so a UI can show the walk
 *      before asking for it.
 *   2. **Keep going past a refusal.** One member that will not start must
 *      not strand the six behind it.
 *   3. **Skip with a note, never silently.** Interactive and one-shot
 *      members (a `cli` scratch harness, a crew) have no daemon to start;
 *      dropping them from the walk unannounced would let an operator
 *      believe a group is up when part of it was never considered.
 */
import type { HangarHarnessEntry, HangarRegistry } from "@crewhaus/harness-registry";
import { readsBriefOnStdin, runClassFor } from "@crewhaus/harness-supervisor";

/** The lifecycle verbs a group accepts. `drain` is deliberately absent: it
 *  is a graceful per-daemon conversation, not a fleet sweep. */
export const GROUP_VERBS = ["start", "stop", "restart"] as const;
export type GroupVerb = (typeof GROUP_VERBS)[number];

export function isGroupVerb(value: string): value is GroupVerb {
  return (GROUP_VERBS as readonly string[]).includes(value);
}

export type GroupPlanMember = {
  readonly id: string;
  readonly specName: string;
  readonly dir: string;
  readonly target: string;
  /** `daemon` / `worker` are walked; everything else is skipped. */
  readonly runClass: string;
  /** 1-based position in this walk. */
  readonly position: number;
  /** The order the operator declared, when they declared one. */
  readonly declaredOrder: number | null;
  /** Why this member will be skipped, or null when it will be acted on. */
  readonly skip: string | null;
};

export type GroupPlan = {
  readonly group: string;
  readonly verb: GroupVerb;
  /** In WALK order — already reversed for `stop`. */
  readonly members: readonly GroupPlanMember[];
  readonly actionable: number;
  readonly skipped: number;
};

/** Why this member cannot be started/stopped as a daemon, or null. */
function skipReason(entry: HangarHarnessEntry, live: (dir: string) => boolean): string | null {
  if (entry.missingSince !== null || !live(entry.dir)) {
    return `directory is missing (since ${entry.missingSince ?? "now"}) — relocate or remove it`;
  }
  const runClass = runClassFor(entry.target);
  if (runClass === "daemon" || runClass === "worker") return null;
  return `${entry.target} is the ${runClass} class — it has no daemon to start${
    readsBriefOnStdin(entry.target) ? " (submit a brief instead)" : ""
  }`;
}

/**
 * What a group verb would do, in order, without doing any of it.
 *
 * `stop` walks the boot order REVERSED: stopping the secretary while the
 * specs that mount its door are still live turns a clean shutdown into a
 * fistful of connection errors.
 */
export function groupPlan(
  registry: HangarRegistry,
  group: string,
  verb: GroupVerb,
  deps: { readonly live: (dir: string) => boolean },
): GroupPlan {
  const ordered = registry.groupMembers(group);
  const walk = verb === "stop" ? [...ordered].reverse() : ordered;
  const members = walk.map((entry, index): GroupPlanMember => {
    const declared = entry.groupOrder?.[group];
    return {
      id: entry.id,
      specName: entry.specName,
      dir: entry.dir,
      target: entry.target,
      runClass: runClassFor(entry.target),
      position: index + 1,
      declaredOrder: declared ?? null,
      skip: skipReason(entry, deps.live),
    };
  });
  return {
    group,
    verb,
    members,
    actionable: members.filter((m) => m.skip === null).length,
    skipped: members.filter((m) => m.skip !== null).length,
  };
}

export type GroupMemberResult = {
  readonly id: string;
  readonly specName: string;
  readonly position: number;
  readonly ok: boolean;
  /** `skipped` members were never acted on; the rest were. */
  readonly skipped: boolean;
  /** One line an operator can act on. */
  readonly message: string;
  /** The typed refusal reason, when the supervisor gave one. */
  readonly reason?: string;
  readonly runId?: string;
};

export type GroupRunResult = {
  readonly group: string;
  readonly verb: GroupVerb;
  readonly parallel: boolean;
  readonly members: readonly GroupMemberResult[];
  readonly ok: number;
  readonly failed: number;
  readonly skipped: number;
};

/** Act on one member. Returns the row that lands in the response. */
export type GroupMemberRunner = (
  member: GroupPlanMember,
) => Promise<Omit<GroupMemberResult, "id" | "specName" | "position" | "skipped">>;

/**
 * Walk a group's plan, acting on every actionable member.
 *
 * `parallel` is opt-in and exists for groups where order genuinely does not
 * matter; it can never be the default, because the ordering IS the feature.
 * A member whose runner throws fails that member only — the walk continues,
 * and the caller decides the HTTP status from `failed`.
 */
export async function runGroup(
  plan: GroupPlan,
  run: GroupMemberRunner,
  opts: { readonly parallel?: boolean } = {},
): Promise<GroupRunResult> {
  const parallel = opts.parallel === true;
  const one = async (member: GroupPlanMember): Promise<GroupMemberResult> => {
    const base = { id: member.id, specName: member.specName, position: member.position };
    if (member.skip !== null) {
      return { ...base, ok: true, skipped: true, message: `skipped — ${member.skip}` };
    }
    try {
      return { ...base, skipped: false, ...(await run(member)) };
    } catch (err) {
      return {
        ...base,
        ok: false,
        skipped: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  let members: GroupMemberResult[];
  if (parallel) {
    members = await Promise.all(plan.members.map(one));
  } else {
    members = [];
    for (const member of plan.members) members.push(await one(member));
  }
  return {
    group: plan.group,
    verb: plan.verb,
    parallel,
    members,
    ok: members.filter((m) => m.ok && !m.skipped).length,
    failed: members.filter((m) => !m.ok).length,
    skipped: members.filter((m) => m.skipped).length,
  };
}
