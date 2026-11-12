/**
 * A row with several command-line equivalents names each one.
 *
 * A review row shows one equivalent per verdict, and an approval row one for
 * grant and one for deny. Each starts in the harness directory, so the words
 * that tell them apart sit late in a long line. The label beside each, and
 * the name of its copy button, say which action it mirrors.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Just enough DOM for `el()`: nodes, attributes and text. */
class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  ownText = "";
  constructor(readonly tag: string) {}
  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(value: string) {
    this.classes.clear();
    for (const c of value.split(/\s+/)) if (c !== "") this.classes.add(c);
  }
  readonly classList = {
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
  };
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.children.length = 0;
    this.ownText = value;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(): void {}
  appendChild<T extends FakeNode>(child: T): T {
    this.children.push(child);
    return child;
  }
}

const saved = {
  document: (globalThis as Record<string, unknown>)["document"],
  Node: (globalThis as Record<string, unknown>)["Node"],
};
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g["Node"] = FakeNode;
  g["document"] = {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (value: string) => {
      const node = new FakeNode("#text");
      node.ownText = value;
      return node;
    },
  };
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  g["document"] = saved.document;
  g["Node"] = saved.Node;
});

// @ts-expect-error — hand-written browser JS, typed as text for the embed map
const control = await import("../assets/js/views/control.js");

type Rendered = { label: string; command: string | null; copyName: string | null };

function read(node: FakeNode): Rendered {
  const [label, middle, copy] = node.children;
  return {
    label: label?.textContent ?? "",
    command: middle?.tag === "code" ? middle.textContent : null,
    copyName: copy?.getAttribute("aria-label") ?? null,
  };
}

describe("a command-line equivalent's label", () => {
  test("names the verdict it mirrors, on the line and on its copy button", () => {
    const dir = "/home/sam/harnesses/support-desk";
    const rendered = (["pass", "fail"] as const).map((verdict) =>
      read(control.actionTwin("review", { dir, id: "rev_1", verdict }, verdict)),
    );
    expect(rendered.map((r) => r.label)).toEqual(["pass", "fail"]);
    expect(rendered.map((r) => r.copyName)).toEqual([
      "Copy the pass command",
      "Copy the fail command",
    ]);
    expect(rendered[0]?.command).toStartWith(`cd '${dir}' && crewhaus review resolve`);
    const thumbs = read(
      control.actionTwin(
        "adjudicate",
        { dir, id: "rev_1", sessionId: "sess_1", turn: 2, verdict: "down" },
        "down",
      ),
    );
    expect(thumbs).toMatchObject({ label: "down", copyName: "Copy the down command" });
  });

  test("names grant and deny on an approval", () => {
    const grant = read(control.actionTwin("grant", { id: "appr_1", dir: "/h" }, "Grant"));
    const deny = read(control.actionTwin("deny", { id: "appr_1", dir: "/h" }, "Deny"));
    expect([grant.label, deny.label]).toEqual(["Grant", "Deny"]);
    expect([grant.copyName, deny.copyName]).toEqual([
      "Copy the Grant command",
      "Copy the Deny command",
    ]);
  });

  test("is the generic one where a line stands alone", () => {
    const twin = read(control.cliTwin("crewhaus doctor"));
    expect(twin).toEqual({ label: "CLI twin", command: "crewhaus doctor", copyName: null });
    const none = control.cliTwin(null, "no verb yet", "pass");
    expect(read(none).label).toBe("pass");
  });

  test("the review and approval rows pass the verdict to every equivalent they show", () => {
    const views = join(import.meta.dir, "..", "assets", "js", "views");
    const review = readFileSync(join(views, "review.js"), "utf8");
    const approvals = readFileSync(join(views, "approvals.js"), "utf8");
    // Every actionTwin call in each row takes a third, label argument.
    const calls = (source: string): string[] =>
      [...source.matchAll(/actionTwin\(([\s\S]*?)\)(?=,?\s*\n)/g)].map((m) => m[1] as string);
    expect(calls(review).length).toBe(2);
    for (const call of calls(review)) expect(call.trimEnd()).toMatch(/verdict,?$/);
    expect(calls(approvals)).toEqual([
      '"grant", { id: row.id, dir: row.dir }, "Grant"',
      '"deny", { id: row.id, dir: row.dir }, "Deny"',
    ]);
  });
});
