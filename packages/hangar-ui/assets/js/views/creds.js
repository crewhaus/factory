/**
 * Credentials — the per-harness `.env` editor (presence only), the doctor,
 * the secrets backend, and the MCP config lint. Plus the fleet-wide
 * credential matrix and its set-across action.
 *
 * VALUES ARE WRITE-ONLY, and this screen is where that promise is most
 * visible: a field accepts a value and the panel immediately re-reads
 * PRESENCE. Nothing here ever displays a secret, because nothing here ever
 * receives one back — the server returns booleans. The input is cleared the
 * instant the write returns, so the value does not even survive in the DOM.
 *
 * "Unset" writes a `# NAME=` stub rather than removing the line, so a
 * required key stays visible instead of quietly disappearing from the
 * checklist.
 *
 * Set-across is the sharpest tool in the manager: one typed value written
 * into several harnesses' own `.env` files, typed-confirm gated (the
 * operator echoes the KEY, and the SERVER verifies it), reported per
 * harness, stored nowhere.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { fmtRelativeTime } from "../util.js";

/**
 * Read one M3 route. The generated wrappers answer `{ ok, status, body }`
 * and never throw for a non-2xx, because an M3 refusal is the interesting
 * part: a 501 means "not built yet", and that is a state to render, not an
 * exception to swallow.
 */
export async function m3(call) {
  try {
    const answer = await call;
    return answer && typeof answer === "object" ? answer : { ok: false, status: 0, body: {} };
  } catch (err) {
    return { ok: false, status: 0, body: { message: err instanceof Error ? err.message : "" } };
  }
}

/** A card whose body is replaced by the server's own reason when a route is
 *  not implemented or refused. "Not built yet" is a fact, not a blank. */
export function m3Card(title, answer, build) {
  const card = el("section", { class: "card" }, [el("h3", { class: "card-title", text: title })]);
  if (!answer.ok) {
    const reason =
      (answer.body && (answer.body.error || answer.body.message)) || `HTTP ${answer.status}`;
    card.appendChild(
      el("div", { class: "rollup" }, [
        dot(
          answer.status === 501 ? "off" : "bad",
          answer.status === 501 ? "not built yet" : "unavailable",
        ),
      ]),
    );
    card.appendChild(el("p", { class: "muted", text: String(reason) }));
    return card;
  }
  for (const node of build(answer.body)) if (node) card.appendChild(node);
  return card;
}

/** The empty state every M3 read carries with it: the server names both the
 *  reason and the verb that would create the data. */
export function m3Empty(body, fallback) {
  return emptyState(
    typeof body.note === "string" && body.note !== "" ? body.note : fallback,
    typeof body.verb === "string" ? body.verb : null,
  );
}

/** Traffic-light state for one credential cell. ALWAYS paired with text. */
export function cellDot(state) {
  if (state === "set") return dot("ok", "set");
  if (state === "missing") return dot("bad", "missing");
  if (state === "commented-stub") return dot("warn", "stub");
  return dot("off", "informational");
}

/** Raw payload fold, for the operator who wants the server's own answer. */
export function rawFold(body) {
  return collapsible([el("span", { class: "muted", text: "raw payload" })], [jsonPre(body)]);
}

// ---------------------------------------------------------------------------
// The per-harness Credentials tab
// ---------------------------------------------------------------------------

export async function renderCreds(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const [envAnswer, doctorAnswer, secretsAnswer, secretsDoctorAnswer, lintAnswer] =
    await Promise.all([
      m3(api.env({ id: ctx.id })),
      m3(api.doctor({ id: ctx.id })),
      m3(api.secrets({ id: ctx.id })),
      m3(api.secretsDoctor({ id: ctx.id })),
      m3(api.mcpLint({ id: ctx.id })),
    ]);
  clear(root);
  const reload = () => renderCreds(root, ctx);

  root.appendChild(
    m3Card("Required credentials", envAnswer, (body) => envCards(body, ctx, reload)),
  );
  root.appendChild(m3Card("Doctor", doctorAnswer, (body) => doctorCard(body, ctx, reload)));
  root.appendChild(
    m3Card("Secrets backend", secretsAnswer, (body) =>
      secretsCard(body, secretsDoctorAnswer.ok ? secretsDoctorAnswer.body : null),
    ),
  );
  root.appendChild(m3Card("MCP config lint", lintAnswer, (body) => lintCard(body)));
}

