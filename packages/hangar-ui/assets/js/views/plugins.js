/**
 * Settings › Plugins: each installed plugin, where it stands with you, and the
 * review where you choose what it may see (#522).
 *
 * A plugin's manifest asks; you allow; Home serves only what you allowed. The
 * review lists what the plugin asks for, one group per kind, unticked unless
 * the plugin was installed before plugins asked (then it is prefilled with what
 * it could see, under its own heading). These choices limit what CrewHaus hands
 * the plugin, not what its own code can do: a bundle that loads it runs its code
 * with the bundle's authority, and the screen says so.
 *
 * The review and its writes go through Home's versioned API (`plugins.review`,
 * `plugins.grant`, `plugins.revoke`). After a write, focus moves to the result's
 * heading; a 412 (someone changed the grant meanwhile) shows the fresh review
 * and keeps your ticks. DOM by createElement and textContent only.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, skeleton, statusBadge } from "../dom.js";
import { confirmAction } from "../ui/dialog.js";
import { normalizeRows } from "../util.js";
import { call, createAction } from "../v1.js";

/** The state words, never colour alone. */
export const STATE_WORDS = Object.freeze({
  waiting: "Waiting for your OK",
  allowed: "Allowed",
  "asks-for-more": "Asks for more",
  revoked: "Revoked",
});

const STATE_TONE = Object.freeze({
  waiting: "warn",
  allowed: "ok",
  "asks-for-more": "warn",
  revoked: "off",
});

/** The word and mark for a plugin's state. */
export function stateBadge(state) {
  return statusBadge(STATE_TONE[state] ?? "off", STATE_WORDS[state] ?? String(state ?? ""));
}

const LIMIT_SENTENCE =
  "These choices limit what CrewHaus hands this plugin. They do not limit what its own code can do: a harness that loads it runs its code with the harness's own access.";

const GROUPS = Object.freeze([
  { field: "panes", legend: "Tabs it may add" },
  { field: "events", legend: "Run activity it may receive" },
  { field: "reads", legend: "What it may read" },
  { field: "net", legend: "Websites its tabs may reach" },
  { field: "tools", legend: "Host tools its tools may use" },
]);

const asList = (value) => (Array.isArray(value) ? value.map(String) : []);

/** The ticks a review starts with: what is granted, or what it could see before (legacy). */
export function initialTicks(review) {
  const source = review?.granted ?? (review?.legacy === true ? review?.asks : null);
  const ticks = {};
  for (const { field } of GROUPS) ticks[field] = new Set(asList(source?.[field]));
  const harnesses = source?.harnesses;
  ticks.all = harnesses === "all";
  ticks.harnesses = new Set(harnesses === "all" ? [] : asList(harnesses));
  return ticks;
}

/** The grant request a set of ticks makes, with the generation the review read. */
export function grantBody(ticks, review) {
  const body = {
    harnesses: ticks.all === true ? "all" : [...ticks.harnesses],
  };
  for (const { field } of GROUPS) body[field] = [...ticks[field]];
  if (typeof review?.gen === "number") body.expect = review.gen;
  return body;
}

/** Settings › Plugins (`#/settings/plugins`). */
export async function renderPluginSettings(root) {
  clear(root).appendChild(skeleton(4));
  const [inventoryRes, feedRes] = await Promise.allSettled([api.plugins(), api.harnesses()]);
  clear(root);
  if (inventoryRes.status !== "fulfilled") {
    root.appendChild(
      el("section", { class: "card error-card" }, [
        el("h2", { text: "Plugins unavailable" }),
        el("p", {
          class: "muted",
          text: String(inventoryRes.reason?.message ?? "Home did not answer."),
        }),
      ]),
    );
    return;
  }
  const inventory = inventoryRes.value;
  const harnesses = feedRes.status === "fulfilled" ? normalizeRows(feedRes.value) : [];
  const plugins = Array.isArray(inventory?.plugins) ? inventory.plugins : [];
  root.appendChild(
    el("section", { class: "card" }, [
      el("h2", { class: "card-title", text: "Plugins" }),
      el("p", {
        class: "muted",
        text: "A plugin asks for what it wants to see. Nothing reaches it until you allow it here.",
      }),
      el("p", { class: "muted small", text: LIMIT_SENTENCE }),
      deferredList(inventory?.deferred),
    ]),
  );
  if (plugins.length === 0) {
    root.appendChild(emptyState("No plugins installed", "crewhaus plugins install <name>"));
    return;
  }
  for (const plugin of plugins) root.appendChild(pluginCard(plugin, harnesses));
}

/** The extension points this build accepts and does not run, with why: visible, never silent. */
function deferredList(deferred) {
  const rows = deferred && typeof deferred === "object" ? Object.entries(deferred) : [];
  if (rows.length === 0) return null;
  return el("ul", { class: "check-list" }, [
    el("li", {
      class: "muted",
      text: "Plugins may declare these, and this build does not run them yet:",
    }),
    ...rows.map(([point, reason]) =>
      el("li", null, [
        dot("off", point),
        el("span", { class: "muted", text: ` — ${String(reason)}` }),
      ]),
    ),
  ]);
}

