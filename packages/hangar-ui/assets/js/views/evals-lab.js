/**
 * Evals — the M3 half of the Evals tab: the typed launcher, matrix runs, CI
 * suites, trends, the sample-size planner, judge calibration, grader
 * quality, redteam, coverage, the drift sentinel, voice replays, the
 * optimizer, the flywheel, experiments, and the annotation → distill join.
 *
 * The M1/M2 surface (`views/evals.js`: run history, drill-down, baselines)
 * stays where it is and is rendered above this.
 *
 * Rules this screen must not break, because each one turns a measurement
 * into a false alarm:
 *   - a PARTIAL run renders deflated and is never charted as a regression;
 *   - a REPLAYED run is badged not-live;
 *   - trends split agent spend from judge spend — the judge frequently costs
 *     more than the thing it is judging;
 *   - a matrix cell's crash class decides whether Retry is even offered: a
 *     billing failure is NOT retryable, however much it looks like a 429;
 *   - spending the locked test split is a typed, visible gesture.
 *
 * Every node is built with el()/text() — markup strings are banned app-wide,
 * so nothing a grader, a model or a provider wrote can inject into this page.
 */

import { api } from "../api.js";
import { asOf, clear, collapsible, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { fmtCount, fmtPct, fmtRelativeTime, fmtUsd } from "../util.js";

export async function renderEvalsLab(root, ctx) {
  clear(root).appendChild(skeleton(4));
  const [
    trends,
    matrix,
    suites,
    judge,
    graders,
    redteam,
    coverage,
    sentinel,
    voice,
    optimize,
    flywheel,
    experiments,
    annotations,
  ] = await Promise.all(
    [
      api.evalTrends,
      api.evalMatrix,
      api.evalSuites,
      api.judgeCalibration,
      api.graderCards,
      api.redteam,
      api.evalCoverage,
      api.sentinel,
      api.voiceEvals,
      api.optimizer,
      api.flywheel,
      api.experiments,
      api.annotations,
    ].map((fn) => fn({ id: ctx.id }).catch((err) => ({ ok: false, status: 0, body: { err } }))),
  );
  clear(root);
  const reload = () => renderEvalsLab(root, ctx);
  root.appendChild(launcherCard(ctx, flywheel, reload));
  root.appendChild(trendsCard(trends));
  root.appendChild(matrixCard(ctx, matrix));
  root.appendChild(suitesCard(ctx, suites, reload));
  root.appendChild(plannerCard(ctx));
  root.appendChild(judgeCard(ctx, judge, reload));
  root.appendChild(gradersCard(ctx, graders, reload));
  root.appendChild(redteamCard(ctx, redteam, reload));
  root.appendChild(coverageCard(ctx, coverage, reload));
  root.appendChild(sentinelCard(ctx, sentinel, reload));
  if (payload(voice).applicable === true) root.appendChild(voiceCard(voice));
  root.appendChild(optimizerCard(ctx, optimize, reload));
  root.appendChild(flywheelCard(ctx, flywheel, reload));
  root.appendChild(experimentsCard(ctx, experiments, reload));
  root.appendChild(annotationsCard(annotations));
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

/** The `{ok, status, body}` envelope's payload, tolerant of a failed call. */
function payload(res) {
  return res && typeof res === "object" && res.body && typeof res.body === "object" ? res.body : {};
}

/** A card whose body is only drawn when the server said something IS there;
 *  otherwise the standard empty state, which always names the verb. */
function panel(title, res, draw, extraHead) {
  const data = payload(res);
  const card = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: title }), extraHead ?? null]),
  ]);
  if (res && res.ok === false && res.status !== 0 && data.present === undefined) {
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

function stat(label, value) {
  return el("div", { class: "mini" }, [
    el("div", { class: "mini-num", text: value }),
    el("div", { class: "mini-label", text: label }),
  ]);
}

function field(label, node) {
  return el("label", { class: "field" }, [el("span", { class: "kv-k", text: label }), node]);
}

function input(name, attrs) {
  return el("input", { class: "input", name, ...(attrs ?? {}) });
}

function readNumber(form, name) {
  const raw = form.elements[name]?.value?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function readText(form, name) {
  const raw = form.elements[name]?.value?.trim();
  return raw ? raw : undefined;
}

/** Post an M3 write and report BOTH outcomes — no write ever fails silently,
 *  and a refusal is rendered as the payload it is, not swallowed. */
async function submit(fn, params, body, okMessage, reload) {
  const res = await fn(params, body).catch((err) => ({
    ok: false,
    status: 0,
    body: { error: String(err) },
  }));
  if (!res.ok) {
    toast(refusalText(res), "error");
    return res;
  }
  toast(okMessage, "info");
  if (reload) reload();
  return res;
}

function refusalText(res) {
  const body = payload(res);
  const raw = typeof body.error === "string" ? body.error : "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return `${parsed.error}${parsed.route ? ` — use ${parsed.route}` : ""}`;
    }
  } catch {
    // not a structured refusal — fall through to the raw message
  }
  return raw || `HTTP ${String(res.status)}`;
}

