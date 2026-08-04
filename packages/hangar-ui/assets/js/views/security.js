/**
 * Security & audit — the audit chain, the egress review console, the PII
 * tuner, the justification console, the security corpus and sandbox checks,
 * the onchain safety panels, compliance evidence, retention, and the SLO
 * monitor.
 *
 * Honesty rules this screen is responsible for:
 *   - `audit verify` reports its DESIGNED limits (`anchorChecked` /
 *     `externalAnchorChecked: false`) as facts, not as failures, and the
 *     raw chain files are never shown — only rendered records.
 *   - an egress record carries LINEAGE, not the outbound payload. The
 *     console says so rather than rendering an empty body field that reads
 *     like data loss.
 *   - retention sweep and purge run `--dry-run` FIRST and show the plan; the
 *     real run is a second, typed-confirm gesture, and the plan names what
 *     the pins saved.
 *   - `transaction_policy` is human-owned spec, so its tuner previews and
 *     hands off to the spec write path rather than writing behind it.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, jsonPre, skeleton, toast } from "../dom.js";
import { fmtPct, fmtRelativeTime } from "../util.js";
import { m3, m3Card, m3Empty } from "./creds.js";

export async function renderSecurity(root, ctx) {
  clear(root).appendChild(skeleton(8));
  const [
    auditAnswer,
    egressAnswer,
    piiAnswer,
    justificationAnswer,
    corpusAnswer,
    sandboxAnswer,
    onchainAnswer,
    sentinelAnswer,
    complianceAnswer,
    retentionAnswer,
    sloAnswer,
  ] = await Promise.all([
    m3(api.audit({ id: ctx.id })),
    m3(api.egress({ id: ctx.id })),
    m3(api.pii({ id: ctx.id })),
    m3(api.justification({ id: ctx.id })),
    m3(api.securityCorpus({ id: ctx.id })),
    m3(api.sandboxDoctor({ id: ctx.id })),
    m3(api.onchain({ id: ctx.id })),
    m3(api.onchainSentinel({ id: ctx.id })),
    m3(api.compliance({ id: ctx.id })),
    m3(api.retention({ id: ctx.id })),
    m3(api.slo({ id: ctx.id })),
  ]);
  clear(root);
  const reload = () => renderSecurity(root, ctx);

  root.appendChild(m3Card("Audit chain", auditAnswer, (body) => auditCard(body, ctx)));
  root.appendChild(m3Card("Egress review", egressAnswer, (body) => egressCard(body, ctx, reload)));
  root.appendChild(m3Card("SLO monitor", sloAnswer, (body) => sloCard(body)));
  root.appendChild(
    m3Card("Justification", justificationAnswer, (body) => justificationCard(body, ctx)),
  );
  root.appendChild(m3Card("PII policy", piiAnswer, (body) => piiCard(body, ctx, reload)));
  root.appendChild(
    m3Card("Security corpus", corpusAnswer, (body) => corpusCard(body, ctx, reload)),
  );
  root.appendChild(m3Card("Sandbox", sandboxAnswer, (body) => sandboxCard(body)));
  root.appendChild(
    m3Card("Onchain safety", onchainAnswer, (body) =>
      onchainCard(body, sentinelAnswer.ok ? sentinelAnswer.body : null, ctx),
    ),
  );
  root.appendChild(
    m3Card("Compliance evidence", complianceAnswer, (body) => complianceCard(body, ctx, reload)),
  );
  root.appendChild(m3Card("Retention", retentionAnswer, (body) => retentionCard(body, ctx)));
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function auditCard(body, ctx) {
  const records = Array.isArray(body.records) ? body.records : [];
  const kinds = Array.isArray(body.kinds) ? body.kinds : [];
  const encryption = body.encryption && typeof body.encryption === "object" ? body.encryption : {};
  const verifyState = el("div", { class: "control-state" });

  const verifyBtn = el("button", { class: "btn", type: "button", text: "Verify chain" });
  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    const answer = await m3(api.auditVerify({ id: ctx.id }, {}));
    verifyBtn.disabled = false;
    if (!answer.ok) {
      verifyState.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    const result = answer.body;
    const limitations = Array.isArray(result.limitations) ? result.limitations : [];
    verifyState.replaceChildren(
      result.ok === true
        ? dot("ok", `chain intact — ${String(result.recordsChecked)} record(s) checked`)
        : dot("bad", `chain broken: ${String(result.reason ?? "")}`),
      // The two anchor flags are FACTS about what the verifier does, not
      // failures — so they render as notes beside a green light, never as a
      // downgrade of it.
      ...limitations.map((line) => el("div", { class: "muted reason", text: String(line) })),
    );
  });

  const nodes = [
    el("div", { class: "rollup" }, [
      dot(body.present === true ? "ok" : "off", `${records.length} record(s) rendered`),
      encryption.on === true ? el("span", { class: "chip chip-warn", text: "encrypted" }) : null,
      body.truncated === true ? el("span", { class: "chip", text: "truncated" }) : null,
      Number(body.tornLines) > 0
        ? el("span", { class: "chip", text: `${Number(body.tornLines)} torn line(s)` })
        : null,
    ]),
    el("p", { class: "muted", text: String(body.rawFilesNote ?? "") }),
    encryption.on === true && encryption.note
      ? el("p", { class: "muted", text: String(encryption.note) })
      : null,
    el("div", { class: "control-action" }, [
      el("div", { class: "control-row" }, [verifyBtn]),
      verifyState,
    ]),
  ];

  if (kinds.length > 0) {
    nodes.push(
      el(
        "div",
        { class: "chip-group" },
        kinds.map((entry) =>
          el("span", { class: "chip", text: `${String(entry.kind)} ${String(entry.count)}` }),
        ),
      ),
    );
  }
  if (records.length === 0) {
    nodes.push(m3Empty(body, "No audit records yet"));
    return nodes;
  }
  const tbody = el("tbody");
  for (const record of records.slice(-100).reverse()) {
    tbody.appendChild(
      el("tr", null, [
        el("td", { class: "mono", text: String(record.seq) }),
        el("td", {
          class: "muted",
          text: record.ts ? fmtRelativeTime(record.ts, Date.now()) : "—",
        }),
        el("td", { class: "mono", text: String(record.kind) }),
        el("td", null, [
          record.hashOk ? dot("ok", "body matches hash") : dot("warn", "hash mismatch"),
        ]),
        el("td", null, [
          record.encrypted
            ? el("span", { class: "muted", text: "sealed" })
            : collapsible(
                [el("span", { class: "muted", text: "payload" })],
                [jsonPre(record.payload)],
              ),
        ]),
      ]),
    );
  }
  nodes.push(
    el("div", { class: "table-scroll" }, [
      el("table", { class: "fleet" }, [
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ["Seq", "When", "Kind", "Integrity", "Payload"].map((h) => el("th", { text: h })),
          ),
        ),
        tbody,
      ]),
    ]),
  );
  return nodes;
}

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

function egressCard(body, ctx, reload) {
  const decisions = Array.isArray(body.decisions) ? body.decisions : [];
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(Number(body.open) > 0 ? "warn" : "ok", `${Number(body.open) || 0} untriaged`),
      el("span", { class: "chip", text: `${decisions.length} decision(s)` }),
    ]),
    // The record's omission of the outbound body is DELIBERATE — saying so
    // is the difference between "designed" and "broken".
    el("p", { class: "muted", text: String(body.payloadNote ?? "") }),
  ];
  if (decisions.length === 0) {
    nodes.push(m3Empty(body, "No egress decisions recorded"));
    return nodes;
  }
  const tbody = el("tbody");
  for (const decision of decisions.slice(-100).reverse()) {
    tbody.appendChild(
      el("tr", null, [
        el("td", { class: "mono", text: String(decision.decisionId) }),
        el("td", {
          class: "muted",
          text: decision.ts ? fmtRelativeTime(decision.ts, Date.now()) : "—",
        }),
        el("td", { class: "mono", text: String(decision.sinkId ?? "—") }),
        el("td", null, [
          decision.verdict === "block"
            ? dot("bad", "block")
            : dot("warn", String(decision.verdict ?? "—")),
        ]),
        el("td", { class: "muted sub", text: (decision.origins || []).join(" → ") || "—" }),
        el("td", { class: "cell-actions" }, [triageControl(decision, ctx, reload)]),
      ]),
    );
  }
  nodes.push(
    el("div", { class: "table-scroll" }, [
      el("table", { class: "fleet" }, [
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ["Id", "When", "Sink", "Verdict", "Lineage", "Triage"].map((h) =>
              el("th", { text: h }),
            ),
          ),
        ),
        tbody,
      ]),
    ]),
  );
  return nodes;
}

function triageControl(decision, ctx, reload) {
  if (decision.triage) {
    return el("span", { class: "muted" }, [
      dot("ok", String(decision.triage.verdict)),
      el("span", { text: ` by ${String(decision.triage.by ?? "?")}` }),
    ]);
  }
  const select = el("select", { class: "input", "aria-label": "triage verdict" }, [
    el("option", { value: "acknowledge", text: "acknowledge" }),
    el("option", { value: "allow", text: "allow" }),
    el("option", { value: "block", text: "block" }),
    el("option", { value: "needs-review", text: "needs-review" }),
  ]);
  const note = el("input", { class: "input", type: "text", placeholder: "note (optional)" });
  const save = el("button", { class: "btn btn-ghost", type: "button", text: "Record" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    const answer = await m3(
      api.egressReview(
        { id: ctx.id, decisionId: String(decision.decisionId) },
        { verdict: select.value, ...(note.value !== "" ? { note: note.value } : {}) },
      ),
    );
    save.disabled = false;
    if (!answer.ok || answer.body.recorded !== true) {
      toast(String(answer.body.reason ?? answer.body.error ?? "could not record the triage"));
      return;
    }
    reload();
  });
  return el("div", { class: "row-editor" }, [select, note, save]);
}

// ---------------------------------------------------------------------------
// SLO
// ---------------------------------------------------------------------------

function sloCard(body) {
  const targets = Array.isArray(body.targets) ? body.targets : [];
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  const exporters = body.exporters && typeof body.exporters === "object" ? body.exporters : {};
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(
        targets.some((target) => target.breached) ? "bad" : body.declared === true ? "ok" : "off",
        body.declared === true
          ? targets.some((target) => target.breached)
            ? "a target is breached"
            : "within every declared target"
          : "no SLO declared",
      ),
      el("span", { class: "chip", text: `ladder: ${(body.ladder || []).join(" → ")}` }),
      el("span", { class: "chip", text: `state: ${String(body.ladderState ?? "idle")}` }),
      typeof body.observedAt === "string"
        ? el("span", {
            class: "asof",
            title: body.observedAt,
            text: `as of ${fmtRelativeTime(body.observedAt, Date.now())}`,
          })
        : null,
    ]),
    el("p", { class: "muted", text: String(body.ladderNote ?? "") }),
  ];
  if (targets.length === 0) {
    nodes.push(m3Empty(body, "No SLO targets and no observations"));
  } else {
    const tbody = el("tbody");
    for (const target of targets) {
      tbody.appendChild(
        el("tr", null, [
          el("td", { class: "mono", text: String(target.metric) }),
          el("td", { text: fmtTarget(target.threshold, target.unit) }),
          el("td", { text: fmtTarget(target.observed, target.unit) }),
          el("td", null, [
            target.observed === null
              ? dot("off", "no observation")
              : target.breached
                ? dot("bad", "breached")
                : dot("ok", "within target"),
          ]),
        ]),
      );
    }
    nodes.push(
      el("div", { class: "table-scroll" }, [
        el("table", { class: "fleet" }, [
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["Metric", "Target", "Observed", "State"].map((h) => el("th", { text: h })),
            ),
          ),
          tbody,
        ]),
      ]),
    );
  }
  nodes.push(
    el("div", { class: "rollup" }, [
      exporters.otlpEndpointConfigured
        ? dot("ok", "OTLP endpoint set")
        : dot("off", "no OTLP endpoint"),
      exporters.metricsConfigured ? dot("ok", "metrics sink set") : dot("off", "no metrics sink"),
      el("span", { class: "muted", text: String(exporters.note ?? "") }),
    ]),
  );
  if (alerts.length > 0) {
    nodes.push(
      collapsible(
        [el("span", { class: "muted", text: `${alerts.length} alert_raised record(s)` })],
        [
          el(
            "ul",
            { class: "check-list" },
            alerts
              .slice(-20)
              .reverse()
              .map((alert) =>
                el("li", { class: "check" }, [
                  dot("warn", String(alert.metric ?? "alert")),
                  el("span", {
                    text: ` observed ${String(alert.observed)} vs ${String(alert.threshold)} (from ${String(alert.baselineSessions)} baseline session(s))`,
                  }),
                  alert.detail
                    ? el("div", { class: "muted reason", text: String(alert.detail) })
                    : null,
                ]),
              ),
          ),
          el("p", { class: "muted", text: String(body.baselineNote ?? "") }),
        ],
      ),
    );
  }
  return nodes;
}

function fmtTarget(value, unit) {
  if (value === null || value === undefined) return "—";
  if (unit === "rate") return fmtPct(Number(value));
  if (unit === "ms") return `${Math.round(Number(value))} ms`;
  return `${Number(value).toFixed(2)} ${String(unit)}`;
}

// ---------------------------------------------------------------------------
// Justification
// ---------------------------------------------------------------------------

function justificationCard(body, ctx) {
  const records = Array.isArray(body.records) ? body.records : [];
  const byTool = Array.isArray(body.byTool) ? body.byTool : [];
  const state = el("div", { class: "control-state" });

  const tool = el("input", {
    class: "input mono",
    type: "text",
    placeholder: "tool name",
    "aria-label": "tool name",
  });
  const preflight = el("button", {
    class: "btn",
    type: "button",
    text: "Preflight (never runs the tool)",
  });
  preflight.addEventListener("click", async () => {
    if (tool.value === "") {
      toast("name a tool first", "info");
      return;
    }
    preflight.disabled = true;
    const answer = await m3(api.justificationPreflight({ id: ctx.id }, { tool: tool.value }));
    preflight.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    const result = answer.body;
    const history = result.history && typeof result.history === "object" ? result.history : {};
    state.replaceChildren(
      dot(
        result.likelyVerdict === "deny" ? "bad" : result.likelyVerdict === "allow" ? "ok" : "off",
        `likely ${String(result.likelyVerdict)}`,
      ),
      el("span", {
        class: "chip",
        text: `${String(history.evaluations ?? 0)} past evaluation(s), ${String(history.denials ?? 0)} denied`,
      }),
      el("span", { class: "chip", text: "the tool was NOT executed" }),
      el("div", { class: "muted reason", text: String(result.note ?? "") }),
    );
  });

  const calibrate = el("button", { class: "btn btn-ghost", type: "button", text: "Calibrate" });
  calibrate.addEventListener("click", async () => {
    calibrate.disabled = true;
    const answer = await m3(api.justificationCalibrate({ id: ctx.id }, { apply: true }));
    calibrate.disabled = false;
    if (!answer.ok) {
      toast(String(answer.body.error ?? answer.status));
      return;
    }
    state.replaceChildren(
      dot("ok", "calibration queued"),
      el("div", { class: "muted reason", text: String(answer.body.applyNote ?? "") }),
    );
  });

  const nodes = [
    el("div", { class: "rollup" }, [
      dot(records.length > 0 ? "ok" : "off", `${records.length} evaluated call(s)`),
      body.config
        ? el("span", { class: "chip", text: `judge: ${String(body.config.judge ?? "declared")}` })
        : el("span", { class: "chip", text: "no security.justification block" }),
    ]),
    el("div", { class: "control-action" }, [
      el("div", { class: "control-row" }, [tool, preflight, calibrate]),
      state,
    ]),
    el("p", { class: "muted", text: String(body.linkNote ?? "") }),
  ];
  if (byTool.length > 0) {
    nodes.push(
      el(
        "div",
        { class: "chip-group" },
        byTool.map((entry) =>
          el("span", {
            class: "chip",
            text: `${String(entry.toolName)}: ${String(entry.allow)}✓ / ${String(entry.deny)}✗`,
          }),
        ),
      ),
    );
  }
  if (records.length === 0) {
    nodes.push(m3Empty(body, "No justification records yet"));
    return nodes;
  }
  nodes.push(
    collapsible(
      [el("span", { class: "muted", text: "verbatim justifications" })],
      [
        el(
          "ul",
          { class: "check-list" },
          records
            .slice(-30)
            .reverse()
            .map((record) =>
              el("li", { class: "check" }, [
                record.verdict === "deny" ? dot("bad", "deny") : dot("ok", "allow"),
                el("code", { text: String(record.toolName) }),
                el("div", { class: "muted", text: String(record.justification) }),
                record.reason
                  ? el("div", { class: "muted reason", text: String(record.reason) })
                  : null,
              ]),
            ),
        ),
      ],
    ),
  );
  return nodes;
}

// ---------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------

function piiCard(body, ctx, reload) {
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(
        body.present === true ? "ok" : "off",
        `${Number(body.allowEntries) || 0} allow entr(ies)`,
      ),
    ]),
    el("p", { class: "muted", text: String(body.valuesNote ?? "") }),
    el("p", { class: "muted", text: String(body.hitCountsNote ?? "") }),
  ];
  if (body.present !== true) {
    nodes.push(m3Empty(body, "No pii-policy.json — the built-in detector set applies"));
  } else {
    nodes.push(
      collapsible([el("span", { class: "muted", text: "policy" })], [jsonPre(body.policy)]),
    );
  }
  nodes.push(
    policyTuner("PII policy", body.policy, ctx, reload, (policy, dryRun, confirmName) =>
      api.piiTune({ id: ctx.id }, { policy, dryRun, ...(confirmName ? { confirmName } : {}) }),
    ),
  );
  return nodes;
}

/**
 * The shared policy tuner: paste a policy, see the BEFORE/AFTER, and only
 * then confirm. `dryRun` defaults to true on the server too — an omitted
 * flag must never mean "do it".
 */
