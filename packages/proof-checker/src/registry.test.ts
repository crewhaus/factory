import { describe, expect, spyOn, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import { LEAN4_IMAGE_REF } from "@crewhaus/sandbox-image-lean4";
import { Z3_IMAGE_REF } from "@crewhaus/sandbox-image-z3";
import { BUILTIN_LIMITS } from "./builtin/budget";
import { BUILTIN_LANGUAGE } from "./builtin/checker";
import { DEFAULT_LEAN4_IMAGE, DEFAULT_SMT_IMAGE } from "./index";
import { LEAN4_LANGUAGE } from "./lean4";
import {
  DEFAULT_CHECKER_IDS,
  KNOWN_CHECKER_IDS,
  ProofCheckerConfigError,
  checkerImages,
  createCheckerRegistry,
  createDefaultCheckers,
} from "./registry";
import { SMT_LANGUAGE } from "./smt";
import { fakeSandbox } from "./test-helpers";
import type { ProofChecker } from "./types";

const stub = (id: string): ProofChecker => ({
  id,
  language: `${id} language`,
  async available() {
    return { ok: true };
  },
  async check() {
    return { ok: true, checker: id, assumptions: [], axioms: [], output: "", durationMs: 0 };
  },
});

describe("createCheckerRegistry", () => {
  test("get / has / list / ids, in registration order", () => {
    const registry = createCheckerRegistry([stub("builtin"), stub("plugin-x"), stub("smt")]);
    expect(registry.ids()).toEqual(["builtin", "plugin-x", "smt"]);
    expect(registry.list().map((c) => c.id)).toEqual(["builtin", "plugin-x", "smt"]);
    expect(registry.get("plugin-x")?.language).toBe("plugin-x language");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.has("smt")).toBe(true);
    expect(registry.has("lean4")).toBe(false);
  });

  test("a repeated id is refused, not shadowed", () => {
    expect(() => createCheckerRegistry([stub("builtin"), stub("builtin")])).toThrow(
      /proof checker id "builtin" is registered twice/,
    );
    try {
      createCheckerRegistry([stub("a"), stub("a")]);
    } catch (err) {
      expect(err).toBeInstanceOf(ProofCheckerConfigError);
      expect(err).toBeInstanceOf(CrewhausError);
      expect((err as CrewhausError).code).toBe("config");
    }
  });

  test("an empty id is refused", () => {
    expect(() => createCheckerRegistry([stub(" ")])).toThrow(/non-empty id/);
  });
});

