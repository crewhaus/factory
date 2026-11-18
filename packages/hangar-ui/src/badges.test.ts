/**
 * A declared badge the harness's shape does not use says so in words, with a
 * "Why?" disclosure, and the Library chip reads "not used here". Rendered with
 * just enough DOM for `el()`, so every string asserted is a text node.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
const badges = await import("../assets/js/ui/badges.js");

/** Every node under `node`, depth first. */
function all(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(all)];
}

const REASON = "watchme is accepted on the managed shape but its emitter does not wire it yet";

describe("the harness header's badge strip", () => {
  test("a badge the shape does not use says so in words, with a Why? disclosure", () => {
    const strip = badges.badgeStrip(
      { watchme: true, budget: true, memory: false },
      { watchme: { status: "unwired", reason: REASON }, budget: { status: "wired" } },
      undefined,
      "managed",
    ) as FakeNode;
    const nodes = all(strip);
    expect(strip.textContent).toContain("watchme Not used on managed harnesses");
    expect(strip.textContent).toContain("budget");
    expect(strip.textContent).not.toContain("memory");
    const details = nodes.filter((n) => n.tag === "details");
    expect(details).toHaveLength(1);
    const summary = details[0]?.children.find((n) => n.tag === "summary");
    expect(summary?.textContent).toBe("Why?");
    expect(details[0]?.textContent).toContain(REASON);
    // Status is words, not only a class: the used badge carries no such words.
    const chips = strip.children;
    expect(chips.map((c) => c.textContent)).toEqual([
      `watchme Not used on managed harnessesWhy?${REASON}`,
      "budget",
    ]);
  });

  test("the note shows once beneath the strip, with the command that answers it", () => {
    const note = "Built with CrewHaus 0.8.4. Recompile to check which settings take effect.";
    const block = badges.badgeStrip(
      { watchme: true, budget: true },
      { watchme: { status: "unknown" }, budget: { status: "unknown" } },
      note,
      "managed",
      "crewhaus compile",
    ) as FakeNode;
    const nodes = all(block);
    expect(nodes.filter((n) => n.textContent === `${note} `)).toHaveLength(1);
    const code = nodes.filter((n) => n.tag === "code");
    expect(code.map((n) => n.textContent)).toEqual(["crewhaus compile"]);
    expect(block.textContent).not.toContain("Not used");
    // An unknown badge says so in words.
    expect(block.textContent).toContain("watchme Not checked");
  });

  test("a note no command answers (a newer build) shows no command", () => {
    const note =
      "Built with a newer CrewHaus (0.10.0) than this one (0.9.0). Update this CrewHaus to check which settings take effect.";
    const block = badges.badgeStrip(
      { watchme: true },
      { watchme: { status: "unknown" } },
      note,
      "managed",
    ) as FakeNode;
    const nodes = all(block);
    expect(nodes.filter((n) => n.tag === "code")).toHaveLength(0);
    expect(nodes.filter((n) => n.tag === "span" && n.textContent === note)).toHaveLength(1);
  });

  test("a badge that needs a recompile says so in words", () => {
    const strip = badges.badgeStrip(
      { budget: true },
      { budget: { status: "recompile", reason: "Recompile to turn this on." } },
      undefined,
      "cli",
    ) as FakeNode;
    expect(strip.children.map((c) => c.textContent)).toEqual(["budget Recompile to turn on"]);
  });

  test("no declared badge renders nothing", () => {
    expect(badges.badgeStrip({ watchme: false }, {}, undefined, "cli")).toBeNull();
    expect(badges.badgeStrip(undefined, undefined, undefined, "cli")).toBeNull();
  });
});

describe("the Library chip", () => {
  test("reads 'not used here' for a badge the shape does not use", () => {
    const support = { watchme: { status: "unwired", reason: REASON }, budget: { status: "wired" } };
    expect((badges.libraryChip("watchme", support) as FakeNode).textContent).toBe(
      "watchme · not used here",
    );
    expect((badges.libraryChip("budget", support) as FakeNode).textContent).toBe("budget");
    expect((badges.libraryChip("memory", {}) as FakeNode).textContent).toBe("memory");
  });

  test("reads 'recompile to turn on' and 'not checked' in words", () => {
    const support = { budget: { status: "recompile" }, memory: { status: "unknown" } };
    expect((badges.libraryChip("budget", support) as FakeNode).textContent).toBe(
      "budget · recompile to turn on",
    );
    expect((badges.libraryChip("memory", support) as FakeNode).textContent).toBe(
      "memory · not checked",
    );
  });
});
