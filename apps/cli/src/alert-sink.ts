/**
 * Item 31 — construct the `AlertSink` the alert watchdog uses for durable +
 * off-box delivery of a threshold breach. Two channels, both best-effort:
 *   - `appendAudit`   → a tamper-evident `alert_raised` record on the
 *                       hash-chained audit log (so the alert history itself is
 *                       auditable);
 *   - `fireAlertHook` → the settings.json `alert` hook (HOOK_EVENTS gained
 *                       `"alert"` additively) AND/OR an `alerts.webhook` POST.
 *
 * Side-effect-free + injected (audit log, hook runner, hook list, fetch) so
 * this entry file (which runs an argv switch on import) stays testable and no
 * network/audit I/O happens at import time. `crewhaus run` wires the real
 * `openAuditLog`, `loadHooks`+`runHooks`, and `globalThis.fetch`.
 */
import type { AlertBreachPayload, AlertSink } from "@crewhaus/runtime-core";

/** Minimal audit seam — structurally satisfied by `@crewhaus/audit-log`. */
export type AlertAuditSink = {
  append(input: {
    readonly kind: "alert_raised";
    readonly payload: unknown;
  }): Promise<unknown>;
};

/** Minimal hook seam — structurally satisfied by `hooks-engine`'s `runHooks`. */
export type AlertHookRunner = (
  event: "alert",
  payload: unknown,
  matcherKey: string,
) => Promise<void>;

export type BuildAlertSinkOptions = {
  /** Durable audit log (undefined ⇒ no audit channel). */
  readonly audit?: AlertAuditSink;
  /** Runs settings.json `alert` hooks (undefined ⇒ no hook channel). */
  readonly runAlertHooks?: AlertHookRunner;
  /** Webhook URL to POST the breach JSON to (undefined ⇒ no webhook channel). */
  readonly webhookUrl?: string;
  /** Injected fetch (defaults to global fetch) for the webhook POST. */
  readonly fetchImpl?: typeof fetch;
  /** Warn sink for best-effort delivery failures (defaults to stderr). */
  readonly warn?: (line: string) => void;
};

/**
 * Build the `AlertSink`, or `undefined` when NO channel is configured (so the
 * caller spreads nothing into `runChatLoop` and the watchdog keeps only its
 * trace-event + snapshot behaviour). Every channel is best-effort: a failure
 * is warned, never thrown — an alert-delivery hiccup must not fail a run.
 */
export function buildAlertSink(opts: BuildAlertSinkOptions): AlertSink | undefined {
  const hasAudit = opts.audit !== undefined;
  const hasHooks = opts.runAlertHooks !== undefined;
  const hasWebhook = typeof opts.webhookUrl === "string" && opts.webhookUrl !== "";
  if (!hasAudit && !hasHooks && !hasWebhook) return undefined;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  const sink: AlertSink = {};
  if (hasAudit) {
    sink.appendAudit = async (breach: AlertBreachPayload): Promise<void> => {
      await opts.audit?.append({ kind: "alert_raised", payload: breach });
    };
  }
  if (hasHooks || hasWebhook) {
    sink.fireAlertHook = async (breach: AlertBreachPayload): Promise<void> => {
      // Match the hook by the breached metric name so a settings.json hook can
      // target `matcher: "cost_burn_usd_per_min"`, etc.
      if (hasHooks) {
        try {
          await opts.runAlertHooks?.("alert", breach, "metric");
        } catch (err) {
          warn(`[alert] hook failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (hasWebhook && opts.webhookUrl !== undefined) {
        // F5 — warn (never block) on a non-https scheme, mirroring
        // security-digest.ts's notifySecurityDigest: an alert breach payload
        // carries session/metric/threshold detail, and posting it cleartext
        // leaks it to every on-path observer. Advisory only — the webhook
        // still POSTs; a local tunnel/dev receiver is a legitimate use case.
        if (isNonHttpsUrl(opts.webhookUrl)) {
          warn(
            `[alert] webhook ${opts.webhookUrl} uses plain http — the breach payload will transit unencrypted; prefer an https webhook`,
          );
        }
        const doFetch = opts.fetchImpl ?? fetch;
        try {
          const res = await doFetch(opts.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(breach),
          });
          if (!res.ok) warn(`[alert] webhook POST returned ${res.status}`);
        } catch (err) {
          warn(`[alert] webhook POST failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
  }
  return sink;
}

/**
 * F5 — true when `url` parses and its scheme is anything other than
 * `https:` (notably plain `http:`). An unparseable URL returns `false` here
 * — the webhook POST itself will surface that failure via its own
 * try/catch, so this check only ever adds the scheme warning, never a new
 * failure mode.
 */
function isNonHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol !== "https:";
  } catch {
    return false;
  }
}

/**
 * Read the optional `alerts` block from a parsed settings.json root. Only the
 * `webhook` string is consumed today; unknown keys are ignored (additive).
 */
export function alertWebhookFromSettings(settingsRoot: unknown): string | undefined {
  if (typeof settingsRoot !== "object" || settingsRoot === null) return undefined;
  const alerts = (settingsRoot as { alerts?: unknown }).alerts;
  if (typeof alerts !== "object" || alerts === null) return undefined;
  const webhook = (alerts as { webhook?: unknown }).webhook;
  return typeof webhook === "string" && webhook !== "" ? webhook : undefined;
}
