/**
 * The spec editor's own decisions. The screen used to render the static
 * words "edit as YAML" for every non-scalar path and point at a YAML editor
 * that does not exist in this console, which left every block, every list,
 * and every field inside a list item unreachable. What replaced it is the
 * JSON pane, and everything the pane DECIDES — how a dotted path becomes the
 * server's segment array, what an empty pane means, what a batch looks like
 * — is pure, so it is proven here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { conflictModel } from "../assets/js/ui/conflict.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { flatten, formModel } from "../assets/js/ui/schema-form.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  concealedPredicate,
  draftOf,
  draftTextFor,
  editPath,
  editsFor,
  parseJsonValue,
  readOnlyModel,
  settingsCard,
  unsavedEntryIds,
} from "../assets/js/views/spec-edit.js";

describe("editPath", () => {
  test("a list index is a NUMBER — that is what reaches a list item at all", () => {
    expect(editPath("agent.model_pool.candidates.0.id")).toEqual([
      "agent",
      "model_pool",
      "candidates",
      0,
      "id",
    ]);
    expect(editPath("permissions.rules.12")).toEqual(["permissions", "rules", 12]);
  });

  test("a key that merely looks numeric keeps its leading zero as a key", () => {
    // "01" is not a canonical index, so it addresses a mapping key.
    expect(editPath("tool_config.01")).toEqual(["tool_config", "01"]);
  });

  test("empty segments are dropped, and an empty path is empty", () => {
    expect(editPath("memory..wiki.")).toEqual(["memory", "wiki"]);
    expect(editPath("")).toEqual([]);
    expect(editPath(undefined)).toEqual([]);
  });
});

describe("parseJsonValue", () => {
  test("an object, an array and a scalar all round-trip", () => {
    expect(parseJsonValue('{"enabled":true}')).toEqual({
      ok: true,
      remove: false,
      value: { enabled: true },
    });
    expect(parseJsonValue("[1,2]").value).toEqual([1, 2]);
    expect(parseJsonValue('"opus"').value).toBe("opus");
  });

  test("an empty pane is a DELETE, not an empty string", () => {
    expect(parseJsonValue("   ")).toEqual({ ok: true, remove: true });
  });

  test("bad JSON is a reported failure, never a silent write", () => {
    const bad = parseJsonValue("{nope}");
    expect(bad.ok).toBe(false);
    expect(String(bad.message).length).toBeGreaterThan(0);
  });
});

describe("editsFor — the batch the pane sends", () => {
  test("a block this spec never declared is one ordinary edit", () => {
    const batch = editsFor("memory", '{"enabled":true,"wiki":{"enabled":true}}');
    expect(batch.ok).toBe(true);
    expect(batch.removing).toBe(false);
    expect(batch.edits).toEqual([
      { path: ["memory"], value: { enabled: true, wiki: { enabled: true } } },
    ]);
  });

  test("a field inside a list item addresses the item by index", () => {
    const batch = editsFor("agent.model_pool.candidates.0.id", '"anthropic/claude-opus-4"');
    expect(batch.edits[0].path).toEqual(["agent", "model_pool", "candidates", 0, "id"]);
  });

  test("a delete carries NO value key — an undefined would not survive JSON", () => {
    const batch = editsFor("memory", "");
    expect(batch.removing).toBe(true);
    expect(Object.hasOwn(batch.edits[0], "value")).toBe(false);
    expect(JSON.stringify(batch.edits[0])).toBe('{"path":["memory"]}');
  });

  test("no path and bad JSON are both refusals with a sentence", () => {
    expect(editsFor("", "{}").ok).toBe(false);
    expect(String(editsFor("  ", "{}").message)).toContain("path");
    const bad = editsFor("memory", "{nope}");
    expect(bad.ok).toBe(false);
    expect(String(bad.message)).toContain("not valid JSON");
  });
});

describe("the view module's own hygiene", () => {
  test("the dead 'edit as YAML' affordance is gone", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/spec-edit.js", import.meta.url),
    ).text();
    // There is no YAML editor for the SPEC in this console; the label used to
    // claim one. A capability the UI does not have must not be named.
    expect(source.includes('text: "edit as YAML"')).toBe(false);
    expect(source.includes("edit as YAML")).toBe(false);
  });

  test("every setting the form cannot show has a real control behind it", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/spec-edit.js", import.meta.url),
    ).text();
    // The form is built from the schema; a node it cannot render opens the JSON pane.
    expect(source.includes("formModel(body.schema, body.effective, trustRows, {")).toBe(true);
    expect(source.includes('jsonButton(node, "Edit as JSON…"')).toBe(true);
    expect(source.match(/const jsonLeaf = \(node\) =>/g)?.length).toBe(1);
    // …and one for a path the spec has not declared at all.
    expect(source.includes('text: "Edit any path…"')).toBe(true);
  });

  test("the pane writes through the same gated route every other edit uses", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/spec-edit.js", import.meta.url),
    ).text();
    // Preview first (server-computed diff + tier), write second, and the
    // typed confirmation only ever comes from the server's answer.
    expect(source.includes("api.specDiff(")).toBe(true);
    expect(source.includes("api.specEdit(")).toBe(true);
    expect(source.includes("body.autoApplicable === true")).toBe(true);
    expect(source.includes("confirmName")).toBe(true);
  });

  test("a conflict never re-sends a typed confirmation", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/spec-edit.js", import.meta.url),
    ).text();
    // A re-send without asking is for auto-tunable writes only: a `retry`
    // closure that carried `confirmName` would apply a human-owned edit, with
    // one click, on top of a version nobody confirmed it against.
    const retries = [...source.matchAll(/retry(?::| =) \(rev\) =>\s*api\.\w+\([^)]*\)/g)].map(
      (m) => m[0],
    );
    // A field's direct save, and the one reviewed write every reviewed edit goes through.
    expect(retries.length).toBe(2);
    for (const retry of retries) {
      expect(retry.includes("confirmName")).toBe(false);
      expect(retry.includes("...extra")).toBe(false);
    }
    // The typed writes ask again, over a fresh diff: one place builds that for all of them.
    expect(source.match(/conflict\.reconfirm = \(rev\) =>/g)?.length).toBe(1);
    expect(source.match(/if \(typed\) \{\n\s+conflict\.reconfirm/g)?.length).toBe(1);
    expect(source.includes("async function reconfirmEdit(")).toBe(true);
  });
});

const viewSource = async (name: string): Promise<string> =>
  await Bun.file(new URL(`../assets/js/views/${name}`, import.meta.url)).text();

/** Every argument list of `api.<fn>(` calls in `source`, balanced over brackets. */
function callsOf(source: string, fn: string): string[] {
  const out: string[] = [];
  let at = source.indexOf(`api.${fn}(`);
  while (at !== -1) {
    let depth = 0;
    let end = at + `api.${fn}`.length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(at, end + 1));
    at = source.indexOf(`api.${fn}(`, end);
  }
  return out;
}