function policyTuner(label, current, ctx, reload, call) {
  const area = el("textarea", {
    class: "input",
    rows: "6",
    spellcheck: "false",
    "aria-label": `${label} JSON`,
  });
  area.value = JSON.stringify(current ?? {}, null, 2);
  const confirm = el("input", {
    class: "input mono",
    type: "text",
    placeholder: "type the harness name to apply",
    "aria-label": "typed confirmation",
  });
  const state = el("div", { class: "control-state" });
  const previewBtn = el("button", { class: "btn", type: "button", text: "Preview" });
  const applyBtn = el("button", { class: "btn btn-danger", type: "button", text: "Apply" });

  const parse = () => {
    try {
      return JSON.parse(area.value);
    } catch {
      toast("that is not valid JSON");
      return undefined;
    }
  };

  previewBtn.addEventListener("click", async () => {
    const policy = parse();
    if (policy === undefined) return;
    previewBtn.disabled = true;
    const answer = await m3(call(policy, true, ""));
    previewBtn.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    const preview =
      answer.body.preview && typeof answer.body.preview === "object" ? answer.body.preview : {};
    state.replaceChildren(
      preview.changed ? dot("warn", "this would change the policy") : dot("off", "no change"),
      collapsible([el("span", { class: "muted", text: "before" })], [jsonPre(preview.before)]),
      collapsible([el("span", { class: "muted", text: "after" })], [jsonPre(preview.after)]),
      el("div", { class: "muted reason", text: String(answer.body.note ?? "") }),
    );
  });

  applyBtn.addEventListener("click", async () => {
    const policy = parse();
    if (policy === undefined) return;
    applyBtn.disabled = true;
    const answer = await m3(call(policy, false, confirm.value));
    applyBtn.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    state.replaceChildren(
      answer.body.wrote === true
        ? dot("ok", "written")
        : dot("warn", String(answer.body.note ?? "handed off")),
      answer.body.specEdit
        ? collapsible(
            [el("span", { class: "muted", text: "the edit, for the spec write path" })],
            [jsonPre(answer.body.specEdit)],
          )
        : null,
    );
    if (answer.body.wrote === true) reload();
  });

  return el("div", { class: "control-action" }, [
    el("p", { class: "muted", text: `${label} — dry run first, then a typed confirmation` }),
    area,
    el("div", { class: "row-editor" }, [confirm, previewBtn, applyBtn]),
    state,
  ]);
}

