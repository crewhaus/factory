/**
 * HM-198's console half — Settings: Readability (this device's text size,
 * density, motion, contrast, shortcuts and theme), signing this browser out,
 * notification rules (HM-183), read-only mode (HM-187), and the
 * installed-plugin inventory (HM-179).
 *
 * Three deliberate choices show up here as UI:
 *
 *   - Every rule ships OFF except parked approvals, and the screen says so,
 *     because a product that decides what deserves to interrupt you is a
 *     product you stop trusting.
 *   - The read-only toggle is labelled with what it actually protects. It
 *     prevents accidents during a demo; signing in is the security
 *     boundary. Claiming more would be a lie a screen-share could disprove.
 *   - The plugin table lists the DEFERRED extension points beside the wired
 *     ones, with their reasons. A capability that is declared but not wired
 *     has to be visible, or the next person wires it a second time.
 *
 * This screen does NOT read `GET /api/notifications` itself. That GET is the
 * rules evaluation (HM-183), so a second caller consumes deliveries the app's
 * poll would otherwise have toasted — the state comes from the one shared
 * poll in `notify.js`, and the PUT's answer is folded back into it.
 */

import { api } from "../api.js";
import { clear, copyBtn, dot, el, emptyState, scrollRegion, skeleton, toast } from "../dom.js";
import { notifications } from "../notify.js";
import {
  applyPrefs,
  applyTheme,
  readPrefs,
  readTheme,
  takeFocusRequest,
  writePrefs,
  writeTheme,
} from "../prefs.js";
import { hrefHarness } from "../router.js";
import { signOut } from "../sign-in.js";
import { fmtRelativeTime } from "../util.js";

/** kind → the sentence the rule row shows. Mirrors the server's KIND_LABELS;
 *  an unknown kind falls back to its slug rather than disappearing. */