describe("every spec write sends the revision it loaded", () => {
  test("the editor's writes, the connectors', advice's and watch-me's", async () => {
    const spec = await viewSource("spec-edit.js");
    const writes = [
      ...callsOf(spec, "specPatch"),
      ...callsOf(spec, "specEdit"),
      ...callsOf(spec, "mcpConnectorWrite").filter((c) => c.includes("dryRun: false")),
      ...callsOf(spec, "mcpConnectorRemove").filter((c) => c.includes("confirmName")),
    ];
    // A field's save and its retry, the reviewed write and its retry, the re-confirmed
    // write, and the connectors' two.
    expect(writes.length).toBe(7);
    for (const call of writes) expect(call).toContain("expectedRev");

    const feedback = await viewSource("feedback.js");
    const fabric = await viewSource("memory-fabric.js");
    expect(feedback).toContain('{ confirm: true, expectedRev: String(data.rev ?? "") }');
    for (const call of [...callsOf(fabric, "watchmeToggle"), ...callsOf(fabric, "watchmeApply")]) {
      expect(call).toContain("expectedRev");
    }
  });

  test("advice and watch-me open the editor's conflict view on a 412", async () => {
    for (const name of ["feedback.js", "memory-fabric.js"]) {
      const source = await viewSource(name);
      expect(source).toContain('import { openConflict } from "./spec-edit.js";');
      expect(source).toContain("status === 412");
      expect(source).toContain("openConflict(");
    }
  });
});

