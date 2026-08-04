/**
 * Dev & MCP — the two remaining supervised run classes: the `serve --mcp` /
 * `expose:` projection, and the `crewhaus dev` watch-recompile-relaunch
 * loop.
 *
 * Both are PROCESSES, not panels: they go through the manager's own process
 * layer and get a row in the harness's run ledger, so the next manager boot
 * still sees them in history. Their live output is the EXISTING run console —
 * these screens hand off a `runId` to `#/h/<id>/runs/<runId>` rather than
 * opening a second stream.
 *
 * The reason dev mode is driven from here at all: `crewhaus dev` normally
 * compiles into a temp directory and runs with that as the cwd, so sessions,
 * memory and feedback land somewhere that disappears. The manager owns the
 * spawn and sets the cwd to the harness dir, which keeps state in the
 * harness's own `.crewhaus/` across every recompile. The card says which
 * state roots are actually anchored rather than claiming a blanket fix.
 *
 * THREE PROJECTION ANSWERS, NEVER CONFLATED. A `cli` shape projects through a
 * separate `crewhaus serve --mcp` process the manager can start; a
 * channel/managed daemon self-exposes from its own compiled bundle, so the
 * honest control there is the daemon's Start, not a second one; every other
 * shape does not project at all. A Start button on the second or third case
 * would be a dead button, so it is not offered — the reason is.
 */

import { api } from "../api.js";
import { asOf, clear, collapsible, dot, el, emptyState, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtRelativeTime } from "../util.js";
import { cliTwin, gatedBtn, runAction } from "./control.js";

export async function renderRuntime(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const [mcp, dev] = await Promise.all([api.mcpServers({ id: ctx.id }), api.dev({ id: ctx.id })]);
  clear(root);
  const reload = () => renderRuntime(root, ctx);
  root.appendChild(mcpCard(ctx, mcp, reload));
  root.appendChild(devCard(ctx, dev, reload));
}

function errorCard(title, res) {
  const message =
    typeof res?.body?.error === "string" ? res.body.error : `HTTP ${res ? res.status : "?"}`;
  return el("section", { class: "card error-card" }, [
    el("h3", { class: "card-title" }, [dot("bad", title)]),
    el("p", { class: "muted", text: message }),
  ]);
}

/** A write whose REFUSAL is a payload: `{ok:false, code, reason}`. Reporting
 *  it is the whole point — a refusal is information, not an error toast. */
function reportWrite(res, label, reload) {
  if (!res) return;
  if (!res.ok) {
    toast(`${label} failed: ${res.body?.error ?? `HTTP ${res.status}`}`);
    return;
  }
  const body = res.body ?? {};
  if (body.ok === false) {
    toast(String(body.reason ?? `${label} was refused`));
  } else if (body.started === true) {
    toast(`${label}: started — watch it in the run console`, "info");
  } else if (body.stopped === false) {
    // "Nothing was signalled" must never read as "stopped".
    toast(String(body.message ?? `${label} signalled nothing`));
  } else if (body.stopped === true) {
    toast(String(body.message ?? `${label}: stopped`), "info");
  }
  void reload();
}

/** The runs table both cards share; each row links into the ONE run feed. */
function runsTable(ctx, runs) {
  const nowMs = Date.now();
  const tbody = el("tbody");
  for (const run of runs) {
    const runId = typeof run.runId === "string" ? run.runId : null;
    tbody.appendChild(
      el("tr", null, [
        el("td", null, [
          runId === null
            ? el("span", { class: "mono muted", text: String(run.jobId ?? "—") })
            : el("a", {
                class: "mono",
                href: hrefHarness(ctx.id, "runs", runId),
                text: runId,
              }),
        ]),
        el("td", null, [stateDot(String(run.state ?? "unknown"))]),
        el("td", { class: "mono", text: (run.argv ?? []).join(" ") }),
        el("td", {
          text:
            typeof run.startedAt === "string"
              ? fmtRelativeTime(run.startedAt, nowMs)
              : `queued ${fmtRelativeTime(String(run.enqueuedAt ?? ""), nowMs)}`,
        }),
        el("td", {
          class: "num",
          text: typeof run.exitCode === "number" ? String(run.exitCode) : "—",
        }),
        el("td", { class: "muted", text: typeof run.error === "string" ? run.error : "" }),
      ]),
    );
  }
  return el("div", { class: "table-scroll" }, [
    el("table", { class: "fleet" }, [
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          ["Run", "State", "Command", "When", "Exit", "Note"].map((h) => el("th", { text: h })),
        ),
      ),
      tbody,
    ]),
  ]);
}