const KIND_LABELS = {
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

const SINKS = ["in-app", "os", "webhook"];

/** Why an event did not notify — the sentence beside the reason slug. */
const SUPPRESSED_REASONS = {
  "rule-off": "the rule is off",
  "group-muted": "the harness is in a muted group",
  "quiet-hours": "quiet hours silenced every sink it had",
  "already-delivered": "already notified this session",
  "sink-unavailable": "no sink this manager can deliver on was selected",
};

/**
 * Readability (`#/settings/readability`). The first-run card's Adjust lands
 * here, with focus on the current choice.
 */
export async function renderReadabilitySettings(root) {
  const readability = readabilityCard();
  clear(root).appendChild(readability);
  if (takeFocusRequest("readability")) {
    const first = readability.querySelector("input:checked") ?? readability.querySelector("input");
    if (first instanceof HTMLElement) first.focus();
  }
}

/** Notifications (`#/settings/notifications`): the rules, from the shared poll. */
export async function renderNotificationSettings(root) {
  clear(root).appendChild(skeleton(6));
  const [notifRes, groupsRes] = await Promise.allSettled([
    // The shared poll's state — never a second evaluating GET from here.
    notifications.current(),
    api.groups(),
  ]);
  clear(root).appendChild(
    notificationCard(settled(notifRes), settled(groupsRes), () => renderNotificationSettings(root)),
  );
}

/** Home settings (`#/settings/home`): read-only mode and the installed plugins. */
export async function renderHomeSettings(root) {
  clear(root).appendChild(skeleton(6));
  const [readOnlyRes, pluginsRes] = await Promise.allSettled([api.readOnly(), api.plugins()]);
  clear(root);
  root.appendChild(readOnlyCard(settled(readOnlyRes)));
  root.appendChild(pluginCard(settled(pluginsRes)));
}

/** Your account (`#/settings/account`): signing this browser out. */
export function renderAccountSettings(root) {
  clear(root).appendChild(signOutCard());
}

// ---------------------------------------------------------------------------
// Readability (this device)
// ---------------------------------------------------------------------------

/** The Readability choices, in display order. `pref` names the field in the
 *  preferences record; `theme` is stored on its own key. Pure data. */
export const READABILITY_GROUPS = [
  {
    pref: "textSize",
    legend: "Text size",
    options: [
      ["default", "Default"],
      ["large", "Large"],
      ["larger", "Larger"],
    ],
  },
  {
    pref: "density",
    legend: "Density",
    options: [
      ["comfortable", "Comfortable"],
      ["compact", "Compact"],
    ],
  },
  {
    pref: "motion",
    legend: "Motion",
    options: [
      ["system", "System"],
      ["reduce", "Reduce"],
    ],
  },
  {
    pref: "contrast",
    legend: "Contrast",
    options: [
      ["system", "System"],
      ["more", "More"],
    ],
  },
  {
    pref: "singleKeys",
    legend: "Single-key shortcuts",
    options: [
      ["on", "On"],
      ["off", "Off"],
    ],
  },
  {
    pref: "theme",
    legend: "Theme",
    options: [
      ["dark", "Dark"],
      ["light", "Light"],
    ],
  },
];

/** The current value of one Readability group, as its radio value. */
function readabilityValue(pref, prefs, theme) {
  if (pref === "theme") return theme;
  if (pref === "singleKeys") return prefs.singleKeys ? "on" : "off";
  return prefs[pref];
}

/**
 * Readability: native radios in a fieldset per choice, applied the moment
 * one is picked. Stored in this browser only; nothing here is sent anywhere.
 */
function readabilityCard() {
  const prefs = readPrefs();
  const theme = readTheme();
  const groups = READABILITY_GROUPS.map((group) => {
    const current = readabilityValue(group.pref, prefs, theme);
    return el("fieldset", null, [
      el("legend", { text: group.legend }),
      ...group.options.map(([value, label]) => {
        const radio = el("input", {
          type: "radio",
          name: `readability-${group.pref}`,
          value,
          checked: value === current,
        });
        radio.addEventListener("change", () => {
          if (!radio.checked) return;
          const root = document.documentElement;
          if (group.pref === "theme") applyTheme(root, writeTheme(value));
          else if (group.pref === "singleKeys") writePrefs({ singleKeys: value === "on" });
          else applyPrefs(root, writePrefs({ [group.pref]: value }));
        });
        return el("label", { class: "read-choice" }, [radio, el("span", { text: label })]);
      }),
    ]);
  });
  return el(
    "section",
    { class: "card", id: "readability", "aria-labelledby": "readability-title" },
    [
      el("h3", { class: "card-title", id: "readability-title", text: "Readability" }),
      el("p", {
        class: "muted",
        text: "How this browser shows the console. Each choice applies at once and stays on this device.",
      }),
      el("div", { class: "read-grid" }, groups),
    ],
  );
}

function settled(res) {
  return res.status === "fulfilled" ? res.value : null;
}

// ---------------------------------------------------------------------------
// This browser
// ---------------------------------------------------------------------------

/**
 * Sign out ends this tab's session at Home and keeps this browser's key, so
 * the next visit signs in by itself. Forget this browser also deletes the
 * key: the next visit needs a new link from `crewhaus hangar open`.
 */
function signOutCard() {
  const leave = async (forget, button) => {
    button.disabled = true;
    await signOut({ forget });
    window.location.reload();
  };
  const out = el("button", { class: "btn", type: "button", text: "Sign out" });
  out.addEventListener("click", () => leave(false, out));
  const forget = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "Forget this browser",
  });
  forget.addEventListener("click", () => leave(true, forget));
  return el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "This browser" }),
    el("p", {
      class: "muted",
      text: "Sign out ends this tab's session. Forget this browser also removes its key, so signing in again needs a new link from crewhaus hangar open.",
    }),
    el("div", { class: "editor-actions" }, [out, forget]),
  ]);
}

// ---------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------

function readOnlyCard(state) {
  const enabled = state?.enabled === true;
  const locked = state?.locked === true;
  const card = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "Read-only mode" }),
    el("p", { class: "muted", text: String(state?.note ?? "") }),
    el("div", { class: "add-form" }, [
      dot(enabled ? "warn" : "ok", enabled ? "engaged — writes refused" : "off — writes allowed"),
      locked ? el("span", { class: "chip chip-warn", text: "locked at startup" }) : null,
    ]),
  ]);
  const button = el("button", {
    class: enabled ? "btn" : "btn btn-danger",
    type: "button",
    text: enabled ? "Turn read-only off" : "Turn read-only on",
    onClick: async () => {
      button.disabled = true;
      const res = await api.setReadOnly(!enabled);
      button.disabled = false;
      if (res.ok !== true) {
        toast(
          `${String(res.body?.message ?? "refused")} — ${String(res.body?.remedy ?? "")}`,
          "error",
        );
        return;
      }
      window.location.reload();
    },
  });
  if (locked && enabled) {
    button.disabled = true;
    button.title = "this manager was started with the mode locked — restart it without --read-only";
  }
  card.appendChild(button);
  card.appendChild(
    el("p", { class: "muted note" }, [
      el("span", { text: "Exempt while engaged: " }),
      el("code", {
        class: "mono exempt-list",
        text: (Array.isArray(state?.exempt) ? state.exempt : []).join(", ") || "—",
      }),
    ]),
  );
  return card;
}

