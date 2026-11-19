/**
 * The action bar an object's row carries: **Inspect**, and **More** with View spec,
 * View API request, Copy CLI equivalent and Export. An item appears only when it is
 * real for that object; none is ever shown disabled with a made-up command.
 *
 *   actionBar({ref, label, dir?, operation?, exports?})
 *
 * - `ref`: the object's ref. Inspect opens it over the current page (`?inspect=`).
 * - `label`: the object's name, for the controls' accessible names.
 * - `dir`: the harness folder, when the view already holds it (the direct CLI form
 *   shows only then; nothing is fetched to build one).
 * - `operation`: `{id, params, query?, body?}`, the API call the row stands for;
 *   View API request and Copy CLI equivalent appear only with one.
 * - `exports`: `{spec?: true, harness?: true, evalRun?: <run id>}`.
 *
 * The DOM is built with `el` only; nothing runs at import.
 */

import { copyBtn, el, toast } from "../dom.js";
import { hrefHarness, withInspect } from "../router.js";
import { cliTwinFor } from "../supervision.js";
import { openDialog } from "../ui/dialog.js";
import { announce } from "../ui/live.js";
import { actionKey, call, discover } from "../v1.js";
import { equivalentsFor } from "./equivalents.js";
import { harnessOfRef, specAnswer } from "./kinds.js";
import { homeUrl, resolveRef } from "./panel.js";

/** The harness ref's own form: `home/harness/<id>`. */
const harnessRef = (id) => `home/harness/${id}`;

/** Save text as a file in the browser, and say so politely. */
export function saveText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename, class: "sr-only", text: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(`Saved ${filename}`);
}

/** One labelled command block with a copy button. */
function commandBlock(label, command) {
  return el("div", { class: "twin" }, [
    el("span", { class: "twin-label", text: label }),
    el("code", { class: "twin-cmd", tabindex: "0", text: command }),
    copyBtn(command, "copy"),
  ]);
}

async function operationRow(id) {
  const table = await discover().catch(() => null);
  return table?.operations?.find((op) => op.id === id) ?? null;
}

/** View API request: the HTTP request, `curl` and `crewhaus api`. */
async function showApiRequest(opts, opener) {
  const row = await operationRow(opts.operation.id);
  const forms = equivalentsFor(row, opts.operation.params, {
    homeUrl: homeUrl(),
    ...(opts.operation.query !== undefined ? { query: opts.operation.query } : {}),
    ...(opts.operation.body !== undefined ? { body: opts.operation.body } : {}),
  });
  openDialog({
    title: "API request",
    returnFocus: opener,
    dismissOnBackdrop: true,
    body:
      "none" in forms
        ? [el("p", { text: forms.none })]
        : [
            el("p", {
              class: "muted",
              text: "Set CREWHAUS_TOKEN to a token from Access first. Nothing here holds one.",
            }),
            el("h3", { text: "HTTP" }),
            el("pre", { class: "mono", tabindex: "0", text: forms.http }),
            commandBlock("curl", forms.curl),
            commandBlock("On Home's computer", forms.api),
          ],
  });
}

/** Copy CLI equivalent: in the harness folder, and from another computer. */
async function showCliEquivalent(opts, opener) {
  const row = await operationRow(opts.operation.id);
  const forms = equivalentsFor(row, opts.operation.params, {
    homeUrl: homeUrl(),
    ...(typeof opts.dir === "string" ? { dir: opts.dir } : {}),
    ...(opts.operation.query !== undefined ? { query: opts.operation.query } : {}),
    ...(opts.operation.body !== undefined ? { body: opts.operation.body } : {}),
  });
  const body =
    "none" in forms
      ? [el("p", { text: forms.none })]
      : [
          forms.cli.direct !== null
            ? commandBlock("In the harness folder", forms.cli.direct)
            : forms.cli.note !== null
              ? el("p", { class: "muted", text: forms.cli.note })
              : null,
          el("p", { class: "muted", text: "From another computer, sign in once, then call it:" }),
          commandBlock("Sign in", forms.cli.login),
          commandBlock("Call", forms.cli.remote),
        ];
  openDialog({
    title: "Command-line equivalent",
    returnFocus: opener,
    dismissOnBackdrop: true,
    body,
  });
}