/** Traffic light + text, always paired. */
function stateDot(state) {
  if (state === "running") return dot("ok", "running");
  if (state === "pending") return dot("warn", "queued");
  if (state === "done") return dot("ok", "done");
  if (state === "failed") return dot("bad", "failed");
  if (state === "interrupted") return dot("warn", "interrupted (manager restarted)");
  if (state === "cancelled") return dot("off", "cancelled");
  return dot("unknown", state);
}

// ---------------------------------------------------------------------------
// The MCP projection
// ---------------------------------------------------------------------------

function mcpCard(ctx, res, reload) {
  if (!res.ok) return errorCard("The MCP projection could not be read", res);
  const view = res.body ?? {};
  const projection = String(view.projection ?? "none");
  const running = view.running === true;
  const health = view.health && typeof view.health === "object" ? view.health : {};
  const supervision =
    view.supervision && typeof view.supervision === "object" ? view.supervision : {};

  const kv = (k, v) =>
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: k }),
      typeof v === "string"
        ? el("span", { class: "kv-v", text: v })
        : el("span", { class: "kv-v" }, [v]),
    ]);

  const facts = el("div", { class: "proc-facts" }, [
    kv("shape", String(view.target ?? "—")),
    kv(
      "projection",
      projection === "serve"
        ? dot("ok", "a separate `serve --mcp` process")
        : projection === "self"
          ? dot("unknown", "the daemon exposes itself")
          : dot("off", "this shape does not project"),
    ),
    kv("state", running ? dot("ok", "running") : dot("off", "not running")),
    kv("transport", String(view.transport ?? "—")),
    kv("port", typeof view.port === "number" ? String(view.port) : "—"),
    kv(
      "listening",
      health.checked === true
        ? el("span", null, [
            health.listening === true
              ? dot("ok", "something is bound on loopback")
              : dot("bad", "nothing is bound on that port"),
            typeof health.at === "string" ? asOf(health.at) : null,
          ])
        : dot("unknown", "not probed"),
    ),
  ]);
  if (typeof health.note === "string") {
    facts.appendChild(el("p", { class: "muted reason", text: health.note }));
  }

  const actions = el("div", { class: "proc-actions" });
  const startGate =
    projection === "serve"
      ? { enabled: !running, reason: running ? "a projection is already running" : null }
      : { enabled: false, reason: String(view.projectionNote ?? "this shape does not project") };
  const transportPick = el("select", { class: "search", "aria-label": "transport" });
  for (const option of ["stdio", "http"]) {
    const node = el("option", { value: option, text: option === "http" ? "HTTP + SSE" : "stdio" });
    if (String(view.transport ?? "stdio") === option) node.selected = true;
    transportPick.appendChild(node);
  }
  const startBtn = gatedBtn(
    "Start projection",
    startGate,
    () => {
      runAction(
        startBtn,
        "Start projection",
        () => api.mcpServerStart({ id: ctx.id }, { transport: transportPick.value }),
        (r) => reportWrite(r, "Start projection", reload),
      );
    },
    "btn btn-primary",
  );
  const stopGate = {
    enabled: running || supervision.stoppable === true,
    reason: supervision.reason ?? "nothing to stop",
  };
  const stopBtn = gatedBtn("Stop", stopGate, () => {
    runAction(
      stopBtn,
      "Stop",
      () => api.mcpServerStop({ id: ctx.id }, {}),
      (r) => reportWrite(r, "Stop", reload),
    );
  });
  actions.appendChild(transportPick);
  actions.appendChild(startBtn);
  actions.appendChild(stopBtn);

  const reasons = el("div", { class: "proc-reasons" });
  if (!startGate.enabled && startGate.reason) {
    reasons.appendChild(
      el("div", { class: "muted gated-why", text: `start: ${startGate.reason}` }),
    );
  }
  if (supervision.stoppable !== true && typeof supervision.reason === "string") {
    reasons.appendChild(
      el("div", { class: "muted gated-why", text: `stop: ${supervision.reason}` }),
    );
  }

  const runs = Array.isArray(view.runs) ? view.runs : [];
  const card = el("section", { class: "card ov-wide" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "MCP projection" }),
      running ? dot("ok", "running") : dot("off", "idle"),
    ]),
    el("p", { class: "muted", text: String(view.projectionNote ?? "") }),
    facts,
    el("div", { class: "proc-bar" }, [actions, reasons]),
    cliTwin(
      typeof view.cliTwin === "string" ? view.cliTwin : "",
      "no crewhaus.yaml at the harness root — there is no command to run",
    ),
  ]);

  if (runs.length === 0) {
    card.appendChild(
      emptyState(
        typeof view.note === "string" && view.note !== ""
          ? view.note
          : "This harness has never projected an MCP server",
        typeof view.verb === "string" ? view.verb : null,
      ),
    );
  } else {
    card.appendChild(runsTable(ctx, runs));
  }
  const ledger = Array.isArray(view.ledger) ? view.ledger : [];
  if (ledger.length > 0) {
    card.appendChild(
      collapsible(
        [el("span", { class: "muted", text: `run-ledger rows — ${ledger.length}` })],
        [
          el(
            "div",
            { class: "check-list" },
            ledger.map((row) =>
              el("div", { class: "check" }, [
                el("span", { class: "mono", text: String(row.runId ?? "") }),
                el("span", { class: "muted", text: (row.argv ?? []).join(" ") }),
              ]),
            ),
          ),
        ],
      ),
    );
  }
  return card;
}

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------

