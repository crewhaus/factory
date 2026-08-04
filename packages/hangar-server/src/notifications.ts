/**
 * HM-183 — the notification rules engine.
 *
 * Rules over the event kinds §5 names, with three sinks (in-app badge/toast,
 * an OS notification, a webhook), per-group muting and quiet hours. The
 * whole decision layer is PURE: `deriveEvents` turns a fleet snapshot into
 * events, `evaluateNotifications` turns events + rules + clock into
 * deliveries, and only the injected sinks in `createNotificationCentre`
 * touch the world.
 *
 * DEFAULT OFF, WITH ONE EXCEPTION. Every rule ships disabled except
 * `approval-parked`, because that is the only kind where nothing else in the
 * product will ever tell you: an approval sits until a human settles it, and
 * a harness parked overnight is a harness doing nothing. Everything else —
 * a crash loop, a failed eval gate, a budget line — is visible on a screen
 * the operator already opens, so making it interrupt them by default would
 * be the product deciding what deserves attention. They opt in.
 *
 * NO TIMER, NO BOOT COST. Evaluation runs when the console asks for the
 * notification state (the same poll that draws the badge), so the manager
 * has no background loop and boot does no work. The consequence — stated
 * because it is a real one — is that deliveries are computed from the
 * snapshot at poll time, so a condition that appears and clears between two
 * polls is never delivered. That is the honest trade for a manager with no
 * daemon of its own.
 *
 * DEDUPE IS IN MEMORY, ON PURPOSE. A delivery key (`kind:harness:ref`) fires
 * once per manager process. Restarting the manager re-notifies whatever is
 * still true, which is right: after a restart the operator has not seen
 * anything, and a persisted "already told you" would silently swallow the
 * first badge of the session.
 *
 * A SINK THAT DID NOT RUN IS NOT A DELIVERY. The dedupe key is burned for
 * the life of the process, so marking an event delivered when nothing
 * carried it means the operator can never be told about that occurrence
 * again — the worst possible outcome for the two sinks whose whole job is
 * reaching someone who is NOT looking at the console. `poll` therefore fans
 * out first, reports the sinks that ACTUALLY took the delivery, and only
 * remembers the key when at least one did; an event no sink could carry
 * comes back as `suppressed: sink-unavailable`, every poll, until it can.
 */
import { spawn } from "node:child_process";

