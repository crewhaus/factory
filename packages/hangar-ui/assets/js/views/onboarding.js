/**
 * HM-12 — first boot.
 *
 * An empty Library looks broken and teaches nothing, so the Library hands
 * over to this screen when there is nothing registered and no scan root
 * configured. Two paths out, both showing the command they run:
 *
 *   - point the manager at a directory and scan it;
 *   - install a demo starter out of a local demos checkout.
 *
 * Demo mode is honest about needing that checkout. With none configured the
 * card says so and names the repo, the environment variable and the CLI verb
 * — which teaches more than a spinner that ends in a network error would.
 */

import { api } from "../api.js";
import { clear, copyBtn, dot, el, emptyState, skeleton, toast } from "../dom.js";

/** One "here is the command" line — the CLI-twin discipline, on a screen an
 *  operator sees before they have run anything. */
function twin(command) {
  return el("div", { class: "twin" }, [
    el("code", { class: "mono", text: command }),
    copyBtn(command),
  ]);
}

export async function renderOnboarding(root, opts = {}) {
  const reload = opts.reload ?? (() => {});
  clear(root).appendChild(skeleton(5));
  let view = null;
  try {
    view = await api.onboarding();
  } catch (err) {
    clear(root).appendChild(
      el("div", { class: "card error-card" }, [
        el("h2", { text: "Could not read the first-boot state" }),
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  clear(root);
  const twins = view?.cliTwins && typeof view.cliTwins === "object" ? view.cliTwins : {};
  root.appendChild(
    el("div", { class: "card" }, [
      el("h2", { text: "Welcome to Hangar" }),
      el("p", {
        class: "muted",
        text: "Hangar manages the harnesses on this machine. Point it at a directory, or install a demo — either way it registers what it finds and nothing else.",
      }),
    ]),
  );
  root.appendChild(scanRootCard(view, twins, reload));
  root.appendChild(demoCard(view, twins, reload));
  root.appendChild(manualCard(twins, reload));
}

function scanRootCard(view, twins, reload) {
  const suggestions = Array.isArray(view?.suggestions) ? view.suggestions : [];
  const card = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "1 · Where do your harnesses live?" }),
    el("p", {
      class: "muted",
      text: "A scan root is walked for crewhaus.yaml files. Adding one registers what it finds; it never writes inside a harness.",
    }),
  ]);
  if (suggestions.length === 0) {
    card.appendChild(emptyState("No suggestions on this machine", twins.addScanRoot));
  } else {
    card.appendChild(
      el(
        "ul",
        { class: "check-list" },
        suggestions.map((s) =>
          el("li", { class: "suggest-row" }, [
            dot(s?.exists ? "ok" : "unknown", s?.exists ? "exists" : "not created yet"),
            el("code", { class: "mono", text: String(s?.dir ?? "") }),
            el("span", { class: "muted", text: String(s?.why ?? "") }),
            el("button", {
              class: "btn",
              type: "button",
              text: "Add + scan",
              onClick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  await api.addScanRoot(String(s?.dir ?? ""));
                  const result = await api.scan();
                  toast(
                    `Scanned: ${result?.discovered ?? 0} harness(es) found, ${result?.added ?? 0} newly registered`,
                    "info",
                  );
                  reload();
                } catch (err) {
                  button.disabled = false;
                  toast(err instanceof Error ? err.message : String(err), "error");
                }
              },
            }),
          ]),
        ),
      ),
    );
  }
  const field = el("input", {
    class: "input mono grow",
    type: "text",
    placeholder: "/an/absolute/path",
    "aria-label": "scan root path",
  });
  card.appendChild(
    el("div", { class: "add-form" }, [
      field,
      el("button", {
        class: "btn",
        type: "button",
        text: "Add this root",
        onClick: async () => {
          const dir = field.value.trim();
          if (dir === "") return;
          try {
            await api.addScanRoot(dir);
            await api.scan();
            reload();
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), "error");
          }
        },
      }),
    ]),
  );
  // `harness scan --root <dir>` is the real twin for this card's two
  // buttons: the CLI remembers the root it was handed before it walks it,
  // which is exactly "add + scan". There is no `harness scan-root` verb.
  card.appendChild(twin(twins.addScanRoot ?? "crewhaus harness scan --root <dir>"));
  card.appendChild(twin(twins.scan ?? "crewhaus harness scan"));
  return card;
}

function demoCard(view, twins, reload) {
  const demo = view?.demo && typeof view.demo === "object" ? view.demo : {};
  const card = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "2 · Or start from a demo" }),
  ]);
  if (demo.available !== true) {
    card.appendChild(
      el("div", { class: "empty" }, [
        dot("unknown", "demo mode is unavailable"),
        el("div", { class: "empty-msg", text: String(demo.reason ?? "no demos checkout found") }),
        el("div", { class: "empty-verb muted", text: String(demo.remedy ?? "") }),
      ]),
    );
    card.appendChild(twin("git clone https://github.com/crewhaus/demos"));
    card.appendChild(twin("crewhaus init <dir>"));
    return card;
  }
  const starters = Array.isArray(demo.starters) ? demo.starters : [];
  const select = el(
    "select",
    { class: "input", "aria-label": "starter" },
    starters.map((name) => el("option", { value: name, text: name })),
  );
  const dest = el("input", {
    class: "input mono grow",
    type: "text",
    placeholder: "/an/absolute/path/for/the/demo",
    "aria-label": "install directory",
  });
  card.appendChild(
    el("p", {
      class: "muted",
      text: `Copies one starter out of ${String(demo.source ?? "the demos checkout")} into a new directory and registers it. Nothing is downloaded, and an existing directory is never written over.`,
    }),
  );
  card.appendChild(
    el("div", { class: "add-form" }, [
      select,
      dest,
      el("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Install demo",
        onClick: async (event) => {
          const button = event.currentTarget;
          const dir = dest.value.trim();
          if (dir === "") {
            toast("Give an absolute path for the demo", "error");
            return;
          }
          button.disabled = true;
          const res = await api.demoInstall(select.value, dir);
          button.disabled = false;
          if (res.ok !== true) {
            toast(
              `${String(res.body?.message ?? "refused")} — ${String(res.body?.remedy ?? "")}`,
              "error",
            );
            return;
          }
          toast(`Installed ${select.value} into ${dir}`, "info");
          reload();
        },
      }),
    ]),
  );
  card.appendChild(twin(twins.demo ?? "cp -R <demos>/starters/<starter> <dir>"));
  return card;
}

function manualCard(twins, reload) {
  const field = el("input", {
    class: "input mono grow",
    type: "text",
    placeholder: "/path/to/an/existing/harness",
    "aria-label": "harness directory",
  });
  return el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "3 · Already have one? Register it directly" }),
    el("div", { class: "add-form" }, [
      field,
      el("button", {
        class: "btn",
        type: "button",
        text: "Register",
        onClick: async () => {
          const dir = field.value.trim();
          if (dir === "") return;
          try {
            await api.addHarness(dir);
            reload();
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), "error");
          }
        },
      }),
    ]),
    twin(twins.addHarness ?? "crewhaus harness add <dir>"),
  ]);
}

/**
 * Should the Library hand over to onboarding? Pure, so the rule is testable:
 * only when there is genuinely nothing — no registered harness AND no scan
 * root. A machine with a root configured but nothing found is NOT first
 * boot; it is an empty scan, and the Library's own empty state (which names
 * the scan verb) is the honest answer there.
 */
export function shouldOnboard(view, harnessCount) {
  if (harnessCount > 0) return false;
  if (!view || typeof view !== "object") return false;
  return view.firstBoot === true;
}
