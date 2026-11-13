/**
 * Connections (`#/connections`): the connection kinds with a view across
 * every harness, one per row of `CONNECTION_KINDS`. What belongs to a single
 * harness lives in that harness's Setup.
 */

import { CONNECTION_KINDS } from "../destinations.js";
import { clear, el } from "../dom.js";
import { hrefFleet } from "../router.js";

export function renderConnections(root) {
  clear(root).appendChild(
    el("section", { class: "card section-summary", "aria-label": "Connection kinds" }, [
      el("ul", { class: "section-index" }, [
        ...CONNECTION_KINDS.map((kind) =>
          el("li", { class: "section-index-item" }, [
            el("a", { href: hrefFleet("connections", kind.id), text: kind.title }),
            el("p", { class: "muted section-index-describe", text: kind.describe }),
          ]),
        ),
      ]),
      el("p", {
        class: "muted",
        text: "Models, channels and the tools one harness uses are in that harness's Setup.",
      }),
    ]),
  );
}
