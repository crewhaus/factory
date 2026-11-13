/**
 * People (`#/people`). Home has no people screens yet; this page says so and
 * names the command that lists the profiles kept on this computer.
 */

import { clear, el } from "../dom.js";

/** The command that lists people, shown beside the empty state. */
export const PEOPLE_VERB = "crewhaus people list";

export function renderPeople(root) {
  clear(root).appendChild(
    el("section", { class: "card" }, [
      el("div", { class: "empty", "data-cause": "unsupported" }, [
        el("div", { class: "empty-msg", text: "People aren't shown in Home yet." }),
        el("div", {
          class: "empty-detail",
          text: "Profiles are kept on this computer. A terminal can list them.",
        }),
        el("div", { class: "empty-verb" }, [
          "Run ",
          el("code", { text: PEOPLE_VERB }),
          " to see them.",
        ]),
      ]),
    ]),
  );
}
