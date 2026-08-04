/**
 * Manager settings — HM-198's persisted half, plus HM-187's read-only mode.
 *
 * Everything here is MANAGER state (`<hangarRoot>/settings.json`), never
 * harness state: notification rules, quiet hours, the webhook sink, the
 * read-only toggle, and whether onboarding has been completed. Deleting the
 * file loses preferences and nothing else, which is the same posture the
 * rollup cache takes.
 *
 * ---------------------------------------------------------------------------
 * HM-187 — read-only mode, and what it actually protects
 * ---------------------------------------------------------------------------
 * A UI-only toggle is decoration: the routes are still there, and one stale
 * tab, one keyboard shortcut or one `curl` still starts a daemon in front of
 * an audience. So the refusal lives in the SERVER's dispatch, ahead of every
 * handler, and it is expressed the only way that cannot drift as routes are
 * added: **every non-GET `/api` request is refused** unless it is on the
 * short exempt list below.
 *
 * Be precise about the threat it answers. Read-only mode prevents ACCIDENTS
 * during a screen-share or a demo — a misclick, a keyboard binding, a
 * half-finished form. It is not an authorization boundary: the bearer token
 * is, and anyone holding it can turn the mode off again (that is the point —
 * an operator must be able to undo their own toggle). A server started with
 * `readOnlyLocked` refuses even the un-toggle, for the case where the person
 * driving is not the person who owns the machine; the refusal names the
 * restart as the way out, because a lock that can be lifted over the wire is
 * not a lock.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_RULES,
  type NotificationRule,
  type QuietHours,
  normalizeQuietHours,
  normalizeRules,
} from "./notifications";

export const SETTINGS_FILENAME = "settings.json";
const SETTINGS_VERSION = 1;

export type NotificationSettings = {
  readonly rules: readonly NotificationRule[];
  readonly quietHours: QuietHours;
  /** Groups muted across every rule (per-rule muting lives on the rule). */
  readonly mutedGroups: readonly string[];
  /** Webhook sink target, or null. Validated on write. */
  readonly webhookUrl: string | null;
};

export type OnboardingSettings = {
  /** ISO-8601 when the operator finished (or dismissed) first-boot setup. */
  readonly completedAt: string | null;
};

export type HangarSettings = {
  readonly version: number;
  readonly readOnly: boolean;
  readonly notifications: NotificationSettings;
  readonly onboarding: OnboardingSettings;
};

export const DEFAULT_SETTINGS: HangarSettings = {
  version: SETTINGS_VERSION,
  readOnly: false,
  notifications: {
    rules: DEFAULT_RULES,
    quietHours: DEFAULT_QUIET_HOURS,
    mutedGroups: [],
    webhookUrl: null,
  },
  onboarding: { completedAt: null },
};

export type SettingsPatch = {
  readonly readOnly?: boolean;
  readonly notifications?: {
    readonly rules?: unknown;
    readonly quietHours?: unknown;
    readonly mutedGroups?: unknown;
    readonly webhookUrl?: unknown;
  };
  readonly onboarding?: { readonly completedAt?: unknown };
};

export type SettingsStore = {
  readonly path: string;
  get(): HangarSettings;
  /** Merge a patch and persist. Returns the settings as they now stand. */
  update(patch: SettingsPatch): HangarSettings;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate a webhook target. Refuses anything that is not http(s), and
 * refuses userinfo (`https://user:token@host/…`) outright: a credential in
 * a URL would be echoed back by the settings route, written to the settings
 * file in the clear, and logged by whatever receives the hook. Naming the
 * refusal is more useful than masking it after the fact.
 */
export function normalizeWebhookUrl(value: unknown): { url: string | null; error?: string } {
  if (value === null || value === undefined || value === "") return { url: null };
  if (typeof value !== "string") return { url: null, error: "webhookUrl must be a string or null" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: null, error: "webhookUrl is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: null, error: "webhookUrl must be http: or https:" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      url: null,
      error:
        "webhookUrl must not embed credentials — put the secret in a header-bearing proxy or a signed path, not in the URL",
    };
  }
  return { url: parsed.toString() };
}

function coerce(raw: unknown): HangarSettings {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  const notifications = isRecord(raw["notifications"]) ? raw["notifications"] : {};
  const onboarding = isRecord(raw["onboarding"]) ? raw["onboarding"] : {};
  const mutedGroups = Array.isArray(notifications["mutedGroups"])
    ? notifications["mutedGroups"].filter((g): g is string => typeof g === "string")
    : [];
  const completedAt = onboarding["completedAt"];
  return {
    version: SETTINGS_VERSION,
    readOnly: raw["readOnly"] === true,
    notifications: {
      rules: normalizeRules(notifications["rules"]),
      quietHours: normalizeQuietHours(notifications["quietHours"]),
      mutedGroups,
      webhookUrl: normalizeWebhookUrl(notifications["webhookUrl"]).url,
    },
    onboarding: { completedAt: typeof completedAt === "string" ? completedAt : null },
  };
}