function pluginCard(plugin, harnesses) {
  const name = String(plugin?.name ?? "");
  const problems = asList(plugin?.problems);
  const card = el("section", { class: "card plugin-card", "aria-label": name });
  const body = el("div");
  card.appendChild(
    el("div", { class: "rollup" }, [
      el("h3", { class: "card-title", text: name }),
      el("span", { class: "muted mono", text: String(plugin?.version ?? "") }),
      problems.length > 0 ? dot("bad", "Cannot be used") : stateBadge(plugin?.grant?.state),
    ]),
  );
  if (plugin?.description)
    card.appendChild(el("p", { class: "muted", text: String(plugin.description) }));
  if (problems.length > 0) {
    card.appendChild(el("p", { class: "muted", text: problems.join("; ") }));
    return card;
  }
  const review = el("button", { class: "btn btn-primary", type: "button", text: "Review" });
  review.addEventListener("click", async () => {
    review.disabled = true;
    await openReview(body, name, harnesses, null);
    review.disabled = false;
  });
  card.appendChild(
    el("div", { class: "actions" }, [review, twin(`crewhaus plugins grants ${name}`)]),
  );
  card.appendChild(body);
  return card;
}

function twin(command) {
  return el("p", { class: "muted small" }, [
    el("span", { text: "Same as " }),
    el("code", { text: command }),
  ]);
}

/** Load a review into `host`, keeping `keep` (ticks) when given, as after a 412. */
async function openReview(host, name, harnesses, keep, notice) {
  clear(host).appendChild(skeleton(3));
  const res = await call("plugins.review", { params: { plugin: name } });
  clear(host);
  if (!res.ok) {
    host.appendChild(
      el("p", {
        class: "muted",
        role: "status",
        text: res.error?.message ?? "The review could not be read.",
      }),
    );
    return;
  }
  host.appendChild(
    reviewForm(host, name, res.body, harnesses, keep ?? initialTicks(res.body), notice),
  );
}

function checkboxRow(label, checked, onChange, value) {
  const input = el("input", { type: "checkbox", value });
  input.checked = checked === true;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "check-row" }, [input, el("span", { text: label })]);
}

function reviewForm(host, name, review, harnesses, ticks, notice) {
  const form = el("form", { class: "plugin-review", "aria-label": `Review ${name}` });
  form.addEventListener("submit", (event) => event.preventDefault());
  const asks = review?.asks ?? {};
  form.appendChild(
    el("h4", {
      text:
        review?.legacy === true
          ? "Review what this plugin could see before"
          : "Choose what this plugin may see",
    }),
  );
  if (notice) form.appendChild(el("p", { class: "notice", role: "status", text: notice }));
  form.appendChild(
    el("p", { class: "muted small" }, [
      el("span", { text: `Version ${String(review?.version ?? "")}` }),
      el("span", { text: review?.signed === true ? " · Signed" : " · Not signed" }),
      review?.crewhausRange
        ? el("span", { text: ` · Runs on CrewHaus ${review.crewhausRange}` })
        : null,
    ]),
  );

  // Harnesses: every harness you can see, the ones it asked to see first.
  const asked = new Set(asList(asks.harnesses));
  const rows = [...harnesses].sort((a, b) => Number(asked.has(b.id)) - Number(asked.has(a.id)));
  const harnessSet = el("fieldset", null, [el("legend", { text: "Harnesses it may see" })]);
  harnessSet.appendChild(
    checkboxRow("All harnesses, now and later", ticks.all, (on) => {
      ticks.all = on;
    }),
  );
  for (const row of rows) {
    const label = `${String(row.specName ?? row.id)}${asked.has(row.id) ? " (asked for)" : ""}`;
    harnessSet.appendChild(
      checkboxRow(
        label,
        ticks.harnesses.has(row.id),
        (on) => (on ? ticks.harnesses.add(row.id) : ticks.harnesses.delete(row.id)),
        row.id,
      ),
    );
  }
  if (rows.length === 0)
    harnessSet.appendChild(el("p", { class: "muted", text: "No harnesses yet." }));
  form.appendChild(harnessSet);

  for (const { field, legend } of GROUPS) {
    const values = asList(asks[field]);
    const set = el("fieldset", null, [el("legend", { text: legend })]);
    if (values.length === 0)
      set.appendChild(el("p", { class: "muted", text: "It asks for none." }));
    for (const value of values) {
      set.appendChild(
        checkboxRow(
          value,
          ticks[field].has(value),
          (on) => (on ? ticks[field].add(value) : ticks[field].delete(value)),
          value,
        ),
      );
    }
    form.appendChild(set);
  }

  const envNames = asList(review?.envNames);
  if (envNames.length > 0) {
    form.appendChild(
      el("p", { class: "muted" }, [
        el("span", { text: "It says it reads these settings: " }),
        el("code", { text: envNames.join(", ") }),
      ]),
    );
  }
  form.appendChild(el("p", { class: "muted small", text: LIMIT_SENTENCE }));

  const result = el("div");
  const allow = el("button", { class: "btn btn-primary", type: "button", text: "Allow selected" });
  const notNow = el("button", { class: "btn btn-ghost", type: "button", text: "Not now" });
  const actions = [allow, notNow];
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    const res = await createAction("plugins.grant", { params: { plugin: name } }).run({
      body: grantBody(ticks, review),
    });
    allow.disabled = false;
    if (res.status === 412) {
      await openReview(
        host,
        name,
        harnesses,
        ticks,
        "Someone changed this plugin's access meanwhile. This is the latest; your choices are kept. Send them again when ready.",
      );
      return;
    }
    showResult(result, res, res.ok ? "Allowed" : "Not allowed");
  });
  notNow.addEventListener("click", () => {
    clear(host);
  });
  if (typeof review?.gen === "number") {
    const remove = el("button", { class: "btn btn-danger", type: "button", text: "Remove access" });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      const res = await createAction("plugins.revoke", { params: { plugin: name } }).run({
        body: {},
      });
      remove.disabled = false;
      showResult(result, res, res.ok ? "Access removed" : "Access not removed");
    });
    actions.push(remove);
  }
  form.appendChild(el("div", { class: "actions" }, actions));
  form.appendChild(
    el("p", { class: "muted small" }, [
      el("span", { text: "On the command line: " }),
      el("code", { text: `crewhaus plugins grant ${name}` }),
      el("span", { text: " with --harness, --panes, --events, --reads, --net and --tools; " }),
      el("code", { text: `crewhaus plugins revoke ${name}` }),
      el("span", { text: " removes it." }),
    ]),
  );
  form.appendChild(result);
  return form;
}

