/**
 * 0.8.0 (design §5.4) — `proof` on the run result envelopes.
 *
 * Three things are pinned:
 *
 *   1. the envelope: `RunsCreateResult` / `RunsContinueResult` accept a result
 *      with and without `proof` (and the `reply` the daemon has always sent),
 *      and stay `.strict()` around it;
 *   2. the schema against REAL bundles — every shape `@crewhaus/provability`'s
 *      `verifyDocument` produces (pass, fail, assumption, execution, vacuous,
 *      unverified) parses, and malformed ones do not;
 *   3. drift: the schema mirrors provability's `ProofBundle` type rather than
 *      importing it, and tests are not typechecked by `tsc -b`, so the mirror
 *      is held to the type's SOURCE — every field of `ProofBundle`,
 *      `ProofClaim`, `ProofBinding` and a `checkers` entry with its
 *      optionality, and every member of `UnmetReason`, `BindingKind`,
 *      `ClaimStatus`, `ProofVerdict`, the levels (`PROVABILITY_LEVELS`) and
 *      the rungs. A field or a member added on one side only fails here —
 *      otherwise a real bundle carrying it would be refused by the strict
 *      schema at runtime.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProvabilityConfig as IrProvability,
  PROVABILITY_LEVELS,
  type ProofBundle as ProvabilityBundle,
  buildEvidenceIndex,
  recordFromCall,
  unverifiedBundle,
  verifyDocument,
} from "@crewhaus/provability";
import type { z } from "zod";
import {
  PROOF_LEVELS,
  PROOF_UNMET_REASONS,
  ProofBundle,
  RunsContinueResult,
  RunsCreateResult,
  decodeRequest,
} from "./index";

const NOW = (): Date => new Date("2026-10-22T12:00:00.000Z");

const config = (
  level: IrProvability["level"],
  patch: Partial<IrProvability> = {},
): IrProvability => ({
  level,
  onFail: "retry",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["evaluate"], replay: false, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: ["sorry"], timeoutMs: 30_000 },
  ...patch,
});

const POLICY_BODY =
  "Acme refund policy. Refunds are accepted within 14 days of purchase for every order.";

const evidence = buildEvidenceIndex([
  recordFromCall({
    toolUseId: "toolu_fetch",
    toolName: "WebFetch",
    input: { url: "https://acme.example/policy" },
    content: `URL: https://acme.example/policy\nStatus: 200\n\n${POLICY_BODY}`,
    isError: false,
  }),
  recordFromCall({
    toolUseId: "toolu_sum",
    toolName: "Evaluate",
    input: { expression: "1200 + 84.5" },
    content: "1284.5",
    isError: false,
  }),
]);

async function bundleOf(
  text: string,
  level: IrProvability["level"],
  patch: Partial<IrProvability> = {},
): Promise<ProvabilityBundle> {
  return verifyDocument(text, { config: config(level, patch), evidence, now: NOW });
}

const envelope = (proof?: unknown) => ({
  runId: "run_abc12345",
  sessionId: "sess_0123456789abcdef",
  tenantId: "tenant-a",
  reply: "Refunds take 14 days [1].",
  ...(proof !== undefined ? { proof } : {}),
});

describe("RunsCreateResult / RunsContinueResult — the optional proof field", () => {
  test("a result without proof (and without reply) still parses: the field is additive", () => {
    for (const schema of [RunsCreateResult, RunsContinueResult]) {
      expect(schema.safeParse({ runId: "r", sessionId: "s", tenantId: "t" }).success).toBe(true);
      expect(schema.safeParse(envelope()).success).toBe(true);
    }
  });

  test("a result with a real bundle parses, and keeps it verbatim", async () => {
    const proof = await bundleOf(
      "Refunds are accepted within 14 days of purchase [1].\n\n[1]: https://acme.example/policy",
      "grounded",
    );
    for (const schema of [RunsCreateResult, RunsContinueResult]) {
      const parsed = schema.parse(envelope(proof));
      expect(parsed.proof).toEqual(proof);
    }
  });

  test("still .strict(): an unknown key beside proof is refused", async () => {
    const proof = await bundleOf(
      "Refunds take a while [1].\n\n[1]: https://acme.example/policy",
      "cited",
    );
    expect(RunsCreateResult.safeParse({ ...envelope(proof), extra: 1 }).success).toBe(false);
  });

  test("the request side is untouched: runs.create params still refuse a proof", () => {
    expect(() =>
      decodeRequest({
        protocol: "crewhaus.v1",
        id: "x",
        method: "runs.create",
        params: { spec: "s", input: "hi", proof: {} },
      }),
    ).toThrow(/invalid params/);
  });
});

describe("ProofBundle — every shape the verifier produces parses", () => {
  test("a grounded pass with an excerpt and a digest", async () => {
    const b = await bundleOf(
      "Refunds are accepted within 14 days of purchase [1].\n\n[1]: https://acme.example/policy",
      "grounded",
    );
    expect(b.verdict).toBe("pass");
    expect(b.claims[0]?.bindings[0]?.excerpt).toBeDefined();
    expect(b.claims[0]?.bindings[0]?.sha256).toBeDefined();
    expect(ProofBundle.parse(b)).toEqual(b);
  });

  test("a failing answer: an uncited claim and a dangling marker", async () => {
    const b = await bundleOf(
      "Refunds are accepted within 14 days of purchase. Shipping is free on every order [2].",
      "cited",
    );
    expect(b.verdict).toBe("fail");
    expect(b.claims.map((c) => c.status)).toEqual(["unmet", "unmet"]);
    expect(ProofBundle.parse(b)).toEqual(b);
  });

  test("execution evidence and a declared assumption", async () => {
    const b = await bundleOf(
      [
        "The total is 1,284.50 [1].",
        "The fiscal year starts in April for this customer [A1].",
        "",
        "[1]: tool:toolu_sum",
        "[A1]: assume: the fiscal year starts in April",
      ].join("\n"),
      "checked",
    );
    expect(b.assumptions).toBe(1);
    expect(b.claims.some((c) => c.bindings.some((x) => x.kind === "execution"))).toBe(true);
    expect(ProofBundle.parse(b)).toEqual(b);
  });

  test("refused assumptions and a missing proof artifact", async () => {
    const b = await bundleOf(
      [
        "The fiscal year starts in April for this customer [A1].",
        "No two of the six meetings overlap at any time [2].",
        "",
        "[A1]: assume: the fiscal year starts in April",
        "[2]: proof:prf_0123456789abcdef",
      ].join("\n"),
      "proven",
      { assumptions: "forbid" },
    );
    expect(b.assumptionsRefused).toBe(1);
    expect(ProofBundle.parse(b)).toEqual(b);
  });

  test("a proven claim whose proof rests on hypotheses: counted, listed on the binding and the checker", async () => {
    const id = "prf_00000000000000aa";
    const artifact = {
      version: 1 as const,
      id,
      checker: "builtin",
      claim: "No two of the six meetings overlap.",
      statement: "forall i j in 1..6, i != j -> disjoint(m_i, m_j)",
      proof: "1. given ...",
      ok: true,
      assumptions: ["meeting 6 is cancelled"],
      axioms: [],
      output: "proved from 1 assumption",
      outputDigest: `sha256:${"0".repeat(64)}`,
      checkedAt: NOW().toISOString(),
    };
    const b = await verifyDocument(`No two of the six meetings overlap [1].\n\n[1]: proof:${id}`, {
      config: config("proven"),
      evidence,
      artifacts: {
        get: async (want: string) => (want === id ? artifact : undefined),
        put: async () => {},
        list: async () => [artifact],
      },
      trustStoredProofs: true,
      now: NOW,
    });
    expect(b.hypotheses).toBe(1);
    expect(b.claims[0]?.bindings[0]?.assumptions).toEqual(["meeting 6 is cancelled"]);
    expect(b.checkers?.[0]?.assumptions).toEqual(["meeting 6 is cancelled"]);
    expect(ProofBundle.parse(b)).toEqual(b);
  });

  test("a vacuous pass (no claims) and an unverified bundle", async () => {
    const vacuous = await bundleOf("Which order do you mean?", "cited");
    expect(vacuous.vacuous).toBeDefined();
    expect(ProofBundle.parse(vacuous)).toEqual(vacuous);
    const unverified = unverifiedBundle(config("grounded"), new Error("sandbox down"), 1, NOW);
    expect(ProofBundle.parse(unverified)).toEqual(unverified);
  });
});

describe("ProofBundle — malformed bundles are refused", () => {
  const good = async (): Promise<Record<string, unknown>> =>
    (await bundleOf(
      "Refunds are accepted within 14 days of purchase [1].\n\n[1]: https://acme.example/policy",
      "grounded",
    )) as unknown as Record<string, unknown>;

  const cases: Array<[string, (b: Record<string, unknown>) => Record<string, unknown>]> = [
    ["an unknown level", (b) => ({ ...b, level: "verified" })],
    ["an unknown verdict", (b) => ({ ...b, verdict: "maybe" })],
    ["a version other than 1", (b) => ({ ...b, version: 2 })],
    ["a score above 1", (b) => ({ ...b, score: 1.5 })],
    ["a negative count", (b) => ({ ...b, unmet: -1 })],
    ["a fractional count", (b) => ({ ...b, claimCount: 1.5 })],
    ["a bundle hash that is not sha256:<hex>", (b) => ({ ...b, bundleHash: "abc" })],
    ["an unknown top-level key", (b) => ({ ...b, extra: true })],
    [
      "an unknown key on a claim",
      (b) => ({
        ...b,
        claims: (b["claims"] as Array<Record<string, unknown>>).map((c) => ({ ...c, extra: 1 })),
      }),
    ],
    [
      "an unknown binding reason",
      (b) => ({
        ...b,
        claims: (b["claims"] as Array<Record<string, unknown>>).map((c) => ({
          ...c,
          bindings: (c["bindings"] as Array<Record<string, unknown>>).map((x) => ({
            ...x,
            ok: false,
            reason: "felt_wrong",
          })),
        })),
      }),
    ],
    ["a missing bundleHash", ({ bundleHash: _drop, ...rest }) => rest],
  ];
  for (const [name, mutate] of cases) {
    test(name, async () => {
      expect(ProofBundle.safeParse(mutate(await good())).success).toBe(false);
      expect(RunsCreateResult.safeParse(envelope(mutate(await good()))).success).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Drift: the mirror is held to the provability type's source.
// ---------------------------------------------------------------------------

const TYPES_SOURCE = readFileSync(
  join(import.meta.dir, "..", "..", "provability", "src", "types.ts"),
  "utf8",
);

/** The top-level fields of `export type <name> = { … };` in types.ts, with optionality. */
function typeFields(name: string): Map<string, boolean> {
  const start = TYPES_SOURCE.indexOf(`export type ${name} = {`);
  if (start === -1) throw new Error(`types.ts has no "export type ${name} = {"`);
  const end = TYPES_SOURCE.indexOf("\n};", start);
  const fields = new Map<string, boolean>();
  for (const line of TYPES_SOURCE.slice(start, end).split("\n")) {
    const m = /^ {2}readonly (\w+)(\?)?:/.exec(line);
    if (m !== null) fields.set(m[1] as string, m[2] === "?");
  }
  return fields;
}

