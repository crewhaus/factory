/**
 * Settings (`#/settings`): one link per row of `SETTINGS_PAGES`, each with
 * what it holds. Settings are this Home's and this device's, never a
 * harness's.
 */

import { SETTINGS_PAGES } from "../destinations.js";
import { clear, el } from "../dom.js";
import { hrefFleet } from "../router.js";

export function renderSettingsIndex(root) {
  clear(root).appendChild(
    el("section", { class: "card section-summary", "aria-label": "Settings pages" }, [
      el("p", {
        class: "muted",
        text: "Settings for this Home and this device. A harness's own settings are in its Setup.",
      }),
      el(
        "ul",
        { class: "section-index" },
        SETTINGS_PAGES.map((page) =>
          el("li", { class: "section-index-item" }, [
            el("a", { href: hrefFleet("settings", page.id), text: page.title }),
            el("p", { class: "muted section-index-describe", text: page.describe }),
          ]),
        ),
      ),
    ]),
  );
}