// ---------------------------------------------------------------------------
// Corpus + sandbox
// ---------------------------------------------------------------------------

function corpusCard(body, ctx, reload) {
  const run = el("button", { class: "btn", type: "button", text: "Run corpus check" });
  run.addEventListener("click", async () => {
    run.disabled = true;
    const answer = await m3(api.securityCorpusCheck({ id: ctx.id }, {}));
    run.disabled = false;
    if (!answer.ok) {
      toast(String(answer.body.error ?? answer.status));
      return;
    }
    toast("corpus check queued", "info");
    reload();
  });
  const last = body.lastCheck && typeof body.lastCheck === "object" ? body.lastCheck : null;
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(body.present === true ? "ok" : "off", `${Number(body.cases) || 0} case(s)`),
      el("span", { class: "chip", text: `${Number(body.candidateRules) || 0} candidate rule(s)` }),
      typeof body.builtAt === "string"
        ? el("span", {
            class: "asof",
            title: body.builtAt,
            text: `built ${fmtRelativeTime(body.builtAt, Date.now())}`,
          })
        : null,
    ]),
    el("p", { class: "muted", text: String(body.payloadNote ?? "") }),
    el("div", { class: "control-action" }, [
      el("div", { class: "control-row" }, [run]),
      el("div", { class: "control-state" }, [
        last === null
          ? el("span", { class: "muted", text: "no check has run from this manager yet" })
          : dot(last.exitCode === 0 ? "ok" : "warn", `last check ${String(last.state)}`),
      ]),
    ]),
  ];
  if (body.present !== true) nodes.push(m3Empty(body, "No security corpus yet"));
  return nodes;
}

