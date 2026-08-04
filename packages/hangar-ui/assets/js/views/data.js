/**
 * Datasets — the dataset registry, its hygiene checks, and the growth verbs.
 *
 * Rules the screen carries rather than hides: a verify MISMATCH means
 * TAMPERED (not stale); `<spec>-ratings` and `<spec>-regressions` are
 * auto-maintained and invite no hand edit the next distill would overwrite;
 * the test split is locked to the release flow with a visible burn count;
 * and quarantined samples appear beside the registry with their provenance,
 * because a quarantined sample nobody can see is a bug nobody can file.
 *
 * `dataset audit` (registry integrity) and `dataset lint` (canary
 * contamination across specs and few-shot pools) answer different questions
 * and get different buttons.
 *
 * Every node is built with el() — markup strings are banned app-wide, so a
 * mined sample's text can never inject into this page.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { fmtCount, fmtRelativeTime } from "../util.js";

export async function renderData(root, ctx) {
  clear(root).appendChild(skeleton(4));
  const [registry, status, quarantine] = await Promise.all(
    [api.datasets, api.datasetStatus, api.datasetQuarantine].map((fn) =>
      fn({ id: ctx.id }).catch((err) => ({ ok: false, status: 0, body: { error: String(err) } })),
    ),
  );
  clear(root);
  const reload = () => renderData(root, ctx);
  root.appendChild(registryCard(ctx, registry, reload));
  root.appendChild(statusCard(status));
  root.appendChild(quarantineCard(quarantine));
  root.appendChild(hygieneCard(ctx));
  root.appendChild(growthCard(ctx, reload));
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

function payload(res) {
  return res && typeof res === "object" && res.body && typeof res.body === "object" ? res.body : {};
}

function panel(title, res, draw) {
  const data = payload(res);
  const card = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: title })]),
  ]);
  if (res && res.ok === false && data.present === undefined) {
    card.appendChild(el("p", { class: "muted", text: `unavailable (HTTP ${String(res.status)})` }));
    return card;
  }
  if (data.present === false) {
    card.appendChild(emptyState(String(data.note ?? "Nothing yet"), data.verb ?? null));
    return card;
  }
  if (typeof data.note === "string" && data.note !== "") {
    card.appendChild(el("p", { class: "muted", text: data.note }));
  }
  draw(card, data);
  return card;
}

function table(headers, rows) {
  return el("div", { class: "table-scroll" }, [
    el("table", { class: "fleet" }, [
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          headers.map((h) => el("th", { text: h })),
        ),
      ),
      el("tbody", null, rows),
    ]),
  ]);
}

function field(label, node) {
  return el("label", { class: "field" }, [el("span", { class: "kv-k", text: label }), node]);
}

function input(name, attrs) {
  return el("input", { class: "input", name, ...(attrs ?? {}) });
}

function readText(form, name) {
  const raw = form.elements[name]?.value?.trim();
  return raw ? raw : undefined;
}

async function call(fn, params, body) {
  return await fn(params, body).catch((err) => ({
    ok: false,
    status: 0,
    body: { error: String(err) },
  }));
}

/** Split sizes as one string, with the locked holdout marked. */
function splitsText(splits) {
  if (!splits) return "—";
  const test =
    splits.test === null || splits.test === undefined ? "no test" : `${splits.test} test 🔒`;
  return `${fmtCount(splits.train)} train · ${fmtCount(splits.dev)} dev · ${test}`;
}

/** Provenance is a TAXONOMY — render the tally, not a free-text note. */
function provenanceChips(tally) {
  const entries = Object.entries(tally ?? {});
  if (entries.length === 0) return el("span", { class: "muted", text: "—" });
  return el(
    "span",
    { class: "cell-caps" },
    entries.map(([source, count]) =>
      el("span", {
        // A canary sample among ordinary rows is what `dataset lint` hunts.
        class: source === "canary" || source === "(unlabelled)" ? "chip chip-warn" : "chip",
        text: `${source} ${String(count)}`,
      }),
    ),
  );
}

/** A verify result is binary and its language matters: a mismatch means the
 *  stored hashes no longer describe the content — TAMPERED, never "stale". */
