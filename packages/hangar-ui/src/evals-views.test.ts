/**
 * The Evals tab, driven by payloads in the server's shape. `contract.test.ts`
 * proves the server sends that shape from real runner output; this proves the
 * screen reads it, and that every status has a word.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/** Just enough DOM for the view code: it only builds nodes and reads them back. */
class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Array<() => void>> = {};
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  ownText = "";
  disabled = false;
  parent: FakeNode | null = null;
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
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(name: string, fn: () => void): void {
    this.listeners[name] = [...(this.listeners[name] ?? []), fn];
  }
  appendChild<T extends FakeNode>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode): void {
    this.children.splice(this.children.indexOf(child), 1);
  }
  /** Every descendant with this tag. */
  all(tag: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (child.tag === tag) found.push(child);
      found.push(...child.all(tag));
    }
    return found;
  }
  querySelectorAll(tag: string): FakeNode[] {
    return this.all(tag);
  }
  click(): void {
    for (const fn of this.listeners["click"] ?? []) fn();
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
const views = await import("../assets/js/views/evals.js");
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
const lab = await import("../assets/js/views/evals-lab.js");

const CTX = { id: "hrn_0123456789abcdef", dir: "/h" };
const RUN = "run_00000000000000aa";

const row = (verdict: string, overrides: Record<string, unknown> = {}) => ({
  sampleId: `s-${verdict}`,
  dir: `s-${verdict}`,
  verdict,
  score: verdict === "pass" ? 1 : verdict === "fail" ? 0.5 : null,
  note: `why ${verdict}`,
  flaky: false,
  needsReview: false,
  ...overrides,
});

const RUN_PAYLOAD = {
  runId: RUN,
  summary: { aggregates: { passRate: 0.5 } },
  sampleIds: ["s-pass", "s-fail", "s-error", "s-abstained", "s-canary"],
  stats: {
    passRate: 0.5,
    meanScore: 0.75,
    sampleCount: 5,
    errorCount: 1,
    measuredCount: 2,
    costUsd: null,
    partial: false,
    replayed: false,
    flakyCount: 0,
  },
  rows: ["pass", "fail", "error", "abstained", "canary"].map((v) => row(v)),
};

describe("every verdict has a word", () => {
  test("in the words the screen promises", () => {
    expect(views.verdictFace("pass").word).toBe("pass");
    expect(views.verdictFace("fail").word).toBe("fail");
    expect(views.verdictFace("error").word).toBe("error");
    expect(views.verdictFace("abstained").word).toBe("needs a person");
    expect(views.verdictFace("canary").word).toBe("canary");
    expect(views.verdictFace("unknown").word).toBe("no result");
  });

  test("and nothing prints a question mark, however odd the input", () => {
    for (const verdict of [undefined, null, "", "toString", "constructor", 7]) {
      expect(views.verdictFace(verdict).word).toBe("no result");
    }
    for (const face of Object.values(views.VERDICT_FACES) as Array<{ word: string }>) {
      expect(face.word).not.toContain("?");
    }
    expect(views.gradeVerdict(undefined, false)).toBe("unknown");
  });

  test("a grader's record reads by what it records", () => {
    expect(views.gradeVerdict(true, false)).toBe("pass");
    expect(views.gradeVerdict(false, false)).toBe("fail");
    expect(views.gradeVerdict(false, true)).toBe("abstained");
  });
});

describe("the history's pass rate", () => {
  test("a run that measured nothing shows that, never a bare 0%", () => {
    expect(views.passRateWord({ passRate: 0, measuredCount: 0 })).toBe("not measured");
    expect(views.passDotState({ passRate: 0, measuredCount: 0 })).toBe("unknown");
    expect(views.passRateWord({ passRate: 0, partial: true })).toBe("partial");
    expect(views.passDotState({ passRate: 0, partial: true })).toBe("warn");
  });

  test("a measured rate prints as itself, whatever a row once claimed about a gate", () => {
    expect(views.passRateWord({ passRate: 0.5 })).toBe("50%");
    expect(views.passDotState({ passRate: 0.5, gatePassed: true })).toBe("warn");
    expect(views.passDotState({ passRate: 1, gatePassed: false })).toBe("ok");
  });

  test("the row a replayed run gets is badged", () => {
    const root = new FakeNode("div");
    views.drawHistory(
      root,
      CTX,
      {
        runs: [{ runId: RUN, datasetName: "smoke", passRate: 1, meanScore: 1, replayed: true }],
        baselines: {},
        unreadable: null,
      },
      () => {},
    );
    expect(root.textContent).toContain("replayed");
  });
});

describe("the pin column", () => {
  test("a run that cannot be pinned gets its reason in words, and no button", () => {
    const reason = "in run r every case errored, so it says nothing about the spec";
    const cell = views.baselineCell(CTX.id, { pinRefusal: reason }, RUN, false, "/h", () => {});
    expect(cell.tag).toBe("span");
    expect(cell.classes.has("gated-why")).toBe(true);
    expect(cell.textContent).toBe(reason);
    expect(cell.all("button")).toEqual([]);
  });

  test("a run that can be pinned gets the button", () => {
    const cell = views.baselineCell(CTX.id, {}, RUN, false, "/h", () => {});
    expect(cell.all("button").map((b: FakeNode) => b.textContent)).toContain("Pin baseline");
  });

  test("the pinned run says so, whatever a later rule thinks of it", () => {
    const cell = views.baselineCell(CTX.id, { pinRefusal: "x" }, RUN, true, "/h", () => {});
    expect(cell.textContent).toBe("baseline");
  });
});

describe("the empty history", () => {
  const draw = (data: unknown): string => {
    const root = new FakeNode("div");
    views.drawHistory(root, CTX, data, () => {});
    return root.textContent;
  };

  test("an unreadable history is not 'no evals'", () => {
    const text = draw({
      runs: [],
      baselines: {},
      unreadable: "Couldn't read the eval history: .crewhaus/evals/index.jsonl is not readable.",
      launch: { offered: true, note: null, verb: "crewhaus x" },
    });
    expect(text).toContain("Couldn't read the eval history");
    expect(text).not.toContain("crewhaus x");
  });

  test("never run names the note and the command there is", () => {
    const text = draw({
      runs: [],
      baselines: {},
      unreadable: null,
      launch: {
        offered: false,
        note: "Checks for this harness type run inside its compiled test bundle.",
        verb: "crewhaus compile crewhaus.yaml --with-eval-harness",
      },
    });
    expect(text).toContain("Not measured yet.");
    expect(text).toContain("compiled test bundle");
    expect(text).toContain("crewhaus compile crewhaus.yaml --with-eval-harness");
    expect(text).not.toContain("crewhaus eval");
  });
});

describe("the run view", () => {
  const drawn = (payload: unknown = RUN_PAYLOAD): FakeNode => {
    const root = new FakeNode("div");
    views.drawRun(root, CTX, RUN, payload);
    return root;
  };

  test("the figures and the table come from stats and rows", () => {
    const root = drawn();
    const text = root.textContent;
    expect(text).toContain("50%");
    expect(text).toContain("0.75");
    expect(text).toContain("needs a person");
    expect(text).toContain("why error");
    // Unknown cost is a dash, never $0.
    expect(text).not.toContain("$0");
    expect(root.all("table")[0]?.parent?.classes.has("table-scroll")).toBe(true);
  });

  test("a row reads nothing from the raw summary", () => {
    const root = drawn({
      ...RUN_PAYLOAD,
      summary: { passRate: 0.9, results: [{ sampleId: "s-pass", pass: false }] },
    });
    expect(root.textContent).toContain("50%");
    expect(root.textContent).not.toContain("90%");
  });

  test("a sample with no directory gets no link", () => {
    const root = drawn({ ...RUN_PAYLOAD, rows: [row("pass", { dir: null })] });
    expect(root.all("a").filter((a: FakeNode) => a.textContent === "s-pass")).toEqual([]);
    expect(root.textContent).toContain("s-pass");
  });

  test("a link goes to the directory, not the raw id", () => {
    const root = drawn({ ...RUN_PAYLOAD, rows: [row("pass", { sampleId: "a/b", dir: "a_b" })] });
    const link = root.all("a").find((a: FakeNode) => a.textContent === "a/b");
    expect(link?.attrs["href"]).toContain("a_b");
  });

  test("the filter buttons say which is on, to a screen reader too", () => {
    const root = drawn();
    const buttons = root.all("button") as FakeNode[];
    expect(buttons.map((b) => [b.textContent, b.attrs["aria-pressed"]])).toEqual([
      ["all", "true"],
      ["pass", "false"],
      ["fail", "false"],
      ["no verdict", "false"],
    ]);
    buttons[2]?.click();
    expect(buttons.map((b) => b.attrs["aria-pressed"])).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    const text = root.textContent;
    expect(text).toContain("s-fail");
    expect(text).toContain("s-error");
    expect(text).not.toContain("s-pass");
  });

  test("each filter has its own sentence when it is empty", () => {
    const root = drawn({ ...RUN_PAYLOAD, rows: [row("pass")] });
    const buttons = root.all("button") as FakeNode[];
    buttons[2]?.click();
    expect(root.textContent).toContain("No case in this run failed or errored.");
    buttons[3]?.click();
    expect(root.textContent).toContain("Every case in this run has a verdict.");
    const sentences = (views.SAMPLE_FILTERS as Array<{ none: string }>).map((f) => f.none);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  test("no filters when no row has a verdict", () => {
    const root = drawn({ ...RUN_PAYLOAD, rows: [row("unknown")] });
    expect(root.all("button")).toEqual([]);
    expect(root.textContent).toContain("no result");
  });
});

describe("the sample view", () => {
  const GRADES = {
    overall: { passed: false, score: 0.5, rationale: "x" },
    perGrader: [
      { name: "exact", passed: true, score: 1, rationale: "matched" },
      { name: "judge", passed: false, score: 0, rationale: "unsure", abstained: true },
    ],
  };

  test("draws grades.overall and each grader, by the fields the runner writes", () => {
    const root = new FakeNode("div");
    views.drawSample(root, CTX, RUN, "s1", {
      grades: GRADES,
      transcript: [],
      transcriptTruncated: false,
    });
    const text = root.textContent;
    expect(text).toContain("exact");
    expect(text).toContain("matched");
    expect(text).toContain("needs a person");
    expect(text).not.toContain("?");
    expect(text).not.toContain("No grades recorded");
  });

  test("a shape no writer emits reads as no grades", () => {
    expect(views.gradeRowsOf({ pass: true, grader: "x" })).toEqual([]);
    expect(views.gradeRowsOf(null)).toEqual([]);
  });
});

describe("the lab's cards draw a control only where its job can start", () => {
  const CTX_LAB = { id: "hrn_0123456789abcdef" };
  const NOTE = "No checks yet: add eval/graders.yaml.";
  const COMPILE = "crewhaus compile crewhaus.yaml --with-eval-harness";
  const refused = { offered: false, shapeOk: true, note: NOTE, verb: null };
  const offered = { offered: true, shapeOk: true, note: null, verb: "crewhaus x" };
  const flywheelRes = (launches: Record<string, unknown>, extra: object = {}) => ({
    ok: true,
    status: 200,
    body: { present: true, note: null, workflows: [], datasetPrecedence: {}, launches, ...extra },
  });
  const quiet = { ok: true, status: 200, body: { present: true } };
  const buttons = (card: FakeNode): string[] =>
    card.all("button").map((b: FakeNode) => b.textContent);

  test("the eval launcher", () => {
    const no = lab.launcherCard(CTX_LAB, flywheelRes({ eval: refused }), () => {});
    expect(no.all("form")).toEqual([]);
    expect(no.textContent).toContain(NOTE);

    const shape = lab.launcherCard(
      CTX_LAB,
      flywheelRes({ eval: { ...refused, shapeOk: false, note: "not here", verb: COMPILE } }),
      () => {},
    );
    expect(shape.textContent).toContain(COMPILE);

    const yes = lab.launcherCard(CTX_LAB, flywheelRes({ eval: offered }), () => {});
    expect(yes.all("form").length).toBe(1);
    expect(buttons(yes)).toContain("Run eval");
    // Reading the split is said plainly: only one verb counts a use.
    expect(yes.textContent).toContain("only crewhaus datasets release counts a use");
    expect(yes.textContent).not.toContain("burn");
  });

  test("the launcher warns of a shadowed dataset without falling over", () => {
    const card = lab.launcherCard(
      CTX_LAB,
      flywheelRes(
        { eval: offered },
        { datasetPrecedence: { shadowing: true, note: "that file shadows the ratings" } },
      ),
      () => {},
    );
    expect(card.textContent).toContain("that file shadows the ratings");
  });

  test("a failed read still draws the launcher: the server has the last word", () => {
    const card = lab.launcherCard(CTX_LAB, { ok: false, status: 0, body: {} }, () => {});
    expect(card.all("form").length).toBe(1);
  });

  test("the sentinel", () => {
    const no = lab.sentinelCard(CTX_LAB, quiet, () => {}, flywheelRes({ eval: refused }));
    expect(buttons(no)).not.toContain("Run sentinel");
    expect(no.textContent).toContain(NOTE);
    const yes = lab.sentinelCard(CTX_LAB, quiet, () => {}, flywheelRes({ eval: offered }));
    expect(buttons(yes)).toContain("Run sentinel");
  });

  test("the optimizer", () => {
    const no = lab.optimizerCard(CTX_LAB, quiet, () => {}, flywheelRes({ optimize: refused }));
    expect(no.all("form")).toEqual([]);
    expect(no.textContent).toContain(NOTE);
    const yes = lab.optimizerCard(CTX_LAB, quiet, () => {}, flywheelRes({ optimize: offered }));
    expect(buttons(yes)).toContain("Optimize");
  });

  test("the flywheel, whose scaffolding stays offered either way", () => {
    const no = lab.flywheelCard(CTX_LAB, flywheelRes({ flywheel: refused }), () => {});
    expect(buttons(no)).toEqual(["Scaffold workflows"]);
    expect(no.textContent).toContain(NOTE);
    const yes = lab.flywheelCard(CTX_LAB, flywheelRes({ flywheel: offered }), () => {});
    expect(buttons(yes)).toEqual(["Run the loop", "Scaffold workflows"]);
  });
});

describe("the lab's offers", () => {
  test("a job that cannot start is refused by the offer, and a failed read draws the control", () => {
    const refused = { offered: false, note: "No checks yet: add eval/graders.yaml.", verb: null };
    const res = { ok: true, status: 200, body: { launches: { eval: refused } } };
    expect(lab.launchOf(res, "eval")).toEqual(refused);
    expect(lab.launchRefused(lab.launchOf(res, "eval"))).toBe(true);
    expect(lab.launchOf({ ok: false, status: 0, body: {} }, "eval")).toBeNull();
    expect(lab.launchRefused(null)).toBe(false);
    expect(lab.launchRefused({ offered: true })).toBe(false);
  });
});