function sandboxCard(body) {
  const backends = Array.isArray(body.backends) ? body.backends : [];
  const nodes = [
    el("div", { class: "rollup" }, [
      body.declared === true ? dot("ok", "sandbox declared") : dot("off", "no sandbox block"),
      ...backends.map((backend) =>
        backend.available
          ? dot("ok", `${String(backend.name)} available`)
          : dot("off", `${String(backend.name)} not on PATH`),
      ),
    ]),
    el("p", { text: String(body.wouldHappen ?? "") }),
    el("p", { class: "muted", text: String(body.probeNote ?? "") }),
  ];
  if (body.config) {
    nodes.push(
      collapsible([el("span", { class: "muted", text: "sandbox config" })], [jsonPre(body.config)]),
    );
  }
  if (body.declared !== true) nodes.push(m3Empty(body, "This spec declares no sandbox"));
  return nodes;
}

// ---------------------------------------------------------------------------
// Onchain
// ---------------------------------------------------------------------------

function onchainCard(body, sentinel, ctx) {
  if (body.shapeGated !== true && body.transactionPolicy === null) {
    return [m3Empty(body, `Not an onchain shape (target: ${String(body.target)})`)];
  }
  const nodes = [
    el("div", { class: "rollup" }, [
      // transaction_policy is the ceiling on what value the agent can move,
      // so it leads this panel rather than sitting in a fold.
      body.transactionPolicy
        ? dot("ok", `approval: ${String(body.approvalMode ?? "declared")}`)
        : dot("bad", "no transaction_policy — nothing caps what this agent can move"),
      el("span", { class: "chip", text: `${(body.receipts || []).length} broadcast(s)` }),
    ]),
    el("p", { class: "muted", text: String(body.keyNote ?? "") }),
    body.transactionPolicy
      ? collapsible(
          [el("span", { class: "muted", text: "transaction_policy" })],
          [jsonPre(body.transactionPolicy)],
        )
      : null,
  ];
  for (const [label, value] of [
    ["chains", body.chains],
    ["wallets", body.wallets],
    ["contracts", body.contracts],
    ["triggers", body.triggers],
  ]) {
    if (value === null || value === undefined) continue;
    nodes.push(collapsible([el("span", { class: "muted", text: label })], [jsonPre(value)]));
  }
  if (sentinel) {
    const baselines = Array.isArray(sentinel.baselines) ? sentinel.baselines : [];
    nodes.push(
      el("div", { class: "rollup" }, [
        dot(sentinel.present === true ? "ok" : "off", `${baselines.length} contract baseline(s)`),
        el("span", { class: "muted", text: String(sentinel.note ?? "") }),
      ]),
    );
  }
  nodes.push(
    policyTuner(
      "transaction_policy",
      body.transactionPolicy,
      ctx,
      () => {},
      (policy, dryRun, confirmName) =>
        api.onchainTune(
          { id: ctx.id },
          { policy, dryRun, ...(confirmName ? { confirmName } : {}) },
        ),
    ),
  );
  return nodes;
}

