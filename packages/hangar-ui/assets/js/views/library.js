/**
 * Library — the fleet table. Dense, sortable, filterable by stored groups
 * and computed smart groups. All writes on this screen are registry CRUD
 * (the only write surface in the read-only alpha): add/scan, group
 * create/assign, tags/pin/notes, missing-dir relocate/remove.
 */

import { api } from "../api.js";
import { asOf, clear, copyBtn, dot, el, emptyState, skeleton, toast, withTip } from "../dom.js";
import { hrefHarness } from "../router.js";
import { shapeAccent, shapeLabel } from "../shapes.js";
import { procStatePill } from "../supervision.js";
import {
  deriveSmartGroups,
  dirTail,
  evalHealth,
  fmtCount,
  fmtRelativeTime,
  fmtUsd,
  normalizeRows,
  oldestCachedAt,
  rollupLine,
  sortRows,
} from "../util.js";
import { renderOnboarding, shouldOnboard } from "./onboarding.js";

const state = {
  sortKey: "name",
  sortDir: "asc",
  // {kind:"all"} | {kind:"group",name} | {kind:"smart",id} | {kind:"hidden"}
  filter: { kind: "all" },
  query: "",
};

/**
 * Run one registry write; on failure surface a toast (a write must NEVER
 * vanish silently) and skip the reload so the form/state stays visible.
 */
