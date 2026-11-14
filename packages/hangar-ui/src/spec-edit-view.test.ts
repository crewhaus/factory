/**
 * The spec editor's own decisions. The screen used to render the static
 * words "edit as YAML" for every non-scalar path and point at a YAML editor
 * that does not exist in this console, which left every block, every list,
 * and every field inside a list item unreachable. What replaced it is the
 * JSON pane, and everything the pane DECIDES — how a dotted path becomes the
 * server's segment array, what an empty pane means, what a batch looks like
 * — is pure, so it is proven here.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { conflictModel } from "../assets/js/ui/conflict.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  draftTextFor,
  editPath,
  editsFor,
  parseJsonValue,
  readOnlyModel,
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
    expect(source.includes("formModel(body.schema, body.effective, trustRows)")).toBe(true);
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