// ---------------------------------------------------------------------------
// Notification rules
// ---------------------------------------------------------------------------

/**
 * The one line that says notifications stop when this window closes, with the command
 * that keeps them going, when Home is not running as the installed service. Said in
 * words, never by colour alone.
 */
function notificationServiceLine(service) {
  if (service === null || typeof service !== "object" || service.state === "running") return null;
  const note =
    typeof service.note === "string" && service.note !== ""
      ? service.note
      : "Install the service to get notifications while this window is closed";
  const verb = typeof service.verb === "string" && service.verb !== "" ? service.verb : null;
  return el("p", { class: "muted note notification-service" }, [
    el("span", { text: note }),
    ...(verb !== null ? [" ", el("code", { class: "mono", text: verb }), " ", copyBtn(verb)] : []),
  ]);
}

function notificationCard(state, groupsPayload, reload) {
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  const card = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "Notifications" }),
    el("p", {
      class: "muted",
      text: "Only parked approvals notify by default — everything else is visible on a screen you already open, so it waits for you to ask for it.",
    }),
  ]);
  const serviceLine = notificationServiceLine(state?.service);
  if (serviceLine !== null) card.appendChild(serviceLine);
  if (rules.length === 0) {
    card.appendChild(emptyState("No rules loaded", "crewhaus hangar serve"));
    return card;
  }
  const groups = Array.isArray(groupsPayload?.groups)
    ? groupsPayload.groups.map((g) => String(g?.name ?? ""))
    : [];
  const draft = {
    rules: rules.map((r) => ({
      kind: String(r?.kind ?? ""),
      enabled: r?.enabled === true,
      sinks: Array.isArray(r?.sinks) ? r.sinks.map(String) : ["in-app"],
      mutedGroups: Array.isArray(r?.mutedGroups) ? r.mutedGroups.map(String) : [],
    })),
    quietHours: {
      enabled: state?.quietHours?.enabled === true,
      startHour: Number(state?.quietHours?.startHour ?? 22),
      endHour: Number(state?.quietHours?.endHour ?? 7),
      utcOffsetMinutes: Number(state?.quietHours?.utcOffsetMinutes ?? 0),
    },
    mutedGroups: Array.isArray(state?.mutedGroups) ? state.mutedGroups.map(String) : [],
    webhookUrl: typeof state?.webhookUrl === "string" ? state.webhookUrl : "",
  };

  const table = el("table", { class: "table rules-table" });
  table.appendChild(
    el("thead", null, [
      el("tr", null, [
        el("th", { text: "Notify when" }),
        el("th", { text: "On" }),
        ...SINKS.map((s) => el("th", { text: s })),
      ]),
    ]),
  );
  const tbody = el("tbody");
  for (const rule of draft.rules) {
    const row = el("tr", null, [
      el("td", null, [
        el("span", { text: KIND_LABELS[rule.kind] ?? rule.kind }),
        el("div", { class: "muted mono note", text: rule.kind }),
      ]),
      el("td", null, [
        checkbox(
          rule.enabled,
          (on) => {
            rule.enabled = on;
          },
          `enable ${rule.kind}`,
        ),
      ]),
      ...SINKS.map((sink) =>
        el("td", null, [
          checkbox(
            rule.sinks.includes(sink),
            (on) => {
              rule.sinks = on
                ? [...new Set([...rule.sinks, sink])]
                : rule.sinks.filter((s) => s !== sink);
            },
            `${sink} for ${rule.kind}`,
          ),
        ]),
      ),
    ]);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  card.appendChild(scrollRegion("Notification rules", [table]));

  // Quiet hours + muting + webhook.
  const start = numberField(draft.quietHours.startHour, "quiet hours start (0–23)");
  const end = numberField(draft.quietHours.endHour, "quiet hours end (0–23)");
  const offset = numberField(draft.quietHours.utcOffsetMinutes, "UTC offset in minutes");
  const quietOn = checkbox(
    draft.quietHours.enabled,
    (on) => {
      draft.quietHours.enabled = on;
    },
    "quiet hours",
  );
  card.appendChild(
    el("div", { class: "add-form" }, [
      el("label", { class: "field-inline" }, [quietOn, el("span", { text: " Quiet hours" })]),
      el("label", { class: "field-inline" }, [el("span", { text: "from " }), start]),
      el("label", { class: "field-inline" }, [el("span", { text: "to " }), end]),
      el("label", { class: "field-inline" }, [el("span", { text: "UTC offset (min) " }), offset]),
    ]),
  );
  card.appendChild(
    el("p", {
      class: "muted note",
      text: "Quiet hours silence the OS toast and the webhook. The in-app badge stays — waking up to a console that says everything is fine would be worse than a number you can ignore.",
    }),
  );

  const mutedField = el("input", {
    class: "input mono grow",
    type: "text",
    value: draft.mutedGroups.join(", "),
    placeholder: groups.length > 0 ? groups.join(", ") : "group-a, group-b",
    "aria-label": "muted groups",
  });
  const webhookField = el("input", {
    class: "input mono grow",
    type: "url",
    value: draft.webhookUrl,
    placeholder: "https://hooks.example.com/hangar",
    "aria-label": "webhook URL",
  });
  card.appendChild(
    el("div", { class: "add-form" }, [
      el("label", { class: "field-inline" }, [el("span", { text: "Mute groups " }), mutedField]),
      el("label", { class: "field-inline" }, [el("span", { text: "Webhook " }), webhookField]),
    ]),
  );
  card.appendChild(
    el("p", {
      class: "muted note",
      text: "A webhook URL must not embed credentials — the manager refuses one that does rather than storing it and masking it later.",
    }),
  );
  card.appendChild(
    el("div", { class: "add-form" }, [
      el("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Save rules",
        onClick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const updated = await api.setNotifications({
              rules: draft.rules,
              quietHours: {
                enabled: draft.quietHours.enabled,
                startHour: Number(start.value),
                endHour: Number(end.value),
                utcOffsetMinutes: Number(offset.value),
              },
              mutedGroups: splitList(mutedField.value),
              webhookUrl: webhookField.value.trim() === "" ? null : webhookField.value.trim(),
            });
            // The PUT answers with the same evaluated view the GET does —
            // deliveries included. Fold it into the shared poll so nothing it
            // just consumed goes unseen, and so the badge follows the save.
            notifications.accept(updated);
            toast("Notification rules saved", "info");
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), "error");
          }
          button.disabled = false;
        },
      }),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Clear the badge",
        onClick: async () => {
          try {
            await api.clearNotifications();
            await notifications.refresh();
            toast("Badge cleared", "info");
            reload?.();
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), "error");
          }
        },
      }),
    ]),
  );
  card.appendChild(pendingList(state));
  const why = suppressedList(state);
  if (why !== null) card.appendChild(why);
  return card;
}