function verifyDot(verify) {
  if (!verify) return dot("unknown", "not verified");
  return verify.ok ? dot("ok", "intact") : dot("bad", `tampered (${fmtCount(verify.mismatches)})`);
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

function registryCard(ctx, res, reload) {
  return panel("Dataset registry", res, (card, data) => {
    const rows = (data.datasets ?? []).map((row) =>
      el("tr", null, [
        el("td", null, [
          el("span", { class: "mono", text: String(row.name) }),
          row.autoMaintained
            ? el("span", {
                class: "chip chip-group",
                title: String(row.autoMaintained),
                text: "auto-maintained",
              })
            : null,
        ]),
        el("td", { class: "mono", text: String(row.latestVersion ?? "—") }),
        el("td", { text: splitsText(row.splits) }),
        el("td", null, [provenanceChips(row.provenance)]),
        el("td", null, [verifyDot(row.verify)]),
        el("td", { class: "num", text: fmtCount(row.testSplitBurn) }),
        el("td", { class: "cell-actions" }, [
          detailBtn(ctx, row.name),
          verifyBtn(ctx, row.name, reload),
        ]),
      ]),
    );
    card.appendChild(
      table(["Dataset", "Latest", "Splits", "Provenance", "Verify", "Holdout burn", ""], rows),
    );
    card.appendChild(
      el("p", {
        class: "muted",
        text: "The held-out test split is locked to the release flow; every spend is counted as a burn.",
      }),
    );
  });
}

function detailBtn(ctx, name) {
  const holder = el("div");
  const btn = el("button", { class: "btn btn-ghost", type: "button", text: "Versions" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const res = await call(api.dataset, { id: ctx.id, name: String(name) });
    btn.disabled = false;
    clear(holder);
    if (!res.ok) {
      toast(String(payload(res).error ?? `HTTP ${String(res.status)}`), "error");
      return;
    }
    const data = payload(res);
    if (data.present === false) {
      holder.appendChild(emptyState(String(data.note), data.verb ?? null));
      return;
    }
    holder.appendChild(
      table(
        ["Version", "Created", "Splits", "Verify", "Burn"],
        (data.versions ?? []).map((v) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(v.version) }),
            el("td", { text: fmtRelativeTime(v.createdAt, Date.now()) }),
            el("td", { text: splitsText(v.splits) }),
            el("td", null, [verifyDot(v.verify)]),
            el("td", { class: "num", text: fmtCount(v.burn?.count) }),
          ]),
        ),
      ),
    );
    if (data.testSplit) {
      holder.appendChild(el("p", { class: "gated-why", text: String(data.testSplit.note) }));
    }
  });
  return el("div", { class: "job-action" }, [btn, holder]);
}

function verifyBtn(ctx, name, reload) {
  const btn = el("button", { class: "btn btn-ghost", type: "button", text: "Verify" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const res = await call(api.datasetVerify, { id: ctx.id }, { name: String(name) });
    btn.disabled = false;
    if (!res.ok) {
      toast(String(payload(res).error ?? `HTTP ${String(res.status)}`), "error");
      return;
    }
    const tampered = payload(res).tampered ?? [];
    toast(
      tampered.length === 0
        ? `${String(name)}: every version matches its stored hashes`
        : `${String(name)}: TAMPERED — ${tampered.join(", ")}`,
      tampered.length === 0 ? "info" : "error",
    );
    if (reload) reload();
  });
  return btn;
}

// ---------------------------------------------------------------------------
// status + quarantine
// ---------------------------------------------------------------------------

function statusCard(res) {
  return panel("Freshness, saturation and burn", res, (card, data) => {
    card.appendChild(
      table(
        ["Dataset", "Version", "Age", "Runs", "Last run", "Always-passing", "Burn"],
        (data.datasets ?? []).map((row) => {
          const saturated = row.saturation?.alwaysPassing ?? [];
          return el("tr", null, [
            el("td", { class: "mono", text: String(row.name) }),
            el("td", { class: "mono", text: String(row.version) }),
            el("td", {
              class: "num",
              text: row.ageDays === null ? "—" : `${String(row.ageDays)}d`,
            }),
            el("td", { class: "num", text: fmtCount(row.runCount) }),
            el("td", { text: fmtRelativeTime(row.lastRunTs, Date.now()) }),
            el("td", null, [
              saturated.length === 0
                ? dot("ok", "discriminating")
                : dot("warn", `${String(saturated.length)} saturated`),
            ]),
            el("td", { class: "num", text: fmtCount(row.testSplitBurn) }),
          ]);
        }),
      ),
    );
  });
}

