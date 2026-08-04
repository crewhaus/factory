/**
 * The honest "not built yet" surface.
 *
 * M3's contract — routes, guards, dispatch, client wrappers — is frozen
 * before its handlers are written, so six areas can be implemented in
 * parallel without colliding. That leaves eleven screens that navigate,
 * deep-link and render, but have no data behind them yet.
 *
 * A blank page would be a lie of omission, and a spinner would be worse. So
 * each pending screen says exactly three things: what it will show, that the
 * server answers `501 not implemented (M3)` for it today, and WHICH routes
 * it will read — rendered from the route map itself, so this page cannot
 * drift from the contract it is describing.
 *
 * When an area's handlers land, its view replaces `renderPendingSurface`
 * with the real thing; nothing else in the shell has to change.
 */

import { clear, dot, el } from "./dom.js";
import { ROUTES, routeKeysInGroup } from "./routes.js";

/**
 * Render the pending surface for one M3 group.
 *
 * `root`   container (cleared)
 * `group`  the route-map group whose routes back this screen
 * `title`  the screen's name
 * `blurb`  one sentence on what it will show when it is built
 */
export function renderPendingSurface(root, { group, title, blurb }) {
  clear(root);
  const keys = routeKeysInGroup(group);
  const card = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: title }),
      dot("off", "not built yet (M3)"),
    ]),
    el("p", { class: "muted", text: blurb }),
    el("p", {
      class: "muted",
      text: `The contract for this screen is frozen: ${keys.length} route${
        keys.length === 1 ? "" : "s"
      } exist and answer 501 until the handlers land.`,
    }),
  ]);
  const tbody = el("tbody");
  for (const key of keys) {
    const route = ROUTES[key];
    tbody.appendChild(
      el("tr", null, [
        el("td", { class: "mono", text: route.method }),
        el("td", { class: "mono", text: route.path }),
        el("td", { class: "mono muted", text: route.body ?? "—" }),
      ]),
    );
  }
  card.appendChild(
    el("details", { class: "fold" }, [
      el("summary", { class: "fold-summary" }, [
        el("span", { class: "muted", text: "the routes this screen will read" }),
      ]),
      el("div", { class: "fold-body" }, [
        el("div", { class: "table-scroll" }, [
          el("table", { class: "fleet" }, [
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                ["Method", "Path", "Body"].map((h) => el("th", { text: h })),
              ),
            ),
            tbody,
          ]),
        ]),
      ]),
    ]),
  );
  root.appendChild(card);
  return card;
}
