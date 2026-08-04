/**
 * Channels — provisioning, verification, the two testing tiers, routing
 * display, per-channel status, and the gateway panel. Shape-gated: this tab
 * belongs to channel daemons and says so when it is empty.
 *
 * The two test buttons are labelled for what they actually prove:
 *   tier 1  an unsigned POST expecting a 401 — "the endpoint is up and
 *           rejecting unsigned traffic". Cheap, and NOT end-to-end.
 *   tier 2  a SIGNED synthetic inbound, signed server-side with the
 *           harness's own secret, driving a full turn. Slack, Telegram and
 *           WhatsApp only — Discord's verification is asymmetric Ed25519, so
 *           the harness holds only a public key and a forged event is
 *           impossible by design; iMessage is a poller with no inbound
 *           webhook. Both exclusions render DISABLED WITH THE REASON, which
 *           is more useful than hiding the button and leaving the operator
 *           to wonder why it is gone.
 *
 * The routing panel carries the reactions caveat: emoji feedback needs a
 * `channel` or `user` sessionKey, and a `thread` sessionKey silently
 * collects nothing.
 *
 * A green light is never drawn from spec configuration. "Configured" and
 * "serving" are separate lights, and the second stays unknown-with-a-reason
 * unless the gateway's own `/status` answered.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, jsonPre, numberedCode, skeleton, toast } from "../dom.js";
import { m3, m3Card, m3Empty } from "./creds.js";

export async function renderChannels(root, ctx) {
  clear(root).appendChild(skeleton(5));
  const [channelsAnswer, gatewayAnswer] = await Promise.all([
    m3(api.channels({ id: ctx.id })),
    m3(api.gateway({ id: ctx.id })),
  ]);
  clear(root);
  const reload = () => renderChannels(root, ctx);

  root.appendChild(m3Card("Channels", channelsAnswer, (body) => channelCards(body, ctx, reload)));
  root.appendChild(m3Card("Gateway", gatewayAnswer, (body) => gatewayCard(body)));
}

function channelCards(body, ctx, reload) {
  const rows = Array.isArray(body.channels) ? body.channels : [];
  const nodes = [];

  // A value the compiler REJECTS outranks every env check beside it: no
  // daemon can exist at all, so this leads.
  const compileErrors = Array.isArray(body.compileErrors) ? body.compileErrors : [];
  if (compileErrors.length > 0) {
    nodes.push(
      el("div", { class: "rollup" }, [dot("bad", "this spec will not compile")]),
      el(
        "ul",
        { class: "check-list" },
        compileErrors.map((error) =>
          el("li", { class: "check" }, [
            el("code", { text: String(error.label) }),
            el("div", { class: "muted reason", text: String(error.message) }),
          ]),
        ),
      ),
    );
  }

  nodes.push(routingRow(body.routing));

  if (rows.length === 0) {
    nodes.push(m3Empty(body, "This spec declares no channels"));
    return nodes;
  }

  // Live connectivity is the gateway's own answer, or an honest absence.
  const live = Array.isArray(body.liveChannels) ? body.liveChannels : null;
  nodes.push(
    el("div", { class: "rollup" }, [
      live === null
        ? dot("off", "no live status")
        : dot("ok", `serving: ${live.length === 0 ? "none" : live.join(", ")}`),
      typeof body.statusReason === "string" && body.statusReason !== ""
        ? el("span", { class: "muted", text: body.statusReason })
        : null,
      live !== null ? el("span", { class: "chip", text: String(body.statusSource) }) : null,
    ]),
  );

  nodes.push(verifyControls(ctx, reload));
  for (const row of rows) nodes.push(channelCard(row, live, ctx, reload));
  return nodes;
}

/**
 * The pre-boot gate, run on demand. Offline is answered inline (a pure
 * function of the spec and the environment), so it re-reads the panel; a
 * LIVE verify makes real platform calls and therefore goes through the job
 * queue — the button says which is which rather than hiding the difference.
 */