// ---------------------------------------------------------------------------
// Compliance + retention
// ---------------------------------------------------------------------------

function complianceCard(body, ctx, reload) {
  const bundles = Array.isArray(body.bundles) ? body.bundles : [];
  const frameworks = Array.isArray(body.frameworks) ? body.frameworks : [];
  const select = el(
    "select",
    { class: "input", "aria-label": "framework" },
    frameworks.map((framework) =>
      el("option", { value: String(framework), text: String(framework) }),
    ),
  );
  const generate = el("button", { class: "btn", type: "button", text: "Generate evidence" });
  generate.addEventListener("click", async () => {
    generate.disabled = true;
    const answer = await m3(api.complianceEvidence({ id: ctx.id }, { framework: select.value }));
    generate.disabled = false;
    if (!answer.ok) {
      toast(String(answer.body.error ?? answer.status));
      return;
    }
    toast("evidence collection queued", "info");
    reload();
  });
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(bundles.length > 0 ? "ok" : "off", `${bundles.length} bundle(s)`),
    ]),
    el("div", { class: "row-editor" }, [select, generate]),
    el("p", { class: "muted", text: String(body.retireNote ?? "") }),
  ];
  if (bundles.length === 0) {
    nodes.push(m3Empty(body, "No evidence bundles generated yet"));
    return nodes;
  }
  const tbody = el("tbody");
  for (const bundle of bundles) {
    tbody.appendChild(
      el("tr", null, [
        el("td", { class: "mono", text: String(bundle.name) }),
        el("td", { text: String(bundle.framework ?? "—") }),
        el("td", { text: String(bundle.period ?? "—") }),
        el("td", {
          class: "muted",
          text: bundle.generatedAt ? fmtRelativeTime(bundle.generatedAt, Date.now()) : "—",
        }),
      ]),
    );
  }
  nodes.push(
    el("div", { class: "table-scroll" }, [
      el("table", { class: "fleet" }, [
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ["Bundle", "Framework", "Period", "Generated"].map((h) => el("th", { text: h })),
          ),
        ),
        tbody,
      ]),
    ]),
  );
  return nodes;
}