/** The event kinds rules can fire on (§5 HM-183's list, verbatim). */
export const NOTIFICATION_KINDS = [
  "approval-parked",
  "exit-30",
  "exit-31",
  "exit-33",
  "eval-gate-failed",
  "incident-opened",
  "dream-overdue",
  "budget-80",
  "crash-looping",
  "credential-probe-failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SINKS = ["in-app", "os", "webhook"] as const;
export type NotificationSink = (typeof NOTIFICATION_SINKS)[number];

/** Human labels — the console renders these rather than the slugs. */
export const KIND_LABELS: Readonly<Record<NotificationKind, string>> = {
  "approval-parked": "an approval is parked on a human",
  "exit-30": "a run exited 30 (policy refusal)",
  "exit-31": "a run exited 31 (provider funding)",
  "exit-33": "a run exited 33 (unrecoverable config)",
  "eval-gate-failed": "an eval gate failed against its baseline",
  "incident-opened": "an incident was opened",
  "dream-overdue": "a dream is overdue by more than two windows",
  "budget-80": "spend passed 80% of the declared budget",
  "crash-looping": "a daemon is crash-looping",
  "credential-probe-failed": "a credential probe failed",
};

export type NotificationRule = {
  readonly kind: NotificationKind;
  readonly enabled: boolean;
  readonly sinks: readonly NotificationSink[];
  /** Groups this rule ignores (in addition to the global muted list). */
  readonly mutedGroups: readonly string[];
};

export type QuietHours = {
  readonly enabled: boolean;
  /** Local hour the quiet window opens (0–23). */
  readonly startHour: number;
  /** Local hour it closes (0–23). Wrapping windows (22 → 7) are the norm. */
  readonly endHour: number;
  /** Minutes to add to UTC to get the operator's local time. Explicit so the
   *  server never guesses at a timezone it cannot know. */
  readonly utcOffsetMinutes: number;
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startHour: 22,
  endHour: 7,
  utcOffsetMinutes: 0,
};

/** Every kind, disabled, except parked approvals (in-app only). */
export const DEFAULT_RULES: readonly NotificationRule[] = NOTIFICATION_KINDS.map((kind) => ({
  kind,
  enabled: kind === "approval-parked",
  sinks: ["in-app"] as readonly NotificationSink[],
  mutedGroups: [],
}));

// ---------------------------------------------------------------------------
// Normalization (settings arrive from an HTTP body)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isKind = (v: unknown): v is NotificationKind =>
  typeof v === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(v);

const isSink = (v: unknown): v is NotificationSink =>
  typeof v === "string" && (NOTIFICATION_SINKS as readonly string[]).includes(v);

/**
 * Coerce whatever arrived into exactly one rule per known kind, in the
 * canonical order. Unknown kinds are DROPPED (a rule for an event this
 * build never emits is a rule that silently never fires) and missing kinds
 * fall back to their default, so a client that PUTs a partial list cannot
 * accidentally disable a rule it did not mention.
 */
export function normalizeRules(raw: unknown): readonly NotificationRule[] {
  const byKind = new Map<NotificationKind, NotificationRule>();
  for (const rule of DEFAULT_RULES) byKind.set(rule.kind, rule);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || !isKind(item["kind"])) continue;
      const sinks: NotificationSink[] = Array.isArray(item["sinks"])
        ? item["sinks"].filter(isSink)
        : ["in-app"];
      const mutedGroups = Array.isArray(item["mutedGroups"])
        ? item["mutedGroups"].filter((g): g is string => typeof g === "string")
        : [];
      byKind.set(item["kind"], {
        kind: item["kind"],
        enabled: item["enabled"] === true,
        // A rule with no sink is a rule that cannot notify; keep it honest by
        // falling back to the in-app badge rather than firing into nothing.
        sinks: sinks.length > 0 ? sinks : ["in-app"],
        mutedGroups,
      });
    }
  }
  return NOTIFICATION_KINDS.map((kind) => byKind.get(kind) as NotificationRule);
}

const hour = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;

export function normalizeQuietHours(raw: unknown): QuietHours {
  if (!isRecord(raw)) return DEFAULT_QUIET_HOURS;
  const offset = raw["utcOffsetMinutes"];
  return {
    enabled: raw["enabled"] === true,
    startHour: hour(raw["startHour"], DEFAULT_QUIET_HOURS.startHour),
    endHour: hour(raw["endHour"], DEFAULT_QUIET_HOURS.endHour),
    utcOffsetMinutes:
      typeof offset === "number" && Number.isFinite(offset) && Math.abs(offset) <= 14 * 60
        ? Math.trunc(offset)
        : 0,
  };
}

/**
 * True when `nowMs` falls inside the quiet window. Wrapping windows
 * (22 → 7) are the common case, so the comparison is written for them; a
 * window whose bounds are equal is treated as "never quiet" rather than
 * "always quiet", because the second reading turns a mis-set field into
 * silence nobody can explain.
 */
