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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_RULES,
  type Delivery,
  type HarnessSignal,
  NOTIFICATION_KINDS,
  type NotificationRule,
  OS_NOTIFICATION_TITLE,
  createNotificationCentre,
  defaultNotificationSinks,
  deriveEvents,
  evaluateNotifications,
  inQuietHours,
  normalizeQuietHours,
  normalizeRules,
  osNotifierArgv,
  webhookPayload,
} from "./notifications";
import { startHangarServer } from "./server";
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

  test("an event no sink could carry is NOT marked delivered, and comes back", () => {
    // The dedupe key is burned for the life of the process, so recording a
    // delivery nothing carried makes that occurrence unreachable forever —
    // on exactly the sinks whose job is reaching an absent operator.
    const centre = createNotificationCentre({}); // no os sink, no webhook sink
    const input = {
      rules: allOn.map((r) => ({ ...r, sinks: ["os", "webhook"] as const })),
      quietHours: DEFAULT_QUIET_HOURS,
      mutedGroups: [],
      events: deriveEvents([signal({ pendingApprovals: 1 })]),
      nowMs: NOW,
    };
    const first = centre.poll(input, "https://hooks.example.test/hangar");
    expect(first.deliveries).toEqual([]);
    expect(first.suppressed.map((s) => s.reason)).toEqual(["sink-unavailable"]);
    expect(centre.inApp()).toEqual([]);

    // Still true on the next poll ⇒ still reported. It was never delivered,
    // so "already-delivered" would be a lie.
    const second = centre.poll(input, "https://hooks.example.test/hangar");
    expect(second.suppressed.map((s) => s.reason)).toEqual(["sink-unavailable"]);
  });

  test("a delivery reports the sinks that ACTUALLY carried it", () => {
    // in-app + os are wired; webhook is wired but has no URL. The delivery
    // is real, so the key IS remembered — but it must not claim a webhook
    // POST that never happened.
    const os: Delivery[] = [];
    const centre = createNotificationCentre({ os: (d) => os.push(d), webhook: () => {} });
    const result = centre.poll(
      {
        rules: allOn.map((r) => ({ ...r, sinks: ["in-app", "os", "webhook"] as const })),
        quietHours: DEFAULT_QUIET_HOURS,
        mutedGroups: [],
        events: deriveEvents([signal({ pendingApprovals: 1 })]),
        nowMs: NOW,
      },
      null,
    );
    expect(result.deliveries[0]?.sinks).toEqual(["in-app", "os"]);
    expect(os[0]?.sinks).toEqual(["in-app", "os"]);
    expect(centre.inApp()[0]?.sinks).toEqual(["in-app", "os"]);
  });

  test("availability names every sink this manager cannot deliver on", () => {
    const none = createNotificationCentre({}).availability(null);
    expect(none.find((s) => s.sink === "in-app")?.available).toBe(true);
    expect(none.find((s) => s.sink === "os")?.available).toBe(false);
    expect(none.find((s) => s.sink === "os")?.reason).toContain("no OS notifier");
    expect(none.find((s) => s.sink === "webhook")?.available).toBe(false);

    const wired = createNotificationCentre({ os: () => {}, webhook: () => {} });
    expect(wired.availability(null).find((s) => s.sink === "webhook")?.reason).toContain(
      "no webhook URL",
    );
    const live = wired.availability("https://hooks.example.test/hangar");
    expect(live.every((s) => s.available)).toBe(true);
    expect(live.every((s) => s.reason === null)).toBe(true);
  });
});