/**
 * View spec: what Home knows about the spec this object used ({@link specAnswer}),
 * and a link to the current one in Setup › Spec.
 */
async function showSpec(opts, opener) {
  const harness = harnessOfRef(parseRef(opts.ref));
  if (harness === null) return;
  const isHarness = opts.ref === harnessRef(harness);
  const [own, current] = isHarness
    ? [null, null]
    : await Promise.all([resolveRef(opts.ref), resolveRef(harnessRef(harness))]);
  const answer = specAnswer(own, current, { isHarness });
  openDialog({
    title: "Spec",
    returnFocus: opener,
    dismissOnBackdrop: true,
    body: [
      el("p", { text: answer.words }),
      el("a", {
        class: answer.current === true ? "btn btn-primary" : "btn",
        href: hrefHarness(harness, "setup", "spec"),
        text: answer.current === true ? "Open Setup › Spec" : "Open the current spec",
      }),
    ],
  });
}

function parseRef(text) {
  const parts = String(text).split("/");
  return parts.length === 3 ? { scope: parts[0], kind: parts[1], id: parts[2] } : null;
}

/** Export the masked spec: the browser saves it. */
async function exportSpec(harness) {
  const res = await call("exports.spec", { params: { h: harness } });
  if (!res.ok) {
    toast(res.error.message);
    return;
  }
  saveText(String(res.body.filename), String(res.body.text), "application/yaml");
}

/** Export one evaluation run's rows: the browser saves them. */
async function exportEval(harness, run, format) {
  const res = await call("exports.evalResults", { params: { h: harness, run }, query: { format } });
  if (!res.ok) {
    toast(res.error.message);
    return;
  }
  saveText(String(res.body.filename), String(res.body.text), String(res.body.contentType));
}

/** Export the whole harness: Home writes the archive on its own computer and says where. */
async function exportHarness(harness, dir, opener) {
  const res = await call("exports.harness", {
    params: { h: harness },
    body: {},
    idempotencyKey: actionKey(),
  });
  if (!res.ok) {
    toast(res.error.message);
    return;
  }
  const path = String(res.body.path ?? "");
  const words = exportWords(res.body);
  const status = el("p", { role: "status", class: "muted export-saved" });
  const check = el("button", {
    type: "button",
    class: "btn",
    text: "Check whether it is saved",
    onClick: async () => {
      const listed = await call("exports.list", { params: { h: harness } });
      status.textContent = listed.ok
        ? savedWords(listed.body, path)
        : "Home could not list its archives just now. Try again.";
    },
  });
  openDialog({
    title: words.title,
    returnFocus: opener,
    dismissOnBackdrop: true,
    body: [
      el("p", { text: words.detail }),
      el("p", { class: "muted", text: "Nothing is downloaded to this browser." }),
      check,
      status,
      typeof dir === "string" && dir !== ""
        ? commandBlock("Same, in a terminal", cliTwinFor("state-backup", { dir, out: path }))
        : null,
    ],
  });
}

/**
 * What a harness export's answer says, in words that claim only what is known: a
 * queued job is writing the archive, and a repeated request started nothing new.
 */
export function exportWords(body) {
  const path = String(body?.path ?? "");
  if (body?.job === null || body?.job === undefined) {
    return {
      title: "Already requested",
      detail: `This export was already requested. Its archive is ${path} on Home's computer.`,
    };
  }
  return {
    title: "Exporting the harness",
    detail: `Home is writing the archive to ${path} on its computer. When the job finishes, copy it from there.`,
  };
}

/** Whether `exports.list` lists the archive at `path` yet, in words. */
export function savedWords(body, path) {
  const name = String(path).split(/[\\/]/).pop() ?? "";
  const rows = Array.isArray(body?.exports) ? body.exports : [];
  const row = rows.find((r) => r !== null && typeof r === "object" && r.name === name);
  return row === undefined
    ? "Not saved yet. The job may still be running; check again in a moment."
    : `Saved: ${name}.`;
}