export function inQuietHours(q: QuietHours, nowMs: number): boolean {
  if (!q.enabled) return false;
  if (q.startHour === q.endHour) return false;
  const local = new Date(nowMs + q.utcOffsetMinutes * 60_000);
  const h = local.getUTCHours();
  return q.startHour < q.endHour
    ? h >= q.startHour && h < q.endHour
    : h >= q.startHour || h < q.endHour;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One harness's notifiable signals, as the server already knows them. Every
 * field is something another panel computes — no new reads exist for
 * notifications.
 */
export type HarnessSignal = {
  readonly harnessId: string;
  readonly specName: string;
  readonly groups: readonly string[];
  /** Pending approvals (the approvals fold's count). */
  readonly pendingApprovals: number;
  /** Supervision state, or null when unsupervised. */
  readonly procState: string | null;
  /** `evalHealth().healthy`, or null when unread. */
  readonly evalHealthy: boolean | null;
  readonly openIncidents: number;
  /** Dream specs overdue by more than two windows. */
  readonly overdueDreams: readonly string[];
  /** Recent terminal exits from the run ledger. */
  readonly recentExits: ReadonlyArray<{
    readonly runId: string;
    readonly exitCode: number;
    readonly endedAt: string | null;
  }>;
  /** Spend ÷ declared budget, or null when no budget is declared. */
  readonly budgetUsedRatio: number | null;
  /** True when preflight found a blocking item in the credentials area. */
  readonly credentialProbeFailed: boolean;
};

export type NotificationEvent = {
  readonly kind: NotificationKind;
  readonly harnessId: string;
  readonly specName: string;
  readonly groups: readonly string[];
  /** Stable per-occurrence key — the dedupe unit. */
  readonly key: string;
  readonly label: string;
  /** Pointer for the deep link (`appr_…`, `run_…`, a dream spec name). */
  readonly ref: string | null;
};

/** Exit codes that are their own event kind (§5's 30/31/33). */
const NOTIFIED_EXITS: Readonly<Record<number, NotificationKind>> = {
  30: "exit-30",
  31: "exit-31",
  33: "exit-33",
};

/** Turn a fleet snapshot into events. Pure; order is stable. */
export function deriveEvents(signals: readonly HarnessSignal[]): readonly NotificationEvent[] {
  const events: NotificationEvent[] = [];
  const push = (
    s: HarnessSignal,
    kind: NotificationKind,
    keySuffix: string,
    label: string,
    ref: string | null,
  ): void => {
    events.push({
      kind,
      harnessId: s.harnessId,
      specName: s.specName,
      groups: s.groups,
      key: `${kind}:${s.harnessId}:${keySuffix}`,
      label,
      ref,
    });
  };

  for (const s of signals) {
    if (s.pendingApprovals > 0) {
      // Keyed on the COUNT, not on an approval id: the inbox is the screen,
      // and one badge per harness per level is the useful granularity.
      push(
        s,
        "approval-parked",
        String(s.pendingApprovals),
        `${s.specName}: ${s.pendingApprovals} approval${s.pendingApprovals === 1 ? "" : "s"} parked`,
        null,
      );
    }
    for (const exit of s.recentExits) {
      const kind = NOTIFIED_EXITS[exit.exitCode];
      if (kind === undefined) continue;
      push(s, kind, exit.runId, `${s.specName}: run exited ${exit.exitCode}`, exit.runId);
    }
    if (s.evalHealthy === false) {
      push(s, "eval-gate-failed", "latest", `${s.specName}: eval gate failed`, null);
    }
    if (s.openIncidents > 0) {
      push(
        s,
        "incident-opened",
        String(s.openIncidents),
        `${s.specName}: ${s.openIncidents} open incident${s.openIncidents === 1 ? "" : "s"}`,
        null,
      );
    }
    for (const specName of s.overdueDreams) {
      push(s, "dream-overdue", specName, `${s.specName}: dream "${specName}" is overdue`, specName);
    }
    if (s.budgetUsedRatio !== null && s.budgetUsedRatio >= 0.8) {
      const pct = Math.round(s.budgetUsedRatio * 100);
      // Keyed by decile so a budget creeping from 81% to 89% does not
      // re-notify on every poll, but crossing 90% does.
      push(
        s,
        "budget-80",
        `d${Math.floor(pct / 10)}`,
        `${s.specName}: ${pct}% of the declared budget spent`,
        null,
      );
    }
    if (s.procState === "crash-looping") {
      push(s, "crash-looping", "state", `${s.specName}: the daemon is crash-looping`, null);
    }
    if (s.credentialProbeFailed) {
      push(
        s,
        "credential-probe-failed",
        "preflight",
        `${s.specName}: a credential probe failed preflight`,
        null,
      );
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type Delivery = {
  readonly key: string;
  readonly kind: NotificationKind;
  readonly harnessId: string;
  readonly specName: string;
  readonly label: string;
  readonly ref: string | null;
  readonly sinks: readonly NotificationSink[];
  readonly at: string;
};

export type SuppressedEvent = {
  readonly key: string;
  readonly kind: NotificationKind;
  readonly harnessId: string;
  /** Why it did not notify — rendered in the rules screen so a silent rule
   *  can always be explained without reading this file.
   *
   *  `sink-unavailable` means the rule's sinks all exist but none could
   *  carry this delivery on this manager (no webhook URL configured, or no
   *  OS notifier on this platform). It is NOT deduped: the event returns on
   *  every poll until a sink can take it. */
  readonly reason:
    | "rule-off"
    | "group-muted"
    | "quiet-hours"
    | "already-delivered"
    | "sink-unavailable";
};

export type EvaluateInput = {
  readonly rules: readonly NotificationRule[];
  readonly quietHours: QuietHours;
  readonly mutedGroups: readonly string[];
  readonly events: readonly NotificationEvent[];
  readonly nowMs: number;
  /** Keys already delivered by this manager process. */
  readonly delivered: ReadonlySet<string>;
};

export type EvaluateResult = {
  readonly deliveries: readonly Delivery[];
  readonly suppressed: readonly SuppressedEvent[];
};

/**
 * Decide what notifies. Quiet hours suppress the OS and webhook sinks but
 * NOT the in-app badge — the badge is a number on a screen the operator has
 * to be looking at anyway, and suppressing it would mean waking up to a
 * console that says everything is fine.
 */
export function evaluateNotifications(input: EvaluateInput): EvaluateResult {
  const byKind = new Map(input.rules.map((r) => [r.kind, r]));
  const globallyMuted = new Set(input.mutedGroups);
  const quiet = inQuietHours(input.quietHours, input.nowMs);
  const at = new Date(input.nowMs).toISOString();
  const deliveries: Delivery[] = [];
  const suppressed: SuppressedEvent[] = [];
  const note = (e: NotificationEvent, reason: SuppressedEvent["reason"]): void => {
    suppressed.push({ key: e.key, kind: e.kind, harnessId: e.harnessId, reason });
  };

  for (const event of input.events) {
    const rule = byKind.get(event.kind);
    if (rule === undefined || !rule.enabled) {
      note(event, "rule-off");
      continue;
    }
    const muted = event.groups.some((g) => globallyMuted.has(g) || rule.mutedGroups.includes(g));
    if (muted) {
      note(event, "group-muted");
      continue;
    }
    if (input.delivered.has(event.key)) {
      note(event, "already-delivered");
      continue;
    }
    const sinks = quiet ? rule.sinks.filter((s) => s === "in-app") : rule.sinks;
    if (sinks.length === 0) {
      note(event, "quiet-hours");
      continue;
    }
    deliveries.push({
      key: event.key,
      kind: event.kind,
      harnessId: event.harnessId,
      specName: event.specName,
      label: event.label,
      ref: event.ref,
      sinks,
      at,
    });
  }
  return { deliveries, suppressed };
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

export type NotificationSinks = {
  /** Post one delivery to the OS notification centre. Absent when this
   *  platform has no notifier this manager knows how to drive. */
  readonly os?: (delivery: Delivery) => void;
  /** POST one delivery to the configured webhook. */
  readonly webhook?: (delivery: Delivery, url: string) => void;
};

/** What the console shows beside a sink checkbox: whether this manager can
 *  actually deliver on it, and — when it cannot — why. A capability that is
 *  declared but not usable has to be visible, or the operator configures an
 *  alert that silently never arrives. */
export type SinkAvailability = {
  readonly sink: NotificationSink;
  readonly available: boolean;
  /** Null when available; otherwise the reason, in the operator's words. */
  readonly reason: string | null;
};

/** Title on the OS toast. Fixed — it is the product, not the event. */
export const OS_NOTIFICATION_TITLE = "CrewHaus Hangar";

/** How long a webhook POST is given before it is abandoned. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/** Longest label an OS toast carries; the console holds the full text. */
const OS_BODY_MAX = 240;

/** One line, no control characters — a toast body is not a log line, and a
 *  notifier argument is not a place to smuggle an escape sequence. */
export function toastBody(delivery: Delivery): string {
  const flat = [...delivery.label]
    .map((ch) => (ch < " " || ch === "\u007f" ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > OS_BODY_MAX ? `${flat.slice(0, OS_BODY_MAX - 1)}…` : flat;
}

/**
 * The argv vector that raises one OS notification, or undefined when this
 * platform has no notifier this manager knows how to drive.
 *
 * NEVER a shell string, and on macOS never string-interpolated into the
 * AppleScript either: the body travels as an `argv` ITEM the script reads
 * back, so a spec name containing a quote (or anything else) cannot become
 * script source. Windows is deliberately absent — the PowerShell toast APIs
 * differ by OS build, and a notifier that works on one machine and silently
 * does nothing on another is worse than saying "not on this platform".
 */
export function osNotifierArgv(
  platform: string,
  title: string,
  body: string,
): readonly string[] | undefined {
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e",
      "end run",
      body,
      title,
    ];
  }
  if (platform === "linux") return ["notify-send", "--app-name=crewhaus", title, body];
  return undefined;
}

/** The JSON body one webhook delivery POSTs. Never carries the manager's
 *  token, the harness env, or anything the console masks. */
export function webhookPayload(delivery: Delivery): Record<string, unknown> {
  return {
    source: "crewhaus-hangar",
    kind: delivery.kind,
    label: delivery.label,
    harnessId: delivery.harnessId,
    specName: delivery.specName,
    ref: delivery.ref,
    at: delivery.at,
  };
}

export type NotificationSinkDeps = {
  /** `process.platform`. Injected so the platform choice is testable. */
  readonly platform?: string;
  /** Spawn seam for the OS notifier — an argv VECTOR, never a shell line. */
  readonly notify?: (argv: readonly string[]) => void;
  /** POST seam for the webhook; defaults to `fetch`. */
  readonly post?: (url: string, body: string) => Promise<unknown>;
  /** A sink failure is reported, never swallowed — an operator who thinks
   *  they are being paged has to hear that they are not. */
  readonly onWarn?: (message: string) => void;
  readonly timeoutMs?: number;
};

/**
 * The REAL sinks the shipping manager uses: an OS notifier spawned as an
 * argv vector, and a `fetch` POST to the configured webhook. Both seams are
 * injectable, which is how the test suite proves the fan-out without
 * spawning `osascript` or opening a socket.
 */
export function defaultNotificationSinks(deps: NotificationSinkDeps = {}): NotificationSinks {
  const platform = deps.platform ?? process.platform;
  const onWarn = deps.onWarn ?? ((): void => {});
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  const notify =
    deps.notify ??
    ((argv: readonly string[]): void => {
      const [cmd, ...args] = argv;
      if (cmd === undefined) return;
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      // A box with no notifier installed is a warning, not a crash.
      child.on("error", (err: Error) =>
        onWarn(`hangar-server: OS notification failed: ${err.message}`),
      );
      child.unref();
    });

  const post =
    deps.post ??
    ((url: string, body: string): Promise<unknown> =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // A redirect to somewhere else is not the target the operator
        // configured, so it is an error rather than a hop to follow.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }));

  const sinks: { os?: (d: Delivery) => void; webhook?: (d: Delivery, url: string) => void } = {};
  if (osNotifierArgv(platform, OS_NOTIFICATION_TITLE, "probe") !== undefined) {
    sinks.os = (delivery) => {
      const argv = osNotifierArgv(platform, OS_NOTIFICATION_TITLE, toastBody(delivery));
      if (argv === undefined) return;
      try {
        notify(argv);
      } catch (err) {
        onWarn(
          `hangar-server: OS notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
  }
  sinks.webhook = (delivery, url) => {
    // The URL is never logged: the operator chose it, but a path segment is
    // as good a place to hide a token as a query string.
    const fail = (err: unknown): void =>
      onWarn(
        `hangar-server: webhook delivery ${delivery.key} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    try {
      void Promise.resolve(post(url, JSON.stringify(webhookPayload(delivery)))).catch(fail);
    } catch (err) {
      fail(err);
    }
  };
  return sinks;
}

/** Cap on the in-app queue — a badge, not a log. */
export const MAX_INAPP_DELIVERIES = 100;

export type NotificationCentre = {
  /** Evaluate a snapshot and fan out. Returns what was delivered NOW, with
   *  each delivery's `sinks` naming the sinks that ACTUALLY carried it. */
  poll(input: Omit<EvaluateInput, "delivered">, webhookUrl: string | null): EvaluateResult;
  /** Which sinks this manager can deliver on right now, given the webhook
   *  URL currently configured. */
  availability(webhookUrl: string | null): readonly SinkAvailability[];
  /** The in-app queue, newest first. */
  inApp(): readonly Delivery[];
  /** Drop the in-app queue (the console's "mark all read"). */
  clear(): void;
  /** Forget the dedupe set — used by the "send a test" path so an operator
   *  can re-fire a rule they just edited. */
  forget(key: string): void;
};

/**
 * The stateful shell around the pure evaluator: the dedupe set and the
 * in-app queue, both in memory, plus sink fan-out. Sinks are injected —
 * nothing here spawns `osascript` or opens a socket by itself, so the
 * server's tests never do either. The shipping composition passes
 * {@link defaultNotificationSinks}.
 */
export function createNotificationCentre(sinks: NotificationSinks = {}): NotificationCentre {
  const delivered = new Set<string>();
  let queue: Delivery[] = [];

  /** The sinks that can carry THIS delivery, in canonical order. */
  const usable = (candidate: Delivery, webhookUrl: string | null): readonly NotificationSink[] => {
    const fired: NotificationSink[] = [];
    if (candidate.sinks.includes("in-app")) fired.push("in-app");
    if (candidate.sinks.includes("os") && sinks.os !== undefined) fired.push("os");
    if (candidate.sinks.includes("webhook") && sinks.webhook !== undefined && webhookUrl !== null) {
      fired.push("webhook");
    }
    return fired;
  };

  return {
    poll: (input, webhookUrl) => {
      const result = evaluateNotifications({ ...input, delivered });
      const deliveries: Delivery[] = [];
      const suppressed = [...result.suppressed];
      for (const candidate of result.deliveries) {
        const fired = usable(candidate, webhookUrl);
        if (fired.length === 0) {
          // Nothing carried it, so nothing is remembered: burning the dedupe
          // key here would make this occurrence unreachable forever.
          suppressed.push({
            key: candidate.key,
            kind: candidate.kind,
            harnessId: candidate.harnessId,
            reason: "sink-unavailable",
          });
          continue;
        }
        const final: Delivery = { ...candidate, sinks: fired };
        delivered.add(final.key);
        if (fired.includes("in-app")) queue = [final, ...queue].slice(0, MAX_INAPP_DELIVERIES);
        if (fired.includes("os")) sinks.os?.(final);
        if (fired.includes("webhook") && webhookUrl !== null) sinks.webhook?.(final, webhookUrl);
        deliveries.push(final);
      }
      return { deliveries, suppressed };
    },
    availability: (webhookUrl) => [
      { sink: "in-app", available: true, reason: null },
      sinks.os !== undefined
        ? { sink: "os", available: true, reason: null }
        : {
            sink: "os",
            available: false,
            reason:
              "no OS notifier on this platform — macOS uses osascript and Linux notify-send; there is none this manager drives here",
          },
      sinks.webhook === undefined
        ? {
            sink: "webhook",
            available: false,
            reason: "this manager was built with no webhook sink",
          }
        : webhookUrl === null
          ? { sink: "webhook", available: false, reason: "no webhook URL is configured" }
          : { sink: "webhook", available: true, reason: null },
    ],
    inApp: () => queue,
    clear: () => {
      queue = [];
    },
    forget: (key) => {
      delivered.delete(key);
    },
  };
}