/**
 * What the badge is COUNTING. A number an operator cannot open is a number
 * they learn to ignore, and the in-app queue is the only record of a
 * delivery there is — the dedupe set means the server will not report it a
 * second time.
 */
function pendingList(state) {
  const inApp = Array.isArray(state?.inApp) ? state.inApp : [];
  const box = el("div", { class: "notif-queue" }, [
    el("h4", { class: "sheet-section", text: "Waiting for you" }),
  ]);
  if (inApp.length === 0) {
    box.appendChild(el("p", { class: "muted note", text: "Nothing pending." }));
    return box;
  }
  const now = Date.now();
  box.appendChild(
    el(
      "ul",
      { class: "check-list" },
      inApp.map((d) => {
        const id = String(d?.harnessId ?? "");
        const label = String(d?.label ?? d?.kind ?? "");
        return el("li", null, [
          dot("warn", label),
          el("span", { class: "muted", text: ` ${fmtRelativeTime(String(d?.at ?? ""), now)}` }),
          id === ""
            ? null
            : el("a", { class: "chip", href: hrefHarness(id, "overview"), text: "open →" }),
        ]);
      }),
    ),
  );
  return box;
}

/**
 * …and what did NOT notify, with the reason. A silent rule has to be
 * explainable from the screen, or the operator's only model of the feature
 * is "it sometimes tells me things".
 */
