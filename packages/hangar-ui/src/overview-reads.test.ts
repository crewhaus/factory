/**
 * The Overview's versioned-API cards make exactly the reads they declare: one read of
 * the operation table and one call each, counted on a stubbed fetch.
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
    addEventListener: () => {},
    hidden: false,
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

const OPS = [
  ["harnesses.get", "GET", "/api/v1/harnesses/{h}"],
  ["decisions.list", "GET", "/api/v1/decisions"],
  ["runs.list", "GET", "/api/v1/harnesses/{h}/runs"],
  ["delegations.list", "GET", "/api/v1/harnesses/{h}/delegations"],
  ["budget.get", "GET", "/api/v1/harnesses/{h}/budget"],
].map(([id, method, path]) => ({ id, method, path }));

const sent: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    sent.push(url);
    const body =
      url === "/api/v1" ? { operations: OPS } : { items: [], display: { state: "running" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the Overview's reads", () => {
  test("one table read and five calls, each once", async () => {
    // @ts-expect-error — hand-written browser JS, typed as text for the embed map
    const { v1OverviewCards } = await import("../assets/js/views/overview-cards.js");
    // @ts-expect-error — hand-written browser JS, typed as text for the embed map
    const { resetDiscovery } = await import("../assets/js/v1.js");
    // Another file may have read the table already: this count starts from none.
    resetDiscovery();
    sent.length = 0;
    const cards = await v1OverviewCards({ id: "hrn_000000000000000a" });
    expect(cards.length).toBeGreaterThan(0);
    expect(sent.filter((u) => u === "/api/v1")).toHaveLength(1);
    const calls = sent.filter((u) => u !== "/api/v1").map((u) => u.split("?")[0]);
    expect(calls.sort()).toEqual(
      [
        "/api/v1/decisions",
        "/api/v1/harnesses/hrn_000000000000000a",
        "/api/v1/harnesses/hrn_000000000000000a/budget",
        "/api/v1/harnesses/hrn_000000000000000a/delegations",
        "/api/v1/harnesses/hrn_000000000000000a/runs",
      ].sort(),
    );
    expect(sent.find((u) => u.startsWith("/api/v1/decisions"))).toBe(
      "/api/v1/decisions?harness=hrn_000000000000000a&state=pending&limit=5",
    );
  });
});