function retentionCard(body, ctx) {
  const pins = Array.isArray(body.pins) ? body.pins : [];
  const windows = Array.isArray(body.auditWindows) ? body.auditWindows : [];
  const nodes = [
    el("div", { class: "rollup" }, [
      body.malformed === true
        ? dot("bad", "retention.json will not parse — enforcement is refused, not guessed")
        : dot(body.fromFile === true ? "ok" : "off", `${pins.length} pinned session(s)`),
      body.sessionMaxAgeDays === null
        ? null
        : el("span", { class: "chip", text: `TTL ${String(body.sessionMaxAgeDays)}d` }),
      ...windows.map((window) =>
        window.active
          ? dot("warn", `${String(window.frameworkId)}/${String(window.controlId)} defers deletion`)
          : dot("off", `${String(window.frameworkId)}/${String(window.controlId)} expired`),
      ),
    ]),
    el("p", { class: "muted", text: String(body.auditChainNote ?? "") }),
  ];
  if (body.fromFile !== true) nodes.push(m3Empty(body, "No retention.json"));
  if (pins.length > 0) {
    nodes.push(
      el(
        "div",
        { class: "chip-group" },
        pins.map((pin) => el("span", { class: "chip mono", text: String(pin) })),
      ),
    );
  }
  nodes.push(retentionRun("sweep", ctx), retentionRun("purge", ctx));
  return nodes;
}