function showResult(host, res, title) {
  clear(host);
  const heading = el("h4", { tabindex: "-1", text: title });
  host.appendChild(heading);
  host.appendChild(
    el("p", {
      class: "muted",
      role: "status",
      text: res.ok
        ? "Saved. Home serves this plugin only what you allowed."
        : (res.error?.message ?? "Home did not take it."),
    }),
  );
  heading.focus();
}

/**
 * Setup › Plugins' "Use in this harness": choose which host tools the plugin's
 * tools may use here, see the change to crewhaus.yaml, then type the spec's name.
 * It always writes `{name, tools}`: a bare name would let the plugin use every
 * host tool it asks for.
 */
export function useInHarness(ctx, plugin, servedTools, reload) {
  const name = String(plugin?.name ?? "");
  const chosen = new Set();
  const set = el("fieldset", null, [el("legend", { text: `Host tools ${name} may use here` })]);
  if (servedTools.length === 0) {
    set.appendChild(el("p", { class: "muted", text: "None allowed: it gets no host tools here." }));
  }
  for (const tool of servedTools) {
    set.appendChild(
      checkboxRow(tool, false, (on) => (on ? chosen.add(tool) : chosen.delete(tool)), tool),
    );
  }
  const go = el("button", {
    class: "btn btn-primary",
    type: "button",
    text: "Use in this harness",
  });
  go.addEventListener("click", async () => {
    go.disabled = true;
    const tools = [...chosen];
    const plan = await api.pluginUseWrite({ id: ctx.id, name }, { tools });
    go.disabled = false;
    if (!plan.ok || plan.body?.ok === false) {
      host.textContent = String(plan.body?.error ?? plan.body?.reason ?? `HTTP ${plan.status}`);
      return;
    }
    const confirmName = String(plan.body?.confirmName ?? "");
    confirmAction({
      level: "typed",
      title: `Use ${name} in this harness`,
      lead: "Review the change to crewhaus.yaml, then type the spec's name.",
      detail: [el("pre", { class: "mono", text: String(plan.body?.diff ?? "") })],
      confirmName,
      action: "Write it to the spec",
      onConfirm: async () => {
        const res = await api.pluginUseWrite(
          { id: ctx.id, name },
          { tools, dryRun: false, confirmName, expectedRev: String(plan.body?.rev ?? "") },
        );
        host.textContent = res.ok
          ? `${name} is in this harness's plugins: list.`
          : String(res.body?.error ?? `HTTP ${res.status}`);
        if (res.ok) reload?.();
      },
    });
  });
  const host = el("p", { class: "muted", role: "status" });
  return el("div", { class: "plugin-use" }, [
    set,
    go,
    el("p", {
      class: "muted small",
      text: "No command-line equivalent: edit plugins: in crewhaus.yaml.",
    }),
    host,
  ]);
}