function envCards(body, ctx, reload) {
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const counts = body.counts && typeof body.counts === "object" ? body.counts : {};
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(Number(counts.missing) > 0 ? "bad" : "ok", `${Number(counts.set) || 0} set`),
      el("span", { class: "chip", text: `${Number(counts.missing) || 0} missing` }),
      el("span", { class: "chip", text: `${Number(counts.commentedStub) || 0} stubs` }),
      el("span", { class: "chip", text: `${Number(counts.informational) || 0} informational` }),
    ]),
  ];

  // Precedence is SHOWN, not implied: an operator with both variables set
  // needs to know which one the adapter will actually use.
  const anthropic = body.anthropic && typeof body.anthropic === "object" ? body.anthropic : null;
  if (anthropic) {
    nodes.push(
      el("p", { class: "muted" }, [
        el("span", { text: "Anthropic auth: " }),
        el("strong", { text: String(anthropic.winner ?? "none") }),
        el("span", { text: ` (${String(anthropic.mode)}) — ${String(anthropic.note)}` }),
      ]),
    );
  }

  nodes.push(
    keys.length === 0
      ? m3Empty(body, "No credential requirement is declared by this spec")
      : keyTable(keys, ctx, reload),
  );
  nodes.push(
    el("p", { class: "muted", text: `writes go to ${String(body.editTarget ?? ".env")} (0600)` }),
  );

  const ambient = Array.isArray(body.ambient) ? body.ambient : [];
  if (ambient.length > 0) {
    nodes.push(
      collapsible(
        [el("span", { class: "muted", text: `${ambient.length} ambient credential chain(s)` })],
        [
          el(
            "ul",
            { class: "check-list" },
            ambient.map((entry) =>
              el("li", null, [
                el("code", { text: String(entry.requiredBy) }),
                el("span", { class: "muted", text: ` — ${String(entry.detail)}` }),
              ]),
            ),
          ),
        ],
      ),
    );
  }

  const orphans = Array.isArray(body.orphanStubs) ? body.orphanStubs : [];
  if (orphans.length > 0) {
    nodes.push(
      el("p", { class: "muted", text: `stubs no requirement asks for: ${orphans.join(", ")}` }),
    );
  }
  return nodes;
}

function keyTable(keys, ctx, reload) {
  const tbody = el("tbody");
  for (const key of keys) {
    tbody.appendChild(
      el("tr", null, [
        el("td", { class: "mono cell-name", text: String(key.name) }),
        el("td", null, [cellDot(String(key.state))]),
        el("td", { class: "muted", text: key.source === null ? "—" : String(key.source) }),
        el("td", { class: "muted sub", text: (key.requiredBy || []).join(", ") }),
        el("td", { class: "cell-actions" }, [setControl(ctx, String(key.name), reload)]),
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
          ["Variable", "State", "Supplied by", "Required by", "Set / unset"].map((h) =>
            el("th", { text: h }),
          ),
        ),
      ),
      tbody,
    ]),
  ]);
}

/**
 * The one write control in this screen. The input is `type="password"` with
 * autocomplete off, and it is CLEARED the moment the write returns — the
 * value has no reason to outlive the request, in the process or the DOM.
 */
