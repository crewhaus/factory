/**
 * Item 31 — alert-sink builder tests: audit append, settings.json alert hook
 * dispatch, webhook POST (best-effort), and settings parsing. All I/O is
 * injected — no real audit log / network. Webhook URLs are BUILT AT RUNTIME
 * from parts so no credential-shaped literal appears in source.
 */
import { describe, expect, test } from "bun:test";
import type { AlertBreachPayload } from "@crewhaus/runtime-core";
import { alertWebhookFromSettings, buildAlertSink } from "./alert-sink";

function breach(metric = "turn_p95_seconds"): AlertBreachPayload {
  return {
    sessionId: "sess_x",
    metric,
    observed: 30,
    threshold: 5,
    baselineSessions: 6,
    detail: `${metric} exceeded`,
  };
}

// A webhook host built at runtime so no URL-with-token literal is in source.
const WEBHOOK_URL = ["https://hooks.example.test", "services", "T000", "B000"].join("/");
// Plain-http variant, likewise built at runtime, for the F5 scheme-warning tests.
const HTTP_WEBHOOK_URL = ["http://hooks.example.test", "services", "T000", "B000"].join("/");

describe("buildAlertSink", () => {
  test("no channels configured ⇒ undefined (nothing to wire)", () => {
    expect(buildAlertSink({})).toBeUndefined();
  });

  test("audit channel appends an alert_raised record", async () => {
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const sink = buildAlertSink({
      audit: {
        append: async (input) => {
          appended.push(input);
        },
      },
    });
    expect(sink?.appendAudit).toBeDefined();
    expect(sink?.fireAlertHook).toBeUndefined();
    await sink?.appendAudit?.(breach());
    expect(appended).toHaveLength(1);
    expect(appended[0]?.kind).toBe("alert_raised");
    expect((appended[0]?.payload as AlertBreachPayload).metric).toBe("turn_p95_seconds");
  });

  test("hook channel dispatches the alert event keyed on the metric", async () => {
    const calls: Array<{ event: string; matcherKey: string; payload: unknown }> = [];
    const sink = buildAlertSink({
      runAlertHooks: async (event, payload, matcherKey) => {
        calls.push({ event, matcherKey, payload });
      },
    });
    await sink?.fireAlertHook?.(breach("cost_burn_usd_per_min"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("alert");
    expect(calls[0]?.matcherKey).toBe("metric");
  });

  test("webhook channel POSTs the breach JSON", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const sink = buildAlertSink({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: (async (url: string, init?: { body?: string }) => {
        seen.push({ url, body: init?.body !== undefined ? JSON.parse(init.body) : undefined });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await sink?.fireAlertHook?.(breach());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(WEBHOOK_URL);
    expect((seen[0]?.body as AlertBreachPayload).metric).toBe("turn_p95_seconds");
  });

  test("a non-2xx webhook warns but does not throw", async () => {
    const warnings: string[] = [];
    const sink = buildAlertSink({
      webhookUrl: WEBHOOK_URL,
      warn: (l) => warnings.push(l),
      fetchImpl: (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch,
    });
    await sink?.fireAlertHook?.(breach()); // resolves
    expect(warnings.some((w) => w.includes("500"))).toBe(true);
  });

  test("a throwing hook is warned, and the webhook still fires", async () => {
    const warnings: string[] = [];
    let webhookFired = false;
    const sink = buildAlertSink({
      runAlertHooks: async () => {
        throw new Error("hook exploded");
      },
      webhookUrl: WEBHOOK_URL,
      warn: (l) => warnings.push(l),
      fetchImpl: (async () => {
        webhookFired = true;
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await sink?.fireAlertHook?.(breach());
    expect(warnings.some((w) => w.includes("hook failed"))).toBe(true);
    expect(webhookFired).toBe(true);
  });

  // F5 — a non-https webhook scheme is advisory (warn, still POST), mirroring
  // security-digest.ts's notifySecurityDigest http warning.
  test("http webhook warns on stderr (advisory) but still POSTs", async () => {
    const warnings: string[] = [];
    const seen: Array<{ url: string }> = [];
    const sink = buildAlertSink({
      webhookUrl: HTTP_WEBHOOK_URL,
      warn: (l) => warnings.push(l),
      fetchImpl: (async (url: string) => {
        seen.push({ url });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });
    await sink?.fireAlertHook?.(breach());
    expect(warnings.some((w) => w.includes("plain http"))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(HTTP_WEBHOOK_URL);
  });

  test("https webhook is silent on scheme (no warning)", async () => {
    const warnings: string[] = [];
    const sink = buildAlertSink({
      webhookUrl: WEBHOOK_URL,
      warn: (l) => warnings.push(l),
      fetchImpl: (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch,
    });
    await sink?.fireAlertHook?.(breach());
    expect(warnings.some((w) => w.includes("plain http"))).toBe(false);
  });
});

describe("alertWebhookFromSettings", () => {
  test("reads alerts.webhook", () => {
    expect(alertWebhookFromSettings({ alerts: { webhook: WEBHOOK_URL } })).toBe(WEBHOOK_URL);
  });
  test("missing / malformed ⇒ undefined", () => {
    expect(alertWebhookFromSettings(undefined)).toBeUndefined();
    expect(alertWebhookFromSettings({})).toBeUndefined();
    expect(alertWebhookFromSettings({ alerts: {} })).toBeUndefined();
    expect(alertWebhookFromSettings({ alerts: { webhook: "" } })).toBeUndefined();
    expect(alertWebhookFromSettings({ alerts: { webhook: 42 } })).toBeUndefined();
  });
});