function suppressedList(state) {
  const suppressed = Array.isArray(state?.suppressed) ? state.suppressed : [];
  if (suppressed.length === 0) return null;
  const counts = new Map();
  for (const s of suppressed) {
    const reason = String(s?.reason ?? "unknown");
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return el("div", { class: "notif-suppressed" }, [
    el("h4", { class: "sheet-section", text: "Seen, but not notified" }),
    el(
      "ul",
      { class: "check-list" },
      [...counts.entries()].map(([reason, n]) =>
        el("li", null, [
          dot("off", `${n} × ${reason}`),
          el("span", { class: "muted", text: ` — ${SUPPRESSED_REASONS[reason] ?? reason}` }),
        ]),
      ),
    ),
  ]);
}

function checkbox(checked, onChange, label) {
  const node = el("input", { type: "checkbox", "aria-label": label });
  node.checked = checked === true;
  node.addEventListener("change", () => onChange(node.checked));
  return node;
}

function numberField(value, label) {
  const node = el("input", {
    class: "input num-input",
    type: "number",
    value: String(value),
    "aria-label": label,
  });
  return node;
}

/** "a, b ,, c" → ["a","b","c"]. Exported for the unit tests. */
export function splitList(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function pluginCard(inventory) {
  const plugins = Array.isArray(inventory?.plugins) ? inventory.plugins : [];
  const card = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "Plugins" }),
    el("p", { class: "muted" }, [
      el("span", { text: "This build wires " }),
      el("code", { class: "mono", text: (inventory?.wired ?? []).join(", ") || "nothing" }),
      el("span", {
        text: ". A plugin's pane runs in a sandboxed frame with an opaque origin and a policy built from its own net allow-list; a plugin that may not read a harness sees neither its panes nor its trace events.",
      }),
    ]),
  ]);
  const deferred =
    inventory?.deferred && typeof inventory.deferred === "object"
      ? Object.entries(inventory.deferred)
      : [];
  if (deferred.length > 0) {
    card.appendChild(
      el("ul", { class: "check-list" }, [
        el("li", { class: "muted", text: "Declared but NOT wired (deferred):" }),
        ...deferred.map(([point, reason]) =>
          el("li", null, [
            dot("off", point),
            el("span", { class: "muted", text: ` — ${String(reason)}` }),
          ]),
        ),
      ]),
    );
  }
  if (plugins.length === 0) {
    card.appendChild(emptyState("No plugins installed", "crewhaus plugins install <name>"));
    return card;
  }
  card.appendChild(
    el(
      "ul",
      { class: "check-list" },
      plugins.map((plugin) => pluginRow(plugin)),
    ),
  );
  return card;
}

function pluginRow(plugin) {
  const problems = Array.isArray(plugin?.problems) ? plugin.problems : [];
  const points = Array.isArray(plugin?.extensionPoints) ? plugin.extensionPoints : [];
  const panes = Array.isArray(plugin?.panes) ? plugin.panes : [];
  return el("li", { class: "plugin-row" }, [
    el("div", null, [
      el("strong", { text: String(plugin?.name ?? "") }),
      el("span", { class: "muted mono", text: ` ${String(plugin?.version ?? "")}` }),
      problems.length > 0 ? dot("bad", problems.join("; ")) : null,
    ]),
    plugin?.description ? el("div", { class: "muted", text: String(plugin.description) }) : null,
    el(
      "div",
      { class: "safety-strip" },
      points
        .filter((p) => p.declared === true)
        .map((p) =>
          el("span", {
            class: `chip${p.wired === true ? "" : " chip-warn"}`,
            title: p.wired === true ? "wired" : String(p.reason ?? "not wired"),
            text: `${p.point}: ${p.wired === true ? "wired" : "deferred"}`,
          }),
        ),
    ),
    panes.length > 0
      ? el("div", { class: "muted", text: `panes: ${panes.map((p) => p.id).join(", ")}` })
      : null,
    el("div", { class: "muted mono note" }, [
      el("span", { text: `fs: ${(plugin?.permissions?.fs ?? []).join(" ") || "none"}` }),
      el("span", { text: ` · net: ${(plugin?.permissions?.net ?? []).join(" ") || "none"}` }),
    ]),
  ]);
}
