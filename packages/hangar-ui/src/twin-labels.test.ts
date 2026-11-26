/**
 * A row with several command-line equivalents names each one.
 *
 * Each starts in the harness directory, so the words that tell them apart sit
 * late in a long line. The label beside each, and the name of its copy
 * button, say which action it mirrors.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
  replaceChildren(...nodes: FakeNode[]): void {
    this.children.length = 0;
    this.ownText = "";
    this.children.push(...nodes);
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
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
const apiModule = await import("../assets/js/api.js");

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
});

describe("a write's note", () => {
  const NOTE =
    "Same as `crewhaus wiki archive <slug> --expect <version>`, run in the harness folder; add `--undo` to publish the article again.";

  test("shows its commands as code, and copies the first one", () => {
    const node = control.noteTwin(NOTE, "Archive") as FakeNode;
    expect(node.className).toBe("twin twin-noted");
    const [label, text, copy] = node.children;
    expect(label?.textContent).toBe("Archive");
    expect(text?.children.map((c) => `${c.tag}:${c.textContent}`)).toEqual([
      "#text:Same as ",
      "code:crewhaus wiki archive <slug> --expect <version>",
      "#text:, run in the harness folder; add ",
      "code:--undo",
      "#text: to publish the article again.",
    ]);
    expect(copy?.getAttribute("aria-label")).toBe("Copy the Archive command");
    expect(text?.textContent).toBe(NOTE.replaceAll("`", ""));
  });

  test("that names no command is a muted line with no copy button", () => {
    const node = control.noteTwin("No command-line equivalent.") as FakeNode;
    expect(node.className).toBe("twin twin-none");
    expect(node.children).toHaveLength(2);
    expect(node.textContent).toBe("CLI twinNo command-line equivalent.");
  });

  test("shows only where the view holds the harness folder, or the write is Home's own", async () => {
    const realFetch = globalThis.fetch;
    apiModule.resetTwinNotes();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ notes: { wikiArchive: NOTE } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const withDir = control.writeTwin("wikiArchive", { dir: "/h" }) as FakeNode;
      const homeWide = control.writeTwin("wikiArchive", control.HOME_WIDE) as FakeNode;
      const noDir = control.writeTwin("wikiArchive", { id: "hrn_1" }) as FakeNode;
      const unknown = control.writeTwin("noSuchWrite", { dir: "/h" }) as FakeNode;
      await apiModule.twinNotes();
      expect(withDir.children[0]?.className).toBe("twin twin-noted");
      expect(homeWide.children[0]?.className).toBe("twin twin-noted");
      expect(noDir.children).toHaveLength(0);
      expect(unknown.children).toHaveLength(0);
      // Once read, the next one shows at once.
      const later = control.writeTwin("wikiArchive", { dir: "/h" }) as FakeNode;
      expect(later.children[0]?.className).toBe("twin twin-noted");
    } finally {
      globalThis.fetch = realFetch;
      apiModule.resetTwinNotes();
    }
  });
});