async function tryWrite(label, fn, onOk) {
  try {
    await fn();
  } catch (err) {
    toast(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  onOk();
}

const COLUMNS = [
  { key: "name", label: "Name", get: (r) => r.specName || dirTail(r.dir, 1) },
  { key: "shape", label: "Shape", get: (r) => r.target },
  { key: "model", label: "Model", get: (r) => r.model },
  { key: "process", label: "Process", get: (r) => r.supervision, sortable: true },
  { key: "eval", label: "Last eval", get: (r) => r.lastEval?.passRate ?? null },
  { key: "sessions", label: "Sessions", get: (r) => r.sessions },
  { key: "spend", label: "Spend 7d", get: (r) => r.spend7dUsd },
  { key: "caps", label: "Capabilities", get: () => null, sortable: false },
  { key: "groups", label: "Groups", get: () => null, sortable: false },
  { key: "edit", label: "", get: () => null, sortable: false },
];

export async function renderLibrary(root) {
  clear(root).appendChild(skeleton(6));
  // First paint from the plain (cache-only) feed — instant, stale-labeled
  // via each row's cachedAt — then a background ?hydrate=1 refetch replaces
  // the rows with freshly computed rollups.
  const [feedRes, groupsRes] = await Promise.allSettled([api.harnesses(), api.groups()]);
  if (feedRes.status === "rejected") throw feedRes.reason;
  const rows = normalizeRows(feedRes.value);
  // HM-12: an empty Library on a machine with no scan roots is FIRST BOOT,
  // not an empty list — hand over to onboarding rather than showing a table
  // with no rows and a verb nobody has run yet. A machine that HAS a root
  // configured keeps the empty state below, because "the scan found nothing"
  // is a different fact and its own verb answers it.
  if (rows.length === 0) {
    const onboardingRes = await Promise.allSettled([api.onboarding()]);
    const view = onboardingRes[0].status === "fulfilled" ? onboardingRes[0].value : null;
    if (shouldOnboard(view, rows.length)) {
      clear(root);
      await renderOnboarding(root, { reload: () => renderLibrary(root) });
      return;
    }
  }
  const groups = normalizeGroups(groupsRes.status === "fulfilled" ? groupsRes.value : null, rows);
  draw(root, rows, groups, { hydrating: true });
  hydrateInBackground(root, groups);
}

async function hydrateInBackground(root, groups) {
  let feed;
  try {
    feed = await api.harnesses(true);
  } catch {
    return; // the cold paint stands; the next reload retries
  }
  if (!root.isConnected) return; // navigated away meanwhile
  draw(root, normalizeRows(feed), groups, { hydrating: false });
}

function normalizeGroups(payload, rows) {
  const list = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.groups)
      ? payload.groups
      : [];
  const named = new Map();
  for (const g of list) {
    if (g && typeof g.name === "string" && g.name !== "") {
      named.set(g.name, {
        name: g.name,
        order: typeof g.order === "number" ? g.order : named.size + 1,
        color: typeof g.color === "string" ? g.color : "",
      });
    }
  }
  // Groups referenced on rows but absent from the stored list still render.
  for (const r of rows) {
    for (const name of r.groups) {
      if (!named.has(name)) named.set(name, { name, order: named.size + 1, color: "" });
    }
  }
  return [...named.values()].sort((a, b) => a.order - b.order);
}

function applyFilter(rows, nowMs) {
  // Hidden rows are curation, not data loss: they stay registered but stay
  // OUT of every view except the explicit Hidden bucket — "don't show all
  // harnesses unless added".
  let out =
    state.filter.kind === "hidden"
      ? rows.filter((r) => r.hidden === true)
      : rows.filter((r) => r.hidden !== true);
  if (state.filter.kind === "group") {
    const name = state.filter.name;
    out = out.filter((r) => r.groups.includes(name));
  } else if (state.filter.kind === "smart") {
    const smart = deriveSmartGroups(rows, nowMs).find((g) => g.id === state.filter.id);
    out = smart ? smart.rows.filter((r) => r.hidden !== true) : [];
  }
  if (state.query !== "") {
    const q = state.query.toLowerCase();
    out = out.filter(
      (r) =>
        r.specName.toLowerCase().includes(q) ||
        r.dir.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  return out;
}

function draw(root, rows, groups, opts = {}) {
  const nowMs = Date.now();
  const redraw = () => draw(root, rows, groups, opts);
  const reload = () => renderLibrary(root);
  clear(root);

  const layout = el("div", { class: "lib" });
  layout.appendChild(renderRail(rows, groups, nowMs, redraw, reload));

  const main = el("section", { class: "lib-main" });
  main.appendChild(renderToolbar(reload));
  const cachedAt = oldestCachedAt(rows);
  main.appendChild(
    el("div", { class: "rollup" }, [
      el("span", { text: rollupLine(rows) }),
      cachedAt ? asOf(cachedAt) : null,
      opts.hydrating === true ? el("span", { class: "muted", text: "· refreshing…" }) : null,
    ]),
  );

  for (const row of rows.filter((r) => r.missingSince !== null)) {
    main.appendChild(missingCard(row, reload));
  }

  const visible = applyFilter(
    rows.filter((r) => r.missingSince === null),
    nowMs,
  );
  if (rows.length === 0) {
    main.appendChild(
      emptyState(
        "No harnesses registered yet",
        "crewhaus harness add <dir> (or Scan a root above)",
      ),
    );
  } else if (visible.length === 0) {
    main.appendChild(emptyState("No harnesses match this filter"));
  } else {
    main.appendChild(renderTable(visible, groups, nowMs, redraw, reload));
  }
  layout.appendChild(main);
  root.appendChild(layout);
}

function renderRail(rows, groups, nowMs, redraw, reload) {
  const rail = el("aside", { class: "rail", "aria-label": "groups" });
  const item = (label, count, active, color, onClick) => {
    const btn = el(
      "button",
      { class: `rail-item${active ? " active" : ""}`, type: "button", onClick },
      [
        color ? el("span", { class: "swatch", style: { background: color } }) : null,
        el("span", { class: "rail-label", text: label }),
        el("span", { class: "rail-count", text: String(count) }),
      ],
    );
    return btn;
  };
  const hiddenCount = rows.filter((r) => r.hidden === true).length;
  rail.appendChild(
    item("All harnesses", rows.length - hiddenCount, state.filter.kind === "all", null, () => {
      state.filter = { kind: "all" };
      redraw();
    }),
  );
  // The curated-out entries get their own bucket rather than vanishing:
  // hiding is reversible, and a bucket with a count is how you find them.
  if (hiddenCount > 0) {
    rail.appendChild(
      item("Hidden", hiddenCount, state.filter.kind === "hidden", null, () => {
        state.filter = { kind: "hidden" };
        redraw();
      }),
    );
  }

  const shown = rows.filter((r) => r.hidden !== true);
  if (groups.length > 0) rail.appendChild(el("div", { class: "rail-head", text: "Groups" }));
  for (const g of groups) {
    const count = shown.filter((r) => r.groups.includes(g.name)).length;
    const active = state.filter.kind === "group" && state.filter.name === g.name;
    rail.appendChild(
      item(g.name, count, active, g.color || null, () => {
        state.filter = { kind: "group", name: g.name };
        redraw();
      }),
    );
  }

  const newBtn = el("button", { class: "rail-item rail-new", type: "button", text: "+ New group" });
  newBtn.addEventListener("click", () => {
    const form = groupForm(groups, reload, () => {
      form.replaceWith(newBtn);
    });
    newBtn.replaceWith(form);
  });
  rail.appendChild(newBtn);

  rail.appendChild(el("div", { class: "rail-head", text: "Smart groups" }));
  for (const g of deriveSmartGroups(shown, nowMs)) {
    const active = state.filter.kind === "smart" && state.filter.id === g.id;
    rail.appendChild(
      item(g.label, g.rows.length, active, null, () => {
        state.filter = { kind: "smart", id: g.id };
        redraw();
      }),
    );
  }
  return rail;
}

function groupForm(groups, reload, onCancel) {
  const input = el("input", {
    class: "input",
    type: "text",
    placeholder: "group name",
    "aria-label": "new group name",
  });
  const form = el("form", { class: "rail-form" }, [
    input,
    el("button", { class: "btn btn-primary", type: "submit", text: "Add" }),
    el("button", { class: "btn btn-ghost", type: "button", text: "Cancel", onClick: onCancel }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name === "" || groups.some((g) => g.name === name)) return;
    tryWrite("Create group", () => api.addGroup(name), reload);
  });
  return form;
}

function renderToolbar(reload) {
  const search = el("input", {
    class: "input search",
    type: "search",
    placeholder: "Filter by name, dir, tag…",
    value: state.query,
    "aria-label": "filter harnesses",
  });
  search.addEventListener("input", () => {
    state.query = search.value.trim();
  });
  search.addEventListener("change", reload);

  // A dir-input form under the toolbar (Add harness / Add scan root share
  // the pattern); only one open at a time.
  let openedForm = null;
  const openForm = (bar, placeholder, ariaLabel, submitLabel, onSubmit) => {
    if (openedForm !== null) openedForm.remove();
    const dirInput = el("input", {
      class: "input grow",
      type: "text",
      placeholder,
      "aria-label": ariaLabel,
    });
    const form = el("form", { class: "add-form" }, [
      dirInput,
      el("button", { class: "btn btn-primary", type: "submit", text: submitLabel }),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Cancel",
        onClick: () => form.remove(),
      }),
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const dir = dirInput.value.trim();
      if (dir === "") return;
      onSubmit(dir);
    });
    bar.after(form);
    openedForm = form;
    dirInput.focus();
  };

  const findBtn = withTip(
    el("button", { class: "btn", type: "button", text: "Find harnesses…" }),
    "Discovery WITHOUT registration: walks the scan roots and lists the harnesses that are not yet added, each one an Add away — the Library only shows what you add.",
  );
  const scanBtn = withTip(
    el("button", { class: "btn btn-ghost", type: "button", text: "Scan (add all)" }),
    "The bulk fallback: registers EVERY harness found under the scan roots. Prefer Find harnesses to pick which ones join the Library.",
  );
  const rootBtn = el("button", { class: "btn", type: "button", text: "Add scan root…" });
  const addBtn = withTip(
    el("button", { class: "btn btn-primary", type: "button", text: "Add harness…" }),
    "Register one harness by its directory — the default gesture.",
  );
  const bar = el("div", { class: "toolbar" }, [search, addBtn, findBtn, rootBtn, scanBtn]);

  // The find panel: candidates from GET /api/registry/discover, each with an
  // Add. Only one open at a time, sharing the openedForm slot with the two
  // dir forms.
  findBtn.addEventListener("click", async () => {
    if (openedForm !== null) openedForm.remove();
    findBtn.disabled = true;
    let found = null;
    try {
      found = await api.discover();
    } catch (err) {
      toast(`Find failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      findBtn.disabled = false;
    }
    if (found === null) return;
    const panel = el("div", { class: "card" });
    const candidates = Array.isArray(found.candidates) ? found.candidates : [];
    if (found.roots === 0) {
      toast("No scan roots configured — add one and discovery can search this machine", "info");
      panel.remove();
      rootBtn.click();
      return;
    }
    panel.appendChild(
      el("div", { class: "rollup" }, [
        el("strong", {
          text: `Found ${candidates.length} unregistered harness${candidates.length === 1 ? "" : "es"}`,
        }),
        el("span", {
          class: "muted",
          text: ` under ${found.roots} scan root${found.roots === 1 ? "" : "s"} (${Number(found.alreadyRegistered ?? 0)} already added)`,
        }),
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "Close",
          onClick: () => panel.remove(),
        }),
      ]),
    );
    if (candidates.length === 0) {
      panel.appendChild(emptyState(String(found.note ?? "Nothing new under the scan roots")));
    }
    for (const candidate of candidates) {
      const addOne = el("button", { class: "btn btn-primary", type: "button", text: "Add" });
      addOne.addEventListener("click", () => {
        addOne.disabled = true;
        tryWrite("Add harness", () => api.addHarness(candidate.dir), reload);
      });
      panel.appendChild(
        el("div", { class: "find-row" }, [
          el("strong", { text: String(candidate.specName ?? "") }),
          el("span", { class: "chip", text: String(candidate.target ?? "unknown") }),
          el("span", {
            class: "mono muted",
            title: String(candidate.dir ?? ""),
            text: String(candidate.dir ?? ""),
          }),
          addOne,
        ]),
      );
    }
    if (candidates.length > 1) {
      const addAll = el("button", {
        class: "btn",
        type: "button",
        text: `Add all ${candidates.length}`,
      });
      addAll.addEventListener("click", () => {
        addAll.disabled = true;
        tryWrite(
          "Add all",
          async () => {
            for (const candidate of candidates) await api.addHarness(candidate.dir);
          },
          reload,
        );
      });
      panel.appendChild(el("div", { class: "missing-actions" }, [addAll]));
    }
    bar.after(panel);
    openedForm = panel;
  });

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning…";
    try {
      const result = await api.scan();
      const roots = result && typeof result === "object" ? result.roots : null;
      if (roots === 0) {
        // Zero-work scan is not success — say so and open the fix.
        toast("No scan roots configured — add one first", "info");
        rootBtn.click();
      } else {
        reload();
        return;
      }
    } catch (err) {
      toast(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "Scan";
    }
  });

  rootBtn.addEventListener("click", () => {
    openForm(bar, "/absolute/path/to/scan", "scan root directory", "Add root", (dir) => {
      // After the root lands, scan it right away so the table fills.
      tryWrite(
        "Add scan root",
        () => api.addScanRoot(dir),
        async () => {
          try {
            await api.scan();
          } catch {
            // root saved; the next manual Scan retries discovery
          }
          reload();
        },
      );
    });
  });

  addBtn.addEventListener("click", () => {
    openForm(bar, "/absolute/path/to/harness", "harness directory", "Add", (dir) => {
      tryWrite("Add harness", () => api.addHarness(dir), reload);
    });
  });
  return bar;
}

function missingCard(row, reload) {
  const name = row.specName || dirTail(row.dir, 1);
  const dirInput = el("input", {
    class: "input grow",
    type: "text",
    placeholder: "new absolute path",
    "aria-label": `new path for ${name}`,
  });
  const relocate = el("form", { class: "add-form" }, [
    dirInput,
    el("button", { class: "btn", type: "submit", text: "Relocate" }),
  ]);
  relocate.addEventListener("submit", (e) => {
    e.preventDefault();
    const dir = dirInput.value.trim();
    if (dir === "") return;
    tryWrite("Relocate", () => api.relocateHarness(row.id, dir), reload);
  });
  const removeBtn = el("button", { class: "btn btn-danger", type: "button", text: "Remove entry" });
  removeBtn.addEventListener("click", () => {
    const sure = window.confirm(
      `Remove "${name}" from the registry? Only the registry row is deleted — no harness data.`,
    );
    if (!sure) return;
    tryWrite("Remove", () => api.removeHarness(row.id), reload);
  });
  return el("div", { class: "card missing-card" }, [
    el("div", { class: "missing-head" }, [
      dot("bad", "missing"),
      el("strong", { text: name }),
      el("span", {
        class: "muted",
        text: ` — directory gone since ${fmtRelativeTime(row.missingSince, Date.now())}`,
      }),
    ]),
    el("div", { class: "missing-dir mono", text: row.dir }),
    el("div", { class: "missing-actions" }, [relocate, removeBtn]),
  ]);
}

function renderTable(rows, groups, nowMs, redraw, reload) {
  const col = COLUMNS.find((c) => c.key === state.sortKey) ?? COLUMNS[0];
  const sorted = sortRows(rows, col.get, state.sortDir);

  const thead = el(
    "thead",
    null,
    el(
      "tr",
      null,
      COLUMNS.map((c) => {
        const sortable = c.sortable !== false;
        const active = state.sortKey === c.key;
        const th = el("th", {
          "aria-sort": active ? (state.sortDir === "asc" ? "ascending" : "descending") : null,
        });
        if (!sortable) {
          th.appendChild(el("span", { text: c.label }));
          return th;
        }
        th.appendChild(
          el("button", {
            class: `th-sort${active ? " active" : ""}`,
            type: "button",
            text: active ? `${c.label} ${state.sortDir === "asc" ? "↑" : "↓"}` : c.label,
            onClick: () => {
              if (state.sortKey === c.key) {
                state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
              } else {
                state.sortKey = c.key;
                state.sortDir = "asc";
              }
              redraw();
            },
          }),
        );
        return th;
      }),
    ),
  );

  const tbody = el("tbody");
  for (const row of sorted) {
    tbody.appendChild(harnessRow(row, groups, reload));
  }
  return el("div", { class: "table-scroll" }, [el("table", { class: "fleet" }, [thead, tbody])]);
}

function harnessRow(row, groups, reload) {
  const health = evalHealth(row.lastEval);
  const name = row.specName || dirTail(row.dir, 1) || row.id;

  const pin = el("button", {
    class: `pin${row.pinned ? " pinned" : ""}`,
    type: "button",
    title: row.pinned ? "Unpin" : "Pin (pinned harnesses sort first)",
    "aria-label": row.pinned ? `unpin ${name}` : `pin ${name}`,
    text: row.pinned ? "★" : "☆",
  });
  pin.addEventListener("click", () => {
    tryWrite("Pin", () => api.setPin(row.id, !row.pinned), reload);
  });

  const tr = el("tr", { class: "fleet-row" }, [
    el("td", { class: "cell-name" }, [
      el("div", { class: "name-line" }, [
        pin,
        el("a", { href: hrefHarness(row.id), class: "name-link", text: name }),
      ]),
      el("div", { class: "sub mono", title: row.dir, text: dirTail(row.dir, 2) }),
    ]),
    el("td", null, [
      el("span", {
        class: "shape-badge",
        style: { "--accent": shapeAccent(row.target) },
        text: shapeLabel(row.target),
      }),
    ]),
    el("td", { class: "mono", text: row.model ?? "—" }),
    el("td", null, [
      row.supervision === null
        ? el("span", { class: "muted", text: "—" })
        : el("a", { class: "state-link", href: hrefHarness(row.id, "runs") }, [
            dot(procStatePill(row.supervision).dot, procStatePill(row.supervision).label),
          ]),
      row.pendingApprovals > 0
        ? el("a", {
            class: "chip chip-warn",
            href: "#/approvals",
            text: `${row.pendingApprovals} waiting`,
          })
        : null,
    ]),
    el("td", null, [
      dot(
        health.state === "pass"
          ? "ok"
          : health.state === "fail"
            ? "bad"
            : health.state === "unknown"
              ? "unknown"
              : "off",
        health.label,
      ),
    ]),
    el("td", { class: "num", text: fmtCount(row.sessions) }),
    el("td", { class: "num" }, [
      el("span", { text: fmtUsd(row.spend7dUsd) }),
      row.cachedAt ? asOf(row.cachedAt) : null,
    ]),
    el(
      "td",
      { class: "cell-caps" },
      row.capabilities.length > 0
        ? row.capabilities.map((c) => el("span", { class: "chip", text: c }))
        : el("span", { class: "muted", text: "—" }),
    ),
    el(
      "td",
      { class: "cell-groups" },
      row.groups.length > 0
        ? row.groups.map((g) => el("span", { class: "chip chip-group", text: g }))
        : el("span", { class: "muted", text: "—" }),
    ),
    el("td", { class: "cell-edit" }),
  ]);

  const editBtn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Edit",
    "aria-label": `edit registry fields for ${name}`,
  });
  let editorTr = null;
  editBtn.addEventListener("click", () => {
    if (editorTr) {
      editorTr.remove();
      editorTr = null;
      return;
    }
    editorTr = editorRow(row, groups, reload);
    tr.after(editorTr);
  });
  tr.querySelector(".cell-edit").appendChild(editBtn);
  return tr;
}

function editorRow(row, groups, reload) {
  const tags = el("input", {
    class: "input",
    type: "text",
    value: row.tags.join(", "),
    placeholder: "tags, comma-separated",
    "aria-label": "tags",
  });
  const notes = el("textarea", {
    class: "input notes",
    rows: "2",
    placeholder: "notes",
    "aria-label": "notes",
  });
  notes.value = row.notes;
  const checks = groups.map((g) => {
    const cb = el("input", { type: "checkbox", "aria-label": `group ${g.name}` });
    cb.checked = row.groups.includes(g.name);
    return { name: g.name, cb };
  });
  const hiddenCb = el("input", { type: "checkbox", "aria-label": "hide from the library" });
  hiddenCb.checked = row.hidden === true;
  const form = el("form", { class: "row-editor" }, [
    el("label", { class: "field" }, [el("span", { text: "Tags" }), tags]),
    el("label", { class: "field" }, [el("span", { text: "Notes" }), notes]),
    el("div", { class: "field" }, [
      el("span", { text: "Visibility" }),
      withTip(
        el("label", { class: "check" }, [
          hiddenCb,
          el("span", { text: "Hidden — keep registered, out of the default view" }),
        ]),
        "Hiding is curation, not removal: state, groups and history survive, and the Hidden bucket in the rail lists it until you bring it back.",
      ),
    ]),
    el("div", { class: "field" }, [
      el("span", { text: groups.length > 0 ? "Groups" : "Groups (none defined yet)" }),
      el(
        "div",
        { class: "group-checks" },
        checks.map((c) => el("label", { class: "check" }, [c.cb, el("span", { text: c.name })])),
      ),
    ]),
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-primary", type: "submit", text: "Save" }),
    ]),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const tagList = tags.value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const groupList = checks.filter((c) => c.cb.checked).map((c) => c.name);
    // The server's registry writes are per-field PUTs; save all four.
    tryWrite(
      "Save",
      async () => {
        await api.setTags(row.id, tagList);
        await api.setNotes(row.id, notes.value);
        await api.setGroups(row.id, groupList);
        if (hiddenCb.checked !== (row.hidden === true)) {
          await api.setHidden(row.id, hiddenCb.checked);
        }
      },
      reload,
    );
  });
  const td = el("td", { colspan: String(COLUMNS.length) }, [form, copyBtn(row.dir, "copy dir")]);
  return el("tr", { class: "editor-tr" }, [td]);
}
