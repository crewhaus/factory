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
import { editPath, editsFor, parseJsonValue } from "../assets/js/views/spec-edit.js";

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

  test("every non-scalar path has a real control behind it", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/spec-edit.js", import.meta.url),
    ).text();
    expect(source.includes("jsonPaneButton(")).toBe(true);
    expect(source.includes('text: "Edit as JSON…"')).toBe(true);
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
});