/** One command in a dialog, with its copy button. */
function showCommand(title, command, opener) {
  openDialog({
    title,
    returnFocus: opener,
    dismissOnBackdrop: true,
    body: [commandBlock("Command", command)],
  });
}

/** The More menu: a disclosure of buttons, Escape closing it back to its summary. */
function moreMenu(label, items) {
  const summary = el("summary", {
    class: "btn btn-ghost",
    text: "More",
    "aria-label": `More for ${label}`,
  });
  const list = el(
    "ul",
    { class: "more-list" },
    items.map((item) =>
      el("li", null, [
        el("button", {
          type: "button",
          class: "btn btn-ghost",
          text: item.text,
          onClick: () => {
            menu.open = false;
            // The item's button is gone with the list: focus goes back to More first.
            summary.focus();
            void item.run(summary);
          },
        }),
      ]),
    ),
  );
  const menu = el("details", { class: "more-menu" }, [summary, list]);
  // Opened near an edge of a narrow screen, the list moves just enough to lie
  // wholly on the screen.
  menu.addEventListener("toggle", () => {
    list.style.transform = "";
    if (!menu.open) return;
    const box = list.getBoundingClientRect();
    const room = document.documentElement.clientWidth;
    const shift = box.left < 8 ? 8 - box.left : box.right > room - 8 ? room - 8 - box.right : 0;
    if (shift !== 0) list.style.transform = `translateX(${Math.round(shift)}px)`;
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    summary.focus();
  });
  return menu;
}

/** The items More holds for these options, each only when it is real. */
export function moreItems(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const harness = harnessOfRef(parseRef(o.ref));
  const items = [];
  if (harness !== null) items.push({ id: "spec", text: "View spec", run: (at) => showSpec(o, at) });
  if (o.operation && typeof o.operation.id === "string") {
    items.push({ id: "api", text: "View API request", run: (at) => showApiRequest(o, at) });
    items.push({ id: "cli", text: "Copy CLI equivalent", run: (at) => showCliEquivalent(o, at) });
  }
  const ex = o.exports && typeof o.exports === "object" ? o.exports : {};
  if (harness !== null && ex.spec === true) {
    items.push({ id: "export-spec", text: "Export spec", run: () => exportSpec(harness) });
  }
  if (harness !== null && typeof ex.evalRun === "string" && ex.evalRun !== "") {
    items.push({
      id: "export-csv",
      text: "Export results (CSV)",
      run: () => exportEval(harness, ex.evalRun, "csv"),
    });
    items.push({
      id: "export-jsonl",
      text: "Export results (JSONL)",
      run: () => exportEval(harness, ex.evalRun, "jsonl"),
    });
    if (typeof o.dir === "string" && o.dir !== "") {
      items.push({
        id: "export-terminal",
        text: "Export results in a terminal",
        run: (at) =>
          showCommand(
            "Export results in a terminal",
            cliTwinFor("eval-export", {
              dir: o.dir,
              runDir: `.crewhaus/evals/${ex.evalRun}`,
              format: "csv",
            }),
            at,
          ),
      });
    }
  }
  if (harness !== null && ex.harness === true) {
    items.push({
      id: "export-harness",
      text: "Export harness",
      run: (at) => exportHarness(harness, o.dir, at),
    });
  }
  return items;
}

/** The bar: Inspect, and More when it holds anything. */
export function actionBar(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const label = typeof o.label === "string" && o.label !== "" ? o.label : "this";
  const here = typeof window === "undefined" ? "#/" : window.location.hash || "#/";
  const inspect = el("a", {
    class: "btn btn-ghost",
    href: withInspect(here, String(o.ref)),
    text: "Inspect",
    "aria-label": `Inspect ${label}`,
  });
  const items = moreItems(o);
  return el("div", { class: "action-bar", role: "group", "aria-label": `Actions for ${label}` }, [
    inspect,
    items.length > 0 ? moreMenu(label, items) : null,
  ]);
}
