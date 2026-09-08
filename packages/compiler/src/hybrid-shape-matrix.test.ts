/**
 * 0.6.0 PR 9f — **plan §11.3, asserted against what the compiler actually
 * does.**
 *
 * §11.3 is not an internal note: it is published VERBATIM into crewhaus/docs
 * `COMPILER-ARCHITECTURE.md` and the book's appendix D, and `models explain`
 * prints the spec's own row. PR 9e wired six emitters and left four
 * pool-bearing shapes claiming **E** in the table while their bundles emitted
 * nothing — the shortfall this row closes. So the table is transcribed here,
 * cell by cell, and every cell is checked twice: against
 * `@crewhaus/model-service`'s `HYBRID_FAMILIES_BY_SHAPE` (the one table the
 * emitters gate on) and against a real `compile()` of a real spec for that
 * shape. Change one without the other and this fails.
 *
 * Reading a cell:
 *   **E** — the key compiles with NO warning, and the closures are
 *           constructed for a compiled bundle (in the emitted text for every
 *           shape but `crew`, whose orchestrator calls `wireHybrid` per role
 *           activation from the same blob).
 *   **—** — the shape cannot host the family. Either the strict schema
 *           refuses the key outright (committee) or the compiler reports it
 *           field-precisely as `model-plan-ignored-on-shape` and the emitter
 *           renders nothing for it (pipeline × Consult / Escalate).
 */
import { describe, expect, test } from "bun:test";
import { HYBRID_FAMILIES_BY_SHAPE, type HybridWiringShape } from "@crewhaus/model-service";
import { parseSpecIssues } from "@crewhaus/spec";
import { HYBRID_WIRED_TARGETS, compile } from "./index";

type Cell = "E" | "—";

const CANDIDATES = [
  "candidates:",
  "  - { model: claude-haiku-4-5, tags: [cheap] }",
  "  - { model: claude-opus-4-8, tags: [strong] }",
];

/** Indent a pool body to the column its shape nests it at. */
const pool = (indent: number, body: readonly string[]): string =>
  [...CANDIDATES, ...body].map((l) => `${" ".repeat(indent)}${l}`).join("\n");

type Row = {
  readonly shape: HybridWiringShape;
  /** §11.3 columns, transcribed. */
  readonly guideShadow: Cell;
  readonly committee: Cell;
  readonly consultEscalate: Cell;
  readonly classifier: Cell;
  /**
   * Does the EMITTED text carry the `wireHybrid` call? True everywhere but
   * `crew`, where the pool rides the blob into `@crewhaus/crew-orchestrator`
   * and the call happens per role activation (PR 9e).
   */
  readonly rendersCall: boolean;
  /** The `model_pool` path the warnings and the spec issues are keyed at. */
  readonly poolPath: string;
  /** A minimal valid spec for the shape, with `body` inside its pool. */
  readonly spec: (body: readonly string[]) => string;
};

const ROWS: readonly Row[] = [
  {
    shape: "cli",
    guideShadow: "E",
    committee: "—",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
      ].join("\n"),
  },
  {
    shape: "channel",
    guideShadow: "E",
    committee: "—",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: channel",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
        "channels:",
        "  slack:",
        "    botToken: $M_SLACK_BOT_TOKEN",
        "    signingSecret: $M_SLACK_SIGNING_SECRET",
        "routing:",
        "  sessionKey: thread",
      ].join("\n"),
  },
  {
    shape: "managed",
    guideShadow: "E",
    committee: "—",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: managed",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
        "tenants:",
        "  - id: t1",
        "    budget: { maxInputTokens: 100000, maxOutputTokens: 20000 }",
      ].join("\n"),
  },
  {
    shape: "workflow",
    guideShadow: "E",
    committee: "E",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "steps[0].model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: workflow",
        "model: claude-sonnet-4-6",
        "steps:",
        "  - name: draft",
        "    instructions: write it",
        "    model_pool:",
        pool(6, b),
      ].join("\n"),
  },
  {
    shape: "graph",
    guideShadow: "E",
    committee: "E",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "nodes.plan.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: graph",
        "model: claude-sonnet-4-6",
        "entry: plan",
        "nodes:",
        "  plan:",
        "    instructions: plan it",
        "    model_pool:",
        pool(6, b),
        "  done:",
        "    instructions: finish it",
        "edges:",
        "  - from: plan",
        "    to: done",
      ].join("\n"),
  },
  {
    shape: "crew",
    guideShadow: "E",
    committee: "E",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: false,
    poolPath: "roles.researcher.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: crew",
        "model: claude-sonnet-4-6",
        "entry: researcher",
        "roles:",
        "  researcher:",
        "    instructions: research it",
        "    model_pool:",
        pool(6, b),
      ].join("\n"),
  },
  {
    shape: "pipeline",
    guideShadow: "E",
    committee: "—",
    // §11.3's ONE `—` among the shapes 9f wires — a plan decision, not a
    // shape limit (the pair is additive; see HYBRID_SHAPE_REASON).
    consultEscalate: "—",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: pipeline",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
        "retrieve:",
        "  embedderModel: mock/det",
        "indexing:",
        "  documents:",
        "    - { id: d1, text: hello }",
      ].join("\n"),
  },
  {
    shape: "research",
    guideShadow: "E",
    committee: "—",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: research",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
        "goal: find out",
      ].join("\n"),
  },
  {
    shape: "batch",
    guideShadow: "E",
    committee: "—",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: batch",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
        "queue:",
        "  adapter: in-memory",
      ].join("\n"),
  },
  {
    shape: "browser",
    guideShadow: "E",
    committee: "—",
    consultEscalate: "E",
    classifier: "E",
    rendersCall: true,
    poolPath: "agent.model_pool",
    spec: (b) =>
      [
        "name: m",
        "target: browser",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        pool(4, b),
      ].join("\n"),
  },
];