describe("createDefaultCheckers", () => {
  test("default: builtin then smt (the IR default for formal.checkers)", () => {
    expect(DEFAULT_CHECKER_IDS).toEqual(["builtin", "smt"]);
    expect(KNOWN_CHECKER_IDS).toEqual(["builtin", "smt", "lean4"]);
    expect(createDefaultCheckers().map((c) => c.id)).toEqual(["builtin", "smt"]);
  });

  test("follows formal.checkers order and drops repeats", () => {
    const ids = createDefaultCheckers({ ids: ["lean4", "builtin", "lean4", "smt"] }).map(
      (c) => c.id,
    );
    expect(ids).toEqual(["lean4", "builtin", "smt"]);
  });

  test("an unknown id is a config error naming the known ones", () => {
    expect(() => createDefaultCheckers({ ids: ["builtin", "coq"] })).toThrow(
      /unknown proof checker "coq" \(known: builtin, smt, lean4\)/,
    );
  });

  test("without a sandbox the sandbox checkers are listed, unavailable, and refuse", async () => {
    const [smt, lean4] = createDefaultCheckers({ ids: ["smt", "lean4"] });
    expect(smt?.language).toBe(SMT_LANGUAGE);
    expect(lean4?.language).toBe(LEAN4_LANGUAGE);
    for (const c of [smt, lean4] as ProofChecker[]) {
      const a = await c.available();
      expect(a.ok).toBe(false);
      expect(a.reason).toMatch(/needs a container sandbox and none is configured/);
      const r = await c.check({ claim: "c", statement: "true", proof: "" });
      expect(r).toMatchObject({ ok: false, checker: c.id, reason: a.reason });
    }
  });

  test("the builtin is always available and takes the budget", async () => {
    const [builtin] = createDefaultCheckers({ ids: ["builtin"], timeoutMs: 1 });
    expect(builtin?.language).toBe(BUILTIN_LANGUAGE);
    expect(await builtin?.available()).toEqual({ ok: true });
    const heavy = await builtin?.check({
      claim: "c",
      statement: "forall i in 1..10000: forall j in 1..99: i * j > 0",
      proof: "eval",
    });
    expect(heavy?.reason).toMatch(/ran out of time/);
  });

  test("with a sandbox: real adapters on the curated images, options passed through", async () => {
    const sandbox = fakeSandbox(() => ({
      stdout: "'crewhaus_claim' depends on axioms: [propext]\n",
    }));
    const checkers = createDefaultCheckers({
      sandbox,
      ids: ["builtin", "smt", "lean4"],
      timeoutMs: 12_000,
      forbid: ["sorry"],
    });
    expect(checkerImages(checkers)).toEqual([Z3_IMAGE_REF, LEAN4_IMAGE_REF]);
    const lean4 = checkers[2] as ProofChecker;
    // forbid passed through: native_decide is no longer refused by the pre-scan.
    const r = await lean4.check({ claim: "c", statement: "True", proof: "by native_decide" });
    expect(r.ok).toBe(true);
    expect(sandbox.calls[0]?.timeoutMs).toBe(12_000);
  });

  test("image overrides (formal.image is the lean4 one) and lean4 options", () => {
    const sandbox = fakeSandbox([]);
    const checkers = createDefaultCheckers({
      sandbox,
      ids: ["smt", "lean4"],
      images: { smt: "registry.example/z3:x", lean4: "registry.example/lean-mathlib:1" },
      lean4: { argv: ["lake", "env", "lean", "--stdin", "--json"] },
    });
    expect(checkerImages(checkers)).toEqual([
      "registry.example/z3:x",
      "registry.example/lean-mathlib:1",
    ]);
  });

  test("allowNoop reaches the sandbox checkers", async () => {
    const sandbox = fakeSandbox([{ exitCode: 0 }], "noop");
    const [smt] = createDefaultCheckers({ sandbox, ids: ["smt"], allowNoop: true });
    expect(await smt?.available()).toEqual({ ok: true });
    const [refusing] = createDefaultCheckers({ sandbox, ids: ["smt"] });
    expect((await refusing?.available())?.ok).toBe(false);
  });

  test("the default image refs come from the image packages", () => {
    expect(DEFAULT_SMT_IMAGE).toBe(Z3_IMAGE_REF);
    expect(DEFAULT_LEAN4_IMAGE).toBe(LEAN4_IMAGE_REF);
    expect(checkerImages([stub("builtin")])).toEqual([]);
  });

  test("the defaults form a valid registry", () => {
    const registry = createCheckerRegistry(createDefaultCheckers({ ids: [...KNOWN_CHECKER_IDS] }));
    expect(registry.ids()).toEqual(["builtin", "smt", "lean4"]);
  });
});

describe("createDefaultCheckers — formal.timeout_ms and the builtin", () => {
  test("a 30 s formal.timeout_ms still gives the synchronous builtin at most maxTimeoutMs", async () => {
    const [builtin] = createDefaultCheckers({ ids: ["builtin"], timeoutMs: 30_000 });
    // The clock jumps just past 10 s after the budget is created: a 30 s
    // deadline would pass, the capped one runs out.
    const t0 = 5_000_000;
    let calls = 0;
    const clock = spyOn(Date, "now").mockImplementation(() =>
      calls++ === 0 ? t0 : t0 + BUILTIN_LIMITS.maxTimeoutMs + 1,
    );
    try {
      const r = await (builtin as ProofChecker).check({
        claim: "c",
        statement: "1 = 1",
        proof: "eval",
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/ran out of time/);
    } finally {
      clock.mockRestore();
    }
    expect(BUILTIN_LIMITS.maxTimeoutMs).toBe(10_000);
  });
});