function setControl(ctx, name, reload) {
  const input = el("input", {
    class: "input",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "value (write-only)",
    "aria-label": `value for ${name}`,
  });
  const set = el("button", { class: "btn btn-primary", type: "button", text: "Set" });
  set.addEventListener("click", async () => {
    const value = input.value;
    if (value === "") {
      toast("enter a value first", "info");
      return;
    }
    set.disabled = true;
    const answer = await m3(api.envSet({ id: ctx.id }, { key: name, value }));
    // Cleared FIRST, whatever happened — a failed write is no reason to keep
    // a secret sitting in a DOM node.
    input.value = "";
    set.disabled = false;
    if (!answer.ok) {
      toast(`could not set ${name}: ${String(answer.body.error ?? answer.status)}`);
      return;
    }
    reload();
  });
  const unset = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Unset",
    title: `rewrite ${name} as a "# ${name}=" stub — the requirement stays visible`,
  });
  unset.addEventListener("click", async () => {
    unset.disabled = true;
    const answer = await m3(api.envUnset({ id: ctx.id, key: name }));
    unset.disabled = false;
    if (!answer.ok) {
      toast(`could not unset ${name}: ${String(answer.body.error ?? answer.status)}`);
      return;
    }
    reload();
  });
  return el("div", { class: "row-editor" }, [input, set, unset]);
}

function doctorCard(body, ctx, reload) {
  const checks = Array.isArray(body.checks) ? body.checks : [];
  const counts = body.counts && typeof body.counts === "object" ? body.counts : {};
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(Number(counts.blocking) > 0 ? "bad" : "ok", `${Number(counts.blocking) || 0} blocking`),
      el("span", { class: "chip", text: `${Number(counts.warn) || 0} warn` }),
      el("span", { class: "chip", text: `${Number(counts.info) || 0} info` }),
    ]),
  ];
  nodes.push(
    checks.length === 0
      ? m3Empty(body, "The offline doctor has nothing to check here")
      : el(
          "ul",
          { class: "check-list" },
          checks.map((check) =>
            el("li", { class: "check" }, [
              dot(
                check.level === "blocking" ? "bad" : check.level === "warn" ? "warn" : "ok",
                String(check.level),
              ),
              el("span", { class: "pf-msg", text: String(check.message) }),
              check.remediation
                ? el("div", { class: "muted reason", text: String(check.remediation) })
                : null,
            ]),
          ),
        ),
  );

  const last = body.lastRun && typeof body.lastRun === "object" ? body.lastRun : null;
  nodes.push(
    el("p", {
      class: "muted",
      text:
        last === null
          ? "no doctor job has run from this manager yet"
          : `last run ${String(last.state)}${
              last.endedAt ? ` ${fmtRelativeTime(last.endedAt, Date.now())}` : ""
            }${last.probed ? " (with --probe)" : ""}`,
    }),
  );

  // `--probe` spends money and `--fix` writes to `.env`, so both are opt-in
  // checkboxes beside the button rather than surprises behind it.
  const probe = el("input", { type: "checkbox" });
  const fix = el("input", { type: "checkbox" });
  const run = el("button", { class: "btn", type: "button", text: "Run doctor" });
  run.addEventListener("click", async () => {
    run.disabled = true;
    const answer = await m3(
      api.doctorRun({ id: ctx.id }, { probe: probe.checked, fix: fix.checked }),
    );
    run.disabled = false;
    if (!answer.ok) {
      toast(`doctor failed to start: ${String(answer.body.error ?? answer.status)}`);
      return;
    }
    toast("doctor queued", "info");
    reload();
  });
  nodes.push(
    el("div", { class: "editor-actions" }, [
      run,
      el("label", { class: "muted" }, [
        probe,
        el("span", { text: " --probe (spends a provider call)" }),
      ]),
      el("label", { class: "muted" }, [
        fix,
        el("span", { text: " --fix (appends # NAME= stubs only)" }),
      ]),
    ]),
  );
  if (typeof body.probeNote === "string") {
    nodes.push(el("p", { class: "muted", text: body.probeNote }));
  }
  return nodes;
}

