/**
 * Home's status line is patched in place: a part that stays keeps its node, so a person
 * whose focus is on "1 needs you" keeps it while the line's counts change around it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/** A node that knows its parent, so removing the focused one moves focus to the body. */
class FakeNode {
  childNodes: FakeNode[] = [];
  parent: FakeNode | null = null;
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  className = "";
  ownText = "";
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.ownText + this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parent = null;
    this.childNodes = [];
    this.ownText = value;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(): void {}
  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }
  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error("not a child");
    this.childNodes.splice(at, 1);
    child.parent = null;
    // Taking a node out of the page drops focus from it, as a browser does.
    if (fakeDocument.activeElement === child) fakeDocument.activeElement = fakeDocument.body;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (child.parent !== null) child.parent.removeChild(child);
    const at = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(at, 0, child);
    child.parent = this;
    return child;
  }
}

const fakeDocument = {
  body: new FakeNode("body"),
  activeElement: null as FakeNode | null,
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (value: string) => {
    const node = new FakeNode("#text");
    node.ownText = value;
    return node;
  },
};

const saved = {
  document: (globalThis as Record<string, unknown>)["document"],
  Node: (globalThis as Record<string, unknown>)["Node"],
};
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g["Node"] = FakeNode;
  g["document"] = fakeDocument;
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  g["document"] = saved.document;
  g["Node"] = saved.Node;
});

describe("Home's status line", () => {
  test("a fleet change keeps the focused part's node, and its focus", async () => {
    // @ts-expect-error — hand-written browser JS, typed as text for the embed map
    const { patchStatusLine, statusLineParts } = await import("../assets/js/views/home.js");
    const line = new FakeNode("p");
    const nodes = new Map();
    patchStatusLine(
      line,
      statusLineParts({ counts: { harnesses: 3, needsYou: 1, working: 0 } }),
      [],
      nodes,
    );
    const needs = line.childNodes.find((n) => n.dataset["key"] === "needsYou");
    expect(needs?.textContent).toBe("1 needs you");
    fakeDocument.activeElement = needs ?? null;
    // The next frame: another harness starts working, and a second item needs you.
    patchStatusLine(
      line,
      statusLineParts({ counts: { harnesses: 3, needsYou: 2, working: 1 } }),
      [],
      nodes,
    );
    const after = line.childNodes.find((n) => n.dataset["key"] === "needsYou");
    expect(after).toBe(needs);
    expect(after?.textContent).toBe("2 need you");
    expect(fakeDocument.activeElement).toBe(needs ?? null);
    expect(line.textContent).toBe("3 harnesses · 2 need you · 1 working");
    // A part that goes is removed; the rest stay where they are.
    patchStatusLine(line, statusLineParts({ counts: { harnesses: 3, needsYou: 2 } }), [], nodes);
    expect(line.textContent).toBe("3 harnesses · 2 need you");
    expect(fakeDocument.activeElement).toBe(needs ?? null);
  });
});
