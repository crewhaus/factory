/**
 * Spec tab — read-only. The server masks credential-shaped values before
 * the YAML ever reaches this client; this view renders the masked text in a
 * line-numbered pane plus the env-ref presence checklist (KEY set/unset —
 * names and booleans only, never values) and any parse issues.
 */

import { api } from "../api.js";
import { clear, copyBtn, dot, el, emptyState, numberedCode, skeleton } from "../dom.js";

export async function renderSpec(root, ctx) {
  clear(root).appendChild(skeleton(8));
  const data = await api.spec(ctx.id);
  clear(root);
  if (data === null) {
    root.appendChild(emptyState("No spec found here yet", "crewhaus init"));
    return;
  }
  const yaml = typeof data.yaml === "string" ? data.yaml : "";
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const envRefs = Array.isArray(data.envRefs) ? data.envRefs : [];

  const side = el("aside", { class: "spec-side" });
  side.appendChild(el("h3", { class: "card-title", text: "Env refs" }));
  if (envRefs.length === 0) {
    side.appendChild(el("p", { class: "muted", text: "No $ENV references in this spec." }));
  } else {
    side.appendChild(
      el(
        "ul",
        { class: "check-list" },
        envRefs.map((ref) =>
          el("li", null, [
            dot(ref.set === true ? "ok" : "bad", ref.set === true ? "set" : "unset"),
            el("code", { text: String(ref.key ?? "") }),
          ]),
        ),
      ),
    );
  }
  if (issues.length > 0) {
    side.appendChild(el("h3", { class: "card-title", text: "Parse issues" }));
    side.appendChild(
      el(
        "ul",
        { class: "issue-list" },
        issues.map((i) =>
          el("li", null, [dot("warn", typeof i === "string" ? i : String(i.message ?? "issue"))]),
        ),
      ),
    );
  }

  const pane = el("div", { class: "spec-pane" });
  pane.appendChild(
    el("div", { class: "spec-head" }, [
      el("span", { class: "muted", text: "crewhaus.yaml (values masked server-side)" }),
      copyBtn(yaml, "copy yaml"),
    ]),
  );
  pane.appendChild(
    yaml === "" ? emptyState("Spec is empty", "crewhaus init") : numberedCode(yaml, "spec yaml"),
  );

  root.appendChild(el("div", { class: "spec-layout" }, [pane, side]));
}