/**
 * Dry-run FIRST, then a typed confirm. Two gestures, never one: the plan is
 * the thing the operator is consenting to, and they cannot consent to a plan
 * they have not seen.
 */
function retentionRun(action, ctx) {
  const state = el("div", { class: "control-state" });
  const confirm = el("input", {
    class: "input mono",
    type: "text",
    placeholder: "type the harness name",
    "aria-label": `typed confirmation for ${action}`,
  });
  const real = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: `Run ${action} for real`,
    disabled: true,
  });
  const plan = el("button", { class: "btn", type: "button", text: `Plan ${action} (--dry-run)` });

  const call = (dryRun) =>
    action === "sweep"
      ? api.retentionSweep(
          { id: ctx.id },
          { dryRun, ...(dryRun ? {} : { confirmName: confirm.value }) },
        )
      : api.retentionPurge(
          { id: ctx.id },
          { dryRun, ...(dryRun ? {} : { confirmName: confirm.value }) },
        );

  plan.addEventListener("click", async () => {
    plan.disabled = true;
    const answer = await m3(call(true));
    plan.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    // The real run unlocks only once the plan has been asked for.
    real.disabled = false;
    state.replaceChildren(
      dot("off", `plan queued as job ${String(answer.body.job?.jobId ?? "?")}`),
      el("div", { class: "muted reason", text: String(answer.body.note ?? "") }),
      el("div", { class: "muted reason", text: String(answer.body.pinsNote ?? "") }),
    );
  });

  real.addEventListener("click", async () => {
    real.disabled = true;
    const answer = await m3(call(false));
    real.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    state.replaceChildren(
      dot("warn", `${action} queued as job ${String(answer.body.job?.jobId ?? "?")}`),
      el("div", { class: "muted reason", text: String(answer.body.note ?? "") }),
    );
  });

  return el("div", { class: "control-action" }, [
    el("div", { class: "control-row" }, [plan, confirm, real]),
    state,
  ]);
}
