/**
 * One decision card: who decided is the server's sentence, shown verbatim, whether a
 * delegation rule decided or a person did; the input, the places, what it supersedes,
 * the class it needs, what it is bound to and its fallback all reach the card; and the
 * card never words "decided by" itself. A refused choice says what changed and who won.
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

// @ts-expect-error — hand-written browser JS, typed as text for the embed map
const card = await import("../assets/js/views/decision-card.js");

const DELEGATED =
  "Decided by delegation rule Merge reviewed pull requests (revision 2), turned on by Olive on 2 Nov 2026";

const MERGE = {
  id: "dec_01jc0000000000000000000003",
  kind: "merge",
  harness: "hrn_000000000000000a",
  ref: "hrn_000000000000000a/decision/dec_01jc0000000000000000000003",
  state: "granted",
  requiredClass: "maintainer",
  decision: "grant",
  resolvedBy: "delegation",
  delegation: { rule: "rule_01jc0000000000000000000002", revision: 2 },
  appliedBy: "prn_01jc00000000000000000000aa",
  decidedByText: DELEGATED,
};

const TOOL = {
  id: "appr_00000000000000e1",
  harness: "hrn_000000000000000a",
  toolName: "SendMessage",
  input: { channel: "ops", text: "ship it" },
  places: [{ path: "channels/ops" }],
  supersedes: { id: "appr_00000000000000e0" },
  runId: "run_00000000000000a0",
  requiredClass: "operator",
  bindingDigest: "abc123",
  fallback: "carry-on",
  expiresAt: "2099-01-01T00:00:00.000Z",
  state: "pending",
};

function all(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(all)];
}

describe("the decision card", () => {
  test("a delegated decision's text is the server's, verbatim, and names no person", () => {
    const model = card.decisionCardModel(MERGE, Date.parse("2026-11-20T00:00:00Z"));
    expect(model.decidedByText).toBe(DELEGATED);
    expect(model.title).toBe("Merge");
    expect(model.stateWords).toBe("Granted");
    expect(model.classNeeded).toBe("Needs a Maintainer");
    const drawn = card.renderDecisionCard(MERGE) as FakeNode;
    const texts = all(drawn).map((n) => n.ownText);
    expect(texts).toContain(DELEGATED);
    expect(drawn.textContent).not.toContain(MERGE.appliedBy);
  });

  test("a person's decision reads as the server words it", () => {
    const person = {
      ...TOOL,
      state: "granted",
      decision: "grant",
      decidedByText: "Decided by Sam",
    };
    const drawn = card.renderDecisionCard(person) as FakeNode;
    expect(all(drawn).map((n) => n.ownText)).toContain("Decided by Sam");
  });

  test("the model never words who decided: a row without the server's text shows none", () => {
    const model = card.decisionCardModel(
      {
        ...TOOL,
        state: "granted",
        decision: "grant",
        decidedBy: "Sam",
        decidedByPrincipal: "prn_x",
      },
      0,
    );
    expect(model.decidedByText).toBeNull();
    const drawn = card.renderDecisionCard({
      ...TOOL,
      state: "granted",
      decidedBy: "Sam",
    }) as FakeNode;
    expect(drawn.textContent.toLowerCase()).not.toContain("decided by");
  });

  test("input, places, what it supersedes, class, binding and fallback all reach the card", () => {
    const model = card.decisionCardModel(TOOL, Date.parse("2026-11-20T00:00:00Z"));
    expect(model.input).toEqual({ shown: true, value: TOOL.input });
    expect(model.places).toEqual(TOOL.places);
    expect(model.supersedes).toEqual(TOOL.supersedes);
    expect(model.classNeeded).toBe("Needs an Operator");
    expect(model.binding).toBe("Bound to this run and this spec revision");
    expect(model.fallback).toBe("If no one answers in time, it carries on with other work.");
    expect(model.runHref).toBe("#/i/hrn_000000000000000a/run/run_00000000000000a0");
    expect(model.expect).toBe("abc123");
    expect(model.choices).toEqual(["grant", "deny"]);
    const text = (card.renderDecisionCard(TOOL) as FakeNode).textContent;
    for (const piece of ["ship it", "channels/ops", "appr_00000000000000e0", "Needs an Operator"]) {
      expect(`${piece}: ${text.includes(piece)}`).toBe(`${piece}: true`);
    }
  });

  test("withheld input says so, and no input key means none is shown", () => {
    expect(
      card.decisionCardModel({ ...TOOL, input: undefined, inputWithheld: true }, 0).input?.shown,
    ).toBe(false);
    expect(card.decisionCardModel(MERGE, 0).input).toBeNull();
  });

  test("a choice sends the binding digest as expect, through one action", async () => {
    const sent: unknown[] = [];
    const model = card.decisionCardModel(TOOL, 0);
    const answer = await card.chooseDecision(model, "grant", {
      createAction: (id: string, opts: unknown) => {
        sent.push({ id, opts });
        return { key: "k", run: async () => ({ ok: true, status: 200, body: {} }) };
      },
    });
    expect(answer.ok).toBe(true);
    expect(sent).toEqual([
      {
        id: "decisions.resolve",
        opts: {
          params: { ref: "hrn_000000000000000a/decision/appr_00000000000000e1" },
          body: { choice: "grant", expect: "abc123" },
        },
      },
    ]);
  });

  test("a refused choice says it changed, or who won and through which door", () => {
    expect(
      card.choiceRefusalWords({ ok: false, status: 412, error: { code: "precondition_failed" } }),
    ).toBe("This changed since you opened it.");
    expect(
      card.choiceRefusalWords({
        ok: false,
        status: 409,
        error: {
          code: "already_decided",
          current: { decidedByText: "Decided by Ana", surface: "slack" },
        },
      }),
    ).toBe("Someone already decided this. Decided by Ana. It was decided in Slack.");
  });
});