describe("a conflict's draft is what the write tried, never an empty file", () => {
  const actionsFor = (draft: string, canReapply = true): string[] =>
    conflictModel({ rev: "r2" }, draft, { canReapply }).actions.map((a: { id: string }) => a.id);

  test("the caller's own copy of the edit is what downloads", async () => {
    const asked: unknown[] = [];
    const text = await draftTextFor({ draftId: "d" }, { id: "h", draft: '{"path":"x"}' }, (p) => {
      asked.push(p);
      return Promise.resolve({ ok: true, body: {} });
    });
    expect(text).toBe('{"path":"x"}');
    expect(asked).toEqual([]);
  });

  test("a watch-me or connector 412 downloads the draft the server kept, masked", async () => {
    const asked: unknown[] = [];
    const edits = [{ path: ["watchme", "enabled"], value: true }];
    const text = await draftTextFor(
      { rev: "r2", diff: "~ watchme.enabled", draftId: "20261112T120000Z-0000aaaa" },
      { id: "hrn_1" },
      (p) => {
        asked.push(p);
        return Promise.resolve({ ok: true, body: { yaml: null, edits } });
      },
    );
    expect(asked).toEqual([{ id: "hrn_1", draft: "20261112T120000Z-0000aaaa" }]);
    expect(JSON.parse(text)).toEqual(edits);
    expect(actionsFor(text)).toContain("download");
  });

  test("no draft to be had offers no download", async () => {
    for (const fetchDraft of [
      () => Promise.resolve({ ok: false, status: 404, body: {} }),
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve({ ok: true, body: { yaml: "", edits: [] } }),
    ]) {
      const text = await draftTextFor({ draftId: "d" }, { id: "h" }, fetchDraft);
      expect(text).toBe("");
      expect(actionsFor(text)).not.toContain("download");
    }
    expect(await draftTextFor({}, {}, () => Promise.reject(new Error("never asked")))).toBe("");
  });

  test("every 412 whose caller keeps no draft of its own names the harness to read it from", async () => {
    const spec = await viewSource("spec-edit.js");
    // The two connector conflicts (add and remove).
    expect(spec.match(/const conflict = \{\n\s+id: ctx\.id,/g)?.length).toBe(2);
    const feedback = await viewSource("feedback.js");
    expect(feedback).not.toContain("JSON.stringify({ adviceId");
    expect(feedback).toContain("id: ctx.id,");
    const fabric = await viewSource("memory-fabric.js");
    expect(fabric.match(/\{ id: ctx\.id, reload: \(\) => void rerenderWatchme\(/g)?.length).toBe(2);
  });

  test("watch-me offers no re-apply it cannot do, and keeps focus on the panel after a re-read", async () => {
    const fabric = await viewSource("memory-fabric.js");
    expect(fabric.includes("reconfirm:")).toBe(false);
    expect(fabric.includes("retry:")).toBe(false);
    expect(actionsFor("kept", false)).toEqual(["use-disk", "download"]);
    expect(fabric).toContain("async function rerenderWatchme(");
    expect(fabric).toContain("heading.focus()");
  });
});

describe("a read-only spec", () => {
  test("the model says why in words and holds the writes", () => {
    const m = readOnlyModel({
      reason:
        "This harness uses settings this version of CrewHaus doesn't know: future_block. You can read it here but not change it.",
      paths: ["future_block"],
      verb: "crewhaus harness adopt hrn_0123456789abcdef",
    });
    expect(m.held).toBe(true);
    expect(m.notice).toContain("future_block");
    expect(m.paths).toEqual(["future_block"]);
    expect(m.verb).toBe("crewhaus harness adopt hrn_0123456789abcdef");
    expect(readOnlyModel(null)).toEqual({ held: false, notice: "", paths: [], verb: null });
  });

  test("with no command that can help, the model names none", () => {
    const m = readOnlyModel({
      reason: "Edit crewhaus.yaml with the CrewHaus that wrote it.",
      paths: ["x"],
      verb: null,
    });
    expect(m.held).toBe(true);
    expect(m.verb).toBeNull();
  });

  test("the notice holds the sentence, and the command once, in its own line", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain('el("p", { id: READ_ONLY_REASON_ID, text: model.notice })');
    // No "Run" line at all when there is no command.
    expect(source).toContain("model.verb === null\n      ? null");
    expect(source).toMatch(
      /el\("span", \{ text: "Run " \}\),\s+el\("code", \{ text: model\.verb \}\)/,
    );
    expect(source.match(/el\("code", \{ text: model\.verb \}\)/g)?.length).toBe(1);
    expect(source).toContain('const READ_ONLY_REASON_ID = "spec-read-only-reason";');
  });

  test("every write control is held with aria-disabled and described by the reason, and stays in the tab order", async () => {
    const source = await viewSource("spec-edit.js");
    const held = source.match(/holdWhenReadOnly\(/g)?.length ?? 0;
    // Edit as JSON, Save or Review and apply, Clear, Edit any path, a list's Add and its
    // item buttons, the connectors' Remove and Add, plus the definition.
    expect(held).toBe(9);
    expect(source).toContain('control.setAttribute("aria-disabled", "true")');
    // The reason's own line, first, never the whole card.
    expect(source).toContain(
      'control.setAttribute("aria-describedby", [READ_ONLY_REASON_ID, ...own].join(" "))',
    );
    expect(source.includes("READ_ONLY_NOTE_ID")).toBe(false);
    // Held, never removed from the focus order with `disabled`.
    expect(source.includes("control.disabled = true")).toBe(false);
    expect(source.includes('tabindex: "-1"')).toBe(false);
    expect(source).toContain(
      "if (live.readOnly.held) root.appendChild(readOnlyCard(live.readOnly));",
    );
  });

  test("a rename's warning is in the typed confirmation's lead", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain("const warning = escalationLead(body);");
    expect(source).toContain(
      ': `${warning === "" ? "" : `${warning} `}A person confirms this setting.',
    );
  });
});

describe("the settings form", () => {
  test("reads the schema through the versioned API, by the harness in params", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain('call("specs.schema", { params: { h: ctx.id } })');
    expect(source.includes("api.specSchema(")).toBe(false);
  });

  test("a save says the change is saved and not active yet, in words", async () => {
    const { savedMessage } = await import("../assets/js/views/spec-edit.js");
    expect(savedMessage({ label: "Max tokens", segments: ["agent", "max_tokens"] })).toBe(
      "Saved Max tokens. It is not active until the harness is rebuilt.",
    );
    expect(savedMessage({ label: "Delegation", segments: ["permissions", "delegation"] })).toBe(
      "Saved Delegation. It is not active until a person activates a deployment.",
    );
  });

  test("unsaved values are kept in memory only, never in stored drafts", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain("const unsaved = new Map();");
    expect(source.includes("sessionStorage")).toBe(false);
    expect(source.includes("localStorage")).toBe(false);
    expect(source.includes("ui/draft.js")).toBe(false);
  });

  test("the JSON pane refuses text that still carries a hidden value", () => {
    const refused = editsFor(["thredz", "api_key"], '"[redacted]"');
    expect(refused.ok).toBe(false);
    expect(String(refused.message)).toContain("[redacted]");
    const nested = editsFor("channels", '{"telegram":{"botToken":"[redacted]"}}');
    expect(nested.ok).toBe(false);
    // A segment holding a dot stays one segment.
    expect(editsFor(["models", "claude-3.5"], "{}").edits).toEqual([
      { path: ["models", "claude-3.5"], value: {} },
    ]);
  });

  test("the JSON pane refuses text that carries a value-shape mask or a scrubbed name", () => {
    const shaped = editsFor(
      ["agent"],
      JSON.stringify({ model: "x", instructions: "Use *** for calls", max_tokens: 2000 }),
    );
    expect(shaped.ok).toBe(false);
    expect(String(shaped.message)).toContain("***");
    const scrubbed = editsFor(["agent"], JSON.stringify({ model: "«FIXTURE_MODEL»" }));
    expect(scrubbed.ok).toBe(false);
    expect(String(scrubbed.message)).toContain("«FIXTURE_MODEL»");
    expect(editsFor("slack", '{"channel":"«X»"}').ok).toBe(false);
    // An empty pane is still a delete: it carries no value to have been masked.
    expect(editsFor(["agent"], "").ok).toBe(true);
  });

  test("a block's pane never starts from a masked read, and says which values it hides", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain(
      "value: node.writeOnly === true || node.concealed === true ? undefined : node.paneSeed,",
    );
    expect(source).toContain(
      "hidden: node.writeOnly === true && Array.isArray(node.hidden) ? node.hidden : [],",
    );
    expect(source).toContain("This screen hides a value here, so the pane starts empty.");
    // A typed value that still holds a placeholder is refused before any request.
    expect(source).toContain("if (input !== CLEAR && maskedMarkerOf(input) !== null) {");
  });
});