function secretsCard(body, doctorBody) {
  const names = Array.isArray(body.names) ? body.names : [];
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(body.backend === "file" ? "ok" : "off", `${String(body.backend ?? "env-var")} backend`),
      el("span", { class: "chip", text: `${names.length} secret(s)` }),
    ]),
  ];
  if (names.length === 0) {
    nodes.push(m3Empty(body, "No file-backed secrets store"));
  } else {
    const tbody = el("tbody");
    for (const entry of names) {
      tbody.appendChild(
        el("tr", null, [
          el("td", { class: "mono", text: String(entry.name) }),
          el("td", {
            class: "muted",
            text: entry.rotatedAt ? fmtRelativeTime(entry.rotatedAt, Date.now()) : "—",
          }),
          el("td", null, [
            entry.mode === "0600"
              ? dot("ok", "0600")
              : dot("warn", `${String(entry.mode)} — wider than owner-only`),
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
              ["Name", "Last rotated", "Mode"].map((h) => el("th", { text: h })),
            ),
          ),
          tbody,
        ]),
      ]),
    );
  }
  // Rotation is deliberately NOT offered: the console cannot rotate safely
  // in this build, and a button that leaks a value into a process table is
  // worse than no button. The reason is on screen, not hidden.
  nodes.push(
    el("div", { class: "gated" }, [
      el("button", { class: "btn", type: "button", text: "Rotate", disabled: true }),
      el("span", {
        class: "muted gated-why",
        text: "rotation is not wired in this build — the CLI path would put the value in argv, where any process on this machine can read it",
      }),
    ]),
  );
  if (doctorBody) {
    const unresolved = Array.isArray(doctorBody.unresolved) ? doctorBody.unresolved : [];
    nodes.push(
      el("p", {
        class: "muted",
        text:
          unresolved.length === 0
            ? "every required name resolves from the environment or the store"
            : `${unresolved.length} required name(s) resolve from neither the environment nor the store: ${unresolved
                .map((entry) => String(entry.name))
                .join(", ")}`,
      }),
    );
  }
  if (typeof body.valuesNote === "string") {
    nodes.push(el("p", { class: "muted", text: body.valuesNote }));
  }
  return nodes;
}

function lintCard(body) {
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const servers = Array.isArray(body.servers) ? body.servers : [];
  const nodes = [
    el("div", { class: "rollup" }, [
      dot(
        findings.some((finding) => finding.level === "blocking") ? "bad" : "ok",
        `${servers.length} MCP server(s)`,
      ),
    ]),
  ];
  if (findings.length === 0) {
    nodes.push(m3Empty(body, "Nothing to lint — no MCP server config here"));
    return nodes;
  }
  nodes.push(
    el(
      "ul",
      { class: "check-list" },
      findings.map((finding) =>
        el("li", { class: "check" }, [
          dot(finding.level === "blocking" ? "bad" : "warn", String(finding.kind)),
          el("span", { class: "pf-msg", text: String(finding.message) }),
          finding.remediation
            ? el("div", { class: "muted reason", text: String(finding.remediation) })
            : null,
        ]),
      ),
    ),
  );
  return nodes;
}

// ---------------------------------------------------------------------------
// The fleet-wide credentials matrix (`#/credentials`)
// ---------------------------------------------------------------------------

export async function renderCredentialsMatrix(root) {
  clear(root).appendChild(skeleton(6));
  const answer = await m3(api.credentialsMatrix());
  clear(root);
  const reload = () => renderCredentialsMatrix(root);
  root.appendChild(m3Card("Fleet credentials", answer, (body) => matrixCards(body, reload)));
}

function matrixCards(body, reload) {
  const harnesses = Array.isArray(body.harnesses) ? body.harnesses : [];
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (harnesses.length === 0) {
    return [m3Empty(body, "No harnesses are registered with this manager")];
  }
  return [
    el("div", { class: "rollup" }, [
      dot(
        harnesses.some((row) => Number(row.missing) > 0) ? "bad" : "ok",
        `${harnesses.length} harnesses · ${keys.length} credential names`,
      ),
      // A fold computed for THIS request — labelled, so the figure never
      // implies a freshness it does not have.
      el("span", {
        class: "asof",
        title: String(body.asOf ?? ""),
        text: `as of ${fmtRelativeTime(body.asOf, Date.now())}`,
      }),
    ]),
    el("p", { class: "muted", text: String(body.valuesNote ?? "") }),
    matrixTable(harnesses, keys),
    setAcrossForm(harnesses, keys, reload),
  ];
}