describe("defaultNotificationSinks — the sinks the shipping binary uses", () => {
  const delivery: Delivery = {
    key: "crash-looping:hrn_00000000000000a1:state",
    kind: "crash-looping",
    harnessId: "hrn_00000000000000a1",
    specName: "poly",
    label: 'poly: the "daemon" is crash-looping',
    ref: null,
    sinks: ["os", "webhook"],
    at: new Date(NOW).toISOString(),
  };

  test("the OS notifier is an argv VECTOR whose message is never script source", () => {
    const argv = osNotifierArgv("darwin", OS_NOTIFICATION_TITLE, 'a "quoted" name');
    expect(argv?.[0]).toBe("osascript");
    // The body travels as an argv ITEM the script reads back — so a spec
    // name containing a quote cannot become AppleScript.
    expect(argv).toContain('a "quoted" name');
    expect(argv?.some((part) => part.includes('display notification "'))).toBe(false);
    expect(osNotifierArgv("linux", OS_NOTIFICATION_TITLE, "x")?.[0]).toBe("notify-send");
    // No half-working Windows toast: absent is honest, and `availability`
    // renders it.
    expect(osNotifierArgv("win32", OS_NOTIFICATION_TITLE, "x")).toBeUndefined();
  });

  test("the real sinks spawn the notifier and POST the webhook", async () => {
    const spawned: Array<readonly string[]> = [];
    const posts: Array<{ url: string; body: string }> = [];
    const sinks = defaultNotificationSinks({
      platform: "darwin",
      notify: (argv) => spawned.push(argv),
      post: async (url, body) => {
        posts.push({ url, body });
        return undefined;
      },
    });
    sinks.os?.(delivery);
    sinks.webhook?.(delivery, "https://hooks.example.test/hangar");
    await Promise.resolve();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.[0]).toBe("osascript");
    expect(spawned[0]).toContain(delivery.label);
    expect(posts[0]?.url).toBe("https://hooks.example.test/hangar");
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual(webhookPayload(delivery));
  });

  test("a platform with no notifier declares no os sink at all", () => {
    const sinks = defaultNotificationSinks({ platform: "win32", notify: () => {} });
    expect(sinks.os).toBeUndefined();
    // …and the centre built over them says so rather than silently eating
    // the delivery.
    expect(
      createNotificationCentre(sinks)
        .availability(null)
        .find((s) => s.sink === "os")?.available,
    ).toBe(false);
  });

  test("a failing sink is warned about, never swallowed and never thrown", async () => {
    const warnings: string[] = [];
    const sinks = defaultNotificationSinks({
      platform: "linux",
      onWarn: (m) => warnings.push(m),
      notify: () => {
        throw new Error("notify-send: not installed");
      },
      post: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(() => sinks.os?.(delivery)).not.toThrow();
    expect(() => sinks.webhook?.(delivery, "https://hooks.example.test/hangar")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(warnings.some((w) => w.includes("not installed"))).toBe(true);
    expect(warnings.some((w) => w.includes("ECONNREFUSED"))).toBe(true);
    // The URL is never echoed into the log — a path segment is as good a
    // place to hide a token as a query string.
    expect(warnings.some((w) => w.includes("hooks.example.test"))).toBe(false);
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

  test("a sink the manager cannot deliver on suppresses — and starts working the moment it can", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "webhooked");
      makeFixtureHarness(dir, {
        specName: "webhooked",
        approvals: [
          {
            id: "appr_00000000000000b1",
            toolName: "shell",
            input: { cmd: "ls" },
            inputHash: "0".repeat(64),
            runId: "run_00000000000000b1",
            sessionId: "sess_00000000000000bb",
            surface: "cli",
            createdAt: new Date(NOW - 60_000).toISOString(),
          },
        ],
      });
      await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });

      // Webhook only, and no URL yet: nothing can carry it.
      const configured = await t.api("/api/notifications", {
        method: "PUT",
        body: JSON.stringify({
          rules: [{ kind: "approval-parked", enabled: true, sinks: ["webhook"] }],
        }),
      });
      expect(configured.status).toBe(200);
      expect(configured.body["delivered"]).toEqual([]);
      expect(
        (configured.body["suppressed"] as Array<{ reason: string }>).map((s) => s.reason),
      ).toEqual(["sink-unavailable"]);
      expect(configured.body["badge"]).toBe(0);
      expect(t.sinks?.webhook).toEqual([]);
      // …and the screen can say why.
      const availability = configured.body["sinkAvailability"] as Array<{
        sink: string;
        available: boolean;
        reason: string | null;
      }>;
      expect(availability.find((s) => s.sink === "webhook")).toMatchObject({
        available: false,
        reason: "no webhook URL is configured",
      });

      // Give it a URL: the SAME event now delivers, because it was never
      // marked delivered while nothing could carry it.
      const withUrl = await t.api("/api/notifications", {
        method: "PUT",
        body: JSON.stringify({ webhookUrl: "https://hooks.example.test/hangar" }),
      });
      const delivered = withUrl.body["delivered"] as Array<{ kind: string; sinks: string[] }>;
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.kind).toBe("approval-parked");
      expect(delivered[0]?.sinks).toEqual(["webhook"]);
      expect(t.sinks?.webhook).toHaveLength(1);
      expect(t.sinks?.webhook[0]?.url).toBe("https://hooks.example.test/hangar");
      // Webhook only ⇒ no in-app badge, and the payload says so honestly.
      expect(withUrl.body["badge"]).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the shipping composition wires real sinks — omitting them is not `{}`", async () => {
    // The defect this replaced: `crewhaus hangar` passed no sinks, so `os`
    // and `webhook` were permanent no-ops in the only build anyone runs.
    // Booted here the way the CLI boots it: no `notificationSinks` at all.
    const workspace = mkdtempSync(join(tmpdir(), "hangar-sinks-"));
    const server = startHangarServer({
      port: 0,
      root: join(workspace, "hangar"),
      registryRoot: join(workspace, "registry"),
      env: { CREWHAUS_WATCHME_ROOT: join(workspace, "watchme") },
      now: () => NOW,
      onWarn: () => {},
    });
    try {
      const res = await fetch(`${server.url}/api/notifications`, {
        headers: { authorization: `Bearer ${server.token ?? ""}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const availability = body["sinkAvailability"] as Array<{ sink: string; reason: string }>;
      // A `{}` sink set would say "built with no webhook sink"; the real one
      // is present and only wants a URL.
      expect(availability.find((s) => s.sink === "webhook")?.reason).toBe(
        "no webhook URL is configured",
      );
    } finally {
      await server.stop();
      rmSync(workspace, { recursive: true, force: true });
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
