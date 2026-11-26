/**
 * Every act adds one line, and every line is one event of its own type: the item's ref, who
 * acted and closed codes, with no text, no note and no name; a line that is not one is no
 * event.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ATTENTION_ACTION_EVENTS,
  type AttentionItem,
  attIdFromDigest,
  attentionRef,
  mintId,
} from "@crewhaus/control-contract";
import { eventEnvelope } from "@crewhaus/control-contract/schemas";
import { attentionActionsLedger, readPage } from "@crewhaus/control-records";
import { type DecisionActor, createDecisions } from "@crewhaus/control-service";
import {
  DAY,
  HOUR,
  MIN,
  NOW,
  harnessDir,
  iso,
  park,
  run,
  tempRoot,
  testFacts,
  withMembers,
} from "./__test__/fleet";
import {
  type ActAnswer,
  type ActDeps,
  acknowledgeItem,
  addMessage,
  assignItem,
  deferItem,
  dismissItem,
  reopenItem,
  resolveItem,
  snoozeItem,
  unassignItem,
  undeferItem,
} from "./act";
import { attentionEventOf } from "./events";
import { assembleInbox, foldHarness } from "./fold";
import type { AdvisorSnapshot } from "./types";

const HRN = "hrn_0123456789abcdef";
const OWNER = mintId("prn");
const OTHER = mintId("prn");
const PLANT = "a refund for jane";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const SNAPSHOT: AdvisorSnapshot = {
  at: iso(NOW - MIN),
  items: [
    {
      id: "evals-none",
      severity: "suggestion",
      screen: "evals",
      source: "evals",
      action: null,
      status: "open",
    } as never,
  ],
};

describe("attention.* events", () => {
  test("each act adds exactly one event of its type, carrying the ref and no harness text", async () => {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    const dir = harnessDir(t.root, "events");
    const hangarRoot = join(t.root, "hangar");
    mkdirSync(hangarRoot, { recursive: true });
    const m = await withMembers(hangarRoot, { id: HRN, dir });
    const deps: ActDeps = {
      decisions: createDecisions({
        hangarRoot,
        identity: { username: "sam", hostname: "laptop" },
        now: () => NOW,
      }),
      now: () => NOW,
      members: { hangarRoot, harness: { id: HRN, dir, groups: [] } },
      reviewWriter: async () => ({ outcome: "resolved" }),
    };
    await park(dir, { tool: "Bash", input: { command: PLANT } });
    run(dir, { at: NOW - HOUR, state: "failed", failureClass: "tool_error" });
    const item = (kind: string): AttentionItem => {
      const found = assembleInbox(
        [foldHarness(dir, testFacts({}, new Map([[dir, SNAPSHOT]])), NOW, { harness: HRN })],
        NOW,
        { state: "all" },
      ).items.find((i) => i.kind === kind);
      if (found === undefined) throw new Error(`no ${kind}`);
      return found;
    };
    const actor: DecisionActor = { kind: "principal", principal: m.owner, display: PLANT };
    const on = (kind: string) => ({ dir, item: item(kind), actor, via: "home" as const });
    const events = () =>
      readPage(attentionActionsLedger(dir), { limit: 100 })
        .items.map((i) => attentionEventOf(i.record))
        .reverse();
    const acts: ReadonlyArray<readonly [string, string, () => Promise<ActAnswer>]> = [
      ["assigned", "permission", () => assignItem({ ...on("permission"), to: m.operator }, deps)],
      ["unassigned", "permission", () => unassignItem(on("permission"), deps)],
      ["message", "permission", () => addMessage({ ...on("permission"), text: PLANT }, deps)],
      [
        "snoozed",
        "permission",
        () => snoozeItem({ ...on("permission"), until: iso(NOW + DAY) }, deps),
      ],
      [
        "deferred",
        "run-failures",
        () =>
          deferItem(
            { ...on("run-failures"), until: iso(NOW + DAY), reason: "awaiting-someone" },
            deps,
          ),
      ],
      ["undeferred", "run-failures", () => undeferItem(on("run-failures"), deps)],
      [
        "dismissed",
        "setup",
        () => dismissItem({ ...on("setup"), reasonCode: "known", note: PLANT }, deps),
      ],
      ["reopened", "setup", () => reopenItem({ ...on("setup"), note: PLANT }, deps)],
      ["acknowledged", "setup", () => acknowledgeItem({ ...on("setup"), note: PLANT }, deps)],
      ["resolved", "permission", () => resolveItem({ ...on("permission"), choice: "deny" }, deps)],
    ];
    const seen: string[] = [];
    for (const [event, kind, act] of acts) {
      const ref = item(kind).ref;
      const before = events().length;
      const answer = await act();
      expect(`${event}: ${answer.ok}`).toBe(`${event}: true`);
      const now = events();
      expect(now).toHaveLength(before + 1);
      const last = now.at(-1);
      expect(last).toMatchObject({
        type: `attention.${event}`,
        attention: ref,
        actor: m.owner,
        at: iso(NOW),
      });
      seen.push(event);
    }
    // Every event an act may be is driven here.
    expect(seen.sort()).toEqual([...ATTENTION_ACTION_EVENTS].sort());
    const all = JSON.stringify(events());
    for (const text of [PLANT, "jane", "refund", "Bash", "sam", "laptop", m.operator]) {
      expect(`${text}: ${all.includes(text)}`).toBe(`${text}: false`);
    }
    for (const event of events()) {
      const envelope = {
        v: 1,
        id: "0".repeat(8),
        ...event,
        ingestedAt: event?.at,
        harness: HRN,
      };
      const parsed = eventEnvelope.safeParse(envelope);
      const others = parsed.success ? [] : parsed.error.issues.filter((i) => i.path[0] !== "id");
      expect(others).toEqual([]);
    }
  });

  test("a line that is not one is no event, and what is not a code is left out of one that is", () => {
    const id = attIdFromDigest(new Uint8Array(32).fill(9));
    const line = {
      v: 1,
      id,
      event: "dismissed",
      state: "resolved",
      at: iso(NOW),
      by: OWNER,
      via: "home",
      evidenceRev: "0123456789abcdef",
      how: "dismissed",
      reasonCode: "known",
    };
    expect(attentionEventOf(line)).toEqual({
      type: "attention.dismissed",
      at: iso(NOW),
      attention: attentionRef(id),
      actor: OWNER,
      sensitivity: "internal",
      payload: { state: "resolved", how: "dismissed", reasonCode: "known" },
    });
    for (const over of [
      { id: "att_x" },
      { event: PLANT },
      { state: PLANT },
      { by: "local:sam@laptop" },
      { at: PLANT },
    ]) {
      expect(attentionEventOf({ ...line, ...over })).toBeUndefined();
    }
    const planted = attentionEventOf({
      ...line,
      how: PLANT,
      choice: PLANT,
      reasonCode: PLANT,
      until: `${iso(NOW)} (${PLANT})`,
      note: PLANT,
      to: OTHER,
    });
    expect(planted?.payload).toEqual({ state: "resolved" });
    expect(attentionEventOf({ ...line, event: "snoozed" })?.sensitivity).toBe("restricted");
  });
});
