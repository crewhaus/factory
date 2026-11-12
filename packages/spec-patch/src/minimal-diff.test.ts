import { describe, expect, test } from "bun:test";
import { parse, parseDocument } from "yaml";
import { applySpecEdits } from "./index";
import { renderMinimal, scalarSplice } from "./minimal-diff";

const SOURCE = `# a hand-edited spec
name: demo    # the harness name
target: cli
agent:
    model: "claude-opus-5"
    instructions: |
        You help.
        Be brief.

    tools: [Read, Grep]
    sub_agents:
        reviewer:
            model: 'claude-sonnet-5'
            instructions: Review.
    # about the rules
    permissions:
        allow:
          - Read
          - Grep
`;

type Edit = { path: Array<string | number>; value?: unknown };

/** The CST result and the minimal one for the same edits. */
function render(edits: Edit[]) {
  const doc = parseDocument(SOURCE);
  for (const e of edits) {
    if (e.value === undefined) doc.deleteIn(e.path);
    else doc.setIn(e.path, e.value);
  }
  const minimal = renderMinimal(
    SOURCE,
    doc,
    edits.map((e) => e.path),
  );
  return { doc, minimal };
}

/** Bytes before `start` and after `end` of the source are where they were. */
function outsideIdentical(after: string, start: number, end: number): void {
  expect(after.slice(0, start)).toBe(SOURCE.slice(0, start));
  expect(after.slice(after.length - (SOURCE.length - end))).toBe(SOURCE.slice(end));
}

function rangeOf(needle: string): [number, number] {
  const start = SOURCE.indexOf(needle);
  expect(start).toBeGreaterThan(-1);
  return [start, start + needle.length];
}

describe("renderMinimal: each kind of edit changes only its own range", () => {
  test("a plain scalar", () => {
    const { doc, minimal } = render([{ path: ["name"], value: "demo-two" }]);
    expect(minimal?.formatting).toBe("kept");
    const [s, e] = rangeOf("demo    #");
    outsideIdentical(minimal?.yaml ?? "", s, s + "demo".length);
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
    expect(e).toBeGreaterThan(s);
  });

  test("a quoted scalar keeps its quotes", () => {
    const { doc, minimal } = render([{ path: ["agent", "model"], value: "claude-sonnet-5" }]);
    const [s, e] = rangeOf('"claude-opus-5"');
    outsideIdentical(minimal?.yaml ?? "", s, e);
    expect(minimal?.yaml).toContain('model: "claude-sonnet-5"');
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });

  test("a block scalar keeps its header and the file's indentation", () => {
    const { doc, minimal } = render([
      { path: ["agent", "instructions"], value: "You help.\nBe kind.\n" },
    ]);
    const [s, e] = rangeOf("|\n        You help.\n        Be brief.\n");
    outsideIdentical(minimal?.yaml ?? "", s, e);
    expect(minimal?.yaml).toContain("    instructions: |\n        You help.\n        Be kind.\n");
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });

  test("a flow list is re-rendered in flow style in its own range", () => {
    const { doc, minimal } = render([
      { path: ["agent", "tools"], value: ["Read", "Grep", "Glob"] },
    ]);
    const [s, e] = rangeOf("[Read, Grep]");
    outsideIdentical(minimal?.yaml ?? "", s, e);
    expect(minimal?.yaml).toContain("tools: [Read, Grep, Glob]");
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });

  test("an added key lands after the parent map's last pair, at its indentation", () => {
    const { doc, minimal } = render([
      { path: ["agent", "sub_agents", "reviewer", "max_turns"], value: 4 },
    ]);
    const at =
      SOURCE.indexOf("            instructions: Review.\n") +
      "            instructions: Review.\n".length;
    outsideIdentical(minimal?.yaml ?? "", at, at);
    expect(minimal?.yaml).toContain(
      "            instructions: Review.\n            max_turns: 4\n",
    );
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });

  test("a deleted key takes its lines and its attached comment", () => {
    const { doc, minimal } = render([{ path: ["agent", "permissions"] }]);
    const [s] = rangeOf("    # about the rules\n");
    outsideIdentical(minimal?.yaml ?? "", s, SOURCE.length);
    expect(minimal?.yaml).not.toContain("about the rules");
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });

  test("a sequence append follows the siblings' dash style", () => {
    const { doc, minimal } = render([
      { path: ["agent", "permissions", "allow", 2], value: "Glob" },
    ]);
    outsideIdentical(minimal?.yaml ?? "", SOURCE.length, SOURCE.length);
    expect(minimal?.yaml.endsWith("          - Grep\n          - Glob\n")).toBe(true);
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });

  test("several edits in different places each keep their own range", () => {
    const { doc, minimal } = render([
      { path: ["name"], value: "x" },
      { path: ["agent", "sub_agents", "reviewer", "model"], value: "claude-haiku-5" },
    ]);
    expect(minimal?.yaml).toContain("name: x    # the harness name");
    expect(minimal?.yaml).toContain("model: 'claude-haiku-5'");
    expect(parse(minimal?.yaml ?? "")).toEqual(doc.toJS());
  });
});

describe("renderMinimal: what it will not splice", () => {
  test("a source with an alias is left to the full re-render", () => {
    const aliased =
      "name: a\ntarget: cli\nshared: &s\n  x: 1\nagent:\n  ref: *s\n  model: m\n  instructions: i\n";
    const doc = parseDocument(aliased);
    doc.setIn(["shared", "x"], 2);
    expect(renderMinimal(aliased, doc, [["shared", "x"]])).toBeUndefined();
  });

  test("applySpecEdits answers restyled with the CST text when the renderer cannot place an edit", () => {
    const aliased =
      "name: a\ntarget: cli\nagent:\n  model: &m claude-opus-5\n  instructions: hi\nmodels:\n  fast:\n    model: *m\n";
    const out = applySpecEdits(aliased, [{ path: ["agent", "instructions"], value: "hello" }]);
    expect(out.formatting).toBe("restyled");
    const doc = parseDocument(aliased);
    doc.setIn(["agent", "instructions"], "hello");
    expect(out.yaml).toBe(doc.toString());
  });

  test("applySpecEdits answers kept with only the edited bytes changed", () => {
    const valid = `# kept as written
name: demo    # the name
target: cli
agent:
    model: "claude-opus-5"
    instructions: |
        You help.
`;
    const out = applySpecEdits(valid, [{ path: ["agent", "model"], value: "claude-sonnet-5" }]);
    expect(out.formatting).toBe("kept");
    expect(out.yaml).toBe(valid.replace("claude-opus-5", "claude-sonnet-5"));
  });
});

describe("scalarSplice", () => {
  test("keeps double quotes, single quotes and a plain word", () => {
    const src = `a: "x"\nb: 'y'\nc: z\n`;
    const doc = parseDocument(src);
    const node = (k: string) => doc.get(k, true) as Parameters<typeof scalarSplice>[1];
    expect(scalarSplice(src, node("a"), "q")?.text).toBe('"q"');
    expect(scalarSplice(src, node("b"), "it's")?.text).toBe("'it''s'");
    expect(scalarSplice(src, node("c"), "word")?.text).toBe("word");
    expect(scalarSplice(src, node("c"), "two words: here")?.text).toBe('"two words: here"');
  });
});