function verifyControls(ctx, reload) {
  const state = el("div", { class: "control-state" });
  const offline = el("button", { class: "btn", type: "button", text: "Verify (offline)" });
  offline.addEventListener("click", async () => {
    offline.disabled = true;
    const answer = await m3(api.channelVerify({ id: ctx.id }, { offline: true }));
    offline.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    const failing = Array.isArray(answer.body.failing) ? answer.body.failing : [];
    state.replaceChildren(
      answer.body.ok === true
        ? dot("ok", "every boot-gate check passes")
        : dot("bad", `${failing.length} check(s) would stop the boot`),
      ...failing.map((line) => el("div", { class: "muted reason", text: String(line) })),
      el("div", { class: "muted reason", text: String(answer.body.note ?? "") }),
    );
    reload();
  });
  const live = el("button", { class: "btn btn-ghost", type: "button", text: "Verify (live)" });
  live.title = "makes real platform calls — runs as a job";
  live.addEventListener("click", async () => {
    live.disabled = true;
    const answer = await m3(api.channelVerify({ id: ctx.id }, { offline: false }));
    live.disabled = false;
    if (!answer.ok) {
      state.replaceChildren(dot("bad", String(answer.body.error ?? answer.status)));
      return;
    }
    state.replaceChildren(
      dot("off", `queued as job ${String(answer.body.job?.jobId ?? "?")}`),
      el("div", { class: "muted reason", text: String(answer.body.note ?? "") }),
    );
  });
  return el("div", { class: "control-action" }, [
    el("div", { class: "control-row" }, [offline, live]),
    state,
  ]);
}

function routingRow(routing) {
  const model = routing && typeof routing === "object" ? routing : {};
  // `sessionKeyMode`, not `sessionKey`: the server renames it on purpose so
  // the value survives the response masker (see `routingView`).
  const key =
    model.sessionKeyMode === null || model.sessionKeyMode === undefined
      ? "—"
      : String(model.sessionKeyMode);
  return el("div", { class: "kv" }, [
    el("span", { class: "kv-k", text: String(model.specPath ?? "routing.sessionKey") }),
    el("span", { class: "kv-v" }, [
      el("code", { text: key }),
      model.collectsReactions === true
        ? dot("ok", "collects emoji reaction feedback")
        : dot("warn", "collects NO emoji reaction feedback"),
      el("div", { class: "muted reason", text: String(model.reactionsNote ?? "") }),
    ]),
  ]);
}

function channelCard(row, live, ctx, reload) {
  const platform = String(row.platform);
  const serving = live === null ? null : live.includes(platform);
  const checks = Array.isArray(row.checks) ? row.checks : [];
  const fields = Array.isArray(row.fields) ? row.fields : [];

  const fieldList = el(
    "ul",
    { class: "check-list" },
    fields.map((field) =>
      el("li", { class: "check" }, [
        field.set ? dot("ok", "set") : dot("bad", "unset"),
        el("code", { text: String(field.field) }),
        el("span", {
          class: "muted",
          text: field.envRef
            ? ` ← $${String(field.envRef)}`
            : field.inlineLiteral
              ? " ← inline literal in the spec (prefer a $ENV ref)"
              : " ← not declared",
        }),
      ]),
    ),
  );

  const checkList = el(
    "ul",
    { class: "check-list" },
    checks.map((check) =>
      el("li", { class: "check" }, [
        check.pass ? dot(check.informational ? "off" : "ok", "ok") : dot("bad", "blocking"),
        el("span", { class: "pf-msg", text: String(check.label) }),
        check.reason ? el("div", { class: "muted reason", text: String(check.reason) }) : null,
      ]),
    ),
  );

  return el("section", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: platform }),
      row.bootGateOk ? dot("ok", "boot gate green") : dot("bad", "will not boot"),
      serving === null
        ? dot("off", "serving: unknown")
        : serving
          ? dot("ok", "serving")
          : dot("warn", "not in the gateway's channel list"),
    ]),
    row.webhookPath
      ? el("div", { class: "kv" }, [
          el("span", { class: "kv-k", text: "webhook" }),
          el("span", { class: "kv-v" }, [el("code", { text: String(row.webhookPath) })]),
        ])
      : null,
    fieldList,
    checkList,
    tierControls(row, ctx, reload),
    provisionFold(platform, ctx),
  ]);
}