function quarantineCard(res) {
  return panel("Quarantine", res, (card, data) => {
    card.appendChild(
      table(
        ["Sample", "Source", "Why it was pulled", "File"],
        (data.entries ?? []).map((entry) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(entry.id ?? "—") }),
            el("td", null, [
              el("span", { class: "chip", text: String(entry.source ?? "(unlabelled)") }),
            ]),
            el("td", { class: "muted", text: String(entry.reason ?? entry.input ?? "") }),
            el("td", { class: "mono muted", text: String(entry.file) }),
          ]),
        ),
      ),
    );
    if (data.promoteVerb) {
      card.appendChild(
        el("p", { class: "muted" }, [
          el("span", { text: "Promote accepted candidates with " }),
          el("code", { text: String(data.promoteVerb) }),
        ]),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// hygiene — two DIFFERENT questions, two buttons
// ---------------------------------------------------------------------------

function hygieneCard(ctx) {
  const out = el("div");
  const card = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: "Hygiene" })]),
    el("p", {
      class: "muted",
      text: "Audit asks whether the registry is internally consistent. Lint asks whether canary samples have leaked into the spec or the few-shot pool. They are not the same check.",
    }),
  ]);

  const audit = el("button", { class: "btn btn-ghost", type: "button", text: "Audit registry" });
  audit.addEventListener("click", async () => {
    audit.disabled = true;
    const res = await call(api.datasetAudit, { id: ctx.id }, {});
    audit.disabled = false;
    clear(out);
    if (!res.ok) {
      toast(String(payload(res).error ?? `HTTP ${String(res.status)}`), "error");
      return;
    }
    const data = payload(res);
    const findings = data.findings ?? [];
    if (findings.length === 0) {
      out.appendChild(emptyState("No integrity findings", null));
      return;
    }
    out.appendChild(
      table(
        ["Level", "Dataset", "Version", "Finding"],
        findings.map((f) =>
          el("tr", null, [
            el("td", null, [
              dot(
                f.level === "error" ? "bad" : f.level === "warn" ? "warn" : "unknown",
                String(f.level),
              ),
            ]),
            el("td", { class: "mono", text: String(f.name) }),
            el("td", { class: "mono", text: String(f.version ?? "—") }),
            el("td", { text: String(f.finding) }),
          ]),
        ),
      ),
    );
  });

  const lint = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Scan for contamination",
  });
  lint.addEventListener("click", async () => {
    lint.disabled = true;
    const res = await call(api.datasetLint, { id: ctx.id }, {});
    lint.disabled = false;
    if (!res.ok) {
      toast(String(payload(res).error ?? `HTTP ${String(res.status)}`), "error");
      return;
    }
    toast("Contamination scan queued — watch the job feed", "info");
  });

  card.appendChild(el("div", { class: "editor-actions" }, [audit, lint]));
  card.appendChild(out);
  return card;
}

// ---------------------------------------------------------------------------
// growth — preview, THEN write
// ---------------------------------------------------------------------------

/**
 * Each growth verb adds rows to a dataset that later gates a release, so the
 * default is a preview: what would run, where it would write, and what
 * review still stands between the output and a gating dataset.
 */
function growthCard(ctx, reload) {
  const out = el("div");
  const form = el("form", { class: "row-editor" }, [
    field("dataset", input("name", { placeholder: "dataset name", required: true })),
    field(
      "verb",
      el(
        "select",
        { class: "input", name: "verb" },
        [
          ["mine", "mine hard cases from sessions"],
          ["synthesize", "synthesize stress variants"],
          ["refresh-goldens", "refresh goldens"],
        ].map(([value, label]) => el("option", { value, text: label })),
      ),
    ),
  ]);
  const preview = el("button", { class: "btn", type: "submit", text: "Preview" });
  form.appendChild(el("div", { class: "editor-actions" }, [preview]));

  const verbApi = {
    mine: api.datasetMine,
    synthesize: api.datasetSynthesize,
    "refresh-goldens": api.datasetRefreshGoldens,
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = readText(form, "name");
    const verb = form.elements["verb"].value;
    preview.disabled = true;
    const res = await call(verbApi[verb], { id: ctx.id }, { name, dryRun: true });
    preview.disabled = false;
    clear(out);
    if (!res.ok) {
      toast(String(payload(res).error ?? `HTTP ${String(res.status)}`), "error");
      return;
    }
    const data = payload(res);
    const plan = data.plan ?? {};
    out.appendChild(el("p", { class: "muted", text: String(data.note ?? "") }));
    out.appendChild(el("p", { class: "gated-why", text: String(plan.reviewGate ?? "") }));
    out.appendChild(
      collapsible(
        [el("span", { class: "muted", text: "what this will run and where it writes" })],
        [jsonPre({ argv: plan.argv ?? [], writes: plan.writes ?? [] })],
        true,
      ),
    );
    const run = el("button", {
      class: "btn btn-danger",
      type: "button",
      text: `Run ${verb} for real`,
    });
    run.addEventListener("click", async () => {
      run.disabled = true;
      const applied = await call(verbApi[verb], { id: ctx.id }, { name, dryRun: false });
      run.disabled = false;
      if (!applied.ok) {
        toast(String(payload(applied).error ?? `HTTP ${String(applied.status)}`), "error");
        return;
      }
      toast(`${verb} queued`, "info");
      if (reload) reload();
    });
    out.appendChild(el("div", { class: "editor-actions" }, [run]));
  });

  return el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: "Grow a dataset" })]),
    el("p", {
      class: "muted",
      text: "Mining stages candidates in quarantine; synthetic rows never become gold; refreshing goldens changes what correct means. Each previews first.",
    }),
    form,
    out,
  ]);
}