/** The fields of a zod object schema, with optionality. */
function schemaFields(schema: z.AnyZodObject): Map<string, boolean> {
  return new Map(
    Object.entries(schema.shape).map(([key, value]) => [key, (value as z.ZodTypeAny).isOptional()]),
  );
}

const sorted = (m: Map<string, boolean>): Array<[string, boolean]> =>
  [...m].sort(([a], [b]) => a.localeCompare(b));

/** The string members of `export type <name> = "a" | "b";` in types.ts, in order. */
function unionMembers(name: string): string[] {
  const start = TYPES_SOURCE.indexOf(`export type ${name} =`);
  if (start === -1) throw new Error(`types.ts has no "export type ${name} ="`);
  const end = TYPES_SOURCE.indexOf(";", start);
  const members = [...TYPES_SOURCE.slice(start, end).matchAll(/"(\w+)"/g)].map(
    (m) => m[1] as string,
  );
  if (members.length < 2) throw new Error(`types.ts's ${name} is not a union of string literals`);
  return members;
}

describe("ProofBundle — the mirror matches @crewhaus/provability's types", () => {
  const claimSchema = ProofBundle.shape.claims.element;
  const bindingSchema = claimSchema.shape.bindings.element;

  test("ProofBundle: every field, and which are optional", () => {
    expect(sorted(schemaFields(ProofBundle))).toEqual(sorted(typeFields("ProofBundle")));
  });

  test("ProofClaim: every field, and which are optional", () => {
    expect(sorted(schemaFields(claimSchema))).toEqual(sorted(typeFields("ProofClaim")));
  });

  test("ProofBinding: every field, and which are optional", () => {
    expect(sorted(schemaFields(bindingSchema))).toEqual(sorted(typeFields("ProofBinding")));
  });

  test("a checkers entry: every field, and which are optional", () => {
    const start = TYPES_SOURCE.indexOf("readonly checkers?: ReadonlyArray<{");
    expect(start).toBeGreaterThan(-1);
    const end = TYPES_SOURCE.indexOf("}>", start);
    const fields = new Map<string, boolean>();
    for (const line of TYPES_SOURCE.slice(start, end).split("\n").slice(1)) {
      const m = /^\s+readonly (\w+)(\?)?:/.exec(line);
      if (m !== null) fields.set(m[1] as string, m[2] === "?");
    }
    expect(fields.size).toBeGreaterThan(0);
    const checkers = ProofBundle.shape.checkers.unwrap().element;
    expect(sorted(schemaFields(checkers))).toEqual(sorted(fields));
  });

  test("the levels and the rungs: PROVABILITY_LEVELS, verbatim, and `none` below them", () => {
    expect([...PROOF_LEVELS]).toEqual([...PROVABILITY_LEVELS]);
    expect(ProofBundle.shape.level.options).toEqual([...PROVABILITY_LEVELS]);
    const rungs = [...PROVABILITY_LEVELS, "none"];
    expect(TYPES_SOURCE).toContain('export type Rung = ProvabilityLevel | "none";');
    expect(ProofBundle.shape.achieved.options).toEqual(rungs);
    expect(claimSchema.shape.best.options).toEqual(rungs);
    expect(bindingSchema.shape.rung.options).toEqual(rungs);
  });

  test("BindingKind, ClaimStatus, ProofVerdict: every member, in order", () => {
    expect(bindingSchema.shape.kind.options).toEqual(unionMembers("BindingKind"));
    expect(claimSchema.shape.status.options).toEqual(unionMembers("ClaimStatus"));
    expect(ProofBundle.shape.verdict.options).toEqual(unionMembers("ProofVerdict"));
  });

  test("UnmetReason: every member, in order", () => {
    const start = TYPES_SOURCE.indexOf("export type UnmetReason =");
    const end = TYPES_SOURCE.indexOf(";", start);
    const members = [...TYPES_SOURCE.slice(start, end).matchAll(/\| "(\w+)"/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(10);
    expect([...PROOF_UNMET_REASONS]).toEqual(members as string[]);
  });
});