/** The two test tiers, each labelled with exactly what it proves, and each
 *  disabled WITH ITS REASON when the platform cannot support it. */
function tierControls(row, ctx, reload) {
  const platform = String(row.platform);
  const tier1 = row.tier1 && typeof row.tier1 === "object" ? row.tier1 : {};
  const tier2 = row.tier2 && typeof row.tier2 === "object" ? row.tier2 : {};
  const outcome = el("div", { class: "control-state" });

  const probeBtn = el("button", {
    class: "btn",
    type: "button",
    text: "Tier 1 · liveness",
    title: String(tier1.proves ?? ""),
  });
  if (tier1.available !== true) probeBtn.disabled = true;
  else {
    probeBtn.addEventListener("click", async () => {
      probeBtn.disabled = true;
      const answer = await m3(api.channelProbe({ id: ctx.id, channel: platform }, {}));
      probeBtn.disabled = false;
      renderOutcome(outcome, answer);
    });
  }

  const text = el("input", {
    class: "input",
    type: "text",
    placeholder: "synthetic message text (optional)",
    "aria-label": "synthetic message text",
  });
  const syntheticBtn = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "Tier 2 · signed synthetic inbound",
    title: String(tier2.proves ?? tier2.reason ?? ""),
  });
  if (tier2.available !== true) syntheticBtn.disabled = true;
  else {
    syntheticBtn.addEventListener("click", async () => {
      syntheticBtn.disabled = true;
      const answer = await m3(
        api.channelSynthetic(
          { id: ctx.id, channel: platform },
          { confirm: true, ...(text.value !== "" ? { text: text.value } : {}) },
        ),
      );
      syntheticBtn.disabled = false;
      renderOutcome(outcome, answer);
      if (answer.ok && answer.body.ok === true) reload();
    });
  }

  return el("div", { class: "control-action" }, [
    el("div", { class: "control-row" }, [probeBtn, syntheticBtn]),
    el("p", { class: "muted", text: String(tier1.proves ?? "") }),
    tier1.available === true
      ? null
      : el("p", { class: "muted gated-why", text: String(tier1.reason ?? "") }),
    tier2.available === true
      ? el("div", { class: "row-editor" }, [text])
      : el("p", { class: "muted gated-why", text: String(tier2.reason ?? "") }),
    outcome,
  ]);
}

/** Every refusal this screen can receive is a FACT about the platform or the
 *  daemon (`expected: true`), so it renders as a state rather than a toast. */
function renderOutcome(node, answer) {
  if (!answer.ok) {
    node.replaceChildren(dot("bad", String(answer.body.error ?? `HTTP ${answer.status}`)));
    return;
  }
  const body = answer.body;
  const label =
    body.ok === true
      ? String(body.proves ?? "passed")
      : String(body.reason ?? body.proves ?? "did not pass");
  node.replaceChildren(
    dot(body.ok === true ? "ok" : body.expected === true ? "off" : "warn", label),
    typeof body.status === "number"
      ? el("span", { class: "chip", text: `HTTP ${body.status}` })
      : null,
    typeof body.error === "string" && body.error !== ""
      ? el("span", { class: "muted", text: body.error })
      : null,
    body.secretNote ? el("div", { class: "muted reason", text: String(body.secretNote) }) : null,
  );
}

/** The provisioning PLAN, printed before anything is executed. */
function provisionFold(platform, ctx) {
  const body = el("div", { class: "fold-body" }, [
    el("span", { class: "muted", text: "loading…" }),
  ]);
  const fold = el("details", { class: "fold" }, [
    el("summary", { class: "fold-summary" }, [
      el("span", { class: "muted", text: `provisioning plan for ${platform}` }),
    ]),
    body,
  ]);
  let loaded = false;
  fold.addEventListener("toggle", async () => {
    if (!fold.open || loaded) return;
    loaded = true;
    const answer = await m3(api.channelProvision({ id: ctx.id, channel: platform }));
    body.replaceChildren(...planNodes(answer, platform, ctx));
  });
  return fold;
}