function matrixTable(harnesses, keys) {
  const head = el("tr", null, [
    el("th", { text: "Harness" }),
    ...keys.map((key) => el("th", { class: "mono", text: String(key.name) })),
  ]);
  const tbody = el("tbody");
  for (const row of harnesses) {
    const cells = new Map(
      (Array.isArray(row.cells) ? row.cells : []).map((cell) => [String(cell.name), cell]),
    );
    tbody.appendChild(
      el("tr", null, [
        el("td", null, [
          el("span", { class: "name-line", text: String(row.specName) }),
          el("div", { class: "mono sub", text: String(row.id) }),
        ]),
        ...keys.map((key) => {
          const cell = cells.get(String(key.name));
          return el("td", null, [
            cell === undefined
              ? el("span", { class: "muted", text: "not required" })
              : cellDot(String(cell.state)),
          ]);
        }),
      ]),
    );
  }
  return el("div", { class: "table-scroll" }, [
    el("table", { class: "fleet" }, [el("thead", null, head), tbody]),
  ]);
}

/**
 * Set-across. The most dangerous affordance in the manager, so it wears its
 * gates in the open: the operator picks the harnesses explicitly and types
 * the KEY NAME back — which the SERVER verifies, not this form.
 */
function setAcrossForm(harnesses, keys, reload) {
  const keyInput = el("input", {
    class: "input mono",
    type: "text",
    placeholder: "VARIABLE_NAME",
    "aria-label": "variable name",
    list: "cred-keys",
  });
  const datalist = el(
    "datalist",
    { id: "cred-keys" },
    keys.map((key) => el("option", { value: String(key.name) })),
  );
  const valueInput = el("input", {
    class: "input",
    type: "password",
    autocomplete: "off",
    placeholder: "value (write-only)",
    "aria-label": "value",
  });
  const confirmInput = el("input", {
    class: "input mono",
    type: "text",
    placeholder: "type the variable name to confirm",
    "aria-label": "typed confirmation",
  });
  const boxes = harnesses.map((row) => {
    const box = el("input", { type: "checkbox" });
    box.dataset.id = String(row.id);
    return el("label", { class: "chip" }, [box, el("span", { text: ` ${String(row.specName)}` })]);
  });
  const apply = el("button", {
    class: "btn btn-danger",
    type: "button",
    text: "Set across selected",
  });
  apply.addEventListener("click", async () => {
    const harnessIds = boxes
      .map((label) => label.firstChild)
      .filter((box) => box.checked)
      .map((box) => box.dataset.id);
    if (harnessIds.length === 0) {
      toast("select at least one harness", "info");
      return;
    }
    apply.disabled = true;
    const answer = await m3(
      api.credentialsSetAcross(
        {},
        {
          key: keyInput.value,
          value: valueInput.value,
          harnessIds,
          confirmName: confirmInput.value,
        },
      ),
    );
    valueInput.value = "";
    apply.disabled = false;
    if (!answer.ok) {
      toast(String(answer.body.error ?? `HTTP ${answer.status}`));
      return;
    }
    const written = Array.isArray(answer.body.written) ? answer.body.written.length : 0;
    const refused = Array.isArray(answer.body.refused) ? answer.body.refused : [];
    toast(
      `wrote ${written} harness(es)${refused.length > 0 ? `, ${refused.length} refused` : ""}`,
      refused.length > 0 ? "error" : "info",
    );
    reload();
  });
  return el("section", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Set one variable across selected harnesses" }),
      dot("warn", "typed confirmation required"),
    ]),
    el("p", {
      class: "muted",
      text: "each harness is written through its own .env; this manager keeps no copy of the value",
    }),
    el("div", { class: "chip-group" }, boxes),
    el("div", { class: "row-editor" }, [datalist, keyInput, valueInput, confirmInput, apply]),
  ]);
}