describe("the Settings card with no spec", () => {
  test("says why and names the command, with no form", async () => {
    const { settingsState } = await import("../assets/js/views/spec-edit.js");
    const absent = settingsState(
      {
        present: false,
        note: "no crewhaus.yaml in this harness",
        verb: "crewhaus init",
        schema: null,
      },
      0,
      false,
    );
    expect(absent).toEqual({
      absent: true,
      tone: "off",
      word: "no spec",
      note: "no crewhaus.yaml in this harness",
      verb: "crewhaus init",
    });
    // The remedy is named even when the read names none.
    expect(settingsState({ present: false }, 0, false).verb).toBe("crewhaus init");
    // "editable" only when there is a form to edit.
    expect(settingsState({ present: true }, 0, false).word).toBe("no form");
    expect(settingsState({ present: true }, 3, false).word).toBe("editable");
    expect(settingsState({ present: true }, 3, true).word).toBe("read-only");
  });

  test("the card returns before the form and before Edit any path", async () => {
    const source = await viewSource("spec-edit.js");
    const at = source.indexOf("function settingsCard(");
    expect(at).toBeGreaterThan(-1);
    const early = source.indexOf("if (absent.absent) {", at);
    const form = source.indexOf("formModel(body.schema, body.effective, trustRows, {", at);
    const anyPath = source.indexOf('text: "Edit any path…"', at);
    expect(early).toBeGreaterThan(at);
    expect(form).toBeGreaterThan(early);
    expect(anyPath).toBeGreaterThan(early);
    expect(source).toContain("emptyState(absent.note, absent.verb)");
  });
});