// ---------------------------------------------------------------------------
// the launcher
// ---------------------------------------------------------------------------

/**
 * Conventional paths default from the harness dir, so the common launch is
 * one click. `--allow-test-split` is deliberately NOT a checkbox beside the
 * others: it spends a held-out split, the spend is counted as a burn, and the
 * server refuses it unless the release confirmation rides along.
 */
function launcherCard(ctx, flywheelRes, reload) {
  const form = el("form", { class: "row-editor" }, [
    field("dataset", input("dataset", { placeholder: "eval/dataset.jsonl (default)" })),
    field("graders", input("graders", { placeholder: "eval/graders.yaml (default)" })),
    field("repeats", input("repeats", { type: "number", min: "1", placeholder: "1" })),
    field("seed", input("seed", { type: "number", min: "1", placeholder: "—" })),
    field("budget $", input("budgetUsd", { type: "number", step: "0.01", placeholder: "—" })),
    field("models (comma separated)", input("models", { placeholder: "matrix run" })),
  ]);
  const gate = el("input", { type: "checkbox", name: "gate" });
  const holdout = el("input", { type: "checkbox", name: "allowTestSplit" });
  const confirmField = el("div", { class: "gated" }, [
    el("span", {
      class: "gated-why",
      text: 'spending the held-out split is a release gesture — type "release" to confirm',
    }),
    input("releaseConfirm", { placeholder: "release" }),
  ]);
  confirmField.hidden = true;
  holdout.addEventListener("change", () => {
    confirmField.hidden = !holdout.checked;
  });
  form.appendChild(el("label", { class: "check" }, [gate, el("span", { text: " gate this run" })]));
  form.appendChild(
    el("label", { class: "check" }, [
      holdout,
      el("span", { text: " spend the locked test split (recorded as a burn)" }),
    ]),
  );
  form.appendChild(confirmField);

  const run = el("button", { class: "btn btn-primary", type: "submit", text: "Run eval" });
  form.appendChild(el("div", { class: "editor-actions" }, [run]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const models = readText(form, "models");
    const body = {
      ...(readText(form, "dataset") ? { dataset: readText(form, "dataset") } : {}),
      ...(readText(form, "graders") ? { graders: readText(form, "graders") } : {}),
      ...(readNumber(form, "repeats") ? { repeats: readNumber(form, "repeats") } : {}),
      ...(readNumber(form, "seed") ? { seed: readNumber(form, "seed") } : {}),
      ...(readNumber(form, "budgetUsd") ? { budgetUsd: readNumber(form, "budgetUsd") } : {}),
      ...(models
        ? {
            models: models
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean),
          }
        : {}),
      ...(gate.checked ? { gate: true } : {}),
      ...(holdout.checked ? { allowTestSplit: true } : {}),
      ...(holdout.checked && readText(form, "releaseConfirm") === "release"
        ? { releaseConfirm: true }
        : {}),
    };
    run.disabled = true;
    const res = await submit(api.evalLaunch, { id: ctx.id }, body, "Eval queued", null);
    run.disabled = false;
    if (res.ok) {
      const warnings = Array.isArray(payload(res).warnings) ? payload(res).warnings : [];
      for (const w of warnings) toast(String(w), "info");
      if (reload) reload();
    }
  });

  const card = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: "Launch an eval" })]),
    el("p", {
      class: "muted",
      text: "Conventional paths default from the harness directory; progress streams on the run feed.",
    }),
    form,
  ]);
  // The dataset-precedence trap belongs here, where a launch is composed: a
  // conventional eval/dataset.jsonl SILENTLY wins over registry:<spec>-ratings.
  const precedence = payload(flywheelRes).datasetPrecedence;
  if (precedence && precedence.shadowing === true) {
    card.appendChild(
      el("p", { class: "gated-why" }, [dot("warn", "dataset precedence"), text(precedence.note)]),
    );
  }
  return card;
}

