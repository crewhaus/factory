/**
 * Inspect — the browsers that make "inspect ALL captured data" literally
 * true: scope-audit, the prompt-cache rotation record, logs, skills,
 * commands, preferences, settings.json, knowledge.json, identity.json,
 * meta.json and environments.json — plus a generic raw browser for anything
 * unrecognized.
 *
 * Three subtrees are deliberately unreachable and the screen says so rather
 * than showing an empty folder: `secrets/`, the raw audit files (rendered
 * only as verified records on the Security tab), and `.env` (presence
 * booleans only, on the Credentials tab). The server refuses them — this
 * screen only explains them, which is why the exclusions arrive as DATA.
 *
 * The other half of that honesty is `unmodelled`: a `.crewhaus/` entry this
 * manager version has no rich view for is NAMED, with the raw browser one
 * click away. "We have not modelled this yet" is a true sentence; an empty
 * folder is not.
 *
 * `identity.json` displays the Ed25519 FINGERPRINT — the one that stamps
 * every trace envelope. The key material never reaches this browser at all:
 * the server projects it to presence booleans. Everything here is read-only
 * except `settings.json`, which is human-owned configuration and therefore
 * carries the same redacted diff plus typed confirmation the spec's
 * human-owned paths do.
 */

import { api } from "../api.js";
import {
  asOf,
  clear,
  collapsible,
  copyBtn,
  dot,
  el,
  emptyState,
  jsonPre,
  numberedCode,
  skeleton,
  toast,
} from "../dom.js";
import { fmtCount, fmtRelativeTime } from "../util.js";

/** The store opened when the screen first paints — the one that answers
 *  "what is this agent allowed to do", which is what people come here for. */
const DEFAULT_STORE = "settings";

export async function renderInspect(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const res = await api.inspectIndex({ id: ctx.id });
  clear(root);
  if (!res.ok) {
    root.appendChild(errorCard("The inspect index could not be read", res));
    return;
  }
  const view = res.body ?? {};
  const state = {
    store: DEFAULT_STORE,
    entry: null,
    rawPath: typeof view.root === "string" ? view.root : ".crewhaus",
  };

  const indexHost = el("div");
  const storeHost = el("div", { class: "tab-section" });
  const rawHost = el("div", { class: "tab-section" });
  root.appendChild(indexHost);
  root.appendChild(storeHost);
  root.appendChild(rawHost);

  const openStore = async (store, entry = null) => {
    state.store = store;
    state.entry = entry;
    await paintStore(storeHost, ctx, state, openStore);
  };
  const openRaw = async (path) => {
    state.rawPath = path;
    await paintRaw(rawHost, ctx, state, openRaw);
  };

  indexHost.appendChild(indexCard(view, openStore, openRaw));
  await openStore(state.store);
  await openRaw(state.rawPath);
}

/** A failed read, said out loud. No screen in this console fails silently. */
function errorCard(title, res) {
  const message =
    typeof res?.body?.error === "string"
      ? res.body.error
      : typeof res?.body?.message === "string"
        ? res.body.message
        : `HTTP ${res ? res.status : "?"}`;
  return el("div", { class: "card error-card" }, [
    el("h3", { class: "card-title" }, [dot("bad", title)]),
    el("p", { class: "muted", text: message }),
  ]);
}

// ---------------------------------------------------------------------------
// The store index
// ---------------------------------------------------------------------------