describe("unsaved values and focus across a re-read", () => {
  test("a typed value is kept against the value it was typed over, and dropped when that moved", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain("if (entry.seed !== seedMark(node)) {");
    expect(source).toContain('text: "Not saved yet.",');
    // "Use the version on disk" drops the typed value before the re-read.
    expect(source).toMatch(
      /const useDisk = \(\) => \{\s+unsaved\.delete\(unsavedKey\(ctx, node\)\);\s+reload\(\{ focusKey \}\);/,
    );
    expect(source.match(/reload: useDisk,/g)?.length).toBe(2);
    // A JSON pane write drops what the form held typed under its path.
    expect(source).toContain("dropUnsavedUnder(ctx, batch.edits[0]?.path ?? []);");
  });

  test("every conflict's re-read and a proposal's go back to the control that wrote", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain("reload: () => reload(focusOf(opener)),");
    expect(source).toContain("reportWrite(\n          staged,");
    expect(source.match(/reload\(focusOf\(opener\)\);/g)?.length).toBe(2);
  });

  test("a control gone after its own write hands focus to its field's Save, then its input", async () => {
    const { focusCandidates } = await import("../assets/js/views/spec-edit.js");
    expect(focusCandidates('clear:["agent","x"]')).toEqual([
      'clear:["agent","x"]',
      'save:["agent","x"]',
      'input:["agent","x"]',
    ]);
    expect(focusCandidates('save:["a"]')).toEqual(['save:["a"]', 'input:["a"]']);
    expect(focusCandidates("json:any")).toEqual(["json:any"]);
  });

  test("a control in the folded defaults or a closed block is revealed before it takes focus", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain("revealForFocus(target, root);");
    expect(source).toContain("if (at instanceof HTMLDetailsElement && !at.open) at.open = true;");
    expect(source).toContain('toggle.setAttribute("aria-expanded", "true");');
  });
});