// ---------------------------------------------------------------------------
// trends
// ---------------------------------------------------------------------------

function trendsCard(res) {
  return panel("Trends", res, (card, data) => {
    const spend = data.spend ?? {};
    card.appendChild(
      el("div", { class: "mini-row" }, [
        stat("agent spend", fmtUsd(spend.agentUsd ?? null)),
        stat("judge spend", fmtUsd(spend.judgeUsd ?? null)),
        stat("judge share", typeof spend.judgeShare === "number" ? fmtPct(spend.judgeShare) : "—"),
      ]),
    );
    card.appendChild(
      el("p", {
        class: "muted",
        text: "Agent and judge spend are reported apart — one blended number hides which of the two is worth cutting.",
      }),
    );
    for (const series of data.series ?? []) {
      const rows = (series.points ?? []).map((p) =>
        el("tr", { class: p.partial === true ? "folded" : null }, [
          el("td", { class: "mono", text: String(p.runId ?? "") }),
          el("td", { text: fmtRelativeTime(p.ts, Date.now()) }),
          el("td", null, [dot(p.partial === true ? "unknown" : "ok", fmtPct(p.passRate))]),
          el("td", { class: "num", text: fmtScore(p.meanScore) }),
          el("td", { class: "num", text: fmtUsd(p.agentCostUsd) }),
          el("td", { class: "num", text: fmtUsd(p.judgeCostUsd) }),
          el("td", { class: "cell-caps" }, [
            p.partial === true
              ? el("span", {
                  class: "chip chip-warn",
                  title: "ended early — its figures read deflated and never move the trend",
                  text: "partial",
                })
              : null,
            p.replayed === true
              ? el("span", {
                  class: "chip",
                  title:
                    "every tool result came from a cassette — not a measurement of the live system",
                  text: "not live",
                })
              : null,
            p.pinned === true ? el("span", { class: "chip chip-group", text: "baseline" }) : null,
          ]),
        ]),
      );
      card.appendChild(
        collapsible(
          [
            el("span", { class: "mono", text: `${series.specName} / ${series.datasetName}` }),
            el("span", {
              class: "muted",
              text: ` ${fmtCount(series.measuredCount)} measured${
                series.partialCount ? ` · ${String(series.partialCount)} partial` : ""
              }${
                typeof series.deltaPp === "number"
                  ? ` · ${series.deltaPp >= 0 ? "+" : ""}${series.deltaPp.toFixed(1)}pp`
                  : " · no trend yet"
              }`,
            }),
          ],
          [table(["Run", "When", "Pass", "Mean", "Agent $", "Judge $", "Flags"], rows)],
          true,
        ),
      );
    }
  });
}