const GUIDE_SHADOW = [
  "strategy:",
  "  guide: { model: claude-opus-4-8, every: first_turn }",
  "  shadow: { candidate: claude-opus-4-8, sample_rate: 0.2 }",
];
const DIRECTED = ["strategy: { model_directed: true }"];
const CLASSIFIER = [
  "policy: classifier",
  "classifier:",
  "  model: claude-haiku-4-5",
  "  labels: { cheap: easy, strong: hard }",
];
const COMMITTEE = ["strategy: { committee: { members: [cheap, strong] } }"];

const bundleText = (yaml: string): string =>
  compile(yaml, { readme: false })
    .files.map((f) => f.content)
    .join("\n");

const noticePaths = (yaml: string): readonly string[] =>
  compile(yaml, { readme: false })
    .warnings.filter(
      (w) => w.code === "model-plan-ignored-on-shape" || w.code === "model-plan-pending-runtime",
    )
    .map((w) => w.path)
    .sort();

describe("plan §11.3 — the per-shape hybrid matrix matches the compiler (PR 9f)", () => {
  test("the transcribed table covers every shape model-service lists as pool-bearing", () => {
    expect(ROWS.map((r) => r.shape).sort()).toEqual(
      Object.entries(HYBRID_FAMILIES_BY_SHAPE)
        .filter(([, fams]) => fams.length > 0)
        .map(([shape]) => shape)
        .sort(),
    );
    // …and the compiler's own view of "wired" is derived from the same table.
    expect([...HYBRID_WIRED_TARGETS].sort()).toEqual(ROWS.map((r) => r.shape).sort());
  });

  for (const row of ROWS) {
    describe(`${row.shape}`, () => {
      test("the §11.3 row equals model-service's family row", () => {
        const families = HYBRID_FAMILIES_BY_SHAPE[row.shape];
        expect(families.includes("sideCalls")).toBe(row.guideShadow === "E");
        expect(families.includes("classifier")).toBe(row.classifier === "E");
        expect(families.includes("modelDirected")).toBe(row.consultEscalate === "E");
      });

      test("guide / shadow: E — compiles clean and the closures are constructed", () => {
        const yaml = row.spec(GUIDE_SHADOW);
        expect(parseSpecIssues(yaml)).toEqual([]);
        expect(noticePaths(yaml)).toEqual([]);
        if (row.rendersCall) {
          expect(bundleText(yaml)).toContain(
            'import { wireHybrid } from "@crewhaus/model-service";',
          );
          expect(bundleText(yaml)).toContain("...wireHybrid({");
        }
        // Either way the blob reaches the bundle for the runtime to read.
        expect(bundleText(yaml)).toContain('"guide":{"model":"claude-opus-4-8"');
      });

      test("policy: classifier: E — compiles clean and the label call is constructed", () => {
        const yaml = row.spec(CLASSIFIER);
        expect(parseSpecIssues(yaml)).toEqual([]);
        expect(noticePaths(yaml)).toEqual([]);
        if (row.rendersCall) expect(bundleText(yaml)).toContain("...wireHybrid({");
      });

      test(`Consult / Escalate: ${row.consultEscalate}`, () => {
        const yaml = row.spec(DIRECTED);
        expect(parseSpecIssues(yaml)).toEqual([]);
        if (row.consultEscalate === "E") {
          expect(noticePaths(yaml)).toEqual([]);
          if (row.rendersCall) expect(bundleText(yaml)).toContain("...wireHybrid({");
        } else {
          // Field-precise, and standing: a plan decision, not a deferred row.
          expect(noticePaths(yaml)).toEqual([`${row.poolPath}.strategy.model_directed`]);
          expect(bundleText(yaml)).not.toContain("wireHybrid");
        }
      });

      test(`committee: ${row.committee}`, () => {
        const issues = parseSpecIssues(row.spec(COMMITTEE));
        if (row.committee === "E") {
          expect(issues).toEqual([]);
        } else {
          // `—` here means the strict union refuses it outright.
          expect(issues.length).toBeGreaterThan(0);
        }
      });

      test("byte-identity: a pool with no closure-shaped key wires nothing", () => {
        const text = bundleText(row.spec([]));
        expect(text).toContain('"candidates":[{"model":"claude-haiku-4-5"');
        expect(text).not.toContain("wireHybrid");
        expect(text).not.toContain("@crewhaus/model-service");
      });
    });
  }
});