function indexCard(view, openStore, openRaw) {
  const stores = Array.isArray(view.stores) ? view.stores : [];
  const excluded = Array.isArray(view.excluded) ? view.excluded : [];
  const unmodelled = Array.isArray(view.unmodelled) ? view.unmodelled : [];
  const present = stores.filter((s) => s.present === true).length;
  const nowMs = Date.now();

  const tbody = el("tbody");
  for (const store of stores) {
    const name = el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: String(store.store ?? ""),
    });
    name.addEventListener("click", () => {
      void openStore(String(store.store ?? ""));
    });
    tbody.appendChild(
      el("tr", null, [
        el("td", null, [name]),
        el("td", null, [
          store.present === true
            ? dot("ok", store.kind === "dir" ? "directory" : "file")
            : dot("off", "not written yet"),
        ]),
        el("td", { class: "mono", text: String(store.path ?? "") }),
        el("td", {
          class: "num",
          text:
            typeof store.entries === "number"
              ? fmtCount(store.entries)
              : typeof store.bytes === "number"
                ? `${fmtCount(store.bytes)} B`
                : "—",
        }),
        el("td", {
          text:
            typeof store.modifiedAt === "string" ? fmtRelativeTime(store.modifiedAt, nowMs) : "—",
        }),
        el("td", { class: "muted", text: String(store.what ?? "") }),
      ]),
    );
  }

  const card = el("section", { class: "card ov-wide" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Inspect" }),
      dot(present > 0 ? "ok" : "off", `${present} of ${stores.length} stores written`),
      el("span", { class: "muted card-sub", text: String(view.root ?? ".crewhaus") }),
    ]),
    stores.length === 0
      ? emptyState(
          typeof view.note === "string" ? view.note : "No inspectable stores yet",
          typeof view.verb === "string" ? view.verb : null,
        )
      : el("div", { class: "table-scroll" }, [
          el("table", { class: "fleet" }, [
            el(
              "thead",
              null,
              el(
                "tr",
                null,
                ["Store", "State", "Path", "Size", "Changed", "What it holds"].map((h) =>
                  el("th", { text: h }),
                ),
              ),
            ),
            tbody,
          ]),
        ]),
  ]);

  if (unmodelled.length > 0) {
    const chips = el("div", { class: "chip-group" });
    for (const name of unmodelled) {
      const chip = el("button", { class: "btn btn-ghost", type: "button", text: String(name) });
      chip.addEventListener("click", () => {
        void openRaw(`${String(view.root ?? ".crewhaus")}/${String(name)}`);
      });
      chips.appendChild(chip);
    }
    card.appendChild(
      el("div", { class: "rollup" }, [
        dot("unknown", "recognized, but no rich view here yet"),
        el("span", {
          class: "muted",
          text:
            typeof view.unmodelledNote === "string"
              ? view.unmodelledNote
              : "open these with the raw browser below",
        }),
      ]),
    );
    card.appendChild(chips);
  }

  if (excluded.length > 0) {
    const list = el("div", { class: "check-list" });
    for (const item of excluded) {
      list.appendChild(
        el("div", { class: "check" }, [
          dot("off", String(item.path ?? "")),
          el("div", { class: "muted reason", text: String(item.reason ?? "") }),
          el("div", { class: "muted reason", text: `available on: ${String(item.where ?? "")}` }),
        ]),
      );
    }
    card.appendChild(
      collapsible(
        [
          el("span", { class: "muted", text: "excluded from every inspect route — on purpose" }),
          el("span", { class: "chip", text: String(excluded.length) }),
        ],
        [list],
        true,
      ),
    );
  }
  return card;
}

// ---------------------------------------------------------------------------
// One store
// ---------------------------------------------------------------------------

async function paintStore(host, ctx, state, openStore) {
  clear(host).appendChild(skeleton(4));
  const res =
    state.entry === null
      ? await api.inspectStore({ id: ctx.id, store: state.store })
      : await api.inspectEntry({ id: ctx.id, store: state.store, name: state.entry });
  clear(host);
  if (!res.ok) {
    host.appendChild(errorCard(`Could not read "${state.store}"`, res));
    return;
  }
  const view = res.body ?? {};
  const title = state.entry === null ? state.store : `${state.store} / ${state.entry}`;

  const head = el("h3", { class: "card-title" }, [
    el("span", { text: String(title) }),
    view.present === true ? dot("ok", "present") : dot("off", "nothing written yet"),
    el("span", { class: "muted card-sub", text: String(view.path ?? "") }),
  ]);
  const card = el("section", { class: "card ov-wide" }, [head]);

  if (state.entry !== null) {
    const back = el("button", { class: "btn btn-ghost", type: "button", text: "← all entries" });
    back.addEventListener("click", () => {
      void openStore(state.store, null);
    });
    card.appendChild(back);
  }

  if (view.present !== true) {
    card.appendChild(
      emptyState(
        typeof view.note === "string" ? view.note : "Nothing written here yet",
        typeof view.verb === "string" ? view.verb : null,
      ),
    );
    host.appendChild(card);
    return;
  }

  const entries = Array.isArray(view.entries) ? view.entries : [];
  const files = Array.isArray(view.files) ? view.files : [];
  const rows = entries.length > 0 ? entries : files;
  if (rows.length > 0) {
    card.appendChild(entryTable(rows, state, openStore));
    if (view.truncated === true) {
      card.appendChild(
        el("p", {
          class: "muted",
          text: "the listing was capped — open the rest with the raw browser",
        }),
      );
    }
  }

  if (state.store === "identity" && view.document && typeof view.document === "object") {
    card.appendChild(identityCard(view.document));
  } else if (state.store === "settings" && state.entry === null) {
    card.appendChild(settingsPanel(ctx, view, () => openStore("settings", null)));
  } else if (view.document && typeof view.document === "object") {
    card.appendChild(jsonPre(view.document));
  }

  if (typeof view.text === "string" && view.text !== "") {
    card.appendChild(numberedCode(view.text, String(title)));
  }
  if (typeof view.parseError === "string" && view.parseError !== "") {
    card.appendChild(
      el("p", { class: "muted", text: `this file did not parse: ${view.parseError}` }),
    );
  }
  if (view.truncated === true && typeof view.text === "string") {
    card.appendChild(el("p", { class: "muted", text: "shown up to the read cap" }));
  }
  host.appendChild(card);
}