function devCard(ctx, res, reload) {
  if (!res.ok) return errorCard("Dev mode could not be read", res);
  const view = res.body ?? {};
  const running = view.running === true;
  const blocked = view.blocked === true;
  const supervision =
    view.supervision && typeof view.supervision === "object" ? view.supervision : {};
  const lastCompile =
    view.lastCompile && typeof view.lastCompile === "object" ? view.lastCompile : null;
  const roots = Array.isArray(view.stateRoots) ? view.stateRoots : [];

  const kv = (k, v) =>
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: k }),
      typeof v === "string"
        ? el("span", { class: "kv-v", text: v })
        : el("span", { class: "kv-v" }, [v]),
    ]);

  const facts = el("div", { class: "proc-facts" }, [
    kv(
      "state",
      running ? dot("ok", `running (${String(view.mode ?? "watch")})`) : dot("off", "not running"),
    ),
    kv(
      "run",
      typeof view.runId === "string"
        ? el("a", {
            class: "mono",
            href: hrefHarness(ctx.id, "runs", view.runId),
            text: view.runId,
          })
        : "—",
    ),
    kv("watching", (Array.isArray(view.watching) ? view.watching : []).join(", ") || "—"),
    kv("cwd", String(view.cwd ?? "—")),
    kv(
      "last compile",
      lastCompile === null
        ? dot("unknown", "nothing compiled here yet")
        : el("span", null, [
            lastCompile.state === "done"
              ? dot("ok", "clean")
              : lastCompile.state === "failed"
                ? dot("bad", `failed (exit ${lastCompile.exitCode ?? "?"})`)
                : dot("warn", String(lastCompile.state ?? "unknown")),
            typeof lastCompile.at === "string" ? asOf(lastCompile.at) : null,
          ]),
    ),
  ]);
  facts.appendChild(el("p", { class: "muted reason", text: String(view.cwdNote ?? "") }));

  // Which parts of the state tree the manager has actually anchored — the
  // honest version of "dev's temp-cwd trap is fixed".
  const rootList = el("div", { class: "check-list" });
  for (const root of roots) {
    rootList.appendChild(
      el("div", { class: "check" }, [
        root.anchored === true
          ? dot("ok", `${String(root.name)} → ${String(root.value)}`)
          : dot("unknown", `${String(root.name)} — not pinned (follows the child's cwd)`),
      ]),
    );
  }

  const checkOnly = el("input", { type: "checkbox", id: "dev-check-only" });
  const startGate = {
    enabled: !running && !blocked && typeof view.verb === "string",
    reason: blocked
      ? String(view.blockedReason ?? "a supervised daemon is running")
      : running
        ? "a dev loop is already running"
        : typeof view.verb === "string"
          ? null
          : String(view.note ?? "there is nothing to watch"),
  };
  const startBtn = gatedBtn(
    "Start dev loop",
    startGate,
    () => {
      runAction(
        startBtn,
        "Start dev loop",
        () => api.devStart({ id: ctx.id }, { checkOnly: checkOnly.checked }),
        (r) => reportWrite(r, "Start dev loop", reload),
      );
    },
    "btn btn-primary",
  );
  const stopGate = {
    enabled: running || supervision.stoppable === true,
    reason: supervision.reason ?? "nothing to stop",
  };
  const stopBtn = gatedBtn("Stop", stopGate, () => {
    runAction(
      stopBtn,
      "Stop",
      () => api.devStop({ id: ctx.id }, {}),
      (r) => reportWrite(r, "Stop", reload),
    );
  });

  const reasons = el("div", { class: "proc-reasons" });
  if (!startGate.enabled && startGate.reason) {
    reasons.appendChild(
      el("div", { class: "muted gated-why", text: `start: ${startGate.reason}` }),
    );
  }
  if (supervision.stoppable !== true && typeof supervision.reason === "string") {
    reasons.appendChild(
      el("div", { class: "muted gated-why", text: `stop: ${supervision.reason}` }),
    );
  }

  const runs = Array.isArray(view.runs) ? view.runs : [];
  const card = el("section", { class: "card ov-wide" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Dev mode" }),
      running ? dot("ok", `watching (${String(view.mode ?? "watch")})`) : dot("off", "idle"),
    ]),
    facts,
    collapsible(
      [el("span", { class: "muted", text: "state roots the manager anchored" })],
      [rootList],
    ),
    el("div", { class: "proc-bar" }, [
      el("div", { class: "proc-actions" }, [
        el("label", { class: "muted", for: "dev-check-only" }, [
          checkOnly,
          el("span", { text: " validate only (compile --check --watch)" }),
        ]),
        startBtn,
        stopBtn,
      ]),
      reasons,
    ]),
    cliTwin(
      typeof view.cliTwin === "string" ? view.cliTwin : "",
      "no crewhaus.yaml at the harness root — there is no command to run",
    ),
  ]);

  if (runs.length === 0) {
    card.appendChild(
      emptyState(
        typeof view.note === "string" && view.note !== ""
          ? view.note
          : "No dev loop has run for this harness",
        typeof view.verb === "string" ? view.verb : null,
      ),
    );
  } else {
    card.appendChild(runsTable(ctx, runs));
  }
  card.appendChild(
    el("div", { class: "proc-links" }, [
      el("a", { href: hrefHarness(ctx.id, "runs"), text: "run history →" }),
      el("a", { href: hrefHarness(ctx.id, "overview"), text: "process card →" }),
    ]),
  );
  return card;
}