describe("focus after a watch-me or advice 412", () => {
  /** The text from `start` to the first `end` after it; fails when either is gone. */
  const slice = (source: string, start: string, end: string): string => {
    const at = source.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    const stop = source.indexOf(end, at);
    expect(stop).toBeGreaterThan(at);
    return source.slice(at, stop);
  };

  test("watch-me's writes hold their button with aria-disabled, and the conflict view returns to it", async () => {
    const fabric = await viewSource("memory-fabric.js");
    const run = slice(
      fabric,
      "async function run(btn, label, call, onDone, conflict = null) {",
      "\n}\n",
    );
    expect(run.includes(".disabled = true")).toBe(false);
    expect(run.includes(".disabled = false")).toBe(false);
    expect(run).toContain('btn.setAttribute("aria-disabled", "true")');
    expect(run).toContain('if (btn.getAttribute("aria-disabled") === "true") return undefined;');
    expect(run).toContain("{ opener: btn, ...(conflict ?? {}) }");
  });

  test("advice's apply holds itself the same way, and is the opener the conflict view returns to", async () => {
    const feedback = await viewSource("feedback.js");
    const handler = slice(
      feedback,
      'text: "Apply to the spec",',
      'holder.appendChild(el("div", { class: "editor-actions" }, [apply]));',
    );
    expect(handler.includes("apply.disabled = true")).toBe(false);
    expect(handler.includes("apply.disabled = false")).toBe(false);
    expect(handler).toContain('apply.setAttribute("aria-disabled", "true")');
    expect(handler).toContain('if (apply.getAttribute("aria-disabled") === "true") return;');
    expect(handler).toContain("opener: apply,");
    expect(handler.includes("opener: previewBtn")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The settings form, rendered against just enough DOM to read its controls
// ---------------------------------------------------------------------------

/** An element with the parts `el()` and the settings card touch. */
class FormNode {
  readonly children: FormNode[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Array<(event: unknown) => unknown>> = {};
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => undefined } as Record<string, unknown>;
  readonly classList = {
    add: (...names: string[]): void => {
      this.className = [...new Set([...this.className.split(" "), ...names])]
        .filter((n) => n !== "")
        .join(" ");
    },
    remove: (...names: string[]): void => {
      this.className = this.className
        .split(" ")
        .filter((n) => n !== "" && !names.includes(n))
        .join(" ");
    },
    toggle: (): boolean => false,
    contains: (name: string): boolean => this.className.split(" ").includes(name),
  };
  className = "";
  ownText = "";
  value = "";
  hidden = false;
  disabled = false;
  parentNode: FormNode | null = null;
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = value;
  }
  get firstChild(): FormNode | null {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  addEventListener(name: string, fn: (event: unknown) => unknown): void {
    this.listeners[name] = [...(this.listeners[name] ?? []), fn];
  }
  appendChild<T extends FormNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: FormNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child: FormNode): void {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }
  replaceChildren(...nodes: FormNode[]): void {
    this.textContent = "";
    this.append(...nodes);
  }
  focus(): void {}
  querySelector(): FormNode | null {
    return null;
  }
  querySelectorAll(): FormNode[] {
    return [];
  }
  find(test: (node: FormNode) => boolean): FormNode | undefined {
    for (const child of this.children) {
      if (test(child)) return child;
      const deeper = child.find(test);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  }
  fire(name: string): void {
    for (const fn of this.listeners[name] ?? []) fn({ preventDefault: (): void => undefined });
  }
}

const formDocument = {
  body: new FormNode("body"),
  activeElement: null as FormNode | null,
  createElement: (tag: string) => new FormNode(tag),
  createTextNode: (value: string) => {
    const node = new FormNode("#text");
    node.ownText = value;
    return node;
  },
  getElementById: (): FormNode | null => null,
  querySelector: (): FormNode | null => null,
  querySelectorAll: (): FormNode[] => [],
};

describe("a value typed over a hidden one, rendered", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g["document"], Node: g["Node"], HTMLElement: g["HTMLElement"] };
  beforeAll(() => {
    g["document"] = formDocument;
    g["Node"] = FormNode;
    g["HTMLElement"] = FormNode;
  });
  afterAll(() => {
    g["document"] = saved.document;
    g["Node"] = saved.Node;
    g["HTMLElement"] = saved.HTMLElement;
  });

  const bodyWith = (value: string) => ({
    present: true,
    schema: {
      $ref: "#/definitions/t",
      definitions: {
        t: {
          type: "object",
          properties: {
            thredz: {
              type: "object",
              properties: { api_secret_text: { type: "string" }, label: { type: "string" } },
            },
          },
          additionalProperties: false,
        },
      },
    },
    effective: [
      { segments: ["thredz", "api_secret_text"], value, source: "declared" },
      { segments: ["thredz", "label"], value: "plain", source: "declared" },
    ],
    effectiveTruncated: false,
    rev: "r1",
  });
  const render = (ctx: { id: string }, value: string): FormNode =>
    settingsCard(
      ctx,
      bodyWith(value),
      null,
      { readOnly: { held: false } },
      () => undefined,
    ) as FormNode;
  const inputFor = (card: FormNode, setting: string): FormNode => {
    const field = card.find(
      (n) => n.dataset["fieldKey"] !== undefined && n.textContent.includes(setting),
    );
    expect(field).toBeDefined();
    const input = field?.find((n) => n.tag === "input" || n.tag === "textarea");
    expect(input).toBeDefined();
    return input as FormNode;
  };
  const idsFor = (ctx: { id: string }): string[] =>
    (unsavedEntryIds() as string[]).filter((id) => id.startsWith(`${ctx.id}\u0000`));

  test("a hidden value's replacement goes into a password field that keeps nothing", () => {
    const ctx = { id: "h-hidden" };
    const first = inputFor(render(ctx, "[redacted]"), "thredz.api_secret_text");
    expect(first.tag).toBe("input");
    expect(first.attrs["type"]).toBe("password");
    expect(first.attrs["autocomplete"]).toBe("new-password");
    expect(first.value).toBe("");
    first.value = "typed-replacement";
    first.fire("input");
    expect(idsFor(ctx)).toEqual([]);
    const again = inputFor(render(ctx, "[redacted]"), "thredz.api_secret_text");
    expect(again.value).toBe("");
  });

  test("a plain setting's typed value is kept, so the seam sees entries", () => {
    const ctx = { id: "h-plain" };
    const plain = inputFor(render(ctx, "[redacted]"), "thredz.label");
    expect(plain.attrs["type"]).toBe("text");
    plain.value = "typed";
    plain.fire("input");
    expect(idsFor(ctx).length).toBe(1);
    expect(inputFor(render(ctx, "[redacted]"), "thredz.label").value).toBe("typed");
  });

  test("in a capped read, a setting with no row of its own offers no control and no save", () => {
    const body = {
      ...bodyWith("plain"),
      effective: [{ segments: ["thredz", "label"], value: "plain", source: "declared" }],
      effectiveTruncated: true,
    };
    const card = settingsCard(
      { id: "h-capped" },
      body,
      null,
      { readOnly: { held: false } },
      () => undefined,
    ) as FormNode;
    const fieldOf = (setting: string) =>
      card.find((n) => n.dataset["fieldKey"] !== undefined && n.textContent.includes(setting));
    const cappedField = fieldOf("thredz.api_secret_text");
    expect(cappedField).toBeDefined();
    expect(cappedField?.textContent).toContain("crewhaus.yaml");
    expect(cappedField?.find((n) => n.tag === "input" || n.tag === "textarea")).toBeUndefined();
    expect(cappedField?.find((n) => n.tag === "select")).toBeUndefined();
    expect(cappedField?.find((n) => n.tag === "button")).toBeUndefined();
    // The setting the read did return keeps its control and its save.
    const shown = fieldOf("thredz.label");
    expect(shown?.find((n) => n.tag === "input")?.value).toBe("plain");
    expect(shown?.find((n) => n.tag === "button")).toBeDefined();
  });

  test("the notice for a capped read sends the rest to crewhaus.yaml", async () => {
    const source = await viewSource("spec-edit.js");
    const at = source.indexOf("body.effectiveTruncated === true\n");
    expect(at).toBeGreaterThan(-1);
    const notice = source.slice(at, source.indexOf("})", at));
    expect(notice).toContain("crewhaus.yaml");
    expect(notice.includes("JSON pane")).toBe(false);
  });
});

describe("a hidden or credential's setting keeps nothing typed into it", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g["document"], Node: g["Node"], HTMLElement: g["HTMLElement"] };
  beforeAll(() => {
    g["document"] = formDocument;
    g["Node"] = FormNode;
    g["HTMLElement"] = FormNode;
  });
  afterAll(() => {
    g["document"] = saved.document;
    g["Node"] = saved.Node;
    g["HTMLElement"] = saved.HTMLElement;
  });

  // A typed value, built at runtime: it must never be found anywhere it is kept.
  const TYPED = ["typed", "value", String(4242)].join("-");

  /** A form over one `probe` block whose settings are those given, with the rows given. */
  const bodyOf = (
    properties: Record<string, unknown>,
    effective: unknown[],
    credentialNames: string[] = [],
  ) => ({
    present: true,
    schema: {
      $ref: "#/definitions/t",
      definitions: {
        t: {
          type: "object",
          properties: { probe: { type: "object", properties } },
          additionalProperties: false,
        },
      },
    },
    effective,
    effectiveTruncated: false,
    credentialNames,
    rev: "r1",
  });
  const render = (ctx: { id: string }, body: unknown): FormNode =>
    settingsCard(ctx, body, null, { readOnly: { held: false } }, () => undefined) as FormNode;
  const fieldFor = (card: FormNode, setting: string): FormNode => {
    const field = card.find(
      (n) => n.dataset["fieldKey"] !== undefined && n.textContent.includes(setting),
    );
    expect(field).toBeDefined();
    return field as FormNode;
  };
  const idsFor = (ctx: { id: string }): string[] =>
    (unsavedEntryIds() as string[]).filter((id) => id.startsWith(`${ctx.id}\u0000`));
  const hidden = (segment: string) => ({
    segments: ["probe", segment],
    value: "[redacted]",
    source: "declared",
  });

  test("a hidden text setting keeps nothing, and a re-render shows it empty", () => {
    const ctx = { id: "h-wo-text" };
    const body = bodyOf({ word: { type: "string" } }, [hidden("word")]);
    const input = fieldFor(render(ctx, body), "probe.word").find((n) => n.tag === "input");
    expect(input?.attrs["type"]).toBe("password");
    (input as FormNode).value = TYPED;
    input?.fire("input");
    expect(idsFor(ctx)).toEqual([]);
    expect(fieldFor(render(ctx, body), "probe.word").find((n) => n.tag === "input")?.value).toBe(
      "",
    );
  });

  test("a hidden yes-or-no setting keeps nothing, and a re-render shows it unset", () => {
    const ctx = { id: "h-wo-bool" };
    const body = bodyOf({ flag: { type: "boolean" } }, [hidden("flag")]);
    const select = fieldFor(render(ctx, body), "probe.flag").find((n) => n.tag === "select");
    expect(select).toBeDefined();
    (select as FormNode).value = "0";
    select?.fire("change");
    expect(idsFor(ctx)).toEqual([]);
    const again = fieldFor(render(ctx, body), "probe.flag").find((n) => n.tag === "select");
    expect(again?.children[0]?.attrs["value"]).toBe("");
    expect(again?.children.some((o) => (o as unknown as { selected?: boolean }).selected)).toBe(
      false,
    );
  });

  test("a hidden choice setting keeps nothing, and a re-render shows it unset", () => {
    const ctx = { id: "h-wo-select" };
    const body = bodyOf({ mode: { type: "string", enum: ["fast", "slow"] } }, [hidden("mode")]);
    const select = fieldFor(render(ctx, body), "probe.mode").find((n) => n.tag === "select");
    expect(select).toBeDefined();
    (select as FormNode).value = "1";
    select?.fire("change");
    expect(idsFor(ctx)).toEqual([]);
    const again = fieldFor(render(ctx, body), "probe.mode").find((n) => n.tag === "select");
    expect(again?.children[0]?.attrs["value"]).toBe("");
    expect(again?.children.some((o) => (o as unknown as { selected?: boolean }).selected)).toBe(
      false,
    );
  });

  test("a hidden list setting keeps nothing, and a re-render shows it with no items", () => {
    const ctx = { id: "h-wo-list" };
    const body = bodyOf({ names: { type: "array", items: { type: "string" } } }, [
      { segments: ["probe", "names"], value: ["[redacted]"], source: "declared" },
    ]);
    const field = fieldFor(render(ctx, body), "probe.names");
    const add = field.find((n) => n.tag === "button" && n.textContent === "Add an item");
    expect(add).toBeDefined();
    add?.fire("click");
    const item = field.find((n) => n.tag === "input");
    expect(item).toBeDefined();
    (item as FormNode).value = TYPED;
    item?.fire("input");
    expect(idsFor(ctx)).toEqual([]);
    expect(
      fieldFor(render(ctx, body), "probe.names").find((n) => n.tag === "input"),
    ).toBeUndefined();
  });

  test("an absent credential setting is a password field that keeps nothing", () => {
    const ctx = { id: "h-credential" };
    const body = bodyOf(
      { api_key: { type: "string" }, label: { type: "string" } },
      [{ segments: ["probe", "label"], value: "plain", source: "declared" }],
      ["api_key"],
    );
    const input = fieldFor(render(ctx, body), "probe.api_key").find((n) => n.tag === "input");
    expect(input?.attrs["type"]).toBe("password");
    expect(input?.attrs["autocomplete"]).toBe("new-password");
    (input as FormNode).value = TYPED;
    input?.fire("input");
    expect(idsFor(ctx)).toEqual([]);
    expect(fieldFor(render(ctx, body), "probe.api_key").find((n) => n.tag === "input")?.value).toBe(
      "",
    );
  });

  test("a credential setting in the shape the masked schema arrives in is a concealed block", () => {
    const schema = bodyOf({ api_key: { type: "[redacted]" } }, []).schema;
    const nodeOf = (names?: string[]) =>
      flatten(
        formModel(schema, [], [], names === undefined ? {} : { credentialNames: names }).groups,
      ).find(
        (n: { key?: string; segments?: string[] }) => n.segments?.join(".") === "probe.api_key",
      );
    expect(nodeOf(["api_key"])).toMatchObject({ kind: "json", concealed: true });
    expect(nodeOf()?.concealed).toBe(false);
  });

  test("a conflict draft holds no typed value of a credential's setting", async () => {
    const model = formModel(bodyOf({ api_key: { type: "string" } }, []).schema, [], [], {
      credentialNames: ["api_key"],
    });
    const concealedAt = concealedPredicate(model, ["api_key"]);
    const edit = { path: ["probe", "api_key"], value: TYPED };
    for (const text of [draftOf(edit, concealedAt), draftOf([edit], concealedAt)]) {
      expect(text.includes(TYPED)).toBe(false);
      expect(text).toContain("[redacted]");
    }
    expect(JSON.parse(draftOf(edit, concealedAt))).toEqual({
      path: ["probe", "api_key"],
      value: "[redacted]",
    });
    const block = draftOf(
      [{ path: ["probe"], value: { api_key: TYPED, label: "x" } }],
      concealedAt,
    );
    expect(JSON.parse(block)).toEqual([
      { path: ["probe"], value: { api_key: "[redacted]", label: "x" } },
    ]);
    // With no test for what is a credential, every value is hidden.
    expect(JSON.parse(draftOf({ path: ["probe", "label"], value: "x" }))).toEqual({
      path: ["probe", "label"],
      value: "[redacted]",
    });
    const offered = await draftTextFor({}, { draft: draftOf(edit, concealedAt) });
    expect(offered.includes(TYPED)).toBe(false);
  });

  test("a write-only setting's path is hidden in a draft at and under it", () => {
    const body = bodyOf({ word: { type: "string" } }, [hidden("word")]);
    const model = formModel(body.schema, body.effective, [], {});
    const concealedAt = concealedPredicate(model, []);
    expect(concealedAt(["probe", "word"])).toBe(true);
    expect(concealedAt(["probe", "other"])).toBe(false);
    expect(JSON.parse(draftOf({ path: ["probe", "word"], value: TYPED }, concealedAt)).value).toBe(
      "[redacted]",
    );
  });

  test("both conflict drafts go through draftOf", async () => {
    const source = await viewSource("spec-edit.js");
    expect(source).toContain("draft: draftOf(edit, concealedAt),");
    expect(source).toContain("draft: draftOf(edits, concealedAt),");
  });
});