function entryTable(rows, state, openStore) {
  const nowMs = Date.now();
  const tbody = el("tbody");
  for (const row of rows) {
    const name = String(row.name ?? "");
    const cell =
      state.entry === null && row.kind !== "other"
        ? (() => {
            const btn = el("button", { class: "btn btn-ghost", type: "button", text: name });
            btn.addEventListener("click", () => {
              void openStore(state.store, name);
            });
            return btn;
          })()
        : el("span", { class: "mono", text: name });
    tbody.appendChild(
      el("tr", null, [
        el("td", null, [cell]),
        el("td", null, [
          row.kind === "other"
            ? dot("warn", "not readable from here")
            : dot("ok", row.kind === "dir" ? "directory" : "file"),
        ]),
        el("td", {
          class: "num",
          text: typeof row.bytes === "number" ? `${fmtCount(row.bytes)} B` : "—",
        }),
        el("td", {
          text: typeof row.modifiedAt === "string" ? fmtRelativeTime(row.modifiedAt, nowMs) : "—",
        }),
        el("td", { class: "muted", text: typeof row.note === "string" ? row.note : "" }),
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
          ["Name", "Kind", "Size", "Changed", "Note"].map((h) => el("th", { text: h })),
        ),
      ),
      tbody,
    ]),
  ]);
}

/** The fingerprint that stamps every trace envelope — and PRESENCE, never a
 *  value, for the key material sitting beside it in the same file. */
function identityCard(doc) {
  const kv = (k, v) =>
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: k }),
      typeof v === "string"
        ? el("span", { class: "kv-v mono", text: v })
        : el("span", { class: "kv-v" }, [v]),
    ]);
  return el("div", { class: "proc-facts" }, [
    kv("fingerprint", String(doc.fingerprint ?? "—")),
    kv("short", String(doc.fingerprintShort ?? "—")),
    kv("algorithm", String(doc.algorithm ?? "—")),
    kv("created", String(doc.createdAt ?? "—")),
    kv("public key", doc.publicKeyPresent === true ? dot("ok", "present") : dot("off", "absent")),
    kv(
      "private key",
      doc.privateKeyPresent === true
        ? dot("ok", "present on disk — never served")
        : dot("off", "absent"),
    ),
    el("p", {
      class: "muted reason",
      text: "this fingerprint is stamped onto every trace envelope and audit record; the key material stays on disk and is never sent to this browser",
    }),
  ]);
}

// ---------------------------------------------------------------------------
// settings.json — the one write on this surface
// ---------------------------------------------------------------------------

/**
 * The settings editor.
 *
 * Human-owned configuration, so it takes the same route the spec's
 * human-owned paths do: Preview first (a server-computed, credential-redacted
 * diff), then a typed confirmation the SERVER verifies. Nothing here
 * auto-tunes, and nothing merges — the editor holds the whole next document,
 * so what an operator confirmed is exactly what lands.
 */