function planNodes(answer, platform, ctx) {
  if (!answer.ok) {
    return [
      el("p", { class: "muted", text: String(answer.body.error ?? `HTTP ${answer.status}`) }),
    ];
  }
  const view = answer.body;
  const plan = view.plan && typeof view.plan === "object" ? view.plan : {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(view.present === true ? "ok" : "off", String(plan.kind ?? "plan")),
      el("span", { class: "chip", text: "print-only — nothing has been called" }),
    ]),
    view.present === true ? null : m3Empty(view, `No ${platform} block in this spec`),
    typeof view.baseUrlNote === "string" && view.baseUrlNote !== ""
      ? el("p", { class: "muted", text: view.baseUrlNote })
      : null,
    plan.callbackUrl
      ? el("div", { class: "kv" }, [
          el("span", { class: "kv-k", text: "callback" }),
          el("span", { class: "kv-v" }, [el("code", { text: String(plan.callbackUrl) })]),
        ])
      : null,
    el(
      "ol",
      { class: "check-list" },
      steps.map((step) => el("li", { text: String(step) })),
    ),
    plan.note ? el("p", { class: "muted", text: String(plan.note) }) : null,
    typeof plan.manifest === "string" ? numberedCode(plan.manifest, "slack app manifest") : null,
    plan.request
      ? collapsible(
          [el("span", { class: "muted", text: "the request it makes" })],
          [jsonPre(plan.request)],
        )
      : null,
  ];

  const baseUrl = el("input", {
    class: "input",
    type: "url",
    placeholder: "https://your-public-host",
    "aria-label": "public base URL",
  });
  const run = el("button", { class: "btn", type: "button", text: "Run provisioning" });
  const state = el("div", { class: "control-state" });
  run.addEventListener("click", async () => {
    run.disabled = true;
    const result = await m3(
      api.channelProvisionRun(
        { id: ctx.id, channel: platform },
        { confirm: true, baseUrl: baseUrl.value },
      ),
    );
    run.disabled = false;
    if (!result.ok) {
      toast(String(result.body.error ?? `HTTP ${result.status}`));
      return;
    }
    state.replaceChildren(
      result.body.submitted === true
        ? dot("ok", "queued")
        : dot("off", String(result.body.reason ?? "not submitted")),
    );
  });
  nodes.push(el("div", { class: "row-editor" }, [baseUrl, run, state]));
  return nodes.filter((node) => node !== null);
}

function gatewayCard(body) {
  if (body.declared !== true) {
    const add = body.addBlock && typeof body.addBlock === "object" ? body.addBlock : null;
    const port = add?.value ? String(add.value.port) : "8787";
    return [
      m3Empty(body, "This spec declares no gateway: block"),
      add
        ? el("div", null, [
            el("p", {
              class: "muted",
              text: "adding one gives the daemon a /status endpoint and, with ui: true, its own mini dashboard:",
            }),
            numberedCode(`gateway:\n  port: ${port}\n  ui: true\n`, "gateway block"),
            el("p", { class: "muted", text: String(add.note ?? "") }),
          ])
        : null,
    ];
  }
  const nodes = [
    el("div", { class: "rollup" }, [
      body.status === null || body.status === undefined
        ? dot("off", "no status")
        : dot(
            "ok",
            `turns ${String(body.turnCount ?? "—")} · heartbeats ${String(body.heartbeatCount ?? "—")}`,
          ),
      el("span", { class: "chip", text: `port ${String(body.port ?? "—")}` }),
      body.ui === true ? el("span", { class: "chip", text: "ui enabled" }) : null,
      typeof body.statusReason === "string" && body.statusReason !== ""
        ? el("span", { class: "muted", text: body.statusReason })
        : null,
    ]),
  ];
  if (typeof body.dashboardUrl === "string") {
    nodes.push(
      el("p", null, [
        el("a", {
          href: body.dashboardUrl,
          target: "_blank",
          rel: "noreferrer",
          text: "open the daemon's own dashboard",
        }),
      ]),
    );
  }
  if (body.status !== null && body.status !== undefined) {
    nodes.push(
      collapsible(
        [el("span", { class: "muted", text: "gateway /status" })],
        [jsonPre(body.status)],
      ),
    );
  }
  return nodes;
}