/**
 * Open (and lazily create) the settings file. A torn or foreign file is
 * reported through `onWarn` and replaced by the defaults IN MEMORY — never
 * deleted, because a file this manager cannot parse may still be one the
 * operator can fix by hand.
 */
export function openSettingsStore(
  hangarRoot: string,
  opts: { readonly onWarn?: (message: string) => void } = {},
): SettingsStore {
  const path = join(hangarRoot, SETTINGS_FILENAME);
  const onWarn = opts.onWarn ?? (() => {});
  let cached: HangarSettings | undefined;

  const read = (): HangarSettings => {
    if (cached !== undefined) return cached;
    if (!existsSync(path)) {
      cached = DEFAULT_SETTINGS;
      return cached;
    }
    try {
      cached = coerce(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      onWarn(
        `hangar-server: ${path} is unreadable (${err instanceof Error ? err.message : String(err)}) — using defaults; the file is left in place`,
      );
      cached = DEFAULT_SETTINGS;
    }
    return cached;
  };

  const write = (next: HangarSettings): HangarSettings => {
    cached = next;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch (err) {
      onWarn(
        `hangar-server: could not persist settings to ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return next;
  };

  return {
    path,
    get: read,
    update: (patch) => {
      const current = read();
      const n = patch.notifications;
      const webhook =
        n !== undefined && "webhookUrl" in n ? normalizeWebhookUrl(n.webhookUrl) : undefined;
      if (webhook?.error !== undefined) throw new Error(webhook.error);
      const next: HangarSettings = {
        version: SETTINGS_VERSION,
        readOnly: patch.readOnly === undefined ? current.readOnly : patch.readOnly === true,
        notifications: {
          rules: n?.rules === undefined ? current.notifications.rules : normalizeRules(n.rules),
          quietHours:
            n?.quietHours === undefined
              ? current.notifications.quietHours
              : normalizeQuietHours(n.quietHours),
          mutedGroups:
            n?.mutedGroups === undefined
              ? current.notifications.mutedGroups
              : Array.isArray(n.mutedGroups)
                ? n.mutedGroups.filter((g): g is string => typeof g === "string")
                : [],
          webhookUrl: webhook === undefined ? current.notifications.webhookUrl : webhook.url,
        },
        onboarding: {
          completedAt:
            patch.onboarding === undefined || !("completedAt" in patch.onboarding)
              ? current.onboarding.completedAt
              : typeof patch.onboarding.completedAt === "string"
                ? patch.onboarding.completedAt
                : null,
        },
      };
      return write(next);
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only mode — the server-side refusal
// ---------------------------------------------------------------------------

/**
 * The `<METHOD> <pathname>` pairs read-only mode still allows.
 *
 * Kept as EXACT strings, not prefixes: an exemption that matched a prefix
 * would quietly widen every time a route was added underneath it, which is
 * precisely how a "read-only" mode stops being one.
 *
 *   - the toggle itself, so the operator who turned the mode on can turn it
 *     off (a lock nobody can lift is a support ticket);
 *   - the boot ticket, which mints a browser handoff and touches no state
 *     the mode is about.
 */
export const READ_ONLY_EXEMPT: ReadonlySet<string> = new Set([
  "PUT /api/read-only",
  "POST /api/boot-ticket",
]);

/** True when this request would be refused with read-only mode engaged. */
export function isReadOnlyRefused(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !READ_ONLY_EXEMPT.has(`${method} ${pathname}`);
}

/** The refusal body — a fact about the manager, with the way out named. */
/**
 * The 403 body for a refused mutating request.
 *
 * `locked` is not decoration: the two modes have DIFFERENT remedies, and a
 * remedy that names the wrong one sends an operator to restart a manager
 * they could have toggled over the wire (or to toggle one that will refuse).
 * Plain `--read-only` is a session default and CAN be lifted with
 * `PUT /api/read-only {"enabled":false}`; only `--read-only-locked` requires
 * a restart.
 */
export function readOnlyRefusal(
  method: string,
  pathname: string,
  locked = false,
): Record<string, unknown> {
  return {
    error: "read-only mode is engaged — this manager refuses every mutating request",
    code: "read_only",
    method,
    path: pathname,
    locked,
    remedy: locked
      ? "this manager was started with --read-only-locked; restart it without that flag"
      : 'turn it off in Settings (or PUT /api/read-only {"enabled":false})',
  };
}
