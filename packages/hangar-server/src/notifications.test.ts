/**
 * HM-183 — the notification rules engine.
 *
 * Everything that decides whether an operator is interrupted is pure, so it
 * is proven here: the default posture (only parked approvals), the group
 * mutes, the quiet-hours split (the in-app badge survives; the OS toast does
 * not), the dedupe, and the normalization that stops a partial PUT from
 * silently disabling a rule it never mentioned.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_RULES,
  type Delivery,
  type HarnessSignal,
  NOTIFICATION_KINDS,
  type NotificationRule,
  createNotificationCentre,
  deriveEvents,
  evaluateNotifications,
  inQuietHours,
  normalizeQuietHours,
  normalizeRules,
} from "./notifications";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

const signal = (over: Partial<HarnessSignal> = {}): HarnessSignal => ({
  harnessId: "hrn_00000000000000a1",
  specName: "fixture",
  groups: [],
  pendingApprovals: 0,
  procState: null,
  evalHealthy: true,
  openIncidents: 0,
  overdueDreams: [],
  recentExits: [],
  budgetUsedRatio: null,
  credentialProbeFailed: false,
  ...over,
});

const allOn: readonly NotificationRule[] = NOTIFICATION_KINDS.map((kind) => ({
  kind,
  enabled: true,
  sinks: ["in-app", "os"],
  mutedGroups: [],
}));

const evaluate = (
  events: ReturnType<typeof deriveEvents>,
  over: Partial<Parameters<typeof evaluateNotifications>[0]> = {},
) =>
  evaluateNotifications({
    rules: allOn,
    quietHours: DEFAULT_QUIET_HOURS,
    mutedGroups: [],
    events,
    nowMs: NOW,
    delivered: new Set<string>(),
    ...over,
  });

describe("default posture", () => {
  test("only parked approvals notify out of the box", () => {
    const on = DEFAULT_RULES.filter((r) => r.enabled).map((r) => r.kind);
    expect(on).toEqual(["approval-parked"]);
    for (const rule of DEFAULT_RULES) expect(rule.sinks).toEqual(["in-app"]);
  });

  test("with defaults, a crash loop is derived but does not deliver", () => {
    const events = deriveEvents([signal({ procState: "crash-looping" })]);
    expect(events.map((e) => e.kind)).toEqual(["crash-looping"]);
    const result = evaluate(events, { rules: DEFAULT_RULES });
    expect(result.deliveries).toEqual([]);
    expect(result.suppressed[0]?.reason).toBe("rule-off");
  });
});

describe("deriveEvents", () => {
  test("every §5 kind is derivable from the snapshot", () => {
    const events = deriveEvents([
      signal({
        pendingApprovals: 2,
        procState: "crash-looping",
        evalHealthy: false,
        openIncidents: 1,
        overdueDreams: ["nightly"],
        budgetUsedRatio: 0.94,
        credentialProbeFailed: true,
        recentExits: [
          { runId: "run_1", exitCode: 30, endedAt: null },
          { runId: "run_2", exitCode: 31, endedAt: null },
          { runId: "run_3", exitCode: 33, endedAt: null },
          { runId: "run_4", exitCode: 0, endedAt: null },
        ],
      }),
    ]);
    expect([...new Set(events.map((e) => e.kind))].sort()).toEqual([...NOTIFICATION_KINDS].sort());
    // Exit 0 is not an event.
    expect(events.filter((e) => e.ref === "run_4")).toEqual([]);
  });

  test("a budget below 80% produces nothing; the key moves by decile", () => {
    expect(deriveEvents([signal({ budgetUsedRatio: 0.79 })])).toEqual([]);
    const at81 = deriveEvents([signal({ budgetUsedRatio: 0.81 })])[0];
    const at89 = deriveEvents([signal({ budgetUsedRatio: 0.89 })])[0];
    const at91 = deriveEvents([signal({ budgetUsedRatio: 0.91 })])[0];
    expect(at81?.key).toBe(at89?.key as string);
    expect(at81?.key).not.toBe(at91?.key as string);
  });
});

describe("evaluateNotifications", () => {
  test("a muted group suppresses with the reason, globally or per rule", () => {
    const events = deriveEvents([signal({ groups: ["demo"], pendingApprovals: 1 })]);
    const global = evaluate(events, { mutedGroups: ["demo"] });
    expect(global.deliveries).toEqual([]);
    expect(global.suppressed[0]?.reason).toBe("group-muted");

    const perRule = evaluate(events, {
      rules: allOn.map((r) => (r.kind === "approval-parked" ? { ...r, mutedGroups: ["demo"] } : r)),
    });
    expect(perRule.deliveries).toEqual([]);

    // A different group is unaffected.
    expect(evaluate(events, { mutedGroups: ["prod"] }).deliveries).toHaveLength(1);
  });

  test("quiet hours drop the OS toast but keep the in-app badge", () => {
    const events = deriveEvents([signal({ pendingApprovals: 1 })]);
    const quiet = evaluate(events, {
      // 12:00Z with a +0 offset falls inside 09:00–17:00.
      quietHours: { enabled: true, startHour: 9, endHour: 17, utcOffsetMinutes: 0 },
    });
    expect(quiet.deliveries[0]?.sinks).toEqual(["in-app"]);

    const loud = evaluate(events, {
      quietHours: { enabled: true, startHour: 22, endHour: 7, utcOffsetMinutes: 0 },
    });
    expect(loud.deliveries[0]?.sinks).toEqual(["in-app", "os"]);
  });

  test("a rule whose only sink is silenced by quiet hours is suppressed with that reason", () => {
    const events = deriveEvents([signal({ pendingApprovals: 1 })]);
    const result = evaluate(events, {
      rules: allOn.map((r) => ({ ...r, sinks: ["os"] as const })),
      quietHours: { enabled: true, startHour: 9, endHour: 17, utcOffsetMinutes: 0 },
    });
    expect(result.deliveries).toEqual([]);
    expect(result.suppressed[0]?.reason).toBe("quiet-hours");
  });

  test("an already-delivered key is suppressed, not re-fired", () => {
    const events = deriveEvents([signal({ pendingApprovals: 1 })]);
    const key = events[0]?.key as string;
    const result = evaluate(events, { delivered: new Set([key]) });
    expect(result.deliveries).toEqual([]);
    expect(result.suppressed[0]?.reason).toBe("already-delivered");
  });
});

describe("inQuietHours", () => {
  test("wrapping windows, non-wrapping windows, offsets, and the degenerate case", () => {
    const at = (iso: string) => Date.parse(iso);
    const wrap = { enabled: true, startHour: 22, endHour: 7, utcOffsetMinutes: 0 };
    expect(inQuietHours(wrap, at("2026-08-03T23:30:00Z"))).toBe(true);
    expect(inQuietHours(wrap, at("2026-08-03T03:00:00Z"))).toBe(true);
    expect(inQuietHours(wrap, at("2026-08-03T12:00:00Z"))).toBe(false);
    const day = { enabled: true, startHour: 9, endHour: 17, utcOffsetMinutes: 0 };
    expect(inQuietHours(day, at("2026-08-03T12:00:00Z"))).toBe(true);
    expect(inQuietHours(day, at("2026-08-03T18:00:00Z"))).toBe(false);
    // +120 minutes moves 21:00Z to 23:00 local, inside the 22→7 window.
    expect(inQuietHours({ ...wrap, utcOffsetMinutes: 120 }, at("2026-08-03T21:00:00Z"))).toBe(true);
    // Equal bounds mean "never quiet", never "always quiet".
    expect(inQuietHours({ ...wrap, startHour: 8, endHour: 8 }, at("2026-08-03T08:30:00Z"))).toBe(
      false,
    );
    expect(inQuietHours({ ...wrap, enabled: false }, at("2026-08-03T23:30:00Z"))).toBe(false);
  });
});

describe("normalizeRules / normalizeQuietHours", () => {
  test("a partial PUT keeps the rules it did not mention", () => {
    const rules = normalizeRules([{ kind: "crash-looping", enabled: true, sinks: ["os"] }]);
    expect(rules).toHaveLength(NOTIFICATION_KINDS.length);
    expect(rules.find((r) => r.kind === "crash-looping")?.enabled).toBe(true);
    // The default-on rule is untouched.
    expect(rules.find((r) => r.kind === "approval-parked")?.enabled).toBe(true);
  });

  test("unknown kinds and unknown sinks are dropped, never stored", () => {
    const rules = normalizeRules([
      { kind: "not-a-kind", enabled: true },
      { kind: "exit-30", enabled: true, sinks: ["os", "carrier-pigeon"] },
    ]);
    expect(rules.some((r) => (r.kind as string) === "not-a-kind")).toBe(false);
    expect(rules.find((r) => r.kind === "exit-30")?.sinks).toEqual(["os"]);
  });

  test("a rule with no usable sink falls back to the in-app badge", () => {
    const rules = normalizeRules([{ kind: "exit-31", enabled: true, sinks: [] }]);
    expect(rules.find((r) => r.kind === "exit-31")?.sinks).toEqual(["in-app"]);
  });

  test("quiet hours clamp to real hours and a plausible offset", () => {
    expect(normalizeQuietHours({ enabled: true, startHour: 99, endHour: -1 })).toEqual({
      enabled: true,
      startHour: DEFAULT_QUIET_HOURS.startHour,
      endHour: DEFAULT_QUIET_HOURS.endHour,
      utcOffsetMinutes: 0,
    });
    expect(normalizeQuietHours({ utcOffsetMinutes: 99_999 }).utcOffsetMinutes).toBe(0);
    expect(normalizeQuietHours("nonsense")).toEqual(DEFAULT_QUIET_HOURS);
  });
});

describe("createNotificationCentre", () => {
  test("fans out to the injected sinks once per key, and the badge caps", () => {
    const os: Delivery[] = [];
    const hooks: Array<{ delivery: Delivery; url: string }> = [];
    const centre = createNotificationCentre({
      os: (d) => os.push(d),
      webhook: (d, url) => hooks.push({ delivery: d, url }),
    });
    const events = deriveEvents([signal({ pendingApprovals: 1 })]);
    const input = {
      rules: allOn.map((r) => ({ ...r, sinks: ["in-app", "os", "webhook"] as const })),
      quietHours: DEFAULT_QUIET_HOURS,
      mutedGroups: [],
      events,
      nowMs: NOW,
    };
    const first = centre.poll(input, "https://hooks.example.test/hangar");
    expect(first.deliveries).toHaveLength(1);
    expect(os).toHaveLength(1);
    expect(hooks[0]?.url).toBe("https://hooks.example.test/hangar");
    expect(centre.inApp()).toHaveLength(1);

    // Same snapshot again: nothing new fires.
    const second = centre.poll(input, "https://hooks.example.test/hangar");
    expect(second.deliveries).toEqual([]);
    expect(os).toHaveLength(1);

    centre.clear();
    expect(centre.inApp()).toEqual([]);
  });

  test("no webhook URL means the webhook sink is simply not called", () => {
    let called = 0;
    const centre = createNotificationCentre({
      webhook: () => {
        called += 1;
      },
    });
    centre.poll(
      {
        rules: allOn.map((r) => ({ ...r, sinks: ["webhook"] as const })),
        quietHours: DEFAULT_QUIET_HOURS,
        mutedGroups: [],
        events: deriveEvents([signal({ pendingApprovals: 1 })]),
        nowMs: NOW,
      },
      null,
    );
    expect(called).toBe(0);
  });
});

describe("GET/PUT /api/notifications", () => {
  test("the route returns the badge, and a PUT round-trips through the settings file", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "notified");
      makeFixtureHarness(dir, {
        specName: "notified",
        approvals: [
          {
            id: "appr_00000000000000a1",
            toolName: "shell",
            input: { cmd: "ls" },
            inputHash: "0".repeat(64),
            runId: "run_00000000000000a1",
            sessionId: "sess_00000000000000aa",
            surface: "cli",
            createdAt: new Date(NOW - 60_000).toISOString(),
          },
        ],
      });
      await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });

      const first = await t.api("/api/notifications");
      expect(first.status).toBe(200);
      expect(first.body["badge"]).toBe(1);
      expect((first.body["delivered"] as Delivery[])[0]?.kind).toBe("approval-parked");

      // A second poll delivers nothing new but the badge persists.
      const second = await t.api("/api/notifications");
      expect(second.body["delivered"]).toEqual([]);
      expect(second.body["badge"]).toBe(1);

      const put = await t.api("/api/notifications", {
        method: "PUT",
        body: JSON.stringify({
          rules: [{ kind: "approval-parked", enabled: false, sinks: ["in-app"] }],
          mutedGroups: ["demo"],
          quietHours: { enabled: true, startHour: 22, endHour: 7, utcOffsetMinutes: 0 },
        }),
      });
      expect(put.status).toBe(200);
      const rules = put.body["rules"] as NotificationRule[];
      expect(rules.find((r) => r.kind === "approval-parked")?.enabled).toBe(false);
      expect(put.body["mutedGroups"]).toEqual(["demo"]);

      const cleared = await t.api("/api/notifications/clear", { method: "POST" });
      expect(cleared.body["badge"]).toBe(0);
      expect(((await t.api("/api/notifications")).body["inApp"] as unknown[]).length).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a webhook URL carrying credentials is refused, not stored and masked", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const bad = await t.api("/api/notifications", {
        method: "PUT",
        body: JSON.stringify({ webhookUrl: "https://user:pw@hooks.example.test/x" }),
      });
      expect(bad.status).toBe(400);
      expect(String(bad.body["error"])).toContain("must not embed credentials");
      expect((await t.api("/api/notifications")).body["webhookUrl"]).toBeNull();

      const wrongScheme = await t.api("/api/notifications", {
        method: "PUT",
        body: JSON.stringify({ webhookUrl: "file:///etc/passwd" }),
      });
      expect(wrongScheme.status).toBe(400);
    } finally {
      await t.stop();
    }
  }, 20_000);
});