function fmtScore(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

/**
 * Matrix cells live outside run history. The crash CLASS is the actionable
 * part: billing and systemic failures get their remedy, never a Retry button
 * — re-running a quota exhaustion just spends another minute proving it.
 */
function matrixCard(ctx, res) {
  return panel("Model matrix", res, (card, data) => {
    const rows = (data.cells ?? []).map((cell) => {
      const crash = cell.crash;
      return el("tr", null, [
        el("td", { class: "mono", text: String(cell.model ?? "") }),
        el("td", null, [
          crash
            ? dot(crash.retryable ? "warn" : "bad", crash.kind)
            : dot("ok", fmtPct(cell.passRate)),
        ]),
        el("td", { class: "num", text: fmtScore(cell.meanScore) }),
        el("td", { class: "num", text: fmtCount(cell.sampleCount) }),
        el("td", { class: "num", text: fmtUsd(cell.costPer1kSamplesUsd) }),
        el("td", { class: "muted", text: crash ? String(crash.remedy) : "" }),
        el("td", { class: "cell-actions" }, [
          crash?.retryable
            ? retryCellBtn(ctx, cell)
            : crash
              ? el("span", {
                  class: "chip chip-warn",
                  title: "re-running cannot change this outcome",
                  text: "not retryable",
                })
              : null,
        ]),
      ]);
    });
    card.appendChild(
      table(["Model", "Verdict", "Mean", "Samples", "Est $/1k", "Remedy", ""], rows),
    );
    for (const root of data.roots ?? []) {
      card.appendChild(
        el("p", { class: "muted" }, [
          el("span", { class: "mono", text: String(root.root) }),
          asOf(root.generatedAt) ?? null,
        ]),
      );
    }
  });
}

function retryCellBtn(ctx, cell) {
  const btn = el("button", { class: "btn btn-ghost", type: "button", text: "Re-run cell" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await submit(
      api.evalLaunch,
      { id: ctx.id },
      { models: [String(cell.model)] },
      "Cell re-queued",
      null,
    );
    btn.disabled = false;
  });
  return btn;
}

// ---------------------------------------------------------------------------
// CI suites
// ---------------------------------------------------------------------------

function suitesCard(ctx, res, reload) {
  const runner = el("form", { class: "row-editor" }, [
    field("suite", input("suite", { placeholder: "eval/suite.yaml", required: true })),
    field(
      "tier",
      el(
        "select",
        { class: "input", name: "tier" },
        ["fast", "nightly", "release"].map((t) => el("option", { value: t, text: t })),
      ),
    ),
  ]);
  const go = el("button", { class: "btn", type: "submit", text: "Run suite" });
  runner.appendChild(el("div", { class: "editor-actions" }, [go]));
  runner.addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    await submit(
      api.evalSuiteRun,
      { id: ctx.id },
      { suite: readText(runner, "suite"), tier: runner.elements["tier"].value },
      "Suite queued",
      reload,
    );
    go.disabled = false;
  });

  const card = panel("CI suites", res, (node, data) => {
    for (const suite of data.suites ?? []) {
      const rows = (suite.entries ?? []).map((entry) =>
        el("tr", null, [
          el("td", { class: "mono", text: String(entry.name) }),
          el("td", null, [dot(entry.passed ? "ok" : "bad", entry.passed ? "pass" : "fail")]),
          el("td", { class: "num", text: fmtPct(entry.passRate) }),
          el("td", { class: "num", text: fmtScore(entry.meanScore) }),
          el("td", {
            class: "muted",
            text: [
              entry.minPassRate != null ? `min pass ${fmtPct(entry.minPassRate)}` : "",
              entry.minMeanScore != null ? `min score ${fmtScore(entry.minMeanScore)}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }),
          el("td", { class: "cell-caps" }, [
            entry.partial === true
              ? el("span", {
                  class: "chip chip-warn",
                  title: "a partial entry always fails — its aborted samples counted as errors",
                  text: "partial ⇒ fail",
                })
              : null,
          ]),
        ]),
      );
      node.appendChild(
        collapsible(
          [
            dot(suite.passed ? "ok" : "bad", `${suite.tier} tier`),
            el("span", { class: "muted", text: ` ${String(suite.dir)}` }),
          ],
          [table(["Entry", "Verdict", "Pass", "Mean", "Floors", ""], rows)],
          suite.passed !== true,
        ),
      );
    }
  });
  card.appendChild(runner);
  return card;
}

// ---------------------------------------------------------------------------
// the sample-size planner
// ---------------------------------------------------------------------------

/** Pure offline arithmetic — nothing runs and nothing is written, which is
 *  exactly why it can be asked BEFORE spending anything. */
function plannerCard(ctx) {
  const out = el("div", { class: "mini-row" });
  const form = el("form", { class: "row-editor" }, [
    field(
      "delta to detect",
      input("targetDelta", { type: "number", step: "0.01", value: "0.05", required: true }),
    ),
    field(
      "measured base rate",
      input("baseRate", { type: "number", step: "0.01", placeholder: "0.5" }),
    ),
  ]);
  const go = el("button", { class: "btn", type: "submit", text: "Plan" });
  form.appendChild(el("div", { class: "editor-actions" }, [go]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      targetDelta: readNumber(form, "targetDelta"),
      ...(readNumber(form, "baseRate") !== undefined
        ? { baseRate: readNumber(form, "baseRate") }
        : {}),
    };
    const res = await api
      .evalPlan({ id: ctx.id }, body)
      .catch((err) => ({ ok: false, status: 0, body: { error: String(err) } }));
    clear(out);
    if (!res.ok) {
      toast(refusalText(res), "error");
      return;
    }
    const data = payload(res);
    out.appendChild(stat("samples needed", fmtCount(data.samples)));
    out.appendChild(stat("confidence", fmtPct(data.confidence)));
    out.appendChild(stat("formula", String(data.formula ?? "")));
    if (data.caveat) out.appendChild(el("p", { class: "muted", text: String(data.caveat) }));
  });
  return el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: "Sample-size planner" })]),
    el("p", {
      class: "muted",
      text: "How many samples it takes to detect a delta. Offline arithmetic — no run, no cost.",
    }),
    form,
    out,
  ]);
}

// ---------------------------------------------------------------------------
// judge calibration + graders
// ---------------------------------------------------------------------------

function judgeCard(ctx, res, reload) {
  const card = panel("Judge calibration", res, (node, data) => {
    node.appendChild(
      table(
        ["Spec", "Cut", "Judge model", "Calibrated"],
        (data.specs ?? []).map((s) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(s.spec) }),
            el("td", { class: "num", text: fmtScore(s.cut) }),
            el("td", { class: "mono", text: String(s.judgeModel ?? "—") }),
            el("td", { text: fmtRelativeTime(s.calibratedAt, Date.now()) }),
          ]),
        ),
      ),
    );
  });
  const preview = el("button", { class: "btn btn-ghost", type: "button", text: "Preview ROC cut" });
  preview.addEventListener("click", async () => {
    preview.disabled = true;
    await submit(api.judgeCalibrate, { id: ctx.id }, {}, "Calibration preview queued", reload);
    preview.disabled = false;
  });
  const apply = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "Calibrate + apply",
  });
  apply.addEventListener("click", async () => {
    if (
      !window.confirm("Applying a calibration changes how every LATER run is scored. Continue?")
    ) {
      return;
    }
    apply.disabled = true;
    await submit(
      api.judgeCalibrate,
      { id: ctx.id },
      { apply: true, confirm: true },
      "Calibration queued",
      reload,
    );
    apply.disabled = false;
  });
  card.appendChild(el("div", { class: "editor-actions" }, [preview, apply]));
  return card;
}

function gradersCard(ctx, res, reload) {
  const card = panel("Grader quality", res, (node, data) => {
    node.appendChild(
      table(
        ["Kind", "Name", "Judge model", "Runs", "Datasets"],
        (data.graders ?? []).map((g) =>
          el("tr", null, [
            el("td", { text: String(g.kind) }),
            el("td", { class: "mono", text: String(g.name ?? g.gradersHash ?? "") }),
            el("td", { class: "mono", text: String(g.judgeModel ?? "—") }),
            el("td", { class: "num", text: fmtCount(g.runs) }),
            el("td", { class: "muted", text: (g.datasets ?? []).join(", ") }),
          ]),
        ),
      ),
    );
    if (data.gradersFile) {
      node.appendChild(el("p", { class: "muted mono", text: String(data.gradersFile) }));
    }
  });
  const suggest = el("button", { class: "btn btn-ghost", type: "button", text: "Suggest graders" });
  suggest.addEventListener("click", async () => {
    suggest.disabled = true;
    await submit(api.gradersSuggest, { id: ctx.id }, {}, "Grader draft queued (advisory)", reload);
    suggest.disabled = false;
  });
  const meta = el("button", { class: "btn btn-ghost", type: "button", text: "Meta-eval graders" });
  meta.addEventListener("click", async () => {
    meta.disabled = true;
    await submit(api.gradersTest, { id: ctx.id }, { golden: true }, "Meta-eval queued", reload);
    meta.disabled = false;
  });
  card.appendChild(el("div", { class: "editor-actions" }, [suggest, meta]));
  return card;
}

// ---------------------------------------------------------------------------
// redteam, coverage, sentinel, voice
// ---------------------------------------------------------------------------

function redteamCard(ctx, res, reload) {
  const card = panel("Redteam", res, (node, data) => {
    node.appendChild(
      el("div", { class: "mini-row" }, [
        stat(
          "attack success",
          typeof data.latestAttackSuccessRate === "number"
            ? fmtPct(data.latestAttackSuccessRate)
            : "—",
        ),
        stat("attack dataset", data.dataset ? String(data.dataset.name) : "—"),
      ]),
    );
    node.appendChild(
      table(
        ["Run", "When", "Attack success", "Samples"],
        (data.runs ?? []).map((r) =>
          el("tr", { class: r.partial ? "folded" : null }, [
            el("td", { class: "mono", text: String(r.runId) }),
            el("td", { text: fmtRelativeTime(r.ts, Date.now()) }),
            el("td", null, [
              dot(r.attackSuccessRate > 0 ? "bad" : "ok", fmtPct(r.attackSuccessRate)),
            ]),
            el("td", { class: "num", text: fmtCount(r.sampleCount) }),
          ]),
        ),
      ),
    );
  });
  const generate = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Generate attacks",
  });
  generate.addEventListener("click", async () => {
    generate.disabled = true;
    await submit(api.redteamGenerate, { id: ctx.id }, {}, "Attack generation queued", reload);
    generate.disabled = false;
  });
  card.appendChild(el("div", { class: "editor-actions" }, [generate]));
  return card;
}

/** Coverage gaps hand off to `dataset mine` — the sessions that DEMONSTRATE
 *  a gap are what make "draft samples from these" a real hand-off. */
function coverageCard(ctx, res, reload) {
  return panel("Coverage gaps", res, (node, data) => {
    node.appendChild(
      table(
        ["Behavior", "Kind", "Seen", "Sessions"],
        (data.gaps ?? []).map((gap) =>
          el("tr", null, [
            el("td", { text: String(gap.behavior) }),
            el("td", { class: "muted", text: String(gap.kind ?? "") }),
            el("td", { class: "num", text: fmtCount(gap.frequency) }),
            el("td", { class: "mono muted", text: (gap.sessions ?? []).slice(0, 3).join(" ") }),
          ]),
        ),
      ),
    );
    const mine = el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Draft samples from these sessions",
    });
    mine.addEventListener("click", async () => {
      mine.disabled = true;
      await submit(
        api.datasetMine,
        { id: ctx.id },
        { name: `${String(ctx.detail?.entry?.specName ?? "mined")}-mined`, dryRun: true },
        "Mining preview ready — open the Datasets tab",
        reload,
      );
      mine.disabled = false;
    });
    node.appendChild(el("div", { class: "editor-actions" }, [mine]));
  });
}

/**
 * Sentinel attribution is CONDITIONAL: a flip is provider drift only when
 * spec, dataset, graders and judge all still match the frozen baseline. When
 * one moved, the panel names it instead of blaming the provider.
 */
function sentinelCard(ctx, res, reload) {
  const card = panel("Provider-drift sentinel", res, (node, data) => {
    const attribution = data.attribution ?? {};
    node.appendChild(
      el("p", null, [
        dot(
          attribution.providerDrift ? "warn" : "unknown",
          attribution.providerDrift ? "attributable to provider drift" : "not attributable",
        ),
      ]),
    );
    node.appendChild(el("p", { class: "muted", text: String(attribution.reason ?? "") }));
    if ((attribution.mismatches ?? []).length > 0) {
      node.appendChild(
        el(
          "ul",
          { class: "check-list" },
          attribution.mismatches.map((m) => el("li", { text: String(m) })),
        ),
      );
    }
    if (data.baseline) node.appendChild(jsonPre(data.baseline));
  });
  const run = el("button", { class: "btn btn-ghost", type: "button", text: "Run sentinel" });
  run.addEventListener("click", async () => {
    run.disabled = true;
    await submit(api.sentinelRun, { id: ctx.id }, {}, "Sentinel queued", reload);
    run.disabled = false;
  });
  card.appendChild(el("div", { class: "editor-actions" }, [run]));
  return card;
}

function voiceCard(res) {
  return panel("Voice replays", res, (node, data) => {
    node.appendChild(
      el("div", { class: "mini-row" }, [stat("replays on disk", fmtCount(data.replays))]),
    );
    if (data.report) node.appendChild(jsonPre(data.report));
  });
}

// ---------------------------------------------------------------------------
// optimizer, flywheel, experiments, annotations
// ---------------------------------------------------------------------------

function optimizerCard(ctx, res, reload) {
  const card = panel("Optimizer", res, (node, data) => {
    node.appendChild(el("p", { class: "muted", text: String(data.acceptance ?? "") }));
    node.appendChild(
      table(
        ["Run", "When", "Artifacts", ""],
        (data.runs ?? []).map((r) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(r.optRunId) }),
            el("td", { text: fmtRelativeTime(r.at, Date.now()) }),
            el("td", { class: "cell-caps" }, [
              r.hasDecisions ? el("span", { class: "chip", text: "decisions" }) : null,
              r.hasPatchedYaml ? el("span", { class: "chip", text: "patched.yaml" }) : null,
            ]),
            el("td", { class: "cell-actions" }, [artifactsBtn(ctx, r.optRunId)]),
          ]),
        ),
      ),
    );
  });
  const form = el("form", { class: "row-editor" }, [
    field(
      "mutator",
      el(
        "select",
        { class: "input", name: "mutator" },
        ["rule-based", "claude", "meta-harness"].map((m) => el("option", { value: m, text: m })),
      ),
    ),
    field("budget $", input("budgetUsd", { type: "number", step: "0.01", placeholder: "—" })),
  ]);
  const go = el("button", { class: "btn", type: "submit", text: "Optimize" });
  form.appendChild(el("div", { class: "editor-actions" }, [go]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    await submit(
      api.optimizerRun,
      { id: ctx.id },
      {
        mutator: form.elements["mutator"].value,
        ...(readNumber(form, "budgetUsd") ? { budgetUsd: readNumber(form, "budgetUsd") } : {}),
      },
      "Optimizer queued",
      reload,
    );
    go.disabled = false;
  });
  card.appendChild(form);
  return card;
}

function artifactsBtn(ctx, optRunId) {
  const btn = el("button", { class: "btn btn-ghost", type: "button", text: "Artifacts" });
  const holder = el("div");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const res = await api
      .optimizerArtifacts({ id: ctx.id, optRunId })
      .catch((err) => ({ ok: false, status: 0, body: { error: String(err) } }));
    btn.disabled = false;
    clear(holder);
    if (!res.ok) {
      toast(refusalText(res), "error");
      return;
    }
    const data = payload(res);
    holder.appendChild(
      table(
        ["File", "Kind", "Bytes"],
        (data.files ?? []).map((f) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(f.name) }),
            el("td", { text: String(f.kind) }),
            el("td", { class: "num", text: fmtCount(f.size) }),
          ]),
        ),
      ),
    );
    if (data.decisions) holder.appendChild(jsonPre(data.decisions));
  });
  return el("div", { class: "job-action" }, [btn, holder]);
}

function flywheelCard(ctx, res, reload) {
  const card = panel("Flywheel", res, (node, data) => {
    const precedence = data.datasetPrecedence ?? {};
    node.appendChild(
      el("p", null, [
        dot(
          precedence.shadowing ? "warn" : "ok",
          precedence.shadowing ? "dataset shadowed" : "dataset precedence clear",
        ),
      ]),
    );
    node.appendChild(el("p", { class: "muted", text: String(precedence.note ?? "") }));
    if ((data.workflows ?? []).length > 0) {
      node.appendChild(
        el(
          "ul",
          { class: "check-list" },
          data.workflows.map((w) => el("li", { class: "mono", text: String(w) })),
        ),
      );
    }
  });
  for (const action of ["run", "init"]) {
    const btn = el("button", {
      class: action === "run" ? "btn" : "btn btn-ghost",
      type: "button",
      text: action === "run" ? "Run the loop" : "Scaffold workflows",
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await submit(
        api.flywheelRun,
        { id: ctx.id },
        { action },
        action === "run" ? "Flywheel queued" : "Scaffolding queued",
        reload,
      );
      btn.disabled = false;
    });
    card.appendChild(btn);
  }
  return card;
}

function experimentsCard(ctx, res, reload) {
  const card = panel("Experiments", res, (node, data) => {
    node.appendChild(el("p", { class: "muted", text: String(data.boundary ?? "") }));
    for (const experiment of data.experiments ?? []) {
      const rows = (experiment.variants ?? []).map((v) =>
        el("tr", null, [
          el("td", { class: "mono", text: String(v.version) }),
          el("td", { class: "num", text: fmtCount(v.n) }),
          el("td", null, [dot(v.n > 0 ? "ok" : "unknown", fmtPct(v.successRate))]),
          el("td", {
            class: "num",
            text: Array.isArray(v.ci95) ? `${fmtPct(v.ci95[0])}–${fmtPct(v.ci95[1])}` : "—",
          }),
          el("td", {
            class: "num",
            text:
              typeof v.successRateDelta === "number"
                ? `${v.successRateDelta >= 0 ? "+" : ""}${fmtPct(v.successRateDelta)}`
                : "—",
          }),
          el("td", { class: "muted", text: (v.sources ?? []).join(", ") }),
        ]),
      );
      node.appendChild(
        collapsible(
          [
            el("span", { class: "mono", text: String(experiment.name) }),
            el("span", {
              class: "muted",
              text: ` ${fmtCount(experiment.totalObservations)} observations`,
            }),
          ],
          [table(["Version", "n", "Success", "Wilson 95%", "Δ vs control", "Sources"], rows)],
          true,
        ),
      );
    }
  });
  const form = el("form", { class: "row-editor" }, [
    field("experiment", input("name", { placeholder: "name", required: true })),
    field("version", input("version", { placeholder: "1.2.3" })),
    field(
      "outcome",
      el(
        "select",
        { class: "input", name: "outcome" },
        ["pass", "fail"].map((o) => el("option", { value: o, text: o })),
      ),
    ),
  ]);
  const go = el("button", { class: "btn btn-ghost", type: "submit", text: "Record outcome" });
  form.appendChild(el("div", { class: "editor-actions" }, [go]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    go.disabled = true;
    const res = await submit(
      api.experimentRecord,
      { id: ctx.id },
      {
        action: "record",
        name: readText(form, "name"),
        version: readText(form, "version"),
        outcome: form.elements["outcome"].value,
      },
      "Outcome recorded",
      reload,
    );
    if (res.ok && payload(res).submitted === false) {
      toast(String(payload(res).note ?? "incomplete"), "error");
    }
    go.disabled = false;
  });
  card.appendChild(form);
  return card;
}

/**
 * F-7, rendered honestly. Eval-sample annotations are durable and visible,
 * and mostly NOT training-data eligible: a sample's transcript lives under
 * the run directory, and distill joins ratings to turns by sweeping the
 * sessions root. The panel states the real counts and the upstream fix
 * rather than showing a pipeline that does not run.
 */
function annotationsCard(res) {
  return panel("Annotations → distill", res, (node, data) => {
    const join = data.join ?? {};
    node.appendChild(
      el("div", { class: "mini-row" }, [
        stat("annotations", fmtCount(join.total)),
        stat("reach distill", fmtCount(join.resolvable)),
        stat("blocked", fmtCount(join.unresolvable)),
      ]),
    );
    node.appendChild(
      el("p", null, [
        dot(
          join.unresolvable > 0 ? "warn" : "ok",
          join.unresolvable > 0 ? "join incomplete" : "join resolves",
        ),
      ]),
    );
    node.appendChild(el("p", { class: "muted", text: String(join.reason ?? "") }));
    if (join.upstreamFix) {
      node.appendChild(el("p", { class: "gated-why", text: String(join.upstreamFix) }));
    }
    node.appendChild(
      el(
        "ul",
        { class: "check-list" },
        (join.sinks ?? []).map((s) => el("li", { class: "mono", text: String(s) })),
      ),
    );
    node.appendChild(
      table(
        ["Run", "Sample", "Verdict", "Note", "State"],
        (data.annotations ?? []).map((a) =>
          el("tr", null, [
            el("td", { class: "mono", text: String(a.runId) }),
            el("td", { class: "mono", text: String(a.sampleId) }),
            el("td", null, [dot(a.verdict === "pass" ? "ok" : "bad", String(a.verdict ?? "?"))]),
            el("td", { class: "muted", text: String(a.note ?? "") }),
            el("td", { class: "muted", text: String(a.join?.state ?? "") }),
          ]),
        ),
      ),
    );
  });
}