function settingsPanel(ctx, view, reload) {
  const summary = view.summary && typeof view.summary === "object" ? view.summary : {};
  const rules =
    summary.permissionRules && typeof summary.permissionRules === "object"
      ? summary.permissionRules
      : { allow: 0, deny: 0, ask: 0 };
  const hooks = Array.isArray(summary.hooks) ? summary.hooks : [];
  const source = JSON.stringify(view.document ?? {}, null, 2);

  const facts = el("div", { class: "proc-facts" }, [
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "permission rules" }),
      el("span", { class: "kv-v" }, [
        el("span", { class: "chip", text: `allow ${fmtCount(rules.allow ?? 0)}` }),
        el("span", { class: "chip", text: `deny ${fmtCount(rules.deny ?? 0)}` }),
        el("span", { class: "chip", text: `ask ${fmtCount(rules.ask ?? 0)}` }),
      ]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "hooks" }),
      el("span", { class: "kv-v" }, [
        hooks.length === 0 ? dot("off", "none") : dot("ok", `${fmtCount(hooks.length)} wired`),
      ]),
    ]),
  ]);
  for (const hook of hooks) {
    facts.appendChild(
      el("div", { class: "kv" }, [
        el("span", { class: "kv-k", text: String(hook.event ?? "hook") }),
        el("span", { class: "kv-v mono", text: String(hook.command ?? "") }),
      ]),
    );
  }

  const editor = el("textarea", { class: "notes", rows: "14", spellcheck: "false" });
  editor.value = source;
  const diffHost = el("div");
  const confirm = el("input", {
    class: "token-input",
    type: "text",
    placeholder: "type the spec name to confirm",
    "aria-label": "typed confirmation",
  });

  const parsed = () => {
    try {
      return { ok: true, value: JSON.parse(editor.value) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

  const previewBtn = el("button", { class: "btn", type: "button", text: "Preview changes" });
  previewBtn.addEventListener("click", async () => {
    const next = parsed();
    if (!next.ok) {
      toast(`That is not valid JSON: ${next.message}`);
      return;
    }
    const res = await api.settingsWrite({ id: ctx.id }, { settings: next.value, dryRun: true });
    clear(diffHost);
    if (!res.ok) {
      diffHost.appendChild(errorCard("Preview failed", res));
      return;
    }
    const body = res.body ?? {};
    const issues = Array.isArray(body.issues) ? body.issues : [];
    const diff = Array.isArray(body.diff) ? body.diff : [];
    diffHost.appendChild(
      el("div", { class: "rollup" }, [
        issues.length === 0
          ? dot("ok", diff.length === 0 ? "no changes" : `${fmtCount(diff.length)} changed lines`)
          : dot("bad", `${fmtCount(issues.length)} problems — this would break the agent's rules`),
        typeof body.note === "string" ? el("span", { class: "muted", text: body.note }) : null,
      ]),
    );
    for (const issue of issues) {
      diffHost.appendChild(
        el("div", { class: "muted reason", text: `${issue.path || "(root)"}: ${issue.message}` }),
      );
    }
    if (diff.length > 0)
      diffHost.appendChild(el("pre", { class: "prose-pre", text: diff.join("\n") }));
    if (typeof body.confirmName === "string") {
      confirm.placeholder = `type "${body.confirmName}" to confirm`;
    }
  });

  const applyBtn = el("button", { class: "btn btn-danger", type: "button", text: "Apply" });
  applyBtn.addEventListener("click", async () => {
    const next = parsed();
    if (!next.ok) {
      toast(`That is not valid JSON: ${next.message}`);
      return;
    }
    const res = await api.settingsWrite(
      { id: ctx.id },
      { settings: next.value, confirmName: confirm.value },
    );
    if (!res.ok) {
      toast(
        res.status === 409
          ? "This write needs the harness's spec name typed in, exactly."
          : `Apply failed: ${res.body?.error ?? `HTTP ${res.status}`}`,
      );
      return;
    }
    toast("settings.json written", "info");
    void reload();
  });

  return el("div", null, [
    facts,
    collapsible(
      [
        el("span", { class: "muted", text: "edit settings.json" }),
        el("span", { class: "chip chip-warn", text: "human-owned" }),
      ],
      [
        el("p", {
          class: "muted",
          text: "These rules decide what the agent may do. Preview shows a credential-redacted diff; applying needs the harness's spec name typed in, and the server checks it.",
        }),
        editor,
        el("div", { class: "editor-actions" }, [previewBtn, confirm, applyBtn]),
        diffHost,
      ],
    ),
    collapsible(
      [el("span", { class: "muted", text: "raw document" })],
      [jsonPre(view.document ?? {})],
    ),
  ]);
}

// ---------------------------------------------------------------------------
// The generic raw browser
// ---------------------------------------------------------------------------

async function paintRaw(host, ctx, state, openRaw) {
  clear(host).appendChild(skeleton(3));
  const res = await api.inspectRaw(
    { id: ctx.id },
    undefined,
    `?path=${encodeURIComponent(state.rawPath)}`,
  );
  clear(host);
  const card = el("section", { class: "card ov-wide" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Raw browser" }),
      dot("unknown", "read-only"),
      el("span", { class: "muted card-sub", text: state.rawPath }),
    ]),
  ]);

  const input = el("input", {
    class: "search",
    type: "text",
    "aria-label": "harness-relative path",
  });
  input.value = state.rawPath;
  const go = el("button", { class: "btn", type: "button", text: "Open" });
  go.addEventListener("click", () => {
    void openRaw(input.value.trim());
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void openRaw(input.value.trim());
  });
  card.appendChild(el("div", { class: "toolbar" }, [input, go, crumbs(state.rawPath, openRaw)]));

  if (!res.ok) {
    // A 403 here is the allowlist doing its job, not a fault — say which.
    card.appendChild(
      res.status === 403
        ? el("div", { class: "rollup" }, [
            dot("off", "excluded on purpose"),
            el("span", {
              class: "muted",
              text:
                res.body && typeof res.body.error === "string"
                  ? res.body.error
                  : "this path is never served raw",
            }),
          ])
        : errorCard("That path could not be read", res),
    );
    host.appendChild(card);
    return;
  }

  const view = res.body ?? {};
  card.appendChild(
    el("div", { class: "rollup" }, [
      view.modelled ? dot("ok", `modelled as "${view.modelled}"`) : dot("unknown", "unmodelled"),
      el("span", { class: "muted", text: String(view.modelledNote ?? "") }),
    ]),
  );

  if (view.present !== true) {
    card.appendChild(
      emptyState(typeof view.note === "string" ? view.note : "Nothing at that path"),
    );
    host.appendChild(card);
    return;
  }

  if (view.kind === "dir") {
    const entries = Array.isArray(view.entries) ? view.entries : [];
    const hidden = Array.isArray(view.excludedHere) ? view.excludedHere : [];
    if (entries.length === 0) {
      card.appendChild(emptyState("This directory holds nothing readable from here"));
    } else {
      const list = el("div", { class: "chip-group" });
      for (const entry of entries) {
        const name = String(entry.name ?? "");
        const btn = el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: entry.kind === "dir" ? `${name}/` : name,
          title: entry.kind === "other" ? String(entry.note ?? "not readable") : name,
        });
        if (entry.kind === "other") btn.disabled = true;
        else {
          btn.addEventListener("click", () => {
            void openRaw(`${state.rawPath}/${name}`);
          });
        }
        list.appendChild(btn);
      }
      card.appendChild(list);
    }
    if (hidden.length > 0) {
      card.appendChild(
        el("div", { class: "rollup" }, [
          dot("off", `${fmtCount(hidden.length)} entries excluded here`),
          el("span", { class: "muted", text: hidden.join(", ") }),
        ]),
      );
    }
    host.appendChild(card);
    return;
  }

  card.appendChild(
    el("div", { class: "h-dir" }, [
      el("span", { class: "mono muted", text: String(view.path ?? "") }),
      copyBtn(String(view.path ?? ""), "copy path"),
      typeof view.modifiedAt === "string" ? asOf(view.modifiedAt) : null,
    ]),
  );
  if (view.document && typeof view.document === "object") card.appendChild(jsonPre(view.document));
  if (typeof view.text === "string" && view.text !== "") {
    card.appendChild(numberedCode(view.text, String(view.path ?? "file")));
  }
  if (view.truncated === true) {
    card.appendChild(el("p", { class: "muted", text: "shown up to the read cap" }));
  }
  host.appendChild(card);
}

/** Clickable breadcrumbs for the current raw path. */
function crumbs(path, openRaw) {
  const parts = String(path)
    .split("/")
    .filter((p) => p !== "");
  const wrap = el("span", { class: "crumb-line" });
  parts.forEach((part, index) => {
    if (index > 0) wrap.appendChild(el("span", { class: "muted", text: " / " }));
    const upto = parts.slice(0, index + 1).join("/");
    const btn = el("button", { class: "btn btn-ghost", type: "button", text: part });
    btn.addEventListener("click", () => {
      void openRaw(upto);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}
